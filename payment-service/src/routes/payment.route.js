const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { internalAuth } = require('../middlewares/internalAuth.middleware');
const {
     createPaymentOrder,
     getPaymentOrder,
     verifyAndCapturePayment,
     initiateRefund,
} = require('../controllers/payment.controller');

const router = express.Router();
const paymentCreateRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const paymentReadRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });
const paymentVerifyRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const paymentRefundRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

// Internal routes (called by booking-service)
router.post('/orders', paymentCreateRateLimit, internalAuth, createPaymentOrder);
router.get('/orders/:paymentOrderId', paymentReadRateLimit, internalAuth, getPaymentOrder);
router.post('/orders/:paymentOrderId/verify', paymentVerifyRateLimit, internalAuth, verifyAndCapturePayment);
router.post('/refunds', paymentRefundRateLimit, internalAuth, initiateRefund);

module.exports = router;
