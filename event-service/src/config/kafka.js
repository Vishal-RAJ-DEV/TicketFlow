const { Kafka, logLevel } = require('kafkajs');
const logger = require('./logger');
const { config } = require('./');

const kafka = new Kafka({
  clientId: config.KAFKA_CLIENT_ID,
  brokers: [config.KAFKA_BROKER],
  logLevel: logLevel.ERROR,
  retry: {
    initialRetryTime: 300,
    retries: 8,
    maxRetryTime: 30000,
  },
});

const producer = kafka.producer({
  allowAutoTopicCreation: true,
  idempotent: true,
  maxInFlightRequests: 5,
  retry: { retries: 5 },
});

let isConnected = false;

const connectProducer = async () => {
  if (isConnected) return;
  await producer.connect();
  isConnected = true;
  logger.info('Kafka producer connected');
};

const disconnectProducer = async () => {
  if (!isConnected) return;
  await producer.disconnect();
  isConnected = false;
  logger.info('Kafka producer disconnected');
};

const sendEvent = async (topic, key, payload) => {
  await connectProducer();
  return producer.send({
    topic,
    messages: [{
      key,
      value: JSON.stringify(payload),
      timestamp: Date.now().toString(),
    }],
  });
};

module.exports = { kafka, producer, connectProducer, disconnectProducer, sendEvent };