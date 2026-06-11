const db     = require('../config/db_config');
const logger = require('../utils/logger');

// ─── GET ALL MEDIA ────────────────────────────────────────────
exports.getAllMedia = async (req, res, next) => {
  const { type, page = 1, limit = 20, search } = req.query;
  logger.info(`MEDIA | getAllMedia | type:${type||'all'} page:${page} search:${search||'none'}`);
  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = `
      SELECT m.id, m.type, m.title, m.thumbnail_url, m.status, m.created_at,
        u.name AS uploaded_by_name,
        mm.event_name, mm.location, mm.description, mm.speaker_name,
        mm.sermon_topic, mm.service_date,
        up_yt.youtube_link, up_yt.youtube_video_id,
        up_tg.telegram_msg_id
      FROM media m
      LEFT JOIN users u ON m.uploaded_by = u.id
      LEFT JOIN media_metadata mm ON m.id = mm.media_id
      LEFT JOIN uploads up_yt ON m.id = up_yt.media_id AND up_yt.platform = 'youtube' AND up_yt.upload_status = 'success'
      LEFT JOIN uploads up_tg ON m.id = up_tg.media_id AND up_tg.platform = 'telegram' AND up_tg.upload_status = 'success'
      WHERE m.status = 'uploaded'
    `;
    const params = [];
    if (type && ['video', 'photo', 'audio'].includes(type)) {
      query += ' AND m.type = ?'; params.push(type);
    }
    if (search) {
      query += ' AND (mm.event_name LIKE ? OR mm.description LIKE ? OR mm.speaker_name LIKE ? OR m.title LIKE ?)';
      const s = `%${search}%`; params.push(s, s, s, s);
    }
    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [rows] = await db.promise().query(query, params);
    const [[{ total }]] = await db.promise().query(
      `SELECT COUNT(*) AS total FROM media m LEFT JOIN media_metadata mm ON m.id = mm.media_id WHERE m.status = 'uploaded' ${type ? 'AND m.type = ?' : ''}`,
      type ? [type] : []
    );

    logger.db('SELECT', 'media', `returned ${rows.length} of ${total} items`);
    return res.json({
      success: true, data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { logger.error('getAllMedia error:', err.message); next(err); }
};

// ─── GET MEDIA BY ID ──────────────────────────────────────────
exports.getMediaById = async (req, res, next) => {
  const { id } = req.params;
  logger.info(`MEDIA | getMediaById | id:${id}`);
  try {
    const [rows] = await db.promise().query(
      `SELECT m.*, u.name AS uploaded_by_name,
        mm.event_name, mm.location, mm.description, mm.participants,
        mm.speaker_name, mm.sermon_topic, mm.service_date,
        up_yt.youtube_link, up_yt.youtube_video_id, up_tg.telegram_msg_id
       FROM media m
       LEFT JOIN users u ON m.uploaded_by = u.id
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       LEFT JOIN uploads up_yt ON m.id = up_yt.media_id AND up_yt.platform = 'youtube'
       LEFT JOIN uploads up_tg ON m.id = up_tg.media_id AND up_tg.platform = 'telegram'
       WHERE m.id = ?`,
      [id]
    );
    if (!rows.length) {
      logger.warn(`MEDIA | id:${id} not found`);
      return res.status(404).json({ success: false, message: 'Media not found' });
    }
    logger.db('SELECT', 'media', `found media id:${id} type:${rows[0].type}`);
    return res.json({ success: true, data: rows[0] });
  } catch (err) { logger.error('getMediaById error:', err.message); next(err); }
};

// ─── CREATE MEDIA (Admin) ─────────────────────────────────────
exports.createMedia = async (req, res, next) => {
  const { type, title, file_path, metadata } = req.body;
  logger.info(`MEDIA | createMedia | type:${type} title:${title} by user:${req.user?.id}`);
  try {
    if (!type || !['video', 'photo', 'audio'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Valid media type required (video/photo/audio)' });
    }
    const [result] = await db.promise().query(
      'INSERT INTO media (type, title, file_path, status, uploaded_by) VALUES (?, ?, ?, "pending", ?)',
      [type, title || null, file_path || null, req.user.id]
    );
    const mediaId = result.insertId;
    logger.db('INSERT', 'media', `created media id:${mediaId}`);

    if (metadata) {
      await db.promise().query(
        `INSERT INTO media_metadata (media_id, event_name, location, description, participants, speaker_name, sermon_topic, service_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [mediaId, metadata.event_name||null, metadata.location||null, metadata.description||null,
         metadata.participants||null, metadata.speaker_name||null, metadata.sermon_topic||null, metadata.service_date||null]
      );
      logger.db('INSERT', 'media_metadata', `saved metadata for media id:${mediaId}`);
    }

    await db.promise().query(
      'INSERT INTO uploads (media_id, platform) VALUES (?, "telegram"), (?, "youtube")',
      [mediaId, mediaId]
    );
    logger.db('INSERT', 'uploads', `created upload rows for media id:${mediaId}`);

    await db.promise().query(
      'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
      ['MEDIA_CREATED', req.user.id, `${type} media created: ${title}`]
    );

    logger.media('CREATED', type, mediaId, `by user:${req.user.id}`);
    return res.status(201).json({ success: true, message: 'Media entry created', data: { id: mediaId } });
  } catch (err) { logger.error('createMedia error:', err.message); next(err); }
};

// ─── UPDATE MEDIA (Admin) ─────────────────────────────────────
exports.updateMedia = async (req, res, next) => {
  const { id } = req.params;
  logger.info(`MEDIA | updateMedia | id:${id} by user:${req.user?.id}`);
  try {
    const { title, metadata } = req.body;
    if (title) {
      await db.promise().query('UPDATE media SET title = ? WHERE id = ?', [title, id]);
      logger.db('UPDATE', 'media', `title updated for id:${id}`);
    }
    if (metadata) {
      await db.promise().query(
        `UPDATE media_metadata SET event_name=?, location=?, description=?, participants=?,
         speaker_name=?, sermon_topic=?, service_date=? WHERE media_id=?`,
        [metadata.event_name, metadata.location, metadata.description, metadata.participants,
         metadata.speaker_name, metadata.sermon_topic, metadata.service_date, id]
      );
      logger.db('UPDATE', 'media_metadata', `metadata updated for media id:${id}`);
    }
    return res.json({ success: true, message: 'Media updated' });
  } catch (err) { logger.error('updateMedia error:', err.message); next(err); }
};

// ─── DELETE MEDIA (Admin) ─────────────────────────────────────
exports.deleteMedia = async (req, res, next) => {
  const { id } = req.params;
  logger.info(`MEDIA | deleteMedia | id:${id} by user:${req.user?.id}`);
  try {
    const [rows] = await db.promise().query('SELECT * FROM media WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Media not found' });
    await db.promise().query('DELETE FROM media WHERE id = ?', [id]);
    await db.promise().query('INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
      ['MEDIA_DELETED', req.user.id, `Deleted media id:${id}`]);
    logger.media('DELETED', rows[0].type, id, `by user:${req.user.id}`);
    return res.json({ success: true, message: 'Media deleted' });
  } catch (err) { logger.error('deleteMedia error:', err.message); next(err); }
};

// ─── ADMIN QUEUE ──────────────────────────────────────────────
exports.getAdminQueue = async (req, res, next) => {
  logger.info(`MEDIA | getAdminQueue | for user:${req.user?.id}`);
  try {
    const [rows] = await db.promise().query(
      `SELECT m.*, mm.event_name, mm.speaker_name,
        up_yt.upload_status AS youtube_status, up_yt.youtube_link,
        up_tg.upload_status AS telegram_status, up_tg.telegram_msg_id
       FROM media m
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       LEFT JOIN uploads up_yt ON m.id = up_yt.media_id AND up_yt.platform = 'youtube'
       LEFT JOIN uploads up_tg ON m.id = up_tg.media_id AND up_tg.platform = 'telegram'
       WHERE m.uploaded_by = ? ORDER BY m.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    logger.db('SELECT', 'media+uploads', `admin queue: ${rows.length} items for user:${req.user.id}`);
    return res.json({ success: true, data: rows });
  } catch (err) { logger.error('getAdminQueue error:', err.message); next(err); }
};

// ─── UPDATE THUMBNAIL ─────────────────────────────────────────
exports.updateThumbnail = async (req, res, next) => {
  const { id } = req.params;
  const { thumbnail_url } = req.body;
  logger.info(`MEDIA | updateThumbnail | id:${id}`);
  try {
    await db.promise().query('UPDATE media SET thumbnail_url = ? WHERE id = ?', [thumbnail_url, id]);
    logger.db('UPDATE', 'media', `thumbnail updated for id:${id}`);
    return res.json({ success: true, message: 'Thumbnail updated' });
  } catch (err) { logger.error('updateThumbnail error:', err.message); next(err); }
};
