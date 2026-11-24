const test = require('node:test');
const assert = require('node:assert/strict');
const {
  signGatewayAssertion,
  verifyGatewayAssertion,
  requestBodyDigest,
} = require('../../shared/utils/gatewayAssertion');

const secret = 'a'.repeat(64);

test('accepts a valid short-lived gateway assertion', () => {
  const assertion = signGatewayAssertion({
    secret,
    method: 'POST',
    path: '/organizers/?source=web',
    userId: 'user-123',
    body: { name: 'North Star Events' },
  });

  assert.equal(verifyGatewayAssertion({
    secret,
    method: 'POST',
    path: '/organizers?source=web',
    userId: 'user-123',
    body: { name: 'North Star Events' },
    timestamp: assertion.timestamp,
    nonce: assertion.nonce,
    signature: assertion.signature,
  }), true);
});

test('rejects changes to method, path, identity or request body', () => {
  const body = { name: 'North Star Events' };
  const assertion = signGatewayAssertion({
    secret,
    method: 'POST',
    path: '/organizers',
    userId: 'user-123',
    body,
  });
  const base = {
    secret,
    method: 'POST',
    path: '/organizers',
    userId: 'user-123',
    body,
    timestamp: assertion.timestamp,
    nonce: assertion.nonce,
    signature: assertion.signature,
  };

  assert.equal(verifyGatewayAssertion({ ...base, method: 'DELETE' }), false);
  assert.equal(verifyGatewayAssertion({ ...base, path: '/organizers/other' }), false);
  assert.equal(verifyGatewayAssertion({ ...base, userId: 'user-456' }), false);
  assert.equal(verifyGatewayAssertion({ ...base, body: { name: 'Tampered' } }), false);
  assert.equal(verifyGatewayAssertion({ ...base, nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), false);
});

test('rejects expired/future assertions and malformed signatures', () => {
  const assertion = signGatewayAssertion({
    secret,
    method: 'GET',
    path: '/catalog',
    userId: null,
    body: undefined,
  });
  const base = {
    secret,
    method: 'GET',
    path: '/catalog/',
    userId: null,
    body: {},
    timestamp: assertion.timestamp,
    nonce: assertion.nonce,
    signature: assertion.signature,
  };

  assert.equal(verifyGatewayAssertion({ ...base, now: Number(assertion.timestamp) + 30_001 }), false);
  assert.equal(verifyGatewayAssertion({ ...base, now: Number(assertion.timestamp) - 30_001 }), false);
  assert.equal(verifyGatewayAssertion({ ...base, signature: 'invalid' }), false);
});

test('normalizes empty request bodies to the same digest', () => {
  assert.equal(requestBodyDigest(undefined), requestBodyDigest({}));
});
