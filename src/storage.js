import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function createJsonStore(filePath) {
  if (!filePath) throw new TypeError('filePath is required');
  const sanitize = (value, key = '') => {
    if (typeof value === 'string') {
      if (/(?:token|authorization|password|secret|api[-_]?key)/i.test(key) || /^gh[pousr]_[A-Za-z0-9_]+$/.test(value)) return undefined;
      if (/(?:^|[_-])(body|readme|content|markdown|html)(?:$|[_-])/i.test(key) || /(?:issue|pull[-_]?request|pr)[-_]?(?:body|content|text)/i.test(key)) return undefined;
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key)).filter((entry) => entry !== undefined);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
        const sanitized = sanitize(childValue, childKey);
        return sanitized === undefined ? [] : [[childKey, sanitized]];
      }));
    }
    return value;
  };
  return {
    filePath,
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
    async save(value) {
      await mkdir(dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const json = JSON.stringify(sanitize(value), null, 2) + '\n';
      await writeFile(tempPath, json, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, filePath);
      return value;
    },
    async backup(destination) {
      if (!destination) throw new TypeError('destination is required');
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(filePath, destination);
      return destination;
    }
  };
}

/**
 * Resolve the runtime data file. By default it lives in the repository root
 * (the directory containing `src/`'s parent), so the application keeps its
 * local state alongside the project and the path can be ignored by Git.
 * `GITHUB_ORGANIZER_DATA` remains available for explicit deployments.
 */
export function defaultDataPath(env = process.env, platform = process.platform, projectRoot = process.cwd()) {
  if (env.GITHUB_ORGANIZER_DATA) return env.GITHUB_ORGANIZER_DATA;
  return resolve(projectRoot, 'data.json');
}
