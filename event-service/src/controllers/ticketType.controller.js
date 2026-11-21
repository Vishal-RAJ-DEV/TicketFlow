const asyncHandler = require('../utils/asyncHandler');
const ticketTypeService = require('../services/ticketType.service');

exports.createTicketType = asyncHandler(async (req, res) => {
  const ticketType = await ticketTypeService.createTicketType(req.params.occurrenceId, req.user.id, req.body);
  res.status(201).json({ success: true, message: 'Ticket type created', data: ticketType });
});

exports.listTicketTypes = asyncHandler(async (req, res) => {
  const ticketTypes = await ticketTypeService.listTicketTypes(req.params.occurrenceId, req.user.id);
  res.status(200).json({ success: true, data: ticketTypes });
});

exports.updateTicketType = asyncHandler(async (req, res) => {
  const ticketType = await ticketTypeService.updateTicketType(req.params.ticketTypeId, req.user.id, req.body);
  res.status(200).json({ success: true, message: 'Ticket type updated', data: ticketType });
});

exports.updateTicketTypeStatus = asyncHandler(async (req, res) => {
  const ticketType = await ticketTypeService.updateTicketTypeStatus(req.params.ticketTypeId, req.user.id, req.body.status);
  res.status(200).json({ success: true, message: 'Ticket type status updated', data: ticketType });
});