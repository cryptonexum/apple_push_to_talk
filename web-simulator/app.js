// Walkie-Talkie VoIP PWA — WebRTC Audio Engine with Background Keepalive
// Use case: Sender must have app open. Receiver can have app minimized or closed.

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

class WalkieTalkieVoIP {
  constructor(socket) {
    this.socket = socket;
    this.roomCode = null;
    this.isTalking = false;
    this.peerConnections = new Map();
    this.localStream = null;
    this.audioEnabled = false;

    // Background keepalive
    this.keepaliveAudio = null;
    this.keepaliveCtx   = null;

    // Visualizer
    this.audioCtx    = null;
    this.analyser    = null;
    this.animFrameId = null;

    this.initDOM();
    this.bindUIEvents();
    this.bindSocketEvents();
    this.checkURLRoomCode();

    // Listen for messages from Service Worker (auto-join from notification tap)
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'AUTO_JOIN' && e.data.room) {
        this.autoJoinRoom(e.data.room);
      }
    });
  }

  // ─── Silent Audio Keepalive (keeps iOS PWA alive in background) ────────────
  startKeepAlive() {
    if (this.keepaliveCtx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.keepaliveCtx = new AC();

      // Oscillator at inaudible gain — prevents iOS from suspending audio session
      const osc  = this.keepaliveCtx.createOscillator();
      const gain = this.keepaliveCtx.createGain();
      gain.gain.value = 0.00001; // essentially silent
      osc.connect(gain);
      gain.connect(this.keepaliveCtx.destination);
      osc.start();

      console.log('[Keepalive] Silent audio session started — app stays alive in background');
    } catch (e) {
      console.warn('[Keepalive] Could not start keepalive:', e);
    }
  }

  stopKeepAlive() {
    if (this.keepaliveCtx) {
      this.keepaliveCtx.close();
      this.keepaliveCtx = null;
    }
  }

  // ─── DOM ────────────────────────────────────────────────────────────────────
  initDOM() {
    this.setupEl   = document.getElementById('phone-setup');
    this.talkEl    = document.getElementById('phone-talk');
    this.codeInput = document.getElementById('phone-code-input');
    this.codeDisp  = document.getElementById('phone-code-display');
    this.peerBadge = document.getElementById('phone-peer-badge');
    this.pttBtn    = document.getElementById('phone-ptt-btn');
    this.pttLabel  = document.getElementById('phone-ptt-label');
    this.pttSub    = document.getElementById('phone-ptt-subtext');
    this.canvas    = document.getElementById('phone-canvas');
    this.ctx2d     = this.canvas.getContext('2d');
  }

  // ─── UI Events ──────────────────────────────────────────────────────────────
  bindUIEvents() {
    document.getElementById('btn-join-public')?.addEventListener('click', () => this.joinRoom('369000'));
    document.getElementById('phone-btn-create')?.addEventListener('click', () => this.createRoom());
    document.getElementById('phone-btn-join')?.addEventListener('click', () => this.joinRoom());
    document.getElementById('phone-btn-leave')?.addEventListener('click', () => this.leaveRoom());
    document.getElementById('btn-share-room')?.addEventListener('click', () => this.shareLink());
    document.getElementById('btn-toggle-sim')?.addEventListener('click', () => {
      const sim = document.getElementById('simulator-view');
      const ph  = document.getElementById('phone-view');
      const btn = document.getElementById('btn-toggle-sim');
      const showing = !sim.classList.contains('hidden');
      sim.classList.toggle('hidden', showing);
      ph.classList.toggle('hidden', !showing);
      btn.textContent = showing ? '⌚ Sim' : '📱 Phone';
    });

    const onDown = (e) => { e.preventDefault(); this.startTalk(); };
    const onUp   = (e) => { e.preventDefault(); this.stopTalk(); };

    this.pttBtn.addEventListener('mousedown',   onDown);
    this.pttBtn.addEventListener('mouseup',     onUp);
    this.pttBtn.addEventListener('mouseleave',  onUp);
    this.pttBtn.addEventListener('touchstart',  onDown, { passive: false });
    this.pttBtn.addEventListener('touchend',    onUp,   { passive: false });
    this.pttBtn.addEventListener('touchcancel', onUp,   { passive: false });
  }

  // ─── Socket Signaling Events ────────────────────────────────────────────────
  bindSocketEvents() {
    const s = this.socket;

    s.on('room-joined', (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(res.isPaired || res.isPublic); }
    });

    s.on('peer-joined', async ({ peerId, isPaired, isPublic, shouldOffer }) => {
      if (this.roomCode) {
        this.setPaired(isPaired || isPublic);
        if (shouldOffer) await this.createPeerConnection(peerId, true);
      }
    });

    s.on('peer-left', ({ peerId }) => {
      this.closePeerConnection(peerId);
      if (this.roomCode && this.roomCode !== '369000') this.setPaired(false);
    });

    s.on('webrtc-offer', async ({ fromId, offer }) => {
      const pc = await this.createPeerConnection(fromId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('webrtc-answer', { targetId: fromId, answer });
    });

    s.on('webrtc-answer', async ({ fromId, answer }) => {
      const pc = this.peerConnections.get(fromId);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    s.on('webrtc-ice', async ({ fromId, candidate }) => {
      const pc = this.peerConnections.get(fromId);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
      }
    });

    s.on('peer-start-talk', () => { if (this.roomCode) this.showPeerTalking(); });
    s.on('peer-stop-talk',  () => { if (this.roomCode) this.showPeerStopped(); });
  }

  // ─── WebRTC Peer Connection ──────────────────────────────────────────────────
  async createPeerConnection(peerId, isInitiator) {
    if (this.peerConnections.has(peerId)) this.peerConnections.get(peerId).close();

    if (!this.localStream) await this.initMicrophone();

    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peerConnections.set(peerId, pc);

    // Add muted mic tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }

    // Play remote audio when received
    pc.ontrack = (event) => {
      console.log('[WebRTC] Remote audio track received');
      this.playRemoteAudio(event.streams[0], peerId);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('webrtc-ice', { targetId: peerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => console.log(`[WebRTC] ${peerId}:`, pc.connectionState);

    if (isInitiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', { targetId: peerId, offer });
    }

    return pc;
  }

  closePeerConnection(peerId) {
    this.peerConnections.get(peerId)?.close();
    this.peerConnections.delete(peerId);
    document.getElementById(`audio-${peerId}`)?.remove();
  }

  // ─── Microphone (muted by default, PTT unmutes) ─────────────────────────────
  async initMicrophone() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
        video: false
      });
      this.setMicMute(true); // start muted

      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      this.audioCtx.createMediaStreamSource(this.localStream).connect(this.analyser);

      console.log('[MIC] Microphone ready');
    } catch (err) {
      console.error('[MIC] Permission denied:', err);
      alert('Microphone access is required for Push-to-Talk. Please allow it.');
      throw err;
    }
  }

  setMicMute(muted) {
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    this.audioEnabled = !muted;
  }

  // ─── Remote Audio Playback via <audio> element ──────────────────────────────
  playRemoteAudio(remoteStream, peerId) {
    document.getElementById(`audio-${peerId}`)?.remove();

    const audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.autoplay    = true;
    audio.playsInline = true;
    audio.srcObject   = remoteStream;
    audio.volume      = 1.0;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audio.play().catch(e => console.warn('[AUDIO] Autoplay blocked:', e));
    console.log('[AUDIO] Playing remote stream from', peerId);
  }

  // ─── Room Management ────────────────────────────────────────────────────────
  createRoom() {
    this.socket.emit('create-room', {}, (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(false); this.saveLastRoom(res.roomCode); }
    });
  }

  async joinRoom(code) {
    const c = code || this.codeInput.value.trim();
    if (!c) { alert('Enter a channel code'); return; }

    try { await this.initMicrophone(); } catch { return; }

    this.socket.emit('join-room', { roomCode: c }, (res) => {
      if (res?.success) {
        this.roomCode = res.roomCode;
        this.showTalk(res.isPaired || res.isPublic);
        this.saveLastRoom(res.roomCode);
        this.startKeepAlive(); // ← keep iOS alive in background
      } else {
        alert(res?.message || 'Failed to join');
      }
    });
  }

  // Auto-join called when notification is tapped while app was closed
  async autoJoinRoom(room) {
    if (this.roomCode === room) return;  // already in room
    console.log('[AutoJoin] Rejoining room', room, 'from push notification');
    this.codeInput.value = room;
    await this.joinRoom(room);
  }

  leaveRoom() {
    this.stopTalk();
    this.stopKeepAlive();
    this.peerConnections.forEach((_, id) => this.closePeerConnection(id));
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.socket.emit('leave-room');
    this.clearLastRoom();
    this.talkEl.classList.add('hidden');
    this.setupEl.classList.remove('hidden');
    this.roomCode = null;
  }

  // ─── Persist last room in localStorage for auto-rejoin ─────────────────────
  saveLastRoom(code) { localStorage.setItem('wt_last_room', code); }
  clearLastRoom()    { localStorage.removeItem('wt_last_room'); }

  checkURLRoomCode() {
    // Check URL param first (from notification tap)
    const params = new URLSearchParams(window.location.search);
    const urlRoom    = params.get('room');
    const autoJoin   = params.get('autoJoin') === '1';
    const savedRoom  = localStorage.getItem('wt_last_room');

    if (urlRoom?.length === 6) {
      this.codeInput.value = urlRoom;
      setTimeout(() => this.joinRoom(urlRoom), 800);
    } else if (savedRoom && autoJoin) {
      // Rejoin last known room after notification tap
      this.codeInput.value = savedRoom;
      setTimeout(() => this.joinRoom(savedRoom), 800);
    } else if (savedRoom) {
      // Pre-fill last used code for convenience
      this.codeInput.value = savedRoom;
    }
  }

  // ─── Push-to-Talk ───────────────────────────────────────────────────────────
  startTalk() {
    if (this.isTalking || this.pttBtn.disabled) return;
    this.isTalking = true;
    this.setMicMute(false);
    this.socket.emit('start-talk');
    navigator.vibrate?.([40]);
    this.pttBtn.className = 'pwa-ptt-button talking';
    this.pttLabel.textContent = 'TALKING';
    this.pttSub.textContent = 'Release to stop';
    this.drawWave();
  }

  stopTalk() {
    if (!this.isTalking) return;
    this.isTalking = false;
    this.setMicMute(true);
    this.socket.emit('stop-talk');
    navigator.vibrate?.([20]);
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPaired(true);
  }

  // ─── UI State ───────────────────────────────────────────────────────────────
  showTalk(paired) {
    this.setupEl.classList.add('hidden');
    this.talkEl.classList.remove('hidden');
    this.codeDisp.textContent = `#${this.roomCode}`;
    this.setPaired(paired);
  }

  setPaired(paired) {
    const pub = this.roomCode === '369000';
    if (pub) {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot paired"></span> 🌐 Public Channel #369000';
      this.pttBtn.disabled = false;
      this.pttBtn.className = 'pwa-ptt-button ready';
      this.pttLabel.textContent = 'HOLD TO TALK';
      this.pttSub.textContent = 'VoIP — Crystal clear';
    } else if (paired) {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot paired"></span> 🟢 VoIP Connected';
      this.pttBtn.disabled = false;
      this.pttBtn.className = 'pwa-ptt-button ready';
      this.pttLabel.textContent = 'HOLD TO TALK';
      this.pttSub.textContent = 'Hold button & speak';
    } else {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot waiting"></span> Waiting for peer...';
      this.pttBtn.disabled = true;
      this.pttBtn.className = 'pwa-ptt-button';
      this.pttLabel.textContent = 'WAITING';
      this.pttSub.textContent = 'Share the code below';
    }
  }

  showPeerTalking() {
    if (this.isTalking) return;
    this.pttBtn.className = 'pwa-ptt-button receiving';
    this.pttLabel.textContent = 'LISTENING';
    this.pttSub.textContent = 'Incoming voice...';
    navigator.vibrate?.([30, 30]);
    this.drawReceive();
  }

  showPeerStopped() {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPaired(true);
  }

  shareLink() {
    const url = `${location.origin}${location.pathname}?room=${this.roomCode}`;
    if (navigator.share) navigator.share({ title: 'Walkie-Talkie VoIP', text: `Join #${this.roomCode}`, url });
    else { navigator.clipboard.writeText(url); alert('Link copied:\n' + url); }
  }

  // ─── Visualizers ────────────────────────────────────────────────────────────
  drawWave() {
    if (!this.isTalking || !this.analyser) return;
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const w = (this.canvas.width / d.length) * 2;
    d.forEach((v, i) => {
      const h = (v / 255) * this.canvas.height;
      this.ctx2d.fillStyle = '#f7630c';
      this.ctx2d.fillRect(i * w, this.canvas.height - h, w - 1, h);
    });
    this.animFrameId = requestAnimationFrame(() => this.drawWave());
  }

  drawReceive() {
    if (this.isTalking) return;
    const t = Date.now() * 0.01;
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let x = 0; x < this.canvas.width; x += 6) {
      const h = Math.abs(Math.sin(t + x * 0.1)) * (this.canvas.height - 4) + 2;
      this.ctx2d.fillStyle = '#58a6ff';
      this.ctx2d.fillRect(x, (this.canvas.height - h) / 2, 3, h);
    }
    this.animFrameId = requestAnimationFrame(() => this.drawReceive());
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const voipApp = new WalkieTalkieVoIP(socket);

  const pill = document.getElementById('pwa-status');
  socket.on('connect',    () => { pill.innerHTML = '<span class="dot online"></span> VoIP Ready'; });
  socket.on('disconnect', () => { pill.innerHTML = '<span class="dot offline"></span> Offline'; });

  // ─── Service Worker + Web Push ─────────────────────────────────────────────
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.register('/sw.js').then(async (reg) => {
      console.log('[SW] Registered');

      // Listen for SW messages (AUTO_JOIN from notification tap)
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'AUTO_JOIN') voipApp.autoJoinRoom(e.data.room);
      });

      // Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.log('[Push] Permission denied — background push disabled');
        return;
      }

      const { publicKey } = await fetch('/api/vapid-public-key').then(r => r.json());

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      // Register push subscription with server
      const sendSub = () => socket.emit('push-subscribe', sub.toJSON());
      if (socket.connected) sendSub();
      socket.on('connect', sendSub);

      console.log('[Push] Background notifications enabled ✅');
    }).catch(e => console.warn('[SW] Failed:', e));
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
