const db = require('./database');
const { verifyToken } = require('./auth');
const { v4: uuidv4 } = require('uuid');

// In-memory voice state
const voiceStates = new Map(); // channelId -> Map(userId -> { socketId, muted, deafened })
const userVoiceChannels = new Map(); // socketId -> { channelId, userId }
const streamStates = new Map(); // channelId -> { userId, type, socketId }

function setupSocket(io) {
  // Auth middleware for socket
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    const decoded = verifyToken(token);
    if (!decoded) return next(new Error('Invalid token'));

    const user = db.prepare('SELECT id, username, display_name, avatar, is_admin, status FROM users WHERE id = ?').get(decoded.id);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    console.log(`[WS] ${socket.user.username} connected`);

    // Set user online
    db.prepare("UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(socket.user.id);
    io.emit('user:status', { userId: socket.user.id, status: 'online' });

    // Join user's guild rooms
    const guilds = db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?').all(socket.user.id);
    guilds.forEach(g => socket.join(`guild:${g.guild_id}`));

    // ─── Chat ───
    socket.on('message:send', (data) => {
      const { channelId, content } = data;
      if (!content || !content.trim()) return;

      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      if (!channel) return;

      const membership = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(channel.guild_id, socket.user.id);
      if (!membership) return;

      const id = uuidv4();
      db.prepare('INSERT INTO messages (id, channel_id, user_id, content) VALUES (?, ?, ?, ?)').run(id, channelId, socket.user.id, content.trim());

      const message = db.prepare(`
        SELECT m.*, u.username, u.display_name, u.avatar
        FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?
      `).get(id);

      io.to(`guild:${channel.guild_id}`).emit('message:new', message);
    });

    socket.on('message:typing', (data) => {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(data.channelId);
      if (!channel) return;
      socket.to(`guild:${channel.guild_id}`).emit('message:typing', {
        channelId: data.channelId,
        user: { id: socket.user.id, display_name: socket.user.display_name }
      });
    });

    // ─── Voice ───
    socket.on('voice:join', (data) => {
      const { channelId } = data;
      const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND type = ?').get(channelId, 'voice');
      if (!channel) return;

      // Leave previous voice channel
      leaveVoiceChannel(socket, io);

      // Join new channel
      if (!voiceStates.has(channelId)) voiceStates.set(channelId, new Map());
      voiceStates.get(channelId).set(socket.user.id, {
        socketId: socket.id,
        userId: socket.user.id,
        username: socket.user.username,
        display_name: socket.user.display_name,
        avatar: socket.user.avatar,
        muted: false,
        deafened: false
      });
      userVoiceChannels.set(socket.id, { channelId, userId: socket.user.id });

      socket.join(`voice:${channelId}`);

      // Notify everyone in guild
      io.to(`guild:${channel.guild_id}`).emit('voice:state', {
        channelId,
        users: Array.from(voiceStates.get(channelId).values())
      });

      // Tell the joiner about existing peers
      const peers = [];
      voiceStates.get(channelId).forEach((state, uid) => {
        if (uid !== socket.user.id) peers.push(state);
      });
      socket.emit('voice:peers', { channelId, peers });
    });

    socket.on('voice:leave', () => {
      leaveVoiceChannel(socket, io);
    });

    socket.on('voice:toggle-mute', (data) => {
      const vc = userVoiceChannels.get(socket.id);
      if (!vc) return;
      const state = voiceStates.get(vc.channelId)?.get(socket.user.id);
      if (state) {
        state.muted = data.muted;
        const channel = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(vc.channelId);
        if (channel) {
          io.to(`guild:${channel.guild_id}`).emit('voice:state', {
            channelId: vc.channelId,
            users: Array.from(voiceStates.get(vc.channelId).values())
          });
        }
      }
    });

    socket.on('voice:toggle-deaf', (data) => {
      const vc = userVoiceChannels.get(socket.id);
      if (!vc) return;
      const state = voiceStates.get(vc.channelId)?.get(socket.user.id);
      if (state) {
        state.deafened = data.deafened;
        const channel = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(vc.channelId);
        if (channel) {
          io.to(`guild:${channel.guild_id}`).emit('voice:state', {
            channelId: vc.channelId,
            users: Array.from(voiceStates.get(vc.channelId).values())
          });
        }
      }
    });

    // ─── WebRTC Signaling ───
    socket.on('rtc:offer', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('rtc:offer', {
          offer: data.offer,
          fromUserId: socket.user.id,
          fromUsername: socket.user.display_name
        });
      }
    });

    socket.on('rtc:answer', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('rtc:answer', {
          answer: data.answer,
          fromUserId: socket.user.id
        });
      }
    });

    socket.on('rtc:ice-candidate', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('rtc:ice-candidate', {
          candidate: data.candidate,
          fromUserId: socket.user.id
        });
      }
    });

    // ─── Streaming ───
    socket.on('stream:start', (data) => {
      const { channelId, type, title } = data;
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      if (!channel) return;

      const id = uuidv4();
      db.prepare('INSERT OR REPLACE INTO streams (id, user_id, channel_id, title, type, is_live, started_at) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)')
        .run(id, socket.user.id, channelId, title || 'Live Stream', type || 'browser');

      streamStates.set(channelId, {
        streamId: id,
        userId: socket.user.id,
        type: type || 'browser',
        socketId: socket.id
      });

      io.to(`guild:${channel.guild_id}`).emit('stream:started', {
        channelId,
        streamId: id,
        userId: socket.user.id,
        username: socket.user.display_name,
        type: type || 'browser',
        title: title || 'Live Stream'
      });
    });

    socket.on('stream:stop', (data) => {
      const { channelId } = data;
      stopStream(channelId, socket, io);
    });

    socket.on('stream:offer', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('stream:offer', {
          offer: data.offer,
          fromUserId: socket.user.id,
          channelId: data.channelId
        });
      }
    });

    socket.on('stream:answer', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('stream:answer', {
          answer: data.answer,
          fromUserId: socket.user.id
        });
      }
    });

    socket.on('stream:ice', (data) => {
      const target = findSocketByUserId(io, data.targetUserId);
      if (target) {
        target.emit('stream:ice', {
          candidate: data.candidate,
          fromUserId: socket.user.id
        });
      }
    });

    socket.on('stream:request', (data) => {
      // Viewer requesting stream from broadcaster
      const state = streamStates.get(data.channelId);
      if (state) {
        const broadcaster = findSocketByUserId(io, state.userId);
        if (broadcaster) {
          broadcaster.emit('stream:viewer-joined', {
            viewerUserId: socket.user.id,
            viewerSocketId: socket.id,
            channelId: data.channelId
          });
        }
      }
    });

    // ─── Guild events ───
    socket.on('guild:join-room', (data) => {
      socket.join(`guild:${data.guildId}`);
    });

    // ─── Disconnect ───
    socket.on('disconnect', () => {
      console.log(`[WS] ${socket.user.username} disconnected`);
      db.prepare("UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(socket.user.id);
      io.emit('user:status', { userId: socket.user.id, status: 'offline' });

      leaveVoiceChannel(socket, io);

      // Stop any streams
      streamStates.forEach((state, channelId) => {
        if (state.socketId === socket.id) {
          stopStream(channelId, socket, io);
        }
      });
    });
  });
}

function leaveVoiceChannel(socket, io) {
  const vc = userVoiceChannels.get(socket.id);
  if (!vc) return;

  const channelState = voiceStates.get(vc.channelId);
  if (channelState) {
    channelState.delete(socket.user.id);
    if (channelState.size === 0) {
      voiceStates.delete(vc.channelId);
    }
  }

  socket.leave(`voice:${vc.channelId}`);
  userVoiceChannels.delete(socket.id);

  const channel = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(vc.channelId);
  if (channel) {
    io.to(`guild:${channel.guild_id}`).emit('voice:state', {
      channelId: vc.channelId,
      users: channelState ? Array.from(channelState.values()) : []
    });
    io.to(`voice:${vc.channelId}`).emit('voice:user-left', {
      userId: socket.user.id,
      channelId: vc.channelId
    });
  }
}

function stopStream(channelId, socket, io) {
  const state = streamStates.get(channelId);
  if (!state) return;

  db.prepare('UPDATE streams SET is_live = 0 WHERE user_id = ? AND channel_id = ?').run(state.userId, channelId);
  streamStates.delete(channelId);

  const channel = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(channelId);
  if (channel) {
    io.to(`guild:${channel.guild_id}`).emit('stream:stopped', { channelId, userId: state.userId });
  }
}

function findSocketByUserId(io, userId) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.user && socket.user.id === userId) return socket;
  }
  return null;
}

module.exports = { setupSocket, voiceStates, streamStates };
