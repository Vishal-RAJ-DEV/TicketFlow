const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { validateCsrfDoubleSubmit, doubleCsrfProtection } = require('../middlewares/csrf.middleware');
const csrfProtection = [validateCsrfDoubleSubmit, doubleCsrfProtection];
const {getUserContext} = require('../middlewares/getUserContext.middleware');
const { internalAuth } = require('../middlewares/internalAuth.middleware');
const { getProfile, updateProfile, deleteProfile, getUserInternal } = require('../controllers/user.controller');

const router = express.Router();
const userApiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });
const internalApiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });

router.get("/profile", userApiRateLimit, getUserContext, getProfile);
router.put("/profile", userApiRateLimit, ...csrfProtection, getUserContext, updateProfile);
router.delete("/profile", userApiRateLimit, ...csrfProtection, getUserContext, deleteProfile);

router.get("/internal/:userId", internalApiRateLimit, internalAuth, getUserInternal);

module.exports = router;