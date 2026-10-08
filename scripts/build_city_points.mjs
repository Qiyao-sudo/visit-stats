// 构建城市坐标表：DataV 城市中心点(经纬度) → 现有 SVG 地图坐标系
// 方法：逐省形状配准——烘焙路径最大子多边形 与 DataV 省界最大环 做 PCA 主轴对齐，
//       4 种轴向镜像组合按栅格 IoU 择优；省内城市随变换落位，精度≈地图简化级别。
import fs from 'node:fs';

const GEO_DIR = new URL('../geo/', import.meta.url);
const map = JSON.parse(fs.readFileSync(new URL('china-map.json', GEO_DIR), 'utf8'));
const OUT = new URL('city-points.json', GEO_DIR);

const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
async function getJSON(url) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500 * (t + 1)));
  }
  return null;
}

/* ---- 与 server.js pathCenter 相同的路径解析（多边形也带回） ---- */
function parseSubs(d) {
  const subs = [];
  let cx = 0, cy = 0, cur = null;
  const close = () => { if (cur && cur.length > 2) subs.push(cur); cur = null; };
  const re = /([MmLlZz])([^MmLlZz]*)/g;
  let mm;
  while ((mm = re.exec(d))) {
    const c = mm[1], ns = (mm[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    if (c === 'M') { cx = ns[0] || 0; cy = ns[1] || 0; close(); cur = [[cx, cy]]; }
    else if (c === 'l') { if (!cur) cur = []; for (let i = 0; i + 1 < ns.length; i += 2) { cx += ns[i]; cy += ns[i + 1]; cur.push([cx, cy]); } }
    else close();
  }
  close();
  return subs;
}
function polyCentroid(poly) {
  let A = 0, px = 0, py = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cr = p[0] * q[1] - q[0] * p[1];
    A += cr; px += (p[0] + q[0]) * cr; py += (p[1] + q[1]) * cr;
  }
  A /= 2;
  return { a: A, x: px / (6 * A), y: py / (6 * A) };
}
function largestSub(d) {
  let best = null;
  for (const poly of parseSubs(d)) {
    const c = polyCentroid(poly);
    if (!best || Math.abs(c.a) > Math.abs(best.c.a)) best = { poly, c };
  }
  return best;
}
function ringCentroid(ring) { // DataV [lng,lat]
  const pts = ring.map(p => [p[0], p[1]]);
  const c = polyCentroid(pts);
  return { poly: pts, c };
}

/* ---- 2x2 协方差主轴 ---- */
function pca(pts, m) {
  let s11 = 0, s12 = 0, s22 = 0;
  for (const p of pts) {
    const dx = p[0] - m[0], dy = p[1] - m[1];
    s11 += dx * dx; s12 += dx * dy; s22 += dy * dy;
  }
  const n = pts.length;
  s11 /= n; s12 /= n; s22 /= n;
  const tr = s11 + s22, det = s11 * s22 - s12 * s12;
  const disc = Math.max(Math.sqrt(Math.max(tr * tr / 4 - det, 0)), 1e-12);
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-12);
  let e1 = Math.abs(s12) > 1e-12 ? [l1 - s22, s12] : [1, 0];
  const n1 = Math.hypot(e1[0], e1[1]); e1 = [e1[0] / n1, e1[1] / n1];
  const e2 = [-e1[1], e1[0]];
  return { e1, e2, s1: Math.sqrt(l1), s2: Math.sqrt(l2) };
}

/* ---- 栅格 IoU ---- */
function maskIoU(polyA, polyB) {
  function mask(poly) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    poly.forEach(p => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
    const N = 48, g = Array.from({ length: N }, () => new Uint8Array(N));
    const inPoly = (x, y) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = minx + (maxx - minx) * (i + .5) / N, y = miny + (maxy - miny) * (j + .5) / N;
      if (inPoly(x, y)) g[j][i] = 1;
    }
    return g;
  }
  const a = mask(polyA), b = mask(polyB);
  let inter = 0, un = 0;
  for (let i = 0; i < 48; i++) for (let j = 0; j < 48; j++) { if (a[j][i] && b[j][i]) inter++; if (a[j][i] || b[j][i]) un++; }
  return un ? inter / un : 0;
}

/* ---- 拉取 DataV ---- */
const china = await getJSON(BASE + '100000_full.json');
if (!china) { console.error('DataV 全国数据拉取失败'); process.exit(1); }
const provGeo = {}; // name -> {ring, ringC, adcode}
for (const f of china.features) {
  if (!f.geometry) continue;
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  let best = null;
  for (const poly of polys) {
    const r = ringCentroid(poly[0]);
    if (!best || Math.abs(r.c.a) > Math.abs(best.r.c.a)) best = { r };
  }
  if (best) provGeo[f.properties.name] = { ring: best.r.poly, ringC: best.r.c, adcode: String(f.properties.adcode) };
}
console.log('DataV 省级几何:', Object.keys(provGeo).length);

const cityGeo = {};
let failProvs = [];
for (const [pname, pv] of Object.entries(provGeo)) {
  const gj = await getJSON(BASE + pv.adcode + '_full.json');
  if (!gj) { failProvs.push(pname); continue; }
  const cities = {};
  for (const f of gj.features) {
    const c = f.properties.center || f.properties.centroid;
    const n = f.properties.name;
    if (c && n && n !== pname) cities[n] = c;
  }
  if (Object.keys(cities).length) cityGeo[pname] = cities;
  await new Promise(r => setTimeout(r, 120));
}
console.log('城市数据完成省:', Object.keys(cityGeo).length, failProvs.length ? '失败:' + failProvs.join(',') : '');

/* ---- 逐省形状配准并投影城市 ---- */
const out = {};
let nCities = 0, aligned = 0, iouSum = 0;
for (const [pname, pg] of Object.entries(provGeo)) {
  if (!map.provinces[pname] || !cityGeo[pname]) continue;
  const ms = largestSub(map.provinces[pname].d);
  if (!ms) continue;
  const mapPoly = ms.poly, mapC = ms.c;
  const geoPoly = pg.ring, geoC = pg.ringC;
  const m0 = [mapC.x, mapC.y], g0 = [geoC.x, geoC.y];
  const M = pca(mapPoly, m0), G = pca(geoPoly, g0);
  // geo → map：p_map = m0 + E · D · S · Fᵀ · (p_geo − g0)
  const S = [M.s1 / G.s1, M.s2 / G.s2];
  let bestT = null, bestIoU = -1;
  for (const d1 of [1, -1]) for (const d2 of [1, -1]) {
    const T = p => {
      const dx = p[0] - g0[0], dy = p[1] - g0[1];
      // Fᵀ·d
      const u = G.e1[0] * dx + G.e1[1] * dy, v = G.e2[0] * dx + G.e2[1] * dy;
      const uu = u * d1 * S[0], vv = v * d2 * S[1];
      return [m0[0] + M.e1[0] * uu + M.e2[0] * vv, m0[1] + M.e1[1] * uu + M.e2[1] * vv];
    };
    const iou = maskIoU(mapPoly, geoPoly.map(T));
    if (iou > bestIoU) { bestIoU = iou; bestT = T; }
  }
  if (!bestT || bestIoU < 0.5) { console.log('⚠', pname, '配准 IoU 过低', bestIoU.toFixed(2), '跳过'); continue; }
  aligned++; iouSum += bestIoU;
  const m = {};
  for (const [cname, c] of Object.entries(cityGeo[pname])) {
    const pt = bestT(c);
    if (pt && isFinite(pt[0]) && isFinite(pt[1])) { m[cname] = [+pt[0].toFixed(1), +pt[1].toFixed(1)]; nCities++; }
  }
  if (Object.keys(m).length) out[pname] = m;
}
console.log('配准成功省:', aligned, '平均IoU:', (iouSum / aligned).toFixed(3));
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('city-points.json:', Object.keys(out).length, '省', nCities, '市,', (fs.statSync(OUT).size / 1024).toFixed(1) + 'KB');

// 抽查
const h = out['海南省'] || {};
console.log('海南: 海口', h['海口市'], '三亚', h['三亚市'], '三沙', h['三沙市']);
console.log('广东: 广州', (out['广东省'] || {})['广州市'], '深圳', (out['广东省'] || {})['深圳市'], '湛江', (out['广东省'] || {})['湛江市']);
console.log('新疆: 乌鲁木齐', (out['新疆维吾尔自治区'] || {})['乌鲁木齐市'], '喀什', (out['新疆维吾尔自治区'] || {})['喀什地区']);
console.log('内蒙: 呼和浩特', (out['内蒙古自治区'] || {})['呼和浩特市'], '呼伦贝尔', (out['内蒙古自治区'] || {})['呼伦贝尔市']);
