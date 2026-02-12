/* ═══════════════════════════════════════════
   VC+ Streaming Engine
   Browser screen share + OBS RTMP viewer
   ═══════════════════════════════════════════ */

class StreamingEngine {
  constructor(socket, userId) {
    this.socket = socket;
    this.userId = userId;
    this.localStream = null;
    this.peerConnections = new Map(); // viewerUserId -> RTCPeerConnection
    this.viewerConnection = null; // when watching someone else
    this.isStreaming = false;
    this.currentChannelId = null;

    this._setupListeners();
  }

  _setupListeners() {
    // As broadcaster: handle new viewers
    this.socket.on('stream:viewer-joined', async (data) => {
      if (!this.isStreaming || !this.localStream) return;
      await this._sendStreamToViewer(data.viewerUserId);
    });

    // As viewer: receive stream offer
    this.socket.on('stream:offer', async (data) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      this.viewerConnection = pc;

      pc.ontrack = (event) => {
        const video = document.getElementById('stream-video');
        if (video && event.streams[0]) {
          video.srcObject = event.streams[0];
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit('stream:ice', {
            targetUserId: data.fromUserId,
            candidate: event.candidate
          });
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socket.emit('stream:answer', {
        targetUserId: data.fromUserId,
        answer: answer
      });
    });

    // As broadcaster: receive viewer answer
    this.socket.on('stream:answer', async (data) => {
      const pc = this.peerConnections.get(data.fromUserId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    // ICE candidates
    this.socket.on('stream:ice', async (data) => {
      let pc = this.peerConnections.get(data.fromUserId) || this.viewerConnection;
      if (pc && data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {}
      }
    });
  }

  async startBrowserStream(channelId, options = {}) {
    try {
      const streamOptions = {
        video: {
          cursor: 'always',
          displaySurface: options.displaySurface || 'monitor'
        },
        audio: options.shareAudio !== false
      };

      this.localStream = await navigator.mediaDevices.getDisplayMedia(streamOptions);

      // Detect when user stops sharing
      this.localStream.getVideoTracks()[0].onended = () => {
        this.stopStream();
      };

      this.isStreaming = true;
      this.currentChannelId = channelId;

      this.socket.emit('stream:start', {
        channelId,
        type: 'browser',
        title: options.title || 'Screen Share'
      });

      return this.localStream;
    } catch (err) {
      console.error('[Stream] Failed to start:', err);
      throw err;
    }
  }

  async _sendStreamToViewer(viewerUserId) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    this.peerConnections.set(viewerUserId, pc);

    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('stream:ice', {
          targetUserId: viewerUserId,
          candidate: event.candidate
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socket.emit('stream:offer', {
      targetUserId: viewerUserId,
      offer: offer,
      channelId: this.currentChannelId
    });
  }

  watchStream(channelId) {
    // Request stream from broadcaster
    this.socket.emit('stream:request', { channelId });
  }

  watchOBSStream(flvUrl) {
    // For OBS streams, we use the FLV URL from the RTMP server
    const video = document.getElementById('stream-video');
    if (video) {
      // Use native video or flv.js if available
      if (window.flvjs && flvjs.isSupported()) {
        const player = flvjs.createPlayer({ type: 'flv', url: flvUrl });
        player.attachMediaElement(video);
        player.load();
        player.play();
        this._obsPlayer = player;
      } else {
        // Fallback: try direct
        video.src = flvUrl;
        video.play().catch(() => {});
      }
    }
  }

  stopStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.peerConnections.forEach(pc => pc.close());
    this.peerConnections.clear();

    if (this.currentChannelId) {
      this.socket.emit('stream:stop', { channelId: this.currentChannelId });
    }

    this.isStreaming = false;
    this.currentChannelId = null;
  }

  stopWatching() {
    if (this.viewerConnection) {
      this.viewerConnection.close();
      this.viewerConnection = null;
    }
    if (this._obsPlayer) {
      this._obsPlayer.destroy();
      this._obsPlayer = null;
    }
    const video = document.getElementById('stream-video');
    if (video) {
      video.srcObject = null;
      video.src = '';
    }
  }

  destroy() {
    this.stopStream();
    this.stopWatching();
  }
}

window.StreamingEngine = StreamingEngine;
