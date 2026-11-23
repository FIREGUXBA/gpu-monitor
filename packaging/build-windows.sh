#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
exec node packaging/build-electron.mjs win32 x64
