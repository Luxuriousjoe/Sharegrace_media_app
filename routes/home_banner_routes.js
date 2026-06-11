const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload_middleware');
const authGuards = require('../middleware/auth_middleware');
const authMiddleware =
  authGuards.authMiddleware || ((req, res, next) => next());
const homeBannerAdminMiddleware =
  authGuards.homeBannerAdminMiddleware ||
  authGuards.adminMiddleware ||
  authMiddleware;
let homeBannerController;

try {
  homeBannerController = require('../controllers/home_banner_controller');
} catch (error) {
  const unavailable = (req, res) =>
    res.status(503).json({
      success: false,
      message: 'Home banner feature is temporarily unavailable on this deployment.',
      detail: error.message,
    });
  homeBannerController = {
    getAll: unavailable,
    getAdminList: unavailable,
    streamFile: unavailable,
    upload: unavailable,
    toggle: unavailable,
    remove: unavailable,
  };
}

const ensureHandler = (handler) =>
  typeof handler === 'function'
    ? handler
    : (req, res) =>
        res.status(503).json({
          success: false,
          message: 'Home banner route handler unavailable on this deployment.',
        });

router.get('/', authMiddleware, ensureHandler(homeBannerController.getAll));
router.get(
  '/admin',
  homeBannerAdminMiddleware,
  ensureHandler(homeBannerController.getAdminList)
);
router.get('/:id/file', ensureHandler(homeBannerController.streamFile));
router.post(
  '/',
  homeBannerAdminMiddleware,
  upload.single('file'),
  ensureHandler(homeBannerController.upload)
);
router.patch(
  '/:id/toggle',
  homeBannerAdminMiddleware,
  ensureHandler(homeBannerController.toggle)
);
router.delete(
  '/:id',
  homeBannerAdminMiddleware,
  ensureHandler(homeBannerController.remove)
);

module.exports = router;
