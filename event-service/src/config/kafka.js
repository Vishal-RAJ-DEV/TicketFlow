const fs = require('node:fs');
const { Kafka, logLevel } = require('kafkajs');
const logger = require('./logger');
const { config } = require('./');

const ssl = !config.KAFKA_SSL ? false : (config.KAFKA_CA_FILE || config.KAFKA_CERT_FILE || config.KAFKA_KEY_FILE
  ? {
      rejectUnauthorized: true,
      ...(config.KAFKA_CA_FILE ? { ca: [fs.readFileSync(config.KAFKA_CA_FILE)] } : {}),
      ...(config.KAFKA_CERT_FILE ? { cert: fs.readFileSync(config.KAFKA_CERT_FILE) } : {}),
      ...(config.KAFKA_KEY_FILE ? { key: fs.readFileSync(config.KAFKA_KEY_FILE) } : {}),
    }
  : true);

const sasl = config.KAFKA_SASL_USERNAME
  ? { mechanism: config.KAFKA_SASL_MECHANISM, username: config.KAFKA_SASL_USERNAME, password: config.KAFKA_SASL_PASSWORD }
  : undefined;

const kafka = new Kafka({
  clientId: config.KAFKA_CLIENT_ID,
  brokers: [config.KAFKA_BROKER],
  ssl,
  ...(sasl ? { sasl } : {}),
  logLevel: logLevel.ERROR,
  retry: { initialRetryTime: 300, retries: 8, maxRetryTime: 30000 },
});

const producer = kafka.producer({
  allowAutoTopicCreation: config.KAFKA_ALLOW_AUTO_TOPIC_CREATION,
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
    messages: [{ key, value: JSON.stringify(payload), timestamp: Date.now().toString() }],
  });
};
module.exports = { kafka, producer, connectProducer, disconnectProducer, sendEvent };
