const fs = require('fs');
const path = require('path');
const db = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');
const telegramService = require('../services/telegram_service');

let bannerColumnCache = null;

async function getBannerColumns() {
  if (bannerColumnCache) {
    return bannerColumnCache;
  }

  const [rows] = await db.promise().query('SHOW COLUMNS FROM home_header_banners');
  bannerColumnCache = new Set(rows.map((row) => row.Field));
  return bannerColumnCache;
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

function getHomeBannerChannelId() {
  return (
    config.telegram?.homeBannerChannelId ||
    process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID ||
    '-1003741514843'
  ).toString().trim();
}

function buildBannerFileUrl(id) {
  const baseUrl = getPublicBaseUrl();
  const pathOnly = `/api/home-banners/${id}/file`;
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
    const [rows] = await db.promise().query(
      `SELECT id, image_path, display_order, is_active, created_at
       FROM home_header_banners
       WHERE is_active = 1
       ORDER BY display_order ASC, created_at DESC`
    );

    const data = rows.map((row) => ({
      ...row,
      image_url: buildBannerFileUrl(row.id),
    }));

    return res.json({ success: true, data });
  } catch (error) {
    logger.error('homeBanner.getAll error:', error.message);
    next(error);
  }
};

exports.getAdminList = async (req, res, next) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, image_path, display_order, is_active, created_at
       FROM home_header_banners
       ORDER BY display_order ASC, created_at DESC`
    );

    const data = rows.map((row) => ({
      ...row,
      image_url: buildBannerFileUrl(row.id),
    }));

    return res.json({ success: true, data });
  } catch (error) {
    logger.error('homeBanner.getAdminList error:', error.message);
    next(error);
  }
};

exports.upload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image file is required' });
    }

    const columns = await getBannerColumns();
    const displayOrder = Number.parseInt(req.body.display_order, 10);
    const safeOrder = Number.isNaN(displayOrder) ? 1000 : displayOrder;
    const isActive = parseBool(req.body.is_active, true);

    let storagePath = req.file.path;
    let telegramFileId = null;
    let telegramFilePath = null;
    let telegramMessageId = null;
    let telegramFileUniqueId = null;
    let telegramUploadWorked = false;

    try {
      const channelId = getHomeBannerChannelId();
      const tgUploadResult = await telegramService.sendMediaToChannel(
        {
          type: 'photo',
          file_path: req.file.path,
          title: `Home Banner ${new Date().toISOString()}`,
        },
        channelId,
        {
          caption: 'HOME BANNER STORAGE\nSHAREGRACE FAMLY CHURCH',
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
      } else {
        logger.warn('homeBanner.upload | Telegram upload returned without fileId, keeping local file storage');
      }
    } catch (tgError) {
      logger.warn(`homeBanner.upload | Telegram upload failed, falling back to local storage: ${tgError.message}`);
    }

    const fields = ['image_path', 'display_order'];
    const values = [storagePath, safeOrder];

    if (columns.has('is_active')) {
      fields.push('is_active');
      values.push(isActive ? 1 : 0);
    }
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
      `INSERT INTO home_header_banners (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values
    );

    if (telegramUploadWorked && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }

    return res.status(201).json({
      success: true,
      message: telegramUploadWorked
        ? 'Home banner uploaded to Telegram storage'
        : 'Home banner uploaded (local fallback storage)',
      data: {
        id: result.insertId,
        image_url: buildBannerFileUrl(result.insertId),
        storage: telegramUploadWorked ? 'telegram' : 'local',
      },
    });
  } catch (error) {
    logger.error('homeBanner.upload error:', error.message);
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      'SELECT id, image_path FROM home_header_banners WHERE id = ? LIMIT 1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    const row = rows[0];
    await db.promise().query('DELETE FROM home_header_banners WHERE id = ?', [id]);

    if (row.image_path && isLocalPath(row.image_path) && fs.existsSync(row.image_path)) {
      try {
        fs.unlinkSync(row.image_path);
      } catch (_) {}
    }

    return res.json({ success: true, message: 'Banner deleted' });
  } catch (error) {
    logger.error('homeBanner.remove error:', error.message);
    next(error);
  }
};

exports.toggle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      'SELECT id, is_active FROM home_header_banners WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    const nextValue = parseBool(rows[0].is_active, true) ? 0 : 1;
    await db.promise().query(
      'UPDATE home_header_banners SET is_active = ? WHERE id = ?',
      [nextValue, id]
    );

    return res.json({
      success: true,
      message: nextValue ? 'Banner enabled' : 'Banner hidden',
    });
  } catch (error) {
    logger.error('homeBanner.toggle error:', error.message);
    next(error);
  }
};

exports.streamFile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const columns = await getBannerColumns();

    const selectTelegramMsgId = columns.has('telegram_msg_id') ? 'telegram_msg_id' : 'NULL AS telegram_msg_id';
    const selectTelegramFileId = columns.has('telegram_file_id') ? 'telegram_file_id' : 'NULL AS telegram_file_id';
    const selectTelegramFilePath = columns.has('telegram_file_path') ? 'telegram_file_path' : 'NULL AS telegram_file_path';

    const [rows] = await db.promise().query(
      `SELECT image_path, ${selectTelegramMsgId}, ${selectTelegramFileId}, ${selectTelegramFilePath}
       FROM home_header_banners
       WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    const row = rows[0];
    const localPath = row.image_path;
    if (localPath && isLocalPath(localPath) && fs.existsSync(localPath)) {
      const ext = path.extname(localPath).toLowerCase();
      const contentType = ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(localPath).pipe(res);
      return;
    }

    const fileId = row.telegram_file_id || extractTelegramFileIdFromImagePath(row.image_path);
    const filePath = row.telegram_file_path || null;

    if (!fileId && !filePath) {
      return res.status(404).json({ success: false, message: 'Banner file not available' });
    }

    await telegramService.streamFileToResponse({
      fileId,
      filePath,
      res,
      wantsDownload: false,
      fileName: `home-banner-${id}.jpg`,
    });
  } catch (error) {
    logger.error('homeBanner.streamFile error:', error.message);
    next(error);
  }
};
