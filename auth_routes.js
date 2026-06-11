const db              = require('../config/db_config');
const youtubeService  = require('../services/youtube_service');
const telegramService = require('../services/telegram_service');
const logger          = require('../utils/logger');

exports.getUploadQueue = async (req, res, next) => {
  logger.info(`UPLOADS | getUploadQueue | by ${req.user?.email}`);
  try {
    const [rows] = await db.promise().query(
      `SELECT u.*, m.type, m.title, m.file_path, mm.event_name
       FROM uploads u JOIN media m ON u.media_id = m.id
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       ORDER BY u.created_at DESC LIMIT 100`
    );
    logger.db('SELECT', 'uploads', `returned ${rows.length} upload records`);
    return res.json({ success: true, data: rows });
  } catch (err) { logger.error('getUploadQueue error:', err.message); next(err); }
};

exports.updateUploadStatus = async (req, res, next) => {
  const { mediaId } = req.params;
  const { platform, upload_status, telegram_msg_id, youtube_link, youtube_video_id, error_message } = req.body;
  logger.info(`UPLOADS | updateStatus | media:${mediaId} platform:${platform} status:${upload_status}`);
  try {
    await db.promise().query(
      `UPDATE uploads SET upload_status=?,
        telegram_msg_id=COALESCE(?,telegram_msg_id),
        youtube_link=COALESCE(?,youtube_link),
        youtube_video_id=COALESCE(?,youtube_video_id),
        error_message=COALESCE(?,error_message),
        upload_date=IF(?='success',NOW(),upload_date)
       WHERE media_id=? AND platform=?`,
      [upload_status, telegram_msg_id||null, youtube_link||null, youtube_video_id||null,
       error_message||null, upload_status, mediaId, platform]
    );
    const [uploads] = await db.promise().query('SELECT platform,upload_status FROM uploads WHERE media_id=?', [mediaId]);
    const allSuccess = uploads.every(u => u.upload_status === 'success');
    const anyFailed  = uploads.some(u => u.upload_status === 'failed');
    const newStatus  = allSuccess ? 'uploaded' : anyFailed ? 'failed' : 'uploading';
    await db.promise().query('UPDATE media SET status=? WHERE id=?', [newStatus, mediaId]);
    logger.media('STATUS_UPD', platform, mediaId, `→ ${upload_status} | media status → ${newStatus}`);
    return res.json({ success: true, message: 'Upload status updated' });
  } catch (err) { logger.error('updateUploadStatus error:', err.message); next(err); }
};

exports.triggerUpload = async (req, res, next) => {
  const { mediaId } = req.params;
  logger.media('TRIGGER', '?', mediaId, `upload triggered by ${req.user?.email}`);
  try {
    const [mediaRows] = await db.promise().query(
      `SELECT m.*, mm.event_name, mm.description, mm.speaker_name, mm.sermon_topic, mm.service_date
       FROM media m LEFT JOIN media_metadata mm ON m.id = mm.media_id WHERE m.id=?`, [mediaId]
    );
    if (!mediaRows.length) return res.status(404).json({ success: false, message: 'Media not found' });
    const media = mediaRows[0];

    // Respond immediately — uploads are async
    res.json({ success: true, message: 'Upload triggered', data: { mediaId } });

    await db.promise().query('UPDATE media SET status="uploading" WHERE id=?', [mediaId]);
    logger.media('UPLOADING', media.type, mediaId, 'status set to uploading');

    try {
      if (media.type !== 'photo') {
        logger.media('YT_START', media.type, mediaId, 'starting YouTube upload...');
        const ytResult = await youtubeService.uploadMedia(media);
        await db.promise().query(
          `UPDATE uploads SET upload_status='success', youtube_link=?, youtube_video_id=?, upload_date=NOW()
           WHERE media_id=? AND platform='youtube'`,
          [ytResult.link, ytResult.videoId, mediaId]
        );
        logger.media('YT_DONE', media.type, mediaId, `link:${ytResult.link}`);
      }

      logger.media('TG_START', media.type, mediaId, 'starting Telegram upload...');
      const tgResult = await telegramService.sendMedia(media);
      await db.promise().query(
        `UPDATE uploads SET upload_status='success', telegram_msg_id=?, upload_date=NOW()
         WHERE media_id=? AND platform='telegram'`,
        [tgResult.messageId, mediaId]
      );
      logger.media('TG_DONE', media.type, mediaId, `msg_id:${tgResult.messageId}`);

      await db.promise().query('UPDATE media SET status="uploaded" WHERE id=?', [mediaId]);
      logger.media('COMPLETE', media.type, mediaId, 'all platforms uploaded successfully');
    } catch (uploadErr) {
      logger.error(`UPLOAD_FAIL | media:${mediaId} | ${uploadErr.message}`);
      await db.promise().query('UPDATE media SET status="failed" WHERE id=?', [mediaId]);
    }
  } catch (err) { logger.error('triggerUpload error:', err.message); next(err); }
};

exports.retryFailedUploads = async () => {
  logger.info('CRON | Scanning for failed uploads...');
  try {
    const [failedUploads] = await db.promise().query(
      `SELECT u.*, m.file_path, m.type, m.title, mm.event_name, mm.description, mm.speaker_name
       FROM uploads u JOIN media m ON u.media_id = m.id
       LEFT JOIN media_metadata mm ON m.id = mm.media_id
       WHERE u.upload_status='failed' AND u.retry_count < 3`
    );
    if (!failedUploads.length) {
      logger.info('CRON | No failed uploads to retry');
      return;
    }
    logger.info(`CRON | Found ${failedUploads.length} failed upload(s) to retry`);
    for (const upload of failedUploads) {
      logger.media('RETRY', upload.type||'?', upload.media_id, `platform:${upload.platform} attempt:${upload.retry_count+1}`);
      await db.promise().query(
        'UPDATE uploads SET upload_status="in_progress", retry_count=retry_count+1 WHERE id=?', [upload.id]
      );
      try {
        if (upload.platform === 'youtube' && upload.type !== 'photo') {
          const ytResult = await youtubeService.uploadMedia(upload);
          await db.promise().query(
            `UPDATE uploads SET upload_status='success', youtube_link=?, youtube_video_id=?, upload_date=NOW() WHERE id=?`,
            [ytResult.link, ytResult.videoId, upload.id]
          );
          logger.media('RETRY_OK', 'youtube', upload.media_id, ytResult.link);
        } else if (upload.platform === 'telegram') {
          const tgResult = await telegramService.sendMedia(upload);
          await db.promise().query(
            `UPDATE uploads SET upload_status='success', telegram_msg_id=?, upload_date=NOW() WHERE id=?`,
            [tgResult.messageId, upload.id]
          );
          logger.media('RETRY_OK', 'telegram', upload.media_id, `msg:${tgResult.messageId}`);
        }
      } catch (err) {
        await db.promise().query(
          'UPDATE uploads SET upload_status="failed", error_message=? WHERE id=?',
          [err.message, upload.id]
        );
        logger.error(`RETRY_FAIL | upload:${upload.id} | ${err.message}`);
      }
    }
  } catch (err) { logger.error('retryFailedUploads error:', err.message); }
};
