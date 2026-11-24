const express = require('express');
const { requireAuth } = require('../middlewares/auth.middleware');
const { createProxy, getCircuitBreakerStatus } = require('../services/proxy');
const { ipRateLimit, endpointRateLimit, combinedRateLimit } = require('../middlewares/rateLimiting.middleware')
const { config } = require('../config');
const { validateCsrfDoubleSubmit, doubleCsrfProtection } = require('../middlewares/csrf.middleware');
const csrfProtection = [validateCsrfDoubleSubmit, doubleCsrfProtection];

const router = express.Router();

// ===========================
// Service Proxy Routes
// ===========================

/**
 * USER SERVICE ROUTES
 * Gateway Path: /api/users/auth/login
 * Service Path: /auth/login
**/

const userServiceProxy = createProxy('userService', config.SERVICES.USER_SERVICE_URL);

// public routes
router.post(
     '/users/auth/send-otp',
     endpointRateLimit(5, 3600000), // 5 requests per hour
     userServiceProxy
);

router.post(
     '/users/auth/verify-otp',
     endpointRateLimit(10, 3600000), // 10 requests per hour
     userServiceProxy
);

router.post(
     '/users/auth/login',
     endpointRateLimit(100, 900000),// 100 requests per 15 minutes
     userServiceProxy
);

router.post(
     '/users/auth/google-auth',
     endpointRateLimit(10, 900000), // 10 requests per 15 minutes
     userServiceProxy
);

router.post(
     '/users/auth/refresh',
     endpointRateLimit(20, 900000), // 20 requests per 15 minutes
     userServiceProxy
);

// private routes
router.get(
     '/users/user/profile',
     requireAuth,
     combinedRateLimit(),
     userServiceProxy
)

router.put(
     '/users/user/profile',
     ...csrfProtection,
     requireAuth,
     combinedRateLimit(),
     userServiceProxy
)

router.delete(
     '/users/user/profile',
     ...csrfProtection,
     requireAuth,
     combinedRateLimit(),
     userServiceProxy
)

const eventServiceProxy = createProxy('eventService', config.SERVICES.EVENT_SERVICE_URL, { gatewayAssertion: true });

const eventRoute = (method, path, authenticated = true, limiter = combinedRateLimit()) => {
     const isStateChanging = ['post', 'put', 'patch', 'delete'].includes(method);
     const csrfHandlers = isStateChanging ? csrfProtection : [];
     const handlers = authenticated
          ? [...csrfHandlers, requireAuth, limiter, eventServiceProxy]
          : [limiter, ...csrfHandlers, eventServiceProxy];
     router[method](path, ...handlers);
};

// Public event discovery
eventRoute('get', '/events/catalog', false, endpointRateLimit(120, 60000));
eventRoute('get', '/events/catalog/:slug', false, endpointRateLimit(120, 60000));

// Organizer management
eventRoute('post', '/events/organizers');
eventRoute('get', '/events/organizers');
eventRoute('get', '/events/organizers/:organizerId');
eventRoute('patch', '/events/organizers/:organizerId');
eventRoute('get', '/events/organizers/:organizerId/members');
eventRoute('put', '/events/organizers/:organizerId/members/:memberUserId');
eventRoute('delete', '/events/organizers/:organizerId/members/:memberUserId');

// Venue and immutable layout versions
eventRoute('post', '/events/venues/organizers/:organizerId');
eventRoute('get', '/events/venues/organizers/:organizerId');
eventRoute('get', '/events/venues/:venueId');
eventRoute('patch', '/events/venues/:venueId');
eventRoute('post', '/events/venues/:venueId/layout-versions');
eventRoute('get', '/events/venues/:venueId/layout-versions');
eventRoute('post', '/events/venues/:venueId/layout-versions/:layoutVersionId/publish');
eventRoute('post', '/events/venues/:venueId/sections');
eventRoute('get', '/events/venues/:venueId/sections');
eventRoute('patch', '/events/venues/:venueId/sections/:sectionId');
eventRoute('delete', '/events/venues/:venueId/sections/:sectionId');
eventRoute('post', '/events/venues/:venueId/sections/:sectionId/seats');
eventRoute('patch', '/events/venues/:venueId/sections/:sectionId/seats/:seatId');
eventRoute('delete', '/events/venues/:venueId/sections/:sectionId/seats/:seatId');

// Event catalog management
eventRoute('post', '/events/events/organizers/:organizerId');
eventRoute('get', '/events/events/organizers/:organizerId');
eventRoute('get', '/events/events/:eventId');
eventRoute('patch', '/events/events/:eventId');
eventRoute('post', '/events/events/:eventId/publish');
eventRoute('post', '/events/events/:eventId/cancel');

// Occurrence and ticket configuration
eventRoute('post', '/events/occurrences/events/:eventId');
eventRoute('get', '/events/occurrences/events/:eventId');
eventRoute('get', '/events/occurrences/:occurrenceId');
eventRoute('patch', '/events/occurrences/:occurrenceId');
eventRoute('post', '/events/occurrences/:occurrenceId/publish');
eventRoute('post', '/events/occurrences/:occurrenceId/cancel');

eventRoute('post', '/events/ticket-types/occurrences/:occurrenceId');
eventRoute('get', '/events/ticket-types/occurrences/:occurrenceId');
eventRoute('patch', '/events/ticket-types/:ticketTypeId');
eventRoute('patch', '/events/ticket-types/:ticketTypeId/status');

// ===========================
// SEARCH SERVICE ROUTES (public - no auth required)
// ===========================
const searchServiceProxy = createProxy('searchService', config.SERVICES.SEARCH_SERVICE_URL);

router.get(
     '/search/trains',
     endpointRateLimit(60, 60000), // 60 requests per minute
     searchServiceProxy
);

router.get(
     '/search/autocomplete',
     endpointRateLimit(120, 60000), // 120 requests per minute
     searchServiceProxy
);

// ===========================
// INVENTORY SERVICE ROUTES (public read-only)
// ===========================
const inventoryServiceProxy = createProxy('inventoryService', config.SERVICES.INVENTORY_SERVICE_URL);

// Public: aggregate availability (used by search results)
router.get(
     '/inventory/schedules/:scheduleId/availability',
     endpointRateLimit(120, 60000), // 120 requests per minute
     inventoryServiceProxy
);

// Authenticated: individual seat statuses
router.get(
     '/inventory/schedules/:scheduleId/seats',
     requireAuth,
     combinedRateLimit(),
     inventoryServiceProxy
);

// Note: lock/unlock/confirm/cancel-booking are now internal-only
// (called by booking-service directly, not through the gateway)

// ===========================
// BOOKING SERVICE ROUTES
// ===========================
const bookingServiceProxy = createProxy('bookingService', config.SERVICES.BOOKING_SERVICE_URL);

router.post(
     '/bookings/bookings',
     requireAuth,
     endpointRateLimit(5, 60000), // 5 booking attempts per minute,
     bookingServiceProxy
);

router.get(
     '/bookings/bookings',
     requireAuth,
     combinedRateLimit(),
     bookingServiceProxy
);

router.get(
     '/bookings/bookings/:bookingId',
     requireAuth,
     combinedRateLimit(),
     bookingServiceProxy
);

router.post(
     '/bookings/bookings/:bookingId/verify-payment',
     requireAuth,
     combinedRateLimit(),
     bookingServiceProxy
);

router.post(
     '/bookings/bookings/:bookingId/cancel',
     requireAuth,
     combinedRateLimit(),
     bookingServiceProxy
);

// ===========================
// PAYMENT SERVICE ROUTES (webhook only - public)
// ===========================
const paymentServiceProxy = createProxy('paymentService', config.SERVICES.PAYMENT_SERVICE_URL);

// Razorpay webhook (public — no auth, signature-verified by payment-service)
router.post(
     '/payments/webhooks/razorpay',
     paymentServiceProxy
);

// Gateway Health Status

router.get('/gateway/health', (req, res) => {
     res.status(200).json({
          success: true,
          message: "API Gateway is healthy",
          timestamp: new Date().toISOString()
     });
});

router.get('/gateway/circuit-breakers', (req, res) => {
     const status = getCircuitBreakerStatus();
     res.status(200).json({
          success: true,
          circuitBreakers: status,
     });
});

module.exports = router;