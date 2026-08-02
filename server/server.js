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

// Initialize Socket.io for web clients
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
    // Handled by Socket.io engine
    return;
  } else {
    // Handled by native WebSocket server
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

// Rooms state: code -> { users: Map(id -> clientAdapter) }
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

// Unified client handler function
function handleClientMessaging(client) {
  let currentRoom = null;

  client.on('message', (messageData) => {
    let data = {};
    if (typeof messageData === 'string') {
      try { data = JSON.parse(messageData); } catch (e) {}
    } else if (Buffer.isBuffer(messageData)) {
      // Audio binary buffer packet received from raw WebSocket client
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        room.users.forEach((peer, peerId) => {
          if (peerId !== client.id) {
            peer.sendAudio(messageData);
          }
        });
      }
      return;
    }

    const action = data.action || data.event;

    // Actions: create-room
    if (action === 'create-room') {
      const code = data.roomCode || generateRoomCode();
      const roomData = rooms.get(code) || { code, users: new Map() };
      roomData.users.set(client.id, client);
      rooms.set(code, roomData);
      currentRoom = code;

      console.log(`[Native WS Create] Code: ${code} by ${client.id}`);
      client.sendJSON({ event: 'room-joined', success: true, roomCode: code, isPaired: false });
    }

    // Actions: join-room
    else if (action === 'join-room') {
      const code = data.roomCode?.trim();
      if (!code || !rooms.has(code)) {
        client.sendJSON({ event: 'error-message', success: false, message: 'Invalid Room Code' });
        return;
      }

      const roomData = rooms.get(code);
      if (roomData.users.size >= 2 && !roomData.users.has(client.id)) {
        client.sendJSON({ event: 'error-message', success: false, message: 'Room Full (1-to-1 max)' });
        return;
      }

      roomData.users.set(client.id, client);
      currentRoom = code;

      console.log(`[Native WS Join] Code: ${code} by ${client.id}`);
      const isPaired = roomData.users.size === 2;
      client.sendJSON({ event: 'room-joined', success: true, roomCode: code, isPaired });

      // Notify peer
      roomData.users.forEach((peer, peerId) => {
        if (peerId !== client.id) {
          peer.sendJSON({ event: 'peer-joined', peerId: client.id, isPaired: true });
        }
      });
    }

    // Actions: start-talk
    else if (action === 'start-talk') {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const room = rooms.get(currentRoom);
      room.users.forEach((peer, peerId) => {
        if (peerId !== client.id) {
          peer.sendJSON({ event: 'peer-start-talk', talkerId: client.id });
        }
      });
    }

    // Actions: stop-talk
    else if (action === 'stop-talk') {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const room = rooms.get(currentRoom);
      room.users.forEach((peer, peerId) => {
        if (peerId !== client.id) {
          peer.sendJSON({ event: 'peer-stop-talk', talkerId: client.id });
        }
      });
    }

    // Actions: leave-room
    else if (action === 'leave-room') {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        room.users.delete(client.id);
        room.users.forEach((peer) => {
          peer.sendJSON({ event: 'peer-left', peerId: client.id, isPaired: false });
        });
        if (room.users.size === 0) rooms.delete(currentRoom);
      }
      currentRoom = null;
    }
  });

  client.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(client.id);
      room.users.forEach((peer) => {
        peer.sendJSON({ event: 'peer-left', peerId: client.id, isPaired: false });
      });
      if (room.users.size === 0) rooms.delete(currentRoom);
    }
  });
}

// 1. Native WebSocket Connection Handler (Apple Watch)
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const id = 'ws_' + Math.random().toString(36).substr(2, 9);
  console.log(`[+] Native WebSocket connected: ${id}`);

  const clientAdapter = {
    id,
    type: 'native-ws',
    sendJSON: (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    sendAudio: (buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    },
    on: (evt, cb) => {
      if (evt === 'message') {
        ws.on('message', (msg) => cb(msg));
      } else if (evt === 'close') {
        ws.on('close', cb);
      }
    }
  };

  handleClientMessaging(clientAdapter);
});

// 2. Socket.io Connection Handler (Web Simulator)
io.on('connection', (socket) => {
  console.log(`[+] Socket.io connected: ${socket.id}`);

  const clientAdapter = {
    id: socket.id,
    type: 'socket.io',
    sendJSON: (obj) => socket.emit(obj.event || 'message', obj),
    sendAudio: (chunk) => socket.emit('audio-chunk', { senderId: socket.id, chunk }),
    on: (evt, cb) => {
      if (evt === 'message') {
        socket.onAny((event, ...args) => {
          if (event === 'audio-chunk') {
            cb(args[0]);
          } else {
            cb({ action: event, ...args[0] });
          }
        });
      } else if (evt === 'close') {
        socket.on('disconnect', cb);
      }
    }
  };

  handleClientMessaging(clientAdapter);
});

// API Info endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
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
  console.log(`📡 Native WebSocket Endpoint: wss://.../`);
  console.log(`🌐 Socket.io Web Simulator: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
