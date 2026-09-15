import { createGhAdapter } from './gh-adapter.js';
import { createOrchestrator } from './orchestrator.js';
import { createJsonStore, defaultDataPath } from './storage.js';
import { createServer } from './server.js';

const args = process.argv.slice(2); const portIndex = args.indexOf('--port'); const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 4173); const host = process.env.HOST || '127.0.0.1';
const store = createJsonStore(defaultDataPath()); const orchestrator = createOrchestrator({ github: createGhAdapter(), store }); const server = createServer({ orchestrator });
server.listen(port, host, () => { const actual = server.address().port; console.log(`GitHub 项目整理已启动：http://${host}:${actual}`); console.log(`扫描结果保存于：${store.filePath}`); });
