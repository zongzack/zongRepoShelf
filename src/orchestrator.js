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
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
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
  if (status.archived) signals.push({ code: 'archived', category: 'status', label: '项目条目已归档', value: true });
  if (status.disabled) signals.push({ code: 'disabled', category: 'status', label: '项目条目已禁用', value: true });
  if (status.deprecated) signals.push({ code: 'deprecated', category: 'status', label: '项目条目标记为 deprecated', value: true });
  const recency = [
    ['latestCommitAt', 'no-recent-commit', thresholds.noCommitMonths, '提交', '无提交记录'],
    ['latestReleaseAt', 'no-recent-release', thresholds.noReleaseMonths, 'Release', '从未发布 Release'],
    ['latestActivityAt', 'no-recent-activity', thresholds.noActivityMonths, 'Issue/PR 活动', '无 Issue/PR 活动记录']
  ];
  for (const [field, code, months, subject, missingLabel] of recency) {
    const value = evidence[field];
    const category = field.replace('latest', '').replace('At', '').toLowerCase();
    const unavailable = evidence.unavailable?.[category];
    if (!value && !unavailable) signals.push({ code, category, label: missingLabel, value: null, thresholdMonths: months });
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
  const unavailable = supplemental.unavailable || {};
  const evidence = { status, latestCommitAt: firstDefined(supplemental.latestCommitAt, repo.latestCommitAt, repo.latest_commit_at, repo.pushed_at, repo.updated_at, null), latestReleaseAt: firstDefined(supplemental.latestReleaseAt, repo.latestReleaseAt, repo.latest_release_at, repo.latest_release?.published_at, null), latestActivityAt: firstDefined(supplemental.latestActivityAt, repo.latestActivityAt, repo.activity_at, repo.updated_at, null), ...(Object.keys(unavailable).length ? { unavailable } : {}) };
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
  const evidence = item.evidence || { status: { archived: item.archived, disabled: item.disabled, deprecated: item.deprecated }, latestCommitAt: item.latestCommitAt, latestReleaseAt: item.latestReleaseAt, latestActivityAt: item.latestActivityAt, unavailable: {} };
  const healthSignals = buildSignals(evidence, thresholds, now); const recommendation = buildRecommendation(healthSignals);
  return { ...item, archived: evidence.status.archived, disabled: evidence.status.disabled, deprecated: evidence.status.deprecated, latestCommitAt: evidence.latestCommitAt, latestReleaseAt: evidence.latestReleaseAt, latestActivityAt: evidence.latestActivityAt, evidence, healthSignals, recommendation, priority: recommendation.priority };
}

export function createOrchestrator({ github, store, clock = () => new Date(), thresholds = DEFAULT_THRESHOLDS }) {
  if (!github || !store) throw new TypeError('github and store are required');
  let latest = null; let progress = { completed: 0, total: 2, percent: 0, phase: 'idle' }; let pendingPreview = null;
  const nowIso = () => clock().toISOString();
  function normalizeActionSelections(input = {}) {
    if (Array.isArray(input)) return input.map((value) => typeof value === 'string' ? { fullName: value, action: 'unstar' } : value);
    if (Array.isArray(input.selections)) return input.selections;
    if (Array.isArray(input.items)) return input.items;
    const result = [];
    for (const action of ['unstar', 'keep']) for (const value of (input[action] || [])) result.push(typeof value === 'string' ? { fullName: value, action } : { ...value, action });
    return result;
  }
  function normalizeAction(action) {
    const value = String(action || '').toLowerCase();
    if (['unstar', 'remove-star', 'remove_star', '取消 star', '取消star'].includes(value)) return 'unstar';
    if (['keep', 'retain', '保留', '保留当前关系'].includes(value)) return 'keep';
    return null;
  }
  async function ensureLatest() { if (!latest) await store.load().then((value) => { latest = value; }); return latest; }
  function ensureAudit() { if (!latest.audit) latest.audit = []; return latest.audit; }
  function findItem(fullNameOrId) { return (latest?.items || []).find((item) => item.fullName === fullNameOrId || String(item.id) === String(fullNameOrId)); }
  function actionInputFromResult(result) { return { fullName: result.fullName, action: result.action }; }
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
      await ensureLatest();
      const previousAudit = latest?.audit || [];
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
            const unavailable = { ...(item.evidence.unavailable || {}), ...(extra.unavailable || {}) };
            item.evidence = { status, latestCommitAt: firstDefined(extra.latestCommitAt, item.evidence.latestCommitAt, null), latestReleaseAt: firstDefined(extra.latestReleaseAt, item.evidence.latestReleaseAt, null), latestActivityAt: firstDefined(extra.latestActivityAt, item.evidence.latestActivityAt, null), ...(Object.keys(unavailable).length ? { unavailable } : {}) };
          }
          Object.assign(item, recalculateItem(item, effective, now));
        } catch (error) { failures.push({ source: 'health', item: item.fullName, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
      }
      const items = [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      const result = { version: 1, status: failures.length ? 'completed-with-errors' : 'completed', auth, scannedAt: now.toISOString(), thresholds: effective, items, failures, audit: previousAudit, actionResults: [], summary: { total: items.length + failures.length, success: items.length, failed: failures.length }, progress: { completed: completedSources, total: sources.length, percent: 100 } };
      latest = result; progress = { ...result.progress, phase: 'completed' }; await store.save(result); return result;
    },
    async previewActions(input = {}) {
      await ensureLatest();
      if (!latest) return { status: 'no-scan', groups: { unstar: [], keep: [] }, actions: [], total: 0 };
      const seen = new Set(); const actions = []; const invalid = [];
      for (const raw of normalizeActionSelections(input)) {
        const fullName = raw?.fullName || raw?.name || raw?.project;
        const action = normalizeAction(raw?.action || raw?.type || (raw?.unstar ? 'unstar' : undefined));
        const item = findItem(fullName);
        if (!item || !action || seen.has(item.fullName) || (action === 'unstar' && !item.relation?.starred)) { if (fullName && !seen.has(fullName)) invalid.push({ fullName, reason: !item ? '项目条目不在最近扫描结果中' : action === 'unstar' && !item.relation?.starred ? '项目当前没有 Star 关系，不能取消 Star' : '不支持的动作' }); continue; }
        seen.add(item.fullName); actions.push({ id: `${action}:${item.fullName}`, fullName: item.fullName, project: item.fullName, action, relation: item.relation, url: item.url });
      }
      const preview = { id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'preview', createdAt: nowIso(), groups: { unstar: actions.filter((a) => a.action === 'unstar'), keep: actions.filter((a) => a.action === 'keep') }, actions, invalid, total: actions.length };
      pendingPreview = preview;
      return preview;
    },
    async confirmActions(previewOrInput = {}) {
      await ensureLatest();
      let preview = previewOrInput?.status === 'preview' && pendingPreview?.id === previewOrInput.id ? previewOrInput : (previewOrInput?.previewId && pendingPreview?.id === previewOrInput.previewId ? pendingPreview : null);
      if (preview && Array.isArray(previewOrInput.actions)) {
        const wanted = new Set(previewOrInput.actions.map((action) => action.id || `${action.action}:${action.fullName}`));
        const actions = (pendingPreview.actions || []).filter((action) => wanted.has(action.id) || wanted.has(`${action.action}:${action.fullName}`));
        preview = { ...pendingPreview, actions, groups: { unstar: actions.filter((a) => a.action === 'unstar'), keep: actions.filter((a) => a.action === 'keep') }, total: actions.length };
      }
      if (!latest) return { status: 'no-scan', results: [], summary: { total: 0, success: 0, failed: 0 } };
      if (!preview) return { status: 'confirmation-required', results: [], error: '必须先预览并确认批量动作' };
      if (preview.id && pendingPreview?.id && preview.id !== pendingPreview.id) return { status: 'confirmation-required', results: [], error: '批量预览已失效，请重新预览' };
      const results = [];
      for (const action of preview.actions || []) {
        const at = nowIso();
        try {
          if (action.action === 'unstar') {
            if (typeof github.unstar !== 'function') throw new Error('GitHub 适配器不支持取消 Star');
            await github.unstar(action.fullName);
          }
          const result = { ...action, status: 'succeeded', result: 'success', at };
          results.push(result); ensureAudit().push({ project: action.fullName, action: action.action, time: at, result: 'success', status: 'succeeded' });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error); const result = { ...action, status: 'failed', result: 'failed', error: reason, reason, at };
          results.push(result); ensureAudit().push({ project: action.fullName, action: action.action, time: at, result: 'failed', status: 'failed', error: reason, reason });
        }
      }
      latest.lastActionResults = results; latest.actionResults = [...(latest.actionResults || []), ...results];
      if (pendingPreview?.id === preview.id) {
        const done = new Set(results.map((result) => result.id));
        const remaining = (pendingPreview.actions || []).filter((action) => !done.has(action.id));
        pendingPreview = remaining.length ? { ...pendingPreview, actions: remaining, groups: { unstar: remaining.filter((a) => a.action === 'unstar'), keep: remaining.filter((a) => a.action === 'keep') }, total: remaining.length } : null;
      }
      await store.save(latest);
      return { status: results.some((r) => r.status === 'failed') ? 'completed-with-errors' : 'completed', results, summary: { total: results.length, success: results.filter((r) => r.status === 'succeeded').length, failed: results.filter((r) => r.status === 'failed').length } };
    },
    async retryAction(input = {}) {
      await ensureLatest();
      const fullName = input.fullName || input.project || input.name; const prior = [...(latest?.actionResults || []), ...(latest?.lastActionResults || [])].reverse().find((r) => r.fullName === fullName && r.action === 'unstar' && r.status === 'failed');
      if (!prior) return { status: 'not-found', results: [], error: '没有可重试的失败动作' };
      const retryPreview = { id: `retry-${Date.now()}`, status: 'preview', actions: [actionInputFromResult(prior)] }; pendingPreview = retryPreview;
      const result = await this.confirmActions(retryPreview);
      return { ...result, retried: fullName };
    },
    async undoStar(input = {}) {
      await ensureLatest();
      const fullName = input.fullName || input.project || input.name; const prior = [...(latest?.actionResults || []), ...(latest?.lastActionResults || [])].reverse().find((r) => r.fullName === fullName && r.action === 'unstar' && r.status === 'succeeded' && !r.undone);
      if (!prior) return { status: 'not-found', error: '没有可撤销的本次取消 Star 动作', fullName };
      const at = nowIso(); let currentlyStarred;
      try {
        const check = github.isStarred || github.getStarredStatus || github.checkStarred;
        if (typeof check !== 'function') throw new Error('GitHub 适配器不支持状态检查');
        currentlyStarred = Boolean(await check.call(github, fullName));
        if (currentlyStarred) {
          const result = { fullName, action: 'undo-unstar', status: 'skipped', result: 'skipped', reason: '项目当前已是 Star 状态，未覆盖现有关系', at };
          ensureAudit().push({ project: fullName, action: 'undo-unstar', time: at, result: 'skipped', status: 'skipped', reason: result.reason }); await store.save(latest); return result;
        }
        if (typeof github.star !== 'function') throw new Error('GitHub 适配器不支持恢复 Star');
        await github.star(fullName); prior.undone = true;
        const result = { fullName, action: 'undo-unstar', status: 'succeeded', result: 'success', at };
        ensureAudit().push({ project: fullName, action: 'undo-unstar', time: at, result: 'success', status: 'succeeded' }); await store.save(latest); return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error); const result = { fullName, action: 'undo-unstar', status: 'failed', result: 'failed', error: reason, reason, at, currentlyStarred };
        ensureAudit().push({ project: fullName, action: 'undo-unstar', time: at, result: 'failed', status: 'failed', error: reason, reason }); await store.save(latest); return result;
      }
    },
    async undoUnstar(input = {}) { return this.undoStar(input); },
    async previewBatch(input = {}) { return this.previewActions(input); },
    async confirmBatch(input = {}) { return this.confirmActions(input); },
    async retryFailedAction(input = {}) { return this.retryAction(input); },
    async undoAction(input = {}) { return this.undoStar(input); },
    async executeActions(input = {}) { const preview = input?.status === 'preview' ? input : await this.previewActions(input); if (preview.status === 'preview' && !pendingPreview) pendingPreview = preview; return this.confirmActions(preview); }
  };
}

export { DEFAULT_THRESHOLDS };
