const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config/app_config');
const logger = require('../utils/logger');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
let driveClient = null;
let driveAuth = null;

function isConfigured() {
  const cfg = config.googleDrive || {};
  return (
    cfg.enabled &&
    !!String(cfg.folderId || '').trim() &&
    (!!String(cfg.serviceAccountJson || '').trim() ||
      !!String(cfg.serviceAccountPath || '').trim())
  );
}

function getCredentials() {
  const cfg = config.googleDrive || {};
  if (cfg.serviceAccountJson) {
    return JSON.parse(cfg.serviceAccountJson);
  }
  if (cfg.serviceAccountPath) {
    const raw = fs.readFileSync(cfg.serviceAccountPath, 'utf8');
    return JSON.parse(raw);
  }
  throw new Error('Google Drive service account is not configured');
}

async function getDriveClient() {
  if (driveClient) return driveClient;

  if (!isConfigured()) {
    throw new Error('Google Drive storage is not configured');
  }

  const credentials = getCredentials();
  driveAuth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
  driveClient = google.drive({ version: 'v3', auth: driveAuth });
  logger.startup('Google Drive service initialized');
  return driveClient;
}

function publicDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

async function uploadAppReleaseFile({ localPath, fileName, mimeType = 'application/vnd.android.package-archive' }) {
  const drive = await getDriveClient();
  const folderId = String(config.googleDrive.folderId).trim();
  const resolvedName = fileName || path.basename(localPath);

  const createRes = await drive.files.create({
    requestBody: {
      name: resolvedName,
      mimeType,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: 'id,name,size,mimeType,webViewLink',
    supportsAllDrives: true,
  });

  const fileId = createRes.data.id;
  if (!fileId) {
    throw new Error('Google Drive upload succeeded but no file id returned');
  }

  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    });
  } catch (permErr) {
    logger.warn(`Google Drive permission warning for file:${fileId} | ${permErr.message}`);
  }

  return {
    fileId,
    fileName: createRes.data.name || resolvedName,
    fileSize: createRes.data.size ? Number(createRes.data.size) : null,
    mimeType: createRes.data.mimeType || mimeType,
    webViewLink: createRes.data.webViewLink || null,
    downloadUrl: publicDownloadUrl(fileId),
  };
}

async function streamFileToResponse({ fileId, res, wantsDownload = true, fileName = 'app-release.apk' }) {
  const drive = await getDriveClient();

  let metadata;
  try {
    const metaRes = await drive.files.get({
      fileId,
      fields: 'name,mimeType,size',
      supportsAllDrives: true,
    });
    metadata = metaRes.data;
  } catch (_) {
    metadata = {};
  }

  const response = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true,
    },
    { responseType: 'stream' }
  );

  const resolvedName = metadata?.name || fileName;
  const mimeType = metadata?.mimeType || 'application/octet-stream';
  const size = metadata?.size || null;

  res.setHeader('Content-Type', mimeType);
  if (size) res.setHeader('Content-Length', size);
  res.setHeader(
    'Content-Disposition',
    `${wantsDownload ? 'attachment' : 'inline'}; filename="${resolvedName}"`
  );

  response.data.on('error', (err) => {
    logger.error(`Google Drive stream error | file:${fileId} | ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to stream file from Google Drive' });
    }
  });
  response.data.pipe(res);
}

module.exports = {
  isConfigured,
  publicDownloadUrl,
  uploadAppReleaseFile,
  streamFileToResponse,
};
