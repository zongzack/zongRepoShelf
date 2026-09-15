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
    }
  };
}
