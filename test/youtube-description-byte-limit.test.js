'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDeliveryProfile } = require('../src/publishing/delivery-profiles');

test('YouTube description accepts the 5000-byte UTF-8 boundary', () => {
  const description = '😀'.repeat(1250);
  assert.equal(Buffer.byteLength(description, 'utf8'), 5000);
  const profile = compileDeliveryProfile('youtube_long_form', { title: 'Boundary', description });
  assert.equal(profile.metadata.description, description);
});

test('YouTube description rejects UTF-8 text over the 5000-byte provider limit', () => {
  const description = '😀'.repeat(1251);
  assert.equal(Buffer.byteLength(description, 'utf8'), 5004);
  assert.throws(
    () => compileDeliveryProfile('youtube_long_form', { title: 'Too large', description }),
    (error) => error.code === 'INVALID_METADATA' && error.message === 'YouTube description exceeds 5000 bytes'
  );
});

test('non-YouTube downloadable MP4 keeps its existing description normalization contract', () => {
  const description = 'x'.repeat(6000);
  const profile = compileDeliveryProfile('downloadable_mp4', { title: 'Download', description });
  assert.equal(profile.metadata.description.length, 6000);
});
