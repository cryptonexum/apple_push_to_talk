// Apple Watch 1-to-1 Walkie-Talkie Web Simulator Logic

class WatchSimulator {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.roomCode = null;
    this.isTalking = false;
    this.isReceiving = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioContext = null;
    this.analyser = null;
    this.animFrameId = null;

    this.initDOM();
    this.bindEvents();
    this.startClock();
  }

  initDOM() {
    this.setupView = document.getElementById(`setup-view-${this.id}`);
    this.talkView = document.getElementById(`talk-view-${this.id}`);
    this.codeInput = document.getElementById(`code-input-${this.id}`);
    this.btnCreate = document.getElementById(`btn-create-${this.id}`);
    this.btnJoin = document.getElementById(`btn-join-${this.id}`);
    this.btnDisconnect = document.getElementById(`btn-disconnect-${this.id}`);
    this.pttBtn = document.getElementById(`ptt-btn-${this.id}`);
    this.pttLabel = document.getElementById(`ptt-label-${this.id}`);
    this.peerInd = document.getElementById(`peer-ind-${this.id}`);
    this.badgeCode = document.getElementById(`badge-code-${this.id}`);
    this.canvas = document.getElementById(`canvas-${this.id}`);
    this.canvasCtx = this.canvas.getContext('2d');
    this.timeDisplay = document.getElementById(`time-${this.id}`);
    this.crownBtn = document.getElementById(`crown-${this.id}`);
  }

  bindEvents() {
    this.btnCreate.addEventListener('click', () => this.createRoom());
    this.btnJoin.addEventListener('click', () => this.joinRoom());
    this.btnDisconnect.addEventListener('click', () => this.leaveRoom());

    // Push To Talk button events (Hold to talk)
    const startPTT = (e) => {
      e.preventDefault();
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

    this.pttBtn.addEventListener('touchstart', startPTT);
    this.pttBtn.addEventListener('touchend', stopPTT);

    // Crown click easter egg / vibration
    this.crownBtn.addEventListener('click', () => {
      this.playBeep(800, 0.05);
    });
  }

  startClock() {
    const updateTime = () => {
      const now = new Date();
      const hrs = String(now.getHours()).padStart(2, '0');
      const mins = String(now.getMinutes()).padStart(2, '0');
      this.timeDisplay.textContent = `${hrs}:${mins}`;
    };
    updateTime();
    setInterval(updateTime, 10000);
  }

  async initAudioContext() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  playBeep(freq = 600, duration = 0.08) {
    try {
      this.initAudioContext();
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.audioContext.currentTime);
      gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
      osc.start();
      osc.stop(this.audioContext.currentTime + duration);
    } catch (err) {
      console.log('Beep audio error:', err);
    }
  }

  createRoom() {
    this.socket.emit('create-room', { name: `Watch Client ${this.id}` }, (res) => {
      if (res.success) {
        this.roomCode = res.roomCode;
        this.showTalkView(res.isPaired);
      } else {
        alert(res.message || 'Error creating channel');
      }
    });
  }

  joinRoom() {
    const code = this.codeInput.value.trim();
    if (!code || code.length !== 6) {
      alert('Please enter a valid 6-digit channel code');
      return;
    }
    this.socket.emit('join-room', { roomCode: code, name: `Watch Client ${this.id}` }, (res) => {
      if (res.success) {
        this.roomCode = res.roomCode;
        this.showTalkView(res.isPaired);
      } else {
        alert(res.message || 'Failed to join channel');
      }
    });
  }

  showTalkView(isPaired) {
    this.setupView.classList.remove('active');
    this.talkView.classList.add('active');
    this.badgeCode.textContent = `#${this.roomCode}`;
    this.updatePairState(isPaired);
  }

  updatePairState(isPaired) {
    if (isPaired) {
      this.peerInd.innerHTML = '🟢 Paired';
      this.peerInd.style.color = '#3fb950';
      this.pttBtn.disabled = false;
      this.pttBtn.className = 'ptt-button ready';
      this.pttLabel.textContent = 'TALK';
    } else {
      this.peerInd.innerHTML = '🟡 Waiting...';
      this.peerInd.style.color = '#e3b341';
      this.pttBtn.disabled = true;
      this.pttBtn.className = 'ptt-button';
      this.pttLabel.textContent = 'WAITING';
    }
  }

  async startTalking() {
    await this.initAudioContext();
    this.playBeep(880, 0.1); // Chirp on talk start
    this.isTalking = true;

    this.pttBtn.className = 'ptt-button talking';
    this.pttLabel.textContent = 'TALKING';

    this.socket.emit('start-talk');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.analyser);
      this.drawWaveform();

      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.isTalking) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Data = reader.result;
            this.socket.emit('audio-chunk', base64Data);
          };
          reader.readAsDataURL(event.data);
        }
      };

      // Send audio chunk slice every 150ms for live low-latency streaming
      this.mediaRecorder.start(150);
      this.activeStream = stream;
    } catch (err) {
      console.error('Microphone error:', err);
      // Fallback synthetic voice tone if mic permission denied
      this.drawSyntheticWaveform();
    }
  }

  stopTalking() {
    if (!this.isTalking) return;
    this.isTalking = false;
    this.playBeep(440, 0.1); // Chirp on talk stop

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    if (this.activeStream) {
      this.activeStream.getTracks().forEach(t => t.stop());
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
    this.playBeep(700, 0.08);
    this.pttBtn.className = 'ptt-button receiving';
    this.pttLabel.textContent = 'LISTENING';
    this.drawReceivingWaveform();
  }

  onPeerStopTalk() {
    this.isReceiving = false;
    this.playBeep(350, 0.08);
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.updatePairState(true);
  }

  async onIncomingAudioChunk(base64Chunk) {
    try {
      await this.initAudioContext();
      // Decode audio chunk blob and play via Web Audio API
      const res = await fetch(base64Chunk);
      const arrayBuffer = await res.arrayBuffer();
      
      this.audioContext.decodeAudioData(arrayBuffer, (buffer) => {
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        source.start(0);
      }, (err) => {
        // Fallback for raw byte streams
      });
    } catch (e) {
      console.log('Audio decode fallback:', e);
    }
  }

  leaveRoom() {
    this.socket.emit('leave-room');
    if (this.isTalking) this.stopTalking();
    this.talkView.classList.remove('active');
    this.setupView.classList.add('active');
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
      this.canvasCtx.fillStyle = '#3fb950';
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

    for (let x = 0; x < this.canvas.width; x += 4) {
      const height = Math.abs(Math.sin(time + x * 0.1)) * (this.canvas.height - 4) + 2;
      this.canvasCtx.fillRect(x, (this.canvas.height - height) / 2, 2, height);
    }

    this.animFrameId = requestAnimationFrame(() => this.drawReceivingWaveform());
  }

  drawSyntheticWaveform() {
    this.drawReceivingWaveform();
  }
}

// Global App Initialization
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  const serverStatusPill = document.getElementById('server-status');

  socket.on('connect', () => {
    serverStatusPill.innerHTML = '<span class="status-dot online"></span> Server Online';
  });

  socket.on('disconnect', () => {
    serverStatusPill.innerHTML = '<span class="status-dot offline"></span> Server Offline';
  });

  // Instantiate 2 watch clients in the simulator
  const watchA = new WatchSimulator(1, socket);
  const watchB = new WatchSimulator(2, socket);

  // Router for Socket events to proper simulator based on room state
  socket.on('peer-joined', (data) => {
    if (watchA.roomCode) watchA.updatePairState(data.isPaired);
    if (watchB.roomCode) watchB.updatePairState(data.isPaired);
  });

  socket.on('peer-left', (data) => {
    if (watchA.roomCode) watchA.updatePairState(false);
    if (watchB.roomCode) watchB.updatePairState(false);
  });

  socket.on('peer-start-talk', (data) => {
    if (watchA.roomCode && data.talkerId !== socket.id) watchA.onPeerStartTalk();
    if (watchB.roomCode && data.talkerId !== socket.id) watchB.onPeerStartTalk();
  });

  socket.on('peer-stop-talk', (data) => {
    if (watchA.roomCode) watchA.onPeerStopTalk();
    if (watchB.roomCode) watchB.onPeerStopTalk();
  });

  socket.on('audio-chunk', (data) => {
    if (watchA.roomCode && data.senderId !== socket.id) watchA.onIncomingAudioChunk(data.chunk);
    if (watchB.roomCode && data.senderId !== socket.id) watchB.onIncomingAudioChunk(data.chunk);
  });
});
