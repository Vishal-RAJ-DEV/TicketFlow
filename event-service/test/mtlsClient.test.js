'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
config.TLS_ENABLED = true;
config.MTLS_CLIENT_CNS = ['ticketflow-api-gateway', 'ticketflow-prometheus'];

const { requireMtlsClient } = require('../src/middlewares/mtlsClient.middleware');

const invoke = ({ path = '/internal/metrics', authorized = true, commonName } = {}) => {
  let nextError;
  let continued = false;
  const certificate = commonName ? { subject: { CN: commonName } } : {};
  requireMtlsClient({
    path,
    socket: {
      authorized,
      getPeerCertificate: () => certificate,
    },
  }, {}, (error) => {
    nextError = error;
    continued = !error;
  });
  return { nextError, continued };
};

test('mTLS accepts an authorized allowlisted Gateway certificate', () => {
  const result = invoke({ commonName: 'ticketflow-api-gateway' });
  assert.equal(result.continued, true);
  assert.equal(result.nextError, undefined);
});

test('mTLS accepts an authorized allowlisted Prometheus client certificate', () => {
  const result = invoke({ commonName: 'ticketflow-prometheus' });
  assert.equal(result.continued, true);
});

test('mTLS rejects missing, untrusted and unauthorized client certificates', () => {
  for (const input of [
    { authorized: false, commonName: 'ticketflow-api-gateway' },
    { authorized: true },
    { authorized: true, commonName: 'untrusted-client' },
  ]) {
    const result = invoke(input);
    assert.equal(result.continued, false);
    assert.equal(result.nextError.statusCode, 401);
  }
});

test('mTLS leaves liveness and readiness probes reachable', () => {
  for (const path of ['/', '/health', '/ready']) {
    const result = invoke({ path, authorized: false });
    assert.equal(result.continued, true);
    assert.equal(result.nextError, undefined);
  }
});
