const asyncHandler = require('../utils/asyncHandler');
const occurrenceService = require('../services/occurrence.service');

exports.createOccurrence = asyncHandler(async (req, res) => {
  const occurrence = await occurrenceService.createOccurrence(req.params.eventId, req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Event occurrence created', data: occurrence });
});

exports.listOccurrences = asyncHandler(async (req, res) => {
  const occurrences = await occurrenceService.listOccurrences(req.params.eventId, req.user.id);
  res.status(200).json({ success: true, data: occurrences });
});

exports.getOccurrence = asyncHandler(async (req, res) => {
  const occurrence = await occurrenceService.getOccurrence(req.params.occurrenceId, req.user.id);
  res.status(200).json({ success: true, data: occurrence });
});

exports.updateOccurrence = asyncHandler(async (req, res) => {
  const occurrence = await occurrenceService.updateOccurrence(req.params.occurrenceId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Event occurrence updated', data: occurrence });
});

exports.publishOccurrence = asyncHandler(async (req, res) => {
  const occurrence = await occurrenceService.publishOccurrence(req.params.occurrenceId, req.user.id);
  res.status(200).json({ success: true, message: 'Event occurrence published', data: occurrence });
});