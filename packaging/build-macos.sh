#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."

arch="${1:-$(uname -m)}"
[[ "$arch" != x86_64 ]] || arch=x64
if [[ "$arch" != arm64 && "$arch" != x64 ]]; then
  echo "用法：$0 [arm64|x64]" >&2
  exit 1
fi
exec node packaging/build-electron.mjs darwin "$arch"
