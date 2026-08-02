const express   = require('express');
const http      = require('http');
const { Server: SocketIOServer } = require('socket.io');
const webPush   = require('web-push');
const path      = require('path');
const cors      = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const webSimulatorPath = path.join(__dirname, '..', 'web-simulator');
app.use(express.static(webSimulatorPath));

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 5000
});

// ── VAPID keys for Web Push ──────────────────────────────────────────────────
// Replace with your own if you regenerate them
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BK1zmq7J9XIC7w0lNTpPsAGEtldNcNcWI4hRfXrrr6e7ft9nHMXwz6r9wFyT_6tpgF-UMH4iReoptUtBAd84B2E';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'tJpX_gTf_nBxtiDP_4t2BUoP2u0n2Ox8LjyfBIZ2cCk';

webPush.setVapidDetails(
  'mailto:admin@walkietalkie.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ── State ────────────────────────────────────────────────────────────────────
const PUBLIC_CHANNEL_CODE = '369000';
const rooms = new Map();                      // roomCode -> Set of socketIds
const pushSubs = new Map();                   // socketId -> pushSubscription
rooms.set(PUBLIC_CHANNEL_CODE, new Set());

function generateRoomCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (rooms.has(code) || code === PUBLIC_CHANNEL_CODE);
  return code;
}

// ── Send push notification to all room peers of a socket ────────────────────
async function notifyPeers(roomCode, senderSocketId, payload) {
  if (!rooms.has(roomCode)) return;
  rooms.get(roomCode).forEach(async (memberId) => {
    if (memberId === senderSocketId) return;
    const sub = pushSubs.get(memberId);
    if (!sub) return;
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      console.log(`[Push] Failed to notify ${memberId}:`, e.statusCode || e.message);
      if (e.statusCode === 410) pushSubs.delete(memberId); // expired subscription
    }
  });
}

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoom = null;

  // Store web push subscription for this socket
  socket.on('push-subscribe', (subscription) => {
    pushSubs.set(socket.id, subscription);
    console.log(`[Push] Subscription stored for ${socket.id}`);
  });

  socket.on('create-room', (data, cb) => {
    const code = generateRoomCode();
    rooms.set(code, new Set([socket.id]));
    socket.join(code);
    currentRoom = code;
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
      return cb?.({ success: false, message: 'Channel full (1-to-1 max)' });
    }

    members.add(socket.id);
    socket.join(code);
    currentRoom = code;

    const isPaired = isPublic || members.size >= 2;
    const res = { success: true, roomCode: code, isPaired, isPublic };
    cb?.(res);
    socket.emit('room-joined', res);
    socket.to(code).emit('peer-joined', { peerId: socket.id, isPaired: true, isPublic, shouldOffer: true });
  });

  // ── WebRTC Signaling ────────────────────────────────────────────────────────
  socket.on('webrtc-offer',  ({ targetId, offer })     => io.to(targetId).emit('webrtc-offer',  { fromId: socket.id, offer }));
  socket.on('webrtc-answer', ({ targetId, answer })    => io.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer }));
  socket.on('webrtc-ice',    ({ targetId, candidate }) => io.to(targetId).emit('webrtc-ice',    { fromId: socket.id, candidate }));

  // ── PTT signals + Web Push notification ─────────────────────────────────────
  socket.on('start-talk', async () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('peer-start-talk', { talkerId: socket.id });

    // Send push notification to peers who may have closed the app
    await notifyPeers(currentRoom, socket.id, {
      title: '🎙️ Incoming Transmission',
      body:  'Someone is talking in your Walkie-Talkie channel! Tap to listen.',
      tag:   'walkie-talkie-ptt',
      room:  currentRoom
    });
  });

  socket.on('stop-talk', () => {
    if (currentRoom) socket.to(currentRoom).emit('peer-stop-talk', { talkerId: socket.id });
  });

  socket.on('leave-room', () => cleanup());
  socket.on('disconnect', () => { console.log(`[-] Disconnected: ${socket.id}`); cleanup(); });

  function cleanup() {
    pushSubs.delete(socket.id);
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

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', publicChannel: PUBLIC_CHANNEL_CODE, activeRooms: rooms.size, timestamp: new Date() });
});

// Expose VAPID public key to clients
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Walkie-Talkie VoIP + Push server on port ${PORT}`);
});
