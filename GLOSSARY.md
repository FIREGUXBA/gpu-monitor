# GPU Monitor

一个本地运行的 GPU 监控面板：通过 SSH 读一台远端 Linux 机器的 `nvidia-smi`，把显卡负载、显存和持有显存的任务呈现出来。网页版与 Electron 桌面版共用同一套语言。

## 目标

**target**:
被监控的那台远端 Linux 机器。它同时是采样对象、历史的归属单位和界面标题所指的东西。
_Avoid_: host, server, machine, node

**target key**:
唯一确定一个 **target** 的字符串，也决定它的采样历史存在哪里。password 模式下由登录用户名、地址和端口组成；system-ssh 模式下由 SSH 别名组成。
_Avoid_: target, host, connection id

**target label**:
**target** 给人看的显示名，用于界面标题和日志。
_Avoid_: target, host

**remote hostname**:
远端 `hostname` 命令的输出，只用于显示，不参与任何身份判断。同一个 **target** 的 remote hostname 可能变化，两个 **target** 也可能有相同的 remote hostname。
_Avoid_: host, target

## 连接

**system-ssh mode**:
一种连接方式：调用本机的 `ssh`，由它自己决定用什么认证——密钥、ssh-agent，或 ssh 配置里别的安排。界面上称为「免密」。
_Avoid_: key mode, key auth, passwordless, 免密登录方式

**password mode**:
一种连接方式：由应用自己持有一条 SSH 连接，用保存的密码认证，并核对远端主机指纹。
_Avoid_: ssh2 mode, direct mode

**saved connection**:
持久化到磁盘的连接配置，应用重启后仍在。它决定启动时连哪里，不代表此刻已经连上。
_Avoid_: connection, config, login

**live session**:
此刻实际存在的 SSH 连接和采样循环。断开后 **saved connection** 仍然存在。
_Avoid_: connection, active connection

**switch**:
把一个 **target** 换成另一个，并作废所有属于旧 **target** 的采样、错误和图表数据。
_Avoid_: login, reconnect, change target

**login user**:
用于 SSH 认证的身份，只有 password 模式才知道它。它和 **owner** 是两个不相干的概念。
_Avoid_: user, account

## 采样

**raw sample**:
对 **target** 的一次完整读取，是历史的原子单位。
_Avoid_: sample, tick, poll

**snapshot**:
最近一次成功的 **raw sample**，加上 CUDA 版本、运行时长和采集时刻，用于渲染当前界面。
_Avoid_: state, status, data

**series**:
某个指标在内存中按时间顺序排列的取值，每块 **GPU**、每项指标各一条。
_Avoid_: history, data

**window**:
把 **series** 按时间范围取出、并降采样到目标点数后的结果，供图表使用。它的时间步长可能远大于采样间隔，所以相邻两点不代表相邻的两次 **raw sample**。
_Avoid_: history, range, chart data

**stale sample**:
属于旧 **target** 的 **raw sample** 或 **snapshot**。一次 **switch** 之后它们不能再出现在界面上。
_Avoid_: old data, dirty data

## 显卡与负载

**GPU**:
**target** 上的一块 NVIDIA 计算卡，由 nvidia-smi 报告的 UUID 唯一标识。
_Avoid_: card, device

**GPU index**:
**GPU** 在 **target** 上从 0 开始的序号，用于界面排序和历史数组的下标。它是位置，不是身份：卡序变化后同一个 index 可能指向另一块卡。
_Avoid_: gpu id, gpu number

**run task**:
在 **target** 上占用某块 **GPU** 显存的进程，身份是 PID 与启动时刻的组合。同一条命令跑两次是两个 **run task**。
_Avoid_: process, job, workload, 进程

**owner**:
**run task** 所属的远端系统用户。
_Avoid_: user, account

## 通知

**available GPU**:
当前 **target** 上利用率与可用显存都达到 **watch** 要求的一块 **GPU**。它是判定余量的最小单位，不等于整台机器空闲。
_Avoid_: idle card, free card, 空闲卡

**watch**:
用户的一次性意图：至少 N 块 **available GPU**，每块可用显存不低于 X GB。它属于当前安装，不属于任何 **target key**；一次 **switch** 不清除它。界面上称为「蹲守」。
_Avoid_: subscription, alert, rule, 订阅, 盯盘

**watch window**:
判定 **watch** 是否 **qualified** 的时间窗，默认 5 分钟。窗内数据不足时不下结论。
_Avoid_: 观察期, 滑动窗口

**qualified**:
**watch window** 内至少 90% 的 **raw sample** 显示 **available GPU** 数达到 **watch** 的要求。它是 **push** 的唯一触发条件。
_Avoid_: idle, 空闲, 达标

**push**:
通过 **notification channel** 向用户发出一条消息。一次 **qualified** 最多产生一次成功的 **push**。
_Avoid_: 告警, 报警, 推送任务

**notification channel**:
承载 **push** 的通道。本期只有 WxPusher 极简推送。
_Avoid_: webhook, bot, 推送服务

**SPT**:
WxPusher 极简推送令牌，以 `SPT_` 开头，是用户级凭据，敏感程度等同密码。
_Avoid_: token, key, appToken