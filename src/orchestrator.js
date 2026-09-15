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
  const forkOriginal = repo.parent?.full_name || repo.source?.full_name || repo.forked_from?.full_name || null;
  const evidence = { status, latestCommitAt: firstDefined(supplemental.latestCommitAt, repo.latestCommitAt, repo.latest_commit_at, repo.pushed_at, repo.updated_at, null), latestReleaseAt: firstDefined(supplemental.latestReleaseAt, repo.latestReleaseAt, repo.latest_release_at, repo.latest_release?.published_at, null), latestActivityAt: firstDefined(supplemental.latestActivityAt, repo.latestActivityAt, repo.activity_at, repo.updated_at, null), ...(firstDefined(supplemental.defaultBranch, repo.default_branch) ? { defaultBranch: firstDefined(supplemental.defaultBranch, repo.default_branch) } : {}), ...(forkOriginal ? { forkOriginal } : {}), ...(Object.keys(unavailable).length ? { unavailable } : {}) };
  const healthSignals = buildSignals(evidence, thresholds, now);
  const recommendation = buildRecommendation(healthSignals);
  return { id: String(repo.id ?? fullName), owner, name, fullName, url: repo.html_url || `https://github.com/${fullName}`, description: repo.description || '', relation: { starred: source === 'starred', owned: source === 'owned', fork: Boolean(repo.fork), ...(forkOriginal ? { forkOriginal } : {}) }, archived: status.archived, disabled: status.disabled, deprecated: status.deprecated, language: repo.language || null, topics, lists: Array.isArray(repo.lists) ? [...repo.lists] : [], latestCommitAt: evidence.latestCommitAt, latestReleaseAt: evidence.latestReleaseAt, latestActivityAt: evidence.latestActivityAt, evidence, healthSignals, recommendation, priority: recommendation.priority, scannedAt: now.toISOString() };
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
  existing.language ||= item.language; existing.description ||= item.description; existing.topics = [...new Set([...(existing.topics || []), ...(item.topics || [])])]; existing.lists = [...new Set([...(existing.lists || []), ...(item.lists || [])])];
  existing.archived ||= item.archived; existing.disabled ||= item.disabled; existing.deprecated ||= item.deprecated;
  existing.evidence.status = { archived: existing.archived, disabled: existing.disabled, deprecated: existing.deprecated };
  if (!existing.evidence.defaultBranch && item.evidence.defaultBranch) existing.evidence.defaultBranch = item.evidence.defaultBranch;
  if (!existing.evidence.forkOriginal && item.evidence.forkOriginal) existing.evidence.forkOriginal = item.evidence.forkOriginal;
  if (!existing.relation.forkOriginal && item.relation.forkOriginal) existing.relation.forkOriginal = item.relation.forkOriginal;
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
  function normalizeListName(value) { return String(value || '').trim(); }
  function findList(nameOrId) { return (latest?.lists || []).find((list) => String(list.id) === String(nameOrId) || list.name === nameOrId); }
  function listWriteGuard(item) {
    if (!item) return '项目条目不在最近扫描结果中';
    if (!item.relation?.starred) return '未 Star 的本人拥有仓库不支持 GitHub List 写操作';
    return null;
  }
  function normalizeListAction(action) {
    const value = String(action || '').toLowerCase();
    if (['add', 'join', '加入', 'add-to-list'].includes(value)) return 'add';
    if (['remove', 'leave', '移出', 'remove-from-list'].includes(value)) return 'remove';
    if (['unique', 'set-unique', '唯一', '设为唯一归类'].includes(value)) return 'unique';
    return null;
  }
  function listActionInput(input = {}) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input.selections)) return input.selections;
    if (Array.isArray(input.actions)) return input.actions;
    return [];
  }
  function applyListMembership(fullName, listName, action) {
    const item = findItem(fullName); if (!item) return;
    item.lists = Array.isArray(item.lists) ? item.lists : [];
    if (action === 'add' && !item.lists.includes(listName)) item.lists.push(listName);
    if (action === 'remove') item.lists = item.lists.filter((name) => name !== listName);
    if (action === 'unique') item.lists = [listName];
  }
  function recountLists(target = latest) {
    if (!target) return [];
    return (target.lists || []).map((list) => ({ ...list, repositoryCount: (target.items || []).filter((item) => item.lists?.includes(list.name)).length, pendingCount: (target.items || []).filter((item) => item.lists?.includes(list.name) && item.healthSignals?.length).length }));
  }
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
      latest.lists = recountLists(latest);
      await store.save(latest); return latest;
    },
    async listOverview() {
      await ensureLatest();
      if (!latest) return { status: 'no-scan', lists: [], rules: [] };
      const lists = recountLists(latest);
      return { status: 'ok', lists, rules: latest.listRules || [] };
    },
    async previewListActions(input = {}) {
      await ensureLatest();
      if (!latest) return { status: 'no-scan', actions: [], groups: { add: [], remove: [], unique: [] }, invalid: [], total: 0 };
      const actions = []; const invalid = []; const seen = new Set();
      for (const raw of listActionInput(input)) {
        const fullName = raw?.fullName || raw?.project || raw?.name;
        const listName = normalizeListName(raw?.list || raw?.listName || raw?.targetList);
        const action = normalizeListAction(raw?.action || raw?.type);
        const item = findItem(fullName); const list = findList(listName);
        const guard = listWriteGuard(item);
        let reason = guard || (!list ? '目标 List 不存在于最近扫描结果中' : !action ? '不支持的 List 动作' : !fullName || !listName ? '项目条目和 List 均为必填' : null);
        if (!reason && action === 'remove' && !(item.lists || []).includes(list.name)) reason = '项目当前不属于该 List';
        if (!reason && action === 'add' && (item.lists || []).includes(list.name)) reason = '项目已经属于该 List';
        const key = `${action}:${fullName}:${listName}`;
        if (reason || seen.has(key)) { if (fullName && !seen.has(key)) invalid.push({ fullName, list: listName, action, reason: reason || '重复动作' }); continue; }
        seen.add(key); actions.push({ id: key, fullName, project: fullName, listId: list.id, list: list.name, action, currentLists: [...(item.lists || [])], uniqueConfirmationRequired: action === 'unique' && (item.lists || []).some((name) => name !== list.name) });
      }
      const preview = { id: `list-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'preview', createdAt: nowIso(), actions, invalid, groups: { add: actions.filter((a) => a.action === 'add'), remove: actions.filter((a) => a.action === 'remove'), unique: actions.filter((a) => a.action === 'unique') }, total: actions.length };
      pendingPreview = preview; return preview;
    },
    async confirmListActions(input = {}) {
      await ensureLatest();
      const preview = input?.status === 'preview' && pendingPreview?.id === input.id ? input : (input?.previewId && pendingPreview?.id === input.previewId ? pendingPreview : null);
      if (!latest) return { status: 'no-scan', results: [], summary: { total: 0, success: 0, failed: 0 } };
      if (!preview) return { status: 'confirmation-required', results: [], error: '必须先预览并确认 List 动作' };
      if (preview.id && pendingPreview?.id && preview.id !== pendingPreview.id) return { status: 'confirmation-required', results: [], error: 'List 批量预览已失效，请重新预览' };
      const wanted = Array.isArray(input.actions) ? new Set(input.actions.map((a) => a.id || `${a.action}:${a.fullName}:${a.list}`)) : null;
      const selected = (preview.actions || []).filter((a) => !wanted || wanted.has(a.id) || wanted.has(`${a.action}:${a.fullName}:${a.list}`));
      const results = [];
      for (const action of selected) {
        const at = nowIso();
        try {
          if (action.action === 'unique' && action.uniqueConfirmationRequired && input.confirmUnique !== true) throw new Error('设为唯一归类会移除其他 List 关系，需要单独确认');
          const method = action.action === 'add' ? 'addToList' : action.action === 'remove' ? 'removeFromList' : (typeof github.setUniqueList === 'function' ? 'setUniqueList' : 'addToList');
          if (typeof github[method] !== 'function') throw new Error('GitHub 适配器不支持 List 动作');
          if (action.action === 'unique' && action.uniqueConfirmationRequired) {
            for (const current of action.currentLists.filter((name) => name !== action.list)) {
              const existingList = findList(current);
              if (existingList && typeof github.removeFromList === 'function') await github.removeFromList(existingList.id, action.fullName);
            }
          }
          await github[method](action.listId, action.fullName);
          applyListMembership(action.fullName, action.list, action.action);
          const result = { ...action, status: 'succeeded', result: 'success', at }; results.push(result); ensureAudit().push({ project: action.fullName, action: `list-${action.action}`, list: action.list, time: at, result: 'success', status: 'succeeded' });
        } catch (error) { const reason = error instanceof Error ? error.message : String(error); const result = { ...action, status: 'failed', result: 'failed', reason, error: reason, at }; results.push(result); ensureAudit().push({ project: action.fullName, action: `list-${action.action}`, list: action.list, time: at, result: 'failed', status: 'failed', reason }); }
      }
      latest.actionResults = [...(latest.actionResults || []), ...results]; await store.save(latest);
      return { status: results.some((r) => r.status === 'failed') ? 'completed-with-errors' : 'completed', results, summary: { total: results.length, success: results.filter((r) => r.status === 'succeeded').length, failed: results.filter((r) => r.status === 'failed').length } };
    },
    async createList(input = {}) {
      await ensureLatest(); const name = normalizeListName(input.name); if (!latest) return { status: 'no-scan', error: '暂无扫描结果' }; if (!name) return { status: 'invalid', error: 'List 名称不能为空' }; if (typeof github.createList !== 'function') return { status: 'failed', error: 'GitHub 适配器不支持新建 List' };
      try { const list = await github.createList(name, input.description || ''); await ensureLatest(); latest.lists = [...(latest.lists || []), { id: String(list.id ?? list.name ?? name), name: list.name || name, description: list.description || input.description || '', private: Boolean(list.private), repositoryCount: 0, pendingCount: 0 }]; ensureAudit().push({ action: 'list-create', list: name, time: nowIso(), result: 'success', status: 'succeeded' }); await store.save(latest); return { status: 'succeeded', list: latest.lists.at(-1) }; } catch (error) { const reason = error instanceof Error ? error.message : String(error); if (latest) { ensureAudit().push({ action: 'list-create', list: name, time: nowIso(), result: 'failed', status: 'failed', reason }); await store.save(latest); } return { status: 'failed', error: reason }; }
    },
    async renameList(input = {}) {
      await ensureLatest(); if (!latest) return { status: 'no-scan', error: '暂无扫描结果' }; const list = findList(input.id || input.list || input.name); const name = normalizeListName(input.newName || input.targetName); if (!list || !name) return { status: 'invalid', error: 'List 或新名称不能为空' }; if (typeof github.renameList !== 'function') return { status: 'failed', error: 'GitHub 适配器不支持重命名 List' };
      try { await github.renameList(list.id, name); const old = list.name; list.name = name; for (const item of latest.items || []) item.lists = (item.lists || []).map((v) => v === old ? name : v); ensureAudit().push({ action: 'list-rename', list: old, newName: name, time: nowIso(), result: 'success', status: 'succeeded' }); await store.save(latest); return { status: 'succeeded', list }; } catch (error) { const reason = error instanceof Error ? error.message : String(error); ensureAudit().push({ action: 'list-rename', list: list.name, newName: name, time: nowIso(), result: 'failed', status: 'failed', reason }); await store.save(latest); return { status: 'failed', error: reason }; }
    },
    async deleteList(input = {}) {
      await ensureLatest(); if (!latest) return { status: 'no-scan', error: '暂无扫描结果' }; const list = findList(input.id || input.list || input.name); if (!list) return { status: 'invalid', error: 'List 不存在' }; if (input.confirm !== true) return { status: 'confirmation-required', list: { ...list }, error: '删除 List 前需要二次确认' }; if (typeof github.deleteList !== 'function') return { status: 'failed', error: 'GitHub 适配器不支持删除 List' };
      try { await github.deleteList(list.id); latest.lists = (latest.lists || []).filter((v) => String(v.id) !== String(list.id)); for (const item of latest.items || []) item.lists = (item.lists || []).filter((v) => v !== list.name); ensureAudit().push({ action: 'list-delete', list: list.name, time: nowIso(), result: 'success', status: 'succeeded' }); await store.save(latest); return { status: 'succeeded', list }; } catch (error) { const reason = error instanceof Error ? error.message : String(error); ensureAudit().push({ action: 'list-delete', list: list.name, time: nowIso(), result: 'failed', status: 'failed', reason }); await store.save(latest); return { status: 'failed', error: reason }; }
    },
    async saveListRules(input = {}) { await ensureLatest(); if (!latest) return { status: 'no-scan' }; const rules = Array.isArray(input.rules) ? input.rules : []; latest.listRules = rules.map((rule) => ({ type: ['keyword', 'topic', 'language'].includes(rule.type) ? rule.type : 'keyword', value: String(rule.value || '').trim(), list: normalizeListName(rule.list || rule.listName) })).filter((rule) => rule.value && rule.list); for (const item of latest.items || []) item.listSuggestions = latest.listRules.filter((rule) => { const value = rule.value.toLowerCase(); if (rule.type === 'language') return String(item.language || '').toLowerCase() === value; if (rule.type === 'topic') return (item.topics || []).some((topic) => String(topic).toLowerCase() === value); return [item.fullName, item.name, item.description, ...(item.topics || [])].some((field) => String(field || '').toLowerCase().includes(value)); }).map((rule) => ({ list: rule.list, targetList: rule.list, matchedField: rule.type, matchedValue: rule.value, rule })); await store.save(latest); return { status: 'succeeded', rules: latest.listRules }; },
    async explainListRules(input = {}) { await ensureLatest(); const item = findItem(input.fullName || input.project || input.name); if (!item) return { status: 'not-found', matches: [] }; const matches = (latest.listRules || []).filter((rule) => { const value = rule.value.toLowerCase(); if (rule.type === 'language') return String(item.language || '').toLowerCase() === value; if (rule.type === 'topic') return (item.topics || []).some((topic) => String(topic).toLowerCase() === value); return [item.fullName, item.name, item.description, ...(item.topics || [])].some((field) => String(field || '').toLowerCase().includes(value)); }).map((rule) => ({ ...rule, matchedField: rule.type === 'language' ? 'language' : rule.type === 'topic' ? 'topic' : 'keyword', matchedValue: rule.value, targetList: rule.list })); return { status: 'ok', fullName: item.fullName, matches }; },
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
            const defaultBranch = firstDefined(extra.defaultBranch, item.evidence.defaultBranch);
            const forkOriginal = firstDefined(extra.forkOriginal, item.evidence.forkOriginal);
            item.evidence = { status, latestCommitAt: firstDefined(extra.latestCommitAt, item.evidence.latestCommitAt, null), latestReleaseAt: firstDefined(extra.latestReleaseAt, item.evidence.latestReleaseAt, null), latestActivityAt: firstDefined(extra.latestActivityAt, item.evidence.latestActivityAt, null), ...(defaultBranch ? { defaultBranch } : {}), ...(forkOriginal ? { forkOriginal } : {}), ...(Object.keys(unavailable).length ? { unavailable } : {}) };
          }
          Object.assign(item, recalculateItem(item, effective, now));
        } catch (error) { failures.push({ source: 'health', item: item.fullName, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
      }
      const items = [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      let lists = latest?.lists || [];
      if (typeof github.listLists === 'function') {
        try {
          const remoteLists = await github.listLists();
          lists = (remoteLists || []).map((list) => ({ id: String(list.id ?? list.name), name: normalizeListName(list.name), description: list.description || '', private: Boolean(list.private), repositoryCount: Number(list.repositoryCount ?? list.repositories_count ?? 0) })).filter((list) => list.name);
          if (typeof github.listListRepositories === 'function') {
            for (const list of lists) {
              try {
                const members = await github.listListRepositories(list.id);
                for (const member of members || []) {
                  const fullName = member.full_name || (member.owner?.login && member.name ? `${member.owner.login}/${member.name}` : null);
                  const item = fullName && map.get(fullName); if (item) { item.lists = [...new Set([...(item.lists || []), list.name])]; }
                }
              } catch (error) { failures.push({ source: 'lists', list: list.name, reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
            }
          }
        } catch (error) { failures.push({ source: 'lists', reason: error instanceof Error ? error.message : String(error), at: now.toISOString() }); }
      }
      const rules = Array.isArray(latest?.listRules) ? latest.listRules : [];
      for (const item of items) {
        item.listSuggestions = rules.filter((rule) => {
          const value = String(rule.value || '').toLowerCase();
          if (rule.type === 'language') return String(item.language || '').toLowerCase() === value;
          if (rule.type === 'topic') return (item.topics || []).some((topic) => String(topic).toLowerCase() === value);
          return [item.fullName, item.name, item.description, ...(item.topics || [])].some((field) => String(field || '').toLowerCase().includes(value));
        }).map((rule) => ({ list: rule.list, targetList: rule.list, matchedField: rule.type, matchedValue: rule.value, rule }));
      }
      lists = recountLists({ lists, items });
      const result = { version: 1, status: failures.length ? 'completed-with-errors' : 'completed', auth, scannedAt: now.toISOString(), thresholds: effective, items, lists, listRules: rules, failures, audit: previousAudit, actionResults: [], summary: { total: items.length + failures.length, success: items.length, failed: failures.length }, progress: { completed: completedSources, total: sources.length, percent: 100 } };
      latest = result; progress = { ...result.progress, phase: 'completed' }; await store.save(result); return result;
    },
    async previewLifecycleActions(input = {}) {
      await ensureLatest();
      if (!latest) return { status: 'no-scan', actions: [], invalid: [], groups: { archive: [], unarchive: [], delete: [] }, total: 0 };
      const selections = Array.isArray(input) ? input : (input.selections || input.actions || []);
      const actions = []; const invalid = []; const seen = new Set();
      for (const raw of selections) {
        const fullName = raw?.fullName || raw?.project || raw?.name;
        const actionValue = String(raw?.action || raw?.type || '').toLowerCase();
        const action = ['archive', '归档'].includes(actionValue) ? 'archive' : ['unarchive', 'un-archive', '取消归档'].includes(actionValue) ? 'unarchive' : ['delete', '删除'].includes(actionValue) ? 'delete' : null;
        const item = findItem(fullName);
        let reason = !item ? '项目条目不在最近扫描结果中' : !item.relation?.owned ? '仅允许对本人拥有的项目条目执行仓库生命周期动作' : !action ? '不支持的仓库生命周期动作' : null;
        if (!reason && action === 'archive' && item.archived) reason = '项目已经归档';
        if (!reason && action === 'unarchive' && !item.archived) reason = '项目当前未归档';
        const key = `${action}:${fullName}`;
        if (reason || seen.has(key)) { if (fullName) invalid.push({ fullName, action, reason: reason || '重复动作' }); continue; }
        seen.add(key);
        actions.push({ id: key, fullName: item.fullName, project: item.fullName, action, owned: true, fork: Boolean(item.relation.fork), forkOriginal: item.relation.forkOriginal || item.evidence?.forkOriginal || null, defaultBranch: item.evidence?.defaultBranch || null, latestCommitAt: item.latestCommitAt || item.evidence?.latestCommitAt || null, archived: item.archived, evidence: item.evidence, risk: action === 'delete' ? '删除不可由本工具恢复，需在高级危险操作区域二次确认' : null });
      }
      const preview = { id: `lifecycle-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'preview', createdAt: nowIso(), actions, invalid, groups: { archive: actions.filter((a) => a.action === 'archive'), unarchive: actions.filter((a) => a.action === 'unarchive'), delete: actions.filter((a) => a.action === 'delete') }, total: actions.length };
      pendingPreview = preview; return preview;
    },
    async confirmLifecycleActions(input = {}) {
      await ensureLatest();
      if (!latest) return { status: 'no-scan', results: [], summary: { total: 0, success: 0, failed: 0 } };
      const preview = input?.status === 'preview' && pendingPreview?.id === input.id ? pendingPreview : input?.previewId && pendingPreview?.id === input.previewId ? pendingPreview : null;
      if (!preview) return { status: 'confirmation-required', results: [], error: '必须先预览并确认仓库生命周期动作' };
      const wanted = Array.isArray(input.actions) ? new Set(input.actions.map((a) => a.id || `${a.action}:${a.fullName}`)) : null;
      const selected = (preview.actions || []).filter((a) => !wanted || wanted.has(a.id) || wanted.has(`${a.action}:${a.fullName}`));
      const pendingDelete = selected.find((action) => action.action === 'delete' && (input.confirm !== true || input.confirmFullName !== action.fullName));
      if (pendingDelete) return { status: 'confirmation-required', results: [], error: input.confirm !== true ? '删除前需要二次确认' : '必须输入完整 owner/repo 名称确认删除', requiredFullName: pendingDelete.fullName, evidence: pendingDelete.evidence, action: pendingDelete };
      const pendingLifecycle = selected.find((action) => action.action !== 'delete' && input.confirm !== true);
      if (pendingLifecycle) return { status: 'confirmation-required', results: [], error: 'Archive/Unarchive 前需要二次确认', action: pendingLifecycle };
      const results = [];
      for (const action of selected) {
        const at = nowIso();
        // 先落审计意图，再触碰 GitHub；崩溃或失败时仍留下可追溯记录。
        const intent = { project: action.fullName, action: action.action, time: at, result: 'pending', status: 'pending', metadata: { owner: action.fullName.split('/')[0], name: action.fullName.split('/')[1], fork: action.fork, forkOriginal: action.forkOriginal, defaultBranch: action.defaultBranch, latestCommitAt: action.latestCommitAt, evidence: action.evidence } };
        ensureAudit().push(intent); await store.save(latest);
        try {
          const method = action.action === 'archive' ? (github.archive ? 'archive' : github.archiveRepository ? 'archiveRepository' : 'setArchived') : action.action === 'unarchive' ? (github.unarchive ? 'unarchive' : github.unarchiveRepository ? 'unarchiveRepository' : 'setArchived') : (github.deleteRepository ? 'deleteRepository' : github.deleteRepo ? 'deleteRepo' : 'deleteRepository');
          if (typeof github[method] !== 'function') throw new Error('GitHub 适配器不支持该仓库生命周期动作');
          if (method === 'setArchived') await github[method](action.fullName, action.action === 'archive'); else await github[method](action.fullName);
          intent.result = 'success'; intent.status = 'succeeded';
          const item = findItem(action.fullName); if (item && action.action !== 'delete') { item.archived = action.action === 'archive'; item.evidence = { ...(item.evidence || {}), status: { ...(item.evidence?.status || {}), archived: item.archived } }; Object.assign(item, recalculateItem(item, latest.thresholds || DEFAULT_THRESHOLDS, clock())); }
          if (action.action === 'delete') latest.items = (latest.items || []).filter((entry) => entry.fullName !== action.fullName);
          results.push({ ...action, status: 'succeeded', result: 'success', at });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error); intent.result = 'failed'; intent.status = 'failed'; intent.reason = reason;
          results.push({ ...action, status: 'failed', result: 'failed', reason, error: reason, at, retryable: true });
        }
      }
      latest.lastActionResults = results; latest.actionResults = [...(latest.actionResults || []), ...results]; await store.save(latest);
      return { status: results.some((r) => r.status === 'failed') ? 'completed-with-errors' : 'completed', results, summary: { total: results.length, success: results.filter((r) => r.status === 'succeeded').length, failed: results.filter((r) => r.status === 'failed').length } };
    },
    async retryLifecycleAction(input = {}) {
      await ensureLatest(); const fullName = input.fullName || input.project || input.name;
      const prior = [...(latest?.actionResults || []), ...(latest?.lastActionResults || [])].reverse().find((r) => r.fullName === fullName && ['archive', 'unarchive', 'delete'].includes(r.action) && r.status === 'failed' && r.retryable !== false);
      if (!prior) return { status: 'not-found', results: [], error: '没有可重试的仓库生命周期失败动作' };
      const preview = await this.previewLifecycleActions({ selections: [{ fullName, action: prior.action }] });
      return this.confirmLifecycleActions({ previewId: preview.id, actions: preview.actions, confirm: input.confirm === true, confirmFullName: input.confirmFullName });
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
