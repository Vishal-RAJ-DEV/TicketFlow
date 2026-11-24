'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
config.OPS_TOKEN = 'ticketflow-ops-test-token-0123456789';
config.METRICS_TOKEN = 'ticketflow-metrics-test-token-0123456789';

const { requireOpsToken, requireMetricsToken } = require('../src/middlewares/opsAuth.middleware');

const invoke = (middleware, headers = {}) => {
  let nextError;
  let continued = false;
  middleware({ headers }, {}, (error) => {
    nextError = error;
    continued = !error;
  });
  return { nextError, continued };
};

test('operations endpoints accept the configured bearer token', () => {
  const result = invoke(requireOpsToken, { authorization: 'Bearer ' + config.OPS_TOKEN });
  assert.equal(result.continued, true);
  assert.equal(result.nextError, undefined);
});

test('operations endpoints reject missing and incorrect credentials', () => {
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { 'x-ops-token': 'wrong-token' }]) {
    const result = invoke(requireOpsToken, headers);
    assert.equal(result.continued, false);
    assert.equal(result.nextError.statusCode, 401);
  }
});

test('metrics endpoint accepts only the configured metrics token header', () => {
  const accepted = invoke(requireMetricsToken, { 'x-metrics-token': config.METRICS_TOKEN });
  assert.equal(accepted.continued, true);

  for (const headers of [{}, { 'x-metrics-token': 'wrong-token' }, { authorization: 'Bearer ' + config.METRICS_TOKEN }]) {
    const result = invoke(requireMetricsToken, headers);
    assert.equal(result.continued, false);
    assert.equal(result.nextError.statusCode, 401);
  }
});
