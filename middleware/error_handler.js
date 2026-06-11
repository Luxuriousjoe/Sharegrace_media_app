// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Error Handler
//  Returns clear, specific error messages for every scenario
// ═══════════════════════════════════════════════════════════════
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const status  = err.status || 500;
  const message = err.message || 'Internal server error';

  logger.error(`ERROR_HANDLER | ${status} | ${req.method} ${req.originalUrl}`);
  logger.error(`ERROR_HANDLER | Code: ${err.code || 'none'} | Message: ${message}`);

  // ── MySQL: duplicate entry ─────────────────────────────────
  if (err.code === 'ER_DUP_ENTRY') {
    logger.warn('DB | Duplicate entry attempted');
    return res.status(409).json({
      success: false,
      message: 'This record already exists',
    });
  }

  // ── MySQL: table does not exist ────────────────────────────
  // Log it clearly but give the client a useful message
  if (err.code === 'ER_NO_SUCH_TABLE') {
    const tableName = err.message.match(/'([^']+)'/)?.[1] || 'unknown';
    logger.error(`DB | Table missing: ${tableName}`);
    logger.error('DB | Run fix_defaultdb.sql in TablePlus to create all missing tables');
    return res.status(500).json({
      success: false,
      message: `A required database table (${tableName}) is missing. Please run the setup SQL script.`,
      code: 'DB_TABLE_MISSING',
      table: tableName,
    });
  }

  // ── MySQL: unknown column ──────────────────────────────────
  if (err.code === 'ER_BAD_FIELD_ERROR') {
    logger.error(`DB | Unknown column: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: `Database column error: ${err.message}. The database schema may need to be updated.`,
      code: 'DB_COLUMN_ERROR',
    });
  }

  // ── MySQL: connection refused / access denied ──────────────
  if (err.code === 'ECONNREFUSED' || err.code === 'ER_ACCESS_DENIED_ERROR') {
    logger.error('DB | Connection refused or access denied');
    return res.status(503).json({
      success: false,
      message: 'Cannot connect to database. Please try again in a moment.',
      code: 'DB_CONNECTION_ERROR',
    });
  }

  // ── MySQL: too many connections ────────────────────────────
  if (err.code === 'ER_CON_COUNT_ERROR') {
    return res.status(503).json({
      success: false,
      message: 'Server is busy. Please try again shortly.',
      code: 'SERVER_BUSY',
    });
  }

  // ── JWT errors ────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid session token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Session expired', code: 'TOKEN_EXPIRED' });
  }

  // ── Validation ────────────────────────────────────────────
  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message });
  }

  // ── Default ───────────────────────────────────────────────
  return res.status(status).json({
    success: false,
    message,
  });
};

module.exports = errorHandler;
