// 把共用的 AI 程式嵌進 index.html（工具是單一檔案，下載後雙擊開啟也要能用，所以不另外 import）：
//   - Shared_Services/ai-gateway/client/ 的 gateway-client.js、own-key.js、ai-access.js（AI 雙入口）
//   - 本工具 ai/ 的 threeview-prompt.js、threeview-schema.js（原始檔；2026-10-13 從組合單元模擬器搬來）
//     （「自己的金鑰」那條路用的指令與輸出格式；閘道的 threeview-recognize 也是同步自這兩個檔）
//   - Shared_Services/ai-gateway/client/apply-key.html → 本工具的 apply-key.html（「如何申請自己的 API 金鑰」說明頁）
//   - 本工具 i18n/ 的 i18n.js、en.js、vi.js、id.js（介面語言；另一組標記「介面語言」）
//
//   node sync-ai.mjs           重新產生 index.html 裡兩個標記之間的段落
//   node sync-ai.mjs --check   只檢查有沒有落後（regress.mjs 會跑；落後就失敗），也檢查閘道的副本和來源一致
// 要改這些程式請改原始檔，再執行這支同步；不要直接改 index.html 裡標記之間的內容。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(here, '../../..');
const CLIENT = path.join(HUB, 'Shared_Services/ai-gateway/client');
const AUS = path.join(here, '../ai');
const GATEWAY = path.join(HUB, 'Shared_Services/ai-gateway');
const HTML = path.join(here, '../index.html');
const GUIDE_SRC = path.join(CLIENT, 'apply-key.html'), GUIDE = path.join(here, '../apply-key.html');
const BEGIN = '/* ==== BEGIN 共用 AI 程式（tests/sync-ai.mjs 自動產生：請改原始檔再同步，不要直接改這一段）==== */';
const END = '/* ==== END 共用 AI 程式 ==== */';
const I18N_DIR = path.join(here, '../i18n');
const I_BEGIN = '/* ==== BEGIN 介面語言（tests/sync-ai.mjs 自動產生：請改 i18n/ 的原始檔再同步，不要直接改這一段）==== */';
const I_END = '/* ==== END 介面語言 ==== */';

for (const dir of [CLIENT, AUS]) if (!existsSync(dir)) { console.error(`找不到來源資料夾：${dir}`); process.exit(2); }

// 一個 ES module → 一個立即執行函式，回傳它 export 的名稱（各自的區域變數不會和工具本身的程式衝突）
function wrap(varName, file, deps = {}, extra = '') {
  let src = readFileSync(file, 'utf8');
  const names = [...src.matchAll(/^export (?:async function|function|const|class|let) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  src = src.replace(/^import \{([^}]+)\} from '\.\/([\w-]+)\.js';$/gm, (_, list, mod) => {
    if (!deps[mod]) throw new Error(`${path.basename(file)} 用到 ${mod}.js，但沒有指定對應的變數`);
    // 變數名稱不能和 import 進來的名稱相同（const { X } = X 會在初始化前就讀它，整頁的 AI 區塊都會壞掉）
    if (list.split(',').map(x => x.trim()).includes(deps[mod])) throw new Error(`${path.basename(file)}：${mod}.js 對應的變數 ${deps[mod]} 和 import 的名稱相同，請換一個`);
    return `const {${list}} = ${deps[mod]};`;
  });
  if (/^import /m.test(src)) throw new Error(`${path.basename(file)} 還有沒處理的 import`);
  src = src.replace(/^export /gm, '');
  const rel = path.relative(HUB, file);
  return `// ---- ${rel}\nconst ${varName} = (() => {\n${src.trimEnd()}\n${extra}return { ${[...names, ...(extra ? extraNames(extra) : [])].join(', ')} };\n})();`;
}
const extraNames = code => [...code.matchAll(/^const ([A-Za-z_$][\w$]*) =/gm)].map(m => m[1]);

const { THREEVIEW_SCHEMA } = await import(pathToFileURL(path.join(AUS, 'threeview-schema.js')).href);
const block = [
  BEGIN,
  wrap('AI_GW', path.join(CLIENT, 'gateway-client.js')),
  wrap('AI_KEY', path.join(CLIENT, 'own-key.js')),
  ...(existsSync(path.join(CLIENT, 'ai-access-i18n.js')) ? [wrap('AI_I18N_MOD', path.join(CLIENT, 'ai-access-i18n.js'))] : []),
  wrap('AI_ACCESS', path.join(CLIENT, 'ai-access.js'), { 'gateway-client': 'AI_GW', 'own-key': 'AI_KEY', 'ai-access-i18n': 'AI_I18N_MOD' }),
  wrap('TV_AI', path.join(AUS, 'threeview-prompt.js'), {},
    `// ---- ${path.relative(HUB, path.join(AUS, 'threeview-schema.js'))}（輸出格式，JSON）\nconst THREEVIEW_SCHEMA = ${JSON.stringify(THREEVIEW_SCHEMA)};\n`),
  END,
].join('\n');

const iblock = [
  I_BEGIN,
  wrap('I18N_EN', path.join(I18N_DIR, 'en.js')),
  wrap('I18N_VI', path.join(I18N_DIR, 'vi.js')),
  wrap('I18N_ID', path.join(I18N_DIR, 'id.js')),
  wrap('I18N', path.join(I18N_DIR, 'i18n.js'), { en: 'I18N_EN', vi: 'I18N_VI', id: 'I18N_ID' }),
  I_END,
].join('\n');

const html = readFileSync(HTML, 'utf8');
const replaceBlock = (src, b0, b1, content) => {
  const a = src.indexOf(b0), b = src.indexOf(b1);
  if (a < 0 || b < a) { console.error(`index.html 裡找不到同步標記：${b0.slice(0, 30)}`); process.exit(2); }
  return src.slice(0, a) + content + src.slice(b + b1.length);
};
const next = replaceBlock(replaceBlock(html, BEGIN, END, block), I_BEGIN, I_END, iblock);

if (process.argv.includes('--check')) {
  let bad = 0;
  if (next !== html) { console.error('index.html 裡的共用 AI 程式或介面語言落後原始檔：請執行 node tests/sync-ai.mjs'); bad++; }
  if (!existsSync(GUIDE) || readFileSync(GUIDE, 'utf8') !== readFileSync(GUIDE_SRC, 'utf8')) { console.error('apply-key.html 和 Shared_Services 的說明頁不同：請執行 node tests/sync-ai.mjs'); bad++; }
  // 閘道的 threeview-recognize 用的指令與格式也同步自同一份來源：確認閘道沒有落後（否則兩個入口的辨識不一致）
  try { execFileSync('node', [path.join(GATEWAY, 'scripts/sync-assembly.mjs'), '--check'], { stdio: 'pipe' }); }
  catch (err) { console.error('閘道的三視圖指令／格式和來源不一致：' + String(err.stderr || err.message).trim()); bad++; }
  if (bad) process.exit(1);
  console.log('共用 AI 程式、申請說明頁與原始檔一致；閘道的三視圖指令與格式也一致');
} else {
  writeFileSync(HTML, next);
  writeFileSync(GUIDE, readFileSync(GUIDE_SRC, 'utf8'));
  console.log('已更新 index.html 的共用 AI 程式與 apply-key.html');
}
