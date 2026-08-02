// Walkie-Talkie VoIP PWA — WebRTC Audio Engine
// Uses WebRTC peer connections for real VoIP (same as WhatsApp/Discord)

// Public STUN servers for NAT traversal (free, no config needed)
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

    // WebRTC state
    this.peerConnections = new Map();   // peerId -> RTCPeerConnection
    this.localStream = null;            // microphone stream (always active after joining)
    this.audioEnabled = false;          // mic muted by default

    // Visualizer
    this.audioCtx = null;
    this.analyser = null;
    this.animFrameId = null;

    this.initDOM();
    this.bindUIEvents();
    this.bindSocketEvents();
    this.checkURLRoomCode();
  }

  // ─── DOM ───────────────────────────────────────────────────────────────────
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

  // ─── UI Events ─────────────────────────────────────────────────────────────
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

    // PTT: hold = unmute mic & signal peer, release = mute & signal peer
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
        if (shouldOffer) {
          // We are the existing user — initiate WebRTC offer to the new peer
          await this.createPeerConnection(peerId, true);
        }
      }
    });

    s.on('peer-left', ({ peerId }) => {
      this.closePeerConnection(peerId);
      if (this.roomCode && this.roomCode !== '369000') this.setPaired(false);
    });

    // Receive WebRTC offer — create answer
    s.on('webrtc-offer', async ({ fromId, offer }) => {
      console.log('[SIGNALING] Received offer from', fromId);
      const pc = await this.createPeerConnection(fromId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('webrtc-answer', { targetId: fromId, answer });
    });

    // Receive answer — complete handshake
    s.on('webrtc-answer', async ({ fromId, answer }) => {
      console.log('[SIGNALING] Received answer from', fromId);
      const pc = this.peerConnections.get(fromId);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    // Receive ICE candidate
    s.on('webrtc-ice', async ({ fromId, candidate }) => {
      const pc = this.peerConnections.get(fromId);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
      }
    });

    // PTT visual indicators from peer
    s.on('peer-start-talk', () => { if (this.roomCode) this.showPeerTalking(); });
    s.on('peer-stop-talk',  () => { if (this.roomCode) this.showPeerStopped(); });
  }

  // ─── WebRTC Peer Connection ─────────────────────────────────────────────────
  async createPeerConnection(peerId, isInitiator) {
    if (this.peerConnections.has(peerId)) {
      this.peerConnections.get(peerId).close();
    }

    // Ensure microphone is ready before creating peer connection
    if (!this.localStream) {
      await this.initMicrophone();
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peerConnections.set(peerId, pc);

    // Add mic tracks to peer connection (muted by default until PTT pressed)
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // When remote audio arrives — play it automatically
    pc.ontrack = (event) => {
      console.log('[WebRTC] Remote audio track received from', peerId);
      const remoteStream = event.streams[0];
      this.playRemoteAudio(remoteStream, peerId);
    };

    // ICE candidate exchange
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice', { targetId: peerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state with ${peerId}:`, pc.connectionState);
    };

    // If we are the initiator — create and send offer
    if (isInitiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', { targetId: peerId, offer });
    }

    return pc;
  }

  closePeerConnection(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) { pc.close(); this.peerConnections.delete(peerId); }
    // Remove audio element
    const el = document.getElementById(`audio-${peerId}`);
    if (el) el.remove();
  }

  // ─── Microphone Setup (always-on, muted unless PTT held) ───────────────────
  async initMicrophone() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });

      // Start with mic muted — PTT will unmute
      this.setMicMute(true);

      // Audio visualizer setup
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      const src = this.audioCtx.createMediaStreamSource(this.localStream);
      src.connect(this.analyser);

      console.log('[MIC] Microphone ready');
    } catch (err) {
      console.error('[MIC] Permission denied:', err);
      alert('Please allow microphone access to use Push-to-Talk.');
      throw err;
    }
  }

  setMicMute(muted) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !muted;
    });
    this.audioEnabled = !muted;
  }

  // ─── Remote Audio Playback ─────────────────────────────────────────────────
  playRemoteAudio(remoteStream, peerId) {
    // Remove old element if exists
    const old = document.getElementById(`audio-${peerId}`);
    if (old) old.remove();

    // Create <audio> element for remote stream — browser handles everything
    const audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = remoteStream;

    // Volume boost
    audio.volume = 1.0;

    // Must be in DOM for iOS Safari to play
    audio.style.display = 'none';
    document.body.appendChild(audio);

    audio.play().catch(e => console.warn('[AUDIO] Autoplay blocked:', e));
    console.log('[AUDIO] Playing remote stream from', peerId);
  }

  // ─── Room Management ───────────────────────────────────────────────────────
  createRoom() {
    this.socket.emit('create-room', {}, (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(false); }
    });
  }

  async joinRoom(code) {
    const c = code || this.codeInput.value.trim();
    if (!c) { alert('Enter a channel code'); return; }

    // Pre-request mic permission before joining
    try { await this.initMicrophone(); } catch (e) { return; }

    this.socket.emit('join-room', { roomCode: c }, (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(res.isPaired || res.isPublic); }
      else alert(res?.message || 'Failed to join');
    });
  }

  leaveRoom() {
    this.stopTalk();
    this.peerConnections.forEach((_, id) => this.closePeerConnection(id));
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.socket.emit('leave-room');
    this.talkEl.classList.add('hidden');
    this.setupEl.classList.remove('hidden');
    this.roomCode = null;
  }

  checkURLRoomCode() {
    const p = new URLSearchParams(window.location.search).get('room');
    if (p?.length === 6) { this.codeInput.value = p; setTimeout(() => this.joinRoom(p), 600); }
  }

  // ─── Push-to-Talk ──────────────────────────────────────────────────────────
  startTalk() {
    if (this.isTalking || this.pttBtn.disabled) return;
    this.isTalking = true;

    // Unmute microphone — WebRTC streams mic to all peers automatically
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

    // Mute microphone — peers hear silence
    this.setMicMute(true);

    this.socket.emit('stop-talk');
    navigator.vibrate?.([20]);

    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPaired(true);
  }

  // ─── UI State ──────────────────────────────────────────────────────────────
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
    this.pttSub.textContent = 'Incoming VoIP voice...';
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
    if (navigator.share) { navigator.share({ title: 'Walkie-Talkie VoIP', text: `Join #${this.roomCode}`, url }); }
    else { navigator.clipboard.writeText(url); alert('Link copied:\n' + url); }
  }

  // ─── Visualizers ──────────────────────────────────────────────────────────
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const app = new WalkieTalkieVoIP(socket);

  const pill = document.getElementById('pwa-status');
  socket.on('connect',    () => { pill.innerHTML = '<span class="dot online"></span> VoIP Ready'; });
  socket.on('disconnect', () => { pill.innerHTML = '<span class="dot offline"></span> Offline'; });
});
