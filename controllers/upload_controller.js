// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Upload Controller
//  Handles: queue display, upload triggering, retry, saved videos,
//           YouTube channel video caching
// ═══════════════════════════════════════════════════════════════
const db = require('../config/db_config');
const youtubeService = require('../services/youtube_service');
const telegramService = require('../services/telegram_service');
const logger = require('../utils/logger');
const photoPreviewService = require('../services/photo_preview_service');

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

async function buildMediaMetadataSelect(prefix = 'mm') {
  const columns = await getMediaMetadataColumns();
  const pick = (column) =>
    columns.has(column) ? `${prefix}.${column}` : `NULL AS ${column}`;

  return [
    pick('event_name'),
    pick('description'),
    pick('speaker_name'),
    pick('sermon_topic'),
    pick('service_date'),
    pick('location'),
    pick('content_category'),
    pick('upload_to_telegram'),
    pick('upload_to_youtube'),
    pick('youtube_schedule_at'),
  ].join(',\n            ');
}

// ─── Internal helper: process one media upload ────────────────
async function triggerUploadByMediaId(mediaId, actor = 'system') {
  logger.media('TRIGGER', '?', mediaId, `by ${actor}`);
  const metadataSelect = await buildMediaMetadataSelect();

  const [mediaRows] = await db.promise().query(
    `SELECT m.*, ${metadataSelect}
     FROM media m
     LEFT JOIN media_metadata mm ON m.id = mm.media_id
     WHERE m.id = ?`,
    [mediaId]
  );

  if (!mediaRows.length) {
    throw new Error(`Media not found: ${mediaId}`);
  }

  const media = mediaRows[0];
  logger.info(`TRIGGER | Found media: type=${media.type} title=${media.title} path=${media.file_path}`);

  const mediaType = media.type;
  const [uploadRows] = await db.promise().query(
    `SELECT platform, upload_status, youtube_link, youtube_video_id, telegram_msg_id
     FROM uploads
     WHERE media_id = ?`,
    [mediaId]
  );

  const uploadByPlatform = Object.fromEntries(
    uploadRows.map((row) => [row.platform, row])
  );
  const pendingPlatforms = uploadRows
    .filter((row) => row.upload_status === 'pending' || row.upload_status === 'failed')
    .map((row) => row.platform);
  const hasInProgress = uploadRows.some((row) => row.upload_status === 'in_progress');
  const allSuccessBeforeStart =
    uploadRows.length > 0 && uploadRows.every((row) => row.upload_status === 'success');

  if (allSuccessBeforeStart) {
    logger.media('SKIP', mediaType, mediaId, 'all platform uploads already succeeded');
    await db.promise().query(
      "UPDATE media SET status = 'uploaded' WHERE id = ?",
      [mediaId]
    );

    return {
      success: true,
      mediaId,
      finalStatus: 'uploaded',
      skipped: true,
    };
  }

  if (hasInProgress && pendingPlatforms.length === 0) {
    logger.media('SKIP', mediaType, mediaId, 'upload already in progress');
    return {
      success: true,
      mediaId,
      finalStatus: 'uploading',
      skipped: true,
    };
  }

  const shouldUploadYouTube = mediaType === 'video' && pendingPlatforms.includes('youtube');
  const shouldMarkSkippedYouTubeSuccess =
    mediaType !== 'video' && pendingPlatforms.includes('youtube');
  const shouldUploadTelegram = pendingPlatforms.includes('telegram');

  await db.promise().query(
    "UPDATE media SET status = 'uploading' WHERE id = ?",
    [mediaId]
  );

  if (shouldUploadYouTube || shouldMarkSkippedYouTubeSuccess) {
    await db.promise().query(
      `UPDATE uploads
       SET upload_status = 'in_progress',
           error_message = NULL
       WHERE media_id = ? AND platform = 'youtube'`,
      [mediaId]
    );
  }

  if (shouldUploadTelegram) {
    await db.promise().query(
      `UPDATE uploads
       SET upload_status = 'in_progress',
           error_message = NULL
       WHERE media_id = ? AND platform = 'telegram'`,
      [mediaId]
    );
  }

  let youtubeLink = null;
  let youtubeVideoId = null;
  let telegramMsgId = null;
  let ytError = null;
  let tgError = null;
  const mediaColumns = await getMediaColumns();
  const hasPreviewUploadStatus = mediaColumns.has('preview_upload_status');
  const hasPreviewFilePath = mediaColumns.has('preview_file_path');
  const hasPreviewTelegramMsgId = mediaColumns.has('preview_telegram_msg_id');
  const hasPreviewTelegramFileId = mediaColumns.has('preview_telegram_file_id');
  const hasPreviewTelegramFileUniqueId = mediaColumns.has('preview_telegram_file_unique_id');
  const hasPreviewTelegramFilePath = mediaColumns.has('preview_telegram_file_path');
  const hasPreviewErrorMessage = mediaColumns.has('preview_error_message');

  // ── YouTube Upload (videos and audio only) ────────────────
  if (shouldUploadYouTube) {
    try {
      logger.media('YT_START', mediaType, mediaId, 'uploading to YouTube...');
      const ytResult = await youtubeService.uploadMedia(media);
      youtubeLink = ytResult.link;
      youtubeVideoId = ytResult.videoId;

      await db.promise().query(
        `UPDATE uploads
         SET upload_status = 'success',
             youtube_link = ?,
             youtube_video_id = ?,
             upload_date = NOW(),
             error_message = NULL
         WHERE media_id = ? AND platform = 'youtube'`,
        [youtubeLink, youtubeVideoId, mediaId]
      );

      const thumbUrl = `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`;
      await db.promise().query(
        'UPDATE media SET thumbnail_url = ? WHERE id = ?',
        [thumbUrl, mediaId]
      );

      logger.media('YT_DONE', mediaType, mediaId, youtubeLink);
    } catch (err) {
      ytError = err.message;
      logger.error(`YT_FAIL | media:${mediaId} | ${err.message}`);

      await db.promise().query(
        `UPDATE uploads
         SET upload_status = 'failed',
             error_message = ?
         WHERE media_id = ? AND platform = 'youtube'`,
        [err.message, mediaId]
      );
    }
  } else if (shouldMarkSkippedYouTubeSuccess) {
    // photos and audio skip YouTube by design
    await db.promise().query(
      `UPDATE uploads
       SET upload_status = 'success',
           upload_date = NOW(),
           error_message = NULL
       WHERE media_id = ? AND platform = 'youtube'`,
      [mediaId]
    );
  }

  // ── Telegram Upload (all types) ───────────────────────────
  if (shouldUploadTelegram) {
    try {
      logger.media('TG_START', mediaType, mediaId, 'sending to Telegram...');
      const existingYouTubeLink = shouldUploadYouTube
        ? youtubeLink
        : (uploadByPlatform.youtube?.youtube_link || null);
      const mediaWithLink = { ...media, youtube_link: existingYouTubeLink };
      let tgResult;

      if (mediaType === 'photo') {
        const previewPath = hasPreviewFilePath
          ? await photoPreviewService.ensurePhotoPreview({
              mediaId,
              sourcePath: media.file_path,
              existingPreviewPath: media.preview_file_path,
            })
          : await photoPreviewService.ensurePhotoPreview({
              mediaId,
              sourcePath: media.file_path,
              existingPreviewPath: null,
            });

        if (hasPreviewUploadStatus) {
          await db.promise().query(
            `UPDATE media
             SET preview_upload_status = 'in_progress'
             WHERE id = ?`,
            [mediaId]
          );
        }

        tgResult = await telegramService.sendPhotoBundle({
          ...mediaWithLink,
          preview_file_path: previewPath,
        });
        telegramMsgId = tgResult.main.messageId;

        const previewSetParts = [];
        const previewSetParams = [];
        if (hasPreviewFilePath) {
          previewSetParts.push('preview_file_path = ?');
          previewSetParams.push(previewPath);
        }
        if (hasPreviewUploadStatus) {
          previewSetParts.push("preview_upload_status = 'success'");
        }
        if (hasPreviewTelegramMsgId) {
          previewSetParts.push('preview_telegram_msg_id = ?');
          previewSetParams.push(tgResult.preview.messageId || null);
        }
        if (hasPreviewTelegramFileId) {
          previewSetParts.push('preview_telegram_file_id = ?');
          previewSetParams.push(tgResult.preview.fileId || null);
        }
        if (hasPreviewTelegramFileUniqueId) {
          previewSetParts.push('preview_telegram_file_unique_id = ?');
          previewSetParams.push(tgResult.preview.fileUniqueId || null);
        }
        if (hasPreviewTelegramFilePath) {
          previewSetParts.push('preview_telegram_file_path = ?');
          previewSetParams.push(tgResult.preview.filePath || null);
        }
        if (hasPreviewErrorMessage) {
          previewSetParts.push('preview_error_message = NULL');
        }

        if (previewSetParts.length) {
          await db.promise().query(
            `UPDATE media
             SET ${previewSetParts.join(', ')}
             WHERE id = ?`,
            [...previewSetParams, mediaId]
          );
        }
      } else {
        tgResult = await telegramService.sendMedia(mediaWithLink);
        telegramMsgId = tgResult.messageId;

        // Audio thumbnails are stored in the same Telegram picture dump channel.
        if (
          mediaType === 'audio' &&
          hasPreviewFilePath &&
          media.preview_file_path
        ) {
          if (hasPreviewUploadStatus) {
            await db.promise().query(
              `UPDATE media
               SET preview_upload_status = 'in_progress'
               WHERE id = ?`,
              [mediaId]
            );
          }

          try {
            const previewChannelId = telegramService.getPhotoDumpChannelId();
            const previewUpload = await telegramService.sendMediaToChannel(
              {
                ...mediaWithLink,
                type: 'photo',
                file_path: media.preview_file_path,
              },
              previewChannelId,
              {
                caption: [
                  'AUDIO THUMBNAIL STORAGE',
                  media.title ? `Title: ${media.title}` : null,
                  `Media ID: ${media.id}`,
                  '',
                  'SHAREGRACE FAMLY CHURCH',
                ].filter(Boolean).join('\n'),
                parseMode: null,
              },
            );

            const previewSetParts = [];
            const previewSetParams = [];
            if (hasPreviewUploadStatus) {
              previewSetParts.push("preview_upload_status = 'success'");
            }
            if (hasPreviewTelegramMsgId) {
              previewSetParts.push('preview_telegram_msg_id = ?');
              previewSetParams.push(previewUpload.messageId || null);
            }
            if (hasPreviewTelegramFileId) {
              previewSetParts.push('preview_telegram_file_id = ?');
              previewSetParams.push(previewUpload.fileId || null);
            }
            if (hasPreviewTelegramFileUniqueId) {
              previewSetParts.push('preview_telegram_file_unique_id = ?');
              previewSetParams.push(previewUpload.fileUniqueId || null);
            }
            if (hasPreviewTelegramFilePath) {
              previewSetParts.push('preview_telegram_file_path = ?');
              previewSetParams.push(previewUpload.filePath || null);
            }
            if (hasPreviewErrorMessage) {
              previewSetParts.push('preview_error_message = NULL');
            }

            if (previewSetParts.length) {
              await db.promise().query(
                `UPDATE media
                 SET ${previewSetParts.join(', ')}
                 WHERE id = ?`,
                [...previewSetParams, mediaId]
              );
            }
          } catch (previewError) {
            logger.warn(
              `TG_AUDIO_PREVIEW_FAIL | media:${mediaId} | ${previewError.message}`
            );
            if (hasPreviewUploadStatus) {
              const previewFailureSetParts = ["preview_upload_status = 'failed'"];
              const previewFailureParams = [];
              if (hasPreviewErrorMessage) {
                previewFailureSetParts.push('preview_error_message = ?');
                previewFailureParams.push(previewError.message);
              }
              await db.promise().query(
                `UPDATE media
                 SET ${previewFailureSetParts.join(', ')}
                 WHERE id = ?`,
                [...previewFailureParams, mediaId]
              ).catch(() => {});
            }
          }
        }
      }

      const uploadColumns = await getUploadsColumns();
      const hasTelegramFileId = uploadColumns.has('telegram_file_id');
      const hasTelegramFilePath = uploadColumns.has('telegram_file_path');
      const hasTelegramFileUniqueId = uploadColumns.has('telegram_file_unique_id');
      const setParts = [
        "upload_status = 'success'",
        'telegram_msg_id = ?',
        'upload_date = NOW()',
        'error_message = NULL',
      ];
      const setParams = [telegramMsgId];

      if (hasTelegramFileId) {
        setParts.push('telegram_file_id = ?');
        setParams.push(mediaType === 'photo'
          ? (tgResult.main.fileId || null)
          : (tgResult.fileId || null));
      }

      if (hasTelegramFilePath) {
        setParts.push('telegram_file_path = ?');
        setParams.push(mediaType === 'photo'
          ? (tgResult.main.filePath || null)
          : (tgResult.filePath || null));
      }

      if (hasTelegramFileUniqueId) {
        setParts.push('telegram_file_unique_id = ?');
        setParams.push(mediaType === 'photo'
          ? (tgResult.main.fileUniqueId || null)
          : (tgResult.fileUniqueId || null));
      }

      await db.promise().query(
        `UPDATE uploads
         SET ${setParts.join(', ')}
         WHERE media_id = ? AND platform = 'telegram'`,
        [...setParams, mediaId]
      );

      logger.media('TG_DONE', mediaType, mediaId, `msg_id:${telegramMsgId}`);
    } catch (err) {
      tgError = err.message;
      logger.error(`TG_FAIL | media:${mediaId} | ${err.message}`);

      if (mediaType === 'photo' && err.mainResult) {
        telegramMsgId = err.mainResult.messageId || telegramMsgId;
        try {
          const uploadColumns = await getUploadsColumns();
          const hasTelegramFileId = uploadColumns.has('telegram_file_id');
          const hasTelegramFilePath = uploadColumns.has('telegram_file_path');
          const hasTelegramFileUniqueId = uploadColumns.has('telegram_file_unique_id');
          const setParts = [
            'telegram_msg_id = ?',
          ];
          const setParams = [telegramMsgId];

          if (hasTelegramFileId) {
            setParts.push('telegram_file_id = ?');
            setParams.push(err.mainResult.fileId || null);
          }
          if (hasTelegramFilePath) {
            setParts.push('telegram_file_path = ?');
            setParams.push(err.mainResult.filePath || null);
          }
          if (hasTelegramFileUniqueId) {
            setParts.push('telegram_file_unique_id = ?');
            setParams.push(err.mainResult.fileUniqueId || null);
          }

          await db.promise().query(
            `UPDATE uploads
             SET ${setParts.join(', ')}
             WHERE media_id = ? AND platform = 'telegram'`,
            [...setParams, mediaId]
          );
        } catch (partialStoreError) {
          logger.warn(`TG_PARTIAL_STORE_FAIL | media:${mediaId} | ${partialStoreError.message}`);
        }

        if (mediaType === 'photo') {
          if (hasPreviewUploadStatus) {
            const previewFailureSetParts = ["preview_upload_status = 'failed'"];
            const previewFailureParams = [];
            if (hasPreviewErrorMessage) {
              previewFailureSetParts.push('preview_error_message = ?');
              previewFailureParams.push(err.message);
            }
            await db.promise().query(
              `UPDATE media
               SET ${previewFailureSetParts.join(', ')}
               WHERE id = ?`,
              [...previewFailureParams, mediaId]
            ).catch(() => {});
          }

          await db.promise().query(
            `UPDATE uploads
             SET upload_status = 'success',
                 upload_date = NOW(),
                 error_message = NULL
             WHERE media_id = ? AND platform = 'telegram'`,
            [mediaId]
          );

          await db.promise().query(
            "UPDATE media SET status = 'uploaded' WHERE id = ?",
            [mediaId]
          );

          logger.warn(`TG_PREVIEW_ONLY_FAIL | media:${mediaId} | main photo upload succeeded but preview dump failed`);
          tgError = null;
          return {
            success: true,
            mediaId,
            telegramMsgId,
            youtubeLink,
            youtubeVideoId,
            finalStatus: shouldUploadYouTube && ytError ? 'failed' : 'uploaded',
            previewFailed: true,
            previewError: err.message,
          };
        }
      }

      if (mediaType === 'photo' && hasPreviewUploadStatus) {
        const previewFailureSetParts = ["preview_upload_status = 'failed'"];
        const previewFailureParams = [];
        if (hasPreviewErrorMessage) {
          previewFailureSetParts.push('preview_error_message = ?');
          previewFailureParams.push(err.message);
        }
        await db.promise().query(
          `UPDATE media
           SET ${previewFailureSetParts.join(', ')}
           WHERE id = ?`,
          [...previewFailureParams, mediaId]
        ).catch(() => {});
      }

      await db.promise().query(
        `UPDATE uploads
         SET upload_status = 'failed',
             error_message = ?
         WHERE media_id = ? AND platform = 'telegram'`,
        [err.message, mediaId]
      );
    }
  }

  // ── Set final media status ────────────────────────────────
  const [uploads] = await db.promise().query(
    'SELECT platform, upload_status FROM uploads WHERE media_id = ?',
    [mediaId]
  );

  const allSuccess = uploads.every((u) => u.upload_status === 'success');
  const anyFailed = uploads.some((u) => u.upload_status === 'failed');

  const finalStatus = allSuccess
    ? 'uploaded'
    : anyFailed
      ? 'failed'
      : 'uploading';

  await db.promise().query(
    'UPDATE media SET status = ? WHERE id = ?',
    [finalStatus, mediaId]
  );

  logger.media('COMPLETE', mediaType, mediaId, `final status: ${finalStatus}`);

  if (!ytError && mediaType === 'video') {
    setTimeout(async () => {
      try {
        await youtubeService.fetchChannelVideos();
        logger.info('YT | Channel video cache refreshed after upload');
      } catch (e) {
        logger.warn(`YT | Cache refresh failed: ${e.message}`);
      }
    }, 10000);
  }

  return {
    success: true,
    mediaId,
    telegramMsgId,
    youtubeLink,
    youtubeVideoId,
    finalStatus,
  };
}

// ─── GET Upload Queue (with full media details) ───────────────
exports.getUploadQueue = async (req, res, next) => {
  logger.info(`UPLOADS | getUploadQueue | by ${req.user?.email}`);
  try {
    const metadataSelect = await buildMediaMetadataSelect();
    const [rows] = await db.promise().query(
      `SELECT
         u.id, u.media_id, u.platform, u.upload_status,
         u.telegram_msg_id, u.youtube_link, u.youtube_video_id,
         u.retry_count, u.error_message, u.upload_date,
         u.created_at,
         m.type, m.title, m.file_path, m.status AS media_status,
         m.thumbnail_url,
         ${metadataSelect}
       FROM uploads u
       JOIN media m ON u.media_id = m.id
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       ORDER BY u.created_at DESC
       LIMIT 100`
    );

    logger.db('SELECT', 'uploads', `returned ${rows.length} records`);
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('getUploadQueue error:', err.message);
    next(err);
  }
};

// ─── UPDATE Upload Status ─────────────────────────────────────
exports.updateUploadStatus = async (req, res, next) => {
  const { mediaId } = req.params;
  const {
    platform,
    upload_status,
    telegram_msg_id,
    youtube_link,
    youtube_video_id,
    error_message,
  } = req.body;

  logger.info(`UPLOADS | updateStatus | media:${mediaId} platform:${platform} → ${upload_status}`);

  try {
    await db.promise().query(
      `UPDATE uploads SET
         upload_status    = ?,
         telegram_msg_id  = COALESCE(?, telegram_msg_id),
         youtube_link     = COALESCE(?, youtube_link),
         youtube_video_id = COALESCE(?, youtube_video_id),
         error_message    = COALESCE(?, error_message),
         upload_date      = IF(? = 'success', NOW(), upload_date)
       WHERE media_id = ? AND platform = ?`,
      [
        upload_status,
        telegram_msg_id || null,
        youtube_link || null,
        youtube_video_id || null,
        error_message || null,
        upload_status,
        mediaId,
        platform,
      ]
    );

    const [uploads] = await db.promise().query(
      'SELECT platform, upload_status FROM uploads WHERE media_id = ?',
      [mediaId]
    );

    const allSuccess = uploads.every((u) => u.upload_status === 'success');
    const anyFailed = uploads.some((u) => u.upload_status === 'failed');
    const newStatus = allSuccess ? 'uploaded' : anyFailed ? 'failed' : 'uploading';

    await db.promise().query(
      'UPDATE media SET status = ? WHERE id = ?',
      [newStatus, mediaId]
    );

    logger.media('STATUS_UPD', platform, mediaId, `→ ${upload_status} | media → ${newStatus}`);
    return res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    logger.error('updateUploadStatus error:', err.message);
    next(err);
  }
};

// ─── TRIGGER Upload via HTTP route ────────────────────────────
exports.triggerUpload = async (req, res, next) => {
  const { mediaId } = req.params;

  try {
    res.json({
      success: true,
      message: 'Upload started',
      data: { mediaId: Number(mediaId) },
    });

    setImmediate(async () => {
      try {
        await triggerUploadByMediaId(mediaId, req.user?.email || 'route');
      } catch (err) {
        logger.error(`triggerUpload background error | media:${mediaId} | ${err.message}`);
        await db.promise().query(
          "UPDATE media SET status = 'failed' WHERE id = ?",
          [mediaId]
        ).catch(() => {});
      }
    });
  } catch (err) {
    logger.error('triggerUpload error:', err.message);
    next(err);
  }
};

// ─── RETRY Failed Uploads (cron) ─────────────────────────────
exports.retryFailedUploads = async () => {
  logger.info('CRON | Checking for failed uploads...');
  try {
    const [failedMediaRows] = await db.promise().query(
      `SELECT DISTINCT media_id
       FROM uploads
       WHERE upload_status = 'failed' AND retry_count < 3`
    );

    if (!failedMediaRows.length) {
      logger.info('CRON | No failed uploads');
      return;
    }

    logger.info(`CRON | Retrying ${failedMediaRows.length} failed media item(s)`);

    for (const row of failedMediaRows) {
      try {
        await db.promise().query(
          "UPDATE uploads SET retry_count = retry_count + 1 WHERE media_id = ? AND upload_status = 'failed'",
          [row.media_id]
        );

        await triggerUploadByMediaId(row.media_id, 'retry-cron');
      } catch (err) {
        logger.error(`RETRY_FAIL | media:${row.media_id} | ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('retryFailedUploads:', err.message);
  }
};

// ─── GET YouTube Channel Videos (for home screen) ────────────
exports.getChannelVideos = async (req, res, next) => {
  logger.info('UPLOADS | getChannelVideos');
  try {
    const videos = await youtubeService.getCachedChannelVideos(20);
    return res.json({ success: true, data: videos });
  } catch (err) {
    logger.error('getChannelVideos error:', err.message);
    next(err);
  }
};

// ─── REFRESH YouTube Channel Videos (admin trigger) ──────────
exports.refreshChannelVideos = async (req, res, next) => {
  logger.info(`UPLOADS | refreshChannelVideos | by ${req.user?.email}`);
  try {
    const videos = await youtubeService.fetchChannelVideos();
    return res.json({
      success: true,
      message: `Fetched ${videos.length} videos`,
      data: videos,
    });
  } catch (err) {
    logger.error('refreshChannelVideos error:', err.message);
    next(err);
  }
};

// ─── SAVE Video for later (user action) ──────────────────────
exports.saveVideo = async (req, res, next) => {
  const userId = req.user.id;
  const { media_id, video_id, title, thumbnail_url, youtube_url } = req.body;
  logger.info(`UPLOADS | saveVideo | user:${userId} media:${media_id} ytVid:${video_id}`);

  try {
    if (!media_id && !video_id) {
      return res.status(400).json({ success: false, message: 'media_id or video_id required' });
    }

    await db.promise().query(
      `INSERT INTO saved_videos (user_id, media_id, video_id, title, thumbnail_url, youtube_url)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE saved_at = NOW()`,
      [
        userId,
        media_id || null,
        video_id || null,
        title || null,
        thumbnail_url || null,
        youtube_url || null,
      ]
    );

    logger.info(`UPLOADS | Video saved for user:${userId}`);
    return res.json({ success: true, message: 'Saved for later' });
  } catch (err) {
    logger.error('saveVideo error:', err.message);
    next(err);
  }
};

// ─── UNSAVE Video ─────────────────────────────────────────────
exports.unsaveVideo = async (req, res, next) => {
  const userId = req.user.id;
  const { media_id, video_id } = req.body;

  try {
    if (media_id) {
      await db.promise().query(
        'DELETE FROM saved_videos WHERE user_id = ? AND media_id = ?',
        [userId, media_id]
      );
    } else if (video_id) {
      await db.promise().query(
        'DELETE FROM saved_videos WHERE user_id = ? AND video_id = ?',
        [userId, video_id]
      );
    }

    return res.json({ success: true, message: 'Removed from saved' });
  } catch (err) {
    logger.error('unsaveVideo error:', err.message);
    next(err);
  }
};

// ─── GET Saved Videos for user ────────────────────────────────
exports.getSavedVideos = async (req, res, next) => {
  const userId = req.user.id;
  logger.info(`UPLOADS | getSavedVideos | user:${userId}`);

  try {
    const metadataSelect = await buildMediaMetadataSelect('mm');
    const [rows] = await db.promise().query(
      `SELECT sv.*, m.type, m.status AS media_status,
              up.youtube_link, up.telegram_msg_id,
              ${metadataSelect}
       FROM saved_videos sv
       LEFT JOIN media m ON sv.media_id = m.id
       LEFT JOIN uploads up ON m.id = up.media_id AND up.platform = 'youtube'
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       WHERE sv.user_id = ?
       ORDER BY sv.saved_at DESC`,
      [userId]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('getSavedVideos error:', err.message);
    next(err);
  }
};

module.exports.triggerUploadByMediaId = triggerUploadByMediaId;
