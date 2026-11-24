const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getUserContext } = require('../middlewares/getUserContext.middleware');
const {
     createBooking,
     getBooking,
     getUserBookings,
     cancelBooking,
     verifyPayment,
} = require('../controllers/booking.controller');

const router = express.Router();
const bookingRateLimitKey = (req) => {
     const userId = req.headers['x-user-id'];
     return userId ? 'user:' + String(userId) : ipKeyGenerator(req.ip);
};
const bookingCreateRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 5, keyGenerator: bookingRateLimitKey, standardHeaders: 'draft-8', legacyHeaders: false });
const bookingReadRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, keyGenerator: bookingRateLimitKey, standardHeaders: 'draft-8', legacyHeaders: false });
const bookingMutationRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: bookingRateLimitKey, standardHeaders: 'draft-8', legacyHeaders: false });

// All booking routes require authentication (user context from gateway)
router.post('/bookings', bookingCreateRateLimit, getUserContext, createBooking);
router.get('/bookings', bookingReadRateLimit, getUserContext, getUserBookings);
router.get('/bookings/:bookingId', bookingReadRateLimit, getUserContext, getBooking);
router.post('/bookings/:bookingId/verify-payment', bookingMutationRateLimit, getUserContext, verifyPayment);
router.post('/bookings/:bookingId/cancel', bookingMutationRateLimit, getUserContext, cancelBooking);

module.exports = router;
