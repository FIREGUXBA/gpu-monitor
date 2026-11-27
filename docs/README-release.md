# GPU Monitor 发布指南

稳定版发布到 GitHub Releases，提供 macOS Apple Silicon 压缩包、Windows x64 安装包和便携包。两个平台的应用内更新都从 GitHub 的 `releases/latest/download/` 读取各自的更新清单，每次发布都要上传两份清单。

## 1. 准备构建环境

- 使用 macOS、Node.js 22.12 或更高版本，以及 Xcode Command Line Tools。GitHub 账号需要有仓库写权限。
- 下载并解压项目使用的 Sparkle SDK，取得 `bin/generate_keys`、`bin/generate_appcast` 和 `bin/sign_update`。 [Sparkle 2.10.1 SDK](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.1)
- 用钥匙串中 `FIREGUXBA.gpu-monitor` 账户的现有签名密钥发布。旧版内置了对应的公钥，更换密钥会导致旧版无法验证更新。换机器时，先迁移原密钥。

## 2. 提升版本并提交

在仓库根目录操作。以下用 `0.1.3` 举例，把版本改成这次要发布的值。先确认 `main` 包含本次要发布的全部改动，再执行版本提交。

```bash
git switch main
git status --short --branch
git pull --ff-only origin main

VERSION=0.1.3
TAG="v$VERSION"
REPO=FIREGUXBA/gpu-monitor

npm ci
npm version "$VERSION" --no-git-tag-version --ignore-scripts
npm test
git diff --check
git diff -- package.json package-lock.json
git add -- package.json package-lock.json
git commit -m "release: GPU Monitor $VERSION"
RELEASE_COMMIT="$(git rev-parse HEAD)"
git push origin HEAD:main
```

`npm version` 会同时更新 `package.json` 和 `package-lock.json`。遇到命令失败时，先解决问题再继续。

## 3. 构建应用和更新清单

在同一份已提交的源码上构建两平台。把 `SPARKLE_BIN` 改成解压后 SDK 的实际 `bin` 路径。若脚本找不到默认位置的 `node_api.h`，将 `NODE_HEADERS_DIR` 设为包含该文件的目录后重试。

```bash
SPARKLE_BIN=/path/to/Sparkle-SDK/bin
SPARKLE_ACCOUNT=FIREGUXBA.gpu-monitor
export SPARKLE_PUBLIC_ED_KEY="$("$SPARKLE_BIN/generate_keys" --account "$SPARKLE_ACCOUNT" -p)"
export SPARKLE_FEED_URL="https://github.com/$REPO/releases/latest/download/appcast-macos-arm64.xml"

test -n "$SPARKLE_PUBLIC_ED_KEY" &&
  ./packaging/build-macos.sh arm64 &&
  ./packaging/build-windows.sh &&
  git diff --exit-code "$RELEASE_COMMIT" --
```

Windows 脚本会同时生成安装包、便携包和 `latest.yml`。macOS 要对本次生成的 ZIP 制作 appcast，再签署 XML。

```bash
MAC_ZIP=GPU-Monitor-Electron-macos-arm64.zip
WIN_ZIP=GPU-Monitor-Electron-windows-x64.zip
WIN_INSTALLER="GPU-Monitor-Setup-$VERSION-x64.exe"
APPCAST=appcast-macos-arm64.xml
APPCAST_DIR="$(mktemp -d)"
```

若需要在应用内显示更新说明，在运行下一组命令前，把本版说明写到 `$APPCAST_DIR/GPU-Monitor-Electron-macos-arm64.html`。

```bash
cp "dist/$MAC_ZIP" "$APPCAST_DIR/" &&
  "$SPARKLE_BIN/generate_appcast" --account "$SPARKLE_ACCOUNT" \
    --download-url-prefix "https://github.com/$REPO/releases/download/$TAG/" \
    --embed-release-notes -o "$APPCAST_DIR/$APPCAST" "$APPCAST_DIR" &&
  "$SPARKLE_BIN/sign_update" --account "$SPARKLE_ACCOUNT" "$APPCAST_DIR/$APPCAST" &&
  cp "$APPCAST_DIR/$APPCAST" dist/
```

## 4. 核对附件并发布

先核对 ZIP 完整性、macOS 更新源与 ZIP 的签名，以及 Windows 清单中的版本、文件名和安装包摘要。

```bash
unzip -tq "dist/$MAC_ZIP"
unzip -tq "dist/$WIN_ZIP"
"$SPARKLE_BIN/sign_update" --verify --account "$SPARKLE_ACCOUNT" "dist/$APPCAST"
MAC_SIGNATURE="$(xmllint --xpath 'string(//enclosure/@*[local-name()="edSignature"])' "dist/$APPCAST")"
"$SPARKLE_BIN/sign_update" --verify --account "$SPARKLE_ACCOUNT" "dist/$MAC_ZIP" "$MAC_SIGNATURE"
test "$(xmllint --xpath 'string(//item/*[local-name()="version"])' "dist/$APPCAST")" = "$VERSION"
test "$(xmllint --xpath 'string(//enclosure/@url)' "dist/$APPCAST")" = "https://github.com/$REPO/releases/download/$TAG/$MAC_ZIP"
grep -Fx "version: $VERSION" dist/latest.yml
grep -Fx "path: $WIN_INSTALLER" dist/latest.yml
test "$(openssl dgst -sha512 -binary "dist/$WIN_INSTALLER" | openssl base64 -A)" = "$(awk '/^sha512:/ {print $2}' dist/latest.yml)"
```

确认各项检查通过后，为构建所用的提交打标签。

```bash
git tag "$TAG" "$RELEASE_COMMIT"
git push origin "refs/tags/$TAG"
```

在仓库的 Releases 页面选择 **Draft a new release**，选中刚推送的标签，填写标题和更新说明，并上传 `dist/` 中这五个文件。 [GPU Monitor Releases](https://github.com/FIREGUXBA/gpu-monitor/releases)

| 附件 | 用途 |
| --- | --- |
| `GPU-Monitor-Electron-macos-arm64.zip` | macOS Apple Silicon 下载及应用内更新 |
| `appcast-macos-arm64.xml` | macOS 签名更新源 |
| `GPU-Monitor-Setup-<版本>-x64.exe` | Windows 安装及应用内更新 |
| `GPU-Monitor-Electron-windows-x64.zip` | Windows 便携版下载 |
| `latest.yml` | Windows 更新清单 |

等五个附件都上传完成，确认 **This is a pre-release** 未选中，选中 **Set as latest release**，再点 **Publish release**。 [GitHub 发布操作说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release)

## 5. 发布后核验

确认最新发布页指向新标签，且客户端实际访问到的两份清单和本次上传的文件一致。

```bash
LATEST="https://github.com/$REPO/releases/latest/download"
test "$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).tag_name')" = "$TAG"
curl -fsSL "$LATEST/$APPCAST" | cmp - "dist/$APPCAST"
curl -fsSL "$LATEST/latest.yml" | cmp - dist/latest.yml
git ls-remote --tags origin "refs/tags/$TAG"
```

最后在上一版的 macOS 应用和 Windows 安装版里分别点击「检查更新…」，确认能看到新版本。若执行了实际升级，再确认应用版本、SSH 连接设置和历史记录。Windows 便携版通过下载新版 ZIP 手动更新。
