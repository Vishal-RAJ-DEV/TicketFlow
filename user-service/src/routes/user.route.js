const express = require('express');
const { validateCsrfDoubleSubmit, doubleCsrfProtection } = require('../middlewares/csrf.middleware');
const csrfProtection = [validateCsrfDoubleSubmit, doubleCsrfProtection];
const {getUserContext} = require('../middlewares/getUserContext.middleware');
const { internalAuth } = require('../middlewares/internalAuth.middleware');
const { getProfile, updateProfile, deleteProfile, getUserInternal } = require('../controllers/user.controller');

const router = express.Router();

router.get("/profile", getUserContext, getProfile);
router.put("/profile", ...csrfProtection, getUserContext, updateProfile);
router.delete("/profile", ...csrfProtection, getUserContext, deleteProfile);

router.get("/internal/:userId", internalAuth, getUserInternal);

module.exports = router;