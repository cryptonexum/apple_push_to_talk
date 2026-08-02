// iPhone & Apple Watch Progressive Web App (PWA) Walkie-Talkie

class PhoneWalkieTalkieApp {
  constructor(socket) {
    this.socket = socket;
    this.roomCode = null;
    this.isTalking = false;
    this.isReceiving = false;
    this.audioContext = null;
    this.analyser = null;
    this.scriptProcessor = null;
    this.micStream = null;
    this.animFrameId = null;
    this.nextPlayTime = 0;
    this.isAudioUnlocked = false;

    this.initDOM();
    this.bindEvents();
    this.checkURLRoomCode();
    this.setupAudioUnlockListener();
  }

  initDOM() {
    this.pwaStatus = document.getElementById('pwa-status');
    this.phoneSetup = document.getElementById('phone-setup');
    this.phoneTalk = document.getElementById('phone-talk');
    this.codeInput = document.getElementById('phone-code-input');
    this.btnPublic = document.getElementById('btn-join-public');
    this.btnCreate = document.getElementById('phone-btn-create');
    this.btnJoin = document.getElementById('phone-btn-join');
    this.btnLeave = document.getElementById('phone-btn-leave');
    this.btnShare = document.getElementById('btn-share-room');
    this.codeDisplay = document.getElementById('phone-code-display');
    this.peerBadge = document.getElementById('phone-peer-badge');
    this.peerStatus = document.getElementById('phone-peer-status');
    this.pttBtn = document.getElementById('phone-ptt-btn');
    this.pttLabel = document.getElementById('phone-ptt-label');
    this.pttSubtext = document.getElementById('phone-ptt-subtext');
    this.canvas = document.getElementById('phone-canvas');
    this.canvasCtx = this.canvas.getContext('2d');
  }

  bindEvents() {
    if (this.btnPublic) {
      this.btnPublic.addEventListener('click', () => this.joinPublicChannel());
    }
    this.btnCreate.addEventListener('click', () => this.createRoom());
    this.btnJoin.addEventListener('click', () => this.joinRoom());
    this.btnLeave.addEventListener('click', () => this.leaveRoom());
    this.btnShare.addEventListener('click', () => this.shareRoomLink());

    // Push-to-Talk touch & mouse hold events
    const startPTT = (e) => {
      e.preventDefault();
      this.unlockAudioContext();
      if (this.pttBtn.disabled || this.isTalking || this.isReceiving) return;
      this.startTalking();
    };

    const stopPTT = (e) => {
      e.preventDefault();
      if (this.isTalking) {
        this.stopTalking();
      }
    };

    this.pttBtn.addEventListener('mousedown', startPTT);
    this.pttBtn.addEventListener('mouseup', stopPTT);
    this.pttBtn.addEventListener('mouseleave', stopPTT);

    this.pttBtn.addEventListener('touchstart', startPTT, { passive: false });
    this.pttBtn.addEventListener('touchend', stopPTT, { passive: false });
    this.pttBtn.addEventListener('touchcancel', stopPTT, { passive: false });
  }

  setupAudioUnlockListener() {
    const unlock = () => {
      this.unlockAudioContext();
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('click', unlock, { once: true });
  }

  async unlockAudioContext() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({ latencyHint: 'interactive' });
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;

      // Master Gain Boost Node (Volume multiplier = 4.0)
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.setValueAtTime(4.0, this.audioContext.currentTime);
      this.gainNode.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (!this.isAudioUnlocked) {
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gainNode);
      source.start(0);
      this.isAudioUnlocked = true;
      console.log('[Audio Engine] Speaker Output Unlocked');
    }
  }

  checkURLRoomCode() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && roomParam.length === 6) {
      this.codeInput.value = roomParam;
      setTimeout(() => this.joinRoom(), 500);
    }
  }

  vibrate(pattern = [25]) {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }

  playBeep(freq = 600, duration = 0.08) {
    try {
      this.unlockAudioContext();
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.audioContext.currentTime);
      gain.gain.setValueAtTime(0.2, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.gainNode);
      osc.start();
      osc.stop(this.audioContext.currentTime + duration);
    } catch (err) {}
  }

  joinPublicChannel() {
    this.unlockAudioContext();
    this.vibrate([20]);
    this.codeInput.value = '369000';
    this.joinRoom('369000');
  }

  createRoom() {
    this.unlockAudioContext();
    this.vibrate([15]);
    this.socket.emit('create-room', { deviceType: 'iPhone PWA' }, (res) => {
      if (res && res.success) {
        this.roomCode = res.roomCode;
        this.showTalkView(res.isPaired);
      }
    });
  }

  joinRoom(targetCode) {
    this.unlockAudioContext();
    this.vibrate([15]);
    const code = targetCode || this.codeInput.value.trim() || '369000';
    this.socket.emit('join-room', { roomCode: code, deviceType: 'iPhone PWA' }, (res) => {
      if (res && res.success) {
        this.roomCode = res.roomCode;
        this.showTalkView(res.isPaired || res.isPublic);
      } else if (res && !res.success) {
        alert(res.message || 'Failed to join channel');
      }
    });
  }

  onRoomJoinedEvent(res) {
    if (res && res.success) {
      this.roomCode = res.roomCode;
      this.showTalkView(res.isPaired || res.isPublic);
    }
  }

  showTalkView(isPaired) {
    this.phoneSetup.classList.add('hidden');
    this.phoneTalk.classList.remove('hidden');
    this.codeDisplay.textContent = `#${this.roomCode}`;
    this.updatePairState(isPaired);
  }

  updatePairState(isPaired) {
    const isPublic = this.roomCode === '369000';
    if (isPublic) {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot paired"></span> Global Public Channel #369000';
      this.pttBtn.disabled = false;
      this.pttBtn.className = 'pwa-ptt-button ready';
      this.pttLabel.textContent = 'HOLD TO TALK';
      this.pttSubtext.textContent = 'Public Broadcast';
    } else if (isPaired) {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot paired"></span> Paired with Friend';
      this.pttBtn.disabled = false;
      this.pttBtn.className = 'pwa-ptt-button ready';
      this.pttLabel.textContent = 'HOLD TO TALK';
      this.pttSubtext.textContent = 'Press & Speak';
    } else {
      this.peerBadge.innerHTML = '<span class="status-indicator-dot waiting"></span> Waiting for friend to join...';
      this.pttBtn.disabled = true;
      this.pttBtn.className = 'pwa-ptt-button';
      this.pttLabel.textContent = 'WAITING';
      this.pttSubtext.textContent = 'Share Code Below';
    }
  }

  shareRoomLink() {
    const link = `${window.location.origin}${window.location.pathname}?room=${this.roomCode}`;
    if (navigator.share) {
      navigator.share({
        title: 'Walkie-Talkie Channel',
        text: `Join my Walkie-Talkie channel #${this.roomCode} to talk!`,
        url: link
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(link);
      alert(`Channel Link copied to clipboard!\n\n${link}`);
    }
  }

  // Real-Time High Performance Int16 PCM Audio Streamer
  async startTalking() {
    await this.unlockAudioContext();
    this.vibrate([40]);
    this.playBeep(880, 0.1);
    this.isTalking = true;

    this.pttBtn.className = 'pwa-ptt-button talking';
    this.pttLabel.textContent = 'TALKING';
    this.pttSubtext.textContent = 'Release when done';

    this.socket.emit('start-talk');

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const source = this.audioContext.createMediaStreamSource(this.micStream);
      source.connect(this.analyser);
      this.drawWaveform();

      const bufferSize = 2048;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isTalking) return;
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767) binary buffer
        const int16Array = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send binary ArrayBuffer over socket
        this.socket.emit('audio-chunk', {
          pcm: int16Array.buffer,
          sampleRate: this.audioContext.sampleRate
        });
      };

      source.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);

    } catch (err) {
      console.error('Microphone error:', err);
      this.drawSyntheticWaveform();
    }
  }

  stopTalking() {
    if (!this.isTalking) return;
    this.isTalking = false;
    this.vibrate([20]);
    this.playBeep(440, 0.1);

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.socket.emit('stop-talk');
    this.updatePairState(true);
  }

  onPeerStartTalk() {
    this.isReceiving = true;
    this.nextPlayTime = 0;
    this.unlockAudioContext();
    this.vibrate([30, 30]);
    this.playBeep(700, 0.08);
    this.pttBtn.className = 'pwa-ptt-button receiving';
    this.pttLabel.textContent = 'LISTENING';
    this.pttSubtext.textContent = 'Incoming Voice...';
    this.drawReceivingWaveform();
  }

  onPeerStopTalk() {
    this.isReceiving = false;
    this.vibrate([20]);
    this.playBeep(350, 0.08);
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.updatePairState(true);
  }

  // Real-Time High Performance Int16 PCM Audio Playback Engine
  async onIncomingAudioChunk(payload) {
    try {
      await this.unlockAudioContext();

      const audioData = payload?.audioPayload || payload;
      let rawBuffer = audioData?.pcm;
      let sampleRate = audioData?.sampleRate || 22050;

      if (!rawBuffer) return;

      // Handle ArrayBuffer or Socket.io binary buffer payload
      let int16Array;
      if (rawBuffer instanceof ArrayBuffer) {
        int16Array = new Int16Array(rawBuffer);
      } else if (rawBuffer.data) {
        int16Array = new Int16Array(new Uint8Array(rawBuffer.data).buffer);
      } else {
        int16Array = new Int16Array(rawBuffer);
      }

      if (int16Array.length === 0) return;

      // Create Web Audio PCM buffer
      const audioBuffer = this.audioContext.createBuffer(1, int16Array.length, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      // Convert Int16 back to Float32 sample
      for (let i = 0; i < int16Array.length; i++) {
        channelData[i] = int16Array[i] / (int16Array[i] < 0 ? 32768 : 32767);
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Connect to Volume Gain Booster -> Speaker Output
      source.connect(this.gainNode);

      // Gapless scheduling
      const now = this.audioContext.currentTime;
      if (this.nextPlayTime < now) {
        this.nextPlayTime = now;
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;

    } catch (e) {
      console.error('PCM playback error:', e);
    }
  }

  leaveRoom() {
    this.vibrate([15]);
    this.socket.emit('leave-room');
    if (this.isTalking) this.stopTalking();
    this.phoneTalk.classList.add('hidden');
    this.phoneSetup.classList.remove('hidden');
    this.codeInput.value = '';
    this.roomCode = null;
  }

  drawWaveform() {
    if (!this.isTalking) return;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);

    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const barWidth = (this.canvas.width / bufferLength) * 2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * this.canvas.height;
      this.canvasCtx.fillStyle = '#f7630c';
      this.canvasCtx.fillRect(x, this.canvas.height - barHeight, barWidth - 1, barHeight);
      x += barWidth;
    }

    this.animFrameId = requestAnimationFrame(() => this.drawWaveform());
  }

  drawReceivingWaveform() {
    if (!this.isReceiving) return;
    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const time = Date.now() * 0.01;
    this.canvasCtx.fillStyle = '#58a6ff';

    for (let x = 0; x < this.canvas.width; x += 6) {
      const height = Math.abs(Math.sin(time + x * 0.1)) * (this.canvas.height - 4) + 2;
      this.canvasCtx.fillRect(x, (this.canvas.height - height) / 2, 3, height);
    }

    this.animFrameId = requestAnimationFrame(() => this.drawReceivingWaveform());
  }

  drawSyntheticWaveform() {
    this.drawReceivingWaveform();
  }
}

// Global Initialization
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  const statusPill = document.getElementById('pwa-status');
  const btnToggleSim = document.getElementById('btn-toggle-sim');
  const phoneView = document.getElementById('phone-view');
  const simView = document.getElementById('simulator-view');

  socket.on('connect', () => {
    statusPill.innerHTML = '<span class="dot online"></span> Server Online';
  });

  socket.on('disconnect', () => {
    statusPill.innerHTML = '<span class="dot offline"></span> Server Offline';
  });

  // Toggle View Mode (iPhone PWA vs Dual Watch Sim)
  btnToggleSim.addEventListener('click', () => {
    if (simView.classList.contains('hidden')) {
      simView.classList.remove('hidden');
      phoneView.classList.add('hidden');
      btnToggleSim.textContent = '📱 Phone';
    } else {
      simView.classList.add('hidden');
      phoneView.classList.remove('hidden');
      btnToggleSim.textContent = '⌚ Sim';
    }
  });

  // Initialize iPhone Walkie Talkie App
  const phoneApp = new PhoneWalkieTalkieApp(socket);

  // Global socket message router
  socket.on('room-joined', (res) => {
    phoneApp.onRoomJoinedEvent(res);
  });

  socket.on('peer-joined', (data) => {
    if (phoneApp.roomCode) phoneApp.updatePairState(data.isPaired || data.isPublic);
  });

  socket.on('peer-left', (data) => {
    if (phoneApp.roomCode && phoneApp.roomCode !== '369000') phoneApp.updatePairState(false);
  });

  socket.on('peer-start-talk', (data) => {
    if (phoneApp.roomCode && data.talkerId !== socket.id) phoneApp.onPeerStartTalk();
  });

  socket.on('peer-stop-talk', (data) => {
    if (phoneApp.roomCode) phoneApp.onPeerStopTalk();
  });

  socket.on('audio-chunk', (data) => {
    if (phoneApp.roomCode && data.senderId !== socket.id) phoneApp.onIncomingAudioChunk(data.audioPayload || data);
  });
});
