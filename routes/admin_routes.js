const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin_controller');
const { adminMiddleware } = require('../middleware/auth_middleware');
const updateUserPermissionsHandler =
  adminController.updateUserPermissions || adminController.updateUser;

router.get('/users', adminMiddleware, adminController.getAllUsers);
router.post('/users', adminMiddleware, adminController.createUser);
router.post('/admins', adminMiddleware, adminController.createAdmin);
router.patch('/users/:id/toggle', adminMiddleware, adminController.toggleUser);
router.put('/users/:id', adminMiddleware, adminController.updateUser);
router.patch('/users/:id/permissions', adminMiddleware, updateUserPermissionsHandler);
router.delete('/users/:id', adminMiddleware, adminController.deleteUser);
router.put('/users/:id/password', adminMiddleware, adminController.changeUserPassword);
router.get('/logs', adminMiddleware, adminController.getLogs);
router.get('/stats', adminMiddleware, adminController.getDashboardStats);

module.exports = router;
