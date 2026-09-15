import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/orchestrator.js';

const repo = (full_name, extra = {}) => ({ id: extra.id ?? full_name, full_name, name: full_name.split('/')[1], owner: { login: full_name.split('/')[0] }, ...extra });

function memoryStore() { let value; return { async load() { return value; }, async save(v) { value = v; } }; }

test('认证不可用时扫描被门禁且不调用 GitHub', async () => {
  let called = false;
  const github = { async authStatus() { return { state: 'not-installed', message: '请安装 gh' }; }, async listStarred() { called = true; return []; }, async listOwned() { called = true; return []; } };
  const result = await createOrchestrator({ github, store: memoryStore() }).scan();
  assert.equal(result.status, 'blocked');
  assert.equal(result.auth.state, 'not-installed');
  assert.equal(called, false);
});

test('只有显式 scan 调用才读取并去重 Star/owned 项目', async () => {
  let starredCalls = 0;
  const github = { async authStatus() { return { state: 'authenticated', message: 'ok' }; }, async listStarred() { starredCalls++; return [repo('acme/a', { starred_at: '2025-01-01T00:00:00Z' }), repo('acme/shared')]; }, async listOwned() { return [repo('acme/shared', { fork: true }), repo('me/my-repo')]; } };
  const orchestrator = createOrchestrator({ github, store: memoryStore() });
  assert.equal(starredCalls, 0);
  const result = await orchestrator.scan();
  assert.equal(starredCalls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.success, 3);
  const shared = result.items.find((i) => i.fullName === 'acme/shared');
  assert.deepEqual(shared.relation, { starred: true, owned: true, fork: true });
});

test('局部读取失败会计入失败并保留失败原因', async () => {
  const github = { async authStatus() { return { state: 'authenticated', message: 'ok' }; }, async listStarred() { return [repo('ok/repo')]; }, async listOwned() { throw new Error('rate limit exceeded'); } };
  const result = await createOrchestrator({ github, store: memoryStore() }).scan();
  assert.equal(result.status, 'completed-with-errors');
  assert.equal(result.summary.success, 1);
  assert.equal(result.summary.failed, 1);
  assert.match(result.failures[0].reason, /rate limit/);
});

test('最近扫描可通过单个 JSON 存储重新加载', async () => {
  const store = memoryStore();
  const github = { async authStatus() { return { state: 'authenticated', message: 'ok' }; }, async listStarred() { return [repo('a/b')]; }, async listOwned() { return []; } };
  const orchestrator = createOrchestrator({ github, store });
  const saved = await orchestrator.scan();
  const loaded = await orchestrator.loadLastScan();
  assert.equal(loaded.items[0].fullName, saved.items[0].fullName);
});

test('畸形项目条目会保留为可见失败记录', async () => {
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [{ name: 'missing-owner' }]; }, async listOwned() { return []; } };
  const result = await createOrchestrator({ github, store: memoryStore() }).scan();
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failures[0].item, 'missing-owner');
});
