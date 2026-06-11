const express = require('express');
const router = express.Router();

const appReleaseController = require('../controllers/app_release_controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth_middleware');
const uploadAppRelease = require('../middleware/upload_app_release_middleware');

router.get('/latest', authMiddleware, appReleaseController.getLatest);
router.get('/latest/download', appReleaseController.downloadLatest);
router.get('/admin', adminMiddleware, appReleaseController.getAdminList);
router.post('/', adminMiddleware, uploadAppRelease.single('file'), appReleaseController.create);

module.exports = router;
