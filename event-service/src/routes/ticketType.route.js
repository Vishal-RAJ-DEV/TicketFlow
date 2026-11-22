const express = require('express');
const controller = require('../controllers/ticketType.controller');
const { getUserContext } = require('../middlewares/getUserContext.middleware');

const router = express.Router();
router.use(getUserContext);

router.post('/occurrences/:occurrenceId', controller.createTicketType);
router.get('/occurrences/:occurrenceId', controller.listTicketTypes);
router.patch('/:ticketTypeId', controller.updateTicketType);
router.patch('/:ticketTypeId/status', controller.updateTicketTypeStatus);

module.exports = router;