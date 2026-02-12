/* ═══════════════════════════════════════════
   VC+ Voice Engine — WebRTC P2P Mesh
   ═══════════════════════════════════════════ */

class VoiceEngine {
  constructor(socket, userId) {
    this.socket = socket;
    this.userId = userId;
    this.peers = new Map(); // userId -> RTCPeerConnection
    this.localStream = null;
    this.processedStream = null;
    this.currentChannelId = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.audioProcessor = new AudioProcessingEngine();
    this.audioMixer = new AudioMixer();
    this.onVoiceActivity = null; // callback(userId, speaking)
    this.remoteAudioEls = new Map(); // userId -> HTMLAudioElement (fallback playback)
    this._localMonitorRunning = false;

    // Wire mixer's activity detection to our callback
    this.audioMixer.onUserActivity = (userId, speaking) => {
      if (this.onVoiceActivity) this.onVoiceActivity(userId, speaking);
    };

    this._setupSocketListeners();
  }

  _setupSocketListeners() {
    this.socket.on('voice:peers', async (data) => {
      console.log('[Voice] Received peers:', data.peers.length);
      for (const peer of data.peers) {
        await this._createPeerConnection(peer.userId, true);
      }
    });

    this.socket.on('voice:user-left', (data) => {
      console.log('[Voice] User left:', data.userId);
      this._removePeer(data.userId);
    });

    this.socket.on('rtc:offer', async (data) => {
      console.log('[Voice] Received offer from', data.fromUserId);
      if (!this.currentChannelId) {
        console.warn('[Voice] Got offer but not in a channel, ignoring');
        return;
      }
      const pc = await this._createPeerConnection(data.fromUserId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('rtc:answer', {
        targetUserId: data.fromUserId,
        answer: answer
      });
    });

    this.socket.on('rtc:answer', async (data) => {
      console.log('[Voice] Received answer from', data.fromUserId);
      const pc = this.peers.get(data.fromUserId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    this.socket.on('rtc:ice-candidate', async (data) => {
      const pc = this.peers.get(data.fromUserId);
      if (pc && data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn('[Voice] ICE candidate error:', e);
        }
      }
    });
  }

  async join(channelId, audioSettings) {
    this.currentChannelId = channelId;

    try {
      // Get microphone with browser-level processing
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: audioSettings?.echoCancellation !== false,
          noiseSuppression: audioSettings?.noiseSuppression !== false,
          autoGainControl: audioSettings?.autoGainControl !== false,
          channelCount: 1,
          sampleRate: 48000
        }
      });

      // Apply our additional audio processing
      this.processedStream = await this.audioProcessor.init(this.localStream);

      console.log('[Voice] Mic acquired, processed stream tracks:',
        this.processedStream.getAudioTracks().map(t => `${t.label} enabled=${t.enabled} readyState=${t.readyState}`));

      // Notify server
      this.socket.emit('voice:join', { channelId });

      // Monitor own mic level for speaking indicator
      this._startLocalMonitor();

    } catch (err) {
      console.error('[Voice] Failed to get microphone:', err);
      throw err;
    }
  }

  _startLocalMonitor() {
    if (this._localMonitorRunning) return;
    this._localMonitorRunning = true;

    const analysers = this.audioProcessor.getAnalysers();
    const analyser = analysers.processed;
    if (!analyser) { this._localMonitorRunning = false; return; }

    const data = new Float32Array(analyser.fftSize);
    let speaking = false;
    let silenceFrames = 0;
    const SPEAK_THRESHOLD = -50;
    const SILENCE_HOLD = 12;

    const check = () => {
      if (!this._localMonitorRunning || !this.currentChannelId) return;

      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-10));

      let nowSpeaking;
      if (db > SPEAK_THRESHOLD && !this.isMuted) {
        nowSpeaking = true;
        silenceFrames = 0;
      } else {
        silenceFrames++;
        nowSpeaking = silenceFrames < SILENCE_HOLD && !this.isMuted;
      }

      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking;
        if (this.onVoiceActivity) this.onVoiceActivity(this.userId, speaking);
      }

      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  _stopLocalMonitor() {
    this._localMonitorRunning = false;
  }

  async _createPeerConnection(remoteUserId, isInitiator) {
    if (this.peers.has(remoteUserId)) {
      this._removePeer(remoteUserId);
    }

    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(config);
    this.peers.set(remoteUserId, pc);

    // Add our processed audio track
    if (this.processedStream) {
      this.processedStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.processedStream);
        console.log(`[Voice] Added local track to PC for ${remoteUserId}: ${track.label} enabled=${track.enabled}`);
      });
    } else {
      console.warn('[Voice] No processedStream when creating peer connection!');
    }

    // Handle incoming audio
    pc.ontrack = (event) => {
      console.log(`[Voice] ontrack from ${remoteUserId}:`, event.streams.length, 'streams,', event.track.kind, event.track.readyState);
      const remoteStream = event.streams[0];
      if (remoteStream) {
        // Play directly via an <audio> element — primary playback path
        this._playRemoteAudio(remoteUserId, remoteStream);

        // Route a CLONE through mixer purely for voice-activity monitoring
        // (cloning avoids browsers muting the stream when two consumers share it)
        const monitorStream = remoteStream.clone();
        this.audioMixer.addUser(remoteUserId, monitorStream);
      }
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('rtc:ice-candidate', {
          targetUserId: remoteUserId,
          candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Voice] ICE state for ${remoteUserId}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Voice] Connection state for ${remoteUserId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.error(`[Voice] Connection to ${remoteUserId} FAILED`);
      }
    };

    // If we're the initiator, create and send an offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('rtc:offer', {
        targetUserId: remoteUserId,
        offer: offer
      });
      console.log(`[Voice] Sent offer to ${remoteUserId}`);
    }

    return pc;
  }

  _playRemoteAudio(userId, stream) {
    // Remove old audio element if any
    this._stopRemoteAudio(userId);

    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.volume = 1.0;

    // Must call play() — autoplay alone may not be enough
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.then(() => {
        console.log(`[Voice] Audio element playing for ${userId}`);
      }).catch(err => {
        console.warn(`[Voice] Audio play() blocked for ${userId}:`, err.message);
      });
    }

    this.remoteAudioEls.set(userId, audio);
  }

  _stopRemoteAudio(userId) {
    const audio = this.remoteAudioEls.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      this.remoteAudioEls.delete(userId);
    }
  }

  _removePeer(userId) {
    const pc = this.peers.get(userId);
    if (pc) {
      pc.close();
      this.peers.delete(userId);
    }
    this.audioMixer.removeUser(userId);
    this._stopRemoteAudio(userId);
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    // Only mute the outgoing processed stream (what others hear)
    if (this.processedStream) {
      this.processedStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    this.socket.emit('voice:toggle-mute', { muted: this.isMuted });
    return this.isMuted;
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    if (this.isDeafened) {
      this.audioMixer.setMasterVolume(0);
      // Also mute the direct audio elements
      this.remoteAudioEls.forEach(audio => { audio.volume = 0; });
      if (!this.isMuted) this.toggleMute();
    } else {
      this.audioMixer.setMasterVolume(this.audioMixer.masterVolume || 1);
      this.remoteAudioEls.forEach(audio => { audio.volume = 1; });
      if (this.isMuted) this.toggleMute();
    }
    this.socket.emit('voice:toggle-deaf', { deafened: this.isDeafened });
    return this.isDeafened;
  }

  setUserVolume(userId, volume) {
    this.audioMixer.setUserVolume(userId, volume);
  }

  setMasterVolume(volume) {
    this.audioMixer.setMasterVolume(volume);
  }

  leave() {
    // Stop local speaking monitor
    this._stopLocalMonitor();

    // Close all peer connections
    this.peers.forEach((pc, userId) => {
      pc.close();
      this.audioMixer.removeUser(userId);
      this._stopRemoteAudio(userId);
    });
    this.peers.clear();
    this.remoteAudioEls.clear();

    // Stop local streams
    this.audioProcessor.destroy();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.processedStream = null;

    this.socket.emit('voice:leave');
    this.currentChannelId = null;
    this.isMuted = false;
    this.isDeafened = false;
  }

  getAudioLevel() {
    return this.audioProcessor.getLevel();
  }

  updateAudioSettings(settings) {
    this.audioProcessor.updateSettings(settings);
  }

  destroy() {
    this.leave();
    this.audioMixer.destroy();
  }
}

window.VoiceEngine = VoiceEngine;
