import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/orchestrator.js';

const repo = (full_name, extra = {}) => ({ id: full_name, full_name, name: full_name.split('/')[1], owner: { login: full_name.split('/')[0] }, ...extra });
function memoryStore() { let value; return { async load() { return value; }, async save(v) { value = v; } }; }

function fixture() {
  const calls = [];
  const github = {
    async authStatus() { return { state: 'authenticated' }; },
    async listStarred() { return [repo('acme/starred', { topics: ['cli'], language: 'JavaScript' }), repo('acme/multi')]; },
    async listOwned() { return [repo('me/owned')]; },
    async listLists() { return [{ id: 1, name: '工具' }, { id: 2, name: '学习' }]; },
    async listListRepositories(id) { return id === '1' ? [repo('acme/multi')] : []; },
    async assignToList(id, name) { calls.push(['assign', id, name]); },
    async removeFromList(id, name) { calls.push(['remove', id, name]); },
  };
  return { github, calls, store: memoryStore() };
}

test('扫描结果包含 Lists 关系及数量统计', async () => {
  const f = fixture(); const result = await createOrchestrator(f).scan();
  assert.deepEqual(result.items.find((i) => i.fullName === 'acme/multi').lists, ['工具']);
  assert.equal(result.lists.find((l) => l.name === '工具').repositoryCount, 1);
});

test('扫描合并 GitHub Lists 时按项目条目名称大小写不敏感匹配', async () => {
  const github = {
    async authStatus() { return { state: 'authenticated' }; },
    async listStarred() { return [repo('GopeedLab/gopeed')]; },
    async listOwned() { return []; },
    async listLists() { return [{ id: 'sundry-id', name: 'sundry' }]; },
    async listListRepositories() { return [repo('gopeedlab/Gopeed')]; }
  };
  const result = await createOrchestrator({ github, store: memoryStore() }).scan();
  assert.deepEqual(result.items.find((i) => i.fullName === 'GopeedLab/gopeed').lists, ['sundry']);
  assert.equal(result.lists.find((l) => l.name === 'sundry').repositoryCount, 1);
});

test('归类到 List 会替换原归类，并拒绝已完成的重复归类', async () => {
  const f = fixture(); const orch = createOrchestrator(f); await orch.scan();
  const assignment = await orch.previewListActions({ selections: [{ fullName: 'acme/multi', list: '学习', action: 'assign' }] });
  assert.equal(assignment.groups.assign.length, 1);
  assert.equal(assignment.actions[0].replacesExistingList, true);
  const assigned = await orch.confirmListActions(assignment);
  assert.equal(assigned.summary.success, 1);
  assert.deepEqual((await f.store.load()).items.find((i) => i.fullName === 'acme/multi').lists, ['学习']);
  assert.deepEqual(f.calls, [['assign', '2', 'acme/multi']]);
  const duplicate = await orch.previewListActions({ selections: [{ fullName: 'acme/multi', list: '学习', action: 'assign' }] });
  assert.equal(duplicate.total, 0);
  assert.match(duplicate.invalid[0].reason, /已经归类/);
});

test('扫描发现远端多归类时保留一个可见归类并要求用户修正', async () => {
  const f = fixture();
  f.github.listListRepositories = async (id) => id === '1' || id === '2' ? [repo('acme/multi')] : [];
  const result = await createOrchestrator(f).scan();
  const item = result.items.find((entry) => entry.fullName === 'acme/multi');
  assert.deepEqual(item.lists, ['工具']);
  assert.deepEqual(item.listConflict.remoteLists, ['工具', '学习']);
  assert.match(result.failures.find((entry) => entry.item === 'acme/multi').reason, /多个 List/);
});

test('未 Star 的本人拥有仓库禁止 List 写操作', async () => {
  const f = fixture(); const orch = createOrchestrator(f); await orch.scan();
  const preview = await orch.previewListActions({ selections: [{ fullName: 'me/owned', list: '工具', action: 'assign' }] });
  assert.equal(preview.total, 0); assert.match(preview.invalid[0].reason, /未 Star/);
});

test('List 生命周期删除需要二次确认且规则解释可追溯', async () => {
  const f = fixture(); f.github.createList = async (name) => ({ id: 3, name }); f.github.renameList = async () => {}; f.github.deleteList = async () => {};
  const orch = createOrchestrator(f); await orch.scan(); await orch.createList({ name: '前端' });
  const renamed = await orch.renameList({ list: '前端', newName: '前端技术' }); assert.equal(renamed.status, 'succeeded');
  const pending = await orch.deleteList({ list: '前端技术' }); assert.equal(pending.status, 'confirmation-required');
  assert.equal((await orch.deleteList({ list: '前端技术', confirm: true })).status, 'succeeded');
  await orch.saveListRules({ rules: [{ type: 'topic', value: 'cli', list: '工具' }, { type: 'language', value: 'javascript', list: '工具' }] });
  const explanation = await orch.explainListRules({ fullName: 'acme/starred' }); assert.equal(explanation.matches.length, 2); assert.equal(explanation.matches[0].targetList, '工具');
});
