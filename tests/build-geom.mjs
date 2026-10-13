// 從 ../index.html 抽出幾何管線（拓撲 → 分類 → 視圖）與載入函式，產生可在 Node 執行的 .gen/geom.mjs
import fs from 'fs';
const src = new URL('../index.html', import.meta.url);
const lines = fs.readFileSync(src, 'utf8').split('\n');
const at = prefix => { const i = lines.findIndex(l => l.startsWith(prefix)); if (i < 0) throw new Error('找不到 ' + prefix); return i; };
const pipeline = lines.slice(at('function buildTopology'), lines.findIndex(l => l.includes('// 6. 圖面')) - 1).join('\n');
const loaders = lines.slice(at('function objectToSoup'), at('function demoGeometry')).join('\n');
const demo = lines.slice(at('function demoGeometry'), at('async function loadFile')).join('\n');
const stdStart = at('const STD = {');
let stdEnd = stdStart; while (!lines[stdEnd].startsWith('};')) stdEnd++;
const dims = lines.slice(at('const VIEW_AXES = {'), at('function computeLayout')).join('\n');
// AI 辨識：草稿 → 工件 → manifold 實體（不含介面）
const aiGeom = lines.slice(at('const pathTokens = '), at('function renderCompare')).join('\n');
const basesStart = at('const BASES = {');
let basesEnd = basesStart; while (!lines[basesEnd].startsWith('};')) basesEnd++;
const out = `import * as THREE from 'three';
export const state = { zUp: false, rot: new THREE.Matrix4(), unit: 1, thr: 30, showDims: true, showDetail: true, showHoles: true, hiddenDims: new Set() };
${lines.slice(stdStart, stdEnd + 1).join('\n')}
${lines.slice(basesStart, basesEnd + 1).join('\n')}
let model = null; export function setModel(m) { model = m; viewCache = {}; }
let viewCache = {};
${pipeline}
${loaders}
${demo}
${dims}
const esc = s => String(s);
// 介面語言：測試一律用中文原文（與網頁的 t()／N() 相同的變數代換）
const t = (s, v) => { let o = s.includes('|') ? s.slice(s.indexOf('|') + 1) : s; if (v) o = o.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)); return o; };
const N = s => s;
${aiGeom}
export function setMF(m) { MF = m; }
export { applyChoices, toPart, buildPart, outlinePoints, reviewItems, planDims,  BASES, buildTopology, repairTJunctions, transformModel, classifyModel, computeView, processView, objectToSoup, geomToSoup, parseOBJ, unitFromComment, demoGeometry };
`;
fs.mkdirSync(new URL('./.gen/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./.gen/geom.mjs', import.meta.url), out);
console.log('已產生 tests/.gen/geom.mjs（' + out.split('\n').length + ' 行）');
