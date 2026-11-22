const asyncHandler = require('../utils/asyncHandler');
const eventService = require('../services/event.service');

exports.createEvent = asyncHandler(async (req, res) => {
  const event = await eventService.createEvent(req.params.organizerId, req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Event created successfully', data: event });
});

exports.listOrganizerEvents = asyncHandler(async (req, res) => {
  const events = await eventService.listOrganizerEvents(req.params.organizerId, req.user.id);
  res.status(200).json({ success: true, data: events });
});

exports.getEvent = asyncHandler(async (req, res) => {
  const event = await eventService.getEventForOrganizer(req.params.eventId, req.user.id);
  res.status(200).json({ success: true, data: event });
});

exports.updateEvent = asyncHandler(async (req, res) => {
  const event = await eventService.updateEvent(req.params.eventId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Event updated successfully', data: event });
});

exports.publishEvent = asyncHandler(async (req, res) => {
  const event = await eventService.publishEvent(req.params.eventId, req.user.id);
  res.status(200).json({ success: true, message: 'Event published successfully', data: event });
});

exports.cancelEvent = asyncHandler(async (req, res) => {
  const event = await eventService.cancelEvent(req.params.eventId, req.user.id, req.body.reason);
  res.status(200).json({ success: true, message: 'Event cancelled', data: event });
});

exports.listPublicEvents = asyncHandler(async (req, res) => {
  const events = await eventService.listPublicEvents(req.query);
  res.status(200).json({ success: true, data: events });
});

exports.getPublicEvent = asyncHandler(async (req, res) => {
  const event = await eventService.getPublicEventBySlug(req.params.slug);
  res.status(200).json({ success: true, data: event });
});