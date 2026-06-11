const jwt    = require('jsonwebtoken');
const config = require('../config/app_config');
const logger = require('../utils/logger');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn(`AUTH | No token on ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ success: false, message: 'No token provided — please log in' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    logger.info(`AUTH | Token valid | user:${decoded.email} role:${decoded.role} → ${req.method} ${req.originalUrl}`);
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
    if (req.user.role !== 'admin') {
      logger.warn(`ADMIN_GUARD | Access denied for ${req.user.email} on ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    logger.info(`ADMIN_GUARD | Admin access granted to ${req.user.email} → ${req.method} ${req.originalUrl}`);
    next();
  });
};

module.exports = { authMiddleware, adminMiddleware };
