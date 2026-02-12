/* ═══════════════════════════════════════════
   VC+ Audio Processing Engine
   Noise suppression, keyboard click filter,
   noise gate, gain control
   ═══════════════════════════════════════════ */

class AudioProcessingEngine {
  constructor() {
    this.context = null;
    this.stream = null;
    this.sourceNode = null;
    this.outputNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.rawAnalyserNode = null;
    this.noiseGateNode = null;
    this.highPassFilter = null;
    this.lowPassFilter = null;
    this.compressorNode = null;
    this.processedStream = null;

    this.settings = {
      noiseSuppression: true,
      keyboardFilter: true,
      echoCancellation: true,
      autoGainControl: true,
      noiseGateThreshold: -50,
      masterVolume: 1.0
    };

    this.isGateOpen = false;
    this.gateHoldTime = 0;
    this.GATE_HOLD_MS = 150;
    this.GATE_ATTACK_MS = 5;
    this.GATE_RELEASE_MS = 50;

    // Keyboard click detection
    this.clickDetector = {
      history: new Float32Array(10),
      historyIndex: 0,
      lastClickTime: 0,
      suppressUntil: 0
    };
  }

  async init(stream) {
    this.stream = stream;
    this.context = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });

    this.sourceNode = this.context.createMediaStreamSource(stream);

    // ─── Processing chain ───
    // 1. High-pass filter (removes low rumble / keyboard thump fundamental)
    this.highPassFilter = this.context.createBiquadFilter();
    this.highPassFilter.type = 'highpass';
    this.highPassFilter.frequency.value = 80;
    this.highPassFilter.Q.value = 0.7;

    // 2. Low-pass filter (removes high hiss)
    this.lowPassFilter = this.context.createBiquadFilter();
    this.lowPassFilter.type = 'lowpass';
    this.lowPassFilter.frequency.value = 14000;
    this.lowPassFilter.Q.value = 0.7;

    // 3. Notch filter for keyboard click frequencies (2kHz-4kHz range)
    this.keyboardNotch1 = this.context.createBiquadFilter();
    this.keyboardNotch1.type = 'peaking';
    this.keyboardNotch1.frequency.value = 2500;
    this.keyboardNotch1.Q.value = 2;
    this.keyboardNotch1.gain.value = 0; // dynamically set

    this.keyboardNotch2 = this.context.createBiquadFilter();
    this.keyboardNotch2.type = 'peaking';
    this.keyboardNotch2.frequency.value = 4000;
    this.keyboardNotch2.Q.value = 2;
    this.keyboardNotch2.gain.value = 0;

    // 4. Compressor (acts as limiter + leveler)
    this.compressorNode = this.context.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;
    this.compressorNode.knee.value = 12;
    this.compressorNode.ratio.value = 4;
    this.compressorNode.attack.value = 0.005;
    this.compressorNode.release.value = 0.1;

    // 5. Gain
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = this.settings.masterVolume;

    // 6. Analyser for noise gate & level metering (post-processing)
    this.analyserNode = this.context.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.3;

    // 6b. Raw analyser (pre-processing) — tapped directly from source
    this.rawAnalyserNode = this.context.createAnalyser();
    this.rawAnalyserNode.fftSize = 2048;
    this.rawAnalyserNode.smoothingTimeConstant = 0.3;

    // 7. Noise gate gain node
    this.noiseGateNode = this.context.createGain();
    this.noiseGateNode.gain.value = 1;

    // Chain: source -> highpass -> lowpass -> notch1 -> notch2 -> compressor -> gain -> analyser -> noiseGate -> output
    // Also:  source -> rawAnalyser (parallel tap for visualization)
    this.sourceNode.connect(this.highPassFilter);
    this.sourceNode.connect(this.rawAnalyserNode); // raw mic signal tap
    this.highPassFilter.connect(this.lowPassFilter);
    this.lowPassFilter.connect(this.keyboardNotch1);
    this.keyboardNotch1.connect(this.keyboardNotch2);
    this.keyboardNotch2.connect(this.compressorNode);
    this.compressorNode.connect(this.gainNode);
    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.noiseGateNode);

    // Create output stream
    const dest = this.context.createMediaStreamDestination();
    this.noiseGateNode.connect(dest);
    this.processedStream = dest.stream;

    // Start processing loop
    this._startProcessingLoop();

    return this.processedStream;
  }

  _startProcessingLoop() {
    const dataArray = new Float32Array(this.analyserNode.fftSize);

    const process = () => {
      if (!this.context || this.context.state === 'closed') return;

      this.analyserNode.getFloatTimeDomainData(dataArray);

      // Calculate RMS level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const dB = 20 * Math.log10(Math.max(rms, 1e-10));

      // ─── Noise Gate ───
      if (this.settings.noiseSuppression) {
        const now = performance.now();
        if (dB > this.settings.noiseGateThreshold) {
          // Signal above threshold - open gate
          if (!this.isGateOpen) {
            this.noiseGateNode.gain.linearRampToValueAtTime(1, this.context.currentTime + this.GATE_ATTACK_MS / 1000);
            this.isGateOpen = true;
          }
          this.gateHoldTime = now;
        } else {
          // Signal below threshold
          if (this.isGateOpen && now - this.gateHoldTime > this.GATE_HOLD_MS) {
            this.noiseGateNode.gain.linearRampToValueAtTime(0.01, this.context.currentTime + this.GATE_RELEASE_MS / 1000);
            this.isGateOpen = false;
          }
        }
      } else {
        this.noiseGateNode.gain.value = 1;
        this.isGateOpen = true;
      }

      // ─── Keyboard click detection ───
      if (this.settings.keyboardFilter) {
        // Detect transient spikes (clicks are sharp transients)
        const cd = this.clickDetector;
        const avgHistory = cd.history.reduce((a, b) => a + b, 0) / cd.history.length;
        const currentLevel = rms;

        // If current level is much higher than recent average, it's a click
        if (currentLevel > avgHistory * 8 && currentLevel > 0.01) {
          const now = performance.now();
          if (now - cd.lastClickTime > 50) { // debounce
            cd.lastClickTime = now;
            cd.suppressUntil = now + 80; // suppress for 80ms
            // Briefly attenuate the keyboard frequency range
            this.keyboardNotch1.gain.value = -18;
            this.keyboardNotch2.gain.value = -15;
          }
        }

        // Release suppression
        if (performance.now() > cd.suppressUntil && cd.suppressUntil > 0) {
          this.keyboardNotch1.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.05);
          this.keyboardNotch2.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.05);
          cd.suppressUntil = 0;
        }

        cd.history[cd.historyIndex] = currentLevel;
        cd.historyIndex = (cd.historyIndex + 1) % cd.history.length;
      } else {
        this.keyboardNotch1.gain.value = 0;
        this.keyboardNotch2.gain.value = 0;
      }

      // Store level for UI metering
      this.currentLevel = dB;
      this.currentRMS = rms;

      requestAnimationFrame(process);
    };

    requestAnimationFrame(process);
  }

  updateSettings(settings) {
    Object.assign(this.settings, settings);

    if (this.gainNode) {
      this.gainNode.gain.value = this.settings.masterVolume;
    }
  }

  getLevel() {
    return { dB: this.currentLevel || -100, rms: this.currentRMS || 0 };
  }

  getRawLevel() {
    if (!this.rawAnalyserNode) return { dB: -100, rms: 0 };
    const data = new Float32Array(this.rawAnalyserNode.fftSize);
    this.rawAnalyserNode.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const dB = 20 * Math.log10(Math.max(rms, 1e-10));
    return { dB, rms };
  }

  /** Returns { raw: AnalyserNode, processed: AnalyserNode } for external visualization */
  getAnalysers() {
    return { raw: this.rawAnalyserNode, processed: this.analyserNode };
  }

  destroy() {
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
}

// ─── Per-user volume mixer ───
class AudioMixer {
  constructor() {
    this.context = null; // lazy-init on first addUser to avoid suspended context issues
    this.userGains = new Map(); // userId -> { gainNode, source, volume, analyser }
    this.masterGain = null;
    this.masterVolume = 1.0;
    this.onUserActivity = null; // callback(userId, speaking)
  }

  _ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
      this.masterGain.gain.value = this.masterVolume;
    }
    // Always try to resume (browsers require user gesture)
    if (this.context.state === 'suspended') {
      this.context.resume().catch(() => {});
    }
    return this.context;
  }

  addUser(userId, stream) {
    if (this.userGains.has(userId)) {
      this.removeUser(userId);
    }

    const ctx = this._ensureContext();

    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.0;

    // Analyser for voice activity detection
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;

    // Connect: source → gainNode → analyser (monitoring only, no destination)
    // Actual playback goes through the <audio> element in VoiceEngine
    source.connect(gainNode);
    gainNode.connect(analyser);

    this.userGains.set(userId, { source, gainNode, volume: 1.0, stream, analyser });

    // Start voice activity monitoring
    this._monitorUser(userId, analyser);

    // Play via a muted Audio element to keep the cloned stream alive
    // (some browsers pause MediaStream processing if nothing consumes it)
    try {
      const audio = new Audio();
      audio.srcObject = stream;
      audio.volume = 0;
      audio.play().catch(() => {});
      const entry = this.userGains.get(userId);
      if (entry) entry._audioEl = audio;
    } catch (e) {}

    console.log(`[Mixer] Added user ${userId}, context state: ${ctx.state}`);
    return gainNode;
  }

  _monitorUser(userId, analyser) {
    const data = new Float32Array(analyser.fftSize);
    let speaking = false;
    let silenceFrames = 0;
    const SPEAK_THRESHOLD = -50; // dB — when to consider as speaking
    const SILENCE_HOLD = 12;     // frames (~200ms) — hold speaking state briefly

    const check = () => {
      if (!this.userGains.has(userId)) return; // stopped

      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-10));

      let nowSpeaking;
      if (db > SPEAK_THRESHOLD) {
        nowSpeaking = true;
        silenceFrames = 0;
      } else {
        silenceFrames++;
        nowSpeaking = silenceFrames < SILENCE_HOLD; // hold for a bit
      }

      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking;
        if (this.onUserActivity) this.onUserActivity(userId, speaking);
      }

      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  removeUser(userId) {
    const entry = this.userGains.get(userId);
    if (entry) {
      try {
        entry.source.disconnect();
        entry.gainNode.disconnect();
        if (entry.analyser) entry.analyser.disconnect();
        if (entry._audioEl) {
          entry._audioEl.pause();
          entry._audioEl.srcObject = null;
        }
      } catch (e) {}
      this.userGains.delete(userId);
    }
  }

  setUserVolume(userId, volume) {
    const entry = this.userGains.get(userId);
    if (entry) {
      entry.volume = volume;
      entry.gainNode.gain.value = volume;
    }
  }

  setMasterVolume(volume) {
    this.masterVolume = volume;
    if (this.masterGain) {
      this.masterGain.gain.value = volume;
    }
  }

  destroy() {
    this.userGains.forEach((_, userId) => this.removeUser(userId));
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

window.AudioProcessingEngine = AudioProcessingEngine;
window.AudioMixer = AudioMixer;
