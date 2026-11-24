const express = require('express');
const controller = require('../controllers/ops.controller');
const { requireOpsToken, requireMetricsToken } = require('../middlewares/opsAuth.middleware');
const router = express.Router();

router.get('/metrics', requireMetricsToken, controller.metrics);
router.get('/ops/outbox', requireOpsToken, controller.getOutboxStatus);
router.get('/ops/outbox/dead-letters', requireOpsToken, controller.listDeadLetters);
router.post('/ops/outbox/dead-letters/:eventId/retry', requireOpsToken, controller.retryDeadLetter);

module.exports = router;
