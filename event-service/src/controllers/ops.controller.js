const asyncHandler = require('../utils/asyncHandler');
const outboxOperations = require('../services/outboxOperations.service');

const metrics = asyncHandler(async (req, res) => {
  const stats = await outboxOperations.getOutboxStats();
  const lines = [
    '# HELP ticketflow_outbox_pending_events Unpublished outbox events that have not been dead-lettered.',
    '# TYPE ticketflow_outbox_pending_events gauge',
    'ticketflow_outbox_pending_events ' + stats.pending,
    '# HELP ticketflow_outbox_dead_letter_events Unpublished outbox events requiring operator action.',
    '# TYPE ticketflow_outbox_dead_letter_events gauge',
    'ticketflow_outbox_dead_letter_events ' + stats.dead_lettered,
    '# HELP ticketflow_outbox_published_events Successfully published outbox events.',
    '# TYPE ticketflow_outbox_published_events gauge',
    'ticketflow_outbox_published_events ' + stats.published,
    '# HELP ticketflow_outbox_oldest_pending_seconds Age of the oldest pending outbox event.',
    '# TYPE ticketflow_outbox_oldest_pending_seconds gauge',
    'ticketflow_outbox_oldest_pending_seconds ' + stats.oldest_pending_seconds,
    '# HELP ticketflow_outbox_publish_attempts Current sum of publish attempts stored on outbox records.',
    '# TYPE ticketflow_outbox_publish_attempts gauge',
    'ticketflow_outbox_publish_attempts ' + stats.publish_attempts,
  ];
  res.type('text/plain; version=0.0.4; charset=utf-8').status(200).send(lines.join('\n') + '\n');
});

const getOutboxStatus = asyncHandler(async (req, res) => {
  const stats = await outboxOperations.getOutboxStats();
  res.status(200).json({ success: true, data: stats });
});

const listDeadLetters = asyncHandler(async (req, res) => {
  const data = await outboxOperations.listDeadLetters(req.query.limit);
  res.status(200).json({ success: true, data });
});

const retryDeadLetter = asyncHandler(async (req, res) => {
  const data = await outboxOperations.retryDeadLetter(req.params.eventId);
  res.status(202).json({ success: true, message: 'Outbox event queued for retry', data });
});

module.exports = { metrics, getOutboxStatus, listDeadLetters, retryDeadLetter };
