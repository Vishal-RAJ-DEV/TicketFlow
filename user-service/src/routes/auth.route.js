const express = require('express');
const { validateCsrfDoubleSubmit, doubleCsrfProtection } = require('../middlewares/csrf.middleware');
const csrfProtection = [validateCsrfDoubleSubmit, doubleCsrfProtection];
const router = express.Router();
const {sendOTP, verifyOTP, login, rotateRefreshToken, verifyGoogleIdToken} = require('../controllers/auth.controller');

router.post("/send-otp", ...csrfProtection, sendOTP);
router.post("/verify-otp", ...csrfProtection, verifyOTP);
router.post("/login", ...csrfProtection, login);
router.post("/refresh", ...csrfProtection, rotateRefreshToken);
router.post("/google-auth", ...csrfProtection, verifyGoogleIdToken);
module.exports = router;