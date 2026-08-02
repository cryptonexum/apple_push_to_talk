const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve static web simulator files
const webSimulatorPath = path.join(__dirname, '..', 'web-simulator');
app.use(express.static(webSimulatorPath));

const server = http.createServer(app);

// Initialize Socket.io for web & PWA clients
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7,
  pingInterval: 10000,
  pingTimeout: 5000
});

// Initialize Native WebSocket Server for Apple Watch URLSessionWebSocketTask
const wss = new WebSocketServer({ noServer: true });

// Handle HTTP Upgrade requests
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname.startsWith('/socket.io/')) {
    return;
  } else {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

// Server-side Ping Keepalive to prevent proxy disconnects (Code 1006)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// Public persistent channel code constant
const PUBLIC_CHANNEL_CODE = '369000';

// Unified Room state: code -> { isPublic: bool, users: Map(id -> clientAdapter) }
const rooms = new Map();

// Initialize permanent public channel 369000
rooms.set(PUBLIC_CHANNEL_CODE, { isPublic: true, users: new Map() });

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code) || code === PUBLIC_CHANNEL_CODE);
  return code;
}

// ----------------------------------------------------
// 1. Socket.io Event Handling (PWA & Web Clients)
// ----------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[+] Socket.io client connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('create-room', (data, callback) => {
    const code = generateRoomCode();
    const roomData = rooms.get(code) || { isPublic: false, users: new Map() };
    roomData.users.set(socket.id, {
      type: 'socket.io',
      sendJSON: (obj) => socket.emit(obj.event || 'message', obj),
      sendAudio: (audioPayload) => socket.emit('audio-chunk', { senderId: socket.id, audioPayload })
    });
    rooms.set(code, roomData);
    socket.join(code);
    currentRoom = code;

    console.log(`[Create Room] Code: ${code} by Socket.io client ${socket.id}`);
    const response = { success: true, roomCode: code, isPaired: false };
    if (typeof callback === 'function') callback(response);
    socket.emit('room-joined', response);
  });

  socket.on('join-room', (data, callback) => {
    const code = data?.roomCode?.trim() || PUBLIC_CHANNEL_CODE;
    
    if (!rooms.has(code)) {
      if (code === PUBLIC_CHANNEL_CODE) {
        rooms.set(PUBLIC_CHANNEL_CODE, { isPublic: true, users: new Map() });
      } else {
        rooms.set(code, { isPublic: false, users: new Map() });
      }
    }

    const roomData = rooms.get(code);
    
    if (!roomData.isPublic && roomData.users.size >= 2 && !roomData.users.has(socket.id)) {
      const err = { success: false, message: 'Private channel is full (1-to-1 max)' };
      if (typeof callback === 'function') callback(err);
      socket.emit('error-message', err);
      return;
    }

    roomData.users.set(socket.id, {
      type: 'socket.io',
      sendJSON: (obj) => socket.emit(obj.event || 'message', obj),
      sendAudio: (audioPayload) => socket.emit('audio-chunk', { senderId: socket.id, audioPayload })
    });
    socket.join(code);
    currentRoom = code;

    console.log(`[Join Room] Code: ${code} (Public: ${roomData.isPublic}) by ${socket.id}`);
    const isPaired = roomData.isPublic ? true : roomData.users.size >= 2;
    const response = { success: true, roomCode: code, isPaired, isPublic: roomData.isPublic };
    if (typeof callback === 'function') callback(response);
    socket.emit('room-joined', response);

    // Notify peers in room
    roomData.users.forEach((peer, peerId) => {
      if (peerId !== socket.id) {
        peer.sendJSON({ event: 'peer-joined', peerId: socket.id, isPaired: true, isPublic: roomData.isPublic });
      }
    });
  });

  socket.on('start-talk', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.users.forEach((peer, peerId) => {
      if (peerId !== socket.id) {
        peer.sendJSON({ event: 'peer-start-talk', talkerId: socket.id });
      }
    });
  });

  socket.on('audio-chunk', (audioPayload) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.users.forEach((peer, peerId) => {
      if (peerId !== socket.id) {
        peer.sendAudio(audioPayload);
      }
    });
  });

  socket.on('stop-talk', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    room.users.forEach((peer, peerId) => {
      if (peerId !== socket.id) {
        peer.sendJSON({ event: 'peer-stop-talk', talkerId: socket.id });
      }
    });
  });

  socket.on('leave-room', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);
      room.users.forEach((peer) => {
        peer.sendJSON({ event: 'peer-left', peerId: socket.id, isPaired: room.users.size > 1 });
      });
      if (room.users.size === 0 && !room.isPublic) rooms.delete(currentRoom);
    }
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    console.log(`[-] Socket.io client disconnected: ${socket.id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);
      room.users.forEach((peer) => {
        peer.sendJSON({ event: 'peer-left', peerId: socket.id, isPaired: room.users.size > 1 });
      });
      if (room.users.size === 0 && !room.isPublic) rooms.delete(currentRoom);
    }
  });
});

// ----------------------------------------------------
// 2. Native WebSocket Handling (Apple Watch Swift)
// ----------------------------------------------------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const id = 'ws_' + Math.random().toString(36).substr(2, 9);
  console.log(`[+] Native WebSocket client connected: ${id}`);
  let currentRoom = null;

  const clientAdapter = {
    type: 'native-ws',
    sendJSON: (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    sendAudio: (buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    }
  };

  ws.on('message', (messageData) => {
    let data = {};
    if (typeof messageData === 'string') {
      try { data = JSON.parse(messageData); } catch (e) {}
    } else if (Buffer.isBuffer(messageData)) {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        room.users.forEach((peer, peerId) => {
          if (peerId !== id) {
            peer.sendAudio(messageData);
          }
        });
      }
      return;
    }

    const action = data.action || data.event;

    if (action === 'create-room') {
      const code = data.roomCode || generateRoomCode();
      const roomData = rooms.get(code) || { isPublic: false, users: new Map() };
      roomData.users.set(id, clientAdapter);
      rooms.set(code, roomData);
      currentRoom = code;

      console.log(`[Create Room] Code: ${code} by Native WS client ${id}`);
      clientAdapter.sendJSON({ event: 'room-joined', success: true, roomCode: code, isPaired: false });
    }

    else if (action === 'join-room') {
      const code = data.roomCode?.trim() || PUBLIC_CHANNEL_CODE;
      
      if (!rooms.has(code)) {
        if (code === PUBLIC_CHANNEL_CODE) {
          rooms.set(PUBLIC_CHANNEL_CODE, { isPublic: true, users: new Map() });
        } else {
          rooms.set(code, { isPublic: false, users: new Map() });
        }
      }

      const roomData = rooms.get(code);
      if (!roomData.isPublic && roomData.users.size >= 2 && !roomData.users.has(id)) {
        clientAdapter.sendJSON({ event: 'error-message', success: false, message: 'Private Channel Full (1-to-1 max)' });
        return;
      }

      roomData.users.set(id, clientAdapter);
      currentRoom = code;

      console.log(`[Join Room] Code: ${code} (Public: ${roomData.isPublic}) by Native WS client ${id}`);
      const isPaired = roomData.isPublic ? true : roomData.users.size >= 2;
      clientAdapter.sendJSON({ event: 'room-joined', success: true, roomCode: code, isPaired, isPublic: roomData.isPublic });

      roomData.users.forEach((peer, peerId) => {
        if (peerId !== id) {
          peer.sendJSON({ event: 'peer-joined', peerId: id, isPaired: true, isPublic: roomData.isPublic });
        }
      });
    }

    else if (action === 'start-talk') {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const room = rooms.get(currentRoom);
      room.users.forEach((peer, peerId) => {
        if (peerId !== id) {
          peer.sendJSON({ event: 'peer-start-talk', talkerId: id });
        }
      });
    }

    else if (action === 'stop-talk') {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const room = rooms.get(currentRoom);
      room.users.forEach((peer, peerId) => {
        if (peerId !== id) {
          peer.sendJSON({ event: 'peer-stop-talk', talkerId: id });
        }
      });
    }

    else if (action === 'leave-room') {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        room.users.delete(id);
        room.users.forEach((peer) => {
          peer.sendJSON({ event: 'peer-left', peerId: id, isPaired: room.users.size > 1 });
        });
        if (room.users.size === 0 && !room.isPublic) rooms.delete(currentRoom);
      }
      currentRoom = null;
    }
  });

  ws.on('close', () => {
    console.log(`[-] Native WebSocket client disconnected: ${id}`);
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(id);
      room.users.forEach((peer) => {
        peer.sendJSON({ event: 'peer-left', peerId: id, isPaired: room.users.size > 1 });
      });
      if (room.users.size === 0 && !room.isPublic) rooms.delete(currentRoom);
    }
  });
});

// API Info endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    publicChannel: PUBLIC_CHANNEL_CODE,
    nativeWebSockets: wss.clients.size,
    socketIO: io.sockets.sockets.size,
    activeRooms: rooms.size,
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Dual-Protocol Relay Server running on port ${PORT}`);
  console.log(`🌐 Public Channel Code: ${PUBLIC_CHANNEL_CODE}`);
  console.log(`====================================================`);
});
