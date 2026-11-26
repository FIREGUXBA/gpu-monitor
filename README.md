# GPU 监控

一个本地运行的 GPU 监控面板：通过 SSH 连接 Linux 服务器，每 2 秒读取一次 `nvidia-smi`，不用登录机器就能看清显卡负载、显存余量和正在跑的任务。

![总览](docs/screenshots/overview.png)

## 功能

一屏看清整台机器：顶部是显存、利用率、任务和用户的整体指标；下方每张显卡一张卡片，曲线、显存、温度和功耗一眼可见，点卡片还能查看这张卡上的任务。页面下半部分是运行中的任务、按用户汇总的显存占用和机器信息；任务页平铺全部进程与完整命令行，并可按显卡筛选。侧栏可随时暂停刷新或切换深浅主题。

## 桌面版

- **macOS**：解压 `GPU-Monitor-Electron-macos-arm64.zip`，双击 `GPU Monitor.app`。这个包适用于 Apple Silicon。可将应用拖到「应用程序」目录。
- **Windows x64**：下载 `GPU-Monitor-Setup-<版本>-x64.exe`，双击并按向导安装。也可下载便携 ZIP，完整解压后运行 `GPU Monitor.exe`。使用免密登录时，请在 Windows 的可选功能中安装 OpenSSH 客户端。
- **从源码启动**：安装 Node.js 22.12 或以上版本，在 macOS 双击 `gpu-monitor.command`。也可以运行 `npm ci && npm start`。首次启动会下载 Electron 运行时。

关闭窗口后仍会继续采样。用 macOS 菜单栏或 Windows 托盘的「打开面板」恢复窗口，也可以再次双击应用。要结束采样，从同一菜单选择「退出」。

带有更新功能的 macOS 发行版会在启动后自动检查新版，也可以从「GPU Monitor」菜单或菜单栏图标选择「检查更新…」。发现新版时会显示更新说明，由你确认是否安装。从未内置更新器的版本升级时，第一次需要手动安装带更新器的版本。

Windows 安装版在启动时自动检查更新，也可以从窗口的「帮助」菜单或托盘菜单选择「检查更新…」。确认后应用会下载新版，并重启完成安装。便携版用户可以先退出旧版，再运行安装包启用此功能，原有的连接和采样历史会继续使用。

## 连接和迁移

第一次打开时可选择 SSH 配置里的免密主机，也可输入主机、端口、用户名和密码。登录后会保存连接并在下次启动时重连。密码由 macOS 钥匙串或 Windows DPAPI 保存。点「清除登录」可断开并删除保存的连接。

- **从旧发行版升级**：先从菜单栏或托盘退出旧版，再启动 Electron，避免同时写入同一份历史。macOS 继续使用 `~/Library/Application Support/GPU Monitor` 和原钥匙串条目。Windows 继续使用 `%LOCALAPPDATA%\GPU Monitor`，同一个 Windows 账户可解密原密码。
- **从源码网页版迁移**：桌面数据目录为空时，先从原项目启动一次 Electron。应用会复制项目 `data/` 中的连接和采样历史。以后启动发行版会继续使用同一平台目录。
- **指定目录**：可用 `GPU_MONITOR_DATA_DIR` 指定存储目录。默认情况下，网页版与桌面版各用自己的目录。请为同时运行的实例使用不同目录。

## 网页版

```bash
npm ci --omit=dev
node server.mjs
```

在浏览器访问 <http://127.0.0.1:8787>。默认在项目的 `data/` 保存数据。仍可通过环境变量调整端口、监听地址和初始连接，例如 `SSH_HOST=my-gpu-box PORT=9000 HOST=127.0.0.1 node server.mjs`。

## 构建发行版

在 macOS 使用 Node.js 22.12 或以上版本。两个 ZIP 都包含 Electron 运行时和应用依赖。

```bash
npm ci
packaging/build-macos.sh       # 当前 Mac 架构，也可显式传入 arm64 或 x64
packaging/build-windows.sh     # Windows x64
```

构建产物输出到 `dist/`。macOS 脚本生成 ad-hoc 签名包，无 Developer ID 签名或公证。Windows 脚本生成 NSIS 安装包、更新清单和便携 ZIP。未配置 Authenticode 证书时，Windows 可能显示 SmartScreen 提示。

### 发布带应用内更新的 Windows 版本

提升 `package.json` 的版本号并同步锁文件，运行 `packaging/build-windows.sh`。将同一次构建的 `GPU-Monitor-Setup-<版本>-x64.exe` 与 `latest.yml` 一并上传到对应的 GitHub Release，并设为最新正式版。客户端从 `releases/latest/download/latest.yml` 获取版本和安装包的 SHA-512。

### 发布带应用内更新的 macOS 版本

1. 从 [Sparkle 发行页](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.1) 下载并解压 Sparkle SDK，首次运行 `bin/generate_keys --account FIREGUXBA.gpu-monitor`。它将私钥保存在钥匙串里并显示公钥。以后所有升级包都要用同一把私钥签名，请备份私钥。
2. 提升 `package.json` 中的版本号，配置公钥后打包。脚本会嵌入固定版本的 Sparkle SDK，并验证 SDK 下载的 SHA-256。构建机需要 Xcode 或 Command Line Tools，以及 Node.js 开发头文件。可用 `NODE_HEADERS_DIR` 指定 `node_api.h` 所在目录。

   ```bash
   export SPARKLE_PUBLIC_ED_KEY="$(/path/to/Sparkle/bin/generate_keys --account FIREGUXBA.gpu-monitor -p)"
   npm ci
   ./packaging/build-macos.sh arm64
   ```

3. 为每个已支持的 Mac 架构生成独立的更新源。下面是 `v0.2.0` 的 Apple Silicon 示例。`bin` 是解压后的 Sparkle 工具包内的目录。在暂存目录放入 `GPU-Monitor-Electron-macos-arm64.html`，即可把更新说明嵌进 XML。

   ```bash
   appcast_dir=$(mktemp -d)
   cp dist/GPU-Monitor-Electron-macos-arm64.zip "$appcast_dir/"
   /path/to/Sparkle/bin/generate_appcast \
     --account FIREGUXBA.gpu-monitor \
     --download-url-prefix https://github.com/FIREGUXBA/gpu-monitor/releases/download/v0.2.0/ \
     --embed-release-notes -o "$appcast_dir/appcast-macos-arm64.xml" "$appcast_dir"
   cp "$appcast_dir/appcast-macos-arm64.xml" dist/
   ```

4. 把 ZIP 和 `appcast-macos-arm64.xml` 一起附到同一个 GitHub Release，再将其发布为最新正式版。客户端默认从 `releases/latest/download/` 读取对应架构的 XML。此后发布最新正式版时，继续附上每个已支持架构的 appcast。可以在构建时通过 `SPARKLE_FEED_URL` 改用其他 HTTPS 更新源。

未配置公钥时，仍可构建普通 ZIP。换用 Developer ID 签名或公证属于独立的发布流程，Sparkle EdDSA 签名只用于验证更新包。

## 常见问题

- **网页版端口已占用**：退出占用 8787 的服务，或用 `PORT` 指定其他端口。
- **免密登录失败**：先在终端确认 `ssh <别名> nvidia-smi` 能直接运行。
- **密码登录提示主机指纹变化**：向管理员核实新指纹后，勾选「信任新的主机指纹并继续」。
- **一直显示「正在连接…」**：检查网络、SSH 和远端的 `nvidia-smi`。如果显示「未选择服务器」，请在左侧栏点「登录」。
