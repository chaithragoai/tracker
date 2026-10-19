import test from 'node:test';
import assert from 'node:assert/strict';
import {
  domainOf,
  isProtectedUrl,
  isExcluded,
  sanitizeMetadata,
  redactSensitiveQuery,
} from '../lib/privacy.js';

test('domain and protected urls', () => {
  assert.equal(domainOf('https://example.com/a'), 'example.com');
  assert.equal(isProtectedUrl('chrome://settings'), true);
  assert.equal(isProtectedUrl('https://example.com'), false);
});

test('excluded domains', () => {
  assert.equal(isExcluded('https://mail.google.com/inbox', ['google.com']), true);
  assert.equal(isExcluded('https://news.ycombinator.com', ['google.com']), false);
});

test('sanitize strips secrets and truncates', () => {
  const out = sanitizeMetadata({
    password: 'nope',
    token: 'abc',
    semantic: 'clicked_control',
    long: 'x'.repeat(600),
  });
  assert.equal(out.password, undefined);
  assert.equal(out.token, undefined);
  assert.equal(out.semantic, 'clicked_control');
  assert.ok(out.long.endsWith('…'));
  assert.ok(out.long.length <= 501);
});

test('redact sensitive query params', () => {
  const url = redactSensitiveQuery('https://app.example/x?token=secret&q=hello');
  assert.match(url, /token=REDACTED/);
  assert.match(url, /q=hello/);
});
