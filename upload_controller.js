// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Admin Controller
//  Uses plain text passwords (no bcrypt)
// ═══════════════════════════════════════════════════════════════
const db     = require('../config/db_config');
const logger = require('../utils/logger');

exports.getAllUsers = async (req, res, next) => {
  logger.info(`ADMIN | getAllUsers | by ${req.user?.email}`);
  try {
    const [rows] = await db.promise().query(
      'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    logger.db('SELECT', 'users', `returned ${rows.length} users`);
    return res.json({ success: true, data: rows });
  } catch (err) { logger.error('getAllUsers error:', err.message); next(err); }
};

exports.createAdmin = async (req, res, next) => {
  const { name, email, password } = req.body;
  logger.info(`ADMIN | createAdmin | ${email} by ${req.user?.email}`);
  try {
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email, and password required' });

    // Store plain text password
    const [result] = await db.promise().query(
      'INSERT INTO users (name, email, role, password, is_active) VALUES (?, ?, "admin", ?, 1)',
      [name, email.toLowerCase(), password]
    );
    await db.promise().query(
      'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
      ['ADMIN_CREATED', req.user.id, `Admin account created: ${email}`]
    );
    logger.info(`ADMIN | Admin created: id:${result.insertId} email:${email}`);
    return res.status(201).json({ success: true, message: 'Admin user created', data: { id: result.insertId } });
  } catch (err) { logger.error('createAdmin error:', err.message); next(err); }
};

exports.createUser = async (req, res, next) => {
  const { name, email, password } = req.body;
  logger.info(`ADMIN | createUser | ${email} by ${req.user?.email}`);
  try {
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email, and password required' });

    // Store plain text password
    const [result] = await db.promise().query(
      'INSERT INTO users (name, email, role, password, is_active) VALUES (?, ?, "user", ?, 1)',
      [name, email.toLowerCase(), password]
    );
    logger.info(`ADMIN | User created: id:${result.insertId} email:${email}`);
    return res.status(201).json({ success: true, message: 'User created', data: { id: result.insertId } });
  } catch (err) { logger.error('createUser error:', err.message); next(err); }
};

exports.toggleUser = async (req, res, next) => {
  const { id } = req.params;
  logger.info(`ADMIN | toggleUser | id:${id} by ${req.user?.email}`);
  try {
    const [rows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const newStatus = rows[0].is_active ? 0 : 1;
    await db.promise().query('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, id]);
    logger.info(`ADMIN | User id:${id} → ${newStatus ? 'active' : 'inactive'}`);
    return res.json({ success: true, message: `User ${newStatus ? 'activated' : 'deactivated'}` });
  } catch (err) { logger.error('toggleUser error:', err.message); next(err); }
};

exports.getLogs = async (req, res, next) => {
  const { page = 1, limit = 50 } = req.query;
  logger.info(`ADMIN | getLogs | page:${page} by ${req.user?.email}`);
  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await db.promise().query(
      `SELECT l.*, u.name AS user_name, u.email AS user_email
       FROM logs l LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.timestamp DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), offset]
    );
    logger.db('SELECT', 'logs', `returned ${rows.length} entries`);
    return res.json({ success: true, data: rows });
  } catch (err) { logger.error('getLogs error:', err.message); next(err); }
};

exports.getDashboardStats = async (req, res, next) => {
  logger.info(`ADMIN | getDashboardStats | by ${req.user?.email}`);
  try {
    const [[{ total_media }]] = await db.promise().query('SELECT COUNT(*) AS total_media FROM media');
    const [[{ uploaded }]]    = await db.promise().query('SELECT COUNT(*) AS uploaded FROM media WHERE status="uploaded"');
    const [[{ pending }]]     = await db.promise().query('SELECT COUNT(*) AS pending FROM media WHERE status IN ("pending","uploading")');
    const [[{ failed }]]      = await db.promise().query('SELECT COUNT(*) AS failed FROM media WHERE status="failed"');
    const [[{ total_users }]] = await db.promise().query('SELECT COUNT(*) AS total_users FROM users');
    const [[{ videos }]]      = await db.promise().query('SELECT COUNT(*) AS videos FROM media WHERE type="video" AND status="uploaded"');
    const [[{ photos }]]      = await db.promise().query('SELECT COUNT(*) AS photos FROM media WHERE type="photo" AND status="uploaded"');
    const [[{ audios }]]      = await db.promise().query('SELECT COUNT(*) AS audios FROM media WHERE type="audio" AND status="uploaded"');
    return res.json({ success: true, data: { total_media, uploaded, pending, failed, total_users, videos, photos, audios } });
  } catch (err) { logger.error('getDashboardStats error:', err.message); next(err); }
};
