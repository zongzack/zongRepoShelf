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

test('健康信号在阈值边界命中并保留四类原始证据', async () => {
  const github = {
    async authStatus() { return { state: 'authenticated' }; },
    async listStarred() { return [repo('acme/legacy', { archived: true })]; },
    async listOwned() { return []; },
    async getHealthEvidence() {
      return {
        archived: true,
        disabled: false,
        deprecated: false,
        latestCommitAt: '2025-09-15T12:00:00.000Z',
        latestReleaseAt: '2024-03-15T12:00:00.000Z',
        latestActivityAt: '2026-03-15T12:00:00.000Z'
      };
    }
  };
  const result = await createOrchestrator({ github, store: memoryStore(), clock: () => new Date('2026-09-15T12:00:00.000Z') }).scan();
  const item = result.items[0];

  assert.deepEqual(item.evidence, {
    status: { archived: true, disabled: false, deprecated: false },
    latestCommitAt: '2025-09-15T12:00:00.000Z',
    latestReleaseAt: '2024-03-15T12:00:00.000Z',
    latestActivityAt: '2026-03-15T12:00:00.000Z'
  });
  assert.deepEqual(item.healthSignals.map((signal) => signal.code), [
    'archived',
    'no-recent-commit',
    'no-recent-release',
    'no-recent-activity'
  ]);
  assert.equal(item.recommendation.priority, 'high');
  assert.deepEqual(item.recommendation.reasons, item.healthSignals.map((signal) => signal.label));
});

test('调整阈值后可重新计算命中信号', async () => {
  const store = memoryStore();
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [repo('acme/fresh', { pushed_at: '2025-12-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' })]; }, async listOwned() { return []; } };
  const orchestrator = createOrchestrator({ github, store, clock: () => new Date('2026-09-15T00:00:00Z') });
  const scanned = await orchestrator.scan();
  assert.equal(scanned.items[0].healthSignals.some((signal) => signal.code === 'no-recent-commit'), false);
  const recalculated = await orchestrator.recalculate({ noCommitMonths: 1 });
  assert.equal(recalculated.thresholds.noCommitMonths, 1);
  assert.equal(recalculated.items[0].healthSignals.some((signal) => signal.code === 'no-recent-commit'), true);
});

test('缺失 release 与活动数据依然可解释', async () => {
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [repo('acme/no-data', { pushed_at: '2026-09-01T00:00:00Z' })]; }, async listOwned() { return []; } };
  const result = await createOrchestrator({ github, store: memoryStore(), clock: () => new Date('2026-09-15T00:00:00Z') }).scan();
  const codes = result.items[0].healthSignals.map((signal) => signal.code);
  assert.ok(codes.includes('no-recent-release'));
  assert.ok(codes.includes('no-recent-activity'));
  assert.match(result.items[0].recommendation.summary, /建议/);
});

test('月末阈值按日历月正确计算', async () => {
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [repo('acme/calendar', { pushed_at: '2026-03-02T00:00:00Z', latest_release_at: '2026-03-02T00:00:00Z', activity_at: '2026-03-02T00:00:00Z' })]; }, async listOwned() { return []; } };
  const result = await createOrchestrator({ github, store: memoryStore(), clock: () => new Date('2026-03-31T00:00:00Z') }).scan({ thresholds: { noCommitMonths: 1, noReleaseMonths: 1, noActivityMonths: 1 } });
  assert.equal(result.items[0].healthSignals.some((signal) => signal.code === 'no-recent-commit'), false);
});
