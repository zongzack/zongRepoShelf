import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/orchestrator.js';

const repo = (fullName, extra = {}) => ({ id: fullName, full_name: fullName, name: fullName.split('/')[1], owner: { login: fullName.split('/')[0] }, default_branch: 'main', pushed_at: '2026-09-01T00:00:00Z', ...extra });
function memoryStore() { let value; return { async load() { return value; }, async save(v) { value = structuredClone(v); } }; }

test('扫描自有原始仓库和 fork，保留关系与身份证据', async () => {
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [repo('other/project')]; }, async listOwned() { return [repo('me/original'), repo('me/fork', { fork: true, parent: { full_name: 'other/project' } })]; } };
  const result = await createOrchestrator({ github, store: memoryStore() }).scan();
  const fork = result.items.find((item) => item.fullName === 'me/fork');
  assert.equal(fork.relation.owned, true); assert.equal(fork.relation.fork, true); assert.equal(fork.relation.forkOriginal, 'other/project');
  assert.equal(fork.evidence.defaultBranch, 'main'); assert.equal(fork.evidence.latestCommitAt, '2026-09-01T00:00:00Z');
  assert.equal(result.items.find((item) => item.fullName === 'other/project').relation.owned, false);
});

test('Archive/Unarchive 仅允许自有仓库并保留失败项', async () => {
  const store = memoryStore(); const calls = []; let fail = true;
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return [repo('other/project')]; }, async listOwned() { return [repo('me/repo')]; }, async archive(name) { calls.push(['archive', name]); if (fail) throw new Error('403 Forbidden'); }, async unarchive(name) { calls.push(['unarchive', name]); } };
  const orch = createOrchestrator({ github, store }); await orch.scan();
  const preview = await orch.previewLifecycleActions({ selections: [{ fullName: 'other/project', action: 'archive' }, { fullName: 'me/repo', action: 'archive' }] });
  assert.equal(preview.total, 1); assert.match(preview.invalid[0].reason, /本人拥有/);
  const failed = await orch.confirmLifecycleActions({ previewId: preview.id, actions: preview.actions, confirm: true }); assert.equal(failed.summary.failed, 1); assert.equal((await store.load()).items[0].fullName, 'me/repo');
  fail = false; const retried = await orch.retryLifecycleAction({ fullName: 'me/repo', confirm: true }); assert.equal(retried.summary.success, 1); assert.deepEqual(calls, [['archive', 'me/repo'], ['archive', 'me/repo']]);
});

test('删除需要二次确认、完整名称并先写审计，失败可重试', async () => {
  const store = memoryStore(); let attempts = 0;
  const github = { async authStatus() { return { state: 'authenticated' }; }, async listStarred() { return []; }, async listOwned() { return [repo('me/fork', { fork: true, parent: { full_name: 'upstream/base' } })]; }, async deleteRepository() { attempts++; if (attempts === 1) throw new Error('permission denied'); } };
  const orch = createOrchestrator({ github, store }); await orch.scan(); const preview = await orch.previewLifecycleActions({ selections: [{ fullName: 'me/fork', action: 'delete' }] });
  const blocked = await orch.confirmLifecycleActions({ previewId: preview.id, actions: preview.actions, confirm: true, confirmFullName: 'wrong/name' }); assert.equal(blocked.status, 'confirmation-required'); assert.match(blocked.error, /完整 owner\/repo/);
  const failed = await orch.confirmLifecycleActions({ previewId: preview.id, actions: preview.actions, confirm: true, confirmFullName: 'me/fork' }); assert.equal(failed.summary.failed, 1); assert.equal((await store.load()).audit.at(-1).status, 'failed');
  const retried = await orch.retryLifecycleAction({ fullName: 'me/fork', confirm: true, confirmFullName: 'me/fork' }); assert.equal(retried.summary.success, 1); assert.equal(attempts, 2);
});
