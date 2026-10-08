# visit-stats · 墨隅自建访客统计

零依赖纯 Node 的轻量访客统计系统：采集脚本 + 采集服务 + JSONL 存储 + 单文件控制台。
无 Docker、无数据库、无第三方 npm 依赖，生产仅一个 `server.js` 进程（PM2 托管）。

## 架构

```
访客浏览器
   │  /stats/t.js（tracker：PV/停留/滚动/外链/下载）
   ▼
EdgeOne CDN ──► 源站 nginx（inknook.ink / www / hs2z / harness 同源反代 /stats/）
                   │   proxy_pass http://127.0.0.1:3100/（Host 原样传递）
                   ▼
            server.js（仅监听 127.0.0.1:3100）
                   │  JSONL 按天落盘 + vid 索引 + GeoCN 离线库解析
                   ▼
   data/YYYY-MM-DD.jsonl · data/vid-index.json
                   ▲
面板浏览器 ──► https://stats.inknook.ink（EdgeOne CNAME，nginx 反代同端口）
                Bearer Token 认证 · SSE 实时推送 · 轮询兜底
```

## 目录结构

```
visit-stats/
├── server.js              # 全部服务端逻辑 + 内嵌控制台（单文件，生产同款）
├── .token                 # 本地开发令牌（生产在 /opt/visit-stats/.token，两者不同）
├── data/                  # 运行数据：按天 JSONL + 访客索引（本地为开发数据）
├── geo/                   # 运行时资产（服务端启动加载）
│   ├── geocn-compact.json     # GeoCN 中国省市区+ISP 紧凑库（v4+v6）
│   ├── country-compact.json   # GeoLite2 境外国家库
│   ├── china-map.json         # 中国省级 SVG path（内联进面板）
│   └── city-points.json       # 地级市中心点（地图坐标，形状配准生成）
├── scripts/
│   ├── build_city_points.mjs  # 城市坐标表构建（DataV + 逐省形状配准）
│   ├── build_geo_db.py        # [归档] Umami 时代 MMDB 合成，已不再使用
│   ├── build_local.py         # [归档] 同上（本地构建版）
│   └── deploy.sh              # 一键部署到生产
├── source/                # 构建脚本的原材料（大文件，勿部署到生产）
│   ├── GeoCN.mmdb             # GeoCN 原始库
│   ├── base-City.mmdb         # GeoLite2-City 原始库
│   └── geocn-full.txt         # 中国行政区划码表（码→名）
└── dist/                  # （构建输出，py 脚本产物）
```

## 本地运行

```bash
cd visit-stats
node server.js            # 监听 127.0.0.1:3100
# 令牌见 .token；打开 http://127.0.0.1:3100 输入令牌登录
```

- 端口/主机：环境变量 `PORT`（默认 3100）、`HOST`（默认 127.0.0.1，生产切勿改 0.0.0.0）
- `BACKFILL=1 node server.js`：用当前解析链重算历史事件的省/市/区/ISP，并归并 www 主域，跑完自动退出
- 保留策略：JSONL 保留 400 天，过期自动清理；vid 索引同步修剪

## 构建脚本

```bash
# 城市坐标表（需联网访问 geo.datav.aliyun.com；产物覆盖 geo/city-points.json）
node scripts/build_city_points.mjs
```

原理：DataV 城市中心点(经纬度) → 逐省形状配准（烘焙 SVG 路径最大子多边形 与 DataV 省界最大环
PCA 主轴对齐，栅格 IoU 择优）→ 输出地图坐标系下的市中心点。
注意：server.js 的面板 HTML 是模板字符串，内嵌正则里的 `\d` 必须写成 `\\d`。

## 部署（目标：任意 Linux + nginx + PM2）

```bash
DEST=user@your-server PORT=22 scripts/deploy.sh              # 仅部署 server.js
DEST=user@your-server PORT=22 scripts/deploy.sh geo          # 同时推送 geo/*.json
DEST=user@your-server PORT=22 scripts/deploy.sh backfill     # 部署后执行历史数据回填
```

手动等价流程：

```bash
scp -i ~/.ssh/your_key server.js user@your-server:/tmp/
ssh -i ~/.ssh/your_key user@your-server \
  "node --check /tmp/visit-stats-server.js && install -m 600 /tmp/visit-stats-server.js /opt/visit-stats/server.js && pm2 restart visit-stats"
```

生产布局：`/opt/visit-stats/`（server.js + geo/ + data/ + .token）。
历史日志导入的日志路径映射写在 `import-logs.json`（不入库，格式见 `import-logs.sample.json`）。

## 地理数据（不入库，需自行构建）

`geo/geocn-compact.json` 与 `geo/country-compact.json` 由授权数据构建，**不在本仓库分发**：

- 中国省市区县 + ISP：[GeoCN](https://github.com/xycz258/GeoCN)（精确到区县级）→ 紧凑为 `geocn-compact.json`
- 境外国家：MaxMind GeoLite2（需同意其 EULA，禁止再分发）→ 紧凑为 `country-compact.json`
- 中国省级 SVG 地图 `china-map.json` 与地级市中心点 `city-points.json` 基于
  [阿里 DataV GeoAtlas](https://datav.aliyun.com/portal/school/atlas/area_selector) 数据生成，已随仓库分发

结构：`geocn-compact.json` 为 `{v4:[start,end,code,isp]..., v6:[s0..s3,e0..e3,code,isp]..., isp:[...], div:{码:名}}`，
`country-compact.json` 为 `{v4:[start,end,nameIdx]..., v6:9元组..., names:[...]}`。服务端启动时若缺失会提示并退出。

## 安全模型（勿破坏）

- **不暴露源站**：服务只监听 loopback；面板经 EdgeOne 域名（CNAME）访问，禁止 A 记录直指源站 IP
- **认证**：所有 `/api/*` 需 `Authorization: Bearer <token>`（timingSafeEqual 恒时比较）；SSE 用 `?token=`（EventSource 无法带 header），同样恒时比较
- **采集白名单**：`/stats/collect` 校验 Host ∈ {inknook.ink, www.inknook.ink, hs2z.inknook.ink, harness.inknook.ink}，伪造 Host 直接丢弃；www 归并为 inknook.ink 入库
- **爬虫过滤**：UA 正则拦截 + nginx 导入层过滤非 200/静态资源
- **CSV 导出**：防 Excel 公式注入（`=`/`+`/`@` 前缀转义）
- **tracker 注入**：nginx `sub_filter` 在博客/hs2z 反代层注入 `/stats/t.js`（harness 自带引用，勿重复注入）

## 数据口径速记

- 会话：30 分钟无活动切分；停留时长按页面可见时段累计（visibilitychange 结算）
- 地理：GeoCN（中国大陆精确到区县+ISP）→ GeoLite2（境外国家）→ 境外/未知
- 地图链路：在线访客按 市（city-points）→ 就近 EdgeOne 大区节点（北京/沈阳/杭州/武汉/广州/成都/西安）→ 源站·上海
- 实时性：SSE 推送（`/api/stream`，20s 心跳）+ 3s/15s 尾沿合并节流刷新 + 2/5 分钟轮询兜底

## 生产备份

`/opt/visit-stats/server.js.bak-*` 为每次部署自动留存的版本，命名含时间与改动主题
（ui / district / wrap / ranktip / charttip / flow / www / center / city …）。
