const express = require('express');
const controller = require('../controllers/venue.controller');
const { getUserContext } = require('../middlewares/getUserContext.middleware');

const router = express.Router();
router.use(getUserContext);

router.post('/organizers/:organizerId', controller.createVenue);
router.get('/organizers/:organizerId', controller.listVenues);

router.get('/:venueId', controller.getVenue);
router.patch('/:venueId', controller.updateVenue);

router.post('/:venueId/layout-versions', controller.createLayoutVersion);
router.get('/:venueId/layout-versions', controller.listLayoutVersions);
router.post('/:venueId/layout-versions/:layoutVersionId/publish', controller.publishLayoutVersion);

router.post('/:venueId/sections', controller.createSection);
router.get('/:venueId/sections', controller.listSections);
router.patch('/:venueId/sections/:sectionId', controller.updateSection);
router.delete('/:venueId/sections/:sectionId', controller.deactivateSection);

router.post('/:venueId/sections/:sectionId/seats', controller.addSeats);
router.patch('/:venueId/sections/:sectionId/seats/:seatId', controller.updateSeat);
router.delete('/:venueId/sections/:sectionId/seats/:seatId', controller.deactivateSeat);

module.exports = router;