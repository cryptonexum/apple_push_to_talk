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

  // ---- Room management ----
  socket.on('create-room', (data, cb) => {
    const code = generateRoomCode();
    rooms.set(code, new Set([socket.id]));
    socket.join(code);
    currentRoom = code;
    console.log(`[CREATE] Room ${code}`);
    const res = { success: true, roomCode: code, isPaired: false, isPublic: false };
    cb?.(res);
    socket.emit('room-joined', res);
  });

  socket.on('join-room', (data, cb) => {
    const code = (data?.roomCode || PUBLIC_CHANNEL_CODE).trim();
    if (!rooms.has(code)) rooms.set(code, new Set());
    const members = rooms.get(code);
    const isPublic = code === PUBLIC_CHANNEL_CODE;

    if (!isPublic && members.size >= 2 && !members.has(socket.id)) {
      const err = { success: false, message: 'Channel full (1-to-1 max)' };
      cb?.(err); return;
    }

    members.add(socket.id);
    socket.join(code);
    currentRoom = code;
    console.log(`[JOIN] Room ${code} (${members.size} members)`);

    const isPaired = isPublic || members.size >= 2;
    const res = { success: true, roomCode: code, isPaired, isPublic };
    cb?.(res);
    socket.emit('room-joined', res);

    // Tell others someone joined — they will initiate WebRTC offer
    socket.to(code).emit('peer-joined', { peerId: socket.id, isPaired: true, isPublic, shouldOffer: true });
  });

  // ---- WebRTC Signaling Relay ----
  // Forward offer from caller to the specific peer
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    console.log(`[OFFER] ${socket.id} -> ${targetId}`);
    io.to(targetId).emit('webrtc-offer', { fromId: socket.id, offer });
  });

  // Forward answer from callee back to caller
  socket.on('webrtc-answer', ({ targetId, answer }) => {
    console.log(`[ANSWER] ${socket.id} -> ${targetId}`);
    io.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer });
  });

  // Forward ICE candidates between peers
  socket.on('webrtc-ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice', { fromId: socket.id, candidate });
  });

  // Broadcast offer to whole room (for public multi-user channel)
  socket.on('webrtc-offer-broadcast', ({ offer }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('webrtc-offer', { fromId: socket.id, offer });
  });

  // ---- PTT signals (still used for UI indicator on peer device) ----
  socket.on('start-talk', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-start-talk', { talkerId: socket.id });
  });

  socket.on('stop-talk', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-stop-talk', { talkerId: socket.id });
  });

  // ---- Leave / Disconnect ----
  socket.on('leave-room', () => {
    cleanupSocket();
  });

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    cleanupSocket();
  });

  function cleanupSocket() {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { peerId: socket.id });
      if (rooms.get(currentRoom).size === 0 && currentRoom !== PUBLIC_CHANNEL_CODE) {
        rooms.delete(currentRoom);
      }
    }
    socket.leave(currentRoom);
    currentRoom = null;
  }
});

app.get('/api/status', (req, res) => {
  const roomInfo = {};
  rooms.forEach((m, c) => { roomInfo[c] = m.size; });
  res.json({ status: 'online', publicChannel: PUBLIC_CHANNEL_CODE, activeRooms: rooms.size, rooms: roomInfo, timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Walkie-Talkie VoIP server on port ${PORT}`);
  console.log(`🌐 Public Channel: ${PUBLIC_CHANNEL_CODE}`);
});
