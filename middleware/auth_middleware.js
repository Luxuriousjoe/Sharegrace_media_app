const jwt = require('jsonwebtoken');
const db = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn(`AUTH | No token on ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ success: false, message: 'No token provided - please log in' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    logger.info(`AUTH | Token valid | user:${decoded.email} role:${decoded.role} -> ${req.method} ${req.originalUrl}`);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      logger.warn(`AUTH | Token expired for ${req.method} ${req.originalUrl}`);
      return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    logger.warn(`AUTH | Invalid token on ${req.method} ${req.originalUrl} | ${err.message}`);
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const adminMiddleware = (req, res, next) => {
  authMiddleware(req, res, () => {
    const role = req.user.role;
    if (role !== 'main_admin' && role !== 'admin') {
      logger.warn(`ADMIN_GUARD | Access denied for ${req.user.email} on ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ success: false, message: 'Main admin access required' });
    }
    logger.info(`ADMIN_GUARD | Admin access granted to ${req.user.email} -> ${req.method} ${req.originalUrl}`);
    next();
  });
};

const timelyReflectionAdminMiddleware = (req, res, next) => {
  authMiddleware(req, res, () => {
    const role = req.user.role;
    if (role !== 'main_admin' && role !== 'secondary_admin' && role !== 'admin') {
      logger.warn(`TIMELY_ADMIN_GUARD | Access denied for ${req.user.email} on ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ success: false, message: 'Timely reflection admin access required' });
    }
    logger.info(`TIMELY_ADMIN_GUARD | Access granted to ${req.user.email} -> ${req.method} ${req.originalUrl}`);
    next();
  });
};

function isTruthyPermission(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

const mediaUploadMiddleware = (req, res, next) => {
  authMiddleware(req, res, async () => {
    try {
      const role = req.user.role;
      if (role === 'main_admin' || role === 'admin') {
        logger.info(`UPLOAD_GUARD | Admin upload granted to ${req.user.email}`);
        return next();
      }

      const [rows] = await db.promise().query(
        'SELECT can_upload_media FROM users WHERE id = ? AND is_active = TRUE',
        [req.user.id],
      );

      if (rows.length && isTruthyPermission(rows[0].can_upload_media)) {
        logger.info(`UPLOAD_GUARD | Upload permission granted to ${req.user.email}`);
        return next();
      }

      logger.warn(`UPLOAD_GUARD | Access denied for ${req.user.email} on ${req.method} ${req.originalUrl}`);
      return res.status(403).json({
        success: false,
        message: 'Upload access is restricted to admins and approved media users',
      });
    } catch (error) {
      logger.error(`UPLOAD_GUARD_ERROR | ${error.message}`);
      next(error);
    }
  });
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  timelyReflectionAdminMiddleware,
  mediaUploadMiddleware,
};
