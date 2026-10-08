#!/usr/bin/env node
/**
 * visit-stats v2 —— 自建轻量访客统计（全面增强版）
 * 零依赖纯 Node。仅监听 127.0.0.1:3100，由各站点 nginx 以 /stats/ 路径同源反代。
 *
 * 采集类型 y: pv=浏览 / d=停留时长 / sd=滚动深度 / out=站外点击 / dl=下载
 * 存储: data/YYYY-MM-DD.jsonl + data/vid-index.json(访客首次出现索引)
 * API: /api/summary /api/events /api/visitor /api/realtime /api/export
 * 静态: /t.js(tracker) /china-map.json / (面板)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3100;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const TOKEN_FILE = path.join(ROOT, ".token");
const VID_INDEX_FILE = path.join(DATA_DIR, "vid-index.json");
const GEO_FILE = path.join(ROOT, "geo", "geocn-compact.json");
const MAP_FILE = path.join(ROOT, "geo", "china-map.json");
const CITY_FILE = path.join(ROOT, "geo", "city-points.json");
const RETAIN_DAYS = 400;

/* ================= token ================= */
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();

/* ================= 地理数据 ================= */
if (!fs.existsSync(GEO_FILE)) {
  console.error("[geo] 缺少 " + GEO_FILE);
  console.error("[geo] 地理库不入库（含授权数据），请获取 GeoCN / GeoLite2 并构建紧凑库，参见 README「地理数据」一节");
  process.exit(1);
}
console.log("[geo] loading", GEO_FILE);
const GEO = JSON.parse(fs.readFileSync(GEO_FILE, "utf8"));
const V4 = GEO.v4, V6 = GEO.v6, ISPS = GEO.isp, DIV = GEO.div;
const V4N = (V4.length / 4) | 0, V6N = (V6.length / 10) | 0;
const MAP_JSON = fs.existsSync(MAP_FILE) ? fs.readFileSync(MAP_FILE) : null;
const CITY_POINTS = fs.existsSync(CITY_FILE) ? JSON.parse(fs.readFileSync(CITY_FILE, "utf8")) : null;
console.log(`[geo] v4=${V4N} v6=${V6N} map=${MAP_JSON ? "ok" : "missing"}`);

/* ================= 境外国家表（GeoLite2 非 CN 段，v6@/48） ================= */
const CTY_FILE = path.join(ROOT, "geo", "country-compact.json");
const CTY = fs.existsSync(CTY_FILE) ? JSON.parse(fs.readFileSync(CTY_FILE, "utf8")) : null;
const C4 = CTY ? CTY.v4 : [], C6 = CTY ? CTY.v6 : [], CNAMES = CTY ? CTY.names : [];
const C4N = (C4.length / 3) | 0, C6N = (C6.length / 9) | 0;
console.log(`[geo] country v4=${C4N} v6=${C6N} names=${CNAMES.length}`);

function lookupCountry(ip) {
  if (!CTY) return null;
  if (ip.includes(".")) {
    const m = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const n = +m[1] * 16777216 + +m[2] * 65536 + +m[3] * 256 + +m[4];
    let lo = 0, hi = C4N - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, b = mid * 3;
      if (n < C4[b]) hi = mid - 1;
      else if (n > C4[b + 1]) lo = mid + 1;
      else return CNAMES[C4[b + 2]] || null;
    }
    return null;
  }
  const w = parseIPv6(ip);
  if (!w) return null;
  let l = 0, h = C6N - 1;
  while (l <= h) {
    const mid = (l + h) >> 1, b = mid * 9;
    let before = false, after = false;
    for (let i = 0; i < 4; i++) {
      if (w[i] < C6[b + i]) { before = true; break; }
      if (w[i] > C6[b + 4 + i]) { after = true; break; }
    }
    if (before) h = mid - 1;
    else if (after) l = mid + 1;
    else return CNAMES[C6[b + 8]] || null;
  }
  return null;
}
/* 统一解析链：GeoCN(中国省市区+ISP) → 国家库(境外国家) → 未知 */
function resolveGeo(ip) {
  const g = lookupGeo(ip);
  if (g) {
    const n = geoName(g.code);
    return { prov: n.prov, city: n.city, district: n.district, isp: g.isp || "" };
  }
  const c = lookupCountry(ip);
  if (c) return { prov: c, city: "", district: "", isp: "" };
  return { prov: "境外/未知", city: "", district: "", isp: "" };
}

function lookupGeo(ip) {
  if (!ip) return null;
  if (ip.includes(".")) {
    const m = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    // 纯算术：位运算在首位 ≥128 时会溢出为负数
    const n = +m[1] * 16777216 + +m[2] * 65536 + +m[3] * 256 + +m[4];
    let lo = 0, hi = V4N - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, b = mid * 4;
      if (n < V4[b]) hi = mid - 1;
      else if (n > V4[b + 1]) lo = mid + 1;
      else return { code: V4[b + 2], isp: ISPS[V4[b + 3]] || "" };
    }
    return null;
  }
  const g6 = parseIPv6(ip);
  if (!g6) return null;
  const w = g6; // [w0,w1,w2,w3] 从高到低
  // v4 映射地址（::ffff:a.b.c.d / ::a.b.c.d）回落到 v4 表
  if (w[0] === 0 && w[1] === 0 && w[2] === 0) {
    const m = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) return lookupGeo(m[0]);
  }
  const NW = 10; // 每条 v6 记录 10 个数：start×4 + end×4 + code + isp
  let l = 0, h = V6N - 1;
  while (l <= h) {
    const mid = (l + h) >> 1, b = mid * NW;
    let cmp = 0;
    for (let i = 0; i < 4 && cmp === 0; i++) {
      const s = V6[b + i], e = V6[b + 4 + i];
      if (w[i] < s) cmp = -1;
      else if (w[i] > e) cmp = 1;
      else cmp = 0; // 落在该维区间内，需继续比对下一维
      if (cmp === 0 && w[i] > s) break; // 严格大于起点，必在区间内（前提：区间无跨维）
    }
    if (cmp === 0) {
      // 逐维精确判定（处理起点=终点的窄段）
      let inRange = true;
      for (let i = 0; i < 4; i++) {
        if (w[i] < V6[b + i] || w[i] > V6[b + 4 + i]) { inRange = false; break; }
      }
      if (inRange) return { code: V6[b + 8], isp: ISPS[V6[b + 9]] || "" };
      cmp = 1;
    }
    if (cmp < 0) h = mid - 1; else l = mid + 1;
  }
  return null;
}
/* 解析任意写法的 IPv6（含 ::、完整 8 组、v4 映射尾）为 4 个 u32（从高到低） */
function parseIPv6(str) {
  let s = String(str).toLowerCase().trim();
  const v4m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4
  if (v4m) {
    const o = v4m[2].split(".").map(Number);
    if (o.some((x) => isNaN(x) || x > 255)) return null;
    s = v4m[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":").filter((x) => x !== "") : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(":").filter((x) => x !== "") : [];
  const fill = 8 - head.length - tail.length;
  if (dbl.length === 2 && fill < 0) return null;
  if (dbl.length === 1 && head.length !== 8) return null;
  const groups = head.concat(new Array(dbl.length === 2 ? fill : 0).fill(0), tail);
  if (groups.length !== 8) return null;
  const w = [0, 0, 0, 0];
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || "0", 16);
    if (isNaN(v) || v > 0xffff) return null;
    w[i >> 1] = w[i >> 1] * 65536 + v;
  }
  return w;
}
const CN_PROV = new Set(Object.keys(DIV).filter((k) => k.endsWith("0000") && k.length === 6).map((k) => DIV[k]));
function geoName(code) {
  code = String(code);
  if (code === "0") return { prov: "境外/未知", city: "", district: "" };
  const prov = DIV[code.slice(0, 2) + "0000"] || "";
  const cityName = DIV[code.slice(0, 4) + "00"] || "";
  const fullName = DIV[code] || "";
  let city = cityName && cityName !== prov ? cityName : "";
  let district = "";
  if (fullName && fullName !== prov && fullName !== cityName && code.slice(4) !== "00") district = fullName;
  return { prov: prov || "未知", city, district };
}

/* ================= UA 解析 ================= */
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternal|curl|wget|python-requests|go-http-client|headlesschrome|node-fetch|axios|semrush|ahrefs|mj12|yandex/i;
function parseUA(ua) {
  const b = /Edg\//.test(ua) ? "Edge"
    : /MQQBrowser|QQBrowser/.test(ua) ? "QQ浏览器"
    : /MicroMessenger/.test(ua) ? "微信内嵌"
    : /MiuiBrowser|MIUI/.test(ua) ? "小米浏览器"
    : /baiduboxapp|Baidu/.test(ua) ? "百度"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "其他";
  const o = /Windows/.test(ua) ? "Windows"
    : /HarmonyOS|OpenHarmony/.test(ua) ? "HarmonyOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux" : "其他";
  const d = /iPad|Tablet/.test(ua) ? "平板"
    : /Mobile|Android|iPhone/.test(ua) ? "手机" : "电脑";
  return { b, o, d };
}

/* ================= 访客首次出现索引 ================= */
let vidIndex = {};   // vid -> first ts
let vidDirty = false;
function loadVidIndex() {
  try { vidIndex = JSON.parse(fs.readFileSync(VID_INDEX_FILE, "utf8")); return; } catch (e) {}
  // 首次启动：从历史数据重建
  vidIndex = {};
  let n = 0;
  for (const f of listDayFiles()) {
    for (const ev of readDay(path.join(DATA_DIR, f))) {
      if (ev.vid && (!vidIndex[ev.vid] || ev.t < vidIndex[ev.vid])) { vidIndex[ev.vid] = ev.t; n++; }
    }
  }
  if (n) { vidDirty = true; saveVidIndex(); }
  console.log(`[vid-index] rebuilt ${Object.keys(vidIndex).length} visitors`);
}
function saveVidIndex() {
  try { fs.writeFileSync(VID_INDEX_FILE, JSON.stringify(vidIndex)); vidDirty = false; } catch (e) {}
}
loadVidIndex();
setInterval(() => { if (vidDirty) saveVidIndex(); }, 60000).unref();

/* ================= 限流 ================= */
const rlMap = new Map();
function rateLimit(ip) {
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || now - e.t > 60000) { e = { n: 0, t: now }; rlMap.set(ip, e); }
  if (++e.n > 120) return false;
  if (rlMap.size > 50000) rlMap.clear();
  return true;
}

/* ================= 存储 ================= */
fs.mkdirSync(DATA_DIR, { recursive: true });
function dayFileName(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
}
function dayFilePath(ts) { return path.join(DATA_DIR, dayFileName(ts)); }
function appendEvent(ev) { fs.appendFile(dayFilePath(ev.t), JSON.stringify(ev) + "\n", () => {}); }
/* ================= SSE 实时推送（面板专用，仅内存连接表，零依赖） ================= */
const SSE_CLIENTS = new Set();
function broadcastSSE(ev) {
  if (!SSE_CLIENTS.size) return;
  const payload = JSON.stringify({
    t: ev.t, h: ev.h, y: ev.y, p: ev.p, vid: ev.vid, ti: ev.ti || "",
    prov: ev.prov, city: ev.city, district: ev.district, isp: ev.isp,
    dv: ev.dv, b: ev.b, o: ev.o, ip: ev.ip, nw: ev.nw || 0,
    dur: ev.dur || 0, sv: ev.sv != null ? ev.sv : null, u: ev.u || "",
  });
  for (const res of SSE_CLIENTS) {
    try { res.write("data: " + payload + "\n\n"); } catch (e) { SSE_CLIENTS.delete(res); }
  }
}
setInterval(() => {
  for (const res of SSE_CLIENTS) {
    try { res.write(":hb\n\n"); } catch (e) { SSE_CLIENTS.delete(res); }
  }
}, 20000).unref();
function readDay(file) {
  const out = [];
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) {}
    }
  } catch (e) {}
  return out;
}
function listDayFiles() {
  try {
    return fs.readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch (e) { return []; }
}
function retainOld() {
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 86400000;
    for (const f of listDayFiles()) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) fs.unlink(path.join(DATA_DIR, f), () => {});
    }
    let pruned = 0;
    for (const k of Object.keys(vidIndex)) {
      if (vidIndex[k] < cutoff) { delete vidIndex[k]; pruned++; }
    }
    if (pruned) { vidDirty = true; saveVidIndex(); console.log("[retain] pruned " + pruned + " visitor ids"); }
  } catch (e) { console.error("[retain]", e.message); }
}
retainOld();
setInterval(retainOld, 24 * 3600 * 1000).unref();

/* ================= 采集 ================= */
const ALLOWED_HOSTS = new Set(["inknook.ink", "www.inknook.ink", "hs2z.inknook.ink", "harness.inknook.ink"]);
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "";
}
const VALID_Y = new Set(["pv", "d", "sd", "out", "dl"]);

function handleCollect(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on("end", () => {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    try {
      const ip = clientIp(req);
      if (!rateLimit(ip)) return;
      const ua = req.headers["user-agent"] || "";
      if (!ua || BOT_RE.test(ua)) return;
      const pl = JSON.parse(body || "{}");
      let y = pl.y;
      if (!VALID_Y.has(y)) y = "pv";
      const host = (req.headers.host || "").replace(/:\d+$/, "");
      if (!ALLOWED_HOSTS.has(host)) return; // 丢弃伪造 Host 的上报
      const bare = host.startsWith("www.") ? host.slice(4) : "";
      const site = bare && ALLOWED_HOSTS.has(bare) ? bare : host; // www 归并为规范域名，站点统计不分家
      const g = resolveGeo(ip);
      const u = parseUA(ua);
      let isNew = false;
      if (!vidIndex[pl.v]) { vidIndex[pl.v] = Date.now(); vidDirty = true; isNew = true; }
      else if (vidIndex[pl.v] > Date.now()) vidIndex[pl.v] = Date.now();
      const ev = {
        t: Date.now(), h: site, vid: String(pl.v || "").slice(0, 32) || "anon", y,
        p: String(pl.p || "/").slice(0, 300),
        ip, prov: g.prov, city: g.city, district: g.district, isp: g.isp,
        b: u.b, o: u.o, dv: u.d,
      };
      if (y === "pv") {
        ev.ti = String(pl.t || "").slice(0, 80);
        ev.r = String(pl.r || "").slice(0, 300);
        ev.lg = String(pl.lang || "").slice(0, 12);
        ev.tz = String(pl.tz || "").slice(0, 40);
        ev.nw = isNew ? 1 : 0;
      } else if (y === "d") {
        ev.dur = Math.min(parseInt(pl.d) || 0, 3600000);
      } else if (y === "sd") {
        ev.sv = Math.min(Math.max(parseInt(pl.v2) || 0, 0), 100);
      } else if (y === "out" || y === "dl") {
        ev.u = String(pl.u || "").slice(0, 280);
      }
      appendEvent(ev);
      broadcastSSE(ev);
    } catch (e) {}
  });
}

/* ================= 来源分析 ================= */
const SEARCH_HOST_RE = /(baidu|bing|google|sogou|so\.com|360\.so|sm\.cn|yandex|duckduckgo)/i;
function classifyRef(r) {
  if (!r) return { cat: "直接访问", host: "", kw: "" };
  let host = "", q = "";
  try { const u = new URL(r); host = u.hostname; q = u.search; } catch (e) { return { cat: "外链", host: r.slice(0, 40), kw: "" }; }
  if (SEARCH_HOST_RE.test(host)) {
    let kw = "";
    if (q) {
      const m = q.match(/[?&](?:wd|q|query|keyword|kw|text)=([^&]+)/);
      if (m) { try { kw = decodeURIComponent(m[1].replace(/\+/g, " ")).slice(0, 60); } catch (e) {} }
    }
    return { cat: "搜索引擎", host, kw };
  }
  return { cat: "外链", host, kw: "" };
}

/* ================= 聚合 ================= */
function dayFilesRange(daysBack, offsetDays) {
  // offsetDays: 0=当前周期, 1=上一周期(用于环比)
  const files = [];
  const now = Date.now();
  for (let i = offsetDays * daysBack; i < offsetDays * daysBack + daysBack; i++) {
    files.push(dayFilePath(now - i * 86400000));
  }
  return files;
}
function loadEvents(files, site, f) {
  f = f || {};
  let events = [];
  for (const fpath of files) {
    const evs = readDay(fpath);
    events = events.concat(evs.filter((e) => {
      if (site !== "all" && e.h !== site) return false;
      if (f.device && e.dv !== f.device) return false;
      if (f.os && e.o !== f.os) return false;
      if (f.browser && e.b !== f.browser) return false;
      return true;
    }));
  }
  return events;
}

function topN(counter, n) {
  return Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function coreMetrics(events) {
  events.sort((a, b) => a.t - b.t);
  const pvEv = events.filter((e) => !e.y || e.y === "pv");
  // 会话划分（页面实例带独立停留槽位）
  const sessions = [];
  const byVid = new Map();
  for (const e of pvEv) {
    let s = byVid.get(e.vid);
    if (!s || e.t - s.endT > 30 * 60000) {
      s = { vid: e.vid, startT: e.t, endT: e.t, pages: [], refs: [], provs: [], dwells: [], scrolls: [] };
      sessions.push(s); byVid.set(e.vid, s);
    }
    s.endT = e.t; s.pages.push(e.p); s.refs.push(e.r || ""); s.provs.push(e.prov);
    s.dwells.push(0); s.scrolls.push(0);
    e._sess = s; e._pidx = s.pages.length - 1; // 标记本 pv 所属会话与页面实例
  }
  // 按时间序把 d(停留) 事件归属到该访客最近一次 pv 的页面实例（多次发送=多段可见时长，累加）
  const curPage = new Map(); // vid -> {sess, idx}
  const all = events.slice().sort((a, b) => a.t - b.t);
  for (const e of all) {
    if (!e.y || e.y === "pv") {
      if (e._sess) curPage.set(e.vid, { sess: e._sess, idx: e._pidx });
    } else if ((e.y === "d" && e.dur) || (e.y === "sd" && e.sv != null)) {
      const cur = curPage.get(e.vid);
      // 仅当该会话仍处活跃窗口内才归入，跨会话的孤儿事件忽略
      if (cur && cur.sess.endT >= e.t - 30 * 60000) {
        const s = cur.sess;
        const idx = e.p && s.pages[cur.idx] === e.p ? cur.idx : s.pages.lastIndexOf(e.p);
        if (idx >= 0) {
          if (e.y === "d") s.dwells[idx] += Math.min(e.dur, 1800000);
          else s.scrolls[idx] = Math.max(s.scrolls[idx], e.sv);
        }
      }
    }
  }
  let bounce = 0, totalSessDur = 0, totalDwell = 0;
  const entry = {}, exit = {};
  for (const s of sessions) {
    if (s.pages.length === 1) bounce++;
    const d = s.dwells.reduce((a, b) => a + b, 0);
    totalDwell += d;
    // 会话时长：有停留数据用可见停留之和；完全没有时长事件时退回首末事件差（封顶30分钟）
    const fallback = s.pages.length > 1 ? Math.min(s.endT - s.startT, 1800000) : 0;
    totalSessDur += d > 0 ? d : fallback;
    entry[s.pages[0]] = (entry[s.pages[0]] || 0) + 1;
    exit[s.pages[s.pages.length - 1]] = (exit[s.pages[s.pages.length - 1]] || 0) + 1;
  }
  // 基础分布
  const byDay = {}, byDayVid = {}, byPage = {}, byRefCat = {}, byKw = {}, byProv = {}, byCity = {}, byCountry = {};
  const byB = {}, byO = {}, byD = {}, byLang = {};
  const byHour = new Array(24).fill(0), byWd = new Array(7).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0)); // [星期][小时]
  let newV = 0;
  const uvs = new Set();
  for (const e of pvEv) {
    const d = new Date(e.t);
    const dkey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    byDay[dkey] = (byDay[dkey] || 0) + 1;
    (byDayVid[dkey] = byDayVid[dkey] || new Set()).add(e.vid);
    byHour[d.getHours()]++; byWd[d.getDay()]++;
    heat[d.getDay()][d.getHours()]++;
    byPage[e.p] = (byPage[e.p] || 0) + 1;
    const rc = classifyRef(e.r);
    byRefCat[rc.cat] = (byRefCat[rc.cat] || 0) + 1;
    if (rc.kw) byKw[rc.kw] = (byKw[rc.kw] || 0) + 1;
    const pv = e.prov || "未知";
    if (CN_PROV.has(pv)) byProv[pv] = (byProv[pv] || 0) + 1;
    const country = CN_PROV.has(pv) ? "中国" : (pv === "境外/未知" ? "未知" : pv);
    byCountry[country] = (byCountry[country] || 0) + 1;
    if (e.city || e.district) {
      const parts = [pv, e.city, e.district].filter(Boolean).filter((x, i, a) => i === 0 || x !== a[i - 1]);
      const ck = parts.join(" · ");
      byCity[ck] = (byCity[ck] || 0) + 1;
    }
    byB[e.b || "未知"] = (byB[e.b || "未知"] || 0) + 1;
    byO[e.o || "未知"] = (byO[e.o || "未知"] || 0) + 1;
    byD[e.dv || "未知"] = (byD[e.dv || "未知"] || 0) + 1;
    if (e.lg) byLang[e.lg] = (byLang[e.lg] || 0) + 1;
      if (e.nw) newV++;
    uvs.add(e.vid);
  }
  // 行为事件；滚动深度按页面实例统计（未滚动=0，参与平均）
  const byOut = {}, byDl = {};
  for (const e of events) {
    if (e.y === "out") byOut[e.u] = (byOut[e.u] || 0) + 1;
    else if (e.y === "dl") byDl[e.u] = (byDl[e.u] || 0) + 1;
  }
  let instN = 0, scrollSum = 0, scrollFull = 0;
  for (const s of sessions) for (const sc of s.scrolls) {
    instN++; scrollSum += sc; if (sc >= 100) scrollFull++;
  }
  const dayKeys = Object.keys(byDay).sort((a, b) => new Date(a) - new Date(b));
  const nowD = new Date();
  const todayKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}-${String(nowD.getDate()).padStart(2, "0")}`;
  return {
    total: {
      pv: pvEv.length, uv: uvs.size, sessions: sessions.length,
      bounceRate: sessions.length ? +(bounce / sessions.length * 100).toFixed(1) : 0,
      avgDur: sessions.length ? Math.round(totalSessDur / sessions.length / 1000) : 0, // 秒
      pagesPerSession: sessions.length ? +(pvEv.length / sessions.length).toFixed(1) : 0,
      newVisitors: newV,
    },
    today: { pv: byDay[todayKey] || 0 },
    daily: dayKeys.map((k) => ({ d: k, day: k.slice(5).replace("-", "/"), pv: byDay[k], uv: byDayVid[k] ? byDayVid[k].size : 0 })),
    pages: topN(byPage, 15), entry: topN(entry, 10), exit: topN(exit, 10),
    refCat: topN(byRefCat, 5), keywords: topN(byKw, 15),
    provinces: topN(byProv, 10), countries: topN(byCountry, 10), cities: topN(byCity, 10),
    browsers: topN(byB, 8), os: topN(byO, 8), devices: topN(byD, 5),
    languages: topN(byLang, 8),
    hours: byHour, weekdays: byWd, heat,
    outbound: topN(byOut, 10), downloads: topN(byDl, 10),
    scroll: { avg: instN ? Math.round(scrollSum / instN) : 0, full: scrollFull },
  };
}

function summarize(days, site, f) {
  const cur = coreMetrics(loadEvents(dayFilesRange(days, 0), site, f));
  // "全部"范围下上一周期必然为空，跳过加载
  const prev = days < RETAIN_DAYS ? coreMetrics(loadEvents(dayFilesRange(days, 1), site, f)) : { total: {} };
  return { days, site, ...cur, compare: { pv: prev.total.pv || 0, uv: prev.total.uv || 0, sessions: prev.total.sessions || 0, bounceRate: prev.total.bounceRate || 0, avgDur: prev.total.avgDur || 0 } };
}

/* ================= API: 完整记录 / 访客下钻 / 实时 / 导出 ================= */
function filterEvents(params) {
  const { site, prov, y, q, from, to } = params;
  const dev = params.device, osv = params.os, brv = params.browser;
  const files = listDayFiles().filter((f) => {
    const d = f.replace(".jsonl", "");
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }).slice(-Math.min(params.maxFiles || 90, 90));
  let rows = [];
  for (const f of files) rows = rows.concat(readDay(path.join(DATA_DIR, f)));
  return rows.filter((e) => {
    if (site !== "all" && e.h !== site) return false;
    if (prov && prov !== "all" && e.prov !== prov) return false;
    if (dev && dev !== "all" && e.dv !== dev) return false;
    if (osv && osv !== "all" && e.o !== osv) return false;
    if (brv && brv !== "all" && e.b !== brv) return false;
    if (y && y !== "all" && (e.y || "pv") !== y) return false;
    if (q) {
      const ql = q.toLowerCase();
      if (!((e.p || "").toLowerCase().includes(ql) || (e.r || "").toLowerCase().includes(ql) || (e.u || "").toLowerCase().includes(ql) || (e.vid || "").includes(ql) || (e.ip || "").toLowerCase().includes(ql))) return false;
    }
    return true;
  });
}
const TYPE_NAME = { pv: "浏览", d: "时长", sd: "滚动", out: "站外点击", dl: "下载" };
function eventRow(e) {
  return {
    id: e.t + "-" + e.vid,
    time: new Date(e.t).toLocaleString("zh-CN", { hour12: false }),
    site: e.h, type: TYPE_NAME[e.y || "pv"] || e.y, vid: e.vid,
    page: e.p, title: e.ti || "", ref: e.r || "", prov: e.prov, city: e.city, district: e.district || "",
    isp: e.isp, device: e.dv, browser: e.b, os: e.o,
    lang: e.lg || "", tz: e.tz || "",
    isNew: !!e.nw, dur: e.dur || 0, scroll: e.sv != null ? e.sv : "", link: e.u || "",
    ip: e.ip,
  };
}
function csvEscape(s) {
  s = String(s == null ? "" : s);
  if (/^[=+@]/.test(s)) s = "'" + s; // 防 Excel 公式注入
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ================= tracker v2 ================= */
const TRACKER_JS = `(function(){
var v;try{v=localStorage.getItem('_vsv');if(!v){v=Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);localStorage.setItem('_vsv',v)}}catch(e){v=''}
var lang=(navigator.language||'').slice(0,12),tz='';
try{tz=(Intl.DateTimeFormat().resolvedOptions().timeZone||'').slice(0,40)}catch(e){}
var startT=Date.now(),maxScroll=0,sent={},lastPath='';
function post(o){
  try{
    o.v=v;o.lang=lang;o.tz=tz;
    var d=JSON.stringify(o);
    if(navigator.sendBeacon){navigator.sendBeacon('/stats/collect',new Blob([d],{type:'text/plain'}))}
    else{var x=new XMLHttpRequest();x.open('POST','/stats/collect');x.send(d)}
  }catch(e){}
}
function pv(){startT=Date.now();maxScroll=0;sent={};lastPath=location.pathname+location.search;setTimeout(checkFit,800);
  post({y:'pv',p:lastPath,t:(document.title||'').slice(0,80),r:document.referrer||''})}
function dur(){
  var el=Date.now()-startT; // startT 恒为当前可见时段的起点
  if(el>1000)post({y:'d',p:lastPath,d:Math.min(el,1800000)});
  startT=Date.now();
}
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='hidden')dur();
  else startT=Date.now();
});
window.addEventListener('pagehide',function(){dur()});
window.addEventListener('scroll',function(){
  try{
    var h=document.documentElement;
    var denom=h.scrollHeight-window.innerHeight;
    var pct=denom>0?Math.round((window.pageYOffset||h.scrollTop)/denom*100):100;
    if(pct>maxScroll)maxScroll=Math.min(pct,100);
    [25,50,75,100].forEach(function(m){if(maxScroll>=m&&!sent[m]){sent[m]=1;post({y:'sd',v2:m,p:location.pathname})}});
  }catch(e){}
},{passive:true});
function checkFit(){ // 一屏即可放下的页面视为已读 100%
  try{
    var h=document.documentElement;
    if(h.scrollHeight-window.innerHeight<10){
      maxScroll=100;
      [25,50,75,100].forEach(function(m){if(!sent[m]){sent[m]=1;post({y:'sd',v2:m,p:location.pathname})}});
    }
  }catch(e){}
}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
  if(!a||!a.href)return;
  if(/^https?:/i.test(a.href)&&a.hostname!==location.hostname){post({y:'out',u:String(a.href).slice(0,280),p:location.pathname.slice(0,200)})}
  else if(/\\.(zip|rar|7z|tar|gz|pdf|docx?|xlsx?|pptx?|mp3|mp4|exe|apk|dmg)(\\?|#|$)/i.test(a.href)){post({y:'dl',u:String(a.href).slice(0,280),p:location.pathname.slice(0,200)})}
},true);
pv();
var h=history.pushState;
if(h){history.pushState=function(){dur();h.apply(this,arguments);setTimeout(pv,0)}}
window.addEventListener('popstate',function(){dur();setTimeout(pv,0)});
})();`;

/* ================= HTTP ================= */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ok = (body, type, extra) => {
    res.writeHead(200, Object.assign({ "Content-Type": type }, extra));
    res.end(body);
  };

  if (p === "/t.js" || p === "/stats/t.js") {
    return ok(TRACKER_JS, "application/javascript; charset=utf-8", { "Cache-Control": "public, max-age=1800" });
  }
  if (p === "/collect" || p === "/stats/collect") {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    return handleCollect(req, res);
  }
  if (p === "/china-map.json") {
    if (!MAP_JSON) { res.writeHead(404); return res.end(); }
    return ok(MAP_JSON, "application/json; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
  }

  if (p === "/" || p === "/index.html") {
    const html = DASHBOARD_HTML
      .replace("__MAP_PAYLOAD__", MAP_JSON ? MAP_JSON.toString() : "null")
      .replace("__CITY_PAYLOAD__", CITY_POINTS ? JSON.stringify(CITY_POINTS) : "null");
    return ok(html, "text/html; charset=utf-8");
  }

  const qtok = url.searchParams.get("token") || "";
  const auth = req.headers.authorization || (qtok ? (qtok.startsWith("Bearer ") ? qtok : "Bearer " + qtok) : "");
  const expectAuth = "Bearer " + TOKEN;
  const authOk = auth.length === expectAuth.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expectAuth));
  if (!authOk) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end('{"error":"unauthorized"}');
  }

  if (p === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 5000\n\n");
    SSE_CLIENTS.add(res);
    req.on("close", () => SSE_CLIENTS.delete(res));
    return;
  }

  if (p === "/api/summary") {
    const raw = url.searchParams.get("days") || "7";
    const days = raw === "all" ? RETAIN_DAYS : Math.min(Math.max(parseInt(raw) || 7, 1), 90);
    const site = url.searchParams.get("site") || "all";
    const f = { device: url.searchParams.get("device") || "", os: url.searchParams.get("os") || "", browser: url.searchParams.get("browser") || "" };
    return ok(JSON.stringify(summarize(days, site, f.device || f.os || f.browser ? f : null)), "application/json; charset=utf-8");
  }
  if (p === "/api/realtime") {
    const now = Date.now();
    const rows = [].concat(readDay(dayFilePath(now)), readDay(dayFilePath(now - 86400000)));
    const recent = rows.filter((e) => e.t > now - 5 * 60000);
    const vids = new Set(recent.map((e) => e.vid));
    const last = recent.slice(-12).reverse().map(eventRow);
    const vmap = new Map();
    for (const e of recent) {
      let v = vmap.get(e.vid);
      if (!v) { v = { vid: e.vid, ip: "", prov: "", city: "", district: "", isp: "", device: "", browser: "", os: "", lastT: e.t, lastPage: e.p || "", pv: 0 }; vmap.set(e.vid, v); }
      if (e.t > v.lastT) { v.lastT = e.t; if (e.p) v.lastPage = e.p; }
      if (!e.y || e.y === "pv") v.pv++;
      if (e.ip) { v.ip = e.ip; v.prov = e.prov || v.prov; v.city = e.city || v.city; v.district = e.district || v.district; v.isp = e.isp || v.isp; }
      if (e.dv) { v.device = e.dv; v.browser = e.b; v.os = e.o; }
    }
    const visitors = [...vmap.values()].sort((a, b) => b.lastT - a.lastT).map((v) => {
      const s = Math.max(Math.round((now - v.lastT) / 1000), 0);
      return { ...v, agoText: s < 60 ? s + " 秒前" : Math.round(s / 60) + " 分前" };
    });
    return ok(JSON.stringify({ online: vids.size, last5m: recent.length, last, visitors }), "application/json; charset=utf-8");
  }
  if (p === "/api/hourly") {
    const date = (url.searchParams.get("date") || "").slice(0, 10);
    const site = url.searchParams.get("site") || "all";
    const f = { device: url.searchParams.get("device") || "", os: url.searchParams.get("os") || "", browser: url.searchParams.get("browser") || "" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400); return res.end('{"error":"bad date"}'); }
    const hours = new Array(24).fill(0);
    const vids = new Set();
    for (const e of readDay(path.join(DATA_DIR, date + ".jsonl"))) {
      if (e.y && e.y !== "pv") continue;
      if (site !== "all" && e.h !== site) continue;
      if (f.device && e.dv !== f.device) continue;
      if (f.os && e.o !== f.os) continue;
      if (f.browser && e.b !== f.browser) continue;
      hours[new Date(e.t).getHours()]++;
      vids.add(e.vid);
    }
    return ok(JSON.stringify({ date, site, hours, uv: vids.size, total: hours.reduce((a, b) => a + b, 0) }), "application/json; charset=utf-8");
  }
  if (p === "/api/events") {
    const params = {
      site: url.searchParams.get("site") || "all",
      prov: url.searchParams.get("prov") || "all",
      y: url.searchParams.get("type") || "all",
      q: (url.searchParams.get("q") || "").trim().slice(0, 60),
      from: url.searchParams.get("from") || "",
      to: url.searchParams.get("to") || "",
      device: url.searchParams.get("device") || "all",
      os: url.searchParams.get("os") || "all",
      browser: url.searchParams.get("browser") || "all",
    };
    const page = Math.max(parseInt(url.searchParams.get("page")) || 1, 1);
    const size = Math.min(Math.max(parseInt(url.searchParams.get("size")) || 50, 10), 200);
    const rows = filterEvents(params).sort((a, b) => b.t - a.t);
    if (url.searchParams.get("format") === "csv") {
      const cols = ["time", "site", "type", "page", "title", "ref", "prov", "city", "district", "isp", "device", "os", "browser", "lang", "isNew", "dur", "scroll", "link", "vid", "ip"];
      const csv = [cols.join(",")]
        .concat(rows.map((e) => { const r = eventRow(e); return cols.map((c) => csvEscape(r[c])).join(","); }))
        .join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="visit-stats-${dayFileName(Date.now()).replace(".jsonl", "")}.csv"`,
      });
      return res.end("\ufeff" + csv);
    }
    return ok(JSON.stringify({ total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size).map(eventRow) }), "application/json; charset=utf-8");
  }
  if (p === "/api/visitor") {
    const vid = (url.searchParams.get("vid") || "").slice(0, 32);
    if (!vid) { res.writeHead(400); return res.end('{"error":"vid required"}'); }
    const rows = filterEvents({ site: "all", prov: "all", y: "all", q: "", maxFiles: 90 })
      .filter((e) => e.vid === vid).sort((a, b) => a.t - b.t);
    const pvs = rows.filter((e) => !e.y || e.y === "pv");
    const provs = {};
    pvs.forEach((e) => { provs[e.prov || "未知"] = (provs[e.prov || "未知"] || 0) + 1; });
    let firstSeen = vidIndex[vid] || (pvs[0] ? pvs[0].t : null);
    return ok(JSON.stringify({
      vid, firstSeen: firstSeen ? new Date(firstSeen).toLocaleString("zh-CN", { hour12: false }) : "",
      totalPv: pvs.length,
      provs: topN(provs, 5),
      timeline: rows.slice(-200).map(eventRow),
    }), "application/json; charset=utf-8");
  }
  res.writeHead(404);
  res.end("not found");
});
/* 历史数据回填：BACKFILL=1 node server.js —— 用当前解析链重算所有事件的省市/运营商 */
if (process.env.BACKFILL === "1") {
  const files = listDayFiles();
  let fixed = 0, total = 0;
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    const events = readDay(p);
    let changed = false;
    for (const e of events) {
      total++;
      if (e.h.startsWith("www.")) {
        const bare = e.h.slice(4);
        if (ALLOWED_HOSTS.has(bare) && e.h !== bare) { e.h = bare; changed = true; fixed++; }
      }
      if (!e.ip) continue;
      const g = resolveGeo(e.ip);
      if (g.prov !== e.prov || g.city !== (e.city || "") || g.district !== (e.district || "") || g.isp !== (e.isp || "")) {
        e.prov = g.prov; e.city = g.city; e.district = g.district; e.isp = g.isp;
        changed = true; fixed++;
      }
    }
    if (changed) fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  console.log(`[backfill] ${files.length} files, ${total} events, ${fixed} updated`);
  process.exit(0);
}
/* 历史日志导入：IMPORT_LOGS=1 node server.js（DRY=1 仅统计不写入）
   解析 nginx main_xff 访问日志 -> pv 事件，合并进 data/*.jsonl（与既有数据按 ip+页面±5s 去重）
   日志路径与站点映射写在 import-logs.json（不入库，格式见 import-logs.sample.json）：
   [ ["/www/wwwlogs/xxx.log", "site.example.com"], ... ] */
if (process.env.IMPORT_LOGS === "1") {
  let FILES = [];
  try { FILES = JSON.parse(fs.readFileSync(path.join(ROOT, "import-logs.json"), "utf8")); } catch (e) {}
  if (!Array.isArray(FILES) || !FILES.length) {
    console.log('[import] 缺少 import-logs.json —— 格式: [["/www/wwwlogs/xxx.log","site.example.com"],...]，参见 import-logs.sample.json');
    process.exit(0);
  }
  const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const SKIP_EXT = /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|map|xml|txt|json|rss|atom)(\?|$)/i;
  const SKIP_PATH = /^(\/\.well-known|\/admin|\/api|\/umami|\/stats)/i;
  const SKIP_EXPLOIT = /(wp-|xmlrpc|phpmyadmin|phpunit|cgi-bin|actuator|HNAP1|boaform|eval-stdin|\.env|\.git\/|\.aws|\/\.aws|\.asp$|\.aspx$|\.jsp$|\.do$|\.action$|etc\/passwd|geoip\/|wwwroot|\.bak$|\.sql$|\.zip$|\.rar$|\.7z$|_mahoupao| hacking |\.tar\.gz$|solr|jenkins|\.aws\/|vendor\/php|\/SDK\/|hikvision|dir_login|\/admin\.php)/i;
  const LINE = /^(\S+) - \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "GET (\S+) [^"]*" (\d{3}) \d+ "([^"]*)" "([^"]*)"(?: "([^"]*)")?(?: "([^"]*)")?/;
  const DRY = process.env.DRY === "1";
  const NL = String.fromCharCode(10);
  const todayName = dayFileName(Date.now());
  const geoCache = new Map();
  const known = new Set(Object.keys(vidIndex));
  const seenVid = new Set();
  const evs = [];
  let nTotal = 0, nStat = 0, nSkip = 0, nBot = 0, nToday = 0;
  for (const [file, site] of FILES) {
    let txt;
    try { txt = fs.readFileSync(file, "utf8"); } catch (e) { console.log("[import] skip", file, e.message); continue; }
    let n = 0;
    for (const line of txt.split(NL)) {
      const m = line.match(LINE);
      if (!m) continue;
      nTotal++;
      if (m[10] !== "200") { nStat++; continue; }
      const p = m[9];
      if (SKIP_EXT.test(p) || SKIP_PATH.test(p) || SKIP_EXPLOIT.test(p)) { nSkip++; continue; }
      const ua = m[12] || "";
      if (!ua || BOT_RE.test(ua)) { nBot++; continue; }
      const mon = MON[m[3]];
      if (mon === undefined) continue;
      const off = (parseInt(m[8].slice(1, 3)) * 3600 + parseInt(m[8].slice(3, 5)) * 60) * (m[8][0] === "-" ? -1 : 1) * 1000;
      const t = Date.UTC(+m[4], mon, +m[2], +m[5], +m[6], +m[7]) - off;
      if (dayFileName(t) === todayName) { nToday++; continue; } // 今日以实时采集为准
      let ip = (m[13] && m[13] !== "-") ? m[13].split(",")[0].trim() : ((m[14] && m[14] !== "-") ? m[14].trim() : m[1]);
      if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) continue;
      if (!geoCache.has(ip)) geoCache.set(ip, resolveGeo(ip));
      const g = geoCache.get(ip);
      const u = parseUA(ua);
      const vid = crypto.createHash("md5").update(ip + "|" + ua).digest("hex").slice(0, 20);
      let nw = 0;
      if (!known.has(vid) && !seenVid.has(vid)) { nw = 1; }
      seenVid.add(vid);
      evs.push({ t, h: site, vid, y: "pv", p: p.slice(0, 300), ti: "", r: (m[11] !== "-" ? m[11] : "").slice(0, 300), ip, prov: g.prov, city: g.city, district: g.district, isp: g.isp, b: u.b, o: u.o, dv: u.d, lg: "", tz: "", nw, imp: 1 });
      n++;
    }
    console.log(`[import] ${file} -> ${site}: ${n} pv`);
  }
  evs.sort((a, b) => a.t - b.t);
  console.log(`[import] total lines=${nTotal} status!=200:${nStat} static/path-skip:${nSkip} bot:${nBot} today-skipped:${nToday} kept=${evs.length} uniqVids=${seenVid.size}`);
  if (DRY) {
    const byDay = {};
    evs.forEach((e) => { byDay[dayFileName(e.t)] = (byDay[dayFileName(e.t)] || 0) + 1; });
    console.log("[import][dry] per-day:", JSON.stringify(byDay));
    const bySite = {};
    evs.forEach((e) => { bySite[e.h] = (bySite[e.h] || 0) + 1; });
    console.log("[import][dry] per-site:", JSON.stringify(bySite));
    console.log("[import][dry] sample:", evs.slice(0, 3).map((e) => `${new Date(e.t).toLocaleString("zh-CN")} ${e.h} ${e.p} ${e.prov} ${e.b}`).join(" | "));
    process.exit(0);
  }
  // 按天合并（ip+页面 与既有事件 ±5s 内视为重复）
  const byFile = {};
  evs.forEach((e) => { (byFile[dayFileName(e.t)] = byFile[dayFileName(e.t)] || []).push(e); });
  let appended = 0;
  for (const [day, list] of Object.entries(byFile)) {
    const fp = path.join(DATA_DIR, day + ".jsonl");
    const exist = readDay(fp);
    const idx = new Map(); // ip|p -> [t...]
    for (const e of exist) {
      const k = e.ip + "|" + e.p;
      (idx.get(k) || idx.set(k, []).get(k)).push(e.t);
    }
    const add = list.filter((e) => {
      const ts = idx.get(e.ip + "|" + e.p) || [];
      return !ts.some((t) => Math.abs(t - e.t) <= 5000);
    });
    if (add.length) fs.appendFileSync(fp, add.map((e) => JSON.stringify(e)).join(NL) + NL);
    appended += add.length;
  }
  console.log(`[import] appended ${appended} events into ${Object.keys(byFile).length} day files`);
  try { fs.rmSync(VID_INDEX_FILE, { force: true }); console.log("[import] vid-index cleared, will rebuild on next boot"); } catch (e) {}
  process.exit(0);
}
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => console.log(`[visit-stats] listening on ${HOST}:${PORT}`));

/* ================= 面板 ================= */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%234d8a70'/%3E%3Cpath d='M18 18h28v7H26v7h16v7H26v7h20v7H18z' fill='%23fff'/%3E%3C/svg%3E">
<title>墨隅 · 访客控制台</title>
<style>
:root{
  --paper:#0b0d0e;
  --ink:#e6e3da;
  --ink-soft:#a49f93;
  --ink-faint:#5b5851;
  --acc:#4d8a70;
  --acc-bright:#6db391;
  --acc-dim:#2f5a48;
  --warm:#c9b393;
  --line:rgba(230,227,218,.09);
  --line2:rgba(230,227,218,.16);
  --mono:"Cascadia Code","JetBrains Mono","SF Mono",Consolas,monospace;
  --serif:"Noto Serif SC","Source Han Serif SC","STSong",Georgia,serif;
  --ease:cubic-bezier(.16,1,.3,1);
  --scroll:#3a372f; --nav-bg:rgba(11,13,14,.72);
  --tip-bg:rgba(19,22,24,.92); --cmd-bg:rgba(19,22,24,.6);
  --box-bg:#111416; --login-bg:rgba(17,20,22,.75); --backdrop:rgba(6,8,9,.72);
  --hoverbg:rgba(230,227,218,.03); --hoverbg2:rgba(230,227,218,.05); --field-bg:rgba(230,227,218,.04);
  --solid-txt:#e6e3da; --sel-stroke:#9fd3bb;
  --cal0:#151a17; --cal1:#1e4636; --cal2:#2a684c; --cal3:#3f8f66; --cal4:#5fb98a;
  --maplo:24,28,32; --maphi:77,138,112;
  --flow1:#6fe0ff; --flow2:#f2a94f;
  --maxw:1480px; --space-1:6px; --space-2:10px; --space-3:16px; --space-4:24px; --space-5:36px;
  --radius-sm:8px; --radius-md:12px; --radius-lg:18px; --surface:rgba(230,227,218,.025);
  --focus:0 0 0 3px rgba(109,179,145,.24); --shadow:0 22px 70px -34px rgba(0,0,0,.72);
}
:root[data-theme="light"]{
  --paper:#f6f4ef; --ink:#29261f; --ink-soft:#5f5a4e; --ink-faint:#928c7e;
  --acc:#3d7a5d; --acc-bright:#2c6b4d; --acc-dim:#2f5e46; --warm:#b06a35;
  --line:rgba(41,38,31,.10); --line2:rgba(41,38,31,.20);
  --scroll:#d5d0c4; --nav-bg:rgba(246,244,239,.82);
  --tip-bg:rgba(255,254,250,.96); --cmd-bg:rgba(255,254,250,.82);
  --box-bg:#fffefb; --login-bg:rgba(255,254,250,.92); --backdrop:rgba(58,54,44,.42);
  --hoverbg:rgba(41,38,31,.04); --hoverbg2:rgba(41,38,31,.06); --field-bg:rgba(41,38,31,.03);
  --solid-txt:#f4f2ec; --sel-stroke:#2c6b4d;
  --cal0:#e9e6de; --cal1:#c5e2d2; --cal2:#8cc9a6; --cal3:#54a578; --cal4:#2c7a52;
  --maplo:232,230,222; --maphi:44,122,82;
  --flow1:#0a6d99; --flow2:#c2660c;
}
*{box-sizing:border-box;margin:0;padding:0}
:where(button,select,input,a,[tabindex]):focus-visible{outline:none;box-shadow:var(--focus)}
button:disabled{opacity:.45;cursor:not-allowed;transform:none!important}
html{scrollbar-color:var(--scroll) var(--paper);scroll-behavior:smooth}
body{
  background:var(--paper);color:var(--ink);
  font:13.5px/1.7 "Segoe UI Variable Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  min-height:100vh;position:relative;
  background-image:
    linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:28px 28px;background-position:-1px -1px;
}
/* 横向滚动感知裁切（只动 transform，不加宽度监听） */
section,footer{padding:64px clamp(20px,6vw,84px);position:relative;border-top:1px solid var(--line)}
section:first-of-type{border-top:0}
section>*{max-width:var(--maxw);margin-left:auto;margin-right:auto}
section>.geo,section>.trendgrid,section>.cmdbar,section>#evwrap,section>.pager{max-width:var(--maxw);width:100%}
.kpishero{width:100%}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.34em;color:var(--acc-bright);text-transform:uppercase;margin-bottom:10px}
h1.serif{font-family:var(--serif);font-weight:400;font-size:clamp(34px,4.6vw,56px);letter-spacing:.04em;line-height:1.15}
h1.serif .lit{color:var(--acc-bright);font-family:var(--mono);font-size:.34em;letter-spacing:.28em;vertical-align:middle;margin-left:16px;font-weight:600}
.sub{color:var(--ink-faint);font-size:12.5px;margin-top:10px;font-family:var(--mono);letter-spacing:.06em}
/* ============ 导航 Dock ============ */
nav{
  position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:8px;
  padding:12px clamp(20px,6vw,84px);background:rgba(11,13,14,.72);
  backdrop-filter:blur(14px);border-bottom:1px solid var(--line);background:var(--nav-bg);
  box-shadow:0 10px 34px -28px rgba(0,0,0,.7)
}
nav>*{min-width:0}
nav .brand{font-family:var(--serif);font-size:19px;letter-spacing:.1em;margin-right:8px}
nav .brand b{color:var(--acc-bright);font-weight:400}
nav .navlink{
  font-size:12.5px;color:var(--ink-soft);text-decoration:none;padding:7px 14px;border-radius:9px;
  letter-spacing:.08em;transition:background .3s var(--ease),color .3s var(--ease);position:relative;
}
nav .navlink::after{content:"";position:absolute;left:14px;right:14px;bottom:5px;height:1px;background:var(--acc-bright);transform:scaleX(0);transform-origin:left;transition:transform .35s var(--ease)}
nav .navlink:hover,nav .navlink:focus-visible{color:var(--ink);background:var(--hoverbg2)}
nav .navlink:hover::after,nav .navlink:focus-visible::after{transform:scaleX(1)}
nav .navlink.active{color:var(--ink);background:var(--hoverbg)}
nav .navlink.active::after{transform:scaleX(1)}
nav .spacer{flex:1}
.navlinks{display:flex;align-items:center;gap:2px;min-width:0}
.navctl{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;min-width:0}
.navctl select{max-width:180px}
select,input[type=date],input[type=text]{background:var(--field-bg);color:var(--ink);border:1px solid var(--line2);border-radius:9px;padding:6px 11px;font-size:12.5px;font-family:var(--mono);transition:border-color .3s}
select:focus,input:focus{outline:none;border-color:var(--acc-bright)}
button{background:transparent;color:var(--ink);border:1px solid var(--line2);border-radius:9px;padding:7px 16px;font-size:12.5px;letter-spacing:.08em;cursor:pointer;transition:border-color .3s var(--ease),transform .2s var(--ease),color .3s}
button:hover{border-color:var(--acc-bright);color:var(--acc-bright)}
button:active{transform:scale(.97)}
button.solid{background:var(--acc-dim);border-color:transparent;color:var(--solid-txt)}
button.solid:hover{background:var(--acc)}
.livechip{cursor:pointer;transition:border-color .25s var(--ease)}
.livechip:hover{border-color:var(--acc-bright)}
.livechip{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);border:1px solid var(--line2);border-radius:999px;padding:5px 14px 5px 11px}
.livechip b{color:var(--acc-bright);font-weight:600;font-size:13px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--acc-bright);position:relative}
.dot::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid var(--acc-bright);opacity:0;animation:ring 2.6s var(--ease) infinite}
@keyframes ring{0%{transform:scale(.4);opacity:.9}70%{transform:scale(1.6);opacity:0}100%{opacity:0}}
/* ============ hero ============ */
#hero{min-height:88dvh;display:flex;flex-direction:column;justify-content:center}
.kpishero{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0;border-top:1px solid var(--line2);margin-top:36px}
.kbig{padding:30px 22px 22px;border-bottom:1px solid var(--line2);border-left:1px solid var(--line2);position:relative;overflow:hidden;min-width:0}
.kbig .n{min-width:0;overflow-wrap:anywhere}
.kbig:first-child{border-left:0}
.kbig .l{font-size:11px;color:var(--ink-faint);letter-spacing:.22em;margin-bottom:14px;font-family:var(--mono)}
.kbig .n{font-family:var(--mono);font-size:clamp(30px,3.4vw,44px);font-weight:500;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums}
.kbig.hero{border:0;border-bottom:1px solid var(--line2);background:linear-gradient(180deg,transparent,rgba(77,138,112,.05))}
.kbig.hero .n{font-size:clamp(56px,8vw,104px);color:var(--acc-bright);font-weight:400}
.kbig .delta{font-family:var(--mono);font-size:11px;margin-top:10px;letter-spacing:.04em}
.up{color:var(--acc-bright)}.dn{color:var(--warm)}
/* ============ 地图区 ============ */
.geo{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:0;align-items:start}
@media(max-width:960px){.geo{grid-template-columns:1fr}}
#mapwrap{position:relative;padding:10px}
#map{width:100%;height:auto;display:block}
#map path{stroke:var(--paper);stroke-width:.55;transition:fill .35s var(--ease),stroke .25s;transform-box:fill-box;transform-origin:center}
#map path:hover{stroke:var(--acc-bright);stroke-width:1.2;cursor:pointer;transform:translateY(-2px)}
#maptip{position:absolute;pointer-events:none;display:none;z-index:5;white-space:nowrap;
  background:var(--tip-bg);backdrop-filter:blur(10px);border:1px solid var(--line2);
  box-shadow:inset 0 1px 0 rgba(230,227,218,.12),0 14px 30px -12px rgba(0,0,0,.7);
  border-radius:10px;padding:7px 12px;font-size:12px;font-family:var(--mono)}
#maptip b{color:var(--acc-bright)}
#legend{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink-faint);margin-top:8px;font-family:var(--mono)}
#legend .lg{display:flex;gap:3px}
#legend .lg i{width:22px;height:8px;border-radius:2px}
#flowlg{display:inline-flex;align-items:center;gap:4px;margin-left:14px}
#flowlg i{display:inline-block;width:16px;height:3px;border-radius:2px}
#oversea{margin-left:auto;color:var(--warm)}
.geoside{border-left:1px solid var(--line2);padding:4px 0 4px 30px}
@media(max-width:960px){.geoside{border-left:0;border-top:1px solid var(--line2);padding:24px 0 0}}
/* 列表行 */
.orow{padding:6px 0;border-bottom:1px solid var(--line);position:relative;cursor:help}
.orow:last-child{border:0}
.orow .r1{display:flex;justify-content:space-between;gap:14px;font-size:13px}
.orow .v{font-family:var(--mono);color:var(--ink-soft);font-size:12px;white-space:nowrap}
.devsec+.devsec{margin-top:16px;border-top:1px solid var(--line2);padding-top:12px}
.devhead{font-size:10px;color:var(--acc-bright);letter-spacing:.22em;font-family:var(--mono);margin-bottom:8px;opacity:.85}
.devrow{cursor:pointer;border-radius:4px;transition:background .2s var(--ease)}
.devrow:hover{background:var(--hoverbg)}
.devrow:hover .r1 span:first-child{color:var(--acc-bright)}
.devrow.on{border-left:2px solid var(--acc-bright);padding-left:8px;background:rgba(109,179,145,.07)}
.devrow.on .r1 span:first-child{color:var(--acc-bright);font-weight:600}
.meter{height:3px;background:var(--acc-dim);border-radius:2px;margin-top:5px;transform-origin:left;animation:grow .9s var(--ease);overflow:hidden;position:relative}
.meter i{position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(230,227,218,.35),transparent);transform:translateX(-100%);animation:shine 3.2s var(--ease) infinite}
@keyframes grow{from{transform:scaleX(0)}}
@keyframes shine{to{transform:translateX(100%)}}
/* ============ 图表 ============ */
.trendgrid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:0;align-items:start}
.trendside{border-left:1px solid var(--line2);padding-left:30px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 24px}
.trendgroup{min-width:0}.trendgroup .kicker{margin:0 0 6px}.trendgroup.wide{grid-column:1/-1}
@media(max-width:960px){.trendgrid{grid-template-columns:1fr}.trendside{border-left:0;border-top:1px solid var(--line2);padding-left:0;padding-top:24px;margin-top:26px}}
@media(max-width:640px){.trendside{grid-template-columns:1fr;gap:18px}.trendgroup.wide{grid-column:auto}}
.calwrap{overflow-x:auto;padding-bottom:4px}
.calmonths{position:relative;height:14px;margin-left:22px;font-family:var(--mono);font-size:9px;color:var(--ink-faint);white-space:nowrap}
.calmonths b{position:absolute;top:0;font-weight:400}
.caldays{display:grid;grid-template-rows:repeat(7,12px);gap:3px;font-family:var(--mono);font-size:9px;color:var(--ink-faint);width:18px}
.caldays span{line-height:12px}
.calgrid{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:3px}
.calgrid i{width:12px;height:12px;border-radius:2.5px;transition:transform .15s var(--ease)}
.calgrid i:hover{transform:scale(1.3);outline:1px solid var(--acc-bright)}
.cal-i{display:inline-block;width:11px;height:11px;border-radius:2.5px}
/* ============ 时间线 ============ */
.daygroup{margin-bottom:26px}
.daygroup .dhead{display:flex;align-items:baseline;gap:16px;margin-bottom:8px}
.daygroup .dhead .d{font-family:var(--serif);font-size:20px;letter-spacing:.05em}
.daygroup .dhead .n{font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
.tev{display:grid;grid-template-columns:116px 14px minmax(180px,1fr) minmax(110px,150px) minmax(120px,160px) minmax(170px,220px);gap:12px;align-items:start;padding:7px 0;border-bottom:1px solid var(--line);font-size:12.5px}
.tev:hover{background:var(--hoverbg)}
.tev.fresh{animation:freshin 1.8s var(--ease)}
@keyframes freshin{0%{background:rgba(109,179,145,.22)}70%{background:rgba(109,179,145,.08)}100%{background:transparent}}
.tev .t{font-family:var(--mono);font-size:11px;color:var(--ink-faint);overflow-wrap:anywhere;line-height:1.45}
.tev .nd{position:relative}
.tev .nd::before{content:"";position:absolute;left:6px;top:2px;width:7px;height:7px;border-radius:50%;background:var(--acc-dim)}
.tev.pv .nd::before{background:var(--acc-bright)}
.tev .nd::after{content:"";position:absolute;left:9px;top:14px;bottom:-8px;width:1px;background:var(--line)}
.tev:last-child .nd::after{display:none}
.tev .main{min-width:0}
.tev .p{font-weight:500;overflow-wrap:anywhere;word-break:break-word}
.tev .sub2{color:var(--ink-faint);font-size:11.5px;margin-top:1px;font-family:var(--mono);white-space:normal;overflow-wrap:anywhere;word-break:break-word;line-height:1.5}
.tev .cell-g,.tev .cell-d,.tev .cell-i{font-family:var(--mono);font-size:11px;color:var(--ink-soft);white-space:normal;overflow-wrap:anywhere;word-break:break-word;min-width:0;line-height:1.5;align-self:start}
.tev .cell-i{color:var(--acc-bright);cursor:pointer}
.tev .mobilemeta{display:none;font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);line-height:1.55;white-space:normal;overflow-wrap:anywhere}
.tev .mobilemeta b{color:var(--ink-soft);font-weight:400}
.click2{cursor:pointer}
.click2:hover .p{color:var(--acc-bright)}
/* 命令盘筛选条 */
.cmdbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:14px 16px;border:1px solid var(--line2);border-radius:14px;margin-bottom:22px;background:var(--cmd-bg);backdrop-filter:blur(8px);box-shadow:0 12px 32px -28px rgba(0,0,0,.7)}
.cmdbar select,.cmdbar input,.cmdbar button{min-height:36px}
.cmdbar .range-sep{color:var(--ink-faint);font-family:var(--mono);font-size:11px}
.cmdbar input[type=text]{flex:1;min-width:180px;font-family:inherit;background:transparent;border-color:transparent;border-bottom:1px solid var(--line2);border-radius:0;padding:8px 4px;font-size:13px}
.cmdbar input[type=text]:focus{border-bottom-color:var(--acc-bright)}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:18px;font-family:var(--mono);font-size:12px;color:var(--ink-faint)}
.pager button{min-width:112px}.pager span{min-width:150px;text-align:center}
.badge{display:inline-block;background:rgba(109,179,145,.14);color:var(--acc-bright);border-radius:5px;padding:0 7px;font-size:10.5px;font-family:var(--mono);letter-spacing:.08em}
/* 骨架 */
.skel{border-radius:6px;background:linear-gradient(100deg,rgba(230,227,218,.04) 40%,rgba(230,227,218,.10) 50%,rgba(230,227,218,.04) 60%);background-size:220% 100%;animation:shim 1.5s linear infinite}
@keyframes shim{to{background-position:-120% 0}}
.skel-row{height:20px;margin:10px 0}
.empty{color:var(--ink-faint);font-size:12.5px;padding:20px 0;display:flex;align-items:center;gap:10px;font-family:var(--mono)}
.error-state{color:var(--warm);font-size:12px;padding:14px 0;font-family:var(--mono);display:flex;align-items:center;gap:8px}
.error-state button{padding:4px 9px;font-size:11px}
#meta.sync-error{color:var(--warm)}
#mapwrap{min-height:220px}
/* 实时链路：用户 → EdgeOne → 源站（特异性须高于 #map path 省份描边） */
#map .flowhalo{fill:none;stroke:var(--paper);stroke-linecap:round;pointer-events:none}
#map .flowl{fill:none;stroke:var(--flow1);stroke-dasharray:9 6;stroke-linecap:round;animation:flowmove 2.4s linear infinite;pointer-events:none}
#map .flowback{fill:none;stroke:var(--flow2);stroke-dasharray:11 7;stroke-linecap:round;animation:flowmove 1.8s linear infinite;pointer-events:none}
@keyframes flowmove{to{stroke-dashoffset:-160}}
.userdot{fill:var(--flow1);stroke:var(--paper);stroke-width:1.5;cursor:help;animation:udot 2.2s ease-in-out infinite}
@keyframes udot{0%,100%{opacity:.6}50%{opacity:1}}
.edgedot{fill:var(--flow2);stroke:var(--paper);stroke-width:1.2;pointer-events:none}
.srvring{fill:none;stroke:var(--acc-bright);opacity:.55;pointer-events:none}
.srvdot{fill:var(--acc-bright);stroke:var(--paper);stroke-width:1.5;pointer-events:none}
.nodelbl{font-family:var(--mono);fill:var(--ink);paint-order:stroke;stroke:var(--paper);stroke-width:3px;pointer-events:none}
.nodelbl.dim{opacity:.5}
#linechart,#hourly{cursor:crosshair}
.ranktip{position:fixed;left:0;top:0;z-index:80;max-width:min(420px,calc(100vw - 24px));padding:9px 12px;border:1px solid var(--line2);border-radius:9px;background:var(--tip-bg);backdrop-filter:blur(12px);box-shadow:var(--shadow);color:var(--ink);font:11px/1.55 var(--mono);white-space:normal;overflow-wrap:anywhere;word-break:break-word;pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .15s var(--ease),transform .15s var(--ease)}
.ranktip.on{opacity:1;transform:none}
.ranktip b{color:var(--acc-bright);font-weight:600}
/* 弹窗 */
#livepop{position:fixed;right:clamp(16px,6vw,84px);z-index:30;width:min(430px,92vw);background:var(--tip-bg);backdrop-filter:blur(14px);border:1px solid var(--line2);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow)}
#livepop:before{content:"";display:block;width:34px;height:3px;border-radius:9px;background:var(--line2);margin:0 auto 10px;opacity:.8}
.lp-row{display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--line);cursor:pointer}
.lp-row:last-child{border:0}
.lp-row:hover .lpp{color:var(--acc-bright)}
.lp-row .lpp{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-row .lpm{font-size:11px;color:var(--ink-faint);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#toast{position:fixed;left:50%;bottom:30px;transform:translate(-50%,10px);background:var(--tip-bg);border:1px solid var(--line2);backdrop-filter:blur(10px);border-radius:10px;padding:8px 18px;font-size:12px;font-family:var(--mono);color:var(--ink);opacity:0;transition:opacity .3s var(--ease),transform .3s var(--ease);z-index:70;pointer-events:none}
#toast.on{opacity:1;transform:translate(-50%,0)}
#modal{position:fixed;inset:0;background:var(--backdrop);backdrop-filter:blur(8px);display:none;z-index:60;align-items:center;justify-content:center}
#modal.on{display:flex}
#modal .box{background:var(--box-bg);border:1px solid var(--line2);border-radius:20px;max-width:900px;width:94vw;max-height:86vh;overflow:auto;padding:24px;
  box-shadow:var(--shadow);transform:scale(.95) translateY(14px);opacity:0;transition:transform .45s var(--ease),opacity .35s}
#modal.on .box{transform:none;opacity:1}
/* 登录 */
#login{min-height:100dvh;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:left}
#login .card{width:min(420px,92vw);border:1px solid var(--line2);border-radius:20px;padding:36px;background:var(--login-bg);backdrop-filter:blur(10px);box-shadow:var(--shadow)}
#login .card:before{content:"TRAFFIC COMMAND / SECURE ACCESS";display:block;color:var(--acc-bright);font:10px var(--mono);letter-spacing:.18em;margin-bottom:18px}
#login h1{font-family:var(--serif);font-size:26px;font-weight:400;letter-spacing:.06em}
#login .sub{margin:8px 0 24px}
#login label{font-size:11px;letter-spacing:.2em;color:var(--ink-faint);font-family:var(--mono);display:block;margin:22px 0 8px}
#login input{width:100%;font-family:var(--mono);padding:11px 13px;font-size:14px}
#login button{width:100%;margin-top:14px;padding:11px;font-size:13.5px}
#lerr{color:var(--warm);font-size:12px;margin-top:12px;min-height:1em;font-family:var(--mono)}
.hidden{display:none}
/* ID 级 display:flex 会压过 .hidden 类，必须显式提升优先级 */
#login.hidden,#app.hidden{display:none}
footer{color:var(--ink-faint);font-family:var(--mono);font-size:11px;padding:26px clamp(20px,6vw,84px)}
@media(max-width:768px){
  nav{display:grid;grid-template-columns:1fr auto auto;grid-template-areas:"brand theme live" "links links links" "ctl ctl ctl";row-gap:10px;padding:10px 14px;align-items:center}
  nav .brand{grid-area:brand;font-size:17px}
  nav .spacer{display:none}
  #themeBtn{grid-area:theme}
  .livechip{grid-area:live;padding:4px 10px 4px 8px}
  .navlinks{display:flex;grid-area:links;overflow-x:auto;gap:2px;padding-bottom:2px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .navlinks::-webkit-scrollbar{display:none}
  .navlinks .navlink{flex:0 0 auto;white-space:nowrap;padding:7px 12px}
  .navctl{display:flex;grid-area:ctl;gap:6px}
  .navctl select{flex:1;min-width:0}
  select,button{min-height:36px}
}
@media(max-width:640px){
  section,footer{padding:44px 16px}
  #livepop{left:10px;right:10px;bottom:10px;top:auto!important;width:auto;max-height:min(68vh,520px);overflow:auto;border-radius:18px;padding:12px 14px calc(14px + env(safe-area-inset-bottom))}
  #modal{align-items:flex-end}
  #modal .box{width:100%;max-width:none;max-height:88vh;border-radius:20px 20px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom))}
  #modal .box:before{content:"";display:block;width:34px;height:3px;border-radius:9px;background:var(--line2);margin:-4px auto 14px}
  section,footer{overflow:hidden}
  h1.serif{font-size:30px}
  .geoside{padding-left:0}
  .tev{grid-template-columns:82px 12px minmax(0,1fr);padding:10px 0;gap:9px}
  .tev .cell-g,.tev .cell-d,.tev .cell-i{display:none}
  .tev .sub2{white-space:normal;word-break:break-word;line-height:1.5}
  .tev .mobilemeta{display:block;margin-top:4px}
  .tev .mobilemeta .cell-i{display:inline;color:var(--acc-bright);cursor:pointer}
  .pager{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
  .pager span{grid-column:1/-1;grid-row:1;min-width:0;order:-1}
  .pager button{width:100%}
  .cmdbar{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px}
  .cmdbar input[type=text]{grid-column:1/-1;min-width:0}
  .cmdbar span{display:none}
  .cmdbar input[type=date]{min-width:0}
  .cmdbar button{width:100%}
  #modal .box{padding:16px}
  .kpishero{grid-template-columns:repeat(2,minmax(0,1fr))}
  .kbig{border-top:1px solid var(--line2);padding:16px 14px 14px}
  .kbig:nth-child(2){border-top:1px solid var(--line2)}
  .kbig.hero{border-top:0}
  .kbig:nth-child(2n+1){border-left:0}
  .kbig:last-child{grid-column:1/-1;border-left:0}
  .kbig .n{font-size:22px}
  .kbig.hero .n{font-size:44px}
}
</style></head><body>

<!-- ============ 登录 ============ -->
<div id="login">
  <div class="card">
    <h1>墨隅控制台</h1>
    <label for="tk">访问令牌</label>
    <input id="tk" type="password" placeholder="Bearer token" autocomplete="off">
    <button class="solid" onclick="doLogin()">进入</button>
    <p id="lerr"></p>
  </div>
</div>

<!-- ============ 主界面 ============ -->
<div id="app" class="hidden">
<nav>
  <span class="brand">墨隅<b>·</b>控制台</span>
  <span class="navlinks">
  <a class="navlink" href="#hero" data-nav>总览</a>
  <a class="navlink" href="#geo" data-nav>地图</a>
  <a class="navlink" href="#trend" data-nav>趋势</a>
  <a class="navlink" href="#logs" data-nav>完整记录</a>
  </span>
  <span class="spacer"></span>
  <span class="navctl">
  <select id="site"><option value="all">全部站点</option></select>
  <select id="days"><option value="1">今天</option><option value="7" selected>近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="all">全部</option></select>
  <button onclick="load()">刷新</button>
  <button onclick="logout()" title="清除令牌并返回登录页">退出</button>
  </span>
  <button onclick="toggleTheme()" id="themeBtn" title="切换 暗色 / 亮色" style="padding:6px 9px;display:inline-flex;align-items:center"><svg id="themeIcon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
  <span class="livechip" onclick="toggleLivePop()" title="查看在线访客"><span class="dot"></span>在线 <b id="liveN">–</b></span>
</nav>

<section id="hero">
  <div class="kicker">Traffic Command · 流量指挥台</div>
  <h1 class="serif">访客全景<span class="lit">LIVE</span></h1>
  <p class="sub" id="meta">正在同步…</p>
  <div class="kpishero" id="cards">
    <div class="kbig hero" style="grid-column:1/-1"><div class="l">浏览量 PV</div><div class="n skel" style="width:220px;height:84px"></div></div>
    <div class="kbig"><div class="l">独立访客 UV</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">会话数</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">跳出率</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">平均时长</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">页 / 会话</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">新访客</div><div class="n skel" style="width:70px;height:34px"></div></div>
    <div class="kbig"><div class="l">滚动深度</div><div class="n skel" style="width:70px;height:34px"></div></div>
  </div>
</section>

<section id="geo">
  <div class="kicker">Geography · 地理</div>
  <h1 class="serif" style="font-size:clamp(26px,3.2vw,40px)">地图分布<span id="provname" style="color:var(--acc-bright)"></span></h1>
  <p class="sub">点击省份联动筛选 · 再点一次取消 · 悬停查看明细</p>
  <div class="geo" style="margin-top:22px">
    <div>
      <div id="mapwrap"><svg id="map"></svg><div id="maptip"></div></div>
      <div id="legend"><span>少</span><span class="lg" id="lgcolors"></span><span>多</span><span id="flowlg" style="display:none"><i style="background:var(--flow1)"></i>接入<i style="background:var(--flow2)"></i>回源</span><span id="flowinfo"></span><span id="oversea"></span></div>
    </div>
    <div class="geoside">
      <div class="kicker" style="margin-bottom:6px">省份 TOP · 中国</div>
      <div id="prov"></div>
      <div class="kicker" style="margin:26px 0 6px" id="citytitle">国家和地区</div>
      <div id="city"></div>
    </div>
  </div>
</section>

<section id="trend">
  <div class="kicker">Signals · 信号</div>
  <h1 class="serif" style="font-size:clamp(26px,3.2vw,40px)">趋势与行为</h1>
  <div class="trendgrid" style="margin-top:26px">
    <div style="min-width:0">
      <div style="margin-top:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div class="kicker" style="margin:0">每日趋势 · PV / UV 折线</div>
          <span style="font-size:10px;font-family:var(--mono);color:var(--ink-faint)"><i style="display:inline-block;width:16px;height:2px;background:var(--acc-bright);vertical-align:3px"></i> PV<i style="display:inline-block;width:16px;height:2px;background:var(--warm);vertical-align:3px;margin-left:12px"></i> UV</span>
        </div>
        <div id="linechart" style="border-bottom:1px solid var(--line2)"></div>
      </div>
      <div style="margin-top:34px">
        <div class="kicker" style="margin-bottom:8px">活跃日历 · 每日浏览</div>
        <div class="calwrap"><div class="calmonths" id="calmonths"></div><div style="display:flex;gap:5px"><div class="caldays"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div><div class="calgrid" id="heatmap"></div></div></div>
        <div style="display:flex;align-items:center;gap:4px;margin-top:8px;font-size:10px;color:var(--ink-faint);font-family:var(--mono)">少<span class="cal-i" style="background:var(--cal0)"></span><span class="cal-i" style="background:var(--cal1)"></span><span class="cal-i" style="background:var(--cal2)"></span><span class="cal-i" style="background:var(--cal3)"></span><span class="cal-i" style="background:var(--cal4)"></span>多</div>
      </div>
      <div style="margin-top:30px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <div class="kicker" style="margin:0">24 小时分布</div>
          <input type="date" id="hourlyDate" style="font-size:11px;padding:3px 8px">
          <span id="hourlySum" style="font-family:var(--mono);font-size:10px;color:var(--ink-faint)"></span>
        </div>
        <div id="hourly" style="display:flex;align-items:flex-end;gap:3px;height:90px;border-bottom:1px solid var(--line2);padding-bottom:2px"></div>
        <div id="hourlylbl" style="display:flex;gap:3px;margin-top:6px;font-family:var(--mono);font-size:9px;color:var(--ink-faint)"></div>
      </div>
    </div>
    <div class="trendside">
      <div class="trendgroup"><div class="kicker">来源分类</div><div id="refcat"></div></div>
      <div class="trendgroup"><div class="kicker">搜索关键词</div><div id="kw"></div></div>
      <div class="trendgroup"><div class="kicker">入口页 TOP</div><div id="entryp"></div></div>
      <div class="trendgroup"><div class="kicker">出口页 TOP</div><div id="exitp"></div></div>
      <div class="trendgroup wide"><div class="kicker">站外点击 / 下载</div><div id="outb"></div></div>
      <div class="trendgroup wide"><div class="kicker">设备 · 系统 · 浏览器<span id="devsel"></span></div><div id="dev"></div></div>
      <div class="trendgroup"><div class="kicker">语言</div><div id="lang"></div></div>
    </div>
  </div>
</section>
<section id="logs">
  <div class="kicker">Ledger · 记录</div>
  <h1 class="serif" style="font-size:clamp(26px,3.2vw,40px)">完整记录</h1>
  <p class="sub" style="margin-bottom:18px">点击任意条目查看该访客的完整轨迹</p>
  <div class="cmdbar">
    <select id="fsite"><option value="all">全部站点</option></select>
    <select id="ftype"><option value="all">全部类型</option><option value="pv">浏览</option><option value="d">时长</option><option value="sd">滚动</option><option value="out">站外点击</option><option value="dl">下载</option></select>
    <select id="fprov"><option value="all">全部省份</option></select>
    <input id="fq" type="text" placeholder="页面 / 来源 / IP / 访客ID…">
    <input id="ffrom" type="date"> <span style="color:var(--ink-faint)">至</span> <input id="fto" type="date">
    <button class="solid" onclick="evPage=1;loadEvents()">查询</button>
    <button onclick="exportCsv()">导出 CSV</button>
  </div>
  <div id="evwrap"><div class="skel skel-row" style="width:90%"></div><div class="skel skel-row" style="width:65%"></div><div class="skel skel-row" style="width:78%"></div></div>
  <div class="pager">
    <button onclick="evGo(-1)">‹ 上一页</button>
    <span id="pginfo"></span>
    <button onclick="evGo(1)">下一页 ›</button>
  </div>
</section>

<footer>墨隅 · 访客控制台</footer>
</div>

<div id="livepop" class="hidden">
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <span class="kicker" style="margin:0">当前在线 <b id="lpN" style="color:var(--acc-bright)">0</b> 位访客</span>
    <span style="font-size:10px;color:var(--ink-faint);font-family:var(--mono)">近 5 分钟活跃 · 点击行查看轨迹</span>
  </div>
  <div id="lpList"></div>
</div>
<div id="toast"></div>
<div id="ranktip" class="ranktip" role="status" aria-live="polite"></div>
<div id="modal" onclick="if(event.target===this)closeModal()"><div class="box">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <b style="font-size:16px;letter-spacing:.02em">访客轨迹 <span class="badge" id="mvid"></span></b>
    <button onclick="closeModal()">关闭</button>
  </div>
  <div id="mstats" class="sub" style="margin-bottom:14px"></div>
  <div id="mtimeline"></div>
</div></div>

<script>
function cssv(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
window.__MAP_DATA__=__MAP_PAYLOAD__;
window.__CITY_PTS__=__CITY_PAYLOAD__;
var TK=localStorage.getItem('vs_token')||'',evPage=1,evTotal=0,provSel=null,SITES=['inknook.ink','hs2z.inknook.ink','harness.inknook.ink'],mapData=window.__MAP_DATA__||null,provCounts={};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function formatGeo(prov,city,district){
  var parts=[prov,city,district].filter(function(x){return x&&x!=='未知'&&x!=='境外/未知'});
  var out=[];parts.forEach(function(x){if(out[out.length-1]!==x)out.push(x)});
  return out.length?out.join(' · '):(prov||'未知');
}
function logout(){closeSSE();localStorage.removeItem('vs_token');location.reload()}
var MOON='<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>';
var SUN='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
function applyTheme(){
  var t=document.documentElement.getAttribute('data-theme')||'dark';
  document.getElementById('themeIcon').innerHTML=t==='light'?MOON:SUN;
}
function toggleTheme(){
  var cur=document.documentElement.getAttribute('data-theme')||'dark';
  var next=cur==='light'?'dark':'light';
  document.documentElement.setAttribute('data-theme',next);
  localStorage.setItem('vs_theme',next);
  applyTheme();
  load();loadHourly();
}
function doLogin(){
  TK=document.getElementById('tk').value.trim();
  fetch('api/summary?days=1',{headers:{Authorization:'Bearer '+TK}}).then(r=>{
    if(r.ok){localStorage.setItem('vs_token',TK);location.reload()}else{document.getElementById('lerr').textContent='令牌不正确'}
  });
}
document.getElementById('tk').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
function countUp(el){
  var m=String(el.textContent).match(/^([\\d.,]+)(.*)$/);if(!m)return;
  var target=parseFloat(m[1].replace(/,/g,''));if(isNaN(target))return;
  var suf=m[2]||'',t0=performance.now(),dur=750;
  function step(t){
    var p=Math.min((t-t0)/dur,1),e=1-Math.pow(1-p,3);
    el.textContent=(Math.round(target*e*10)/10).toLocaleString()+suf;
    if(p<1)requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function kpi(val,label,delta,inv){
  var d='';
  if(delta!=null&&isFinite(delta)){
    var good=(delta>=0)==(!inv);
    d='<div class="delta '+(good?'up':'dn')+'">'+(delta>=0?'▲':'▼')+' '+Math.abs(delta).toFixed(1)+'% 环比</div>';
  }
  return '<div class="kbig"><div class="l">'+label+'</div><div class="n" data-cu="1">'+val+'</div>'+d+'</div>';
}
function pct(cur,prev){return prev>0?(cur-prev)/prev*100:null}
function fmtDur(s){if(s<60)return s+'秒';if(s<3600)return (s/60).toFixed(1)+'分';return (s/3600).toFixed(1)+'时'}
var EMPTY='<div class="empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/></svg>暂无数据 · 静候第一批访客</div>';
function errorState(label,retry){return '<div class="error-state"><span>'+esc(label||'加载失败')+'</span>'+(retry?'<button type="button" onclick="'+retry+'">重试</button>':'')+'</div>'}
var selA=null; // {k:'dv'|'o'|'b', v:'手机'}
function selQS(){if(!selA)return '';var p=selA.k==='dv'?'device':selA.k==='o'?'os':'browser';return '&'+p+'='+encodeURIComponent(selA.v)}
function selLabel(){return selA?((selA.k==='dv'?'设备':selA.k==='o'?'系统':'浏览器')+'：'+selA.v):''}
function tipData(name,count,kind,action){
  return 'data-tip-name="'+esc(name)+'" data-tip-count="'+esc(count)+'" data-tip-kind="'+esc(kind||'数据')+'" data-tip-action="'+esc(action||'')+'"';
}
function devRows(d){
  var el=document.getElementById('dev');
  var secs=[['dv','设备',d.devices],['o','系统',d.os],['b','浏览器',d.browsers]];
  var counts=[];secs.forEach(function(s){s[2].forEach(function(x){counts.push(x.count)})});
  if(!counts.length){el.innerHTML=EMPTY;return}
  var mx=Math.max.apply(null,counts.concat([1]));
  function mk(k,arr,label){return arr.map(function(x){
    var on=selA&&selA.k===k&&selA.v===x.name,action='点击'+(on?'取消':'')+'筛选';
    return '<div class="orow devrow'+(on?' on':'')+'" data-k="'+k+'" data-v="'+esc(x.name)+'" '+tipData(x.name,x.count,label,action)+' role="button" tabindex="0" aria-pressed="'+(on?'true':'false')+'" aria-label="'+esc(label+' '+x.name+'，'+x.count+' 次，'+action)+'" title="'+action+'"><div class="r1"><span title="'+esc(x.name)+'">'+esc(x.name)+'</span><span class="v">'+x.count+'</span></div><div class="meter" style="width:'+Math.round(x.count/mx*100)+'%"><i></i></div></div>';
  }).join('')}
  el.innerHTML=secs.map(function(s){return '<div class="devsec"><div class="devhead">'+s[1]+'</div>'+mk(s[0],s[2],s[1])+'</div>'}).join('');
  Array.prototype.forEach.call(el.querySelectorAll('.devrow'),function(r){
    function activate(){
      var k=r.getAttribute('data-k'),v=r.getAttribute('data-v');
      selA=(selA&&selA.k===k&&selA.v===v)?null:{k:k,v:v};
      document.getElementById('devsel').textContent=selA?(' · '+selLabel()+' ✕'):'';
      load();loadEvents();loadHourly();
    }
    r.onclick=activate;
    r.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();activate()}};
  });
}
function rows(el,arr,kind){
  var mx=Math.max.apply(null,arr.map(x=>x.count).concat([1]));
  kind=kind||'数据';
  el.innerHTML=arr.length?arr.map(x=>'<div class="orow" '+tipData(x.name,x.count,kind)+'><div class="r1"><span title="'+esc(x.name)+'" style="overflow-wrap:anywhere;word-break:break-word">'+esc(x.name)+'</span><span class="v">'+x.count+'</span></div><div class="meter" style="width:'+Math.round(x.count/mx*100)+'%"><i></i></div></div>').join(''):EMPTY;
}
function load(){
  var site=document.getElementById('site').value,days=document.getElementById('days').value;
  fetch('api/summary?site='+encodeURIComponent(site)+'&days='+days+selQS(),{headers:{Authorization:'Bearer '+TK}})
   .then(r=>{if(!r.ok)throw 0;return r.json()})
   .then(d=>{
     var c=d.compare;
     document.getElementById('meta').textContent=(d.days>=400?'全部数据':'近 '+d.days+' 天')+' · 站点 '+(d.site==='all'?'全部':d.site)+(d.days<400?' · 环比上一周期':'')+(selA?' · '+selLabel():'')+' · 会话判定 30 分钟';
     document.getElementById('cards').innerHTML=
       '<div class="kbig hero" style="grid-column:1/-1"><div class="l">浏览量 PV</div><div class="n" data-cu="1">'+d.total.pv+'</div>'+(c.pv?('<div class="delta '+((pct(d.total.pv,c.pv)>=0)?'up':'dn')+'">'+(pct(d.total.pv,c.pv)>=0?'▲':'▼')+' '+Math.abs(pct(d.total.pv,c.pv)).toFixed(1)+'% 环比</div>'):'')+'</div>'+
       kpi(d.total.uv,'独立访客 UV',pct(d.total.uv,c.uv))+
       kpi(d.total.sessions,'会话数',pct(d.total.sessions,c.sessions))+
       kpi(d.total.bounceRate+'%','跳出率',pct(c.bounceRate,d.total.bounceRate),1)+
       kpi(fmtDur(d.total.avgDur),'平均时长',pct(d.total.avgDur,c.avgDur))+
       kpi(d.total.pagesPerSession,'页 / 会话')+
       kpi(d.total.newVisitors,'新访客')+
       kpi(d.scroll.avg+'%','滚动深度');
     Array.prototype.forEach.call(document.querySelectorAll('#cards .n'),countUp);
     drawLine(d);
     drawCalendar(d);
     provCounts={};d.provinces.forEach(x=>provCounts[x.name]=x.count);
     window.COUNTRIES=d.countries||[];
     drawMap();
     rows(document.getElementById('prov'),d.provinces,'省份');
     if(provSel){document.getElementById('citytitle').textContent='城市 · 区县（'+provSel+'）';rows(document.getElementById('city'),d.cities.filter(x=>x.name.indexOf(provSel)===0),'城市 / 区县')}
     else{document.getElementById('citytitle').textContent='国家和地区';rows(document.getElementById('city'),window.COUNTRIES,'国家和地区')}
     rows(document.getElementById('refcat'),d.refCat,'来源分类');
     rows(document.getElementById('kw'),d.keywords,'搜索关键词');
     rows(document.getElementById('entryp'),d.entry,'入口页');
     rows(document.getElementById('exitp'),d.exit,'出口页');
     devRows(d);
     rows(document.getElementById('lang'),d.languages,'语言');
     rows(document.getElementById('outb'),d.outbound.concat(d.downloads),'站外点击 / 下载');
     loadHourly();
   })
   .catch(()=>{var m=document.getElementById('meta');m.textContent='同步失败，请点「刷新」重试';m.classList.add('sync-error')});
}
function drawCalendar(d){
  var CAL=[['#151a17','#1e4636','#2a684c','#3f8f66','#5fb98a']];
  var grid=document.getElementById('heatmap'),months=document.getElementById('calmonths');
  var CALC=[cssv('--cal0'),cssv('--cal1'),cssv('--cal2'),cssv('--cal3'),cssv('--cal4')];
  var byDate={};d.daily.forEach(function(x){byDate[x.d]=x.pv});
  var sorted=d.daily.map(function(x){return x.pv}).filter(function(v){return v>0}).sort(function(a,b){return a-b});
  var lv=[0];
  if(sorted.length){lv=[sorted[Math.floor(sorted.length*.25)],sorted[Math.floor(sorted.length*.5)],sorted[Math.floor(sorted.length*.75)],sorted[sorted.length-1]]}
  function colorOf(v){
    if(!v)return CALC[0];
    if(v<=lv[0])return CALC[1];
    if(v<=lv[1])return CALC[2];
    if(v<=lv[2])return CALC[3];
    return CALC[4];
  }
  function iso(dt){return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0')}
  var end=new Date();end.setHours(0,0,0,0);
  var first=d.daily.length?d.daily[0].d:iso(end);
  var cur=new Date(first+'T00:00:00');
  cur.setDate(cur.getDate()-cur.getDay()); // 对齐周日列首
  var cells='',mhtml='',lastM=-1,col=0;
  while(cur<=end){
    var k=iso(cur),v=byDate[k]||0;
    cells+='<i style="background:'+colorOf(v)+'" title="'+(cur.getMonth()+1)+'月'+cur.getDate()+'日 · '+v+' 次浏览"></i>';
    if(cur.getMonth()!==lastM){mhtml+='<b style="left:'+(col*15)+'px">'+(cur.getMonth()+1)+'月</b>';lastM=cur.getMonth()}
    col++;cur.setDate(cur.getDate()+1);
  }
  grid.innerHTML=cells;
  months.innerHTML=mhtml;
}
function loadHourly(){
  var inp=document.getElementById('hourlyDate');
  var d=inp.value;
  if(!d){var n=new Date();d=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');inp.value=d}
  fetch('api/hourly?date='+d+'&site='+encodeURIComponent(document.getElementById('site').value)+selQS(),{headers:{Authorization:'Bearer '+TK}})
   .then(r=>r.json()).then(x=>{
     var mx=Math.max.apply(null,x.hours.concat([1]));
     var nz=x.hours.filter(function(v){return v>0}).sort(function(a,b){return a-b});
     var lv=nz.length?[nz[Math.floor(nz.length*.25)],nz[Math.floor(nz.length*.5)],nz[Math.floor(nz.length*.75)]]:[1,1,1];
     var HC=[cssv('--cal0'),cssv('--cal1'),cssv('--cal2'),cssv('--cal3'),cssv('--cal4')];
     function col(v){if(!v)return HC[0];if(v<=lv[0])return HC[1];if(v<=lv[1])return HC[2];if(v<=lv[2])return HC[3];return HC[4]}
     var hv=document.getElementById('hourly');
     hv.innerHTML=x.hours.map(function(v,h){
       return '<div style="flex:1;min-width:0;display:flex;align-items:flex-end"><div style="width:100%;border-radius:3px 3px 1px 1px;height:'+Math.max(Math.round(v/mx*86),2)+'px;background:'+col(v)+';transition:height .5s var(--ease)"></div></div>';
     }).join('');
     hv.onpointermove=function(e){
       var r=hv.getBoundingClientRect();
       var h=Math.max(0,Math.min(23,Math.floor((e.clientX-r.left)/r.width*24)));
       showTipXY('<b>'+h+' 点</b><br>'+x.hours[h]+' 次浏览',e.clientX,e.clientY);
     };
     hv.onpointerleave=function(){hideRankTip()};
     document.getElementById('hourlylbl').innerHTML=[0,4,8,12,16,20].map(function(h){return '<span style="flex:4;text-align:center">'+h+'点</span>'}).join('')+'<span style="flex:4;text-align:right">23点</span>';
     document.getElementById('hourlySum').textContent=x.total?('当日 '+x.total+' 次浏览 · '+x.uv+' 位访客'):'当日暂无浏览';
   }).catch(function(){document.getElementById('hourly').innerHTML=errorState('24 小时数据加载失败','loadHourly()');document.getElementById('hourlylbl').innerHTML='';document.getElementById('hourlySum').textContent='';});
}
function drawLine(d){
  var box=document.getElementById('linechart');
  window.__LD=d.daily;
  if(!d.daily.length){box.innerHTML=EMPTY;return}
  var W=Math.max(box.clientWidth||600,280),H=190,P={l:36,r:10,t:12,b:20};
  var mx=1;
  d.daily.forEach(function(x){if(x.pv>mx)mx=x.pv;if(x.uv>mx)mx=x.uv});
  var step=Math.pow(10,Math.floor(Math.log(mx)/Math.LN10));
  var nice=Math.max(Math.ceil(mx/step)*step,4);
  var iw=W-P.l-P.r,ih=H-P.t-P.b,n=d.daily.length;
  function X(i){return P.l+iw*(n===1?0.5:i/(n-1))}
  function Y(v){return P.t+ih*(1-v/nice)}
  var AC=cssv('--acc-bright'),WA=cssv('--warm');
  var g='';
  for(var i=0;i<=4;i++){
    var yy=P.t+ih*i/4,vv=Math.round(nice*(1-i/4));
    g+='<line x1="'+P.l+'" y1="'+yy+'" x2="'+(W-P.r)+'" y2="'+yy+'" stroke="'+cssv('--line2')+'" stroke-width="1"/>';
    g+='<text x="'+(P.l-6)+'" y="'+(yy+3)+'" text-anchor="end" font-size="9" fill="'+cssv('--ink-faint')+'" font-family="var(--mono)">'+vv+'</text>';
  }
  var lstep=Math.max(1,Math.ceil(n/12));
  for(var i=0;i<n;i+=lstep){
    g+='<text x="'+X(i)+'" y="'+(H-5)+'" text-anchor="middle" font-size="9" fill="'+cssv('--ink-faint')+'" font-family="var(--mono)">'+d.daily[i].day+'</text>';
  }
  var pp=d.daily.map(function(x,i){return (i?'L':'M')+X(i)+','+Y(x.pv)}).join('');
  var up=d.daily.map(function(x,i){return (i?'L':'M')+X(i)+','+Y(x.uv||0)}).join('');
  var dots='';
  if(n<=45)d.daily.forEach(function(x,i){
    dots+='<circle cx="'+X(i)+'" cy="'+Y(x.pv)+'" r="2.4" fill="'+AC+'"/>';
    dots+='<circle cx="'+X(i)+'" cy="'+Y(x.uv||0)+'" r="2" fill="'+WA+'"/>';
  });
  box.innerHTML='<svg width="'+W+'" height="'+H+'" style="display:block;overflow:visible">'
   +'<defs><linearGradient id="lga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+AC+'" stop-opacity=".22"/><stop offset="1" stop-color="'+AC+'" stop-opacity="0"/></linearGradient></defs>'
   +g
   +'<path d="'+pp+' L'+X(n-1)+','+(P.t+ih)+' L'+X(0)+','+(P.t+ih)+' Z" fill="url(#lga)"/>'
   +'<path d="'+pp+'" fill="none" stroke="'+AC+'" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'
   +'<path d="'+up+'" fill="none" stroke="'+WA+'" stroke-width="1.3" opacity=".9"/>'
   +'<line class="hl" x1="'+X(0)+'" x2="'+X(0)+'" y1="'+P.t+'" y2="'+(P.t+ih)+'" stroke="'+AC+'" stroke-width="1" stroke-dasharray="3 3" opacity="0" style="transition:opacity .15s"/>'
   +dots
   +'<rect x="'+P.l+'" y="0" width="'+iw+'" height="'+H+'" fill="transparent"/>'
   +'</svg>';
  var svgEl=box.firstChild,hl=svgEl.querySelector('.hl');
  svgEl.addEventListener('pointermove',function(e){
    var rect=svgEl.getBoundingClientRect();
    var px=(e.clientX-rect.left)*(W/rect.width);
    var i=n===1?0:Math.round((px-P.l)/iw*(n-1));
    i=Math.max(0,Math.min(n-1,i));
    var dd=d.daily[i];
    hl.setAttribute('x1',X(i));hl.setAttribute('x2',X(i));hl.setAttribute('opacity','.55');
    showTipXY('<b>'+esc(dd.day)+'</b><br>PV '+dd.pv+' 次 · UV '+(dd.uv||0)+' 次',e.clientX,e.clientY);
  });
  svgEl.addEventListener('pointerleave',function(){hl.setAttribute('opacity','0');hideRankTip()});
}
/* ---- 地图 ---- */
function mapName(n){
  if(mapData.provinces[n])return n;
  var ks=Object.keys(mapData.provinces);
  for(var i=0;i<ks.length;i++){if(ks[i].indexOf(n)===0||n.indexOf(ks[i])===0)return ks[i]}
  return null;
}
function loadMap(){
  if(window.__MAP_DATA__){mapData=window.__MAP_DATA__;drawMap();return}
  var tries=0;
  function go(){
    fetch('china-map.json').then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(m){mapData=m;drawMap()})
     .catch(function(){
       if(++tries<5){setTimeout(go,1000*tries)}
       else{var t=document.getElementById('maptip');t.style.display='block';t.textContent='地图数据加载失败'}
     });
  }
  go();
}
function colorFor(v,mx){
  if(!v)return cssv('--cal0');
  var t=Math.sqrt(v/mx);
  var a=cssv('--maplo').split(',').map(Number),b=cssv('--maphi').split(',').map(Number);
  var c=a.map(function(x,i){return Math.round(x+(b[i]-x)*t)});
  return 'rgb('+c.join(',')+')';
}
function drawMap(){
  if(!mapData&&window.__MAP_DATA__)mapData=window.__MAP_DATA__;
  if(!mapData)return;
  var svg=document.getElementById('map'),tip=document.getElementById('maptip');
  svg.setAttribute('viewBox',mapData.vb.join(' '));
  var mx=0;for(var k in provCounts){if(provCounts[k]>mx)mx=provCounts[k]}
  var over=0;(window.COUNTRIES||[]).forEach(function(c){if(c.name!=='中国')over+=c.count})
  document.getElementById('oversea').textContent=over?('境外/未知 '+over):'';
  document.getElementById('lgcolors').innerHTML=[0,.25,.5,.75,1].map(t=>'<i style="background:'+colorFor(1,1/Math.pow(Math.max(t,0.001),2))+'"></i>').join('');
  var html=Object.keys(mapData.provinces).map(function(name){
    var p=mapData.provinces[name];
    var v=provCounts[name]||0;
    return '<path d="'+p.d+'" data-n="'+esc(name)+'" data-v="'+v+'" fill="'+colorFor(v,mx)+'"/>';
  }).join('');
  svg.innerHTML=html+'<g id="flowlayer"></g>';
  drawLiveFlows();
  svg.onmousemove=function(e){
    var t=e.target;
    if(t&&t.tagName&&t.tagName.toLowerCase()==='path'){
      tip.style.display='block';
      tip.innerHTML='<b>'+t.getAttribute('data-n')+'</b> '+t.getAttribute('data-v')+' 次浏览';
      var r=svg.parentNode.getBoundingClientRect();
      tip.style.left=Math.min(e.clientX-r.left+14,r.width-150)+'px';
      tip.style.top=(e.clientY-r.top-34)+'px';
    } else tip.style.display='none';
  };
  svg.onclick=function(e){
    var t=e.target;
    if(!t||!t.tagName||t.tagName.toLowerCase()!=='path')return;
    var n=t.getAttribute('data-n');
    if(!n)return; // 链路层曲线无省份属性，不参与省份筛选
    provSel=(provSel===n)?null:n;
    Array.prototype.forEach.call(svg.querySelectorAll('path'),function(x){
      var sel=provSel===x.getAttribute('data-n');
      x.style.stroke=sel?cssv('--sel-stroke'):'';
      x.style.strokeWidth=sel?1.4:'';
    });
    document.getElementById('provname').textContent=provSel?(' · '+provSel):'';
    document.getElementById('fprov').value=provSel||'all';
    load();
  };
}
/* ---- 实时链路：在线访客 → EdgeOne 边缘 → 源站(上海) ---- */
var EDGE_PROVS=["北京市","辽宁省","浙江省","湖北省","广东省","四川省","陕西省"];
var EDGE_LABEL={"北京市":"北京","辽宁省":"沈阳","浙江省":"杭州","湖北省":"武汉","广东省":"广州","四川省":"成都","陕西省":"西安"};
var EDGE_OF={"北京市":"北京市","天津市":"北京市","河北省":"北京市","山西省":"北京市","内蒙古自治区":"北京市",
"辽宁省":"辽宁省","吉林省":"辽宁省","黑龙江省":"辽宁省",
"上海市":"浙江省","江苏省":"浙江省","浙江省":"浙江省","安徽省":"浙江省","福建省":"浙江省","江西省":"浙江省","山东省":"浙江省","台湾省":"浙江省",
"河南省":"湖北省","湖北省":"湖北省","湖南省":"湖北省",
"广东省":"广东省","广西壮族自治区":"广东省","海南省":"广东省","香港特别行政区":"广东省","澳门特别行政区":"广东省",
"重庆市":"四川省","四川省":"四川省","贵州省":"四川省","云南省":"四川省","西藏自治区":"四川省",
"陕西省":"陕西省","甘肃省":"陕西省","青海省":"陕西省","宁夏回族自治区":"陕西省","新疆维吾尔自治区":"陕西省"};
/* 省份视觉中心：解析 SVG path，取最大子多边形的面积质心。
   外接矩形质心会把海南拉到南海诸岛、让狭长的内蒙古偏出主体，不能用；
   甘肃等月牙形省份的面积质心也可能落进弯曲空隙，此时用网格近似内切圆心兜底 */
function rayInPoly(pt, poly) {
  var x = pt.x, y = pt.y, inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function segDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var L = dx * dx + dy * dy;
  var t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  var ex = px - (ax + dx * t), ey = py - (ay + dy * t);
  return Math.sqrt(ex * ex + ey * ey);
}
function poleCenter(poly) {
  var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  poly.forEach(function (p) {
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
  });
  var N = 40, best = null, bd = -1;
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) {
    var x = minx + (maxx - minx) * (i + .5) / N, y = miny + (maxy - miny) * (j + .5) / N;
    if (!rayInPoly({ x: x, y: y }, poly)) continue;
    var d = 1e9;
    for (var k = 0, k2 = poly.length - 1; k < poly.length; k2 = k++) {
      var dd = segDist(x, y, poly[k2][0], poly[k2][1], poly[k][0], poly[k][1]);
      if (dd < d) d = dd;
    }
    if (d > bd) { bd = d; best = { x: x, y: y }; }
  }
  return best;
}
function pathCenter(d){
  var best=null,cx=0,cy=0,cur=null;
  function closePoly(){
    if(cur&&cur.length>2){
      var A=0,px=0,py=0;
      for(var i=0;i<cur.length;i++){
        var p=cur[i],q=cur[(i+1)%cur.length];
        var cr=p[0]*q[1]-q[0]*p[1];
        A+=cr;px+=(p[0]+q[0])*cr;py+=(p[1]+q[1])*cr;
      }
      A/=2;
      if(Math.abs(A)>1&&(best===null||Math.abs(A)>Math.abs(best.a)))best={a:A,poly:cur,x:px/(6*A),y:py/(6*A)};
    }
    cur=null;
  }
  var re=/([MmLlZz])([^MmLlZz]*)/g,m;
  while((m=re.exec(d))){
    var cmd=m[1],ns=m[2].match(/-?\\d*\\.?\\d+(?:e[-+]?\\d+)?/gi)||[];
    if(cmd==='M'){cx=+ns[0]||0;cy=+ns[1]||0;closePoly();cur=[[cx,cy]]}
    else if(cmd==='m'){cx+=+ns[0]||0;cy+=+ns[1]||0;closePoly();cur=[[cx,cy]]}
    else if(cmd==='l'||cmd==='L'){
      if(!cur)cur=[];
      for(var i=0;i+1<ns.length;i+=2){
        if(cmd==='l'){cx+=+ns[i];cy+=+ns[i+1]}
        else{cx=+ns[i];cy=+ns[i+1]}
        cur.push([cx,cy]);
      }
    }
    else if(cmd==='z'||cmd==='Z')closePoly();
  }
  closePoly();
  if(!best)return null;
  var pt={x:best.x,y:best.y};
  if(!rayInPoly(pt,best.poly)){ // 质心在月牙空隙里：退化为内切圆心
    var pole=poleCenter(best.poly);
    if(pole)return pole;
  }
  return pt;
}
function provCenter(name){
  if(!mapData||!mapData.provinces[name])return null;
  window.__PC=window.__PC||{};
  if(window.__PC[name])return window.__PC[name];
  var p=document.querySelector('#map path[data-n="'+name+'"]');
  if(!p)return null;
  var c=pathCenter(p.getAttribute('d'));
  if(c)return window.__PC[name]=c;
  var b=p.getBBox(); // 解析失败时退回外接矩形中心
  return window.__PC[name]={x:b.x+b.width/2,y:b.y+b.height/2};
}
function flowArc(x1,y1,x2,y2,bend){
  var mx=(x1+x2)/2,my=(y1+y2)/2,dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1;
  var cx=mx-dy/len*bend*len,cy=my+dx/len*bend*len;
  return "M"+x1.toFixed(1)+","+y1.toFixed(1)+" Q"+cx.toFixed(1)+","+cy.toFixed(1)+" "+x2.toFixed(1)+","+y2.toFixed(1);
}
function flowPair(d,cls,w,unit){
  return '<path class="flowhalo" d="'+d+'" stroke-width="'+((w+2.8*unit).toFixed(1))+'"/>'+
    '<path class="'+cls+'" d="'+d+'" stroke-width="'+w.toFixed(1)+'"/>';
}
function drawLiveFlows(){
  var g=document.getElementById("flowlayer");
  if(!g||!mapData)return;
  var unit=(mapData.vb[2]||1000)/1000;
  var sh=provCenter("上海市");
  if(!sh){g.innerHTML="";return}
  var CPT=window.__CITY_PTS__||null;
  var vis=window.__LIVE_VIS||[],nodes={},cnN=0,overN=0;
  vis.forEach(function(v){
    var p=v.prov||"";
    if(!(p&&mapData.provinces[p])){overN++;return}
    var pt=null,city="";
    if(CPT&&CPT[p]&&v.city&&CPT[p][v.city]){pt=CPT[p][v.city];city=v.city}
    else{var pc=provCenter(p);if(pc)pt=[pc.x,pc.y]}
    if(!pt){overN++;return}
    var k=Math.round(pt[0]*10)+","+Math.round(pt[1]*10);
    var nd=nodes[k];
    if(!nd)nd=nodes[k]={x:pt[0],y:pt[1],prov:p,city:city,n:0};
    if(city&&!nd.city)nd.city=city;
    nd.n++;cnN++;
  });
  var html="";
  EDGE_PROVS.forEach(function(ep){
    var c=provCenter(ep);if(!c)return;
    var on=Object.keys(nodes).some(function(k){return EDGE_OF[nodes[k].prov]===ep});
    html+='<circle class="edgedot" cx="'+c.x+'" cy="'+c.y+'" r="'+(3.4*unit)+'" opacity="'+(on?1:.45)+'"/>'+
      '<text class="nodelbl'+(on?'':' dim')+'" x="'+(c.x+5*unit)+'" y="'+(c.y+3*unit)+'" font-size="'+(10.5*unit)+'">EdgeOne·'+EDGE_LABEL[ep]+'</text>';
  });
  html+='<circle class="srvring" cx="'+sh.x+'" cy="'+sh.y+'" r="'+(7.5*unit)+'" stroke-width="'+(1.2*unit)+'"/>'+
    '<circle class="srvdot" cx="'+sh.x+'" cy="'+sh.y+'" r="'+(4*unit)+'"/>'+
    '<text class="nodelbl" x="'+(sh.x+9*unit)+'" y="'+(sh.y-4*unit)+'" font-size="'+(11.5*unit)+'">源站·上海</text>';
  var drawnBack={};
  Object.keys(nodes).forEach(function(k){
    var nd=nodes[k],ux=nd.x,uy=nd.y;
    var ep=EDGE_OF[nd.prov],ec=ep?provCenter(ep):null;
    if(ec){
      var len=Math.sqrt((ec.x-ux)*(ec.x-ux)+(ec.y-uy)*(ec.y-uy));
      if(len>6*unit)html+=flowPair(flowArc(ux,uy,ec.x,ec.y,.18),'flowl',2.5*unit,unit);
      else{ // 用户与边缘节点同城/同省：错开用户点并画短接入弧
        ux=ec.x+11*unit;uy=ec.y-9*unit;
        html+=flowPair(flowArc(ux,uy,ec.x,ec.y,.35),'flowl',2.5*unit,unit);
      }
      if(!drawnBack[ep]){drawnBack[ep]=1;html+=flowPair(flowArc(ec.x,ec.y,sh.x,sh.y,-.15),'flowback',3*unit,unit);}
    }
    var label=nd.prov+(nd.city?(' · '+nd.city):'');
    html+='<circle class="userdot" cx="'+ux+'" cy="'+uy+'" r="'+(3.6*unit)+'" tabindex="0" data-tip-name="'+esc(label+" · "+nd.n+" 位在线")+'" data-tip-count="'+nd.n+'" data-tip-kind="实时访问 · 经 EdgeOne 回源上海"/>';
    if(nd.n>1)html+='<text class="nodelbl" x="'+(ux+4.5*unit)+'" y="'+(uy-4.5*unit)+'" font-size="'+(10*unit)+'" fill="var(--flow1)">'+nd.n+'</text>';
  });
  g.innerHTML=html;
  var fi=document.getElementById("flowinfo"),fl=document.getElementById("flowlg");
  if(fi)fi.textContent=cnN?("实时链路 "+Object.keys(nodes).length+" 地 · "+cnN+" 位"+(overN?" · 境外 "+overN+" 位未绘制":"")):(overN?"实时链路 · 境外 "+overN+" 位未绘制":"实时链路 · 空闲");
  if(fl)fl.style.display=cnN?"inline-flex":"none";
}
/* ---- 完整记录（时间线） ---- */
function dayLabel(t){
  var d=new Date(t);
  return (d.getMonth()+1)+' 月 '+d.getDate()+' 日';
}
function timeLabel(t){
  var d=new Date(t);
  return ('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
}
function eventRowHTML(e){
  var detail=e.dur?('停留 '+Math.round(e.dur/1000)+'s'):(e.scroll!==''?('滚动 '+e.scroll+'%'):(e.link||''));
  var src=e.ref||e.link||'';
  return '<div class="tev '+(e.type==='浏览'?'pv':'')+' click2" data-vid="'+esc(e.vid)+'">'+
    '<span class="t">'+timeLabel(e.time)+'</span><span class="nd"></span>'+
    '<span class="main"><span class="p">'+esc(e.page)+'</span>'+
    '<span class="sub2">'+esc(e.type)+' · '+esc(e.site.replace('.inknook.ink',''))+(src?(' · ← '+esc(src)):'')+(detail?(' · '+esc(detail)):'')+(e.isNew?' <span class="badge">新访客</span>':'')+'</span></span>'+
    '<span class="cell-g" title="'+esc(formatGeo(e.prov,e.city,e.district))+'">'+esc(formatGeo(e.prov,e.city,e.district))+'</span>'+
    '<span class="cell-d" title="'+esc(e.device+' · '+e.browser)+'">'+esc(e.device+' · '+e.browser)+'</span>'+
    '<span class="cell-i" data-ip="'+esc(e.ip||'')+'" title="IP '+esc(e.ip)+(e.isp?(' · '+esc(e.isp)):'')+' · 点击复制">'+esc(e.ip||'–')+(e.isp?(' · '+esc(e.isp)):'')+'</span>'+
    '<span class="mobilemeta"><b>'+esc(formatGeo(e.prov,e.city,e.district))+'</b> · '+esc(e.device+' · '+e.browser)+' · <span class="cell-i" data-ip="'+esc(e.ip||'')+'">'+esc(e.ip||'–')+(e.isp?(' · '+esc(e.isp)):'')+'</span></span>'+
    '</div>';
}
function bindEventRow(tr){
  tr.onclick=function(ev){if(ev.target&&ev.target.closest&&ev.target.closest('.cell-i'))return;openVisitor(tr.getAttribute('data-vid'))};
}
function loadEvents(){
  var qs='api/events?site='+encodeURIComponent(document.getElementById('fsite').value)+
    '&type='+document.getElementById('ftype').value+
    '&prov='+encodeURIComponent(document.getElementById('fprov').value)+
    '&page='+evPage+'&size=50'+selQS()
    +(document.getElementById('fq').value?'&q='+encodeURIComponent(document.getElementById('fq').value):'')+
    (document.getElementById('ffrom').value?'&from='+document.getElementById('ffrom').value:'')+
    (document.getElementById('fto').value?'&to='+document.getElementById('fto').value:'');
  fetch(qs,{headers:{Authorization:'Bearer '+TK}}).then(r=>r.json()).then(d=>{
    evTotal=d.total;
    document.getElementById('pginfo').textContent='第 '+d.page+' / '+Math.max(Math.ceil(d.total/d.size),1)+' 页 · 共 '+d.total+' 条';
    var wrap=document.getElementById('evwrap');
    if(!d.rows.length){wrap.innerHTML=EMPTY;return}
    wrap.innerHTML=d.rows.map(eventRowHTML).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.click2'),bindEventRow);
  }).catch(function(){document.getElementById('evwrap').innerHTML=errorState('完整记录加载失败','loadEvents()');document.getElementById('pginfo').textContent='暂时无法读取';});
}
function evGo(d){
  var maxP=Math.max(Math.ceil(evTotal/50),1);
  evPage=Math.min(Math.max(evPage+d,1),maxP);
  loadEvents();
}
/* ---- SSE 实时更新：节流刷新 + 完整记录顶部插入 ---- */
var SSE=null,__lastLivePull=0,__lastLoadPull=0,__liveTimer=null,__loadTimer=null;
var SSE_TYPE={pv:'浏览',d:'时长',sd:'滚动',out:'站外点击',dl:'下载'};
function eventsFilterActive(){
  return evPage!==1||document.getElementById('fsite').value!=='all'||document.getElementById('ftype').value!=='all'||
    document.getElementById('fprov').value!=='all'||document.getElementById('fq').value||
    document.getElementById('ffrom').value||document.getElementById('fto').value||selA||provSel;
}
function prependEvent(ev){
  var wrap=document.getElementById('evwrap');
  if(!wrap.querySelector('.tev'))return; // 骨架/空态/错误态时交给节流轮询校正
  var row={time:ev.t,type:SSE_TYPE[ev.y]||'浏览',site:ev.h,page:ev.p,ref:'',prov:ev.prov,city:ev.city,district:ev.district,
    isp:ev.isp,device:ev.dv,browser:ev.b,os:ev.o,isNew:!!ev.nw,dur:ev.dur||0,
    scroll:ev.sv!=null?ev.sv:'',link:ev.u||'',ip:ev.ip,vid:ev.vid};
  wrap.insertAdjacentHTML('afterbegin',eventRowHTML(row));
  var el=wrap.firstElementChild;
  el.classList.add('fresh');
  bindEventRow(el.querySelector('.click2')||el);
  evTotal++;
  document.getElementById('pginfo').textContent='第 '+evPage+' / '+Math.max(Math.ceil(evTotal/50),1)+' 页 · 共 '+evTotal+' 条';
}
/* 尾沿合并节流：窗口内的后续消息不丢弃，保证脉冲结束后拉到最终状态 */
function throttled(fn,delay,lastKey,timerKey){
  if(window[timerKey]!=null)return;
  var wait=Math.max(0,delay-(Date.now()-window[lastKey]));
  window[timerKey]=setTimeout(function(){
    window[timerKey]=null;window[lastKey]=Date.now();fn();
  },wait);
}
function initSSE(){
  try{
    SSE=new EventSource('api/stream?token='+encodeURIComponent(TK));
    SSE.onmessage=function(e){
      var ev;try{ev=JSON.parse(e.data)}catch(x){return}
      throttled(loadLive,3000,'__lastLivePull','__liveTimer');
      throttled(load,15000,'__lastLoadPull','__loadTimer');
      if(!eventsFilterActive())prependEvent(ev);
    };
  }catch(e){SSE=null}
}
function closeSSE(){if(SSE){try{SSE.close()}catch(e){}SSE=null}}
function exportCsv(){
  var qs='api/events?format=csv&site='+encodeURIComponent(document.getElementById('fsite').value)+
    '&type='+document.getElementById('ftype').value+
    '&prov='+encodeURIComponent(document.getElementById('fprov').value)+selQS()+
    +(document.getElementById('fq').value?'&q='+encodeURIComponent(document.getElementById('fq').value):'')+
    (document.getElementById('ffrom').value?'&from='+document.getElementById('ffrom').value:'')+
    (document.getElementById('fto').value?'&to='+document.getElementById('fto').value:'');
  fetch(qs,{headers:{Authorization:'Bearer '+TK}}).then(r=>r.text()).then(t=>{
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([t],{type:'text/csv'}));
    a.download='visit-stats.csv';a.click();
  });
}
/* ---- 访客下钻 ---- */
function openVisitor(vid){
  fetch('api/visitor?vid='+encodeURIComponent(vid),{headers:{Authorization:'Bearer '+TK}})
   .then(r=>r.json()).then(d=>{
     document.getElementById('mvid').textContent=d.vid;
     document.getElementById('mstats').textContent='首次访问 '+d.firstSeen+' · 累计浏览 '+d.totalPv+' 次 · 常用地：'+((d.provs||[]).map(x=>x.name+'('+x.count+')').join('、')||'–');
     document.getElementById('mtimeline').innerHTML=d.timeline.slice().reverse().map(function(e){
       var detail=e.dur?('停留 '+Math.round(e.dur/1000)+'s'):(e.scroll!==''?('滚动 '+e.scroll+'%'):(e.link||''));
       return '<div class="tev '+(e.type==='浏览'?'pv':'')+'"><span class="t">'+timeLabel(e.time)+'</span><span class="nd"></span>'+
        '<span class="main"><span class="p">'+esc(e.page)+'</span><span class="sub2">'+esc(e.type)+' · '+esc(e.site.replace('.inknook.ink',''))+(e.ref?(' · ← '+esc(e.ref)):'')+(detail?(' · '+esc(detail)):'')+'</span></span>'+
        '<span class="cell-g">'+esc(formatGeo(e.prov,e.city,e.district))+'</span>'+
        '<span class="cell-d">'+esc(e.device+' · '+e.browser)+'</span>'+
        '<span class="cell-i" data-ip="'+esc(e.ip||'')+'" title="点击复制 IP">'+esc(e.ip||'–')+(e.isp?(' · '+esc(e.isp)):'')+'</span></div>';
     }).join('');
     var m=document.getElementById('modal');m.classList.add('on');
   }).catch(function(){document.getElementById('mtimeline').innerHTML=errorState('访客轨迹加载失败','closeModal()')});
}
function closeModal(){document.getElementById('modal').classList.remove('on')}
function toast(s){var t=document.getElementById('toast');if(!t)return;t.textContent=s;t.classList.add('on');clearTimeout(window.__tt);window.__tt=setTimeout(function(){t.classList.remove('on')},1500)}
function showTipXY(html,x,y){
  var tip=document.getElementById('ranktip');if(!tip)return;
  tip.innerHTML=html;tip.classList.add('on');
  var r=tip.getBoundingClientRect(),pad=12,left=Math.min(Math.max(x+14,pad),Math.max(pad,innerWidth-r.width-pad)),top=y+14;
  if(top+r.height>innerHeight-pad)top=Math.max(pad,y-r.height-14);
  tip.style.left=left+'px';tip.style.top=top+'px';
}
function showRankTip(row,x,y){
  var tip=document.getElementById('ranktip');if(!tip||!row)return;
  var n=row.getAttribute('data-tip-name')||'',c=row.getAttribute('data-tip-count')||'0',k=row.getAttribute('data-tip-kind')||'数据',a=row.getAttribute('data-tip-action')||'';
  showTipXY('<b>'+esc(n)+'</b><br>'+esc(k)+' · '+esc(c)+' 次'+(a?('<br>'+esc(a)):''),x,y);
}
function hideRankTip(){var tip=document.getElementById('ranktip');if(tip)tip.classList.remove('on')}
document.addEventListener('pointerover',function(e){var row=e.target&&e.target.closest?e.target.closest('[data-tip-name]'):null;if(row)showRankTip(row,e.clientX,e.clientY)});
document.addEventListener('pointermove',function(e){var row=e.target&&e.target.closest?e.target.closest('[data-tip-name]'):null;if(row)showRankTip(row,e.clientX,e.clientY)});
document.addEventListener('pointerout',function(e){var row=e.target&&e.target.closest?e.target.closest('[data-tip-name]'):null;var next=e.relatedTarget&&e.relatedTarget.closest?e.relatedTarget.closest('[data-tip-name]'):null;if(row&&!next)hideRankTip()});
document.addEventListener('focusin',function(e){var row=e.target&&e.target.closest?e.target.closest('[data-tip-name]'):null;if(row){var r=row.getBoundingClientRect();showRankTip(row,r.left,r.bottom)}});
document.addEventListener('focusout',function(e){if(e.target&&e.target.closest&&e.target.closest('[data-tip-name]'))hideRankTip()});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeModal();var p=document.getElementById('livepop');if(p)p.classList.add('hidden')}
});
document.addEventListener('click',function(e){
  var c=e.target&&e.target.closest?e.target.closest('.cell-i'):null;
  if(c&&c.getAttribute('data-ip')){
    var ip=c.getAttribute('data-ip');
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(ip).then(function(){toast('已复制 '+ip)},function(){toast(ip)})}
    else toast(ip);
  }
});
function toggleLivePop(force){
  var p=document.getElementById('livepop');
  var show=force!=null?force:p.classList.contains('hidden');
  if(show){var nb=document.querySelector('nav').getBoundingClientRect().bottom;p.style.top=(nb+10)+'px';p.classList.remove('hidden')}else p.classList.add('hidden');
}
document.addEventListener('click',function(e){
  var p=document.getElementById('livepop');
  if(p&&!p.classList.contains('hidden')&&!p.contains(e.target)&&!(e.target.closest&&e.target.closest('.livechip')))p.classList.add('hidden');
});
function loadLive(){
  fetch('api/realtime',{headers:{Authorization:'Bearer '+TK}}).then(r=>r.json()).then(d=>{
    document.getElementById('liveN').textContent=d.online;
    document.getElementById('lpN').textContent=d.online;
    window.__LIVE_VIS=d.visitors||[];
    drawLiveFlows();
    document.getElementById('lpList').innerHTML=(d.visitors&&d.visitors.length)?d.visitors.map(function(v){
      return '<div class="lp-row" data-vid="'+esc(v.vid)+'">'+
        '<div style="flex:1;min-width:0"><div class="lpp">'+esc(v.lastPage||'/')+'</div>'+
        '<div class="lpm">'+esc(formatGeo(v.prov,v.city,v.district)||'–')+(v.isp?(' · '+esc(v.isp)):'')+' · '+esc(v.device+' · '+v.browser)+' · '+esc(v.ip)+'</div></div>'+
        '<div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);white-space:nowrap">'+esc(v.agoText)+'</div></div>';
    }).join(''):'<div class="empty" style="padding:10px 0">暂无在线访客</div>';
    Array.prototype.forEach.call(document.querySelectorAll('#lpList .lp-row'),function(r){
      r.onclick=function(){toggleLivePop(false);openVisitor(r.getAttribute('data-vid'))};
    });
  }).catch(function(){document.getElementById('liveN').textContent='–';document.getElementById('lpN').textContent='–';document.getElementById('lpList').innerHTML=errorState('在线数据暂不可用','loadLive()');});
}
/* 导航平滑滚动 */
Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'),function(a){
  a.onclick=function(e){e.preventDefault();var t=document.querySelector(a.getAttribute('href'));if(t)t.scrollIntoView({behavior:'smooth'})};
});
if('IntersectionObserver' in window){
  var navObs=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'),function(a){a.classList.toggle('active',a.getAttribute('href')==='#'+entry.target.id)})}})},{rootMargin:'-18% 0px -68% 0px',threshold:0});
  Array.prototype.forEach.call(document.querySelectorAll('section[id]'),function(s){navObs.observe(s)});
}
function init(){
  var s1=document.getElementById('site'),s2=document.getElementById('fsite');
  SITES.forEach(function(h){var o1=document.createElement('option');o1.value=h;o1.textContent=h;s1.appendChild(o1);
    var o2=document.createElement('option');o2.value=h;o2.textContent=h;s2.appendChild(o2);});
  fetch('api/summary?days=7',{headers:{Authorization:'Bearer '+TK}}).then(r=>r.json()).then(function(d){
    var fp=document.getElementById('fprov');
    d.provinces.forEach(function(x){if(x.name!=='境外/未知'){var o=document.createElement('option');o.value=x.name;o.textContent=x.name;fp.appendChild(o)}});
  });
  document.getElementById('hourlyDate').addEventListener('change',loadHourly);
  (function(){var n=new Date();document.getElementById('hourlyDate').max=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0')})();
  window.addEventListener('resize',function(){if(window.__LD)drawLine({daily:window.__LD})});
  load();loadEvents();loadMap();loadLive();loadHourly();
  initSSE();
  setInterval(loadLive,120000);setInterval(load,300000); // SSE 推送为主，轮询仅兜底
}
(function(){var t=localStorage.getItem('vs_theme');if(!t){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
if(TK){
  applyTheme();
  fetch('api/summary?days=1',{headers:{Authorization:'Bearer '+TK}}).then(r=>{
    if(r.ok){
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      init();
    } else localStorage.removeItem('vs_token');
  });
}
</script></body></html>
`;
