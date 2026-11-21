const asyncHandler = require('../utils/asyncHandler');
const organizerService = require('../services/organizer.service');

exports.createOrganizer = asyncHandler(async (req, res) => {
  const organizer = await organizerService.createOrganizer(req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Organizer created successfully', data: organizer });
});

exports.listOrganizers = asyncHandler(async (req, res) => {
  const organizers = await organizerService.listOrganizers(req.user.id);
  res.status(200).json({ success: true, data: organizers });
});

exports.getOrganizer = asyncHandler(async (req, res) => {
  const organizer = await organizerService.getOrganizer(req.params.organizerId, req.user.id);
  res.status(200).json({ success: true, data: organizer });
});

exports.updateOrganizer = asyncHandler(async (req, res) => {
  const organizer = await organizerService.updateOrganizer(req.params.organizerId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Organizer updated successfully', data: organizer });
});

exports.listMembers = asyncHandler(async (req, res) => {
  const members = await organizerService.listMembers(req.params.organizerId, req.user.id);
  res.status(200).json({ success: true, data: members });
});

exports.upsertMember = asyncHandler(async (req, res) => {
  const member = await organizerService.upsertMember(req.params.organizerId, req.user.id, {
    userId: req.params.memberUserId,
    role: req.body.role,
  });
  res.status(200).json({ success: true, message: 'Organizer member saved', data: member });
});

exports.removeMember = asyncHandler(async (req, res) => {
  const result = await organizerService.removeMember(req.params.organizerId, req.user.id, req.params.memberUserId);
  res.status(200).json({ success: true, data: result });
});