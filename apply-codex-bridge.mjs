/**
 * 给 @kenz1117/dsh-ui-usage-billing 打「Codex CLI 用量并入」补丁。
 *
 * 背景：该插件只从 DSH 的 ctx.sessionPersistence 读会话日志折叠用量；
 * Codex CLI 是独立进程，只写 ~/.codex/sessions/**\/rollout-*.jsonl，
 * 所以面板里 gpt-6.1-sol 从 10-18 起恒为 0。
 *
 * 做法：在 createUsageAggregator 的 aggregateOnce() 里、汇总 folds 之前，
 * 追加一个 id="codex-cli" 的虚拟会话 fold。事件按 DSH 原生
 * `assistant/message` 格式构造，交给插件自己的 foldInto 处理，从而复用
 * 它的全部计价 / 站点归组 / 按天分桶逻辑，不另写一套价格换算。
 *
 * 幂等：已含 MARK 时直接退出。可用环境变量 DSH_CODEX_USAGE=0 关掉。
 *
 * 升级提醒：插件升级会覆盖 lib/index.js，届时重跑本脚本即可。
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";

const TARGET = "C:/Users/123/.dsh/profiles/desktop/node_modules/@kenz1117/dsh-ui-usage-billing/lib/index.js";
const BACKUP = TARGET + ".bak-codex-bridge";
const MARK = "/* @codex-bridge */";
const MARK_END = "/* @codex-bridge-end */";

const FN = [
  MARK,
  "const CODEX_ROLLOUT_ROOT = join(homedir(), \".codex\", \"sessions\");",
  "async function listCodexRollouts(dir) {",
  "\tconst out = [];",
  "\tlet entries;",
  "\ttry {",
  "\t\tentries = await readdir(dir, { withFileTypes: true });",
  "\t} catch {",
  "\t\treturn out;",
  "\t}",
  "\tfor (const entry of entries) {",
  "\t\tconst full = join(dir, entry.name);",
  "\t\tif (entry.isDirectory()) out.push(...await listCodexRollouts(full));",
  "\t\telse if (entry.name.endsWith(\".jsonl\")) out.push(full);",
  "\t}",
  "\treturn out;",
  "}",
  "/**",
  "* 把 Codex CLI 的会话日志折成一份与 DSH 会话同构的 fold。",
  "* 每份 rollout 文件取最后一条 token_count 的累计值：Codex 的 resume 会另起",
  "* 一个新文件、从自己的 turn 起重新累计（实测父文件 66434 / 子文件 9260），",
  "* 所以逐文件相加即可；不能按 session_id 去重，否则会丢掉父文件那一段。",
  "* input_tokens 已含 cached_input_tokens（cached 是子集），这里拆成",
  "* inputTokens = input - cached + cacheReadTokens = cached，与 DSH 口径一致。",
  "* @returns fold；没有任何可用文件时返回 undefined。",
  "*/",
  "async function foldCodexUsage(subscriptionMatcher, officialProviderIds, routes, searchEstimate, routeAliases) {",
  "\tconst files = await listCodexRollouts(CODEX_ROLLOUT_ROOT);",
  "\tif (files.length === 0) return void 0;",
  "\tconst events = [];",
  "\tfor (const file of files) {",
  "\t\tlet text;",
  "\t\ttry {",
  "\t\t\ttext = await readFile(file, \"utf8\");",
  "\t\t} catch {",
  "\t\t\tcontinue;",
  "\t\t}",
  "\t\tlet provider;",
  "\t\tlet model;",
  "\t\tlet total;",
  "\t\tlet stamp;",
  "\t\tfor (const line of text.split(\"\\n\")) {",
  "\t\t\tif (line === \"\") continue;",
  "\t\t\tlet row;",
  "\t\t\ttry {",
  "\t\t\t\trow = JSON.parse(line);",
  "\t\t\t} catch {",
  "\t\t\t\tcontinue;",
  "\t\t\t}",
  "\t\t\tif (row.type === \"session_meta\") {",
  "\t\t\t\tif (typeof row.payload?.model_provider === \"string\") provider = row.payload.model_provider;",
  "\t\t\t} else if (row.type === \"turn_context\") {",
  "\t\t\t\tif (typeof row.payload?.model === \"string\") model = row.payload.model;",
  "\t\t\t} else if (row.type === \"event_msg\" && row.payload?.type === \"token_count\") {",
  "\t\t\t\tif (row.payload.info?.total_token_usage !== void 0) {",
  "\t\t\t\t\ttotal = row.payload.info.total_token_usage;",
  "\t\t\t\t\tstamp = row.timestamp;",
  "\t\t\t\t}",
  "\t\t\t}",
  "\t\t}",
  "\t\tif (total === void 0 || model === void 0) continue;",
  "\t\tconst time = typeof stamp === \"string\" ? Date.parse(stamp) : NaN;",
  "\t\tif (!Number.isFinite(time)) continue;",
  "\t\tconst cached = total.cached_input_tokens ?? 0;",
  "\t\tconst cacheWrite = total.cache_write_input_tokens ?? 0;",
  "\t\tevents.push({",
  "\t\t\ttype: \"assistant/message\",",
  "\t\t\ttime,",
  "\t\t\tdata: {",
  "\t\t\t\tusage: {",
  "\t\t\t\t\tinputTokens: Math.max(0, (total.input_tokens ?? 0) - cached),",
  "\t\t\t\t\tcacheReadTokens: cached,",
  "\t\t\t\t\tcacheWriteTokens: cacheWrite,",
  "\t\t\t\t\toutputTokens: total.output_tokens ?? 0",
  "\t\t\t\t},",
  "\t\t\t\tmessage: { source: { kind: \"model\", provider: provider ?? \"portdan\", model } }",
  "\t\t\t}",
  "\t\t});",
  "\t}",
  "\tif (events.length === 0) return void 0;",
  "\tconst fold = freshFold();",
  "\tconst machine = freshMachine();",
  "\tfoldInto(fold, machine, events, subscriptionMatcher, officialProviderIds, routes, searchEstimate, 0, routeAliases);",
  "\trefreshTurns(fold, machine);",
  "\treturn fold;",
  "}",
  MARK_END,
  ""
].join("\n");

const INJECT = [
  "\t\t// @codex-bridge Codex CLI 用量并入（DSH_CODEX_USAGE=0 关闭）",
  "\t\tif (process.env.DSH_CODEX_USAGE !== \"0\") {",
  "\t\t\ttry {",
  "\t\t\t\tconst codexFold = await foldCodexUsage(subscriptionMatcher, officialProviderIds, roundRoutes, searchEstimate, routeAliases);",
  "\t\t\t\tif (codexFold !== void 0) {",
  "\t\t\t\t\tfolds.push({ id: \"codex-cli\", cwd: join(homedir(), \".codex\"), fold: codexFold });",
  "\t\t\t\t\tincluded.add(\"codex-cli\");",
  "\t\t\t\t}",
  "\t\t\t} catch (error) {",
  "\t\t\t\tconsole.warn(\"[usage-billing] codex bridge skipped:\", error);",
  "\t\t\t}",
  "\t\t}",
  "\t\t" + MARK_END,
  ""
].join("\n");

const IMPORT_OLD = "import { lstat, mkdir, readFile, rm, stat } from \"node:fs/promises\";";
const IMPORT_NEW = "import { lstat, mkdir, readdir, readFile, rm, stat } from \"node:fs/promises\";";
const AGG_ANCHOR = "function createUsageAggregator(persistence, options = {}) {";
const TOTAL_ANCHOR = "\t\tconst total = emptyUsage();";

let src = await readFile(TARGET, "utf8");
if (src.includes(MARK)) {
  console.log("already patched; nothing to do");
  process.exit(0);
}

function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`anchor "${label}" matched ${count} times (expected 1)`);
  return text.replace(from, to);
}

let next = replaceOnce(src, IMPORT_OLD, IMPORT_NEW, "fs import");
next = replaceOnce(next, AGG_ANCHOR, FN + "\n" + AGG_ANCHOR, "createUsageAggregator");
next = replaceOnce(next, TOTAL_ANCHOR, INJECT + TOTAL_ANCHOR, "total = emptyUsage()");

await copyFile(TARGET, BACKUP);
await writeFile(TARGET, next, "utf8");
console.log("patched:", TARGET);
console.log("backup:", BACKUP);
console.log("bytes:", src.length, "->", next.length);
