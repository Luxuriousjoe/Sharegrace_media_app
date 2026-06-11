const fs = require('fs');
const path = require('path');
const db = require('../config/db_config');
const config = require('../config/app_config');
const telegramService = require('../services/telegram_service');
const photoPreviewService = require('../services/photo_preview_service');
const logger = require('../utils/logger');

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

let uploadsColumnCache = null;
let mediaMetadataColumnCache = null;
let mediaColumnCache = null;

async function getUploadsColumns() {
  if (uploadsColumnCache) {
    return uploadsColumnCache;
  }

  const [rows] = await db.promise().query('SHOW COLUMNS FROM uploads');
  uploadsColumnCache = new Set(rows.map((row) => row.Field));
  return uploadsColumnCache;
}

async function getMediaColumns() {
  if (mediaColumnCache) {
    return mediaColumnCache;
  }

  const [rows] = await db.promise().query('SHOW COLUMNS FROM media');
  mediaColumnCache = new Set(rows.map((row) => row.Field));
  return mediaColumnCache;
}

async function getMediaMetadataColumns() {
  if (mediaMetadataColumnCache) {
    return mediaMetadataColumnCache;
  }

  const [rows] = await db.promise().query('SHOW COLUMNS FROM media_metadata');
  mediaMetadataColumnCache = new Set(rows.map((row) => row.Field));
  return mediaMetadataColumnCache;
}

function getPublicBaseUrl() {
  const explicit = (config.app?.publicBaseUrl || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  return process.env.RENDER_EXTERNAL_URL
    ? String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
    : '';
}

function buildPreviewUrl(mediaId) {
  const baseUrl = getPublicBaseUrl();
  return baseUrl
    ? `${baseUrl}/api/media/${mediaId}/preview`
    : `/api/media/${mediaId}/preview`;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

async function buildMediaMetadataSelect(prefix = 'mm') {
  const columns = await getMediaMetadataColumns();
  const pick = (column) =>
    columns.has(column) ? `${prefix}.${column}` : `NULL AS ${column}`;

  return [
    pick('event_name'),
    pick('location'),
    pick('description'),
    pick('participants'),
    pick('speaker_name'),
    pick('sermon_topic'),
    pick('service_date'),
    pick('content_category'),
    pick('upload_to_telegram'),
    pick('upload_to_youtube'),
    pick('youtube_schedule_at'),
    pick('featured_enabled'),
    pick('featured_candidate'),
    pick('featured_until'),
    pick('view_count'),
    pick('video_orientation'),
    pick('video_aspect_ratio'),
  ].join(',\n        ');
}

function streamLocalFile({ filePath, wantsDownload, res }) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';
  const fileName = path.basename(filePath);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${wantsDownload ? 'attachment' : 'inline'}; filename="${fileName}"`
  );

  return { fileSize, fileName };
}

// ─── GET ALL MEDIA ────────────────────────────────────────────
exports.getAllMedia = async (req, res, next) => {
  const { type, page = 1, limit = 20, search } = req.query;
  logger.info(`MEDIA | getAllMedia | type:${type || 'all'} page:${page} search:${search || 'none'}`);

  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const metadataSelect = await buildMediaMetadataSelect();

    const mediaColumns = await getMediaColumns();
    const hasPreviewFilePath = mediaColumns.has('preview_file_path');
    const hasPreviewTelegramFileId = mediaColumns.has('preview_telegram_file_id');
    const hasPreviewTelegramFilePath = mediaColumns.has('preview_telegram_file_path');

    const previewAvailabilityParts = [];
    if (hasPreviewFilePath) previewAvailabilityParts.push('m.preview_file_path IS NOT NULL');
    if (hasPreviewTelegramFileId) previewAvailabilityParts.push('m.preview_telegram_file_id IS NOT NULL');
    if (hasPreviewTelegramFilePath) previewAvailabilityParts.push('m.preview_telegram_file_path IS NOT NULL');
    const previewAvailabilitySql = previewAvailabilityParts.length
      ? previewAvailabilityParts.join(' OR ')
      : '0';

    let query = `
      SELECT
        m.id,
        m.type AS type,
        m.title,
        CASE
          WHEN m.type = 'photo' AND (${previewAvailabilitySql})
            THEN ?
          ELSE m.thumbnail_url
        END AS thumbnail_url,
        m.status,
        m.created_at,
        u.name AS uploaded_by_name,
        ${metadataSelect},
        up_yt.youtube_link,
        up_yt.youtube_video_id,
        up_tg.telegram_msg_id
      FROM media m
      LEFT JOIN users u ON m.uploaded_by = u.id
      LEFT JOIN media_metadata mm ON m.id = mm.media_id
      LEFT JOIN uploads up_yt
        ON m.id = up_yt.media_id
       AND up_yt.platform = 'youtube'
       AND up_yt.upload_status = 'success'
      LEFT JOIN uploads up_tg
        ON m.id = up_tg.media_id
       AND up_tg.platform = 'telegram'
       AND up_tg.upload_status = 'success'
      WHERE m.status = 'uploaded'
    `;

    const params = [buildPreviewUrl('__MEDIA_ID__')];

    if (type && ['video', 'photo', 'audio'].includes(type)) {
      query += ` AND m.type = ?`;
      params.push(type);
    }

    if (search) {
      query += ` AND (
        mm.event_name LIKE ?
        OR mm.description LIKE ?
        OR mm.speaker_name LIKE ?
        OR m.title LIKE ?
      )`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    query += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const [rows] = await db.promise().query(query, params);
    for (const row of rows) {
      if (row.thumbnail_url === buildPreviewUrl('__MEDIA_ID__')) {
        row.thumbnail_url = buildPreviewUrl(row.id);
      }
    }

    logger.db('SELECT', 'media', `returned ${rows.length} items`);
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('getAllMedia error:', err.message);
    next(err);
  }
};

// ─── GET MEDIA BY ID ──────────────────────────────────────────
exports.getMediaById = async (req, res, next) => {
  const { id } = req.params;
  logger.info(`MEDIA | getMediaById | id:${id}`);

  try {
    const metadataSelect = await buildMediaMetadataSelect();
    const mediaColumns = await getMediaColumns();
    const hasPreviewFilePath = mediaColumns.has('preview_file_path');
    const hasPreviewTelegramFileId = mediaColumns.has('preview_telegram_file_id');
    const hasPreviewTelegramFilePath = mediaColumns.has('preview_telegram_file_path');
    const previewAvailabilityParts = [];
    if (hasPreviewFilePath) previewAvailabilityParts.push('m.preview_file_path IS NOT NULL');
    if (hasPreviewTelegramFileId) previewAvailabilityParts.push('m.preview_telegram_file_id IS NOT NULL');
    if (hasPreviewTelegramFilePath) previewAvailabilityParts.push('m.preview_telegram_file_path IS NOT NULL');
    const previewAvailabilitySql = previewAvailabilityParts.length
      ? previewAvailabilityParts.join(' OR ')
      : '0';
    const [rows] = await db.promise().query(
      `SELECT
        m.id,
        m.type AS type,
        m.file_path,
        m.title,
        CASE
          WHEN m.type = 'photo' AND (${previewAvailabilitySql})
            THEN ?
          ELSE m.thumbnail_url
        END AS thumbnail_url,
        m.status,
        m.created_at,
        u.name AS uploaded_by_name,
        ${metadataSelect},
        up_yt.youtube_link,
        up_yt.youtube_video_id,
        up_tg.telegram_msg_id
      FROM media m
      LEFT JOIN users u ON m.uploaded_by = u.id
      LEFT JOIN media_metadata mm ON m.id = mm.media_id
      LEFT JOIN uploads up_yt ON m.id = up_yt.media_id AND up_yt.platform = 'youtube'
      LEFT JOIN uploads up_tg ON m.id = up_tg.media_id AND up_tg.platform = 'telegram'
      WHERE m.id = ?`,
      [buildPreviewUrl(id), id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    logger.error('getMediaById error:', err.message);
    next(err);
  }
};

exports.streamPhotoPreview = async (req, res, next) => {
  const { id } = req.params;
  const wantsDownload = req.query.download === '1';

  try {
    const mediaColumns = await getMediaColumns();
    const previewFilePathSelect = mediaColumns.has('preview_file_path')
      ? 'm.preview_file_path'
      : 'NULL AS preview_file_path';
    const previewTelegramMsgIdSelect = mediaColumns.has('preview_telegram_msg_id')
      ? 'm.preview_telegram_msg_id'
      : 'NULL AS preview_telegram_msg_id';
    const previewTelegramFileIdSelect = mediaColumns.has('preview_telegram_file_id')
      ? 'm.preview_telegram_file_id'
      : 'NULL AS preview_telegram_file_id';
    const previewTelegramFilePathSelect = mediaColumns.has('preview_telegram_file_path')
      ? 'm.preview_telegram_file_path'
      : 'NULL AS preview_telegram_file_path';

    const [rows] = await db.promise().query(
      `SELECT
         m.id,
         m.title,
         m.type,
         m.file_path,
         ${previewFilePathSelect},
         ${previewTelegramMsgIdSelect},
         ${previewTelegramFileIdSelect},
         ${previewTelegramFilePathSelect}
       FROM media m
       WHERE m.id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    const media = rows[0];
    if (media.preview_file_path && fs.existsSync(media.preview_file_path)) {
      const { fileSize } = streamLocalFile({
        filePath: media.preview_file_path,
        wantsDownload,
        res,
      });
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(media.preview_file_path).pipe(res);
      return;
    }

    if (media.preview_telegram_file_id || media.preview_telegram_file_path) {
      await telegramService.streamFileToResponse({
        fileId: media.preview_telegram_file_id,
        filePath: media.preview_telegram_file_path,
        res,
        wantsDownload,
        fileName: `${media.title || `preview-${media.id}`}.jpg`,
      });
      return;
    }

    if (media.type === 'photo' && media.file_path && fs.existsSync(media.file_path)) {
      const generatedPreviewPath = await photoPreviewService.ensurePhotoPreview({
        mediaId: media.id,
        sourcePath: media.file_path,
        existingPreviewPath: media.preview_file_path,
      });
      const { fileSize } = streamLocalFile({
        filePath: generatedPreviewPath,
        wantsDownload,
        res,
      });
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(generatedPreviewPath).pipe(res);
      return;
    }

    return res.status(404).json({
      success: false,
      message: 'Media thumbnail not available',
    });
  } catch (err) {
    logger.error('streamPhotoPreview error:', err.message);
    next(err);
  }
};

exports.streamMediaFile = async (req, res, next) => {
  const { id } = req.params;
  const wantsDownload = req.query.download === '1';

  try {
    const uploadColumns = await getUploadsColumns();
    const tgFileIdSelect = uploadColumns.has('telegram_file_id')
      ? 'up_tg.telegram_file_id'
      : 'NULL AS telegram_file_id';
    const tgFilePathSelect = uploadColumns.has('telegram_file_path')
      ? 'up_tg.telegram_file_path'
      : 'NULL AS telegram_file_path';

    const [rows] = await db.promise().query(
      `SELECT
         m.id,
         m.type,
         m.file_path,
         m.title,
         up_tg.telegram_msg_id,
         ${tgFileIdSelect},
         ${tgFilePathSelect},
         up_yt.youtube_link,
         up_yt.youtube_video_id
       FROM media m
       LEFT JOIN uploads up_tg
         ON m.id = up_tg.media_id
        AND up_tg.platform = 'telegram'
        AND up_tg.upload_status = 'success'
       LEFT JOIN uploads up_yt
         ON m.id = up_yt.media_id
        AND up_yt.platform = 'youtube'
        AND up_yt.upload_status = 'success'
       WHERE m.id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    const media = rows[0];
    if (media.file_path && fs.existsSync(media.file_path)) {
      const { fileSize } = streamLocalFile({
        filePath: media.file_path,
        wantsDownload,
        res,
      });

      const range = req.headers.range;
      if (range) {
        const [startText, endText] = range.replace(/bytes=/, '').split('-');
        const start = Number.parseInt(startText, 10);
        const end = endText ? Number.parseInt(endText, 10) : fileSize - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
          return res.end();
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(media.file_path, { start, end }).pipe(res);
        return;
      }

      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(media.file_path).pipe(res);
      return;
    }

    if (media.telegram_file_id || media.telegram_file_path) {
      const fallbackName = media.title
        ? `${media.title}${path.extname(media.file_path || '') || ''}`
        : `media-${media.id}`;

      await telegramService.streamFileToResponse({
        fileId: media.telegram_file_id,
        filePath: media.telegram_file_path,
        res,
        wantsDownload,
        fileName: fallbackName,
      });
      return;
    }

    const platformHint = media.youtube_link
      ? 'The original file is unavailable on the server. YouTube playback is still available, but direct file download is not supported by the YouTube API.'
      : 'Media file not available. To support Telegram fallback downloads, store telegram_file_id and telegram_file_path on upload success.';

    return res.status(404).json({
      success: false,
      message: platformHint,
    });
  } catch (err) {
    logger.error('streamMediaFile error:', err.message);
    next(err);
  }
};

// ─── CREATE MEDIA ─────────────────────────────────────────────
exports.createMedia = async (req, res, next) => {
  try {
    const { type, title } = req.body;
    const metadataRaw = req.body.metadata;
    const uploadPlatformsRaw = req.body.upload_platforms;
    const explicitCategory = req.body.content_category;
    const explicitScheduleAt = req.body.youtube_schedule_at;

    if (!type || !['video', 'photo', 'audio'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Valid media type required (video/photo/audio)',
      });
    }

    const mediaFile = req.file || req.files?.file?.[0] || null;
    const thumbnailFile = req.files?.thumbnail?.[0] || null;

    if (!mediaFile) {
      return res.status(400).json({
        success: false,
        message: 'No media file uploaded',
      });
    }

    const metadata = typeof metadataRaw === 'string'
      ? JSON.parse(metadataRaw)
      : (metadataRaw || {});
    const requestedPlatforms = (() => {
      if (Array.isArray(uploadPlatformsRaw)) return uploadPlatformsRaw;
      if (typeof uploadPlatformsRaw === 'string' && uploadPlatformsRaw.trim()) {
        try {
          return JSON.parse(uploadPlatformsRaw);
        } catch (_) {
          return uploadPlatformsRaw.split(',').map((item) => item.trim()).filter(Boolean);
        }
      }
      return [];
    })();
    const normalisedPlatforms = [...new Set(
      requestedPlatforms
        .map((platform) => String(platform).trim().toLowerCase())
        .filter((platform) => platform === 'telegram' || platform === 'youtube')
    )];

    let uploadPlatforms;
    if (type === 'photo' || type === 'audio') {
      uploadPlatforms = ['telegram'];
    } else {
      uploadPlatforms = normalisedPlatforms.length
        ? normalisedPlatforms
        : ['telegram', 'youtube'];
    }

    if (!uploadPlatforms.length) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one platform for this media upload',
      });
    }

    const metadataColumns = await getMediaMetadataColumns();
    const mediaColumns = await getMediaColumns();
    const contentCategory = explicitCategory || metadata.content_category || null;
    const uploadToTelegram = type === 'photo' || type === 'audio'
      ? true
      : parseBoolean(metadata.upload_to_telegram, uploadPlatforms.includes('telegram'));
    const uploadToYouTube = type === 'video'
      ? parseBoolean(metadata.upload_to_youtube, uploadPlatforms.includes('youtube'))
      : false;
    const youtubeScheduleAt = type === 'video'
      ? (explicitScheduleAt || metadata.youtube_schedule_at || null)
      : null;

    const serverFilePath = mediaFile.path;

    const [columnCheck] = await db.promise().query("SHOW COLUMNS FROM media LIKE 'type'");
    const hasTypeColumn = Array.isArray(columnCheck) && columnCheck.length > 0;
    const typeColumn = hasTypeColumn ? 'type' : 'media_type';

    const [result] = await db.promise().query(
      `INSERT INTO media (${typeColumn}, title, file_path, status, uploaded_by)
       VALUES (?, ?, ?, 'pending', ?)`,
      [type, title || null, serverFilePath, req.user.id]
    );

    const mediaId = result.insertId;

    if (type === 'photo' && mediaColumns.has('preview_file_path')) {
      try {
        const previewPath = await photoPreviewService.generatePhotoPreview({
          mediaId,
          sourcePath: serverFilePath,
        });
        const setParts = ['preview_file_path = ?'];
        const setParams = [previewPath];

        if (mediaColumns.has('thumbnail_url')) {
          setParts.push('thumbnail_url = ?');
          setParams.push(buildPreviewUrl(mediaId));
        }

        if (mediaColumns.has('preview_upload_status')) {
          setParts.push("preview_upload_status = 'pending'");
        }

        await db.promise().query(
          `UPDATE media SET ${setParts.join(', ')} WHERE id = ?`,
          [...setParams, mediaId]
        );
      } catch (previewError) {
        logger.warn(`MEDIA | preview generation failed for media:${mediaId} | ${previewError.message}`);
      }
    }

    const canSetThumbnailPreview =
      (type === 'video' || type === 'audio') &&
      thumbnailFile &&
      mediaColumns.has('preview_file_path') &&
      mediaColumns.has('thumbnail_url');

    if (canSetThumbnailPreview) {
      const setParts = ['preview_file_path = ?', 'thumbnail_url = ?'];
      const setParams = [thumbnailFile.path, buildPreviewUrl(mediaId)];

      if (mediaColumns.has('preview_upload_status')) {
        setParts.push("preview_upload_status = 'success'");
      }

      await db.promise().query(
        `UPDATE media SET ${setParts.join(', ')} WHERE id = ?`,
        [...setParams, mediaId]
      );
    }

    const metadataFields = [
      ['media_id', mediaId],
      ['event_name', metadata.event_name || null],
      ['location', metadata.location || null],
      ['description', metadata.description || null],
      ['participants', metadata.participants || null],
      ['speaker_name', metadata.speaker_name || null],
      ['sermon_topic', metadata.sermon_topic || null],
      ['service_date', metadata.service_date || null],
    ];

    if (metadataColumns.has('content_category')) {
      metadataFields.push(['content_category', contentCategory]);
    }
    if (metadataColumns.has('upload_to_telegram')) {
      metadataFields.push(['upload_to_telegram', uploadToTelegram ? 1 : 0]);
    }
    if (metadataColumns.has('upload_to_youtube')) {
      metadataFields.push(['upload_to_youtube', uploadToYouTube ? 1 : 0]);
    }
    if (metadataColumns.has('youtube_schedule_at')) {
      metadataFields.push(['youtube_schedule_at', youtubeScheduleAt]);
    }
    if (metadataColumns.has('featured_enabled')) {
      metadataFields.push(['featured_enabled', parseBoolean(metadata.featured_enabled, false) ? 1 : 0]);
    }
    if (metadataColumns.has('featured_candidate')) {
      metadataFields.push(['featured_candidate', parseBoolean(metadata.featured_candidate, false) ? 1 : 0]);
    }
    if (metadataColumns.has('featured_until')) {
      metadataFields.push([
        'featured_until',
        parseBoolean(metadata.featured_enabled, false)
          ? new Date(Date.now() + 24 * 60 * 60 * 1000)
          : null,
      ]);
    }
    if (metadataColumns.has('view_count')) {
      metadataFields.push(['view_count', 0]);
    }
    if (metadataColumns.has('video_orientation')) {
      metadataFields.push(['video_orientation', metadata.video_orientation || null]);
    }
    if (metadataColumns.has('video_aspect_ratio')) {
      const ratioValue = metadata.video_aspect_ratio;
      metadataFields.push([
        'video_aspect_ratio',
        ratioValue == null || ratioValue === '' ? null : Number(ratioValue),
      ]);
    }

    await db.promise().query(
      `INSERT INTO media_metadata
       (${metadataFields.map(([column]) => column).join(', ')})
       VALUES (${metadataFields.map(() => '?').join(', ')})`,
      metadataFields.map(([, value]) => value)
    );

    const uploadRows = uploadPlatforms.map((platform) => [mediaId, platform, 'pending']);
    await db.promise().query(
      `INSERT INTO uploads (media_id, platform, upload_status)
       VALUES ?`,
      [uploadRows]
    );

    await db.promise().query(
      'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
      ['MEDIA_CREATED', req.user.id, `${type} media created: ${title || 'Untitled'}`]
    );
    const uploadController = require('./upload_controller');
    try {
      await uploadController.triggerUploadByMediaId(mediaId);
      logger.info(`MEDIA | auto-triggered upload for media:${mediaId}`);
    } catch (err) {
      logger.error(`MEDIA | auto-trigger failed for media:${mediaId} | ${err.message}`);
    }

    return res.status(201).json({
      success: true,
      message: 'Media entry created',
      data: { id: mediaId },
    });
  } catch (err) {
    logger.error('createMedia error:', err.message);
    next(err);
  }
};

// ─── UPDATE MEDIA ─────────────────────────────────────────────
exports.updateMedia = async (req, res, next) => {
  const { id } = req.params;

  try {
    const { title, metadata } = req.body;
    const metadataColumns = await getMediaMetadataColumns();

    if (title) {
      await db.promise().query(
        'UPDATE media SET title = ? WHERE id = ?',
        [title, id]
      );
    }

    if (metadata) {
      const setParts = [
        'event_name = ?',
        'location = ?',
        'description = ?',
        'participants = ?',
        'speaker_name = ?',
        'sermon_topic = ?',
        'service_date = ?',
      ];
      const params = [
        metadata.event_name || null,
        metadata.location || null,
        metadata.description || null,
        metadata.participants || null,
        metadata.speaker_name || null,
        metadata.sermon_topic || null,
        metadata.service_date || null,
      ];

      if (metadataColumns.has('content_category')) {
        setParts.push('content_category = ?');
        params.push(metadata.content_category || null);
      }
      if (metadataColumns.has('upload_to_telegram')) {
        setParts.push('upload_to_telegram = ?');
        params.push(metadata.upload_to_telegram == null ? null : (parseBoolean(metadata.upload_to_telegram) ? 1 : 0));
      }
      if (metadataColumns.has('upload_to_youtube')) {
        setParts.push('upload_to_youtube = ?');
        params.push(metadata.upload_to_youtube == null ? null : (parseBoolean(metadata.upload_to_youtube) ? 1 : 0));
      }
      if (metadataColumns.has('youtube_schedule_at')) {
        setParts.push('youtube_schedule_at = ?');
        params.push(metadata.youtube_schedule_at || null);
      }
      if (metadataColumns.has('featured_enabled')) {
        setParts.push('featured_enabled = ?');
        params.push(metadata.featured_enabled == null ? null : (parseBoolean(metadata.featured_enabled) ? 1 : 0));
      }
      if (metadataColumns.has('featured_candidate')) {
        setParts.push('featured_candidate = ?');
        params.push(metadata.featured_candidate == null ? null : (parseBoolean(metadata.featured_candidate) ? 1 : 0));
      }
      if (metadataColumns.has('featured_until')) {
        setParts.push('featured_until = ?');
        params.push(
          parseBoolean(metadata.featured_enabled, false)
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : null
        );
      }
      if (metadataColumns.has('video_orientation')) {
        setParts.push('video_orientation = ?');
        params.push(metadata.video_orientation || null);
      }
      if (metadataColumns.has('video_aspect_ratio')) {
        const ratioValue = metadata.video_aspect_ratio;
        setParts.push('video_aspect_ratio = ?');
        params.push(
          ratioValue == null || ratioValue === '' ? null : Number(ratioValue)
        );
      }

      await db.promise().query(
        `UPDATE media_metadata
         SET ${setParts.join(', ')}
         WHERE media_id = ?`,
        [...params, id]
      );
    }

    return res.json({ success: true, message: 'Media updated' });
  } catch (err) {
    logger.error('updateMedia error:', err.message);
    next(err);
  }
};

// ─── DELETE MEDIA ─────────────────────────────────────────────
exports.deleteMedia = async (req, res, next) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query(
      'SELECT * FROM media WHERE id = ?',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    await db.promise().query('DELETE FROM media WHERE id = ?', [id]);
    await db.promise().query(
      'INSERT INTO logs (action, user_id, details) VALUES (?, ?, ?)',
      ['MEDIA_DELETED', req.user.id, `Deleted media id:${id}`]
    );

    return res.json({ success: true, message: 'Media deleted' });
  } catch (err) {
    logger.error('deleteMedia error:', err.message);
    next(err);
  }
};

// ─── ADMIN QUEUE ──────────────────────────────────────────────
exports.getAdminQueue = async (req, res, next) => {
  try {
    const metadataSelect = await buildMediaMetadataSelect();
    const [rows] = await db.promise().query(
      `SELECT
        m.*,
        ${metadataSelect},
        up_yt.upload_status AS youtube_status,
        up_yt.youtube_link,
        up_tg.upload_status AS telegram_status,
        up_tg.telegram_msg_id
      FROM media m
      LEFT JOIN media_metadata mm ON m.id = mm.media_id
      LEFT JOIN uploads up_yt ON m.id = up_yt.media_id AND up_yt.platform = 'youtube'
      LEFT JOIN uploads up_tg ON m.id = up_tg.media_id AND up_tg.platform = 'telegram'
      WHERE m.uploaded_by = ?
      ORDER BY m.created_at DESC
      LIMIT 50`,
      [req.user.id]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('getAdminQueue error:', err.message);
    next(err);
  }
};

// ─── UPDATE THUMBNAIL ─────────────────────────────────────────
exports.updateThumbnail = async (req, res, next) => {
  const { id } = req.params;
  const { thumbnail_url } = req.body;

  try {
    await db.promise().query(
      'UPDATE media SET thumbnail_url = ? WHERE id = ?',
      [thumbnail_url, id]
    );

    return res.json({ success: true, message: 'Thumbnail updated' });
  } catch (err) {
    logger.error('updateThumbnail error:', err.message);
    next(err);
  }
};

exports.recordVisit = async (req, res, next) => {
  const { id } = req.params;
  try {
    const metadataColumns = await getMediaMetadataColumns();
    if (metadataColumns.has('view_count')) {
      await db.promise().query(
        'UPDATE media_metadata SET view_count = COALESCE(view_count, 0) + 1 WHERE media_id = ?',
        [id]
      );
    }
    return res.json({ success: true, message: 'Visit recorded' });
  } catch (err) {
    logger.error('recordVisit error:', err.message);
    next(err);
  }
};

exports.recordYouTubeWatch = async (req, res, next) => {
  const { id } = req.params;
  try {
    const metadataColumns = await getMediaMetadataColumns();
    if (metadataColumns.has('view_count')) {
      await db.promise().query(
        'UPDATE media_metadata SET view_count = COALESCE(view_count, 0) + 1 WHERE media_id = ?',
        [id]
      );
    }
    return res.json({ success: true, message: 'YouTube watch recorded' });
  } catch (err) {
    logger.error('recordYouTubeWatch error:', err.message);
    next(err);
  }
};
