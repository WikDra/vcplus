const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });

  const user = db.prepare('SELECT id, username, display_name, avatar, is_admin, stream_key, status FROM users WHERE id = ?').get(decoded.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.user = user;
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function register(username, password, displayName, email) {
  username = username.toLowerCase().trim();
  if (username.length < 3 || username.length > 32) throw new Error('Username must be 3-32 characters');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email || null);
  if (existing) throw new Error('Username or email already taken');

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const streamKey = uuidv4().replace(/-/g, '');

  db.prepare(
    'INSERT INTO users (id, username, display_name, email, password_hash, stream_key) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, username, displayName || username, email || null, hash, streamKey);

  const user = db.prepare('SELECT id, username, display_name, avatar, is_admin, stream_key, status FROM users WHERE id = ?').get(id);
  return { user, token: generateToken(user) };
}

function login(username, password) {
  username = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) throw new Error('Invalid credentials');

  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error('Invalid credentials');

  db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run('online', user.id);

  const safeUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar: user.avatar,
    is_admin: user.is_admin,
    stream_key: user.stream_key,
    status: 'online'
  };

  return { user: safeUser, token: generateToken(safeUser) };
}

module.exports = { generateToken, verifyToken, authMiddleware, adminMiddleware, register, login };
