# Codex CLI 用量并入 DSH 计费面板

`@kenz1117/dsh-ui-usage-billing` 只统计**经过 DSH 进程**的模型调用：它读
`~/.dsh/sessions/**/session.v4.jsonl.zstd`，折叠成按模型 / 按天 / 按站点的用量。
Codex CLI 是独立进程，只写自己的 `~/.codex/sessions/**/rollout-*.jsonl`，
所以 10-18 起面板里 `gpt-6.1-sol` 一直是 0。

这个目录放的是给插件打的本地补丁，把 Codex 侧的用量也折进同一个面板。

## 改了什么

`apply-codex-bridge.mjs` 对插件的 `lib/index.js` 做三处替换：

1. `node:fs/promises` 的 import 加上 `readdir`；
2. 在 `function createUsageAggregator(...)` 之前插入 `listCodexRollouts()` 与
   `foldCodexUsage()`：扫描 `~/.codex/sessions`，每份 rollout 文件取**最后一条**
   `token_count` 的累计 `total_token_usage`，构造一条 DSH 原生格式的事件
   `{type:"assistant/message", data:{usage, message:{source}}}`，交给插件自己的
   `foldInto()` 处理 —— 计价、站点归组（portdan → `site:https://portdan.com`）、
   按天分桶全部复用原逻辑，没有另写一套价格表；
3. 在 `aggregateOnce()` 汇总 `folds` 之前，把这份 fold 以虚拟会话
   `id="codex-cli"` 推进去。

`process.env.DSH_CODEX_USAGE === "0"` 时不并入（改完重启生效）。

## 口径说明

- **每份文件取最后一条 total，逐文件相加**。Codex 的 resume 会另起一个 rollout
  文件、从自己的 turn 重新累计（实测父文件 66434 / 子文件 9260），所以不能按
  `session_id` 去重 —— 那样会丢掉父文件那一段。
- `cached_input_tokens` 是 `input_tokens` 的子集，传给插件时拆成
  `inputTokens = input - cached` + `cacheReadTokens = cached`；
  `reasoning_output_tokens` 已含在 `output_tokens` 里，不另加。
- 时间归属用该文件**最后一条** `token_count` 的 UTC 时间戳，跨零点的会话会整段
  落在结束那天（误差通常只有几分钟到几十分钟）。

## 用法

```bash
# 打补丁（幂等：已打过会直接退出）
node D:/dsh/config/codex-usage-bridge/apply-codex-bridge.mjs

# 校验插件文件语法
node --input-type=module --check < "C:/Users/123/.dsh/profiles/desktop/node_modules/@kenz1117/dsh-ui-usage-billing/lib/index.js"

# 离线对账：按同一口径算期望费用
node D:/dsh/config/codex-usage-bridge/verify-offline.mjs
```

打完补丁**必须重启 DSH 桌面应用**：插件是 host 端模块，Node 不会重读已缓存的
`node_modules`。重启后刷新页面，卡片里的「今日消耗金额」和模型明细应出现
`gpt-6.1-sol` 的 Codex 部分。

原文件备份在插件目录下的 `lib/index.js.bak-codex-bridge`，回滚就是拷回去。

## 实测对账（2026-10-19）

面板 `/api/billing/usage-stats` 的 `byDayModels[日期]["gpt-6.1-sol"]` 与离线脚本逐日核对：

| 日期 | 离线脚本（Codex 侧） | 面板 gpt-6.1-sol | 说明 |
|---|---|---|---|
| 2026-10-17 | ¥49.31 | ¥95.26 | 面板还含当天 175 次 DSH 内测试调用（约 ¥45.96） |
| 2026-10-18 | ¥27.82 | ¥27.82 | 一致（27.81867421） |
| 2026-10-19 | ¥2.73 | ¥2.24 | 面板快照早于脚本，差的是脚本重跑前新增的那次会话 |

`cacheWrite` 必须按 input 单价计入：面板口径是
`input = cacheRead + inputTokens + cacheWrite`，即 `cacheMiss = (input - cached) + cacheWrite`。
漏掉它会让离线值比面板低约 3%（本次差 ¥2.26，全部来自 `cache_write_input_tokens`）。

## 升级插件后

插件升级会覆盖 `lib/index.js`，补丁随之丢失。升级后重跑一次
`apply-codex-bridge.mjs` 即可；如果新版改了上面三处锚点，脚本会报
`anchor "..." matched N times (expected 1)` 而不是静默写坏文件。

## 已知限制

- 只统计 `~/.codex/sessions` 下的 `rollout-*.jsonl`；Codex 的桌面 App、其它 CLI
  （如 Antigravity）用量不在这里。
- 面板「最近会话」里会多出一条叫 `codex-cli` 的虚拟会话，它的 cwd 显示为
  `~/.codex`。
- 扫描是每次聚合全量重读（125 个文件、约 20 MB 以内，实测亚秒级）。

## License

MIT。本仓库只提供「给插件打补丁的脚本」，不包含
`@kenz1117/dsh-ui-usage-billing` 的源代码；原插件版权归其作者所有。

- 上游插件：https://www.npmjs.com/package/@kenz1117/dsh-ui-usage-billing
