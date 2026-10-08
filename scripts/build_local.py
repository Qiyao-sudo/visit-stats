#!/usr/bin/env python3
# 合成 Umami 专用地理库：GeoCN(中国区划,精确到区) + GeoLite2-City(全球) → GeoLite2 结构
# 城市名写入 names.en(Umami 只读该键,填中文名面板即显示中文),补全省份 ISO 码。
# 本地构建版本：在开发机运行，产物再上传服务器，避免在生产机上占用内存。
import os, time, ipaddress
import maxminddb
from mmdb_writer import MMDBWriter

SOURCE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "source")
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")
os.makedirs(DIST_DIR, exist_ok=True)
OUT = os.path.join(DIST_DIR, "GeoLite2-City-CN.mmdb")

PROV_ISO = {11:"BJ",12:"TJ",13:"HE",14:"SX",15:"NM",21:"LN",22:"JL",23:"HL",31:"SH",32:"JS",
            33:"ZJ",34:"AH",35:"FJ",36:"JX",37:"SD",41:"HA",42:"HB",43:"HN",44:"GD",45:"GX",
            46:"HI",50:"CQ",51:"SC",52:"GZ",53:"YN",54:"XZ",61:"SN",62:"GS",63:"QH",64:"NX",
            65:"XJ",71:"TW",81:"HK",82:"MO"}

names = {}
for line in open(os.path.join(SOURCE_DIR, "geocn-full.txt"), encoding="utf-8"):
    p = line.rstrip("\n").split("\t")
    if len(p) == 2 and p[0].isdigit():
        names[int(p[0])] = p[1]

rec_cache = {}
def cn_record(division_code, isp):
    key = (division_code, isp)
    if key in rec_cache: return rec_cache[key]
    code = int(division_code)
    prov = code // 10000
    prov_name = names.get(prov * 10000, "中国")
    iso = "CN-" + PROV_ISO.get(prov, "CH")
    city = names.get(code) or names.get((code // 100) * 100) or prov_name
    rec = {
        "country": {"iso_code": "CN", "geoname_id": 1814991,
                    "names": {"en": "China", "zh-CN": "中国"}},
        "subdivisions": [{"iso_code": iso, "names": {"en": prov_name, "zh-CN": prov_name}}],
        "city": {"names": {"en": city, "zh-CN": city}},
        "isp": isp or "",
    }
    rec_cache[key] = rec
    return rec

def net_interval(net):
    return int(net.network_address), int(net.broadcast_address), net.version

# ---- 1. GeoCN ranges (override) ----
t0 = time.time()
cn_nets = []  # (start, end, version, record)
r = maxminddb.open_database(os.path.join(SOURCE_DIR, "GeoCN.mmdb"))
for net, rec in r:
    s, e, v = net_interval(net)
    cn_nets.append((s, e, v, cn_record(rec.get("division_code"), rec.get("isp"))))
r.close()
cn_v4 = sorted([(s, e) for s, e, v, _ in cn_nets if v == 4])
cn_v6 = sorted([(s, e) for s, e, v, _ in cn_nets if v == 6])
print(f"GeoCN ranges: {len(cn_nets)} ({time.time()-t0:.1f}s), distinct records: {len(rec_cache)}", flush=True)

# ---- 2. base GeoLite2 ranges, skip CN, subtract GeoCN overlays ----
t0 = time.time()
def subtract(ov, s, e):
    for os_, oe in ov:
        if os_ > e: break
        if oe < s: continue
        if os_ <= s:
            s = oe + 1
        else:
            if os_ - 1 >= s: yield (s, os_ - 1)
            s = oe + 1
    if s <= e: yield (s, e)

base_nets = []
skipped_cn = 0
r = maxminddb.open_database(os.path.join(SOURCE_DIR, "base-City.mmdb"))
for net, rec in r:
    if (rec.get("country") or {}).get("iso_code") == "CN":
        skipped_cn += 1
        continue
    s, e, v = net_interval(net)
    ov = cn_v4 if v == 4 else cn_v6
    for ps, pe in subtract(ov, s, e):
        base_nets.append((ps, pe, v, rec))
r.close()
print(f"base kept ranges: {len(base_nets)} (skipped CN {skipped_cn}) ({time.time()-t0:.1f}s)", flush=True)

# ---- 3. write ----
t0 = time.time()
w = MMDBWriter(ip_version=6, database_type="GeoLite2-City", languages=["en", "zh-CN"],
               description={"en": "GeoCN(China divisions) + GeoLite2-City(world), for Umami"})
ins = w.insert_network
def add_range(s, e, v, rec):
    if v == 4:
        a, b = ipaddress.IPv4Address(s), ipaddress.IPv4Address(e)
    else:
        a, b = ipaddress.IPv6Address(s), ipaddress.IPv6Address(e)
    for n in ipaddress.summarize_address_range(a, b):
        ins(n, rec)

done = 0
for s, e, v, rec in base_nets:
    add_range(s, e, v, rec)
    done += 1
    if done % 500000 == 0: print(f"  base inserted {done} ({time.time()-t0:.1f}s)", flush=True)
print(f"base insert done ({time.time()-t0:.1f}s)", flush=True)
t0 = time.time()
for s, e, v, rec in cn_nets:
    add_range(s, e, v, rec)
print(f"cn insert done ({time.time()-t0:.1f}s), writing file...", flush=True)
t0 = time.time()
w.to_db_file(OUT)
print(f"written {OUT} {os.path.getsize(OUT)/1048576:.1f}MB ({time.time()-t0:.1f}s)", flush=True)
