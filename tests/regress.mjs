// 回歸測試：node regress.mjs（先跑 node build-geom.mjs，或直接 npm test）
// 1. 範例模型輸出快照  2. 使用者模型（OBJ 與 GLB 一致、無開放邊）
// 3. 射線法獨立驗證隱藏線（沿每條候選邊取樣，往觀察者方向打射線）
// 4. 匯入情境：雙面匯出／重複面、mm 與 m 單位一致、遠離原點的 T 形接點
import fs from 'fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as G from './.gen/geom.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const r2 = v => Math.round(v * 100) / 100;
const polyLen = polys => polys.reduce((s, p) => s + p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0), 0);

function prepare(soup, unit = 1) {
  G.state.unit = unit; G.state.zUp = false; G.state.rot.identity();
  const T = G.buildTopology(soup), M = G.transformModel(T);
  G.classifyModel(M, 30); G.setModel(M);
  return M;
}
const summary = M => Object.fromEntries(['front', 'top', 'right'].map(v => {
  const pv = G.processView(v);
  return [v, `${r2(polyLen(pv.vis))}/${r2(polyLen(pv.hid))}`];
}));
const fixture = n => new URL('./fixtures/' + n, import.meta.url);
async function loadGLB(path) {
  const buf = fs.readFileSync(path), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  return G.objectToSoup(gltf.scene);
}
const soupOf = g => G.geomToSoup(g);
const rotSoup = (soup, q) => {   // 以 float32 四元數旋轉（模擬 glTF 節點）並存成 float32
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q), v = new THREE.Vector3(), out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { v.set(soup[i], soup[i + 1], soup[i + 2]).applyMatrix4(m); out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; }
  return out;
};

// ---------- 射線法 oracle ----------
function oracle(M, B) {
  const V = M.V, T = M.tris, nt = M.nt, E = M.E, diag = M.diag, [u, v, d] = [B.u, B.v, B.d];
  const proj = p => [u[0] * p[0] + u[1] * p[1] + u[2] * p[2], v[0] * p[0] + v[1] * p[1] + v[2] * p[2]];
  const P = i => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
  const X = [], Y = [];
  for (let i = 0; i < M.nv; i++) { const q = proj(P(i)); X.push(q[0]); Y.push(q[1]); }
  const opp = (f, a, b) => { const i = T[3 * f], j = T[3 * f + 1], k = T[3 * f + 2]; return (i !== a && i !== b) ? i : (j !== a && j !== b) ? j : k; };
  const tolHit = diag * 1e-4, tolCov = diag * 3e-4;   // tolCov 與 processView 的共線合併容差（2e-4·diag）同級
  // 射線：從點往 d 方向，回傳是否被三角形擋住；靠近三角形投影邊界的樣本視為模糊、略過
  const tri2 = [];
  for (let f = 0; f < nt; f++) tri2.push([0, 1, 2].map(k => T[3 * f + k]));
  // 一條射線是否被擋（嚴格在三角形內部）
  const blocked = (p, a, b) => {
    for (let f = 0; f < nt; f++) {
      const [i, j, k] = tri2[f];
      if ((i === a || j === a || k === a) && (i === b || j === b || k === b)) continue;
      const A = P(i), Bv = P(j), C = P(k);
      const e1 = [Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12 * diag * diag) continue;
      const tv = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
      const uu = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const vv = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det;
      const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det;
      if (t > tolHit && uu > 0 && vv > 0 && uu + vv < 1) return true;
    }
    return false;
  };
  // 在樣本點四周（螢幕上 ±δ）各打一條射線：四條一致才採計；不一致代表在遮蔽輪廓邊緣，略過。
  // 這樣落在遮蔽面內部對角線上的點也能正確判定（偏移後會落進其中一個三角形）
  const delta = diag * 5e-4;
  const hidden = (p, a, b) => {
    const offs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([su, sv]) => blocked([0, 1, 2].map(k => p[k] + delta * (su * u[k] + sv * v[k])), a, b));
    if (offs.every(x => x)) return 1;
    if (offs.every(x => !x)) return 0;
    return -1;
  };
  const toSegs = polys => polys.flatMap(pl => pl.slice(1).map((q, i) => [pl[i][0], pl[i][1], q[0], q[1]]));
  const near = (segs, x, y) => segs.some(s => {
    const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L2)) : 0;
    return Math.hypot(s[0] + dx * t - x, s[1] + dy * t - y) < tolCov;
  });
  // 候選邊（與 computeView 相同的定義：銳邊＋輪廓邊）
  const cands = [];
  for (let e = 0; e < E.n.length; e++) {
    const a = E.a[e], b = E.b[e];
    const dx = X[b] - X[a], dy = Y[b] - Y[a];
    if (dx * dx + dy * dy < (diag * 1e-6) ** 2) continue;
    let cand = M.sharp[e] === 1;
    if (!cand && E.n[e] === 2) {
      const c1 = opp(E.f1[e], a, b), c2 = opp(E.f2[e], a, b), ze = Math.hypot(dx, dy) * diag * 1e-7;
      const s1 = dx * (Y[c1] - Y[a]) - dy * (X[c1] - X[a]), s2 = dx * (Y[c2] - Y[a]) - dy * (X[c2] - X[a]);
      const z1 = Math.abs(s1) < ze ? 0 : Math.sign(s1), z2 = Math.abs(s2) < ze ? 0 : Math.sign(s2);
      cand = z1 * z2 > 0 || ((z1 === 0) !== (z2 === 0));
    }
    if (cand) cands.push(e);
  }
  // 最終圖面（學生實際看到的）：可見線優先於隱藏線
  const pv = G.processView(B.name);
  const FV = toSegs(pv.vis), FH = toSegs(pv.hid);
  let checked = 0, visAsHid = 0, hidAsVis = 0, missing = 0, spurious = 0;
  const examples = [];
  const note = (kind, p) => { if (examples.length < 3) examples.push({ kind, p: p.map(r2) }); };
  // (1) 真實的邊 → 圖面：可見的點要畫成實線；隱藏的點要有線（虛線，或被重疊的實線蓋過）
  for (const e of cands) {
    const a = E.a[e], b = E.b[e], pa = P(a), pb = P(b);
    for (let s = 1; s <= 7; s++) {
      const t = s / 8, p = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
      const h = hidden(p, a, b);
      if (h < 0) continue;
      const [x, y] = proj(p), inV = near(FV, x, y), inH = near(FH, x, y);
      checked++;
      if (h === 0 && !inV) { if (inH) { visAsHid++; note('可見畫成虛線', p); } else { missing++; note('漏畫', p); } }
      if (h === 1 && !inV && !inH) { missing++; note('漏畫', p); }
    }
  }
  // (2) 圖面 → 真實的邊：每段實線上的點，至少要有一條「在該處可見」的真實邊支撐
  const support = (x, y) => {   // 回傳通過 (x,y) 的候選邊在該處的可見性集合
    const res = new Set();
    for (const e of cands) {
      const a = E.a[e], b = E.b[e], dx = X[b] - X[a], dy = Y[b] - Y[a], L2 = dx * dx + dy * dy;
      const t0 = ((x - X[a]) * dx + (y - Y[a]) * dy) / L2;
      if (t0 < -tolCov / Math.sqrt(L2) || t0 > 1 + tolCov / Math.sqrt(L2)) continue;
      const t = Math.min(0.999, Math.max(0.001, t0));
      if (Math.hypot(X[a] + dx * t - x, Y[a] + dy * t - y) > tolCov) continue;
      const pa = P(a), pb = P(b);
      res.add(hidden([0, 1, 2].map(k => pa[k] + (pb[k] - pa[k]) * t), a, b));
    }
    return res;
  };
  for (const [segs, want, label] of [[FV, 0, '隱藏畫成實線'], [FH, 1, '多出虛線']]) {
    for (const sg of segs) {
      const L = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]), n = Math.max(1, Math.ceil(L / (diag * 0.01)));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = sg[0] + (sg[2] - sg[0]) * t, y = sg[1] + (sg[3] - sg[1]) * t;
        const sup = support(x, y);
        if (!sup.size || sup.has(-1) || sup.has(want)) continue;   // 端點附近／模糊／有支撐：略過
        if (want === 0) hidAsVis++; else spurious++;
        note(label, [x, y]);
      }
    }
  }
  return { checked, visAsHid, hidAsVis, missing, spurious, examples };
}
const VIEWS = Object.fromEntries(['front', 'top', 'right', 'iso'].map(n => [n, { ...G.BASES[n], name: n }]));
function oracleAll(name, M, views = Object.keys(VIEWS)) {
  for (const v of views) {
    const r = oracle(M, VIEWS[v]);
    ok(r.visAsHid === 0 && r.hidAsVis === 0 && r.missing === 0 && r.spurious === 0,
      `${name} ${v}：射線檢查 ${r.checked} 點，可見畫成虛線 ${r.visAsHid}、隱藏畫成實線 ${r.hidAsVis}、漏畫 ${r.missing}、多出虛線 ${r.spurious}${r.examples.length ? ' ' + JSON.stringify(r.examples) : ''}`);
  }
}

// ---------- 1. 範例快照 ----------
console.log('\n[1] 範例模型快照');
const SNAP = {
  bracket: { front: '257.06/0', top: '228/144', right: '198/144' },
  shaft: { front: '221.66/0', top: '221.66/0', right: '219.75/0' },
  channel: { front: '140/40', top: '272/0', right: '204/0' },
};
for (const [k, exp] of Object.entries(SNAP)) {
  const M = prepare(soupOf(G.demoGeometry(k).g));
  const got = summary(M);
  ok(JSON.stringify(got) === JSON.stringify(exp) && M.stats.open === 0, `${k} ${JSON.stringify(got)}`);
  oracleAll(k, M);
}

// ---------- 2. 使用者模型 ----------
console.log('\n[2] 使用者模型（SketchUp 匯出的十字塊）');
if (fs.existsSync(fixture('cube1.obj'))) {
  const { soup, unit } = G.parseOBJ(fs.readFileSync(fixture('cube1.obj'), 'utf8'));
  const Mo = prepare(soup, unit ?? 1);
  const so = summary(Mo);
  ok(unit === 1 && Mo.stats.open === 0 && Mo.size.every(s => Math.abs(s - 300) < 1e-6), `cube1.obj 單位 ${unit}、開放邊 ${Mo.stats.open}、尺寸 ${Mo.size.map(r2)}`);
  oracleAll('cube1.obj', Mo);
  const Mg = prepare(await loadGLB(fixture('cube1.glb')), 1000);
  const sg = summary(Mg);
  ok(Mg.stats.open === 0 && Mg.size.every(s => Math.abs(s - 300) < 1e-3), `cube1.glb 開放邊 ${Mg.stats.open}、尺寸 ${Mg.size.map(r2)}`);
  oracleAll('cube1.glb', Mg);
  const close = Object.keys(so).every(v => so[v].split('/').every((x, i) => Math.abs(+x - +sg[v].split('/')[i]) < 0.5));
  ok(close, `OBJ 與 GLB 圖面一致 obj=${JSON.stringify(so)} glb=${JSON.stringify(sg)}`);
} else console.log('  （略過：tests/fixtures/ 沒有 cube1 檔案）');

// ---------- 3. 隱藏線壓力案例 ----------
console.log('\n[3] 隱藏線壓力案例');
const cases = {
  '球 64×32': new THREE.SphereGeometry(50, 64, 32),
  '膠囊': new THREE.CapsuleGeometry(15, 40, 8, 32),
  '傾斜圓柱': new THREE.CylinderGeometry(8, 8, 40, 64).rotateX(0.5).rotateZ(0.3),
  '單軸傾斜圓柱 30°': new THREE.CylinderGeometry(10, 10, 60, 32).rotateX(Math.PI / 6),
  '倒四角錐（漏斗）': new THREE.ConeGeometry(40, 40, 4, 1, false).rotateX(Math.PI).rotateY(Math.PI / 4),
  '圓錐': new THREE.ConeGeometry(25, 60, 96),
};
for (const [name, g] of Object.entries(cases)) oracleAll(name, prepare(soupOf(g)));
{ // 浮點四元數旋轉的 L 塊（glTF 節點旋轉後的常見雜訊）
  const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(80, 0); s.lineTo(80, 20); s.lineTo(20, 20); s.lineTo(20, 60); s.lineTo(0, 60); s.closePath();
  const base = soupOf(new THREE.ExtrudeGeometry(s, { depth: 50, bevelEnabled: false }));
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const qf = new Float32Array([q.x, q.y, q.z, q.w]);
  oracleAll('L 塊（float32 四元數旋轉）', prepare(rotSoup(base, new THREE.Quaternion(qf[0], qf[1], qf[2], qf[3]))));
}

// ---------- 4. 匯入情境 ----------
console.log('\n[4] 匯入情境');
{ // 雙面匯出：每個三角形再反向寫一次，圖面要與單面相同
  const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(60, 0); s.lineTo(60, 15); s.lineTo(20, 15); s.lineTo(20, 40); s.lineTo(0, 40); s.closePath();
  const one = soupOf(new THREE.ExtrudeGeometry(s, { depth: 30, bevelEnabled: false }));
  const two = new Float64Array(one.length * 2); two.set(one);
  for (let i = 0; i < one.length; i += 9) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) two[one.length + i + 3 * k + c] = one[i + 3 * (2 - k) + c];
  const a = summary(prepare(one)), Mb = prepare(two), b = summary(Mb);
  ok(JSON.stringify(a) === JSON.stringify(b) && Mb.dupRemoved > 0, `雙面匯出 = 單面 ${JSON.stringify(b)}（移除重複 ${Mb.dupRemoved}）`);
}
{ // mm 與 m：同一模型、同樣的細縫三角形，圖面要一樣
  const g = new THREE.CylinderGeometry(30, 30, 40, 48);
  const mm = soupOf(g), m = Float32Array.from(mm, x => x / 1000);
  const a = summary(prepare(mm, 1)), Mb = prepare(m, 1000), b = summary(Mb);
  const close = Object.keys(a).every(v => a[v].split('/').every((x, i) => Math.abs(+x - +b[v].split('/')[i]) < 0.05));
  ok(close && Mb.stats.open === 0, `mm 與 m 圖面一致 mm=${JSON.stringify(a)} m=${JSON.stringify(b)}`);
}
{ // 遠離原點 + 6 位有效數字的 OBJ，T 形接點仍要接合
  const off = 5000, f6 = x => Number((x + off).toPrecision(6));
  const vtx = [[0, 0, 0], [100, 0, 0], [100, 40, 0], [0, 40, 0], [0, 0, 60], [100, 0, 60], [100, 40, 60], [0, 40, 60], [37.3, 0, 0]];
  const objTxt = vtx.map(p => `v ${f6(p[0] * Math.cos(0.3) - p[2] * Math.sin(0.3))} ${f6(p[1])} ${f6(p[0] * Math.sin(0.3) + p[2] * Math.cos(0.3))}`).join('\n') +
    '\nf 1 4 3 9\nf 9 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n';
  const { soup } = G.parseOBJ(objTxt);
  const M = prepare(soup);
  ok(M.stats.open === 0 && M.tjFixed > 0, `遠離原點 5 m 的 T 形接點：開放邊 ${M.stats.open}、接合 ${M.tjFixed}`);
}
{ // 真正的破洞仍要回報
  const g = new THREE.BoxGeometry(40, 30, 20); g.setIndex(Array.from(g.index.array.slice(0, 30)));   // 少一面
  const M = prepare(soupOf(g));
  ok(M.stats.open > 0, `少一面的盒子仍回報開放邊 ${M.stats.open}`);
}
{ // 單位註解
  const t = ['# File units = millimeters', '# File units = centimeters', '# This file uses meters as units for non-parametric coordinates.', '# File units = inches', '# metric conversion note', '# File units = yards'];
  const got = t.map(G.unitFromComment);
  ok(JSON.stringify(got) === JSON.stringify([1, 10, 1000, 25.4, null, 914.4]), `單位註解 ${JSON.stringify(got)}`);
}

// ---------- 5. 尺寸 ----------
console.log('\n[5] 尺寸（並聯尺寸＋孔）');
function dimsOf(M, proj = 'third') {
  G.setModel(M);
  const side = proj === 'third' ? 'right' : 'left';
  const views = { front: G.processView('front'), top: G.processView('top'), side: G.processView(side) };
  const plan = G.planDims(views, proj, false);
  const out = {};
  for (const [key, list] of Object.entries(plan.slots)) out[key] = list.map(d => (d.overall ? '總' : '') + Math.round(d.value * 100) / 100).join(',');
  const holes = Object.values(views).flatMap(v => v.holes.map(h => `${v.name}:Ø${Math.round(2 * h.r * 100) / 100}${h.depth ? '深' + Math.round(h.depth * 100) / 100 : ''}`));
  return { slots: out, holes, notes: plan.notes };
}
const DIM_SNAP = {
  bracket: { slots: { 'front:bottom': '8,16,44,總60', 'front:left': '6,12,33,總45', 'side:bottom': '總36' }, holes: ['front:Ø8', 'front:Ø7'] },
  shaft: { slots: { 'front:bottom': '20,50,58,總60', 'front:left': '總30', 'side:bottom': '總30' }, holes: [] },
  channel: { slots: { 'front:bottom': '總40', 'front:left': '總30', 'side:right': '14', 'side:bottom': '16,40,總56' }, holes: [] },
};
for (const [k, exp] of Object.entries(DIM_SNAP)) {
  const got = dimsOf(prepare(soupOf(G.demoGeometry(k).g)));
  const sortObj = o => JSON.stringify(Object.keys(o).sort().map(x => [x, o[x]]));
  ok(sortObj(got.slots) === sortObj(exp.slots) && JSON.stringify(got.holes.sort()) === JSON.stringify(exp.holes.slice().sort()),
    `${k} 尺寸 ${JSON.stringify(got.slots)} 孔 ${JSON.stringify(got.holes)}`);
}
if (fs.existsSync(fixture('cube1.obj'))) {
  const { soup } = G.parseOBJ(fs.readFileSync(fixture('cube1.obj'), 'utf8'));
  const got = dimsOf(prepare(soup));
  const all = Object.values(got.slots).join('|');
  ok(got.holes.length === 2 && got.holes.every(h => h.includes('Ø50')) && ['100', '150', '200', '總300'].every(v => all.includes(v)),
    `cube1 尺寸 ${JSON.stringify(got.slots)} 孔 ${JSON.stringify(got.holes)}`);
  const first = dimsOf(prepare(soup), 'first');
  ok(Object.keys(first.slots).includes('top:right') && Object.keys(first.slots).includes('top:bottom'), `cube1 第一角法尺寸位置 ${Object.keys(first.slots).join(' ')}`);
}
{ // 盲孔：深度要標出來；凸柱不是孔
  const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(60, 0); s.lineTo(60, 40); s.lineTo(0, 40); s.closePath();
  const h = new THREE.Path(); h.absarc(20, 20, 5, 0, Math.PI * 2, true); s.holes.push(h);
  const top = soupOf(new THREE.ExtrudeGeometry(s, { depth: 8, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, 12, 40));  // 上層 8 厚，帶孔
  const bot = soupOf(new THREE.BoxGeometry(60, 12, 40).translate(30, 6, 20));   // 下層 12 厚實心（疊在一起成為 8 深的盲孔）
  const cyl = soupOf(new THREE.CylinderGeometry(6, 6, 10, 32).translate(45, 25, 20));   // 凸柱（獨立實體）
  const M = prepare(Float64Array.from([...top, ...bot, ...cyl]));
  const axes = M.axes.map(g => `${g.isHole ? '孔' : '柱'}r${Math.round(g.rMax * 10) / 10}${g.depth ? '深' + Math.round(g.depth * 10) / 10 : ''}`).sort();
  ok(axes.includes('孔r5深8') && axes.includes('柱r6'), `盲孔與凸柱判斷 ${JSON.stringify(axes)}`);
}

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n✓ 全部通過');
process.exit(fails ? 1 : 0);
