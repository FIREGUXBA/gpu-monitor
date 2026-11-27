# GPU 余量蹲守通知 · 设计方案

> 状态：待确认（未开始实现）
> 对齐基线：当前工作区（`server.mjs` 1071 行；`history.mjs`、`desktop-lifecycle.mjs` 已抽出）
> 术语基线：`GLOSSARY.md`（v3：全文按术语表重写，并补充通知相关新词）
> 一句话：**当前 target 上同时有够 N 块、每块可用显存够 X GB 的 GPU，就推一条微信，然后这次 watch 结束。**

---

## 1. 需求

真实场景不是"播报 target 状态"，而是**蹲 GPU 余量**：

> 我要微调模型，占用 1–2 块 GPU 就够。但现在 GPU 被占满了，我想把任务排着——
> **等有余量、而且够我这次用，就提醒我。**

判定条件：

> **当前 target 上，同时可用的 GPU 数 ≥ N**，且每块可用显存 ≥ X GB。

N、X 由用户设定，默认 N=1、X=0（不限制显存）。

---

## 2. 术语（对齐 `GLOSSARY.md` 及新增）

沿用术语表已有词：**target**、**target label**、**remote hostname**、**switch**、**raw sample**、**snapshot**、**stale sample**、**GPU**、**GPU index**、**run task**、**owner**、**live session**、**saved connection**、**system-ssh mode**。

本方案新增以下词，建议后续追加进 `GLOSSARY.md`：

**available GPU**:
当前 target 上满足"利用率 ≤ utilIdlePct 且可用显存 ≥ minFreeGb"的一块 **GPU**。
_Avoid_: idle card, free card, 空闲卡

**watch**:
用户表达的一次性意图：至少 N 块 **available GPU**、每块可用显存 ≥ X GB。它是本功能唯一的持久化用户意图。
_Avoid_: subscription, alert, rule, 订阅

**watch window**:
判定 watch 是否达标的时间窗，默认 5 分钟。
_Avoid_: 滑动窗口, 观察期

**qualified**:
watch window 内 ≥90% 的 **raw sample** 显示可用 **GPU** 数 ≥ N。
_Avoid_: idle, 空闲, 达标（口语可，文档用 qualified）

**push**:
通过通知通道向用户发出一条消息。
_Avoid_: 告警, 报警, notify call

**notification channel**:
承载 **push** 的通道。支持 WxPusher 极简 SPT 与 Server酱 SendKey；配置多个时并行推送，任一成功即结束 watch。
_Avoid_: webhook, bot

**SPT**:
WxPusher 极简推送令牌（`SPT_xxx`），是用户级凭据。
_Avoid_: token, key, appToken

---

## 3. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 交付形态 | 内建进现有 Electron 进程，复用 2 秒采样循环 |
| 2 | 多用户 | 每人装一份 app，各自配自己的微信；SPT 不进发行版 |
| 3 | 通道 | WxPusher **极简 SPT** 与 **Server酱 SendKey**，可以同时配置，达标时都推送 |
| 4 | 凭据存储 | 应用内设置面板填写 → `data/notify.json`（0600） |
| 5 | watch 参数 | 有默认值，也能在面板里临时开一次 |
| 6 | 判定 | watch window 内 **≥90% raw sample** qualified 才算 |
| 7 | 通知范围 | 只推 qualified 那一次；变忙不推；可用 GPU 变多不重复推 |
| 8 | watch 生命周期 | **push 成功一条后自动结束**（一次性） |
| 9 | 持久化 | `watch` 与 `lastNotify` 落盘，重启不丢、不重复推 |
| 10 | 失败兜底 | 重试 3 次 → 仍失败弹系统通知 + 面板显示状态；**watch 不消耗** |
| 11 | 面板 | 侧栏入口 + 测试 push 按钮 + "watch 中"标记 + 取消入口 |
| 12 | 不做 | 实时凑数进度、免打扰时段、自动过期、多 target 并行、自动拉起 run task |
| 13 | switch | 保留 watch 意图，清空 watch window 重新累计 |
| 14 | live session 中断 | 超过 2 分钟标记 unknown，不判定、不 push；恢复后重新累计整个 watch window |

### 与早期回答的修订

需求从"播报余量"变成"蹲余量"后，三条早期结论被简化：

1. **显存条件从"≤10%"改为"可用显存 ≥ X GB"**。相对百分比回答不了"模型装不装得下"。
2. **取消 30 分钟冷却**。一次性 watch 下冷却只会拦住用户主动重开，改为 60 秒防重触发。
3. **删除"变忙"阈值（≥30% / 2 分钟）**。既然不推变忙，这套状态机不需要。

---

## 4. 核心规则

### 4.1 判定单块 GPU 是否 available

`parseGpus()`（`server.mjs:536`）产出的 `memUsed` / `memTotal` 单位是 **MiB**：

```js
const freeGb = (gpu.memTotal - gpu.memUsed) / 1024;
const available = gpu.util <= rule.utilIdlePct && freeGb >= watch.minFreeGb;
```

- `utilIdlePct` 默认 10；`minFreeGb` 默认 0（只看利用率）。
- **不额外扣减预留**，余量由用户自己留。面板需提示：蹲余量时请填真实需求值。

> 已知取舍：`minFreeGb = 0` 时，显存占满但利用率为 0 的 GPU 会被判为 available。这是用户显式选择，不做隐式修正。

### 4.2 判定 qualified

每次 **raw sample** 记录 `{ t, count }`，`count` 是 available **GPU** 的数量：

```js
windowMs   = rule.windowSec * 1000            // 默认 300000
samples    = 最近 windowMs 内的 raw sample（丢弃 t > now 的时钟回拨样本）
windowFull = now - samples[0].t >= windowMs - 2 * POLL_MS
okRatio    = samples.filter(s => s.count >= watch.cards).length / samples.length
qualified  = windowFull && okRatio >= 1 - rule.tolerance   // tolerance 默认 0.1
```

`windowFull` 必须有，否则刚启动十几秒就会误判。

### 4.3 状态推进

```
idle ──开 watch──▶ accumulating ──qualified──▶ push ──成功──▶ done（watch 清空）
                        │                       └──失败──▶ watch 保留，60 秒后重试
                        ├──live session 中断 >2min──▶ unknown（清空 window）
                        └──switch──────────────────▶ accumulating（清空 window，watch 保留）
```

- 只允许**同时一个** active watch；新建覆盖旧的，UI 提示。
- push 成功后删除 `watch`，写入 `lastNotify`。
- push 失败不消耗 watch，避免"没通知到却自动结束"。
- **stale sample 一律丢弃**：`notifier.onSample(snapshot, gen)` 里先校验 `gen === generation`。`switch` 之后旧 target 迟到的 **raw sample** 不能进入新 target 的 watch window——这正是现有 `test/monitor-session.test.mjs` 在守护的不变量。

### 4.4 与现有采样的接入点（已核对行号）

| 位置 | 现状 | 改动 |
|---|---|---|
| `server.mjs:679` | `snapshot = { ... }` | 之后调用 `notifier.onSample(snapshot, gen)` |
| `server.mjs:692` | `lastGoodAt = now` | 判断 live session 是否中断，不改 |
| `server.mjs:563` | `resetForTarget(file)`，内部 `generation++` | 追加 `notifier.resetTarget()` |
| `server.mjs:705` | 没有 target 时 `snapshot = null` | 追加 `notifier.markUnknown()` |
| `server.mjs:887` | `startMonitor()` | 追加 `await notifier.load()` |
| `server.mjs:893` | `stopMonitor()` | 追加 `notifier.stop()` 清理重试定时器 |
| `server.mjs:930` | `handleRequest()` | 追加 5 个 `/api/notify*` 路由 |

**关键约束**：`onSample()` 必须**非阻塞且不抛异常**。它内部若 `await` 网络请求，会把 2 秒采样拖长；若抛错，会被 `loop()` 的 `catch` 当成采样失败写进 `lastError`。所以：

```js
// sample() 末尾
try { notifier.onSample(snapshot, gen); } catch {}
```

push 在 notifier 内部的异步任务里完成，不阻塞采样。

---

## 5. 数据设计

### 5.1 `data/notify.json`（0600）

```json
{
  "spt": "SPT_xxxxxxxx",
  "enabled": true,
  "defaults": { "cards": 1, "minFreeGb": 0 },
  "rule": { "utilIdlePct": 10, "windowSec": 300, "tolerance": 0.1 },
  "watch": { "cards": 2, "minFreeGb": 24, "createdAt": 1795760093603 },
  "lastNotify": { "at": 1795760093603, "ok": true, "error": null, "cards": [2, 5] }
}
```

- **per-installation，不属于任何 target key**。watch 只在当前 target 上生效；**switch** 不清除 watch。
- `watch: null` 表示没有 watch。
- 文件不存在时使用内置默认值，不报错。
- 写入沿用 `writeConfigFile()`（`server.mjs:263`）的 **tmp + rename + `mode: 0o600`**。
- Windows 上 `mode` 不生效，只能依赖用户目录 ACL。文档如实写。

### 5.2 内存态

```
window: Array<{ t, count }>   // watch window，约 150 条 raw sample
pushRetryAt: number
```

`gen` 不单独存——`onSample` 入参就带，比较即丢弃 stale sample。

---

## 6. push

### 6.1 WxPusher 极简 SPT

```http
POST https://wxpusher.zjiecode.com/api/send/message/simple-push
Content-Type: application/json

{ "spt": "SPT_xxx", "content": "……", "summary": "2 块 GPU 可用", "contentType": 1 }
```

- 超时 5 秒（`AbortController`）；重试 3 次，退避 1s / 3s / 9s。
- 限额：单 SPT 每天数百至上千条、QPS ≤ 1。本项目一天最多十几条。
- **SPT 是凭据**：不写日志、不进发行版；面板回显脱敏为 `SPT_••••abcd`。

### 6.2 消息模板

```
【zhichen-server】GPU 余量达标
当前 2 块 GPU 可用（每块 ≥24 GB）
GPU 2｜可用 28.4 GB｜利用率 3%
GPU 5｜可用 29.1 GB｜利用率 0%
已持续满足 5 分 12 秒
```

- 标题用 **target label**（`snapshot.target`）；与 **remote hostname**（`snapshot.host`）不同时两者都写。
- 正文用 **GPU index**（`GPU 2`），不用 "卡 2"。
- `summary` ≤ 20 字符，例：`2 块 GPU 可用 · zhichen`。
- 最多列 8 块，超出写"等 N 块"。

### 6.3 失败兜底

| 场景 | 行为 |
|---|---|
| 成功 | `lastNotify.ok = true`，清空 `watch` |
| 重试后仍失败 | `lastNotify.ok = false` + 错误；`watch` 保留；`pushRetryAt = now + 60s` |
| Electron | 额外 `new Notification({...}).show()` |
| 网页版 | 不弹系统通知，仅面板显示 |
| 未填 SPT | 不 push，面板提示"未配置通知通道" |

`server.mjs:35` 已有 `DESKTOP = Boolean(process.versions.electron)`，据此动态 `import('electron')`。`desktop.mjs` **不需要改**。

两个平台注意点：

- `desktop.mjs:109` 把所有 renderer 权限请求都拒了，但**主进程**的 `new Notification()` 不经过该 handler，不受影响。
- macOS 能否真正弹出取决于系统对 GPU Monitor 的通知授权；授权关了只剩面板状态。文档要写。

### 6.4 CSP

桌面版 CSP 为 `default-src 'self'`（`desktop.mjs:116`），renderer 不能直连 `wxpusher.zjiecode.com`。因此 **push 必须发生在 `server.mjs`（Node 主进程）里**，不能用前端 `fetch`。

---

## 7. 接口

挂在现有 `handleRequest()`（`server.mjs:930`）上，沿用 `/api/connection` 的模式：先校验 `content-type`（415），用 `readJson(req)`（`server.mjs:127`），错误用 `errorWithStatus()`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/notify` | 脱敏配置 + `watch` + `lastNotify` |
| PUT | `/api/notify` | 更新 `spt` / `enabled` / `defaults` / `rule` |
| POST | `/api/notify/watch` | 开 watch `{cards, minFreeGb}` |
| DELETE | `/api/notify/watch` | 取消 watch |
| POST | `/api/notify/test` | 发测试 push，返回 `{ok, error}` |

校验：

- `spt`：`/^SPT_[A-Za-z0-9_-]{8,}$/`
- `cards`：1–32 整数；`minFreeGb`：0–1024；`utilIdlePct`：0–100；`windowSec`：60–1800；`tolerance`：0–0.5
- PUT 收到脱敏占位符时保留原值，避免误清空
- 这些接口在没有 `snapshot` 时也应返回 200（纯配置，不依赖采集）

---

## 8. 前端（按现有结构）

### 8.1 侧栏按钮

`public/index.html:91` 的 `.rail-bottom` 里新增，与 `#connectBtn` / `#theme` / `#pause` 完全同构：

```html
<button id="notifyBtn" class="rail-link rail-btn" type="button" aria-haspopup="dialog"
        aria-label="通知设置" title="通知设置">
  <svg class="icon" aria-hidden="true"><use href="#i-bell"/></svg>
  <span class="rail-label">通知</span>
  <span class="rail-dot" hidden></span>
</button>
```

- 图标符号加到 `index.html:30` 的隐藏 `<svg>` 里（与 `#i-grid`、`#i-key`、`#i-sun` 同处）。
- `.rail-dot` 是新类，需在 `app.css:191` 附近补样式（绝对定位小圆点 + `--accent`）。
- 窄屏（网页版）已有规则把 `.rail-bottom` 折成顶栏（`app.css:575-601`），新按钮自动继承。

### 8.2 弹窗

照抄 `#connectDialog` 的结构（`index.html:294-333`）：`.modal > .modal-card > .modal-head/.modal-sub/.field-grid/.modal-note/.modal-error/.modal-actions`，关闭按钮用 `.icon-btn`，主按钮 `.primary-btn`，次要 `.ghost-btn`。

字段：

1. WxPusher SPT（`type="password"`，附"如何获取"外链）
2. 默认 watch：N 块、每块可用显存 X GB
3. 高级（折叠）：利用率阈值、watch window 秒数、容差
4. 上次 push：`成功 · 14:22` / `失败：timeout`

按钮：保存 / 发送测试 push / 开始 watch（或取消 watch）/ 关闭。

### 8.3 交互与状态

- `app.js` 是单个 IIFE（`public/app.js:1-1203`），沿用 `$`、`$$`、`setText`、`live()`。
- 弹窗开关沿用 `#connectBtn` 的模式（`app.js:1126`、`1132` 的遮罩关闭）。
- watch 状态跟 `/api/state` 一起拿：在 `server.mjs:948` 的返回体里加 `notify: { watch, lastNotify }`，**不新增轮询**。
- 不做实时凑数进度。侧栏只显示 watch 圆点和 `title`。

---

## 9. 代码结构（对齐 `history.mjs` 的写法）

新增：

```
notify.mjs              # 判定 + 配置 + push，不依赖 Electron
test/notify.test.mjs
```

`notify.mjs` 对外接口：

```js
export function createNotifier({ dataDir, pollMs })   // 与 createHistoryStore 同风格
export function evaluateWindow(samples, watch, rule, now)   // 纯函数
export function renderMessage({ target, hostname, gpus, watch, durationMs })
export function maskSpt(spt)
export function createSptSender({ fetchImpl = fetch })      // 可注入，便于测试
```

内部沿用 `history.mjs` 的两个习惯：读写走一条串行队列；写文件用 tmp + rename。

改动：

- `server.mjs`：7 处接入点（见 4.4）+ `/api/state` 返回体加 `notify`。
- `public/index.html` / `app.js` / `app.css`：按钮、弹窗、样式。
- `README.md`：加"微信通知"一节（如何取 SPT、平台限制）。
- **不动** `history.mjs`、`desktop-lifecycle.mjs`、`charts.js` 和正在进行的重构。

---

## 10. 与现状对齐时发现的约束

1. **迁移白名单不含 `notify.json`**。`migrate.mjs:13` 的 `isMonitorFile` 只匹配 `connection.json` 和 `history*.jsonl`。从源码网页版升级到桌面版时通知配置不会带过去，需重填 SPT 一次。建议保持白名单不动，在 README 写明。
2. **switch 的收尾在 `resetForTarget()`**。login、switch、清除 **saved connection** 都走它（`server.mjs:563`），这是唯一需要重置 watch window 的地方，不要散落到各登录函数里。
3. **没有 target 时采样循环不报错**，只是 `snapshot = null` 并 1 秒重试（`server.mjs:705`）。notifier 要显式处理，不能等 2 分钟超时。
4. **`/api/state` 无 snapshot 时返回 503**（`server.mjs:974`）。通知接口不要跟着 503，否则用户没连上时连 SPT 都填不了。
5. **`sample()` 的 await 顺序**：`historyStore.persist()` 之后才赋值 `snapshot`。notifier 接在 `snapshot` 之后，天然拿到已落盘的一帧。
6. **`POLL_MS` 是常量 2000**（`server.mjs:28`），5 分钟 window = 150 条 raw sample；测试里用 `pollMs` 参数注入更快的值，不要改常量。
7. **测试风格**：`node:test` + 临时目录 + 假 `ssh` 脚本（见 `test/monitor-session.test.mjs`）。notifier 单测直接 import 模块，不需要起服务、不需要真 SSH。

---

## 11. 测试

1. `evaluateWindow`：window 未满不 qualified；正好 90% qualified；89% 不 qualified；`count < cards` 不 qualified。
2. 时钟回拨的 raw sample 被丢弃。
3. **stale sample**：`gen` 不匹配的 raw sample 不进入 window（对齐 `monitor-session.test.mjs` 的场景）。
4. `renderMessage`：单块、多块、超过 8 块、0 块。
5. `maskSpt` 不泄露原文。
6. push 重试：注入的前两次失败、第三次成功 → `ok = true`。
7. push 失败：`watch` 保留，`pushRetryAt` 约 60 秒后。
8. 配置校验：非法 SPT / 越界数字 → 400；脱敏占位符保留原值。
9. live session 中断超过 2 分钟：不 qualified、不清空 `watch`。
10. switch：`resetForTarget()` 后 window 清空，重连满 5 分钟才可能 push。

`package.json` 的 `test` 是 `node --test`，`test/*.test.mjs` 会被自动发现，无需改脚本。

---

## 12. 非目标与已知限制

- **app 必须活着**。关窗口仍采样；"退出"或电脑睡眠则不 push。
- 同一时刻只监控一个 target，watch 也只针对当前 target。
- MIG 模式下 `mem.total/used` 口径可能不直观，需在 README 标注。
- WxPusher 不可用时只能降级为系统通知。
- SPT 泄露 = 他人可向该微信发消息，吊销方式是重新扫码换 SPT。
- macOS 通知授权被关时，只能看面板状态。

---

## 13. 验收标准

1. 填 SPT → 点"发送测试 push" → 微信收到。
2. 占满 3 块 GPU、留 1 块 available → 5 分钟后收到 1 条，GPU index 与可用显存正确。
3. 收到后继续 available 30 分钟 → 不重复收到。
4. watch 中重启 app → 侧栏仍显示 watch 标记，且不会在启动瞬间误推。
5. 断网 push → 重试 3 次 → 系统通知"push 失败"，面板显示失败，watch 仍在。
6. switch 到另一个 target → window 清空，满 5 分钟后才可能 push；旧 target 的 stale sample 不参与判定。
7. `npm test` 全绿（含现有 4 个测试文件）。

---

## 14. 实施顺序

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | `notify.mjs` 纯逻辑 + `test/notify.test.mjs` | 判定与渲染可测 |
| P1 | 配置读写 + 5 个 API + `/api/state` 挂 `notify` | 可用 curl 驱动 |
| P2 | 侧栏按钮 + 弹窗 + watch 标记（含 `.rail-dot` 样式） | 可视化配置 |
| P3 | SPT push + 重试 + 系统通知兜底 | 端到端可用 |
| P4 | README + 迁移/睡眠/MIG 限制说明 | 可交付 |

估计：P0–P3 约 1 天，P4 约 1 小时。

---

## 15. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| app 退出 / 合盖 | 收不到 push | 面板提示；后续评估服务器端守护进程 |
| `minFreeGb` 默认 0 | 显存满但零算力的 GPU 误报 | 面板提示蹲余量时填真实值 |
| 抖动反复 qualified | 误报 | 90% window 容差 |
| 通知通道故障 | 漏报 | 重试 + 系统通知 + 面板状态 |
| SPT 明文落盘 | 泄露 | 0600 / Windows ACL、脱敏回显、日志不打印 |
| `onSample` 阻塞采样 | 采样间隔被拖长 | 内部异步、不 await、异常吞掉 |