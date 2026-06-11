const fs = require('fs');
const path = require('path');
const db = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');
const telegramService = require('../services/telegram_service');

let adColumnCache = null;

async function getAdColumns() {
  if (adColumnCache) return adColumnCache;
  const [rows] = await db.promise().query('SHOW COLUMNS FROM event_ads');
  adColumnCache = new Set(rows.map((row) => row.Field));
  return adColumnCache;
}

function getPublicBaseUrl() {
  const explicit = (config.app?.publicBaseUrl || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return process.env.RENDER_EXTERNAL_URL
    ? String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
    : '';
}

function getEventAdChannelId() {
  return (
    config.telegram?.eventAdChannelId ||
    process.env.TELEGRAM_EVENT_AD_CHANNEL_ID ||
    process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID ||
    '-1003741514843'
  )
    .toString()
    .trim();
}

function buildAdFileUrl(id) {
  const baseUrl = getPublicBaseUrl();
  const pathOnly = `/api/event-ads/${id}/file`;
  return baseUrl ? `${baseUrl}${pathOnly}` : pathOnly;
}

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function isLocalPath(filePath) {
  if (!filePath) return false;
  return filePath.includes('\\') || filePath.includes('/') || filePath.startsWith('.');
}

function extractTelegramFileIdFromImagePath(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  const prefix = 'tg_file_id:';
  return imagePath.startsWith(prefix) ? imagePath.substring(prefix.length) : null;
}

exports.getAll = async (req, res, next) => {
  try {
    await db.promise().query(
      `UPDATE event_ads
       SET is_active = 0
       WHERE is_active = 1
         AND event_date < CURDATE()`
    );

    const [rows] = await db.promise().query(
      `SELECT id, image_path, ad_label, headline, subheadline, event_date, display_order, is_active, created_at
       FROM event_ads
       WHERE is_active = 1
         AND event_date >= CURDATE()
       ORDER BY event_date ASC, display_order ASC, created_at DESC`
    );

    const data = rows.map((row) => ({
      ...row,
      image_url: buildAdFileUrl(row.id),
    }));

    return res.json({ success: true, data });
  } catch (error) {
    logger.error(`eventAd.getAll error: ${error.message}`);
    next(error);
  }
};

exports.getAdminList = async (req, res, next) => {
  try {
    await db.promise().query(
      `UPDATE event_ads
       SET is_active = 0
       WHERE is_active = 1
         AND event_date < CURDATE()`
    );

    const [rows] = await db.promise().query(
      `SELECT id, image_path, ad_label, headline, subheadline, event_date, display_order, is_active, created_at
       FROM event_ads
       ORDER BY display_order ASC, event_date ASC, created_at DESC`
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const data = rows.map((row) => {
      const eventDate = row.event_date ? new Date(row.event_date) : null;
      const isExpired = eventDate ? eventDate < today : false;
      return {
        ...row,
        is_expired: isExpired,
        image_url: buildAdFileUrl(row.id),
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    logger.error(`eventAd.getAdminList error: ${error.message}`);
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Ad image file is required' });
    }

    const columns = await getAdColumns();
    const adLabel = String(req.body.ad_label || 'UPCOMING EVENT').trim() || 'UPCOMING EVENT';
    const headline = String(req.body.headline || '').trim();
    const subheadline = String(req.body.subheadline || '').trim() || null;
    const eventDate = String(req.body.event_date || '').trim();
    const displayOrder = Number.parseInt(req.body.display_order, 10);
    const safeOrder = Number.isNaN(displayOrder) ? 1000 : displayOrder;
    const isActive = parseBool(req.body.is_active, true);

    if (!headline) {
      return res.status(400).json({ success: false, message: 'Headline is required' });
    }
    if (!eventDate) {
      return res.status(400).json({ success: false, message: 'Event date is required' });
    }

    let storagePath = req.file.path;
    let telegramFileId = null;
    let telegramFilePath = null;
    let telegramMessageId = null;
    let telegramFileUniqueId = null;
    let telegramUploadWorked = false;

    try {
      const channelId = getEventAdChannelId();
      const tgUploadResult = await telegramService.sendMediaToChannel(
        {
          type: 'photo',
          file_path: req.file.path,
          title: `Event Ad ${new Date().toISOString()}`,
        },
        channelId,
        {
          caption: [
            'HOME AD STORAGE',
            `Label: ${adLabel}`,
            `Headline: ${headline}`,
            `Date: ${eventDate}`,
            '',
            'SHAREGRACE FAMLY CHURCH',
          ].join('\n'),
          parseMode: null,
        }
      );

      telegramFileId = tgUploadResult.fileId || null;
      telegramFilePath = tgUploadResult.filePath || null;
      telegramMessageId = tgUploadResult.messageId || null;
      telegramFileUniqueId = tgUploadResult.fileUniqueId || null;

      if (telegramFileId) {
        storagePath = `tg_file_id:${telegramFileId}`;
        telegramUploadWorked = true;
      }
    } catch (tgError) {
      logger.warn(`eventAd.create | Telegram upload failed, fallback local: ${tgError.message}`);
    }

    const fields = [
      'image_path',
      'ad_label',
      'headline',
      'subheadline',
      'event_date',
      'display_order',
      'is_active',
    ];
    const values = [
      storagePath,
      adLabel,
      headline,
      subheadline,
      eventDate,
      safeOrder,
      isActive ? 1 : 0,
    ];

    if (columns.has('created_by')) {
      fields.push('created_by');
      values.push(req.user.id);
    }
    if (columns.has('telegram_msg_id')) {
      fields.push('telegram_msg_id');
      values.push(telegramMessageId);
    }
    if (columns.has('telegram_file_id')) {
      fields.push('telegram_file_id');
      values.push(telegramFileId);
    }
    if (columns.has('telegram_file_path')) {
      fields.push('telegram_file_path');
      values.push(telegramFilePath);
    }
    if (columns.has('telegram_file_unique_id')) {
      fields.push('telegram_file_unique_id');
      values.push(telegramFileUniqueId);
    }

    const [result] = await db.promise().query(
      `INSERT INTO event_ads (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values
    );

    if (telegramUploadWorked && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }

    return res.status(201).json({
      success: true,
      message: 'Event ad created',
      data: {
        id: result.insertId,
        image_url: buildAdFileUrl(result.insertId),
      },
    });
  } catch (error) {
    logger.error(`eventAd.create error: ${error.message}`);
    next(error);
  }
};

exports.toggle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      'SELECT id, is_active FROM event_ads WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    const nextValue = parseBool(rows[0].is_active, true) ? 0 : 1;
    await db.promise().query('UPDATE event_ads SET is_active = ? WHERE id = ?', [nextValue, id]);
    return res.json({
      success: true,
      message: nextValue ? 'Ad activated' : 'Ad stopped',
    });
  } catch (error) {
    logger.error(`eventAd.toggle error: ${error.message}`);
    next(error);
  }
};

exports.updateOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const displayOrder = Number.parseInt(req.body.display_order, 10);
    if (Number.isNaN(displayOrder)) {
      return res.status(400).json({ success: false, message: 'display_order must be a number' });
    }

    const [rows] = await db.promise().query(
      'SELECT id FROM event_ads WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    await db.promise().query(
      'UPDATE event_ads SET display_order = ? WHERE id = ?',
      [displayOrder, id]
    );

    return res.json({ success: true, message: 'Ad order updated' });
  } catch (error) {
    logger.error(`eventAd.updateOrder error: ${error.message}`);
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      'SELECT id, image_path FROM event_ads WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    const row = rows[0];
    await db.promise().query('DELETE FROM event_ads WHERE id = ?', [id]);
    if (row.image_path && isLocalPath(row.image_path) && fs.existsSync(row.image_path)) {
      try {
        fs.unlinkSync(row.image_path);
      } catch (_) {}
    }

    return res.json({ success: true, message: 'Ad deleted' });
  } catch (error) {
    logger.error(`eventAd.remove error: ${error.message}`);
    next(error);
  }
};

exports.streamFile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const columns = await getAdColumns();
    const selectTelegramFileId = columns.has('telegram_file_id') ? 'telegram_file_id' : 'NULL AS telegram_file_id';
    const selectTelegramFilePath = columns.has('telegram_file_path')
      ? 'telegram_file_path'
      : 'NULL AS telegram_file_path';

    const [rows] = await db.promise().query(
      `SELECT image_path, ${selectTelegramFileId}, ${selectTelegramFilePath}
       FROM event_ads
       WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    const row = rows[0];
    const localPath = row.image_path;
    if (localPath && isLocalPath(localPath) && fs.existsSync(localPath)) {
      const ext = path.extname(localPath).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(localPath).pipe(res);
      return;
    }

    const fileId = row.telegram_file_id || extractTelegramFileIdFromImagePath(row.image_path);
    const filePath = row.telegram_file_path || null;
    if (!fileId && !filePath) {
      return res.status(404).json({ success: false, message: 'Ad file not available' });
    }

    await telegramService.streamFileToResponse({
      fileId,
      filePath,
      res,
      wantsDownload: false,
      fileName: `event-ad-${id}.jpg`,
    });
  } catch (error) {
    logger.error(`eventAd.streamFile error: ${error.message}`);
    next(error);
  }
};
