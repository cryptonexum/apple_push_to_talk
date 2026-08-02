const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve static web simulator files
const webSimulatorPath = path.join(__dirname, '..', 'web-simulator');
app.use(express.static(webSimulatorPath));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB for audio buffer flexibility
});

// Rooms state: code -> { users: Map(socketId -> { id, deviceType, isTalking }), created: Date }
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  let currentRoom = null;
  let userMeta = { id: socket.id, deviceType: 'unknown', name: 'User' };

  // Create a new 1-to-1 channel
  socket.on('create-room', (data, callback) => {
    const code = generateRoomCode();
    userMeta.deviceType = data?.deviceType || 'watchOS';
    userMeta.name = data?.name || `Peer ${socket.id.slice(0, 4)}`;

    const roomData = {
      code,
      users: new Map([[socket.id, { ...userMeta, isTalking: false }]]),
      createdAt: new Date()
    };

    rooms.set(code, roomData);
    socket.join(code);
    currentRoom = code;

    console.log(`[Room Created] Code: ${code} by ${socket.id} (${userMeta.deviceType})`);

    const response = {
      success: true,
      roomCode: code,
      peerCount: 1,
      isPaired: false
    };

    if (typeof callback === 'function') callback(response);
    socket.emit('room-joined', response);
  });

  // Join an existing channel
  socket.on('join-room', (data, callback) => {
    const code = data?.roomCode?.trim();
    userMeta.deviceType = data?.deviceType || 'watchOS';
    userMeta.name = data?.name || `Peer ${socket.id.slice(0, 4)}`;

    if (!code || !rooms.has(code)) {
      const errRes = { success: false, message: 'Invalid or expired Channel Code' };
      if (typeof callback === 'function') callback(errRes);
      socket.emit('error-message', errRes);
      return;
    }

    const roomData = rooms.get(code);

    if (roomData.users.size >= 2 && !roomData.users.has(socket.id)) {
      const errRes = { success: false, message: 'Channel is full (1-to-1 max reached)' };
      if (typeof callback === 'function') callback(errRes);
      socket.emit('error-message', errRes);
      return;
    }

    roomData.users.set(socket.id, { ...userMeta, isTalking: false });
    socket.join(code);
    currentRoom = code;

    console.log(`[Room Joined] Code: ${code} by ${socket.id}`);

    const isPaired = roomData.users.size === 2;
    const response = {
      success: true,
      roomCode: code,
      peerCount: roomData.users.size,
      isPaired
    };

    if (typeof callback === 'function') callback(response);
    socket.emit('room-joined', response);

    // Notify other peer in room
    socket.to(code).emit('peer-joined', {
      peerId: socket.id,
      deviceType: userMeta.deviceType,
      name: userMeta.name,
      peerCount: roomData.users.size,
      isPaired: true
    });
  });

  // Start Push-to-Talk
  socket.on('start-talk', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const user = room.users.get(socket.id);
    if (user) user.isTalking = true;

    socket.to(currentRoom).emit('peer-start-talk', {
      talkerId: socket.id,
      talkerName: userMeta.name,
      timestamp: Date.now()
    });
    console.log(`[PTT START] ${socket.id} in room ${currentRoom}`);
  });

  // Relay Audio Chunk (Binary or Base64 Buffer)
  socket.on('audio-chunk', (chunk) => {
    if (!currentRoom) return;
    // Broadcast immediately to paired peer in room
    socket.to(currentRoom).emit('audio-chunk', {
      senderId: socket.id,
      chunk: chunk
    });
  });

  // Stop Push-to-Talk
  socket.on('stop-talk', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    const user = room.users.get(socket.id);
    if (user) user.isTalking = false;

    socket.to(currentRoom).emit('peer-stop-talk', {
      talkerId: socket.id,
      timestamp: Date.now()
    });
    console.log(`[PTT STOP] ${socket.id} in room ${currentRoom}`);
  });

  // Leave room manually
  socket.on('leave-room', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const roomCode = currentRoom;
    const room = rooms.get(roomCode);
    
    if (room) {
      room.users.delete(socket.id);
      socket.to(roomCode).emit('peer-left', {
        peerId: socket.id,
        isPaired: false
      });
      if (room.users.size === 0) {
        rooms.delete(roomCode);
      }
    }

    socket.leave(roomCode);
    currentRoom = null;
    socket.emit('room-left', { success: true });
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`[-] Client disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        isPaired: false
      });
      if (room.users.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

// API Info endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    activeRooms: rooms.size,
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Walkie Talkie Relay Server running on port ${PORT}`);
  console.log(`🌐 Web Simulator Live: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
