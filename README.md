# Daily Usage

独立的 Codex++ tweak，可查看今天、最近 7 天、最近 30 天的用量，并对比最近四轮周额度。时间均为北京时间。
包含本机及本窗口打开过的 Remote Control 机器，按日期和模型拆分。
本机显示“本机”；只有一台远程机器时显示“远程”，多台时优先显示 Codex 中的连接名称。
离线保留上次名称，未识别名称时显示连接 ID。
源码版本为 0.4.0，最低支持 Codex++ 1.0.10。Daily Usage 可独立使用。

## 安装和使用

推荐在 **Codex++ Settings → Tweak Store** 搜索 **Daily Usage** 并安装。
运行时无 npm 依赖，安装后打开 Codex 设置中的 Daily Usage 页面。

也可以从 [GitHub Releases](https://github.com/kpkhxlgy0/daily-usage/releases) 下载对应版本的压缩包，解压到长期保留的目录。
Windows 已安装 Codex++ 时，在解压目录运行：

```powershell
pwsh -File .\Inject-CodexPlusPlus.ps1 -CheckOnly
pwsh -File .\Inject-CodexPlusPlus.ps1
```

打开 Codex 设置中的 **Daily Usage** 页面查看统计。
打开页面、切换机器或点击刷新时，各查询一次；切换日期范围只筛选已返回的数据。
页面打开期间也不会定时刷新。首次查询可能需要几分钟，完成后自动显示。
离开、隐藏或关闭页面会取消当前查询；再次打开页面重新查询。
启用 tweak 不会扫描日志或创建统计 worker，本机和远程都没有后台轮询。
如果安装后入口尚未出现，重新启动 Codex。统计不调用模型 API。

机器选择默认本机。要查看远程机器，先在本窗口打开该机器上的一条普通会话，
再打开 Daily Usage。机器识别由会话和导航事件触发，没有定时检查。
多台远程机器时用连接名称或连接 ID 区分，不保证是操作系统机器名。
远程查看时，两端的 Daily Usage 需要使用同一版价格表，运行端的 Codex 应用需要运行。
0.1.3 以前的运行端仍使用旧的后台更新机制，需在那台机器上更新后才会停止。
只有查看端安装时无法获得远程机器统计；这里不会自动安装远程组件。

禁用可在 Tweaks 中完成，或运行：

```powershell
pwsh -File .\Uninject-CodexPlusPlus.ps1
```

Uninject 只禁用本 tweak，并移除指向当前源码的开发链接；保留源码、缓存和其他 tweaks。
Store 安装副本只会禁用，不删除。脚本使用 `CODEX_PLUSPLUS_HOME`，未设置时使用 `%APPDATA%/codex-plusplus`。

## 数字表示什么

### 周额度历史

在时间下拉框选择「周额度历史」。每行一个模型，四列显示本轮和最近三个有重置记录的其他周期。各列标明实际日期，不同额度窗口可能重叠，历史记录也可能间断。点列标题可查看整轮明细。

运行端读取七天额度的重置时间，按每条去重请求的原始时间归入周期。时间重叠时，运行端用同一会话和轮次的请求用量、累计计数及相邻额度快照核对归属。每个请求只计一次。缺乏可靠证据的请求列入「未归属周期」。

主表显示整轮金额，本轮统计到查询时刻。点开明细可查看首次观测到 100% 时累计的用量及此后发生的用量。额度百分比属于账号，金额覆盖这台机器留存的请求。实际 credits 扣减以账户账单为准。四轮、较早周期和未归属周期加起来，等于最近 30 天日报的请求数和金额。

远程查看需要两端都使用 0.4.0 或更新的兼容版本。报告超过传输上限时显示提示。

### 按日期统计

- 日期为 Asia/Shanghai；今天包含当日截至最后扫描的请求，7/30 天均包含今天。
- 输入总量包含普通输入、缓存读取和缓存写入。总 Token = 输入 + 输出；推理已在输出中，不再相加。
- 使用逐响应的实际用量，按 `response_id` 跨日志去重；原生子代理单独扫描后并入总量。
- 费用统计保留已经发生、后来被回退或移出上下文的请求。复制到分叉、归档或压缩副本的同一请求只计一次。
- 旧日志缺少响应 ID 时使用保守累计增量，显示“估算”。无法明确归属的前缀、混用旧新格式、损坏或缺失日志会显示覆盖缺口。
- 未知模型等无法定价的情况保留 token，并显示未定价请求。费用估算（USD）为能够定价部分的合计。
- 只反映此机器当前 CODEX_HOME 保留的日志；不能恢复已删除、未同步的云端或另一台机器的数据。
- 多台机器分别查看，第一版不把多台机器直接相加，避免跨机器复制日志造成重复计费。

## 费用估算（USD）

日报与周报使用 **2026-11-18** 的公开 Standard API 价格。先按模型、单次请求的上下文长度和缓存保留时长计价，再汇总金额。费用估算仅覆盖有价格依据的模型 Token 用量。
日志未完整记录服务档位，因此不声称计算了实际 Fast、Flex、Ultrafast 或企业合同费用。
历史日期也使用这张价格表；更新价格表需更新 tweak。

GPT-6.2 的基础单价如下，单位为美元／百万 Token。

| 模型 | 普通输入 | 缓存读取 | 输出 |
| --- | ---: | ---: | ---: |
| GPT-6.2 Sol | 2.00 | 0.10 | 10.00 |
| GPT-6.2 Astra | 8.00 | 0.40 | 40.00 |

还支持 GPT-6 Astra、GPT-6.1 Sol/Terra、GPT-6 Luna/Sol、GPT-5.6 Sol/Terra/Luna、GPT-5.5、GPT-5.4。
未知模型保留 Token 并标记未定价。普通输入、缓存读取和缓存写入分别计价，每个 Token 只归入一项。
适用长上下文阶梯的请求超过 272,000 个输入 token 时，整笔输入与缓存按 2 倍、输出按 1.5 倍计价。
有公开写入价格的模型按日志记录的缓存保留时长计价：30 分钟为普通输入价的 1.25 倍，12 小时为 2.5 倍。缺少时长时按 30 分钟估算。
没有公开缓存写入价格时，仍计入其他可定价的输入和输出，并标出未定价部分。
不含图像生成、搜索等工具单独费用，也不含区域溢价、税费或折扣。

来源：[官方价格表](https://developers.openai.com/api/docs/pricing)、
[缓存计费](https://developers.openai.com/api/docs/guides/prompt-caching)。

## 数据和远程协议

只读 `$CODEX_HOME/sessions` 和 `archived_sessions`；未设置时读取 `~/.codex`。
支持 JSONL 和原生 Zstd 压缩历史。压缩读取需要运行时 Node >=22.15 的原生 Zstd；不支持时报告覆盖缺口。
解析在 worker 中完成，复用没有变化的文件缓存，不将原始聊天正文写进缓存。
下次按需查询会根据保留的日志重建缺少额度关联的旧解析缓存，并统一重算金额。清空缓存和后台扫描均非必需。

运行端写入 `$CODEX_HOME/.daily-usage/machine.json` 和 `summary.json`，
并使用同目录的 `capabilities.json`、`capabilities-v4.json`、`requests/` 和 `responses/` 处理按需查询。
汇总包含机器和发布者 ID、时间、每日各模型用量、周额度采样边界、模型金额及覆盖状态。周视图只传聚合数值。
缓存位于 Codex++ `tweak-data/com.kpk.daily-usage/cache`。禁用会结束 worker、文件监听、IPC 和未完成的查询。

远程机器读取自己的日志并完成计算；查看端通过当前 Codex RC 连接发送固定格式的查询/取消标记，
使用原生文件变更通知等待汇总结果，不下载远程原始会话日志，也不定时读取响应。
运行端空闲时只保留操作系统的文件事件监听，收到请求才启动统计。
页面离开后会发送取消标记；如果连接已断开，运行端依靠最长 5 分钟的请求期限结束遗留任务。
不支持按需协议或原生文件通知时提示更新，不回退到轮询。
查询失败时保留最后成功缓存和原时间；未读到数据时显示暂无统计，不能当成零消耗。
机器列表基于实际打开过的会话，不是所有在线主机列表。远程协议依赖 Codex 内部桥接，应用升级可能需要适配。

## 开发和验证

```powershell
npm ci
npm test
npm run validate
npm run install:local
```

只在开发和测试需要 jsdom；运行时无 npm 依赖。`validate`/`install:local` 默认使用同级规范
`../codex-plusplus` checkout，可通过 `CODEX_PLUSPLUS_SOURCE` 指定。

命令行读取本机最近 30 天报告：

```powershell
node scripts/report.cjs
```

CLI 输出 JSON；默认缓存写到所选 CODEX_HOME 的 `.daily-usage/cache`，可用 `--cache PATH` 指定。
只读原日志，但会写自己的统计缓存。

源码：[kpkhxlgy0/daily-usage](https://github.com/kpkhxlgy0/daily-usage)。
已发布版本见 [GitHub Releases](https://github.com/kpkhxlgy0/daily-usage/releases)。
本机功能及原生压缩日志已验证；按需协议已通过双端文件系统自动化测试，
0.1.3 的真实双机 Remote Control 通知与取消链路尚待安装更新后验证。

MIT；复用模块及来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
