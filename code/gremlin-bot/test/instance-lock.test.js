// Only one copy of the bot at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdInstanceLock } from '../src/instance-lock.js';

test('a second copy is told one is already running, and can start once the first is gone', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const first = await holdInstanceLock(port);
  assert.ok(first, 'the first copy gets the lock');
  assert.equal(await holdInstanceLock(port), null, 'the second copy does not');
  await new Promise((r) => first.close(r));
  const again = await holdInstanceLock(port);
  assert.ok(again, 'free again once the first one exits');
  again.close();
});
