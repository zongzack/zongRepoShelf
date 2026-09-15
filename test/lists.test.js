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
    async addToList(id, name) { calls.push(['add', id, name]); },
    async removeFromList(id, name) { calls.push(['remove', id, name]); },
    async setUniqueList(id, name) { calls.push(['unique', id, name]); }
  };
  return { github, calls, store: memoryStore() };
}

test('扫描结果包含 Lists 关系及数量统计', async () => {
  const f = fixture(); const result = await createOrchestrator(f).scan();
  assert.deepEqual(result.items.find((i) => i.fullName === 'acme/multi').lists, ['工具']);
  assert.equal(result.lists.find((l) => l.name === '工具').repositoryCount, 1);
});

test('加入 List 默认保留其他关系，唯一归类需要单独确认', async () => {
  const f = fixture(); const orch = createOrchestrator(f); await orch.scan();
  const add = await orch.previewListActions({ selections: [{ fullName: 'acme/multi', list: '学习', action: 'add' }] });
  const added = await orch.confirmListActions(add); assert.equal(added.summary.success, 1); assert.deepEqual((await f.store.load()).items.find((i) => i.fullName === 'acme/multi').lists.sort(), ['学习', '工具']);
  const unique = await orch.previewListActions({ selections: [{ fullName: 'acme/multi', list: '学习', action: 'unique' }] });
  const blocked = await orch.confirmListActions(unique); assert.equal(blocked.summary.failed, 1); assert.match(blocked.results[0].reason, /单独确认/);
  const ok = await orch.confirmListActions({ previewId: unique.id, confirmUnique: true }); assert.equal(ok.summary.success, 1); assert.deepEqual((await f.store.load()).items.find((i) => i.fullName === 'acme/multi').lists, ['学习']);
});

test('未 Star 的本人拥有仓库禁止 List 写操作', async () => {
  const f = fixture(); const orch = createOrchestrator(f); await orch.scan();
  const preview = await orch.previewListActions({ selections: [{ fullName: 'me/owned', list: '工具', action: 'add' }] });
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
