const express = require('express');
const controller = require('../controllers/occurrence.controller');
const { getUserContext } = require('../middlewares/getUserContext.middleware');

const router = express.Router();

router.post('/events/:eventId', getUserContext, controller.createOccurrence);
router.get('/events/:eventId', getUserContext, controller.listOccurrences);

router.get('/:occurrenceId', getUserContext, controller.getOccurrence);
router.patch('/:occurrenceId', getUserContext, controller.updateOccurrence);
router.post('/:occurrenceId/publish', getUserContext, controller.publishOccurrence);
router.post('/:occurrenceId/cancel', getUserContext, controller.cancelOccurrence);

module.exports = router;