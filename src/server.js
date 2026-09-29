import { createServer as nodeCreateServer } from 'node:http';

import { lifecycleHtml } from './frontend.js';

export function createServer({ orchestrator }) {
  return nodeCreateServer(async (req, res) => {
    try {
      if (req.method === 'POST' && [
        '/api/actions/retry',
        '/api/actions/retry-any',
        '/api/repositories/lifecycle/retry',
        '/api/repositories/archive',
        '/api/repositories/unarchive',
        '/api/repositories/delete',
      ].includes(req.url)) {
        return json(res, { error: '该写入兼容入口已移除；请先调用 preview，再使用 confirm 显式确认。' }, 410);
      }
      if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(lifecycleHtml); }
      if (req.method === 'GET' && req.url === '/api/status') return json(res, await orchestrator.authStatus());
      if (req.method === 'GET' && req.url === '/api/scan') return json(res, await orchestrator.loadLastScan() || { items: [], failures: [], summary: { total: 0, success: 0, failed: 0 }, progress: { completed: 0, total: 0, percent: 0 } });
      if (req.method === 'GET' && req.url === '/api/progress') return json(res, orchestrator.getProgress?.() || { completed: 0, total: 0, percent: 0, phase: 'idle' });
      if (req.method === 'GET' && req.url === '/api/history') return json(res, typeof orchestrator.actionHistory === 'function' ? await orchestrator.actionHistory() : { status: 'unsupported', entries: [] });
      if (req.method === 'GET' && req.url === '/api/data/path') return json(res, { path: orchestrator.dataPath?.() || null });
      if (req.method === 'POST' && req.url === '/api/data/export') { const body = await readJson(req); return json(res, typeof orchestrator.exportData === 'function' ? await orchestrator.exportData(body.path) : { status: 'unsupported' }, 200); }
      if (req.method === 'POST' && req.url === '/api/scan') { const value = await orchestrator.scan({ onProgress: () => {} }); return json(res, value, value.status === 'blocked' ? 403 : 200); }
      if (req.method === 'POST' && req.url === '/api/recalculate') { const value = await orchestrator.recalculate(await readJson(req)); return json(res, value || { error: '暂无扫描结果' }, value ? 200 : 400); }
      if (req.method === 'POST' && req.url === '/api/actions/preview') { if (typeof orchestrator.previewActions !== 'function') return json(res, { error: '当前版本不支持批量动作' }, 400); return json(res, await orchestrator.previewActions(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/actions/confirm') { if (typeof orchestrator.confirmActions !== 'function') return json(res, { error: '当前版本不支持批量动作' }, 400); return json(res, await orchestrator.confirmActions(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/actions/undo') { if (typeof orchestrator.undoStar !== 'function') return json(res, { error: '当前版本不支持撤销' }, 400); return json(res, await orchestrator.undoStar(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/repositories/lifecycle/preview') { if (typeof orchestrator.previewLifecycleActions !== 'function') return json(res, { error: '当前版本不支持仓库生命周期动作' }, 400); return json(res, await orchestrator.previewLifecycleActions(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/repositories/lifecycle/confirm') { if (typeof orchestrator.confirmLifecycleActions !== 'function') return json(res, { error: '当前版本不支持仓库生命周期动作' }, 400); return json(res, await orchestrator.confirmLifecycleActions(await readJson(req))); }
      if (req.method === 'GET' && req.url === '/api/lists') { if (typeof orchestrator.listOverview !== 'function') return json(res, { lists: [], rules: [] }); return json(res, await orchestrator.listOverview()); }
      if (req.method === 'POST' && req.url === '/api/lists/actions/preview') { if (typeof orchestrator.previewListActions !== 'function') return json(res, { error: '当前版本不支持 List 动作' }, 400); return json(res, await orchestrator.previewListActions(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists/actions/confirm') { if (typeof orchestrator.confirmListActions !== 'function') return json(res, { error: '当前版本不支持 List 动作' }, 400); return json(res, await orchestrator.confirmListActions(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists') { if (typeof orchestrator.createList !== 'function') return json(res, { error: '当前版本不支持 List 生命周期' }, 400); return json(res, await orchestrator.createList(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists/rename') { if (typeof orchestrator.renameList !== 'function') return json(res, { error: '当前版本不支持 List 生命周期' }, 400); return json(res, await orchestrator.renameList(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists/delete') { if (typeof orchestrator.deleteList !== 'function') return json(res, { error: '当前版本不支持 List 生命周期' }, 400); return json(res, await orchestrator.deleteList(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists/rules') { if (typeof orchestrator.saveListRules !== 'function') return json(res, { error: '当前版本不支持 List 规则' }, 400); return json(res, await orchestrator.saveListRules(await readJson(req))); }
      if (req.method === 'POST' && req.url === '/api/lists/rules/explain') { if (typeof orchestrator.explainListRules !== 'function') return json(res, { error: '当前版本不支持 List 规则' }, 400); return json(res, await orchestrator.explainListRules(await readJson(req))); }
      res.writeHead(404); res.end('Not found');
    } catch (error) { json(res, { error: error.message }, 500); }
  });
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function readJson(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) reject(new Error('请求体过大')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); req.on('error', reject); }); }
export { lifecycleHtml as html };
