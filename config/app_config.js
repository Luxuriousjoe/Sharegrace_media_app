// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — App Config
// ═══════════════════════════════════════════════════════════════
module.exports = {
  app: {
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  },
  youtube: {
    clientId:     process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri:  process.env.YOUTUBE_REDIRECT_URI,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    channelId:    process.env.YOUTUBE_CHANNEL_ID,
  },
  telegram: {
    botToken:  process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_MAIN_PHOTO_CHANNEL_ID || '-1003509207720',
    mainPhotoChannelId: process.env.TELEGRAM_MAIN_PHOTO_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID || '-1003509207720',
    photoDumpChannelId: process.env.TELEGRAM_PHOTO_DUMP_CHANNEL_ID || '-1003741514843',
    homeBannerChannelId: process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID || '-1003741514843',
    eventAdChannelId:
      process.env.TELEGRAM_EVENT_AD_CHANNEL_ID ||
      process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID ||
      '-1003741514843',
    appReleaseChannelId:
      process.env.TELEGRAM_APP_RELEASE_CHANNEL_ID ||
      process.env.TELEGRAM_HOME_BANNER_CHANNEL_ID ||
      '-1003741514843',
  },
  jwt: {
    secret:         process.env.JWT_SECRET       || 'grace_fallback_secret_change_in_prod',
    expiresIn:      process.env.JWT_EXPIRES_IN   || '7d',
    refreshSecret:  process.env.JWT_REFRESH_SECRET  || 'grace_fallback_refresh_change_in_prod',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  },
  upload: {
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 4096,
  },
  appRelease: {
    maxFileSizeMB:
      parseInt(process.env.APP_RELEASE_MAX_FILE_SIZE_MB) ||
      parseInt(process.env.MAX_FILE_SIZE_MB) ||
      4096,
  },
  googleDrive: {
    enabled: (process.env.GOOGLE_DRIVE_ENABLED || '').toLowerCase() === 'true',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    serviceAccountJson: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountPath: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH || '',
  },
};
