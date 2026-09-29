import test from 'node:test';
import assert from 'node:assert/strict';

import { createGhAdapter } from '../src/gh-adapter.js';

test('GitHub Lists 通过 GraphQL 读取，并缓存每个 List 的项目条目', async () => {
  const calls = [];
  const adapter = createGhAdapter({
    async runner(command, args) {
      calls.push([command, args]);
      assert.equal(command, 'gh');
      assert.equal(args[0], 'api');
      assert.equal(args[1], 'graphql');
      const query = args.at(-1);
      if (query.includes('viewer { lists')) return {
        stdout: JSON.stringify({ data: { viewer: { lists: { nodes: [{ id: 'UL_1', name: '工具', description: '常用工具', isPrivate: true, items: { totalCount: 1 } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      };
      return {
        stdout: JSON.stringify({ data: { node: { items: { nodes: [{ id: 'R_1', nameWithOwner: 'acme/tool' }], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      };
    },
  });

  const lists = await adapter.listLists();

  assert.deepEqual(lists, [
    {
      id: 'UL_1',
      name: '工具',
      description: '常用工具',
      private: true,
      repositoryCount: 1,
    },
  ]);
  assert.deepEqual(await adapter.listListRepositories('UL_1'), [
    { id: 'R_1', full_name: 'acme/tool' },
  ]);
  assert.equal(calls.length, 2);
  assert.match(calls[0][1].at(-1), /viewer\s*\{\s*lists/);
});

test('GitHub Lists 和 List 内项目均会读取所有 GraphQL 分页', async () => {
  const queries = [];
  const adapter = createGhAdapter({
    async runner(_command, args) {
      const query = args.at(-1);
      queries.push(query);
      if (query.includes('viewer { lists')) {
        const second = query.includes('after: "list-cursor"');
        return {
          stdout: JSON.stringify({ data: { viewer: { lists: {
            nodes: second ? [{ id: 'UL_2', name: '第二页', description: '', isPrivate: true, items: { totalCount: 0 } }] : [{ id: 'UL_1', name: '第一页', description: '', isPrivate: true, items: { totalCount: 2 } }],
            pageInfo: second ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'list-cursor' },
          } } } }),
        };
      }
      const second = query.includes('after: "member-cursor"');
      return {
        stdout: JSON.stringify({ data: { node: { items: {
          nodes: second ? [{ id: 'R_2', nameWithOwner: 'acme/second' }] : [{ id: 'R_1', nameWithOwner: 'acme/first' }],
          pageInfo: second ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'member-cursor' },
        } } } }),
      };
    },
  });

  assert.equal((await adapter.listLists()).length, 2);
  assert.deepEqual(await adapter.listListRepositories('UL_1'), [
    { id: 'R_1', full_name: 'acme/first' },
    { id: 'R_2', full_name: 'acme/second' },
  ]);
  assert.equal(queries.some((query) => query.includes('after: "list-cursor"')), true);
  assert.equal(queries.some((query) => query.includes('after: "member-cursor"')), true);
});

test('归类到 List 会替换已有归类，并通过 GraphQL 一次更新关系', async () => {
  const queries = [];
  const adapter = createGhAdapter({
    async runner(_command, args) {
      const query = args.at(-1);
      queries.push(query);
      if (query.includes('repository(owner:')) return { stdout: JSON.stringify({ data: { repository: { id: 'R_1' } } }) };
      if (query.includes('viewer { lists')) return {
        stdout: JSON.stringify({ data: { viewer: { lists: { nodes: [{ id: 'UL_current', name: '已有归类', description: '', isPrivate: true, items: { totalCount: 1 } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      };
      if (query.includes('node(id:')) return {
        stdout: JSON.stringify({ data: { node: { items: { nodes: [{ id: 'R_1', nameWithOwner: 'acme/tool' }], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      };
      return { stdout: JSON.stringify({ data: { updateUserListsForItem: { lists: [] } } }) };
    },
  });

  await adapter.assignToList('UL_target', 'acme/tool');

  assert.equal(queries.length, 4);
  assert.match(queries[3], /updateUserListsForItem/);
  assert.match(queries[3], /listIds:\s*\["UL_target"\]/);
});
