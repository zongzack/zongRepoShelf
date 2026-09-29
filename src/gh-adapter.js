import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(nodeExecFile);

async function runGh(args, runner = execFile) {
  const result = await runner('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return result?.stdout ?? result;
}

function parsePages(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return parsed;
  return parsed.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function normalizeListArgs(listId, fullName) {
  if (String(listId).includes('/') && !String(fullName).includes('/')) [listId, fullName] = [fullName, listId];
  if (!listId || !fullName?.includes('/')) throw new TypeError('listId and fullName are required');
  return [listId, fullName];
}

function graphQlString(value) {
  return JSON.stringify(String(value));
}

function parseGraphQl(output) {
  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
  if (parsed?.errors?.length) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed?.data ?? parsed;
}

export function createGhAdapter({ runner = execFile } = {}) {
  let listRepositoryCache = new Map();
  async function apiJson(path) {
    const output = await runGh(['api', '-H', 'Accept: application/vnd.github+json', path], runner);
    return typeof output === 'string' ? JSON.parse(output) : output;
  }
  async function graphQl(query) {
    const output = await runGh(['api', 'graphql', '-f', `query=${query}`], runner);
    return parseGraphQl(output);
  }
  async function listStateForRepository(fullName) {
    if (!fullName?.includes('/')) throw new TypeError('fullName is required');
    const [owner, name] = fullName.split('/');
    const state = await graphQl(`query { repository(owner: ${graphQlString(owner)}, name: ${graphQlString(name)}) { id } }`);
    const repositoryId = state.repository?.id;
    if (!repositoryId) throw new Error(`找不到项目条目：${fullName}`);
    const listIds = [];
    for (const list of await listAllLists()) {
      const members = await listRepositoriesForList(list.id);
      if (members.some((item) => item.full_name === fullName)) listIds.push(String(list.id));
    }
    return { repositoryId, listIds };
  }
  async function replaceRepositoryLists(repositoryId, listIds) {
    await graphQl(`mutation { updateUserListsForItem(input: { itemId: ${graphQlString(repositoryId)}, listIds: [${listIds.map(graphQlString).join(',')}] }) { lists { id name } } }`);
    listRepositoryCache = new Map();
  }
  async function listAllLists() {
    const lists = [];
    let after = null;
    do {
      const cursor = after ? `, after: ${graphQlString(after)}` : '';
      const result = await graphQl(`query { viewer { lists(first: 100${cursor}) { nodes { id name description isPrivate items { totalCount } } pageInfo { hasNextPage endCursor } } } }`);
      const connection = result.viewer?.lists || {};
      lists.push(...(connection.nodes || []));
      after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return lists;
  }
  async function listRepositoriesForList(listId) {
    const cached = listRepositoryCache.get(String(listId));
    if (cached) return cached;
    const repositories = [];
    let after = null;
    do {
      const cursor = after ? `, after: ${graphQlString(after)}` : '';
      const result = await graphQl(`query { node(id: ${graphQlString(listId)}) { ... on UserList { items(first: 100${cursor}) { nodes { ... on Repository { id nameWithOwner } } pageInfo { hasNextPage endCursor } } } } }`);
      const connection = result.node?.items || {};
      repositories.push(...(connection.nodes || [])
        .filter((item) => item?.nameWithOwner)
        .map((item) => ({ id: item.id, full_name: item.nameWithOwner })));
      after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    listRepositoryCache.set(String(listId), repositories);
    return repositories;
  }
  return {
    async authStatus() {
      try { await runGh(['auth', 'status', '--hostname', 'github.com'], runner); return { state: 'authenticated', message: 'GitHub CLI 已登录' }; }
      catch (error) {
        const text = `${error?.stderr || ''} ${error?.message || ''}`;
        if (error?.code === 'ENOENT' || /not found|找不到/i.test(text)) return { state: 'not-installed', message: '未找到 gh，请安装 GitHub CLI' };
        if (/not logged in|not authenticated|登录/i.test(text)) return { state: 'not-logged-in', message: 'gh 尚未登录，请运行 gh auth login' };
        return { state: 'not-logged-in', message: 'gh 未通过认证，请运行 gh auth login' };
      }
    },
    async listStarred() {
      const output = await runGh(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', 'user/starred?per_page=100'], runner);
      return parsePages(output);
    },
    async listOwned() {
      const output = await runGh(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', 'user/repos?affiliation=owner&per_page=100&sort=updated'], runner);
      return parsePages(output);
    },
    async unstar(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      try { await runGh(['api', '--method', 'DELETE', '-H', 'Accept: application/vnd.github+json', `user/starred/${fullName}`], runner); return { ok: true, fullName, action: 'unstar' }; }
      catch (error) { throw new Error(`取消 ${fullName} 的 Star 失败：${friendlyGhError(error)}`); }
    },
    async star(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      try { await runGh(['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', `user/starred/${fullName}`], runner); return { ok: true, fullName, action: 'star' }; }
      catch (error) { throw new Error(`恢复 ${fullName} 的 Star 失败：${friendlyGhError(error)}`); }
    },
    async isStarred(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      try { await runGh(['api', '-H', 'Accept: application/vnd.github+json', `user/starred/${fullName}`], runner); return true; }
      catch (error) {
        const text = `${error?.stderr || ''} ${error?.message || ''}`;
        if (error?.status === 404 || error?.code === 404 || /\b404\b|not found/i.test(text)) return false;
        throw new Error(`检查 ${fullName} 的 Star 状态失败：${friendlyGhError(error)}`);
      }
    },
    async setArchived(fullName, archived) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      try {
        await runGh(['api', '--method', 'PATCH', '-H', 'Accept: application/vnd.github+json', '-F', `archived=${Boolean(archived)}`, `repos/${fullName}`], runner);
        return { ok: true, fullName, action: archived ? 'archive' : 'unarchive', archived: Boolean(archived) };
      } catch (error) { throw new Error(`${archived ? '归档' : '取消归档'} ${fullName} 失败：${friendlyGhError(error)}`); }
    },
    async archive(fullName) { return this.setArchived(fullName, true); },
    async unarchive(fullName) { return this.setArchived(fullName, false); },
    async archiveRepository(fullName) { return this.setArchived(fullName, true); },
    async unarchiveRepository(fullName) { return this.setArchived(fullName, false); },
    async deleteRepository(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      try {
        await runGh(['api', '--method', 'DELETE', '-H', 'Accept: application/vnd.github+json', `repos/${fullName}`], runner);
        return { ok: true, fullName, action: 'delete' };
      } catch (error) { throw new Error(`删除 ${fullName} 失败：${friendlyGhError(error)}`); }
    },
    async getHealthEvidence(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      const evidence = { status: {} };
      try {
        const repo = await apiJson(`repos/${fullName}`);
        evidence.archived = Boolean(repo.archived); evidence.disabled = Boolean(repo.disabled);
        evidence.deprecated = Boolean(repo.deprecated) || (Array.isArray(repo.topics) && repo.topics.some((topic) => String(topic).toLowerCase() === 'deprecated'));
        evidence.latestCommitAt = repo.pushed_at || repo.updated_at || null;
        evidence.defaultBranch = repo.default_branch || null;
        evidence.forkOriginal = repo.parent?.full_name || repo.source?.full_name || null;
        try {
          const commits = await apiJson(`repos/${fullName}/commits?per_page=1`);
          const latest = Array.isArray(commits) ? commits[0] : null;
          evidence.latestCommitAt = latest?.commit?.committer?.date || latest?.commit?.author?.date || evidence.latestCommitAt;
        } catch { /* 保留仓库元数据中的 pushed_at 作为降级证据 */ }
      } catch (error) {
        throw new Error(`读取 ${fullName} 项目条目状态失败：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const release = await apiJson(`repos/${fullName}/releases/latest`);
        evidence.latestReleaseAt = release?.published_at || release?.created_at || null;
      } catch (error) {
        const text = `${error?.stderr || ''} ${error?.message || ''}`;
        if (/404|not found/i.test(text) || error?.status === 404) evidence.latestReleaseAt = null;
        else { evidence.latestReleaseAt = null; evidence.unavailable = { ...(evidence.unavailable || {}), release: '读取 Release 失败' }; }
      }
      try {
        const activity = await apiJson(`search/issues?q=repo:${fullName}&sort=updated&order=desc&per_page=1`);
        evidence.latestActivityAt = activity?.items?.[0]?.updated_at || null;
      } catch {
        evidence.latestActivityAt = null; evidence.unavailable = { ...(evidence.unavailable || {}), activity: '读取 Issue/PR 活动失败' };
      }
      return evidence;
    },
    async listLists() {
      listRepositoryCache = new Map();
      return (await listAllLists()).map((list) => ({
        id: String(list.id),
        name: list.name,
        description: list.description || '',
        private: Boolean(list.isPrivate),
        repositoryCount: Number(list.items?.totalCount || 0),
      }));
    },
    async listListRepositories(listId) {
      if (!listId) throw new TypeError('listId is required');
      return listRepositoriesForList(listId);
    },
    async assignToList(listId, fullName) {
      [listId, fullName] = normalizeListArgs(listId, fullName);
      try { const state = await listStateForRepository(fullName); await replaceRepositoryLists(state.repositoryId, [String(listId)]); return { ok: true, listId, fullName, action: 'assign' }; }
      catch (error) { throw new Error(`归类到 List 失败：${friendlyGhError(error)}`); }
    },
    async addToList(listId, fullName) {
      return this.assignToList(listId, fullName);
    },
    async removeFromList(listId, fullName) {
      [listId, fullName] = normalizeListArgs(listId, fullName);
      try { const state = await listStateForRepository(fullName); await replaceRepositoryLists(state.repositoryId, state.listIds.filter((id) => id !== String(listId))); return { ok: true, listId, fullName, action: 'remove' }; }
      catch (error) { throw new Error(`移出 List 失败：${friendlyGhError(error)}`); }
    },
    async setUniqueList(listId, fullName) {
      return this.assignToList(listId, fullName);
    },
    async createList(name, description = '') {
      if (!name?.trim()) throw new TypeError('name is required');
      try { const result = await graphQl(`mutation { createUserList(input: { name: ${graphQlString(name)}, description: ${graphQlString(description)} }) { list { id name description isPrivate } } }`); const list = result.createUserList?.list; return { id: list?.id, name: list?.name, description: list?.description || '', private: Boolean(list?.isPrivate) }; }
      catch (error) { throw new Error(`新建 List 失败：${friendlyGhError(error)}`); }
    },
    async renameList(listId, name) {
      if (!listId || !name?.trim()) throw new TypeError('listId and name are required');
      try { const result = await graphQl(`mutation { updateUserList(input: { listId: ${graphQlString(listId)}, name: ${graphQlString(name)} }) { list { id name description isPrivate } } }`); const list = result.updateUserList?.list; return { id: list?.id, name: list?.name, description: list?.description || '', private: Boolean(list?.isPrivate) }; }
      catch (error) { throw new Error(`重命名 List 失败：${friendlyGhError(error)}`); }
    },
    async deleteList(listId) {
      if (!listId) throw new TypeError('listId is required');
      try { await graphQl(`mutation { deleteUserList(input: { listId: ${graphQlString(listId)} }) { clientMutationId } }`); return { ok: true, listId, action: 'delete' }; }
      catch (error) { throw new Error(`删除 List 失败：${friendlyGhError(error)}`); }
    }
  };
}

function friendlyGhError(error) {
  const text = `${error?.stderr || ''} ${error?.message || ''}`.trim();
  if (/rate limit|secondary rate limit/i.test(text)) return 'GitHub 请求受限（rate limit），请稍后重试';
  if (/403|forbidden|permission/i.test(text)) return 'GitHub 权限不足（403 Forbidden）';
  if (/404|not found/i.test(text)) return 'GitHub 找不到该项目条目（404 Not Found）';
  return text || 'GitHub 返回未知错误';
}
