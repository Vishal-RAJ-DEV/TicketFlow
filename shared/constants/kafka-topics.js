/**
 * Centralized Kafka topic definitions.
 * Every service imports from here so topic names stay in sync.
 */
const KAFKA_TOPICS = {
     // Notification topics (user-service -> notification-service)
     OTP_EMAIL: 'notification.otp-email',
     WELCOME_EMAIL: 'notification.welcome-email',
     BOOKING_EMAIL: 'notification.booking-email',
     PAYMENT_EMAIL: 'notification.payment-email',

     // Legacy railway catalog topics (kept until remaining consumers are migrated)
     TRAIN_CREATED: 'admin.train-created',
     STATION_CREATED: 'admin.station-created',
     ROUTE_CREATED: 'admin.route-created',
     SCHEDULE_CREATED: 'admin.schedule-created',
     TRAIN_UPDATED: 'admin.train-updated',
     STATION_UPDATED: 'admin.station-updated',
     ROUTE_UPDATED: 'admin.route-updated',
     SCHEDULE_CANCELLED: 'admin.schedule-cancelled',

     // Event Service catalog events
     EVENT_PUBLISHED: 'event.published',
     EVENT_UPDATED: 'event.updated',
     EVENT_CANCELLED: 'event.cancelled',
     EVENT_OCCURRENCE_PUBLISHED: 'event.occurrence-published',
     EVENT_OCCURRENCE_CANCELLED: 'event.occurrence-cancelled',
     EVENT_OCCURRENCE_SALES_OPENED: 'event.occurrence-sales-opened',
     EVENT_OCCURRENCE_SALES_CLOSED: 'event.occurrence-sales-closed',
     EVENT_OCCURRENCE_COMPLETED: 'event.occurrence-completed',
     VENUE_LAYOUT_VERSION_PUBLISHED: 'venue.layout-version-published',

     // Inventory topics (inventory-service -> search-service)
     SEAT_AVAILABILITY_UPDATED: 'inventory.seat-availability-updated',

     // Booking topics (booking-service -> notification-service)
     BOOKING_CONFIRMED: 'booking.confirmed',
     BOOKING_CANCELLED: 'booking.cancelled',
     BOOKING_FAILED: 'booking.failed',

     // Payment topics (payment-service -> booking-service)
     PAYMENT_SUCCESS: 'payment.success',
     PAYMENT_FAILED: 'payment.failed',

     // Dead-letter queues (per service — poison messages land here)
     DLQ_BOOKING: 'dlq.booking-service',
     DLQ_INVENTORY: 'dlq.inventory-service',
     DLQ_SEARCH: 'dlq.search-service',
     DLQ_NOTIFICATION: 'dlq.notification-service',
};

/**
 * Max retries before a consumer message is sent to the DLQ.
 * After this many failures the message is considered poison.
 */
const DLQ_MAX_RETRIES = 3;

module.exports = { KAFKA_TOPICS, DLQ_MAX_RETRIES };