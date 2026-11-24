const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { validateCsrfDoubleSubmit, doubleCsrfProtection } = require('../middlewares/csrf.middleware');
const csrfProtection = [validateCsrfDoubleSubmit, doubleCsrfProtection];

const rateLimitResponse = (_req, res) => res.status(429).json({
  success: false,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many authentication attempts. Please try again later.',
});
const sendOtpRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitResponse });
const verifyOtpRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitResponse });
const loginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitResponse });
const refreshRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitResponse });
const googleAuthRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitResponse });
const router = express.Router();
const {sendOTP, verifyOTP, login, rotateRefreshToken, verifyGoogleIdToken} = require('../controllers/auth.controller');

router.post("/send-otp", sendOtpRateLimit, ...csrfProtection, sendOTP);
router.post("/verify-otp", verifyOtpRateLimit, ...csrfProtection, verifyOTP);
router.post("/login", loginRateLimit, ...csrfProtection, login);
router.post("/refresh", refreshRateLimit, ...csrfProtection, rotateRefreshToken);
router.post("/google-auth", googleAuthRateLimit, ...csrfProtection, verifyGoogleIdToken);
module.exports = router;