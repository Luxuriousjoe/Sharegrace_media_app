// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Auth Controller
//  Password stored in column: password_hash (plain text, no bcrypt)
//  Column name matches actual defaultdb users table schema
// ═══════════════════════════════════════════════════════════════
const jwt    = require('jsonwebtoken');
const db     = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');

// ─── Helper: Generate Tokens ──────────────────────────────────
const generateTokens = (user) => {
  const payload = {
    id:    user.id,
    email: user.email,
    role:  user.role,
    name:  user.name,
  };
  const accessToken  = jwt.sign(payload, config.jwt.secret,        { expiresIn: config.jwt.expiresIn });
  const refreshToken = jwt.sign({ id: user.id }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpires });
  return { accessToken, refreshToken };
};

// ─── LOGIN ────────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  const { email, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  logger.auth('LOGIN_ATTEMPT', email || 'NO_EMAIL', '?', ip);

  try {
    if (!email || !password) {
      logger.warn(`LOGIN_FAIL | Missing email or password | ip:${ip}`);
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    logger.db('SELECT', 'users', `looking up email: ${cleanEmail}`);

    const [rows] = await db.promise().query(
      'SELECT * FROM users WHERE email = ? AND is_active = 1',
      [cleanEmail]
    );

    logger.db('RESULT', 'users', `found ${rows.length} user(s) for email: ${cleanEmail}`);

    if (!rows.length) {
      logger.warn(`LOGIN_FAIL | User not found: ${cleanEmail} | ip:${ip}`);
      return res.status(401).json({
        success: false,
        message: 'No account found with that email address',
      });
    }

    const user = rows[0];
    logger.info(`LOGIN | User found: id:${user.id} name:${user.name} role:${user.role}`);

    // ── Read from password_hash column (plain text, no bcrypt) ──
    logger.info(`LOGIN | Checking password for user id:${user.id}...`);

    // The DB column is named password_hash but stores plain text
    const storedPassword = user.password_hash;

    logger.info(`LOGIN | stored length:${storedPassword?.length} incoming length:${password?.length}`);

    if (!storedPassword) {
      logger.error(`LOGIN_FAIL | password_hash is null/undefined for user id:${user.id}`);
      return res.status(500).json({
        success: false,
        message: 'Account password not configured. Please contact the administrator.',
      });
    }

    const isMatch = (storedPassword === password);

    if (!isMatch) {
      logger.warn(`LOGIN_FAIL | Wrong password for: ${cleanEmail} | ip:${ip}`);
      return res.status(401).json({
        success: false,
        message: 'Incorrect password. Please try again.',
      });
    }

    logger.info(`LOGIN | Password matched for user id:${user.id}`);

    const { accessToken, refreshToken } = generateTokens(user);
    logger.info(`LOGIN | Tokens generated for user id:${user.id}`);

    // Save refresh token
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.promise().query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, refreshToken, expiresAt]
    );
    logger.db('INSERT', 'refresh_tokens', `saved for user id:${user.id}`);

    // Log the login event
    try {
      await db.promise().query(
        'INSERT INTO logs (action, user_id, details, ip_addr) VALUES (?, ?, ?, ?)',
        ['USER_LOGIN', user.id, `Successful login by ${user.email}`, ip]
      );
    } catch (logErr) {
      // ip_addr column may not exist in all schema versions
      if (logErr.message?.includes("Unknown column 'ip_addr'")) {
        await db.promise().query(
          'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
          ['USER_LOGIN', user.id, `Successful login by ${user.email}`]
        );
      } else {
        logger.warn(`LOGIN | Could not write log: ${logErr.message}`);
      }
    }

    logger.auth('LOGIN_SUCCESS', user.email, user.role, ip);

    return res.json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      data: {
        accessToken,
        refreshToken,
        user: {
          id:         user.id,
          name:       user.name,
          email:      user.email,
          role:       user.role,
          avatar_url: user.avatar_url || null,
          can_upload_media: user.can_upload_media,
          can_manage_users: user.can_manage_users,
          can_manage_timely_reflections: user.can_manage_timely_reflections,
          can_manage_home_banners: user.can_manage_home_banners,
        },
      },
    });

  } catch (err) {
    logger.error(`LOGIN_ERROR | ${err.message} | email:${email} | ip:${ip}`);
    logger.error('Stack:', err.stack);
    next(err);
  }
};

// ─── REFRESH TOKEN ─────────────────────────────────────────────
exports.refreshToken = async (req, res, next) => {
  logger.info('REFRESH_TOKEN | Request received');
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'Refresh token required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch (jwtErr) {
      logger.warn(`REFRESH_TOKEN | JWT verify failed: ${jwtErr.message}`);
      return res.status(401).json({ success: false, message: 'Session expired — please log in again' });
    }

    const [tokenRows] = await db.promise().query(
      'SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > NOW()',
      [refreshToken]
    );

    if (!tokenRows.length) {
      logger.warn(`REFRESH_TOKEN | Token not found or expired for user id:${decoded.id}`);
      return res.status(401).json({ success: false, message: 'Session expired — please log in again' });
    }

    const [userRows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!userRows.length) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    const user = userRows[0];
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

    await db.promise().query('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.promise().query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, newRefreshToken, expiresAt]
    );

    logger.auth('TOKEN_REFRESH', user.email, user.role, req.ip);
    return res.json({ success: true, data: { accessToken, refreshToken: newRefreshToken } });

  } catch (err) {
    logger.error('REFRESH_TOKEN_ERROR:', err.message);
    next(err);
  }
};

// ─── LOGOUT ───────────────────────────────────────────────────
exports.logout = async (req, res, next) => {
  logger.info('LOGOUT | Request received');
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const [result] = await db.promise().query(
        'DELETE FROM refresh_tokens WHERE token = ?',
        [refreshToken]
      );
      logger.db('DELETE', 'refresh_tokens', `removed ${result.affectedRows} token(s)`);
    }
    logger.auth('LOGOUT', req.user?.email || 'unknown', req.user?.role || '?', req.ip);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    logger.error('LOGOUT_ERROR:', err.message);
    next(err);
  }
};

// ─── GET ME ───────────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  logger.info(`GET_ME | user id:${req.user?.id}`);
  try {
    const [rows] = await db.promise().query(
      `SELECT
        id,
        name,
        email,
        role,
        avatar_url,
        created_at,
        can_upload_media,
        can_manage_users,
        can_manage_timely_reflections,
        can_manage_home_banners
       FROM users
       WHERE id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    logger.info(`GET_ME | Returned profile for ${rows[0].email}`);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    logger.error('GET_ME_ERROR:', err.message);
    next(err);
  }
};

// ─── CHANGE PASSWORD ──────────────────────────────────────────
// Reads and writes password_hash column (plain text stored there)
exports.changePassword = async (req, res, next) => {
  logger.info(`CHANGE_PASSWORD | user id:${req.user?.id}`);
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
    }

    const [rows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });

    const user = rows[0];

    // Compare against password_hash column (plain text)
    if (user.password_hash !== currentPassword) {
      logger.warn(`CHANGE_PASSWORD | Wrong current password for user id:${user.id}`);
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    // Update password_hash column with new plain text value
    await db.promise().query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [newPassword, user.id]
    );
    logger.auth('PWD_CHANGED', user.email, user.role, req.ip);
    return res.json({ success: true, message: 'Password updated successfully' });

  } catch (err) {
    logger.error('CHANGE_PASSWORD_ERROR:', err.message);
    next(err);
  }
};
