const express = require('express');
const controller = require('../controllers/organizer.controller');
const { getUserContext } = require('../middlewares/getUserContext.middleware');

const router = express.Router();

router.use(getUserContext);
router.route('/')
  .get(controller.listOrganizers)
  .post(controller.createOrganizer);

router.get('/:organizerId', controller.getOrganizer);
router.patch('/:organizerId', controller.updateOrganizer);
router.get('/:organizerId/members', controller.listMembers);
router.put('/:organizerId/members/:memberUserId', controller.upsertMember);
router.delete('/:organizerId/members/:memberUserId', controller.removeMember);

module.exports = router;