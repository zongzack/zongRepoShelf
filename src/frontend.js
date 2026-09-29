import { readFileSync } from 'node:fs';

const frontendPath = new URL('./frontend.html', import.meta.url);
const lifecycleHtml = readFileSync(frontendPath, 'utf8');

// 保留原有导出名称，便于现有调用方继续使用。
const html = lifecycleHtml;

export { frontendPath, html, lifecycleHtml };
