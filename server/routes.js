const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware, register, login } = require('./auth');
const db = require('./database');
const { v4: uuidv4 } = require('uuid');

// ─── Auth Routes ───
router.post('/auth/register', (req, res) => {
  try {
    const { username, password, displayName, email } = req.body;
    const result = register(username, password, displayName, email);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const result = login(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

router.put('/auth/profile', authMiddleware, (req, res) => {
  const { display_name, avatar } = req.body;
  if (display_name) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.user.id);
  }
  if (avatar !== undefined) {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  }
  const user = db.prepare('SELECT id, username, display_name, avatar, is_admin, stream_key, status FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// ─── Guild Routes ───
router.post('/guilds', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Guild name is required (min 2 chars)' });

  const id = uuidv4();
  const inviteCode = uuidv4().slice(0, 8);

  db.prepare('INSERT INTO guilds (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)').run(id, name, req.user.id, inviteCode);
  db.prepare('INSERT INTO guild_members (guild_id, user_id, role) VALUES (?, ?, ?)').run(id, req.user.id, 'owner');

  // Create default channels
  const textId = uuidv4();
  const voiceId = uuidv4();
  db.prepare('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)').run(textId, id, 'ogólny', 'text', 0);
  db.prepare('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)').run(voiceId, id, 'Głosowy', 'voice', 1);

  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(id);
  const channels = db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY position').all(id);
  res.json({ guild, channels });
});

router.get('/guilds', authMiddleware, (req, res) => {
  const guilds = db.prepare(`
    SELECT g.* FROM guilds g
    JOIN guild_members gm ON g.id = gm.guild_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at
  `).all(req.user.id);
  res.json({ guilds });
});

router.get('/guilds/:guildId', authMiddleware, (req, res) => {
  const membership = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(req.params.guildId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(req.params.guildId);
  const channels = db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY type, position').all(req.params.guildId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.status, gm.role
    FROM users u JOIN guild_members gm ON u.id = gm.user_id
    WHERE gm.guild_id = ?
    ORDER BY gm.role DESC, u.username
  `).all(req.params.guildId);
  res.json({ guild, channels, members });
});

router.post('/guilds/join', authMiddleware, (req, res) => {
  const { inviteCode } = req.body;
  const guild = db.prepare('SELECT * FROM guilds WHERE invite_code = ?').get(inviteCode);
  if (!guild) return res.status(404).json({ error: 'Invalid invite code' });

  const existing = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guild.id, req.user.id);
  if (existing) return res.status(400).json({ error: 'Already a member' });

  db.prepare('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)').run(guild.id, req.user.id);
  res.json({ guild });
});

router.delete('/guilds/:guildId', authMiddleware, (req, res) => {
  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });
  if (guild.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not authorized' });

  db.prepare('DELETE FROM guilds WHERE id = ?').run(req.params.guildId);
  res.json({ success: true });
});

// ─── Channel Routes ───
router.post('/guilds/:guildId/channels', authMiddleware, (req, res) => {
  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });

  const membership = db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(req.params.guildId, req.user.id);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  if (!['text', 'voice'].includes(type)) return res.status(400).json({ error: 'Type must be text or voice' });

  const maxPos = db.prepare('SELECT MAX(position) as max FROM channels WHERE guild_id = ?').get(req.params.guildId);
  const id = uuidv4();
  db.prepare('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)').run(id, req.params.guildId, name, type, (maxPos.max || 0) + 1);

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  res.json({ channel });
});

router.delete('/channels/:channelId', authMiddleware, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(channel.guild_id);
  if (guild.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not authorized' });

  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.channelId);
  res.json({ success: true });
});

// ─── Message Routes ───
router.get('/channels/:channelId/messages', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;

  let messages;
  if (before) {
    messages = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ? AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
      ORDER BY m.created_at DESC LIMIT ?
    `).all(req.params.channelId, before, limit);
  } else {
    messages = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at DESC LIMIT ?
    `).all(req.params.channelId, limit);
  }

  res.json({ messages: messages.reverse() });
});

// ─── Stream Routes ───
router.get('/stream/key', authMiddleware, (req, res) => {
  res.json({ streamKey: req.user.stream_key });
});

router.post('/stream/key/regenerate', authMiddleware, (req, res) => {
  const newKey = uuidv4().replace(/-/g, '');
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(newKey, req.user.id);
  res.json({ streamKey: newKey });
});

router.get('/streams/live', authMiddleware, (req, res) => {
  const streams = db.prepare(`
    SELECT s.*, u.username, u.display_name, u.avatar
    FROM streams s JOIN users u ON s.user_id = u.id
    WHERE s.is_live = 1
  `).all();
  res.json({ streams });
});

// ─── Admin Routes ───
router.get('/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const guildCount = db.prepare('SELECT COUNT(*) as count FROM guilds').get().count;
  const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const onlineCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'online'").get().count;
  res.json({ userCount, guildCount, messageCount, onlineCount });
});

router.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, email, avatar, status, is_admin, created_at, last_seen FROM users ORDER BY created_at DESC').all();
  res.json({ users });
});

router.delete('/admin/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.userId);
  res.json({ success: true });
});

router.put('/admin/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const { is_admin, display_name } = req.body;
  if (is_admin !== undefined) {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, req.params.userId);
  }
  if (display_name) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.params.userId);
  }
  res.json({ success: true });
});

router.get('/admin/guilds', authMiddleware, adminMiddleware, (req, res) => {
  const guilds = db.prepare(`
    SELECT g.*, u.username as owner_username,
    (SELECT COUNT(*) FROM guild_members WHERE guild_id = g.id) as member_count
    FROM guilds g JOIN users u ON g.owner_id = u.id
    ORDER BY g.created_at DESC
  `).all();
  res.json({ guilds });
});

router.delete('/admin/guilds/:guildId', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM guilds WHERE id = ?').run(req.params.guildId);
  res.json({ success: true });
});

module.exports = router;
