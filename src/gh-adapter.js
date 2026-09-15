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
    }
  };
}
