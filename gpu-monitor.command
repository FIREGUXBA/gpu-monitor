#!/bin/zsh
cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:8787"

if curl -fsS --max-time 2 "$URL/api/state" >/dev/null 2>&1; then
  echo "监控已在运行：$URL"
  open "$URL"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$p" ]; then
      PATH="$(dirname "$p"):$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js（brew install node）"
  read -r "?按回车退出…"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 npm，请先安装 Node.js（brew install node）"
  read -r "?按回车退出…"
  exit 1
fi

if [ ! -d node_modules ] || [ ! -d node_modules/ssh2 ]; then
  echo "首次运行，正在安装依赖…"
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "依赖安装失败，请检查网络后重试（也可手动执行：npm install）"
    read -r "?按回车退出…"
    exit 1
  fi
  if [ ! -d node_modules/ssh2 ]; then
    echo "依赖安装不完整（缺少 ssh2），请手动执行：npm install"
    read -r "?按回车退出…"
    exit 1
  fi
fi

echo "正在启动 GPU 监控…"
( sleep 1.5; open "$URL" ) &
exec node server.mjs