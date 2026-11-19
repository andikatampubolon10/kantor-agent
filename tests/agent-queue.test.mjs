import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentQueue } from '../agent-queue.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('[#6] tugas dijalankan berurutan satu per satu, tidak ada yang dibuang', async () => {
  const q = createAgentQueue({ maxQueue: 10, maxPerChat: 5 });
  const order = [];
  let running = 0;
  let maxConcurrent = 0;
  const mk = (id, ms) => async () => {
    running++; maxConcurrent = Math.max(maxConcurrent, running);
    await sleep(ms);
    order.push(id);
    running--;
    return id;
  };
  const a = q.enqueue({ label: 'a', chatId: 'x', run: mk('a', 30) });
  const b = q.enqueue({ label: 'b', chatId: 'y', run: mk('b', 5) });
  const c = q.enqueue({ label: 'c', chatId: 'x', run: mk('c', 5) });
  assert.equal(a.ahead, 0);
  assert.equal(b.ahead, 1);
  assert.equal(c.ahead, 2);
  assert.deepEqual(await Promise.all([a.done, b.done, c.done]), ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxConcurrent, 1);
  assert.equal(q.status().busy, false);
});

test('[#6] tugas gagal tidak menghentikan antrean', async () => {
  const q = createAgentQueue();
  const bad = q.enqueue({ label: 'bad', run: async () => { throw new Error('boom'); } });
  const good = q.enqueue({ label: 'good', run: async () => 'ok' });
  await assert.rejects(bad.done, /boom/);
  assert.equal(await good.done, 'ok');
});

test('[#6] tugas macet dilewati setelah batas waktu keras', async () => {
  const q = createAgentQueue({ hardLimitMs: 50, makeTimeoutError: () => new Error('TIMEOUT') });
  const stuck = q.enqueue({ label: 'stuck', run: () => new Promise(() => {}) });
  const next = q.enqueue({ label: 'next', run: async () => 'lanjut' });
  await assert.rejects(stuck.done, /TIMEOUT/);
  assert.equal(await next.done, 'lanjut');
});

test('[#6] batas antrean total & per chat', async () => {
  const q = createAgentQueue({ maxQueue: 3, maxPerChat: 2 });
  const block = () => new Promise(r => setTimeout(r, 30));
  q.enqueue({ label: '1', chatId: 'spam', run: block });
  while (!q.status().busy) await sleep(1); // tunggu tugas pertama benar-benar berjalan
  assert.equal(q.enqueue({ label: '2', chatId: 'spam', run: block }).accepted, true);
  assert.equal(q.enqueue({ label: '3', chatId: 'spam', run: block }).accepted, true);
  assert.deepEqual(q.enqueue({ label: '4', chatId: 'spam', run: block }), { accepted: false, reason: 'chat_limit' });
  assert.equal(q.enqueue({ label: '5', chatId: 'lain', run: block }).accepted, true);
  assert.deepEqual(q.enqueue({ label: '6', chatId: 'lain2', run: block }), { accepted: false, reason: 'full' });
  assert.equal(q.status().busy, true);
});
