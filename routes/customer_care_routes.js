const express = require('express');
const router = express.Router();

const customerCareController = require('../controllers/customer_care_controller');
const { authMiddleware, adminMiddleware } = require('../middleware/auth_middleware');

router.post('/', authMiddleware, customerCareController.submitIssue);
router.get('/admin', adminMiddleware, customerCareController.getAdminList);
router.patch('/:id/attend', adminMiddleware, customerCareController.markAttended);

module.exports = router;

