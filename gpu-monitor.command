#!/bin/zsh
cd "$(dirname "$0")" || exit 1

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

if [ ! -x node_modules/.bin/electron ] || [ ! -d node_modules/ssh2 ]; then
  echo "首次运行，正在安装依赖…"
  if ! npm ci --include=dev --no-audit --no-fund; then
    echo "依赖安装失败，请检查网络后重试"
    read -r "?按回车退出…"
    exit 1
  fi
fi

exec npm start
