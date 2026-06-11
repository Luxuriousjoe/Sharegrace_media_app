const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const config = require('../config/app_config');
const logger = require('../utils/logger');

const getBotToken = () => (config.telegram.botToken || '').trim();
const getChannelId = () => (config.telegram.channelId || '').trim();
const getMainPhotoChannelId = () => (config.telegram.mainPhotoChannelId || getChannelId() || '').trim();
const getPhotoDumpChannelId = () => (config.telegram.photoDumpChannelId || '').trim();
const BASE_URL = () => `https://api.telegram.org/bot${getBotToken()}`;
const FILE_BASE_URL = () => `https://api.telegram.org/file/bot${getBotToken()}`;

const buildCaption = (media) => {
  const lines = [];
  if (media.event_name) lines.push(`*${media.event_name}*`);
  if (media.speaker_name) lines.push(`Speaker: ${media.speaker_name}`);
  if (media.sermon_topic) lines.push(`Topic: ${media.sermon_topic}`);
  if (media.service_date) lines.push(`Date: ${media.service_date}`);
  if (media.location) lines.push(`${media.location}`);
  if (media.description) {
    lines.push(`\n${String(media.description).substring(0, 400)}`);
  }
  lines.push('\nSHAREGRACE FAMLY CHURCH');
  return lines.join('\n');
};

const extractUploadedFileMeta = (result, mediaType) => {
  if (!result) {
    return {};
  }

  if (mediaType === 'photo') {
    const photo = Array.isArray(result.photo) && result.photo.length
      ? result.photo[result.photo.length - 1]
      : null;

    return {
      fileId: photo?.file_id || null,
      fileUniqueId: photo?.file_unique_id || null,
    };
  }

  if (mediaType === 'audio') {
    return {
      fileId: result.audio?.file_id || null,
      fileUniqueId: result.audio?.file_unique_id || null,
    };
  }

  if (mediaType === 'video') {
    return {
      fileId: result.video?.file_id || null,
      fileUniqueId: result.video?.file_unique_id || null,
    };
  }

  if (result.document) {
    return {
      fileId: result.document.file_id || null,
      fileUniqueId: result.document.file_unique_id || null,
    };
  }

  return {};
};

exports.getFileInfo = async (fileId) => {
  if (!fileId) {
    throw new Error('Telegram file ID is required');
  }

  const response = await axios.get(`${BASE_URL()}/getFile`, {
    params: { file_id: fileId },
  });

  if (!response.data?.ok || !response.data?.result?.file_path) {
    throw new Error(`Telegram getFile failed for file_id: ${fileId}`);
  }

  const filePath = response.data.result.file_path;
  return {
    filePath,
    fileUrl: `${FILE_BASE_URL()}/${filePath}`,
  };
};

exports.streamFileToResponse = async ({
  fileId,
  filePath,
  res,
  wantsDownload = false,
  fileName = 'telegram-media',
}) => {
  let resolvedPath = filePath;

  if (!resolvedPath) {
    const fileInfo = await exports.getFileInfo(fileId);
    resolvedPath = fileInfo.filePath;
  }

  const response = await axios.get(`${FILE_BASE_URL()}/${resolvedPath}`, {
    responseType: 'stream',
    timeout: 5 * 60 * 1000,
  });

  res.status(response.status);
  if (response.headers['content-type']) {
    res.setHeader('Content-Type', response.headers['content-type']);
  }
  if (response.headers['content-length']) {
    res.setHeader('Content-Length', response.headers['content-length']);
  }
  res.setHeader(
    'Content-Disposition',
    `${wantsDownload ? 'attachment' : 'inline'}; filename="${fileName}"`
  );

  response.data.pipe(res);
};

async function sendMediaToChannel(media, channelId, options = {}) {
  const botToken = getBotToken();
  const resolvedChannelId = (channelId || '').trim();

  if (!resolvedChannelId || !botToken) {
    throw new Error('Telegram bot token or channel ID not configured');
  }

  logger.info(`TG | Sending ${media.type || media.media_type} to channel: ${resolvedChannelId}`);

  const caption = options.caption || buildCaption(media);
  const parseMode = options.parseMode === undefined ? 'Markdown' : options.parseMode;

  if (!media.file_path || !fs.existsSync(media.file_path)) {
    logger.warn(`TG | File not found at "${media.file_path}" - sending text message`);
    if (media.youtube_link) {
      return await exports.sendTextMessage(media, media.youtube_link, resolvedChannelId);
    }
    throw new Error(`File not found at path: ${media.file_path}`);
  }

  const mediaType = media.type || media.media_type;
  const typeMap = {
    video: { endpoint: 'sendVideo', field: 'video' },
    audio: { endpoint: 'sendAudio', field: 'audio' },
    photo: { endpoint: 'sendPhoto', field: 'photo' },
    document: { endpoint: 'sendDocument', field: 'document' },
  };

  const { endpoint, field } = typeMap[mediaType] || typeMap.photo;

  const formData = new FormData();
  formData.append('chat_id', resolvedChannelId);
  formData.append('caption', caption);
  if (parseMode) {
    formData.append('parse_mode', parseMode);
  }
  formData.append(field, fs.createReadStream(media.file_path));

  if (mediaType === 'video') {
    formData.append('supports_streaming', 'true');
  }

  const response = await axios.post(`${BASE_URL()}/${endpoint}`, formData, {
    headers: formData.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 5 * 60 * 1000,
  });

  if (!response.data?.ok) {
    throw new Error(`Telegram API error: ${response.data?.description || 'Unknown Telegram error'}`);
  }

  const result = response.data.result;
  const messageId = String(result.message_id);
  const fileMeta = extractUploadedFileMeta(result, mediaType);
  let filePath = null;

  if (fileMeta.fileId) {
    try {
      const fileInfo = await exports.getFileInfo(fileMeta.fileId);
      filePath = fileInfo.filePath;
    } catch (err) {
      logger.warn(`TG | Uploaded but failed to resolve file path: ${err.message}`);
    }
  }

  logger.info(`TG | Sent ${mediaType} - message_id: ${messageId}`);
  return {
    messageId,
    fileId: fileMeta.fileId || null,
    fileUniqueId: fileMeta.fileUniqueId || null,
    filePath,
  };
}

exports.sendMediaToChannel = sendMediaToChannel;
exports.getPhotoDumpChannelId = getPhotoDumpChannelId;

exports.sendMedia = async (media) => {
  return sendMediaToChannel(media, getChannelId());
};

exports.sendPhotoBundle = async (media) => {
  if ((media.type || media.media_type) !== 'photo') {
    throw new Error('sendPhotoBundle is only supported for photo uploads');
  }

  const mainResult = await sendMediaToChannel(
    media,
    getMainPhotoChannelId(),
  );

  const previewMedia = {
    ...media,
    file_path: media.preview_file_path,
  };

  if (!previewMedia.file_path || !fs.existsSync(previewMedia.file_path)) {
    throw new Error('Photo preview file not found for dump upload');
  }

  let previewResult;
  try {
    previewResult = await sendMediaToChannel(
      previewMedia,
      getPhotoDumpChannelId(),
      {
        caption: [
          'PHOTO PREVIEW DUMP',
          media.title ? `Title: ${media.title}` : null,
          `Media ID: ${media.id}`,
          '',
          'SHAREGRACE FAMLY CHURCH',
        ].filter(Boolean).join('\n'),
        parseMode: null,
      },
    );
  } catch (error) {
    error.mainResult = mainResult;
    throw error;
  }

  return {
    main: mainResult,
    preview: previewResult,
  };
};

exports.sendTextMessage = async (media, youtubeLink, channelOverride) => {
  const channelId = (channelOverride || getChannelId()).trim();
  const caption = buildCaption(media);
  const text = youtubeLink
    ? `${caption}\n\n[Watch on YouTube](${youtubeLink})`
    : caption;

  const response = await axios.post(`${BASE_URL()}/sendMessage`, {
    chat_id: channelId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: false,
  });

  if (!response.data?.ok) {
    throw new Error(`Telegram API error: ${response.data?.description || 'Unknown Telegram error'}`);
  }

  const messageId = String(response.data.result.message_id);
  logger.info(`TG | Sent text message - message_id: ${messageId}`);
  return { messageId };
};

exports.testConnection = async () => {
  const response = await axios.get(`${BASE_URL()}/getMe`);
  if (!response.data?.ok) {
    throw new Error('Bot token is invalid');
  }
  logger.info(`TG | Bot connected: @${response.data.result.username}`);
  return response.data.result;
};

