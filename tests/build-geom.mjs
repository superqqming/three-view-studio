// 從 ../index.html 抽出幾何管線（拓撲 → 分類 → 視圖）與載入函式，產生可在 Node 執行的 .gen/geom.mjs
import fs from 'fs';
const src = new URL('../index.html', import.meta.url);
const lines = fs.readFileSync(src, 'utf8').split('\n');
const at = prefix => { const i = lines.findIndex(l => l.startsWith(prefix)); if (i < 0) throw new Error('找不到 ' + prefix); return i; };
const pipeline = lines.slice(at('function buildTopology'), lines.findIndex(l => l.includes('// 6. 圖面')) - 1).join('\n');
const loaders = lines.slice(at('function objectToSoup'), at('function demoGeometry')).join('\n');
const demo = lines.slice(at('function demoGeometry'), at('async function loadFile')).join('\n');
const basesStart = at('const BASES = {');
let basesEnd = basesStart; while (!lines[basesEnd].startsWith('};')) basesEnd++;
const out = `import * as THREE from 'three';
export const state = { zUp: false, rot: new THREE.Matrix4(), unit: 1, thr: 30 };
${lines.slice(basesStart, basesEnd + 1).join('\n')}
let model = null; export function setModel(m) { model = m; viewCache = {}; }
let viewCache = {};
${pipeline}
${loaders}
${demo}
export { BASES, buildTopology, repairTJunctions, transformModel, classifyModel, computeView, processView, objectToSoup, geomToSoup, parseOBJ, unitFromComment, demoGeometry };
`;
fs.mkdirSync(new URL('./.gen/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./.gen/geom.mjs', import.meta.url), out);
console.log('已產生 tests/.gen/geom.mjs（' + out.split('\n').length + ' 行）');
