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

export function createGhAdapter({ runner = execFile } = {}) {
  async function apiJson(path) {
    const output = await runGh(['api', '-H', 'Accept: application/vnd.github+json', path], runner);
    return typeof output === 'string' ? JSON.parse(output) : output;
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
    async getHealthEvidence(fullName) {
      if (!fullName || !fullName.includes('/')) throw new TypeError('fullName is required');
      const evidence = { status: {} };
      try {
        const repo = await apiJson(`repos/${fullName}`);
        evidence.archived = Boolean(repo.archived); evidence.disabled = Boolean(repo.disabled);
        evidence.deprecated = Boolean(repo.deprecated) || (Array.isArray(repo.topics) && repo.topics.some((topic) => String(topic).toLowerCase() === 'deprecated'));
        evidence.latestCommitAt = repo.pushed_at || repo.updated_at || null;
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
      const output = await runGh(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', 'user/lists?per_page=100'], runner);
      return parsePages(output);
    },
    async listListRepositories(listId) {
      if (!listId) throw new TypeError('listId is required');
      const output = await runGh(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', `user/lists/${listId}/repos?per_page=100`], runner);
      return parsePages(output);
    },
    async addToList(listId, fullName) {
      [listId, fullName] = normalizeListArgs(listId, fullName);
      try { await runGh(['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', `user/lists/${listId}/repos/${fullName}`], runner); return { ok: true, listId, fullName, action: 'add' }; }
      catch (error) { throw new Error(`加入 List 失败：${friendlyGhError(error)}`); }
    },
    async removeFromList(listId, fullName) {
      [listId, fullName] = normalizeListArgs(listId, fullName);
      try { await runGh(['api', '--method', 'DELETE', '-H', 'Accept: application/vnd.github+json', `user/lists/${listId}/repos/${fullName}`], runner); return { ok: true, listId, fullName, action: 'remove' }; }
      catch (error) { throw new Error(`移出 List 失败：${friendlyGhError(error)}`); }
    },
    async setUniqueList(listId, fullName) {
      [listId, fullName] = normalizeListArgs(listId, fullName);
      return this.addToList(listId, fullName);
    },
    async createList(name, description = '') {
      if (!name?.trim()) throw new TypeError('name is required');
      try { const output = await runGh(['api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', '-f', `name=${name}`, '-f', `description=${description}`, 'user/lists'], runner); return typeof output === 'string' ? JSON.parse(output) : output; }
      catch (error) { throw new Error(`新建 List 失败：${friendlyGhError(error)}`); }
    },
    async renameList(listId, name) {
      if (!listId || !name?.trim()) throw new TypeError('listId and name are required');
      try { const output = await runGh(['api', '--method', 'PATCH', '-H', 'Accept: application/vnd.github+json', '-f', `name=${name}`, `user/lists/${listId}`], runner); return typeof output === 'string' ? JSON.parse(output) : output; }
      catch (error) { throw new Error(`重命名 List 失败：${friendlyGhError(error)}`); }
    },
    async deleteList(listId) {
      if (!listId) throw new TypeError('listId is required');
      try { await runGh(['api', '--method', 'DELETE', '-H', 'Accept: application/vnd.github+json', `user/lists/${listId}`], runner); return { ok: true, listId, action: 'delete' }; }
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
