const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

const webSimulatorPath = path.join(__dirname, '..', 'web-simulator');
app.use(express.static(webSimulatorPath));

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,   // 5MB for binary audio blobs
  pingInterval: 10000,
  pingTimeout: 5000
});

const PUBLIC_CHANNEL_CODE = '369000';

// rooms: roomCode -> Set of socketIds
const rooms = new Map();
rooms.set(PUBLIC_CHANNEL_CODE, new Set());

function generateRoomCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (rooms.has(code) || code === PUBLIC_CHANNEL_CODE);
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('create-room', (data, callback) => {
    const code = generateRoomCode();
    rooms.set(code, new Set([socket.id]));
    socket.join(code);
    currentRoom = code;
    console.log(`[CREATE] Room ${code} by ${socket.id}`);
    const res = { success: true, roomCode: code, isPaired: false, isPublic: false };
    if (typeof callback === 'function') callback(res);
    socket.emit('room-joined', res);
  });

  socket.on('join-room', (data, callback) => {
    const code = (data?.roomCode || PUBLIC_CHANNEL_CODE).trim();

    if (!rooms.has(code)) {
      rooms.set(code, new Set());
    }

    const members = rooms.get(code);
    const isPublic = code === PUBLIC_CHANNEL_CODE;

    if (!isPublic && members.size >= 2 && !members.has(socket.id)) {
      const err = { success: false, message: 'Channel is full (1-to-1 max)' };
      if (typeof callback === 'function') callback(err);
      return;
    }

    members.add(socket.id);
    socket.join(code);
    currentRoom = code;

    console.log(`[JOIN] Room ${code} by ${socket.id} (members: ${members.size})`);
    const isPaired = isPublic || members.size >= 2;
    const res = { success: true, roomCode: code, isPaired, isPublic };
    if (typeof callback === 'function') callback(res);
    socket.emit('room-joined', res);

    // Tell others someone joined
    socket.to(code).emit('peer-joined', { peerId: socket.id, isPaired: true, isPublic });
  });

  socket.on('start-talk', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-start-talk', { talkerId: socket.id });
  });

  // audio-chunk: relay raw binary ArrayBuffer directly to room peers
  socket.on('audio-chunk', (buffer) => {
    if (!currentRoom) return;
    // Relay as binary to all other sockets in the room
    socket.to(currentRoom).emit('audio-chunk', buffer);
  });

  socket.on('stop-talk', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-stop-talk', { talkerId: socket.id });
  });

  socket.on('leave-room', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
      if (rooms.get(currentRoom).size === 0 && currentRoom !== PUBLIC_CHANNEL_CODE) {
        rooms.delete(currentRoom);
      }
    }
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
      if (rooms.get(currentRoom).size === 0 && currentRoom !== PUBLIC_CHANNEL_CODE) {
        rooms.delete(currentRoom);
      }
    }
  });
});

app.get('/api/status', (req, res) => {
  const roomList = {};
  rooms.forEach((members, code) => {
    roomList[code] = members.size;
  });
  res.json({ status: 'online', publicChannel: PUBLIC_CHANNEL_CODE, activeRooms: rooms.size, rooms: roomList, timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Walkie-Talkie server running on port ${PORT}`);
  console.log(`🌐 Public Channel: ${PUBLIC_CHANNEL_CODE}`);
});
