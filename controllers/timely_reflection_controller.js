const db = require('../config/db_config');
const firebaseService = require('../services/firebase_service');
const logger = require('../utils/logger');

async function hasTable(tableName) {
  const [rows] = await db.promise().query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
}

async function getColumns(tableName) {
  const [rows] = await db.promise().query(`SHOW COLUMNS FROM ${tableName}`);
  return new Set(rows.map((row) => row.Field));
}

exports.getCurrent = async (req, res, next) => {
  try {
    if (!(await hasTable('timely_reflections'))) {
      return res.json({ success: true, data: null });
    }
    let [rows] = await db.promise().query(
      `SELECT * FROM timely_reflections
       WHERE is_active = 1 AND starts_at <= NOW() AND expires_at > NOW()
       ORDER BY starts_at DESC
       LIMIT 1`
    );
    if (!rows.length) {
      [rows] = await db.promise().query(
        `SELECT * FROM timely_reflections
         WHERE is_active = 1 AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`
      );
    }
    return res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    next(err);
  }
};

exports.getAll = async (req, res, next) => {
  try {
    if (!(await hasTable('timely_reflections'))) {
      return res.json({ success: true, data: [] });
    }
    const [rows] = await db.promise().query(
      'SELECT * FROM timely_reflections ORDER BY reflection_date DESC, created_at DESC'
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { topic, main_article, reference_text, confession, further_study, reflection_date, starts_at, expires_at } = req.body;
    if (!topic || !reflection_date || !starts_at || !expires_at) {
      return res.status(400).json({ success: false, message: 'topic, reflection_date, starts_at, and expires_at are required' });
    }
    if (!(await hasTable('timely_reflections'))) {
      return res.status(500).json({ success: false, message: 'timely_reflections table not available yet' });
    }
    const columns = await getColumns('timely_reflections');
    await db.promise().query('UPDATE timely_reflections SET is_active = 0 WHERE is_active = 1');
    const fields = [
      ['topic', topic],
      ...(columns.has('main_article') ? [['main_article', main_article || null]] : []),
      ['reference_text', reference_text || null],
      ['confession', confession || null],
      ['further_study', further_study || null],
      ['reflection_date', reflection_date],
      ['starts_at', starts_at],
      ['expires_at', expires_at],
      ['is_active', 1],
      ...(columns.has('created_by') ? [['created_by', req.user.id]] : []),
    ];
    const [result] = await db.promise().query(
      `INSERT INTO timely_reflections
       (${fields.map(([name]) => name).join(', ')})
       VALUES (${fields.map(() => '?').join(', ')})`,
      fields.map(([, value]) => value)
    );

    try {
      if (await hasTable('device_tokens')) {
        const [tokenRows] = await db.promise().query(
          `SELECT device_token
           FROM device_tokens
           WHERE is_active = 1`
        );
        const tokens = tokenRows
          .map((row) => row.device_token)
          .filter(Boolean);

        logger.info(
          `TIMELY_REFLECTION_PUSH token lookup found ${tokens.length} active device(s)`
        );

        await firebaseService.sendTimelyReflectionBroadcast({
          topic,
          reflectionId: result.insertId,
        });
      }
    } catch (pushError) {
      logger.warn(`TIMELY_REFLECTION_PUSH failed: ${pushError.message}`);
    }

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await hasTable('timely_reflections'))) {
      return res.json({ success: true, message: 'Nothing to delete' });
    }
    await db.promise().query('UPDATE timely_reflections SET is_active = 0 WHERE id = ?', [id]);
    return res.json({ success: true, message: 'Reflection archived' });
  } catch (err) {
    next(err);
  }
};
