// ============================================================================
//  生成の失敗の内訳(2026年11月4日。docs/generation-format-error-20261104.md 第1部)
//
//    node scripts/analyze-generation-failures.mjs <test-api-path の --out の .jsonl>... [--out=<まとめ.txt>]
//
//  画面と同じ経路の再生の記録(stored の flags・failure)から、生成の失敗を種類(形の崩れ・長さの上限・安全フィルター・429・混雑・
//  時間切れ・そのほか)と場面(危機のあと・気がかり・第三者・危機の状態の生成・インテーク・通常)ごとに数える。
//  2026年11月4日より前の記録には failure(18節)が無いので、印(生成失敗→…・失敗の詳細)から種類を推定する。
//  新しい記録(failure がある)では、終わった理由(finishReason)・入力トークン・出力の上限・AI が返した出力の長さも数える。
//  保留セットの記録は読まない(調整に使わない決まり。ファイル名に holdout を含むものは飛ばす)。
// ============================================================================
import fs from "node:fs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--") && !/holdout/.test(a));
const outPath = (args.find((a) => a.startsWith("--out=")) ?? "").slice(6);

// 古い印の種類の名前 → 新しい種類の名前
const OLD_KIND = [
  [/レート制限|429|RATE_LIMIT/, "利用上限(429)"], [/過負荷|503/, "混雑(503)"], [/時間切れ|TIMEOUT/, "時間切れ"],
  [/応答形式|JSONとして読み取れ/, "形の崩れ"], [/ブロック|SAFETY|BLOCKED/, "安全フィルター"], [/MAX_TOKENS|長さの上限/, "長さの上限"],
];
const kindOfText = (t) => OLD_KIND.find(([re]) => re.test(t))?.[1] ?? "そのほか";
const sceneOf = (flags) => {
  const s = flags.join("\n");
  const m = s.match(/場面の一言\((\w+)・/) ?? s.match(/生成の失敗の内訳: [^(]+\((\w+)・/);
  if (m) return m[1];
  if (/危機の状態の生成→固定の返事/.test(s)) return "crisisGeneration";
  return "通常(固定応答で継続)";
};

const total = { files: 0, runs: 0, aiReplies: 0, failedTurns: 0 };
const byKind = {}, byScene = {}, byKindScene = {}, finish = {}, details = {};
const tokens = [];
const add = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
for (const f of files) {
  total.files++;
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    total.runs++;
    for (const m of r.stored ?? []) {
      if (m.role === "ai") total.aiReplies++;
      const flags = (m.flags ?? []).map(String);
      const recs = Array.isArray(m.failure) ? m.failure : [];
      if (recs.length) {
        for (const rec of recs) for (const x of rec.failures ?? []) {
          add(byKind, x.kind ?? "そのほか"); add(byScene, rec.scene ?? "?"); add(byKindScene, `${x.kind}|${rec.scene}`);
          add(finish, x.finishReason ?? "(なし)");
          if (x.promptTokens != null) tokens.push({ scene: rec.scene, prompt: x.promptTokens, out: x.outputTokens, max: x.maxOutputTokens, raw: x.rawLength });
        }
        total.failedTurns++;
        continue;
      }
      const failFlag = flags.find((x) => /^生成失敗→|^危機の状態の生成→固定の返事で継続\(生成失敗/.test(x));
      if (!failFlag) continue;
      total.failedTurns++;
      const detail = flags.find((x) => x.startsWith("失敗の詳細")) ?? failFlag;
      const kind = /不明なエラー/.test(failFlag) ? kindOfText(detail) : kindOfText(failFlag);
      const scene = sceneOf(flags);
      add(byKind, kind); add(byScene, scene); add(byKindScene, `${kind}|${scene}`);
      if (kind === "そのほか") add(details, detail.replace(/\s+/g, " ").slice(0, 120));
    }
  }
}
const lines = [];
const p = (s = "") => lines.push(s);
const tbl = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n");
p("生成の失敗の内訳(画面と同じ経路の再生の記録)");
p(`読んだファイル ${total.files} / 会話 ${total.runs} / AI の返事の行 ${total.aiReplies} / 生成に失敗したターン ${total.failedTurns}`);
p(""); p("■ 種類ごと"); p(tbl(byKind));
p(""); p("■ 場面ごと"); p(tbl(byScene));
p(""); p("■ 種類×場面"); p(tbl(byKindScene));
if (Object.keys(finish).length) { p(""); p("■ 終わった理由(新しい記録だけ)"); p(tbl(finish)); }
if (tokens.length) {
  p(""); p("■ 失敗した呼び出しのトークン(新しい記録だけ)");
  for (const t of tokens) p(`  ${t.scene}: 入力 ${t.prompt} / 出力 ${t.out ?? "-"} / 上限 ${t.max ?? "-"} / 出力の長さ ${t.raw ?? "-"}字`);
}
if (Object.keys(details).length) { p(""); p("■ 「そのほか」の詳細"); p(tbl(details)); }
const text = lines.join("\n");
console.log(text);
if (outPath) fs.writeFileSync(outPath, text + "\n");
