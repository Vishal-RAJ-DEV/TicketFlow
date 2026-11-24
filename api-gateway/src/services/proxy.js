const axios = require('axios');
const fs = require('node:fs');
const https = require('node:https');
const { config } = require('../config');
const { ServiceUnavailableError, GatewayTimeoutError } = require('../utils/error');
const logger = require('../config/logger');
const { signGatewayAssertion } = require('../../../shared/utils/gatewayAssertion');

/**
 * Circuit Breaker implementation.
 * Downstream 5xx responses count as failures even though Axios is configured
 * to return them to the caller rather than throw.
 */
class CircuitBreaker {
     constructor(serviceName, threshold = config.CIRCUIT_BREAKER_THRESHOLD, timeout = config.CIRCUIT_BREAKER_TIMEOUT) {
          this.serviceName = serviceName;
          this.failureCount = 0;
          this.threshold = threshold;
          this.timeout = timeout;
          this.state = 'CLOSED';
          this.nextAttempt = Date.now();
          this.probeInFlight = false;
     }

     async execute(request) {
          if (this.state === 'OPEN') {
               if (Date.now() < this.nextAttempt) {
                    throw new ServiceUnavailableError(
                         `Service ${this.serviceName} is temporarily unavailable. Circuit breaker is OPEN.`
                    );
               }
               this.state = 'HALF_OPEN';
               this.probeInFlight = false;
               logger.info(`Circuit breaker HALF_OPEN for ${this.serviceName}`);
          }
          if (this.state === 'HALF_OPEN') {
               if (this.probeInFlight) {
                    throw new ServiceUnavailableError(`Service ${this.serviceName} is waiting for its recovery probe.`);
               }
               this.probeInFlight = true;
          }

          try {
               const response = await request();
               if (response && response.status >= 500) {
                    this.onFailure();
               } else {
                    this.onSuccess();
               }
               return response;
          } catch (err) {
               this.onFailure();
               throw err;
          }
     }

     onSuccess() {
          this.failureCount = 0;
          if (this.state === 'HALF_OPEN') {
               this.probeInFlight = false;
               this.state = 'CLOSED';
               logger.info(`Circuit breaker CLOSED for ${this.serviceName}`);
          }
     }

     onFailure() {
          this.probeInFlight = false;
          this.failureCount++;
          if (this.failureCount >= this.threshold) {
               this.state = 'OPEN';
               this.nextAttempt = Date.now() + this.timeout;
               logger.error(
                    `Circuit breaker OPEN for ${this.serviceName}. Next attempt at ${new Date(this.nextAttempt).toISOString()}`
               );
          }
     }

     getState() {
          return {
               service: this.serviceName,
               state: this.state,
               failureCount: this.failureCount,
               nextAttempt: this.state === 'OPEN' ? new Date(this.nextAttempt).toISOString() : null,
          };
     }
}

const circuitBreakers = {
     userService: new CircuitBreaker('user-service'),
     searchService: new CircuitBreaker('search-service'),
     eventService: new CircuitBreaker('event-service'),
     notificationService: new CircuitBreaker('notification-service'),
     bookingService: new CircuitBreaker('booking-service'),
     paymentService: new CircuitBreaker('payment-service'),
     inventoryService: new CircuitBreaker('inventory-service')
};

async function forwardRequest(serviceUrl, path, method, data, headers, circuitBreaker, httpsAgent) {
     const url = `${serviceUrl}${path}`;
     const requestConfig = {
          method,
          url,
          timeout: config.SERVICE_TIMEOUT_MS,
          headers: {
               ...headers,
               host: undefined,
               'content-length': undefined,
          },
          validateStatus: () => true,
          maxRedirects: 0,
          ...(httpsAgent ? { httpsAgent } : {}),
     };

     if (method !== 'GET' && method !== 'DELETE' && data !== undefined) {
          requestConfig.data = data;
     }
     if ((method === 'GET' || method === 'DELETE') && data !== undefined) {
          requestConfig.params = data;
     }

     try {
          const response = await circuitBreaker.execute(() => axios(requestConfig));
          return {
               status: response.status,
               data: response.data,
               headers: response.headers,
          };
     } catch (err) {
          logger.error(`Error forwarding to ${serviceUrl}:`, {
               message: err.message,
               code: err.code,
               path: path.split('?')[0],
               method,
               timeout: config.SERVICE_TIMEOUT_MS,
          });

          if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
               throw new GatewayTimeoutError(`Request to ${serviceUrl} timed out after ${config.SERVICE_TIMEOUT_MS}ms`);
          }
          if (err.code === 'ECONNREFUSED') {
               throw new ServiceUnavailableError(`Cannot connect to ${serviceUrl}. Service may be down.`);
          }
          if (err.response) {
               return {
                    status: err.response.status,
                    data: err.response.data,
                    headers: err.response.headers,
               };
          }
          logger.error(`Network error while calling ${serviceUrl}:`, err.message);
          throw new ServiceUnavailableError('Downstream service temporarily unavailable');
     }
}

function createProxy(serviceName, serviceUrl, options = {}) {
     const circuitBreaker = circuitBreakers[serviceName];
     if (!circuitBreaker) throw new Error(`No circuit breaker found for service: ${serviceName}`);

     const httpsAgent = options.httpsAgent || (serviceName === 'eventService' && serviceUrl.startsWith('https:')
          ? new https.Agent({
               ca: fs.readFileSync(config.EVENT_SERVICE_TLS_CA_FILE),
               cert: fs.readFileSync(config.EVENT_SERVICE_TLS_CLIENT_CERT_FILE),
               key: fs.readFileSync(config.EVENT_SERVICE_TLS_CLIENT_KEY_FILE),
               rejectUnauthorized: true,
               minVersion: 'TLSv1.2',
               keepAlive: true,
          })
          : undefined);

     return async (req, res, next) => {
          try {
               const pathParts = req.path.split('/').filter(Boolean);
               const servicePath = '/' + pathParts.slice(1).join('/');
               const downstreamPath = servicePath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
               const headers = { ...req.headers };
               const clientIp = req.ip || req.socket?.remoteAddress;
               if (clientIp) headers['x-forwarded-for'] = clientIp;

               if (options.gatewayAssertion) {
                    // Never forward a caller-supplied identity or assertion.
                    delete headers['x-user-id'];
                    delete headers['x-gateway-timestamp'];
                    delete headers['x-gateway-signature'];
                    delete headers['x-gateway-nonce'];

                    const userId = req.user?.id ? String(req.user.id) : null;
                    const assertion = signGatewayAssertion({
                         secret: config.GATEWAY_ASSERTION_SECRET,
                         method: req.method,
                         path: downstreamPath,
                         userId,
                         body: req.body,
                    });
                    if (userId) headers['x-user-id'] = userId;
                    headers['x-gateway-timestamp'] = assertion.timestamp;
                    headers['x-gateway-signature'] = assertion.signature;
                    headers['x-gateway-nonce'] = assertion.nonce;
               }

               const result = await forwardRequest(
                    serviceUrl,
                    downstreamPath,
                    req.method,
                    req.body,
                    headers,
                    circuitBreaker,
                    httpsAgent
               );

               const excludeHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'host'];
               Object.keys(result.headers || {}).forEach((key) => {
                    if (!excludeHeaders.includes(key.toLowerCase())) {
                         res.setHeader(key, result.headers[key]);
                    }
               });
               res.status(result.status).json(result.data);
          } catch (err) {
               next(err);
          }
     };
}

function getCircuitBreakerStatus() {
     return Object.values(circuitBreakers).map((cb) => cb.getState());
}

module.exports = {
     createProxy,
     CircuitBreaker,
     circuitBreakers,
     getCircuitBreakerStatus,
};
