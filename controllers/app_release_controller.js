const fs = require('fs');
const db = require('../config/db_config');
const config = require('../config/app_config');
const logger = require('../utils/logger');
const telegramService = require('../services/telegram_service');
const firebaseService = require('../services/firebase_service');
const googleDriveService = require('../services/google_drive_service');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function getAppReleaseChannelId() {
  return (
    config.telegram?.appReleaseChannelId ||
    process.env.TELEGRAM_APP_RELEASE_CHANNEL_ID ||
    process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID ||
    '-1003741514843'
  )
    .toString()
    .trim();
}

function getPublicBaseUrl() {
  const explicit = (config.app?.publicBaseUrl || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  return process.env.RENDER_EXTERNAL_URL
    ? String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
    : '';
}

function buildDownloadUrl(req) {
  const pathOnly = '/api/app-releases/latest/download';
  const inferredBase =
    req && req.get
      ? `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.get('host')}`
      : '';
  const base = getPublicBaseUrl() || inferredBase;
  return base ? `${base}${pathOnly}` : pathOnly;
}

async function getActiveDeviceTokens() {
  const [tables] = await db.promise().query('SHOW TABLES LIKE ?', ['device_tokens']);
  if (!tables.length) return [];

  const [rows] = await db.promise().query(
    `SELECT device_token
     FROM device_tokens
     WHERE is_active = 1
       AND device_token IS NOT NULL
       AND device_token <> ''`
  );
  return rows.map((row) => row.device_token).filter(Boolean);
}

function normalizeReleaseRow(row, req) {
  if (!row) return null;
  const storageProvider =
    String(row.telegram_channel_id || '').toLowerCase() === 'google_drive'
      ? 'google_drive'
      : 'telegram';

  return {
    id: row.id,
    version: row.version,
    title: row.title,
    release_notes: row.release_notes,
    force_update: !!row.force_update,
    notify_users: !!row.notify_users,
    created_at: row.created_at,
    telegram_channel_id: row.telegram_channel_id || null,
    telegram_message_id: row.telegram_message_id || null,
    telegram_file_id: row.telegram_file_id || null,
    telegram_file_unique_id: row.telegram_file_unique_id || null,
    telegram_file_path: row.telegram_file_path || null,
    file_name: row.file_name || null,
    file_size: row.file_size || null,
    download_url: buildDownloadUrl(req),
    storage_provider: storageProvider,
    source_label:
      storageProvider === 'google_drive'
        ? 'Google Drive storage'
        : 'Telegram storage',
  };
}

async function hasAppReleasesTable() {
  const [rows] = await db.promise().query('SHOW TABLES LIKE ?', ['app_releases']);
  return rows.length > 0;
}

exports.getLatest = async (req, res, next) => {
  try {
    if (!(await hasAppReleasesTable())) {
      return res.status(503).json({
        success: false,
        message: 'app_releases table is missing. Run the database ALTER/CREATE script first.',
      });
    }

    const [rows] = await db.promise().query(
      `SELECT id, version, title, release_notes, force_update, notify_users, created_at,
              telegram_channel_id, telegram_message_id, telegram_file_id,
              telegram_file_unique_id, telegram_file_path, file_name, file_size
       FROM app_releases
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'No app release published yet' });
    }

    return res.json({ success: true, data: normalizeReleaseRow(rows[0], req) });
  } catch (error) {
    logger.error(`appRelease.getLatest error: ${error.message}`);
    next(error);
  }
};

exports.getAdminList = async (req, res, next) => {
  try {
    if (!(await hasAppReleasesTable())) {
      return res.status(503).json({
        success: false,
        message: 'app_releases table is missing. Run the database ALTER/CREATE script first.',
      });
    }

    const [rows] = await db.promise().query(
      `SELECT id, version, title, release_notes, force_update, notify_users, is_active, created_at,
              telegram_channel_id, telegram_message_id, telegram_file_id,
              telegram_file_unique_id, telegram_file_path, file_name, file_size
       FROM app_releases
       ORDER BY id DESC
       LIMIT 30`
    );

    const data = rows.map((row) => ({
      ...normalizeReleaseRow(row, req),
      is_active: !!row.is_active,
    }));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error(`appRelease.getAdminList error: ${error.message}`);
    next(error);
  }
};

exports.create = async (req, res, next) => {
  let tgUploadResult = null;

  try {
    if (!(await hasAppReleasesTable())) {
      return res.status(503).json({
        success: false,
        message: 'app_releases table is missing. Run the database ALTER/CREATE script first.',
      });
    }

    const version = String(req.body.version || '').trim();
    const title = String(req.body.title || '').trim() || null;
    const releaseNotes = String(req.body.release_notes || '').trim() || null;
    const forceUpdate = parseBool(req.body.force_update, false);
    const notifyUsers = parseBool(req.body.notify_users, true);

    if (!version) {
      return res.status(400).json({ success: false, message: 'Version is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'APK file is required' });
    }

    logger.info(
      `appRelease.create | incoming APK size: ${req.file.size || 0} bytes (${(((req.file.size || 0) / (1024 * 1024))).toFixed(2)} MB)`
    );

    let channelId = getAppReleaseChannelId();
    const useGoogleDrive = googleDriveService.isConfigured();

    if (useGoogleDrive) {
      try {
        const driveUpload = await googleDriveService.uploadAppReleaseFile({
          localPath: req.file.path,
          fileName: req.file.originalname || req.file.filename || 'app-release.apk',
        });

        channelId = 'google_drive';
        tgUploadResult = {
          messageId: null,
          fileId: driveUpload.fileId,
          fileUniqueId: null,
          filePath: driveUpload.downloadUrl,
        };
      } catch (driveErr) {
        logger.error(`appRelease.create | Google Drive upload failed | ${driveErr.message}`);
        throw driveErr;
      }
    } else {
      try {
        tgUploadResult = await telegramService.sendMediaToChannel(
          {
            type: 'document',
            file_path: req.file.path,
          },
          channelId,
          {
            caption: [
              'APP UPDATE STORAGE',
              `Version: ${version}`,
              title ? `Title: ${title}` : null,
              forceUpdate ? 'Type: FORCE UPDATE' : 'Type: NORMAL UPDATE',
              '',
              'SHAREGRACE FAMLY CHURCH',
            ]
              .filter(Boolean)
              .join('\n'),
            parseMode: null,
          }
        );
      } catch (uploadErr) {
        const upstreamStatus =
          uploadErr?.response?.status ||
          uploadErr?.status ||
          null;
        const upstreamDescription =
          uploadErr?.response?.data?.description ||
          uploadErr?.response?.data?.message ||
          uploadErr?.message ||
          'Unknown upstream upload error';

        logger.error(
          `appRelease.create | Telegram upload failed | status:${upstreamStatus || 'unknown'} | ${upstreamDescription}`
        );

        if (upstreamStatus === 413) {
          return res.status(413).json({
            success: false,
            message:
              'APK upload was rejected as too large by an upstream service (Telegram or hosting proxy). Build a smaller APK (split-per-abi) and retry.',
            code: 'APP_RELEASE_UPSTREAM_413',
            stage: 'telegram_upload',
            upstream_status: 413,
            upstream_message: upstreamDescription,
            file_size_bytes: req.file.size || null,
          });
        }

        throw uploadErr;
      }
    }

    if (!tgUploadResult?.fileId) {
      throw new Error('Release upload succeeded but file id was not returned');
    }

    await db.promise().query('UPDATE app_releases SET is_active = 0 WHERE is_active = 1');

    const [insertResult] = await db.promise().query(
      `INSERT INTO app_releases (
         version,
         title,
         release_notes,
         force_update,
         notify_users,
         telegram_channel_id,
         telegram_message_id,
         telegram_file_id,
         telegram_file_unique_id,
         telegram_file_path,
         file_name,
         file_size,
         uploaded_by,
         is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        version,
        title,
        releaseNotes,
        forceUpdate ? 1 : 0,
        notifyUsers ? 1 : 0,
        channelId,
        tgUploadResult.messageId || null,
        tgUploadResult.fileId || null,
        tgUploadResult.fileUniqueId || null,
        tgUploadResult.filePath || null,
        req.file.originalname || req.file.filename || 'app-release.apk',
        req.file.size || null,
        req.user?.id || null,
      ]
    );

    if (notifyUsers) {
      try {
        const tokens = await getActiveDeviceTokens();
        if (tokens.length) {
          await firebaseService.sendAppUpdateNotification({
            tokens,
            latestVersion: version,
            forceUpdate,
            body: forceUpdate
              ? `Version ${version} is required. Please update now.`
              : `Version ${version} is now available.`,
          });
        }
      } catch (pushError) {
        logger.warn(`appRelease.create push notification warning: ${pushError.message}`);
      }
    }

    return res.status(201).json({
      success: true,
      message: 'App release uploaded successfully',
      data: {
        id: insertResult.insertId,
        version,
        force_update: forceUpdate,
        notify_users: notifyUsers,
        telegram_message_id: tgUploadResult.messageId || null,
        telegram_file_id: tgUploadResult.fileId || null,
        telegram_file_unique_id: tgUploadResult.fileUniqueId || null,
        telegram_file_path: tgUploadResult.filePath || null,
        download_url: buildDownloadUrl(req),
      },
    });
  } catch (error) {
    logger.error(`appRelease.create error: ${error.message}`);
    next(error);
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
  }
};

exports.downloadLatest = async (req, res, next) => {
  try {
    if (!(await hasAppReleasesTable())) {
      return res.status(503).json({
        success: false,
        message: 'app_releases table is missing. Run the database ALTER/CREATE script first.',
      });
    }

    const [rows] = await db.promise().query(
      `SELECT id, version, file_name, telegram_file_id, telegram_file_path
       FROM app_releases
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'No app release available' });
    }

    const row = rows[0];
    if (!row.telegram_file_id && !row.telegram_file_path) {
      return res
        .status(404)
        .json({ success: false, message: 'Release file is unavailable on Telegram storage' });
    }

    const safeVersion = String(row.version || 'latest').replace(/[^0-9A-Za-z._-]/g, '_');
    const defaultName = `sharegrace-family-church-v${safeVersion}.apk`;
    const fileName = row.file_name || defaultName;

    const storageProvider =
      String(row.telegram_channel_id || '').toLowerCase() === 'google_drive'
        ? 'google_drive'
        : 'telegram';

    if (storageProvider === 'google_drive') {
      return googleDriveService.streamFileToResponse({
        fileId: row.telegram_file_id,
        res,
        wantsDownload: true,
        fileName,
      });
    }

    await telegramService.streamFileToResponse({
      fileId: row.telegram_file_id || null,
      filePath: row.telegram_file_path || null,
      res,
      wantsDownload: true,
      fileName,
    });
  } catch (error) {
    logger.error(`appRelease.downloadLatest error: ${error.message}`);
    next(error);
  }
};
