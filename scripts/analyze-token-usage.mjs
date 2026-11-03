// ============================================================================
//  トークン数と費用の集計(2026年11月3日。docs/token-usage-20261103.md)
//
//  scripts/test-api-path.mjs の結果(turns[].calls・memory.calls。src/token-usage.mjs の台帳)を、
//  呼び出しの種類ごと・会話ごとに合計し、有料の単価で費用にする。モデルは呼ばない。本文は表示しない。
//
//  実行: node scripts/analyze-token-usage.mjs <結果の .jsonl> [...] [--json=<書き出し先>]
//
//  単価(USD / 100万トークン。Standard。2026年11月3日に https://aistudio.google.com/docs/pricing で確かめた。
//  2026年12月31日までの値。2027年1月1日から 3.8/3.6-flash は入力・出力・キャッシュとも2倍になる)。
//  思考のトークンは出力の単価で課金される(同じページ「Output price (including thinking tokens)」)。
//  gemini-3.7-flash と gemini-3.5-flash は公式の表に無い(3.5-flash の中身は 3.6-flash)。同じ世代の 3.8/3.6-flash と同じ単価と仮に置く。
// ============================================================================
import fs from "node:fs";

export const PRICES_USD_PER_M = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cached: 0.075, assumed: true },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash": { input: 0.75, output: 3.75, cached: 0.075, assumed: true },
  "gemini-3.5-flash-lite": { input: 0.30, output: 2.50, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.50, cached: 0.025 },
};
// 円にするときの仮の為替(1ドル = 150円。費用の桁を見るためだけ)
export const JPY_PER_USD = 150;

export function costUsd(model, u) {
  const p = PRICES_USD_PER_M[model];
  if (!p || !u) return 0;
  const uncached = Math.max(0, (u.prompt ?? 0) - (u.cached ?? 0));
  return (uncached * p.input + (u.cached ?? 0) * p.cached + ((u.output ?? 0) + (u.thoughts ?? 0)) * p.output) / 1e6;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.slice(7);
const empty = () => ({ calls: 0, ok: 0, prompt: 0, output: 0, thoughts: 0, cached: 0, usd: 0 });
const add = (b, c) => {
  b.calls++;
  if (c.ok) b.ok++;
  for (const k of ["prompt", "output", "thoughts", "cached"]) b[k] += c.usage?.[k] ?? 0;
  b.usd += costUsd(c.model, c.usage);
};

// 見積もり(--fill-from=<無料枠の実測の .jsonl> --regen-rate=0.1):
//  模擬の返事で流した結果(--model=mock。入力は文字数からの見積もり・出力と思考は 0)の、出力と思考を、実測の種類ごとの平均で埋める。
//  模擬の返事は作り直しを人工的に多く起こすので、--regen-rate を渡したら、模擬の作り直しを外し、生成1回につき
//  その割合の作り直し(入力は同じ生成の 1.04 倍。修正指示の分)を足す
const fillFrom = process.argv.find((a) => a.startsWith("--fill-from="))?.slice(12);
const regenRate = Number(process.argv.find((a) => a.startsWith("--regen-rate="))?.slice(13) ?? NaN);
let fill = null;
if (fillFrom) {
  const acc = {};
  for (const line of fs.readFileSync(fillFrom, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    for (const c of [...r.turns.flatMap((t) => t.calls ?? []), ...(r.memory?.calls ?? [])]) {
      if (!c.ok || !c.usage) continue;
      const k = c.label.startsWith("regen") || c.label === "generate_retry" ? "generate" : c.label;
      const a = (acc[k] ??= { n: 0, output: 0, thoughts: 0 });
      a.n++; a.output += c.usage.output; a.thoughts += c.usage.thoughts;
    }
  }
  fill = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { output: a.output / a.n, thoughts: a.thoughts / a.n, n: a.n }]));
  console.log("実測の平均(埋める値):", Object.entries(fill).map(([k, v]) => `${k} 出力${Math.round(v.output)}/思考${Math.round(v.thoughts)}(${v.n}回)`).join(" / "));
}
function filled(calls) {
  if (!fill) return calls;
  let out = calls.map((c) => {
    if (!c.ok || !c.usage || c.usage.output || c.usage.thoughts) return c;
    const k = c.label.startsWith("regen") || c.label === "generate_retry" ? "generate" : c.label;
    const f = fill[k] ?? fill.classifier;
    return { ...c, usage: { ...c.usage, output: Math.round(f.output), thoughts: Math.round(f.thoughts) } };
  });
  if (Number.isFinite(regenRate)) {
    out = out.filter((c) => !c.label.startsWith("regen"));
    for (const c of out.filter((x) => x.label === "generate" && x.ok)) {
      out.push({ ...c, label: "regen_est", usage: { ...c.usage, prompt: c.usage.prompt * 1.04 * regenRate, output: c.usage.output * regenRate, thoughts: 0 } });
    }
  }
  return out;
}

const byLabel = {};
const convs = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    const conv = { name: r.name, staged: r.staged ?? null, turns: r.turns.length, total: empty(), by: {}, failedTurns: 0, generated: 0 };
    const all = filled([...r.turns.flatMap((t) => t.calls ?? []), ...(r.memory?.calls ?? [])]);
    for (const c of all) {
      add(conv.total, c);
      add((conv.by[c.label] ??= empty()), c);
      add((byLabel[c.label] ??= empty()), c);
    }
    // 生成の失敗(固定の一言で継続)のターン。費用が実際より小さく出る(無料枠の混雑)
    conv.failedTurns = r.turns.filter((t) => (t.flags ?? []).some((x) => String(x).startsWith("生成失敗"))).length;
    conv.generated = r.turns.filter((t) => (t.calls ?? []).some((c) => c.ok && c.label.startsWith("generate"))).length;
    convs.push(conv);
  }
}

const R = Math.round;
const fmt = (b) => `${b.calls}回(成功 ${b.ok})入力 ${R(b.prompt)} / 出力 ${R(b.output)} / 思考 ${R(b.thoughts)} / キャッシュ ${R(b.cached)} / $${b.usd.toFixed(4)}(${(b.usd * JPY_PER_USD).toFixed(2)}円)`;
console.log("== 呼び出しの種類ごと(成功した1回あたりの平均)");
for (const [k, b] of Object.entries(byLabel).sort()) {
  const n = b.ok || 1;
  console.log(`  ${k.padEnd(20)} ${fmt(b)}`);
  console.log(`  ${"".padEnd(20)} 平均: 入力 ${Math.round(b.prompt / n)} / 出力 ${Math.round(b.output / n)} / 思考 ${Math.round(b.thoughts / n)} / $${(b.usd / n).toFixed(5)}`);
}
console.log("\n== 会話ごと");
for (const c of convs) {
  console.log(`  ${c.name}(段階ごとの応答 ${c.staged ? "有効" : "無効"}・${c.turns}ターン・生成できたターン ${c.generated}・生成の失敗 ${c.failedTurns})`);
  console.log(`    合計 ${fmt(c.total)}`);
  for (const [k, b] of Object.entries(c.by).sort()) console.log(`      ${k.padEnd(20)} ${fmt(b)}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ prices: PRICES_USD_PER_M, jpy_per_usd: JPY_PER_USD, by_label: byLabel, conversations: convs }, null, 2) + "\n");
