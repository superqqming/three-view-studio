// 本機測試 AI 雙入口（不花錢）：假 Anthropic ＋ 本機課程閘道（Shared_Services/ai-gateway 的 wrangler dev）＋ 本工具的網頁
// 執行：cd tests && node dual-stack.mjs　→ 用瀏覽器開印出來的網址
//   課程額度：王小明／B11201001（測試課程，每人 3 次，快／一般）
//   在兩門課的名單上：張雙修／B11201004（登入時要選課）
//   課程已結束：陳大文／B11201002（登入後應自動改成「使用自己的金鑰」）
//   修的課沒開放三視圖：李無課／B11201005（應被拒）
//   自己的金鑰：隨便貼 sk-ant-test-xxxxxxxxxxxxxxxxxxxx（送到假 Anthropic）
// 假 Anthropic 用組合單元模擬器的 mock：三視圖的系統指令會拿到「草圖範例」的標準答案。
// 閘道的測試狀態寫在本工具 tests/.gateway-state（不寫進閘道的資料夾）；金鑰全是測試用的假值。
import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOCK = 8930, WEB = 8931, GW = 8932, ORIGIN = `http://localhost:${WEB}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HUB = path.resolve(root, '../..');
const gatewayDir = path.join(HUB, 'Shared_Services/ai-gateway/worker');
const state = path.join(here, '.gateway-state');
const { startMock } = await import(pathToFileURL(path.join(HUB, 'Teaching_Tools/assembly-unit-simulator/worker/test/mock-anthropic.mjs')).href);
const { loginKey } = await import(pathToFileURL(path.join(HUB, 'Shared_Services/ai-gateway/client/gateway-client.js')).href);
const SECRETS = { ANTHROPIC_API_KEY: 'test-key', OPENAI_API_KEY: 'test-openai-key', TOKEN_SECRET: 'tvs-token-secret', ROSTER_PEPPER: 'tvs-pepper', ADMIN_KEY: 'tvs-admin-key' };

if (!existsSync(path.join(gatewayDir, 'node_modules'))) throw new Error(`閘道還沒安裝套件：cd "${gatewayDir}" && npm install`);
if (existsSync(state)) rmSync(state, { recursive: true });

const mock = await startMock(MOCK);
const vars = { ...SECRETS, ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, OPENAI_BASE_URL: `http://127.0.0.1:${MOCK}`, ALLOWED_ORIGINS: ORIGIN };
const wr = spawn('npx', ['wrangler', 'dev', '--port', String(GW), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false',
  ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: gatewayDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
let log = '';
wr.stdout.on('data', d => { log += d; }); wr.stderr.on('data', d => { log += d; });
const base = `http://127.0.0.1:${GW}`;
for (let i = 0; ; i++) {
  await new Promise(r => setTimeout(r, 500));
  try { if ((await fetch(base + '/v1/health')).ok) break; } catch { /* 還沒好 */ }
  if (i > 120) { console.log(log); throw new Error('本機閘道沒有啟動'); }
}
const A = async (p, method, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': SECRETS.ADMIN_KEY }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return r.json();
};
const TV = { 'threeview-recognize': { enabled: true, quota: 3, efforts: ['low', 'medium'], defaultEffort: 'medium' } };
await A('/v1/admin/course/TEST', 'PUT', { name: '測試課程', tools: TV });
await A('/v1/admin/course/TEST/roster', 'POST', { keys: [await loginKey('B11201001', '王小明'), await loginKey('B11201004', '張雙修')] });
await A('/v1/admin/course/TEST2', 'PUT', { name: '第二門測試課', tools: TV });
await A('/v1/admin/course/TEST2/roster', 'POST', { keys: [await loginKey('B11201004', '張雙修')] });
await A('/v1/admin/course/TEST-END', 'PUT', { name: '已結束的測試課程', endsAt: '2020-01-01', tools: TV });
await A('/v1/admin/course/TEST-END/roster', 'POST', { keys: [await loginKey('B11201002', '陳大文')] });
await A('/v1/admin/course/TEST-OFF', 'PUT', { name: '沒開放三視圖的課', tools: { 'assembly-recognize': { enabled: true, quota: 3 } } });
await A('/v1/admin/course/TEST-OFF/roster', 'POST', { keys: [await loginKey('B11201005', '李無課')] });

// 本工具的網頁（不快取）；/__last 看最後一個送到假 Anthropic 的請求
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8' };
http.createServer((req, res) => {
  if (req.url === '/__last') { mock.last().then(d => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); }); return; }
  let p = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || /\/(node_modules|\.gateway-state)\//.test(file) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(WEB, '127.0.0.1');

console.log(`就緒：${ORIGIN}/index.html?gateway=${base}&own-base=http://127.0.0.1:${MOCK}`);
console.log(`（假 Anthropic ${MOCK}、本機閘道 ${GW}、管理金鑰 ${SECRETS.ADMIN_KEY}；${ORIGIN}/__last 看最後一個送到假 Anthropic 的請求）`);
const stop = () => { wr.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
