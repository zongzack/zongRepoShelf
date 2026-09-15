import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

test('页面与 API 提供认证状态和显式扫描入口', async () => {
  let scans = 0;
  const orchestrator = { async authStatus() { return { state: 'not-logged-in', message: '请登录' }; }, async loadLastScan() { return null; }, async scan() { scans++; return { status: 'blocked', auth: { state: 'not-logged-in' }, items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; } };
  const server = createServer({ orchestrator }); const port = await listen(server);
  const page = await fetch(`http://127.0.0.1:${port}/`); assert.equal(page.status, 200); assert.match(await page.text(), /开始扫描/);
  const status = await fetch(`http://127.0.0.1:${port}/api/status`); assert.deepEqual(await status.json(), { state: 'not-logged-in', message: '请登录' });
  const scan = await fetch(`http://127.0.0.1:${port}/api/scan`, { method: 'POST' }); assert.equal(scan.status, 403); assert.equal(scans, 1);
  await new Promise((resolve) => server.close(resolve));
});
