// 介面翻譯檢查（改寫自組合單元工作室 tests/i18n-check.mjs，三視圖是單一檔案）：
//   找出 index.html 裡所有 t('…')／N('…') 與 data-i18n 的原文，核對 i18n/en.js、vi.js、id.js
//   缺字、多餘的字、變數 {名稱} 不一致都會列出來；--strict 時有缺字就失敗（regress.mjs 會跑）
//   --dump=檔案：把所有原文（含出現的行號）存成 JSON，給翻譯用
//   --left：列出還沒包 t() 的中文字串（圖面上的字本來就不翻，那幾行標了 i18n-skip）
// 執行：node tests/i18n-check.mjs [--strict] [--dump=檔案] [--left]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STRICT = process.argv.includes('--strict'), LEFT = process.argv.includes('--left');
const DUMP = (process.argv.find(a => a.startsWith('--dump=')) || '').slice(7);

const lines = readFileSync(path.join(root, 'index.html'), 'utf8').split('\n');
const scriptAt = lines.findIndex(l => l.startsWith('<script type="module">'));
// 自動產生的段落（共用 AI 程式、字典本身）不算
let skip = false;
const code = lines.map((l, i) => {
  if (i < scriptAt) return null;
  if (/BEGIN (共用 AI 程式|介面語言)/.test(l)) skip = true;
  const out = skip ? null : l;
  if (/END (共用 AI 程式|介面語言)/.test(l)) skip = false;
  return out;
});
const unquote = lit => {
  if (lit[0] === '`') return lit.slice(1, -1).replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  return JSON.parse(lit[0] === "'" ? '"' + lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"' : lit);
};
const decode = s => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const keys = new Map();   // 原文 → 行號
const add = (k, ln) => { if (!keys.has(k)) keys.set(k, []); keys.get(k).push(ln); };
const CALL = /(?<![\w.$])([tN])\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
const bad = [];
code.forEach((l, i) => {
  if (l == null) return;
  for (const m of l.matchAll(CALL)) add(unquote(m[2]), i + 1);
  if (/(?<![\w.$])t\(\s*`[^`]*\$\{/.test(l)) bad.push(`第 ${i + 1} 行：t() 裡用了 \${}，請改成 {名稱} 加第二個參數`);
});
const html = lines.slice(0, scriptAt).join('\n');
for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n(?![\w-])[^>]*)>([^<]*)(?=<)/g)) add(decode(m[3].trim()), 'html');
for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*\bdata-i18n-(title|placeholder|aria-label)\b[^>]*>/g)) {
  const a = m[0].match(new RegExp(`\\b${m[1]}="([^"]*)"`));
  if (a) add(decode(a[1]), 'html');
}

const holes = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',');
const dicts = {};
for (const L of ['en', 'vi', 'id']) dicts[L] = Object.values(await import(pathToFileURL(path.join(root, 'i18n', L + '.js')).href))[0];
let problems = 0;
console.log(`介面原文 ${keys.size} 條`);
for (const [L, d] of Object.entries(dicts)) {
  const missing = [...keys.keys()].filter(k => !(k in d));
  const extra = Object.keys(d).filter(k => !keys.has(k));
  const mism = [...keys.keys()].filter(k => k in d && holes(k) !== holes(d[k]));
  const empty = Object.entries(d).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
  console.log(`${L}：已翻 ${keys.size - missing.length}／${keys.size}，缺 ${missing.length}，多餘 ${extra.length}，變數不一致 ${mism.length}，空白 ${empty.length}`);
  for (const k of mism.slice(0, 10)) console.log(`   ✗ 變數不一致：「${k}」→「${d[k]}」`);
  for (const k of empty.slice(0, 10)) console.log(`   ✗ 空白：「${k}」`);
  for (const k of extra.slice(0, 5)) console.log(`   · 多餘（程式裡已經沒有）：「${k}」`);
  if (STRICT) for (const k of missing.slice(0, 10)) console.log(`   ✗ 缺：「${k}」（${keys.get(k).join('、')}）`);
  problems += mism.length + empty.length + (STRICT ? missing.length : 0);
}
for (const b of bad) { console.log('   ✗', b); problems++; }

if (LEFT) {
  const cjk = /[㐀-鿿]/;
  const hits = [];
  code.forEach((l, i) => {
    if (l == null || /i18n-skip/.test(l) || /console\.(log|warn|error)/.test(l)) return;
    const c = l.replace(/\s\/\/\s.*$/, '');
    if (/^\s*\/\//.test(c)) return;
    for (const m of c.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
      let lit = m[0];
      if (lit[0] === '`') lit = lit.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
      if (!cjk.test(lit.replace(/[　（）]/g, ''))) continue;
      if (/(?<![\w.$])[tN]\(\s*$/.test(c.slice(0, m.index))) continue;
      hits.push(`${i + 1}: ${m[0].slice(0, 70)}`);
    }
  });
  const h2 = html.replace(/<([a-z0-9]+)\b[^>]*data-i18n[^>]*>[^<]*<\/\1>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const m of h2.matchAll(/>([^<>]*[㐀-鿿][^<>]*)</g)) hits.push(`HTML：${m[1].trim().slice(0, 60)}`);
  console.log(hits.length ? `\n還沒包 t() 的中文（${hits.length}）：\n   ` + hits.join('\n   ') : '\n沒有還沒包 t() 的中文');
}

if (DUMP) {
  writeFileSync(DUMP, JSON.stringify([...keys].map(([k, w]) => ({ zh: k, at: w })), null, 1));
  console.log('已存：' + DUMP);
}
process.exit(problems ? 1 : 0);
