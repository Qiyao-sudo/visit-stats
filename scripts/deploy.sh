#!/usr/bin/env bash
# visit-stats 一键部署：备份 → 上传 → 远端语法检查 → 安装 → PM2 重启 → 健康检查
# 用法（目标服务器通过环境变量提供，不写入本文件）:
#   DEST=user@your-server PORT=22 scripts/deploy.sh            # 仅部署 server.js
#   DEST=user@your-server PORT=22 scripts/deploy.sh geo        # 同时推送 geo/*.json
#   DEST=user@your-server PORT=22 scripts/deploy.sh backfill   # 部署后执行历史数据回填
set -euo pipefail

KEY="${KEY:-$HOME/.ssh/id_ed25519}"
DEST="${DEST:-}"
PORT="${PORT:-22}"
if [ -z "$DEST" ]; then
  echo "用法: DEST=user@your-server [PORT=22] [KEY=~/.ssh/xxx] scripts/deploy.sh [geo|backfill]"
  exit 1
fi
REMOTE_DIR="${REMOTE_DIR:-/opt/visit-stats}"
TS="$(date +%Y%m%d%H%M%S)"
SSH="ssh -i $KEY -p $PORT -o StrictHostKeyChecking=no $DEST"
SCP="scp -i $KEY -P $PORT -o StrictHostKeyChecking=no"

cd "$(dirname "$0")/.."

echo "[1/5] 备份生产 server.js"
$SSH "cp $REMOTE_DIR/server.js $REMOTE_DIR/server.js.bak-$TS"

echo "[2/5] 上传"
$SCP server.js "$DEST:/tmp/visit-stats-server.js"
if [ "${1:-}" = "geo" ] || [ "${1:-}" = "backfill" ]; then
  $SCP geo/*.json "$DEST:$REMOTE_DIR/geo/"
fi

echo "[3/5] 远端语法检查并安装"
$SSH "node --check /tmp/visit-stats-server.js && install -m 600 /tmp/visit-stats-server.js $REMOTE_DIR/server.js"

echo "[4/5] 重启 PM2"
$SSH "pm2 restart visit-stats --update-env"
sleep 3

if [ "${1:-}" = "backfill" ]; then
  echo "[4b] 执行历史回填"
  $SSH "cd $REMOTE_DIR && BACKFILL=1 node server.js && pm2 restart visit-stats --update-env"
  sleep 3
fi

echo "[5/5] 健康检查"
$SSH "printf 'listen=' && ss -ltnp | grep ':3100' | sed 's/.*LISTEN/LISTEN/' \
  && printf 'http=' && curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/ \
  && pm2 status visit-stats | grep visit-stats"

echo "完成。备份: server.js.bak-$TS"
