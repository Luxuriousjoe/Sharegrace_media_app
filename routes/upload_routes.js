const express          = require('express');
const router           = express.Router();
const uploadController = require('../controllers/upload_controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth_middleware');

// ── Upload queue (admin only) ──────────────────────────────────
router.get('/',                   adminMiddleware, uploadController.getUploadQueue);
router.patch('/:mediaId/status',  adminMiddleware, uploadController.updateUploadStatus);
router.post('/:mediaId/trigger',  adminMiddleware, uploadController.triggerUpload);

// ── YouTube channel videos (all authenticated users) ───────────
router.get('/channel-videos',     authMiddleware,  uploadController.getChannelVideos);
router.post('/channel-videos/refresh', adminMiddleware, uploadController.refreshChannelVideos);

// ── Saved videos (all authenticated users) ─────────────────────
router.get('/saved',              authMiddleware,  uploadController.getSavedVideos);
router.post('/saved',             authMiddleware,  uploadController.saveVideo);
router.delete('/saved',           authMiddleware,  uploadController.unsaveVideo);

module.exports = router;
