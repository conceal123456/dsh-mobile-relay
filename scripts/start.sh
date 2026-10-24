#!/usr/bin/env bash
# dsh-mobile-relay —— macOS / Linux 一键启动
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 18.17+：https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 版本过低（$(node -v)），需要 18.17 或更高" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> 安装依赖"
  npm install --no-audit --no-fund
fi

echo "==> 启动中继（Ctrl+C 退出）"
exec npm start
