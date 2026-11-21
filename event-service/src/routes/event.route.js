const express = require('express');
const controller = require('../controllers/event.controller');
const { getUserContext } = require('../middlewares/getUserContext.middleware');

const router = express.Router();

router.post('/organizers/:organizerId', getUserContext, controller.createEvent);
router.get('/organizers/:organizerId', getUserContext, controller.listOrganizerEvents);

router.get('/:eventId', getUserContext, controller.getEvent);
router.patch('/:eventId', getUserContext, controller.updateEvent);
router.post('/:eventId/publish', getUserContext, controller.publishEvent);
router.post('/:eventId/cancel', getUserContext, controller.cancelEvent);

module.exports = router;