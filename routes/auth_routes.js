// ─── auth_routes.js ───────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth_controller');
const deviceTokenController = require('../controllers/device_token_controller');
const { authMiddleware } = require('../middleware/auth_middleware');

router.post('/login', authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);
router.get('/me', authMiddleware, authController.getMe);
router.put('/change-password', authMiddleware, authController.changePassword);
router.post('/device-token', authMiddleware, deviceTokenController.register);
router.delete('/device-token', authMiddleware, deviceTokenController.unregister);

module.exports = router;
