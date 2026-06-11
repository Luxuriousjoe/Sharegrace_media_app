// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — YouTube Service
//  - Upload videos/audio to YouTube channel
//  - Fetch recent channel videos for home screen display
//  - Store fetched videos in DB for fast app access
// ═══════════════════════════════════════════════════════════════
const { google } = require('googleapis');
const fs         = require('fs');
const db         = require('../config/db_config');
const config     = require('../config/app_config');
const logger     = require('../utils/logger');

// ─── OAuth2 Client ────────────────────────────────────────────
const getOAuth2Client = () => {
  const oauth2Client = new google.auth.OAuth2(
    config.youtube.clientId,
    config.youtube.clientSecret,
    config.youtube.redirectUri || 'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: config.youtube.refreshToken });
  return oauth2Client;
};

// ─── Upload media to YouTube ──────────────────────────────────
exports.uploadMedia = async (media) => {
  const auth    = getOAuth2Client();
  const youtube = google.youtube({ version: 'v3', auth });

  const title = media.event_name
    ? `${media.event_name}${media.speaker_name ? ' — ' + media.speaker_name : ''}`
    : media.title || 'Grace Church Media';

  const description = [
    media.description   || '',
    media.speaker_name  ? `Speaker: ${media.speaker_name}`  : '',
    media.sermon_topic  ? `Topic: ${media.sermon_topic}`    : '',
    media.service_date  ? `Date: ${media.service_date}`     : '',
    '\n🙏 Share Grace Family Church',
    'Shared via Grace Church Media App',
  ].filter(Boolean).join('\n');

  const mimeType = media.type === 'video' ? 'video/mp4' : 'audio/mpeg';

  if (!media.file_path || !fs.existsSync(media.file_path)) {
    throw new Error(`File not found at path: ${media.file_path}`);
  }

  logger.info(`YT | Uploading: "${title}" (${media.type})`);

  const scheduledAt = media.youtube_schedule_at
    ? new Date(media.youtube_schedule_at)
    : null;
  const isScheduled =
    scheduledAt instanceof Date &&
    !Number.isNaN(scheduledAt.getTime()) &&
    scheduledAt.getTime() > Date.now();

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags:       ['church', 'sermon', 'worship', 'grace church', media.sermon_topic].filter(Boolean),
        categoryId: '22', // People & Blogs
      },
      status: {
        privacyStatus: isScheduled ? 'private' : 'public',
        ...(isScheduled ? { publishAt: scheduledAt.toISOString() } : {}),
      },
    },
    media: {
      mimeType,
      body: fs.createReadStream(media.file_path),
    },
  });

  const videoId = response.data.id;
  const link    = `https://www.youtube.com/watch?v=${videoId}`;
  logger.info(
    `YT | Upload success: ${link}${isScheduled ? ` | scheduled:${scheduledAt.toISOString()}` : ''}`
  );
  return { videoId, link };
};

// ─── Fetch recent videos from the channel ────────────────────
// Called by cron every 30 minutes + on demand
exports.fetchChannelVideos = async () => {
  logger.info('YT | Fetching recent channel videos...');

  if (!config.youtube.clientId || !config.youtube.refreshToken) {
    logger.warn('YT | YouTube credentials not configured — skipping fetch');
    return [];
  }

  const auth    = getOAuth2Client();
  const youtube = google.youtube({ version: 'v3', auth });

  // Step 1: Search channel for recent uploads
  const searchRes = await youtube.search.list({
    part:       ['snippet'],
    channelId:  config.youtube.channelId,
    maxResults: 20,
    order:      'date',
    type:       ['video'],
  });

  const items = searchRes.data.items || [];
  if (!items.length) {
    logger.info('YT | No videos found on channel');
    return [];
  }

  const videoIds = items.map(i => i.id.videoId).filter(Boolean);

  // Step 2: Get details (duration, views) for each video
  const detailsRes = await youtube.videos.list({
    part: ['snippet', 'contentDetails', 'statistics'],
    id:   videoIds,
  });

  const videos = (detailsRes.data.items || []).map(v => ({
    video_id:      v.id,
    title:         v.snippet.title,
    description:   v.snippet.description?.substring(0, 500) || '',
    thumbnail_url: v.snippet.thumbnails?.high?.url
                || v.snippet.thumbnails?.medium?.url
                || v.snippet.thumbnails?.default?.url || '',
    published_at:  v.snippet.publishedAt
                ? new Date(v.snippet.publishedAt).toISOString().slice(0, 19).replace('T', ' ')
                : null,
    duration:      v.contentDetails?.duration || '',
    view_count:    parseInt(v.statistics?.viewCount || '0'),
    youtube_url:   `https://www.youtube.com/watch?v=${v.id}`,
  }));

  // Step 3: Upsert into DB
  for (const v of videos) {
    await db.promise().query(
      `INSERT INTO youtube_channel_videos
         (video_id, title, description, thumbnail_url, published_at, duration, view_count, youtube_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         title=VALUES(title), description=VALUES(description),
         thumbnail_url=VALUES(thumbnail_url), view_count=VALUES(view_count),
         updated_at=NOW()`,
      [v.video_id, v.title, v.description, v.thumbnail_url,
       v.published_at, v.duration, v.view_count, v.youtube_url]
    );
  }

  logger.info(`YT | Cached ${videos.length} channel videos in DB`);
  return videos;
};

// ─── Get cached channel videos from DB ───────────────────────
exports.getCachedChannelVideos = async (limit = 20) => {
  const [rows] = await db.promise().query(
    `SELECT * FROM youtube_channel_videos
     ORDER BY published_at DESC LIMIT ?`,
    [limit]
  );
  return rows;
};

// ─── Get OAuth access token (for Flutter direct upload) ──────
exports.getAccessToken = async () => {
  const auth = getOAuth2Client();
  const { token } = await auth.getAccessToken();
  return token;
};
