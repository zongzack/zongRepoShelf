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

test('扫描期间页面轮询进度接口并在完成后停止轮询', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated', message: 'ok' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /async function pollScanProgress\(\)/);
    assert.match(page, /setInterval\(pollScanProgress,\s*500\)/);
    assert.match(page, /clearInterval\(progressTimer\)/);
    assert.match(page, /fetch\("\/api\/progress"\)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test('页面将项目详情放入 Dialog，并在列表行直接展示可用操作', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated', message: 'ok' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /function rowActionsHtml/);
    assert.match(page, /function openDetailDialog/);
    assert.match(page, /class="row-actions"/);
    assert.match(page, /data-row-action="unstar"/);
    assert.match(page, /data-row-action="assign"/);
    assert.match(page, /openLifecycleConfirmDialog\(item, action\)/);
    assert.match(page, /批量预览取消 Star/);
    assert.doesNotMatch(page, /id="detailPanel"/);
    assert.doesNotMatch(page, /data-row-menu-toggle/);
    assert.doesNotMatch(page, /<th>操作<\/th>/);
    assert.doesNotMatch(page, /在 GitHub 打开/);
    assert.doesNotMatch(page, /data-star-action/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('页面脚本将最近 commit 时间按北京时间格式化但不追加时区文案', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated', message: 'ok' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /function formatDateTime/);
    assert.match(page, /timeZone: "Asia\/Shanghai"/);
    assert.match(page, /i\.latestCommitAt \? formatDateTime\(i\.latestCommitAt\) : "无记录"/);
    assert.doesNotMatch(page, /北京时间/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('动作 API 只暴露预览、确认和撤销；旧直写入口被明确拒绝', async () => {
  const calls = [];
  const orchestrator = {
    async authStatus() { return { state: 'authenticated' }; },
    async loadLastScan() { return { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
    async previewActions(body) { calls.push(['preview', body]); return { status: 'preview', groups: { unstar: [], keep: [] }, actions: [], total: 0 }; },
    async confirmActions(body) { calls.push(['confirm', body]); return { status: 'completed', results: [], summary: { total: 0, success: 0, failed: 0 } }; },
    async undoStar(body) { calls.push(['undo', body]); return { status: 'not-found' }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  for (const [path, body] of [['/api/actions/preview', { selections: [] }], ['/api/actions/confirm', { previewId: 'x' }], ['/api/actions/undo', { fullName: 'a/b' }]]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200);
  }
  for (const path of ['/api/actions/retry', '/api/actions/retry-any', '/api/repositories/lifecycle/retry', '/api/repositories/archive', '/api/repositories/unarchive', '/api/repositories/delete']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /preview/);
  }
  assert.deepEqual(calls.map(([name]) => name), ['preview', 'confirm', 'undo']); await new Promise((resolve) => server.close(resolve));
});

test('页面与 API 暴露动作历史、JSON 路径和备份导出', async () => {
  const orchestrator = {
    async authStatus() { return { state: 'authenticated' }; },
    async loadLastScan() { return { items: [], failures: [], audit: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } }; },
    async actionHistory() { return { status: 'ok', entries: [{ project: 'a/b', action: 'unstar', status: 'failed', reason: 'temporary', time: '2026-09-29T12:34:56.000Z' }] }; },
    dataPath() { return '/tmp/github-organizer/data.json'; },
    async exportData() { return { status: 'succeeded', path: '/tmp/github-organizer/data.json.backup' }; }
  };
  const server = createServer({ orchestrator }); const port = await listen(server);
  const page = await (await fetch('http://127.0.0.1:' + port + '/')).text();
  assert.match(page, /动作历史/); assert.match(page, /导出 JSON 备份/);
  assert.match(page, /function historyActionLabel/); assert.match(page, /function historyStatusLabel/); assert.match(page, /时间：/); assert.match(page, /x\.time \|\| x\.at \|\| x\.createdAt/);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/history')).json()).entries.length, 1);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/data/path')).json()).path, '/tmp/github-organizer/data.json');
  const exported = await fetch('http://127.0.0.1:' + port + '/api/data/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await exported.json()).status, 'succeeded');
  await new Promise((resolve) => server.close(resolve));
});
