const DEFAULT_THRESHOLDS = Object.freeze({ noCommitMonths: 12, noReleaseMonths: 18, noActivityMonths: 6 });

function normalizeThresholds(input = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_THRESHOLDS)) {
    const value = Number(input[key]);
    result[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return result;
}

function monthsAgo(date, months, now) {
  if (!date) return true;
  const then = new Date(date).getTime();
  if (!Number.isFinite(then)) return true;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return then <= cutoff.getTime();
}

function normalizeAuth(auth) {
  const state = auth?.state;
  if (state === 'authenticated' || state === 'not-installed' || state === 'not-logged-in') return { state, message: auth.message || '' };
  return { state: 'unknown', message: auth?.message || '无法确定 gh 认证状态' };
}

function firstDefined(...values) { return values.find((value) => value !== undefined); }

function buildSignals(evidence, thresholds, now) {
  const signals = [];
  const status = evidence.status;
  if (status.archived) signals.push({ code: 'archived', category: 'status', label: '仓库已归档', value: true });
  if (status.disabled) signals.push({ code: 'disabled', category: 'status', label: '仓库已禁用', value: true });
  if (status.deprecated) signals.push({ code: 'deprecated', category: 'status', label: '项目标记为 deprecated', value: true });
  const recency = [
    ['latestCommitAt', 'no-recent-commit', thresholds.noCommitMonths, '提交', '无提交记录'],
    ['latestReleaseAt', 'no-recent-release', thresholds.noReleaseMonths, 'Release', '从未发布 Release'],
    ['latestActivityAt', 'no-recent-activity', thresholds.noActivityMonths, 'Issue/PR 活动', '无 Issue/PR 活动记录']
  ];
  for (const [field, code, months, subject, missingLabel] of recency) {
    const value = evidence[field];
    const category = field.replace('latest', '').replace('At', '').toLowerCase();
    if (!value) signals.push({ code, category, label: missingLabel, value: null, thresholdMonths: months });
    else if (monthsAgo(value, months, now)) signals.push({ code, category, label: `超过 ${months} 个月无${subject}`, value, thresholdMonths: months });
  }
  return signals;
}

function buildRecommendation(signals) {
  const highPriority = signals.some((signal) => signal.code === 'archived' || signal.code === 'deprecated');
  const priority = highPriority ? 'high' : signals.length ? 'normal' : 'none';
  return { priority, summary: priority === 'high' ? '建议优先审阅：项目状态显示维护已终止或被标记 deprecated' : priority === 'normal' ? '建议审阅：检测到维护信号' : '暂无整理建议', reasons: signals.map((signal) => signal.label), automaticAction: null };
}

function normalizeRepo(repo, source, now, thresholds, supplemental = {}) {
  const fullName = repo.full_name || (repo.owner?.login && repo.name ? `${repo.owner.login}/${repo.name}` : null);
  if (!fullName || !fullName.includes('/')) return null;
  const owner = repo.owner?.login || fullName.split('/')[0];
  const name = repo.name || fullName.split('/')[1];
  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  const status = { archived: Boolean(firstDefined(supplemental.archived, repo.archived, false)), disabled: Boolean(firstDefined(supplemental.disabled, repo.disabled, false)), deprecated: Boolean(firstDefined(supplemental.deprecated, repo.deprecated, topics.some((topic) => String(topic).toLowerCase() === 'deprecated'))) };
  const evidence = { status, latestCommitAt: firstDefined(supplemental.latestCommitAt, repo.latestCommitAt, repo.latest_commit_at, repo.pushed_at, repo.updated_at, null), latestReleaseAt: firstDefined(supplemental.latestReleaseAt, repo.latestReleaseAt, repo.latest_release_at, repo.latest_release?.published_at, null), latestActivityAt: firstDefined(supplemental.latestActivityAt, repo.latestActivityAt, repo.activity_at, repo.updated_at, null) };
  const healthSignals = buildSignals(evidence, thresholds, now);
  const recommendation = buildRecommendation(healthSignals);
  return { id: String(repo.id ?? fullName), owner, name, fullName, url: repo.html_url || `https://github.com/${fullName}`, relation: { starred: source === 'starred', owned: source === 'owned', fork: Boolean(repo.fork) }, archived: status.archived, disabled: status.disabled, deprecated: status.deprecated, latestCommitAt: evidence.latestCommitAt, latestReleaseAt: evidence.latestReleaseAt, latestActivityAt: evidence.latestActivityAt, evidence, healthSignals, recommendation, priority: recommendation.priority, scannedAt: now.toISOString() };
}

function mergeDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const ta = new Date(a).getTime(); const tb = new Date(b).getTime();
  return Number.isFinite(tb) && (!Number.isFinite(ta) || tb > ta) ? b : a;
}

function mergeRepo(map, repo, source, now, thresholds) {
  const item = normalizeRepo(repo, source, now, thresholds);
  if (!item) return { ok: false, reason: '项目条目缺少 full_name 或 owner/name' };
  const existing = map.get(item.fullName);
  if (!existing) { map.set(item.fullName, item); return { ok: true }; }
  existing.relation.starred ||= item.relation.starred; existing.relation.owned ||= item.relation.owned; existing.relation.fork ||= item.relation.fork;
  existing.archived ||= item.archived; existing.disabled ||= item.disabled; existing.deprecated ||= item.deprecated;
  existing.evidence.status = { archived: existing.archived, disabled: existing.disabled, deprecated: existing.deprecated };
  existing.evidence.latestCommitAt = mergeDate(existing.evidence.latestCommitAt, item.evidence.latestCommitAt); existing.evidence.latestReleaseAt = mergeDate(existing.evidence.latestReleaseAt, item.evidence.latestReleaseAt); existing.evidence.latestActivityAt = mergeDate(existing.evidence.latestActivityAt, item.evidence.latestActivityAt);
  existing.latestCommitAt = existing.evidence.latestCommitAt; existing.latestReleaseAt = existing.evidence.latestReleaseAt; existing.latestActivityAt = existing.evidence.latestActivityAt;
  existing.healthSignals = buildSignals(existing.evidence, thresholds, now); existing.recommendation = buildRecommendation(existing.healthSignals); existing.priority = existing.recommendation.priority;
  return { ok: true };
}

function recalculateItem(item, thresholds, now) {
  const evidence = item.evidence || { status: { archived: item.archived, disabled: item.disabled, deprecated: item.deprecated }, latestCommitAt: item.latestCommitAt, latestReleaseAt: item.latestReleaseAt, latestActivityAt: item.latestActivityAt };
  const healthSignals = buildSignals(evidence, thresholds, now); const recommendation = buildRecommendation(healthSignals);
  return { ...item, archived: evidence.status.archived, disabled: evidence.status.disabled, deprecated: evidence.status.deprecated, latestCommitAt: evidence.latestCommitAt, latestReleaseAt: evidence.latestReleaseAt, latestActivityAt: evidence.latestActivityAt, evidence, healthSignals, recommendation, priority: recommendation.priority };
}

export function createOrchestrator({ github, store, clock = () => new Date(), thresholds = DEFAULT_THRESHOLDS }) {
  if (!github || !store) throw new TypeError('github and store are required');
  let latest = null; let progress = { completed: 0, total: 2, percent: 0, phase: 'idle' };
  return {
    async authStatus() { return normalizeAuth(await github.authStatus()); },
    async loadLastScan() { latest = latest || await store.load(); return latest; },
    getProgress() { return { ...progress }; },
    async recalculate(nextThresholds = {}) {
      if (!latest) await this.loadLastScan();
      if (!latest) return null;
      const effective = normalizeThresholds({ ...latest.thresholds, ...nextThresholds }); const now = clock();
      latest = { ...latest, thresholds: effective, items: (latest.items || []).map((item) => recalculateItem(item, effective, now)), recalculatedAt: now.toISOString() };
      await store.save(latest); return latest;
    },
    async scan(options = {}) {
      const auth = normalizeAuth(await github.authStatus());
      if (auth.state !== 'authenticated') return { status: 'blocked', auth, items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } };
      const now = clock(); const effective = normalizeThresholds({ ...thresholds, ...(options.thresholds || {}) }); const failures = []; const map = new Map();
      const sources = [['starred', github.listStarred], ['owned', github.listOwned]]; let completedSources = 0;
      const reportProgress = (phase) => { progress = { phase, completed: completedSources, total: sources.length, percent: Math.round(completedSources / sources.length * 100) }; options.onProgress?.(progress); };
      reportProgress('starting');
      for (const [source, fn] of sources) {
        try { const repos = await fn.call(github); for (const repo of repos || []) { const merged = mergeRepo(map, repo, source, now, effective); if (!merged.ok) failures.push({ source, reason: merged.reason, item: repo?.full_name || repo?.name || 'unknown', at: now.toISOString() }); } }
        catch (error) { failures.push({ source, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
        completedSources += 1; reportProgress(source);
      }
      if (typeof github.getHealthEvidence === 'function') for (const item of map.values()) {
        try {
          const extra = await github.getHealthEvidence(item.fullName);
          if (extra && typeof extra === 'object') {
            const status = { ...item.evidence.status, ...(extra.status || {}) };
            for (const key of ['archived', 'disabled', 'deprecated']) if (key in extra) status[key] = Boolean(extra[key]);
            item.evidence = { status, latestCommitAt: firstDefined(extra.latestCommitAt, item.evidence.latestCommitAt, null), latestReleaseAt: firstDefined(extra.latestReleaseAt, item.evidence.latestReleaseAt, null), latestActivityAt: firstDefined(extra.latestActivityAt, item.evidence.latestActivityAt, null) };
          }
          Object.assign(item, recalculateItem(item, effective, now));
        } catch (error) { failures.push({ source: 'health', item: item.fullName, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
      }
      const items = [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      const result = { version: 1, status: failures.length ? 'completed-with-errors' : 'completed', auth, scannedAt: now.toISOString(), thresholds: effective, items, failures, summary: { total: items.length + failures.length, success: items.length, failed: failures.length }, progress: { completed: completedSources, total: sources.length, percent: 100 } };
      latest = result; progress = { ...result.progress, phase: 'completed' }; await store.save(result); return result;
    }
  };
}

export { DEFAULT_THRESHOLDS };
