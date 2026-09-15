const DEFAULT_THRESHOLDS = Object.freeze({ noCommitMonths: 12, noReleaseMonths: 18, noActivityMonths: 6 });

function monthsAgo(date, months, now) {
  if (!date) return false;
  const then = new Date(date).getTime();
  if (!Number.isFinite(then)) return false;
  return now.getTime() - then >= months * 30.4375 * 24 * 60 * 60 * 1000;
}

function normalizeAuth(auth) {
  const state = auth?.state;
  if (state === 'authenticated' || state === 'not-installed' || state === 'not-logged-in') return { state, message: auth.message || '' };
  return { state: 'unknown', message: auth?.message || '无法确定 gh 认证状态' };
}

function normalizeRepo(repo, source, now, thresholds) {
  const fullName = repo.full_name || (repo.owner?.login && repo.name ? `${repo.owner.login}/${repo.name}` : null);
  if (!fullName || !fullName.includes('/')) return null;
  const owner = repo.owner?.login || fullName.split('/')[0];
  const name = repo.name || fullName.split('/')[1];
  const pushedAt = repo.pushed_at || repo.updated_at || null;
  const latestRelease = repo.latest_release?.published_at || repo.latest_release_at || null;
  const activityAt = repo.activity_at || repo.updated_at || null;
  const evidence = [];
  if (repo.archived) evidence.push({ code: 'archived', label: '仓库已归档', value: true });
  if (repo.disabled) evidence.push({ code: 'disabled', label: '仓库已禁用', value: true });
  if (repo.deprecated || repo.topics?.some?.((topic) => String(topic).toLowerCase() === 'deprecated')) evidence.push({ code: 'deprecated', label: '项目标记为 deprecated', value: true });
  if (monthsAgo(pushedAt, thresholds.noCommitMonths, now)) evidence.push({ code: 'no-recent-commit', label: `超过 ${thresholds.noCommitMonths} 个月无提交`, value: pushedAt });
  if (monthsAgo(latestRelease, thresholds.noReleaseMonths, now)) evidence.push({ code: 'no-recent-release', label: `超过 ${thresholds.noReleaseMonths} 个月无 Release`, value: latestRelease });
  if (monthsAgo(activityAt, thresholds.noActivityMonths, now)) evidence.push({ code: 'no-recent-activity', label: `超过 ${thresholds.noActivityMonths} 个月无 Issue/PR 活动`, value: activityAt });
  return {
    id: String(repo.id ?? fullName),
    owner,
    name,
    fullName,
    url: repo.html_url || `https://github.com/${fullName}`,
    relation: { starred: source === 'starred', owned: source === 'owned', fork: Boolean(repo.fork) },
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    deprecated: Boolean(repo.deprecated),
    latestCommitAt: pushedAt,
    latestReleaseAt: latestRelease,
    latestActivityAt: activityAt,
    healthSignals: evidence,
    priority: evidence.some((e) => e.code === 'archived' || e.code === 'deprecated') ? 'high' : evidence.length ? 'normal' : 'none',
    scannedAt: now.toISOString()
  };
}

function mergeRepo(map, repo, source, now, thresholds) {
  const item = normalizeRepo(repo, source, now, thresholds);
  if (!item) return { ok: false, reason: '项目条目缺少 full_name 或 owner/name' };
  const existing = map.get(item.fullName);
  if (!existing) { map.set(item.fullName, item); return { ok: true }; }
  existing.relation.starred ||= item.relation.starred;
  existing.relation.owned ||= item.relation.owned;
  existing.relation.fork ||= item.relation.fork;
  existing.archived ||= item.archived;
  existing.disabled ||= item.disabled;
  existing.deprecated ||= item.deprecated;
  existing.healthSignals = [...new Map([...existing.healthSignals, ...item.healthSignals].map((e) => [e.code, e])).values()];
  existing.priority = existing.healthSignals.some((e) => e.code === 'archived' || e.code === 'deprecated') ? 'high' : existing.healthSignals.length ? 'normal' : 'none';
  return { ok: true };
}

export function createOrchestrator({ github, store, clock = () => new Date(), thresholds = DEFAULT_THRESHOLDS }) {
  if (!github || !store) throw new TypeError('github and store are required');
  let latest = null;
  let progress = { completed: 0, total: 2, percent: 0, phase: 'idle' };
  return {
    async authStatus() { return normalizeAuth(await github.authStatus()); },
    async loadLastScan() { latest = latest || await store.load(); return latest; },
    getProgress() { return { ...progress }; },
    async scan(options = {}) {
      const auth = normalizeAuth(await github.authStatus());
      if (auth.state !== 'authenticated') {
        return { status: 'blocked', auth, items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } };
      }
      const now = clock();
      const effective = { ...DEFAULT_THRESHOLDS, ...thresholds, ...(options.thresholds || {}) };
      const failures = [];
      const map = new Map();
      const sources = [ ['starred', github.listStarred], ['owned', github.listOwned] ];
      let completedSources = 0;
      const reportProgress = (phase) => { progress = { phase, completed: completedSources, total: sources.length, percent: Math.round(completedSources / sources.length * 100) }; options.onProgress?.(progress); };
      reportProgress('starting');
      for (const [source, fn] of sources) {
        try {
          const repos = await fn.call(github);
          for (const repo of repos || []) {
            const merged = mergeRepo(map, repo, source, now, effective);
            if (!merged.ok) failures.push({ source, reason: merged.reason, item: repo?.full_name || repo?.name || 'unknown', at: now.toISOString() });
          }
        } catch (error) {
          failures.push({ source, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() });
        }
        completedSources += 1;
        reportProgress(source);
      }
      const items = [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      const result = {
        version: 1, status: failures.length ? 'completed-with-errors' : 'completed', auth,
        scannedAt: now.toISOString(), thresholds: effective, items, failures,
        summary: { total: items.length + failures.length, success: items.length, failed: failures.length },
        progress: { completed: completedSources, total: sources.length, percent: 100 }
      };
      latest = result;
      progress = { ...result.progress, phase: 'completed' };
      await store.save(result);
      return result;
    }
  };
}

export { DEFAULT_THRESHOLDS };
