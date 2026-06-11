const express = require('express');
const router = express.Router();

const mediaController = require('../controllers/media_controller');
const authGuards = require('../middleware/auth_middleware');
const authMiddleware = authGuards.authMiddleware;
const adminMiddleware = authGuards.adminMiddleware;
const mediaUploadMiddleware =
  authGuards.mediaUploadMiddleware || authGuards.adminMiddleware;
const upload = require('../middleware/upload_middleware');

router.get('/', authMiddleware, mediaController.getAllMedia);
router.get('/queue/admin', adminMiddleware, mediaController.getAdminQueue);
router.get('/:id/preview', authMiddleware, mediaController.streamPhotoPreview);
router.get('/:id/file', authMiddleware, mediaController.streamMediaFile);
router.get('/:id', authMiddleware, mediaController.getMediaById);
router.post('/:id/visit', authMiddleware, mediaController.recordVisit);
router.post('/:id/youtube-watch', authMiddleware, mediaController.recordYouTubeWatch);

router.post(
  '/',
  mediaUploadMiddleware,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  mediaController.createMedia
);
router.put('/:id', mediaUploadMiddleware, mediaController.updateMedia);
router.delete('/:id', mediaUploadMiddleware, mediaController.deleteMedia);
router.patch('/:id/thumbnail', mediaUploadMiddleware, mediaController.updateThumbnail);

module.exports = router;
