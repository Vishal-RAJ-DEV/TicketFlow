const logger = require('../config/logger');
const { config } = require('../config');
const { runLifecycleBatch } = require('../services/occurrenceLifecycle.service');
let stopped = true;
let timer = null;
let isRunning = false;

const poll = async () => {
  if (stopped || isRunning) return;
  isRunning = true;
  try {
    const results = await runLifecycleBatch(new Date(), config.OCCURRENCE_LIFECYCLE_BATCH_SIZE);
    if (results.length) logger.info('Occurrence lifecycle transitions applied', { occurrences: results.length });
  } catch (error) {
    logger.error('Occurrence lifecycle poll failed', { message: error.message });
  } finally {
    isRunning = false;
    schedule();
  }
};

const schedule = () => {
  if (stopped || timer) return;
  timer = setTimeout(() => {
    timer = null;
    poll();
  }, config.OCCURRENCE_LIFECYCLE_POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
};

const startOccurrenceLifecycleWorker = () => {
  if (!stopped) return;
  stopped = false;
  logger.info('Occurrence lifecycle worker started');
  schedule();
};

const stopOccurrenceLifecycleWorker = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
};

module.exports = { startOccurrenceLifecycleWorker, stopOccurrenceLifecycleWorker, poll };
