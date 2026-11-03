// ============================================================================
//  危機の分類器の「2回並行の判定」が食い違った割合と向き(2026年11月3日。docs/token-usage-20261103.md 3章)
//
//  記録ずみの結果(開発用の文の判定。分類器を2回とも最後まで待って残したもの)から数えるだけ。モデルは呼ばない。
//  保留セット(holdout)の結果は読まない(CLAUDE.md・docs/test-sets の決まり。調整にも使わない)。
//  本文は表示しない(集計だけ)。
//
//  実行: node scripts/analyze-classifier-votes.mjs [結果の .jsonl ...]
//        既定は docs/test-results/crisis-evidence-dev-20261101.jsonl と crisis-keywords-v3-20261009.jsonl
//        test-api-path.mjs の結果(turns[].votes。2026年11月3日から)も渡せる
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceSupportsCrisis, crisisRules } from "../src/classify.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  "docs/test-results/crisis-evidence-dev-20261101.jsonl",
  "docs/test-results/crisis-keywords-v3-20261009.jsonl",
];

const ORDER = { none: 0, watch: 1, crisis: 2 };
const pairKey = (a, b) => [a, b].sort((x, y) => ORDER[x] - ORDER[y]).join("+");

for (const f of files) {
  if (/holdout/i.test(f)) { console.log(`${f}: 保留セットの結果は読まない`); continue; }
  const rows = fs.readFileSync(path.resolve(ROOT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // 1件の判定 = { votes: [{ok,risk,subject,evidence}], text, label, keywordHit }
  const items = [];
  for (const r of rows) {
    if (Array.isArray(r.votes)) {
      items.push({ votes: r.votes, text: r.text, label: r.true_label ?? "?", tierA: r.tier_a === true,
        keywordHit: (r.v3?.keywords?.length ?? 0) + (r.v3?.patterns?.length ?? 0) > 0 });
    } else if (Array.isArray(r.turns)) {
      for (const t of r.turns) {
        if (!Array.isArray(t.votes) || !t.votes.length) continue;
        const rules = crisisRules(String(t.text ?? ""));
        items.push({ votes: t.votes, text: null, label: "log", tierA: false, keywordHit: rules.keywords.length + rules.patterns.length > 0 });
      }
    }
  }
  const both = items.filter((i) => i.votes.length >= 2 && i.votes.slice(0, 2).every((v) => v.ok && v.risk));
  const pairs = {}, byLabel = {};
  const decisiveLabels = {};
  let disagree = 0, subjDisagree = 0, decisive = 0, decisiveTierA = 0, decisiveEvidence = 0;
  for (const i of both) {
    const [a, b] = i.votes;
    const k = pairKey(a.risk, b.risk);
    pairs[k] = (pairs[k] ?? 0) + 1;
    const L = (byLabel[i.label] ??= { n: 0, disagree: 0 });
    L.n++;
    if (a.risk !== b.risk) { disagree++; L.disagree++; }
    if (a.subject !== b.subject) subjDisagree++;
    // 段階を決める食い違い: キーワード・受動パターンが無く、危機が片方だけ(1回の判定なら、半分ほどの確率で段階2にならない)
    const crisisN = [a, b].filter((v) => v.risk === "crisis" && v.subject !== "other").length;
    if (!i.keywordHit && crisisN === 1) {
      decisive++;
      decisiveLabels[i.label] = (decisiveLabels[i.label] ?? 0) + 1;
      if (i.tierA) decisiveTierA++;
      // 根拠の引用の確かめ(2026年11月1日から)を通る危機の票か(本文がある結果だけ)
      const cv = [a, b].find((v) => v.risk === "crisis");
      if (i.text != null && cv && evidenceSupportsCrisis(cv.evidence, i.text).ok) decisiveEvidence++;
    }
  }
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
  console.log(`\n== ${f}`);
  console.log(`  判定 ${items.length} 件のうち、2回とも判定できた ${both.length} 件`);
  console.log(`  risk の食い違い ${disagree}(${pct(disagree, both.length)})/ subject の食い違い ${subjDisagree}(${pct(subjDisagree, both.length)})`);
  console.log(`  組み合わせ: ${Object.entries(pairs).sort().map(([k, n]) => `${k} ${n}`).join(" / ")}`);
  console.log(`  正解のラベルごと: ${Object.entries(byLabel).map(([k, v]) => `${k} ${v.disagree}/${v.n}`).join(" / ")}`);
  console.log(`  キーワード・受動パターンが無く、本人の危機が片方だけ: ${decisive}(${pct(decisive, both.length)})。うち Tier A ${decisiveTierA}` +
    (items.some((i) => i.text != null) ? `、危機の票が根拠の引用の確かめを通る ${decisiveEvidence}` : "") +
    `(正解のラベル: ${Object.entries(decisiveLabels).map(([k, n]) => `${k} ${n}`).join(" / ") || "なし"})`);
  // 片方が失敗(エラー・時間切れ)した判定。1回だけの判定にしたときは、この分が「判定なし = 段階1」になる
  const oneFailed = items.filter((i) => i.votes.length >= 2 && i.votes.slice(0, 2).filter((v) => v.ok && v.risk).length === 1).length;
  const bothFailed = items.filter((i) => i.votes.length >= 2 && i.votes.slice(0, 2).every((v) => !(v.ok && v.risk))).length;
  console.log(`  片方だけ失敗 ${oneFailed}(${pct(oneFailed, items.length)})/ 両方失敗 ${bothFailed}(${pct(bothFailed, items.length)})(無料枠の混雑を含む)`);
}
