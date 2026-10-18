/**
 * 离线对账：按插件补丁同一套口径（每个 rollout 文件取最后一条
 * total_token_usage，逐文件相加）算出 Codex 侧的用量与费用期望值。
 *
 * 价格与插件内置 catalog 一致：gpt-6.1-sol input $2/M、cacheHit $0.1/M、
 * output $10/M，USD→CNY 6.686。仅用于和 /api/billing/usage-stats 对账。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".codex", "sessions");
const USD_CNY = 6.686;
const PRICE = { "gpt-6.1-sol": { input: 2, cacheHit: 0.1, output: 10 } };

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const byDayModel = new Map();
let files = 0;
let usable = 0;

for (const file of await walk(ROOT)) {
  files += 1;
  const text = await readFile(file, "utf8");
  let provider;
  let model;
  let total;
  let stamp;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "session_meta") provider = row.payload?.model_provider ?? provider;
    else if (row.type === "turn_context" && typeof row.payload?.model === "string") model = row.payload.model;
    else if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      total = row.payload.info.total_token_usage;
      stamp = row.timestamp;
    }
  }
  if (!total || !model || !stamp) continue;
  usable += 1;
  const time = Date.parse(stamp);
  if (!Number.isFinite(time)) continue;
  const d = new Date(time);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const key = `${day}|${model}|${provider ?? "?"}`;
  const cell = byDayModel.get(key) ?? { calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0 };
  cell.calls += 1;
  cell.input += total.input_tokens ?? 0;
  cell.cached += total.cached_input_tokens ?? 0;
  cell.cacheWrite += total.cache_write_input_tokens ?? 0;
  cell.output += total.output_tokens ?? 0;
  byDayModel.set(key, cell);
}

console.log(`files=${files} usable=${usable}`);
let grand = 0;
for (const [key, cell] of [...byDayModel].sort()) {
  const [day, model, provider] = key.split("|");
  const price = PRICE[model];
  const miss = cell.input - cell.cached;
  const usd = price ? (miss / 1e6) * price.input + (cell.cached / 1e6) * price.cacheHit + (cell.output / 1e6) * price.output : 0;
  grand += usd * USD_CNY;
  console.log(
    `${key.padEnd(40)} calls=${String(cell.calls).padStart(3)} input=${(cell.input / 1e6).toFixed(2)}M ` +
      `cached=${(cell.cached / 1e6).toFixed(2)}M cw=${(cell.cacheWrite / 1e6).toFixed(3)}M ` +
      `output=${(cell.output / 1e3).toFixed(0)}K  ≈¥${(usd * USD_CNY).toFixed(2)}`
  );
}
console.log(`TOTAL ≈ ¥${grand.toFixed(2)}`);
