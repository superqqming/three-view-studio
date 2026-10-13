// 探測：哪些輸出格式（JSON schema）Anthropic 編譯得過（「The compiled grammar is too large」就是編譯不過）。
// 只送不帶圖片、只回幾個字的小請求；編譯不過的請求 Anthropic 會直接退回、不收費，編譯得過的每個約幾千個輸入 token。
//
//   cd tests && node probe-schema.mjs --gateway             用課程閘道的金鑰試一組由大到小的格式（找出上限在哪裡）
//   cd tests && node probe-schema.mjs --gateway <檔案.js>   只試這個檔案 export 的 THREEVIEW_SCHEMA（例如定案的新格式）
//   不加 --gateway：改用自己的 Anthropic 金鑰（執行時貼上，畫面不顯示、不存檔；或設定環境變數 ANTHROPIC_API_KEY）
//
// --gateway 經閘道的管理端 POST /v1/admin/check-schema，管理金鑰從 Shared_Services/ai-gateway/local/secrets.json 讀（不會印出來）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(here, '../../..');
const MODEL = 'claude-opus-5-5';
const GW = path.join(HUB, 'Shared_Services/ai-gateway/worker/src/tools/assembly');
const load = async (file, name) => (await import(pathToFileURL(file).href))[name];

// ---- 要試的格式 ----
const clone = o => JSON.parse(JSON.stringify(o));
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const num = { type: 'number' }, strArr = { type: 'array', items: { type: 'string' } };
const part = s => s.properties.parts.items;
const feature = s => part(s).properties.steps.items.properties.features.items;
const T = {
  // 「找到的視圖」「圖面檢查」改成字串陣列（例如「前視圖：左上」「【俯視圖】缺少中心線」）
  strings: s => { s.properties.views_found = clone(strArr); part(s).properties.review = clone(strArr); return s; },
  // 凸台的矩形島不再包一層物件：u0、u1、v0、v1 直接放在島上
  flatIsland: s => {
    const isl = feature(s).properties.islands.items;
    delete isl.properties.rect;
    Object.assign(isl.properties, { u0: num, u1: num, v0: num, v1: num });
    isl.required = Object.keys(isl.properties);
    return s;
  },
  // 輪廓的每一段改成數字陣列（直線 [u, v]；圓弧 [u, v, cu, cv, 方向]）
  numOutline: s => { feature(s).properties.outline = { type: 'array', items: { type: 'array', items: num } }; return s; },
  // 量餘裕：多加一個有 6 個數字的物件陣列
  pad: s => { s.properties.pad = { type: 'array', items: obj({ a: num, b: num, c: num, d: num, e: num, f: num }) }; s.required.push('pad'); return s; },
};
const apply = (base, ...fs) => fs.reduce((s, f) => f(s), clone(base));

async function variants() {
  const fileArg = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (fileArg) {
    const file = path.resolve(process.cwd(), fileArg);
    return [[path.basename(file), await load(file, 'THREEVIEW_SCHEMA')]];
  }
  const TV = await load(path.join(here, '../ai/threeview-schema.js'), 'THREEVIEW_SCHEMA');   // 原始檔（改格式之前和線上相同）
  const AS = await load(path.join(GW, 'schema.js'), 'RESULT_SCHEMA');
  return [
    ['組合單元目前的格式（對照：v1 也用這份）', AS],
    ['三視圖目前的格式（預期編譯不過）', TV],
    ['三視圖＋視圖／檢查改字串', apply(TV, T.strings)],
    ['三視圖＋視圖／檢查改字串＋多 6 個數字（量餘裕）', apply(TV, T.strings, T.pad)],
    ['三視圖＋島攤平', apply(TV, T.flatIsland)],
    ['三視圖＋視圖／檢查改字串＋島攤平', apply(TV, T.strings, T.flatIsland)],
    ['三視圖＋視圖／檢查改字串＋輪廓改數字陣列', apply(TV, T.strings, T.numOutline)],
    ['三視圖＋三項都改', apply(TV, T.strings, T.flatIsland, T.numOutline)],
  ];
}

// ---- 金鑰（不顯示） ----
function askHidden(q) {
  if (process.env.ANTHROPIC_API_KEY) return Promise.resolve(process.env.ANTHROPIC_API_KEY.trim());
  if (!process.stdin.isTTY) throw new Error('請在終端機執行，或先設定 ANTHROPIC_API_KEY');
  process.stdout.write(q);
  return new Promise(resolve => {
    const stdin = process.stdin;
    let s = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); resolve(s.trim()); return; }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on('data', on);
  });
}

async function probe(key, schema) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 16,
      messages: [{ role: 'user', content: 'Format test only. Output the shortest valid JSON for the schema.' }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 };
  return { ok: false, status: r.status, message: d.error?.message || JSON.stringify(d).slice(0, 200) };
}

const list = await variants();
if (process.argv.includes('--gateway')) {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(path.join(HUB, 'Shared_Services/ai-gateway/config.json'), 'utf8'));
  const admin = JSON.parse(readFileSync(path.join(HUB, 'Shared_Services/ai-gateway/local/secrets.json'), 'utf8')).ADMIN_KEY;
  const url = (cfg.gateway || cfg.url || 'https://course-ai-gateway.superqqming.workers.dev').replace(/\/$/, '');
  const r = await fetch(url + '/v1/admin/check-schema', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-Key': admin, 'User-Agent': 'probe-schema' },
    body: JSON.stringify({ schemas: Object.fromEntries(list) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`閘道回應 ${r.status}：${d.message || JSON.stringify(d)}`); process.exit(1); }
  let inTok = 0, outTok = 0;
  for (const x of d.results) {
    if (x.ok) { inTok += x.usage.input_tokens || 0; outTok += x.usage.output_tokens || 0; console.log(`✓ 編譯得過　${x.name}（${x.bytes} 字元；輸入 ${x.usage.input_tokens}、輸出 ${x.usage.output_tokens} token）`); }
    else if (x.tooLarge) console.log(`✗ 太大　　　${x.name}（${x.bytes} 字元）`);
    else console.log(`? 其他錯誤　${x.name}：${x.status} ${x.type} ${x.detail}`);
  }
  console.log(`\n模型 ${d.model}；共用了輸入 ${inTok}、輸出 ${outTok} token（閘道的帳戶）`);
  process.exit(0);
}
const key = await askHidden('貼上你的 Anthropic 金鑰（sk-ant-…，畫面不會顯示），按 Enter：');
if (!/^sk-ant-[\x21-\x7e]{10,}$/.test(key)) { console.error('金鑰格式不對（應以 sk-ant- 開頭）'); process.exit(1); }
let inTok = 0, outTok = 0;
for (const [name, schema] of list) {
  const bytes = JSON.stringify(schema).length;
  const r = await probe(key, schema);
  if (r.ok) { inTok += r.input; outTok += r.output; console.log(`✓ 編譯得過　${name}（${bytes} 字元；輸入 ${r.input}、輸出 ${r.output} token）`); }
  else if (/grammar is too large|too complex/i.test(r.message)) console.log(`✗ 太大　　　${name}（${bytes} 字元）`);
  else if (r.status === 401 || r.status === 403 || /usage limits|credit balance/i.test(r.message)) { console.log(`! 停止：${r.status} ${r.message}`); break; }
  else console.log(`? 其他錯誤　${name}：${r.status} ${r.message}`);
}
console.log(`\n共用了輸入 ${inTok}、輸出 ${outTok} token（以 Opus 每百萬輸入 5、輸出 25 美元估，約 US$${(inTok * 5e-6 + outTok * 25e-6).toFixed(3)}）`);
