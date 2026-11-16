# Daily Usage

独立的 Codex++ tweak，按北京时间查看今天、最近 7 天、最近 30 天的 Token 和 API 等值美元。
包含本机及本窗口打开过的 Remote Control 机器，按日期和模型拆分。
版本 0.1.2；最低 Codex++ 1.0.10。无需启用 Session Stats，也不会修改它。

## 安装和使用

推荐在 **Codex++ Settings → Tweak Store** 搜索 **Daily Usage** 并安装。
运行时无 npm 依赖，安装后打开 Codex 设置中的 Daily Usage 页面。

也可以从 [GitHub Release v0.1.2](https://github.com/kpkhxlgy0/daily-usage/releases/tag/v0.1.2)
下载 `daily-usage-0.1.2.zip`，解压到长期保留的目录。
Windows 已安装 Codex++ 时，在解压目录运行：

```powershell
pwsh -File .\Inject-CodexPlusPlus.ps1 -CheckOnly
pwsh -File .\Inject-CodexPlusPlus.ps1
```

打开 Codex 设置中的 **Daily Usage** 页面查看统计。
该版本恢复原有统计设置页，并移除会错误复制整条原生竖栏的主侧栏快捷入口。
首次扫描可能需要几分钟，完成后自动显示；启用期间每分钟更新，面板每 5 秒读取状态。
如果安装后入口尚未出现，重新启动 Codex。统计不调用模型 API。

机器选择默认本机。要查看远程机器，先在本窗口打开该机器上的一条普通会话，
等待约 5 秒后再打开 Daily Usage。列表显示远程连接 ID，不保证是操作系统机器名。
运行端也必须安装并启用 Daily Usage，且 Codex 应用需要运行。
只有查看端安装时无法获得远程机器统计；这里不会自动安装远程组件。

禁用可在 Tweaks 中完成，或运行：

```powershell
pwsh -File .\Uninject-CodexPlusPlus.ps1
```

Uninject 只禁用本 tweak，并移除指向当前源码的开发链接；保留源码、缓存和其他 tweaks。
Store 安装副本只会禁用，不删除。脚本使用 `CODEX_PLUSPLUS_HOME`，未设置时使用 `%APPDATA%/codex-plusplus`。

## 数字表示什么

- 日期为 Asia/Shanghai；今天包含当日截至最后扫描的请求，7/30 天均包含今天。
- 输入总量包含普通输入、缓存读取和缓存写入。总 Token = 输入 + 输出；推理已在输出中，不再相加。
- 使用逐响应的实际用量，按 `response_id` 跨日志去重；原生子代理单独扫描后并入总量。
- 费用统计保留已经发生、后来被回退或移出上下文的请求。复制到分叉、归档或压缩副本的同一请求只计一次。
- 旧日志缺少响应 ID 时使用保守累计增量，显示“估算”。无法明确归属的前缀、混用旧新格式、损坏或缺失日志会显示覆盖缺口。
- 未知模型、缓存写入保留时间缺失等情况保留 token，并显示未定价请求。美元为能够定价部分的合计。
- 只反映此机器当前 CODEX_HOME 保留的日志；不能恢复已删除、未同步的云端或另一台机器的数据。
- 多台机器分别查看，第一版不把多台机器直接相加，避免跨机器复制日志造成重复计费。

## API 等值价格

采用 **2026-11-16 的公开 Standard API 价格**，对当日请求按模型定价，并按单次请求处理长上下文费率。
这是“这些 token 按该价格表值多少美元”，不是历史发票复原或 Codex 订阅账单。
日志未完整记录服务档位，因此不声称计算了实际 Fast、Flex、Ultrafast 或企业合同费用。
历史日期也使用这张价格表；更新价格表需更新 tweak。

已核实模型：GPT-6 Astra、GPT-6.1 Sol/Terra、GPT-6 Luna/Sol、GPT-5.6 Sol/Terra/Luna、GPT-5.5、GPT-5.4。
未知 ID 不猜测为相似模型；缓存写入不能重复按普通输入计费。超过 272,000 输入 token 的请求采用对应长上下文费率。
不含图像生成、搜索等工具单独费用，也不含区域溢价、税费或折扣。

来源：[官方价格表](https://developers.openai.com/api/docs/pricing)、
[缓存计费](https://developers.openai.com/api/docs/guides/prompt-caching)、
[GPT-6.1 Sol 长上下文规则](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。

## 数据和远程协议

只读 `$CODEX_HOME/sessions` 和 `archived_sessions`；未设置时读取 `~/.codex`。
支持 JSONL 和原生 Zstd 压缩历史。压缩读取需要运行时 Node >=22.15 的原生 Zstd；不支持时报告覆盖缺口。
解析在 worker 中完成，复用没有变化的文件缓存，不将原始聊天正文写进缓存。

运行端写入 `$CODEX_HOME/.daily-usage/machine.json` 和 `summary.json`。
汇总仅含机器/发布者 ID、时间、按日期模型的 token 和美元、覆盖状态；不含聊天正文或认证信息。
缓存位于 Codex++ `tweak-data/com.kpk.daily-usage/cache`。禁用会结束 worker、计时器、IPC 和未完成的远程读取。

查看端通过当前 Codex RC 连接读取固定汇总文件，不下载远程原始会话日志。
超过 3 分钟未更新或连接失败时，显示最后成功缓存和原时间；未读到数据时显示暂无统计，不能当成零消耗。
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
版本：[v0.1.2](https://github.com/kpkhxlgy0/daily-usage/releases/tag/v0.1.2)。
本机功能及原生压缩日志已验证；远程协议有自动化测试，真实双机 Remote Control 联调尚未完成。

MIT；复用模块及来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
