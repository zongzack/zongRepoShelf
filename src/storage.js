import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createJsonStore(filePath) {
  if (!filePath) throw new TypeError('filePath is required');
  return {
    filePath,
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
    async save(value) {
      await mkdir(dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const json = JSON.stringify(value, (_key, v) => {
        if (typeof v === 'string' && (/token|authorization/i.test(_key) || /^gh[pousr]_[A-Za-z0-9_]+$/.test(v))) return undefined;
        if (_key === 'body' && typeof v === 'string') return undefined;
        return v;
      }, 2) + '\n';
      await writeFile(tempPath, json, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, filePath);
      return value;
    }
  };
}

export function defaultDataPath(env = process.env, platform = process.platform) {
  if (env.GITHUB_ORGANIZER_DATA) return env.GITHUB_ORGANIZER_DATA;
  if (platform === 'win32') return `${env.APPDATA || '.'}/github-organizer/data.json`;
  return `${env.XDG_DATA_HOME || `${env.HOME || '.'}/.local/share`}/github-organizer/data.json`;
}
