const express = require('express');
const router = express.Router();
const timelyReflectionController = require('../controllers/timely_reflection_controller');
const { authMiddleware, timelyReflectionAdminMiddleware } = require('../middleware/auth_middleware');

router.get('/', authMiddleware, timelyReflectionController.getAll);
router.get('/current', authMiddleware, timelyReflectionController.getCurrent);
router.post('/', timelyReflectionAdminMiddleware, timelyReflectionController.create);
router.delete('/:id', timelyReflectionAdminMiddleware, timelyReflectionController.remove);

module.exports = router;
