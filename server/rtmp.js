const NodeMediaServer = require('node-media-server');
const db = require('./database');

let nms = null;

function startRTMPServer(io) {
  const config = {
    rtmp: {
      port: parseInt(process.env.RTMP_PORT) || 1935,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: parseInt(process.env.RTMP_HTTP_PORT) || 8888,
      allow_origin: '*',
      mediaroot: './data/media'
    },
    trans: {
      ffmpeg: '',
      tasks: []
    }
  };

  nms = new NodeMediaServer(config);

  nms.on('prePublish', (id, streamPath, args) => {
    console.log('[RTMP] Pre-publish:', streamPath);
    // streamPath format: /live/STREAM_KEY
    const parts = streamPath.split('/');
    const streamKey = parts[parts.length - 1];

    const user = db.prepare('SELECT * FROM users WHERE stream_key = ?').get(streamKey);
    if (!user) {
      console.log('[RTMP] Invalid stream key, rejecting');
      const session = nms.getSession(id);
      if (session) session.reject();
      return;
    }

    console.log(`[RTMP] ${user.username} started streaming via OBS`);

    // Update stream status
    const { v4: uuidv4 } = require('uuid');
    const streamId = uuidv4();
    db.prepare('INSERT INTO streams (id, user_id, title, type, is_live, started_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)')
      .run(streamId, user.id, `${user.display_name}'s Stream`, 'obs');

    if (io) {
      io.emit('stream:obs-live', {
        userId: user.id,
        username: user.display_name,
        streamKey,
        type: 'obs',
        httpUrl: `http://localhost:${config.http.port}/live/${streamKey}/index.m3u8`,
        flvUrl: `http://localhost:${config.http.port}/live/${streamKey}.flv`
      });
    }
  });

  nms.on('donePublish', (id, streamPath) => {
    const parts = streamPath.split('/');
    const streamKey = parts[parts.length - 1];
    const user = db.prepare('SELECT * FROM users WHERE stream_key = ?').get(streamKey);
    if (user) {
      db.prepare('UPDATE streams SET is_live = 0 WHERE user_id = ? AND type = ?').run(user.id, 'obs');
      console.log(`[RTMP] ${user.username} stopped OBS stream`);
      if (io) {
        io.emit('stream:obs-stopped', { userId: user.id });
      }
    }
  });

  nms.run();
  console.log(`[RTMP] Server running on port ${config.rtmp.port}, HTTP on port ${config.http.port}`);
}

module.exports = { startRTMPServer };
