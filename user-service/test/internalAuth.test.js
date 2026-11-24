const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'unit-test-google-client';
process.env.SENDGRID_API_KEY = 'unit-test-sendgrid-key';
process.env.MAIL_SEND = 'false';
process.env.INTERNAL_SERVICE_KEY = 'current-internal-service-key-' + 'c'.repeat(32);
process.env.INTERNAL_SERVICE_KEY_PREVIOUS = 'previous-internal-service-key-' + 'p'.repeat(32);

const { internalAuth } = require('../src/middlewares/internalAuth.middleware');

const invoke = (provided) => {
  let nextError;
  let continued = false;
  internalAuth({ headers: { 'x-internal-service-key': provided } }, {}, (error) => {
    nextError = error;
    continued = !error;
  });
  return { nextError, continued };
};

test('accepts the current User Service internal key', () => {
  const result = invoke(process.env.INTERNAL_SERVICE_KEY);
  assert.equal(result.continued, true);
  assert.equal(result.nextError, undefined);
});

test('accepts the previous key during secret rotation', () => {
  const result = invoke(process.env.INTERNAL_SERVICE_KEY_PREVIOUS);
  assert.equal(result.continued, true);
  assert.equal(result.nextError, undefined);
});

test('rejects missing and incorrect internal service keys', () => {
  for (const provided of [undefined, '', 'incorrect-key']) {
    const result = invoke(provided);
    assert.equal(result.continued, false);
    assert.equal(result.nextError.statusCode, 403);
  }
});
