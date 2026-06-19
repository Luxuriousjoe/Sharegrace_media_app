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
  const hasOAuthCredentials =
    !!String(cfg.clientId || '').trim() &&
    !!String(cfg.clientSecret || '').trim() &&
    !!String(cfg.refreshToken || '').trim();
  const hasServiceAccountCredentials =
    !!String(cfg.serviceAccountJson || '').trim() ||
    !!String(cfg.serviceAccountPath || '').trim();

  return (
    cfg.enabled &&
    !!getDefaultFolderId() &&
    (hasOAuthCredentials || hasServiceAccountCredentials)
  );
}

function getDefaultFolderId() {
  const cfg = config.googleDrive || {};
  return String(
    cfg.folderId ||
      cfg.mediaFolderId ||
      cfg.videoFolderId ||
      cfg.photoFolderId ||
      cfg.audioFolderId ||
      ''
  ).trim();
}

function resolveFolderId(mediaType) {
  const cfg = config.googleDrive || {};
  const type = String(mediaType || '').toLowerCase();
  if (type === 'video') return String(cfg.videoFolderId || getDefaultFolderId()).trim();
  if (type === 'photo') return String(cfg.photoFolderId || getDefaultFolderId()).trim();
  if (type === 'audio') return String(cfg.audioFolderId || getDefaultFolderId()).trim();
  if (type === 'thumbnail') return String(cfg.thumbnailFolderId || getDefaultFolderId()).trim();
  return getDefaultFolderId();
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

function hasOAuthCredentials() {
  const cfg = config.googleDrive || {};
  return (
    !!String(cfg.clientId || '').trim() &&
    !!String(cfg.clientSecret || '').trim() &&
    !!String(cfg.refreshToken || '').trim()
  );
}

function getOAuth2Client() {
  const cfg = config.googleDrive || {};
  const auth = new google.auth.OAuth2(
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri || 'https://developers.google.com/oauthplayground'
  );

  auth.setCredentials({ refresh_token: cfg.refreshToken });
  return auth;
}

async function getDriveClient() {
  if (driveClient) return driveClient;

  if (!isConfigured()) {
    throw new Error('Google Drive storage is not configured');
  }

  if (hasOAuthCredentials()) {
    driveAuth = getOAuth2Client();
    driveClient = google.drive({ version: 'v3', auth: driveAuth });
    logger.startup('Google Drive service initialized with OAuth user credentials');
    return driveClient;
  }

  const credentials = getCredentials();
  driveAuth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  driveClient = google.drive({ version: 'v3', auth: driveAuth });
  logger.startup('Google Drive service initialized with service account credentials');
  return driveClient;
}

function publicDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || !size) return null;

  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const startText = match[1];
  const endText = match[2];
  const start = startText ? Number.parseInt(startText, 10) : 0;
  const end = endText ? Number.parseInt(endText, 10) : size - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { invalid: true };
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

async function uploadAppReleaseFile({ localPath, fileName, mimeType = 'application/vnd.android.package-archive' }) {
  return uploadFileToDrive({
    localPath,
    fileName,
    mimeType,
    folderId: String(config.googleDrive.folderId || getDefaultFolderId()).trim(),
  });
}

async function uploadMediaFile({ localPath, fileName, mimeType = 'application/octet-stream', mediaType }) {
  return uploadFileToDrive({
    localPath,
    fileName,
    mimeType,
    folderId: resolveFolderId(mediaType),
  });
}

async function uploadFileToDrive({ localPath, fileName, mimeType = 'application/octet-stream', folderId }) {
  const drive = await getDriveClient();
  const resolvedFolderId = String(folderId || getDefaultFolderId()).trim();
  const resolvedName = fileName || path.basename(localPath);

  if (!resolvedFolderId) {
    throw new Error('Google Drive folder id is not configured');
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: resolvedName,
      mimeType,
      parents: [resolvedFolderId],
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

async function streamFileToResponse({
  fileId,
  res,
  wantsDownload = true,
  fileName = 'app-release.apk',
  rangeHeader,
}) {
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

  const resolvedName = metadata?.name || fileName;
  const mimeType = metadata?.mimeType || 'application/octet-stream';
  const size = metadata?.size ? Number(metadata.size) : null;
  const range = parseRangeHeader(rangeHeader, size);

  if (range?.invalid) {
    res.status(416);
    if (size) res.setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }

  const requestOptions = { responseType: 'stream' };
  if (range) {
    requestOptions.headers = {
      Range: `bytes=${range.start}-${range.end}`,
    };
  }

  const response = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true,
    },
    requestOptions
  );

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range && size) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else if (size) {
    res.setHeader('Content-Length', size);
  }
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
  resolveFolderId,
  uploadFile: uploadFileToDrive,
  uploadFileToDrive,
  uploadMedia: uploadMediaFile,
  uploadAppReleaseFile,
  uploadMediaFile,
  streamFileToResponse,
};
