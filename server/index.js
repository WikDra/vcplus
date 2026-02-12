require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const routes = require('./routes');
const { setupSocket } = require('./socket');
const { startRTMPServer } = require('./rtmp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', routes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Socket.IO
setupSocket(io);

// Start servers
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║           VC+ Server Started             ║
╠══════════════════════════════════════════╣
║  Web:  http://localhost:${PORT}              ║
║  RTMP: rtmp://localhost:${process.env.RTMP_PORT || 1935}/live/     ║
║  Admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}              ║
╚══════════════════════════════════════════╝
  `);
});

// Start RTMP server for OBS streaming
try {
  startRTMPServer(io);
} catch (e) {
  console.log('[RTMP] Could not start RTMP server:', e.message);
  console.log('[RTMP] OBS streaming will not be available. Browser streaming still works.');
}
