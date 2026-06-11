const db = require('../config/db_config');
const logger = require('../utils/logger');

async function hasTable(tableName) {
  const [rows] = await db.promise().query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
}

exports.register = async (req, res, next) => {
  try {
    const { token, platform = 'android' } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }
    if (!(await hasTable('device_tokens'))) {
      return res.status(500).json({ success: false, message: 'device_tokens table not available yet' });
    }

    await db.promise().query(
      `INSERT INTO device_tokens (user_id, device_token, platform, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         platform = VALUES(platform),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, token, platform]
    );

    logger.info(`DEVICE_TOKEN | registered for user:${req.user.email} platform:${platform}`);
    return res.json({ success: true, message: 'Device token registered' });
  } catch (err) {
    next(err);
  }
};

exports.unregister = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }
    if (!(await hasTable('device_tokens'))) {
      return res.json({ success: true, message: 'device_tokens table missing, nothing to unregister' });
    }

    await db.promise().query(
      `UPDATE device_tokens
       SET is_active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE device_token = ?`,
      [token]
    );

    logger.info(`DEVICE_TOKEN | unregistered for user:${req.user.email}`);
    return res.json({ success: true, message: 'Device token unregistered' });
  } catch (err) {
    next(err);
  }
};
