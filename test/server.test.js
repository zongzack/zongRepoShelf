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

test('页面提供搜索、健康筛选、关系筛选和阈值重算控件', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated', message: 'ok' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
    async recalculate(thresholds) { return { thresholds, items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 100 } }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /搜索 owner\/repo/); assert.match(page, /仅健康信号/); assert.match(page, /全部关系/); assert.match(page, /重新计算/); assert.match(page, /完整证据/);
  const response = await fetch(`http://127.0.0.1:${port}/api/recalculate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noCommitMonths: 3 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).thresholds.noCommitMonths, 3);
  await new Promise((resolve) => server.close(resolve));
});

test('动作 API 暴露预览、确认、重试和撤销入口', async () => {
  const calls = [];
  const orchestrator = {
    async authStatus() { return { state: 'authenticated' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
    async previewActions(body) { calls.push(['preview', body]); return { status: 'preview', groups: { unstar: [], keep: [] }, actions: [], total: 0 }; },
    async confirmActions(body) { calls.push(['confirm', body]); return { status: 'completed', results: [], summary: { total: 0, success: 0, failed: 0 } }; },
    async retryAction(body) { calls.push(['retry', body]); return { status: 'not-found', results: [] }; },
    async undoStar(body) { calls.push(['undo', body]); return { status: 'not-found' }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  for (const [path, body] of [['/api/actions/preview', { selections: [] }], ['/api/actions/confirm', { previewId: 'x' }], ['/api/actions/retry', { fullName: 'a/b' }], ['/api/actions/undo', { fullName: 'a/b' }]]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ['preview', 'confirm', 'retry', 'undo']); await new Promise((resolve) => server.close(resolve));
});

test('页面与 API 暴露动作历史、JSON 路径和备份导出', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated' }; },
    async loadLastScan() { return { items: [], failures: [], audit: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
    async actionHistory() { return { status: 'ok', entries: [{ project: 'a/b', action: 'unstar', status: 'failed', reason: 'temporary' }] }; },
    dataPath() { return '/tmp/github-organizer/data.json'; },
    async exportData() { return { status: 'succeeded', path: '/tmp/github-organizer/data.json.backup' }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  const page = await (await fetch('http://127.0.0.1:' + port + '/')).text();
  assert.match(page, /动作历史/); assert.match(page, /导出 JSON 备份/);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/history')).json()).entries.length, 1);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/data/path')).json()).path, '/tmp/github-organizer/data.json');
  const exported = await fetch('http://127.0.0.1:' + port + '/api/data/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await exported.json()).status, 'succeeded');
  await new Promise((resolve) => server.close(resolve));
});
