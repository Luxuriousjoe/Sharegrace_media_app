const jwt = require('jsonwebtoken');
const db = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');

const userColumnCache = new Map();

const generateTokens = (user) => {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
  };

  const accessToken = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
  const refreshToken = jwt.sign(
    { id: user.id },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpires },
  );

  return { accessToken, refreshToken };
};

const hasUserColumn = async (column) => {
  if (userColumnCache.has(column)) {
    return userColumnCache.get(column);
  }

  try {
    const [rows] = await db.promise().query(
      'SHOW COLUMNS FROM users LIKE ?',
      [column],
    );
    const exists = rows.length > 0;
    userColumnCache.set(column, exists);
    return exists;
  } catch (error) {
    logger.warn(`AUTH | Could not inspect users.${column}: ${error.message}`);
    userColumnCache.set(column, false);
    return false;
  }
};

const mapUserPayload = async (user) => {
  const includeOnboarding = await hasUserColumn('onboarding_completed');
  const includeOnboardingAt = await hasUserColumn('onboarding_completed_at');

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar_url: user.avatar_url || null,
    can_upload_media: user.can_upload_media,
    can_manage_users: user.can_manage_users,
    can_manage_timely_reflections: user.can_manage_timely_reflections,
    can_manage_home_banners: user.can_manage_home_banners,
    onboarding_completed: includeOnboarding
      ? user.onboarding_completed ?? 0
      : 0,
    onboarding_completed_at: includeOnboardingAt
      ? user.onboarding_completed_at || null
      : null,
  };
};

const buildProfileSelect = async () => {
  const columns = [
    'id',
    'name',
    'email',
    'role',
    'avatar_url',
    'created_at',
    'can_upload_media',
    'can_manage_users',
    'can_manage_timely_reflections',
    'can_manage_home_banners',
  ];

  if (await hasUserColumn('onboarding_completed')) {
    columns.push('onboarding_completed');
  }
  if (await hasUserColumn('onboarding_completed_at')) {
    columns.push('onboarding_completed_at');
  }

  return columns.join(', ');
};

const updateLoginMetadata = async (userId, ip) => {
  const updates = [];
  const params = [];

  if (await hasUserColumn('first_login_at')) {
    updates.push('first_login_at = COALESCE(first_login_at, NOW())');
  }
  if (await hasUserColumn('last_login_at')) {
    updates.push('last_login_at = NOW()');
  }
  if (await hasUserColumn('last_login_ip')) {
    updates.push('last_login_ip = ?');
    params.push(ip);
  }

  if (!updates.length) return;

  await db.promise().query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    [...params, userId],
  );
};

exports.login = async (req, res, next) => {
  const { email, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  logger.auth('LOGIN_ATTEMPT', email || 'NO_EMAIL', '?', ip);

  try {
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const [rows] = await db.promise().query(
      'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
      [cleanEmail],
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: 'No account found with that email address',
      });
    }

    const user = rows[0];
    const storedPassword = user.password_hash;
    if (!storedPassword) {
      return res.status(500).json({
        success: false,
        message:
          'Account password not configured. Please contact the administrator.',
      });
    }

    if (storedPassword !== password) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password. Please try again.',
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.promise().query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, refreshToken, expiresAt],
    );

    try {
      await updateLoginMetadata(user.id, ip);
    } catch (error) {
      logger.warn(`AUTH | Could not update login metadata: ${error.message}`);
    }

    try {
      await db.promise().query(
        'INSERT INTO logs (action, user_id, details, ip_addr) VALUES (?, ?, ?, ?)',
        ['USER_LOGIN', user.id, `Successful login by ${user.email}`, ip],
      );
    } catch (logError) {
      if (logError.message?.includes("Unknown column 'ip_addr'")) {
        await db.promise().query(
          'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
          ['USER_LOGIN', user.id, `Successful login by ${user.email}`],
        );
      } else {
        logger.warn(`AUTH | Could not write login log: ${logError.message}`);
      }
    }

    logger.auth('LOGIN_SUCCESS', user.email, user.role, ip);

    return res.json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      data: {
        accessToken,
        refreshToken,
        user: await mapUserPayload(user),
      },
    });
  } catch (error) {
    logger.error(`LOGIN_ERROR | ${error.message} | email:${email} | ip:${ip}`);
    next(error);
  }
};

exports.register = async (req, res, next) => {
  const { name, email, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  try {
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required',
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).toLowerCase().trim();

    const [existingUsers] = await db.promise().query(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [cleanEmail],
    );

    if (existingUsers.length) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email already exists',
      });
    }

    const [insertResult] = await db.promise().query(
      'INSERT INTO users (name, email, role, password_hash, is_active) VALUES (?, ?, ?, ?, ?)',
      [cleanName, cleanEmail, 'user', password, true],
    );

    const [rows] = await db.promise().query(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [insertResult.insertId],
    );

    if (!rows.length) {
      return res.status(500).json({
        success: false,
        message: 'Account created but profile could not be loaded',
      });
    }

    const user = rows[0];
    const { accessToken, refreshToken } = generateTokens(user);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.promise().query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, refreshToken, expiresAt],
    );

    try {
      await updateLoginMetadata(user.id, ip);
      await db.promise().query(
        'INSERT INTO logs (action, user_id, details, ip_addr) VALUES (?, ?, ?, ?)',
        ['USER_REGISTER', user.id, `Account created for ${user.email}`, ip],
      );
    } catch (logError) {
      logger.warn(`AUTH | Could not write register log: ${logError.message}`);
    }

    logger.auth('REGISTER_SUCCESS', user.email, user.role, ip);

    return res.status(201).json({
      success: true,
      message: `Welcome to the family, ${user.name}!`,
      data: {
        accessToken,
        refreshToken,
        user: await mapUserPayload(user),
      },
    });
  } catch (error) {
    logger.error(`REGISTER_ERROR | ${error.message} | email:${email} | ip:${ip}`);
    next(error);
  }
};

exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res
        .status(400)
        .json({ success: false, message: 'Refresh token required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        message: 'Session expired, please log in again',
      });
    }

    const [tokenRows] = await db.promise().query(
      'SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > NOW()',
      [refreshToken],
    );

    if (!tokenRows.length) {
      return res.status(401).json({
        success: false,
        message: 'Session expired, please log in again',
      });
    }

    const [userRows] = await db.promise().query(
      'SELECT * FROM users WHERE id = ?',
      [decoded.id],
    );

    if (!userRows.length) {
      return res
        .status(401)
        .json({ success: false, message: 'User not found' });
    }

    const user = userRows[0];
    const nextTokens = generateTokens(user);

    await db.promise().query('DELETE FROM refresh_tokens WHERE token = ?', [
      refreshToken,
    ]);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.promise().query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, nextTokens.refreshToken, expiresAt],
    );

    logger.auth('TOKEN_REFRESH', user.email, user.role, req.ip);
    return res.json({
      success: true,
      data: {
        accessToken: nextTokens.accessToken,
        refreshToken: nextTokens.refreshToken,
      },
    });
  } catch (error) {
    logger.error(`REFRESH_TOKEN_ERROR | ${error.message}`);
    next(error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await db.promise().query(
        'DELETE FROM refresh_tokens WHERE token = ?',
        [refreshToken],
      );
    }

    logger.auth(
      'LOGOUT',
      req.user?.email || 'unknown',
      req.user?.role || '?',
      req.ip,
    );

    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error(`LOGOUT_ERROR | ${error.message}`);
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const columns = await buildProfileSelect();
    const [rows] = await db.promise().query(
      `SELECT ${columns} FROM users WHERE id = ?`,
      [req.user.id],
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, message: 'User not found' });
    }

    return res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    logger.error(`GET_ME_ERROR | ${error.message}`);
    next(error);
  }
};

exports.completeOnboarding = async (req, res, next) => {
  try {
    const canTrackOnboarding = await hasUserColumn('onboarding_completed');
    const canTrackOnboardingAt = await hasUserColumn('onboarding_completed_at');

    if (canTrackOnboarding) {
      const updates = ['onboarding_completed = 1'];
      if (canTrackOnboardingAt) {
        updates.push('onboarding_completed_at = NOW()');
      }

      await db.promise().query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        [req.user.id],
      );
    }

    const columns = await buildProfileSelect();
    const [rows] = await db.promise().query(
      `SELECT ${columns} FROM users WHERE id = ?`,
      [req.user.id],
    );

    return res.json({
      success: true,
      message: 'Onboarding completed',
      data: rows[0],
    });
  } catch (error) {
    logger.error(`COMPLETE_ONBOARDING_ERROR | ${error.message}`);
    next(error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: 'Both passwords required' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters',
      });
    }

    const [rows] = await db.promise().query(
      'SELECT * FROM users WHERE id = ?',
      [req.user.id],
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, message: 'User not found' });
    }

    const user = rows[0];
    if (user.password_hash !== currentPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    await db.promise().query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [newPassword, user.id],
    );

    logger.auth('PWD_CHANGED', user.email, user.role, req.ip);
    return res.json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    logger.error(`CHANGE_PASSWORD_ERROR | ${error.message}`);
    next(error);
  }
};
