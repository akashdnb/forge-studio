'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('outbound webhook reliability migration runs after transactional outbox and progressive release migrations', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'migrations')).sort();
  const index = (name) => files.indexOf(name);
  assert.ok(index('116_transactional_outbox_ordering.sql') >= 0);
  assert.ok(index('117_event_delivery_ordering_ack.sql') >= 0);
  assert.ok(index('151_progressive_release_control.sql') >= 0);
  assert.ok(index('152_outbound_webhook_reliability.sql') > index('151_progressive_release_control.sql'));
});
