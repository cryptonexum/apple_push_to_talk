// Walkie-Talkie PWA — Clean Audio Engine

class WalkieTalkieApp {
  constructor(socket) {
    this.socket = socket;
    this.roomCode = null;
    this.isTalking = false;
    this.audioCtx = null;
    this.micStream = null;
    this.mediaRecorder = null;
    this.nextPlayTime = 0;
    this.animFrameId = null;
    this.analyser = null;

    this.initDOM();
    this.bindEvents();
    this.checkURLRoomCode();

    // Unlock AudioContext on first user touch (iOS requirement)
    const unlock = () => {
      this.getAudioCtx();
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('mousedown', unlock);
    };
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('mousedown', unlock, { once: true });
  }

  // ---------- Audio Context ----------
  getAudioCtx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      // Play a silent buffer to unlock iOS speaker
      const buf = this.audioCtx.createBuffer(1, 1, 22050);
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      src.start(0);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // ---------- DOM ----------
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

  bindEvents() {
    document.getElementById('btn-join-public')?.addEventListener('click', () => {
      this.getAudioCtx();
      this.joinRoom('369000');
    });
    document.getElementById('phone-btn-create')?.addEventListener('click', () => {
      this.getAudioCtx();
      this.createRoom();
    });
    document.getElementById('phone-btn-join')?.addEventListener('click', () => {
      this.getAudioCtx();
      this.joinRoom();
    });
    document.getElementById('phone-btn-leave')?.addEventListener('click', () => this.leaveRoom());
    document.getElementById('btn-share-room')?.addEventListener('click', () => this.shareLink());
    document.getElementById('btn-toggle-sim')?.addEventListener('click', () => {
      const sim = document.getElementById('simulator-view');
      const ph  = document.getElementById('phone-view');
      const btn = document.getElementById('btn-toggle-sim');
      if (sim.classList.contains('hidden')) {
        sim.classList.remove('hidden'); ph.classList.add('hidden'); btn.textContent = '📱 Phone';
      } else {
        sim.classList.add('hidden'); ph.classList.remove('hidden'); btn.textContent = '⌚ Sim';
      }
    });

    // Push-to-Talk: hold = talk, release = stop
    const onDown = (e) => { e.preventDefault(); this.getAudioCtx(); this.startTalk(); };
    const onUp   = (e) => { e.preventDefault(); this.stopTalk(); };

    this.pttBtn.addEventListener('mousedown',   onDown);
    this.pttBtn.addEventListener('mouseup',     onUp);
    this.pttBtn.addEventListener('mouseleave',  onUp);
    this.pttBtn.addEventListener('touchstart',  onDown, { passive: false });
    this.pttBtn.addEventListener('touchend',    onUp,   { passive: false });
    this.pttBtn.addEventListener('touchcancel', onUp,   { passive: false });
  }

  checkURLRoomCode() {
    const p = new URLSearchParams(window.location.search).get('room');
    if (p?.length === 6) { this.codeInput.value = p; setTimeout(() => this.joinRoom(p), 600); }
  }

  // ---------- Room Management ----------
  createRoom() {
    this.socket.emit('create-room', {}, (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(res.isPaired); }
    });
  }

  joinRoom(code) {
    const c = code || this.codeInput.value.trim();
    if (!c) { alert('Enter a room code'); return; }
    this.socket.emit('join-room', { roomCode: c }, (res) => {
      if (res?.success) { this.roomCode = res.roomCode; this.showTalk(res.isPaired || res.isPublic); }
      else alert(res?.message || 'Failed to join');
    });
  }

  leaveRoom() {
    this.stopTalk();
    this.socket.emit('leave-room');
    this.talkEl.classList.add('hidden');
    this.setupEl.classList.remove('hidden');
    this.roomCode = null;
    this.codeInput.value = '';
  }

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
      this.pttSub.textContent = 'Public Broadcast';
    } else if (paired) {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot paired"></span> Paired — Ready to Talk';
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

  shareLink() {
    const url = `${location.origin}${location.pathname}?room=${this.roomCode}`;
    if (navigator.share) {
      navigator.share({ title: 'Walkie-Talkie', text: `Join channel #${this.roomCode}`, url });
    } else {
      navigator.clipboard.writeText(url);
      alert('Link copied: ' + url);
    }
  }

  // ---------- Push-to-Talk ----------
  async startTalk() {
    if (this.isTalking || this.pttBtn.disabled) return;
    this.isTalking = true;

    this.pttBtn.className = 'pwa-ptt-button talking';
    this.pttLabel.textContent = 'TALKING';
    this.pttSub.textContent = 'Release to stop';
    this.socket.emit('start-talk');
    navigator.vibrate?.([40]);

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Visualizer
      const ac = this.getAudioCtx();
      const src = ac.createMediaStreamSource(this.micStream);
      src.connect(this.analyser);
      this.drawWave();

      // Use MediaRecorder to get real compressed audio blobs
      let mime = '';
      for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
        if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
      }

      const opts = mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : {};
      this.mediaRecorder = new MediaRecorder(this.micStream, opts);

      this.mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          // Convert Blob -> ArrayBuffer -> send binary over socket
          const ab = await e.data.arrayBuffer();
          this.socket.emit('audio-chunk', ab);
        }
      };

      // Fire every 300ms for low-latency real-time streaming
      this.mediaRecorder.start(300);
      console.log('[MIC] Recording started, codec:', mime || 'default');

    } catch (err) {
      console.error('[MIC] Error:', err);
      alert('Microphone access denied. Please allow microphone in browser settings.');
      this.stopTalk();
    }
  }

  stopTalk() {
    if (!this.isTalking) return;
    this.isTalking = false;

    this.mediaRecorder?.state !== 'inactive' && this.mediaRecorder?.stop();
    this.micStream?.getTracks().forEach(t => t.stop());
    this.mediaRecorder = null;
    this.micStream = null;

    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.socket.emit('stop-talk');
    navigator.vibrate?.([20]);
    this.setPaired(true);
  }

  // ---------- Incoming Audio Playback ----------
  peerTalkStart() {
    this.nextPlayTime = 0; // reset scheduler
    this.getAudioCtx().resume();
    this.pttBtn.className = 'pwa-ptt-button receiving';
    this.pttLabel.textContent = 'LISTENING';
    this.pttSub.textContent = 'Incoming voice...';
    navigator.vibrate?.([30, 30]);
    this.drawReceive();
  }

  peerTalkStop() {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPaired(true);
  }

  async playIncomingChunk(arrayBuffer) {
    try {
      const ac = this.getAudioCtx();
      if (ac.state === 'suspended') await ac.resume();

      // Decode compressed audio (webm/mp4/ogg blob) -> AudioBuffer
      ac.decodeAudioData(arrayBuffer.slice(0), (decoded) => {
        const src = ac.createBufferSource();
        src.buffer = decoded;

        // Optional: small gain boost
        const gain = ac.createGain();
        gain.gain.value = 2.0;
        src.connect(gain);
        gain.connect(ac.destination);

        // Gapless scheduling
        const now = ac.currentTime;
        if (this.nextPlayTime < now + 0.05) this.nextPlayTime = now + 0.05;
        src.start(this.nextPlayTime);
        this.nextPlayTime += decoded.duration;

      }, (err) => {
        console.warn('[AUDIO] Decode failed:', err);
      });

    } catch (e) {
      console.error('[AUDIO] Playback error:', e);
    }
  }

  // ---------- Visualizers ----------
  drawWave() {
    if (!this.isTalking) return;
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

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const app = new WalkieTalkieApp(socket);

  const pill = document.getElementById('pwa-status');
  socket.on('connect',    () => { pill.innerHTML = '<span class="dot online"></span> Online'; });
  socket.on('disconnect', () => { pill.innerHTML = '<span class="dot offline"></span> Offline'; });

  // Room events
  socket.on('room-joined',     (r) => { if (r?.success) { app.roomCode = r.roomCode; app.showTalk(r.isPaired || r.isPublic); } });
  socket.on('peer-joined',     (d) => { if (app.roomCode) app.setPaired(d.isPaired || d.isPublic); });
  socket.on('peer-left',       ()  => { if (app.roomCode && app.roomCode !== '369000') app.setPaired(false); });
  socket.on('peer-start-talk', ()  => { if (app.roomCode) app.peerTalkStart(); });
  socket.on('peer-stop-talk',  ()  => { if (app.roomCode) app.peerTalkStop(); });

  // *** CRITICAL: incoming audio binary ArrayBuffer ***
  socket.on('audio-chunk', (buffer) => {
    if (!app.roomCode) return;
    // socket.io delivers this as ArrayBuffer when sent as ArrayBuffer
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
      app.playIncomingChunk(buffer);
    } else if (buffer?.buffer instanceof ArrayBuffer) {
      // Handle Uint8Array or Buffer
      app.playIncomingChunk(buffer.buffer);
    } else {
      console.warn('[AUDIO] Unexpected chunk type:', typeof buffer, buffer);
    }
  });
});
