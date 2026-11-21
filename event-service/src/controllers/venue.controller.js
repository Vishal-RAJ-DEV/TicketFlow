const asyncHandler = require('../utils/asyncHandler');
const venueService = require('../services/venue.service');

exports.createVenue = asyncHandler(async (req, res) => {
  const venue = await venueService.createVenue(req.params.organizerId, req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Venue created with its first draft layout', data: venue });
});

exports.listVenues = asyncHandler(async (req, res) => {
  const venues = await venueService.listVenues(req.params.organizerId, req.user.id);
  res.status(200).json({ success: true, data: venues });
});

exports.getVenue = asyncHandler(async (req, res) => {
  const venue = await venueService.getVenue(req.params.venueId, req.user.id);
  res.status(200).json({ success: true, data: venue });
});

exports.updateVenue = asyncHandler(async (req, res) => {
  const venue = await venueService.updateVenue(req.params.venueId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Venue updated successfully', data: venue });
});

exports.createLayoutVersion = asyncHandler(async (req, res) => {
  const layout = await venueService.createLayoutVersion(req.params.venueId, req.user.id);
  res.status(201).json({ success: true, message: 'Draft layout version created', data: layout });
});

exports.listLayoutVersions = asyncHandler(async (req, res) => {
  const layouts = await venueService.listLayoutVersions(req.params.venueId, req.user.id);
  res.status(200).json({ success: true, data: layouts });
});

exports.publishLayoutVersion = asyncHandler(async (req, res) => {
  const layout = await venueService.publishLayoutVersion(req.params.venueId, req.params.layoutVersionId, req.user.id);
  res.status(200).json({ success: true, message: 'Venue layout version published', data: layout });
});

exports.createSection = asyncHandler(async (req, res) => {
  const section = await venueService.createSection(req.params.venueId, req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Venue section created', data: section });
});

exports.listSections = asyncHandler(async (req, res) => {
  const sections = await venueService.listSections(req.params.venueId, req.user.id);
  res.status(200).json({ success: true, data: sections });
});

exports.updateSection = asyncHandler(async (req, res) => {
  const section = await venueService.updateSection(req.params.venueId, req.params.sectionId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Venue section updated', data: section });
});

exports.deactivateSection = asyncHandler(async (req, res) => {
  const result = await venueService.deactivateSection(req.params.venueId, req.params.sectionId, req.user.id);
  res.status(200).json({ success: true, data: result });
});

exports.addSeats = asyncHandler(async (req, res) => {
  const seats = await venueService.addSeats(req.params.venueId, req.params.sectionId, req.user.id, req.body.seats);
  res.status(201).json({ success: true, message: 'Venue seats added', data: seats });
});

exports.updateSeat = asyncHandler(async (req, res) => {
  const seat = await venueService.updateSeat(req.params.venueId, req.params.sectionId, req.params.seatId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Venue seat updated', data: seat });
});

exports.deactivateSeat = asyncHandler(async (req, res) => {
  const result = await venueService.deactivateSeat(req.params.venueId, req.params.sectionId, req.params.seatId, req.user.id);
  res.status(200).json({ success: true, data: result });
});