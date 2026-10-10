// ============================================================================
//  危機キーワード v2(今)と v3(案)の比較(docs/prompts/crisis-keywords-v3.md 4章)
//
//  実行: node scripts/test-crisis-keywords-v3.mjs [--set=docs/test-sets/crisis-detection.json]
//          [--dev=docs/test-sets/crisis-keywords-v3-dev.json] [--reps-tier-a=10] [--reps-other=3] [--reps-dev=3]
//          [--votes=2] [--out=docs/test-results/xxx.jsonl] [--report-only]
//        --out に途中まで書かれたファイルを渡すと、続きから再開する(無料枠の1日の上限で止まった場合用)
//
//  比べ方(対の比較)
//   ・v2 と v3 の違いは照合の規則だけで、分類器に渡す文はどちらの版でも同じ(誇張の言い換えも同じ関数)。
//     そこで、1回の判定ごとに分類器を1回(並行 --votes 回)だけ呼び、その同じ結果に v2 と v3 の照合を当てて
//     それぞれの段階を出す(src/classify.mjs の combineStaged)。分類器の揺れが片方にだけ出ることがなく、
//     呼び出しも半分ですむ
//   ・Tier A(crisis・本人)の発話は --reps-tier-a 回、none・watch・第三者は --reps-other 回、
//     3章の例文(開発用)は --reps-dev 回判定する
//   ・v3 が明示的な表現(tier_a_type = explicit)を1回でも見逃したら、その時点で止めて報告する
//
//  CLAUDE.md 5.10 に従い、無料枠のテスト専用キー(TEST_GEMINI_API_KEYS / TEST_GEMINI_API_KEY1〜)で実行する。
//  保留セットは使わない(保留セット v3 は、採否の判断にだけ別に使う)。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep } from "./_lib/test-env.mjs";
import { classifyStaged, combineStaged, crisisRules, LITE_MODELS } from "../src/classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const ROTATION = createKeyRotationState();

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const SET_PATH = path.resolve(ROOT, arg("set", "docs/test-sets/crisis-detection.json"));
const DEV_ARG = arg("dev", "docs/test-sets/crisis-keywords-v3-dev.json");
const DEV_PATH = DEV_ARG === "none" ? null : path.resolve(ROOT, DEV_ARG);
// 保留セット(ファイル名に holdout を含む)は中身を見ない(docs/prompts/crisis-keywords-v3.md 5章)。発言は表示・集計に出さず、番号だけにする
const HIDE = /holdout/.test(path.basename(SET_PATH));
const REPS_TIER_A = Number(arg("reps-tier-a", 10));
const REPS_OTHER = Number(arg("reps-other", 3));
const REPS_DEV = Number(arg("reps-dev", 3));
const VOTES = Number(arg("votes", 2));
const REPORT_ONLY = process.argv.includes("--report-only");
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/crisis-keywords-v3-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));

// 条件は第1段階の検証(scripts/test-crisis-staged.mjs)と同じ: 分類モデルは LITE_MODELS の先頭だけ、
// 1回あたりの待ち時間の上限は120秒(無料枠の混雑による時間切れを「段階1」として記録しないため)
const PRIMARY_MODEL = LITE_MODELS[0];
LITE_MODELS.splice(1);
const TIMEOUT_MS = arg("timeout-ms", "120000");
const PATIENCE = Number(arg("patience", 6));
process.env.CRISIS_CLASSIFIER_TIMEOUT_MS = TIMEOUT_MS;

// v3 で段階を下げた語・外した語(4章「特に見てほしいところ」)。発言にこれらが含まれるかで、発話ごとに報告する
const LOWERED_WORDS = ["生きてる意味", "生きる意味", "楽になりたい", "らくになりたい", "終わりにしたい", "おわりにしたい",
  "助けて", "たすけて", "触られ", "さわられ", "性的", "無視され続け", "怒鳴られ", "どなられ"];

const main = JSON.parse(readFileSync(SET_PATH, "utf8")).items.map((it) => ({ ...it, set: "main" }));
const dev = DEV_PATH ? JSON.parse(readFileSync(DEV_PATH, "utf8")).items.map((it) => ({ ...it, set: "dev", label: it.group })) : [];
const showText = (t, it) => (HIDE ? `#${main.indexOf(it) + 1}` : t);
// 記録の照合に使う鍵(保留セットは発言を記録に残さないので、番号で照合する)
const recKey = (it) => (HIDE ? `holdout#${main.indexOf(it) + 1}|${JSON.stringify(it.context ?? null).length}` : itemKey(it));
const items = [...main, ...dev];
const isTierA = (it) => it.set === "main" && it.label === "crisis" && (it.subject ?? "self") !== "other";
const repsOf = (it) => (it.set === "dev" ? REPS_DEV : isTierA(it) ? REPS_TIER_A : REPS_OTHER);
const itemKey = (it) => `${it.set}||${it.text}||${JSON.stringify(it.context ?? null)}`;
const loweredIn = (text) => LOWERED_WORDS.filter((w) => String(text).includes(w));

const isTransient = (r) => !!r.classifierError && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(r.classifierError);
const summarize = (r) => ({
  stage: r.risk === "crisis" && r.subject === "other" ? "third" : r.stage,
  tier_a: r.risk === "crisis" && r.subject === "self",
  decided_by: r.decidedBy, keywords: r.keywords, patterns: r.patterns, floor: r.floor ?? [],
  hits: (r.hits ?? []).map((h) => `${h.id} ${h.label}(段階${h.stage})`),
});

async function judge(item) {
  let lastMs = 0;
  const attempt = async () => {
    const t0 = Date.now();
    const r = await classifyStaged(item.text, item.context ?? [], { votes: VOTES, version: "v2" });
    lastMs = Date.now() - t0;
    return r;
  };
  let r = await withRateLimitRetry(KEY_POOL, attempt, isTransient, { state: ROTATION, label: "分類器: " });
  for (let round = 1; isTransient(r) && round <= PATIENCE; round++) {
    const waitMs = Math.min(60000 * round, 300000);
    console.error(`    すべてのキーで上限・混雑。${waitMs / 1000}秒待って試し直します(${round}/${PATIENCE})`);
    await sleep(waitMs);
    r = await withRateLimitRetry(KEY_POOL, attempt, isTransient, { state: ROTATION, label: "分類器: " });
  }
  if (isTransient(r)) return { paused: true, error: r.classifierError };
  // 同じ分類器の結果に、v3 の照合を当てる
  const r3 = combineStaged(crisisRules(item.text, "v3"), r.votes, { followUp: false });
  return {
    v2: summarize(r), v3: summarize(r3),
    votes: (r.votes ?? []).map((v) => ({ ok: v.ok, risk: v.risk, subject: v.subject, reason: v.reason, error: v.error, model: v.model })),
    classifier_error: r.classifierError ?? null, ms: lastMs,
  };
}

// --------------------------------------------------------------------------
// 実行(再開対応)
// --------------------------------------------------------------------------
mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Map();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) {
    const rec = JSON.parse(line);
    done.set(`${rec.item_key}|${rec.rep}`, rec);
  }
}
const total = items.reduce((s, it) => s + repsOf(it), 0);
console.log(`テストセット: ${path.relative(ROOT, SET_PATH)}(${main.length}件)${DEV_PATH ? `+ 開発用 ${path.relative(ROOT, DEV_PATH)}(${dev.length}件)` : ""}${HIDE ? "(保留セット: 発言は表示しない)" : ""}`);
console.log(`判定: Tier A 各${REPS_TIER_A}回・その他 各${REPS_OTHER}回・開発用 各${REPS_DEV}回 = ${total}判定(1判定につき分類器${VOTES}回並行。v2・v3 は同じ結果を使う)`);
console.log(`分類器の呼び出しの見込み: 約${total * VOTES}回(キー${KEY_POOL.length}本)`);
console.log(`記録: ${path.relative(ROOT, OUT)}(済み ${done.size}件)\n`);

let stopped = null, paused = null;
if (!REPORT_ONLY) {
  let count = done.size;
  outer:
  for (const it of items) {
    for (let rep = 1; rep <= repsOf(it); rep++) {
      const key = `${recKey(it)}|${rep}`;
      if (done.has(key)) continue;
      const res = await judge(it);
      if (res.paused) {
        paused = `無料枠の上限または混雑のため中断(「${HIDE ? "保留セット" : it.text.slice(0, 20)}」: ${String(res.error).slice(0, 160)})`;
        console.log(`\n★ ${paused}\n  再開: node scripts/test-crisis-keywords-v3.mjs ${process.argv.slice(2).filter((a) => !a.startsWith("--out=")).join(" ")} --out=${path.relative(ROOT, OUT)}`);
        break outer;
      }
      const rec = {
        item_key: recKey(it), set: it.set,
        text: HIDE ? `#${main.indexOf(it) + 1}` : it.text, has_context: !!it.context?.length, rep,
        true_label: it.label, true_subject: it.subject ?? "self", tier_a: isTierA(it), tier_a_type: it.tier_a_type ?? null,
        lowered_words: loweredIn(it.text), ...res,
        ...(HIDE ? { votes: res.votes.map(({ reason, ...v }) => v), v2: { ...res.v2, hits: res.v2.hits.map((h) => h.split(" ")[0]) }, v3: { ...res.v3, hits: res.v3.hits.map((h) => h.split(" ")[0]) } } : {}),
      };
      const line = JSON.stringify(rec);
      appendFileSync(OUT, line + "\n");
      done.set(key, JSON.parse(line));
      count++;
      const mark = (s) => (rec.tier_a ? (s.tier_a ? "○" : "×") : `段${s.stage}`);
      console.log(`[${count}/${total}] ${String(rec.true_label).padEnd(14)} v2 ${mark(rec.v2).padEnd(4)} v3 ${mark(rec.v3).padEnd(4)} ${rec.v3.decided_by.join(",")} 「${showText(it.text.slice(0, 22), it)}」`);
      if (rec.tier_a_type === "explicit" && !rec.v3.tier_a) {
        stopped = `v3 が明示的な表現を見逃した: 「${showText(it.text, it)}」(${rep}回目。規則=${rec.v3.decided_by.join(",")}、分類器エラー=${rec.classifier_error ?? "なし"})`;
        console.log(`\n★★★ 停止: ${stopped}`);
        break outer;
      }
      await sleep(1000);
    }
  }
}

// --------------------------------------------------------------------------
// 集計
// --------------------------------------------------------------------------
const recs = [...done.values()];
const rate = (n, d) => (d ? `${n}/${d}` : "—");
const perItem = new Map();
for (const r of recs) {
  const p = perItem.get(r.item_key) ?? { text: r.text, set: r.set, label: r.true_label, tier_a: r.tier_a, type: r.tier_a_type, lowered: r.lowered_words, rs: [] };
  p.rs.push(r); perItem.set(r.item_key, p);
}
const rows = [...perItem.values()];
const missN = (p, v) => p.rs.filter((r) => !r[v].tier_a).length;
const stageCount = (p, v, s) => p.rs.filter((r) => r[v].stage === s).length;
const tierA = rows.filter((p) => p.tier_a);
const worsened = tierA.filter((p) => missN(p, "v3") > missN(p, "v2"));
const explicitMissV3 = tierA.filter((p) => p.type === "explicit").reduce((s, p) => s + missN(p, "v3"), 0);
const mainRecs = recs.filter((r) => r.set === "main");
const count = (rs, f) => rs.filter(f).length;
const noneTo2 = (v) => count(mainRecs, (r) => r.true_label === "none" && r[v].stage === 2);
const watchTo0 = (v) => count(mainRecs, (r) => r.true_label === "watch" && r[v].stage === 0);
const variants = rows.filter((p) => p.label === "variant");
const variantAllHitV3 = variants.every((p) => p.rs.every((r) => r.v3.stage === 2));
const fpTo2 = (v) => count(recs, (r) => r.set === "dev" && r.true_label === "false_positive" && r[v].stage === 2);
const ruleKind = (s) => (s.decided_by.includes("pattern") ? "パターン" : s.decided_by.includes("keyword") ? "キーワード" : s.decided_by.includes("classifier") ? "分類器" : "なし");
const ruleBreak = (rs, v) => rs.reduce((m, r) => { const k = ruleKind(r[v]); m[k] = (m[k] ?? 0) + 1; return m; }, {});

const criteria = {
  explicit_zero_miss: explicitMissV3 === 0,
  no_tier_a_item_worsened: worsened.length === 0,
  none_to_stage2_not_increased: noneTo2("v3") <= noneTo2("v2"),
  watch_to_none_not_increased: watchTo0("v3") <= watchTo0("v2"),
  all_variants_hit: variantAllHitV3,
  false_positive_stage2_not_increased: fpTo2("v3") <= fpTo2("v2"),
};
const adopted = Object.values(criteria).every(Boolean);

const lines = [];
const L = (s = "") => lines.push(s);
L("========================================");
L("危機キーワード v2(今)と v3(案)の比較");
L("========================================");
L(`テストセット: ${path.relative(ROOT, SET_PATH)}(${main.length}件)+ 開発用(${dev.length}件)  記録: ${path.relative(ROOT, OUT)}`);
L(`判定: Tier A 各${REPS_TIER_A}回・その他 各${REPS_OTHER}回・開発用 各${REPS_DEV}回。済み ${recs.length}/${total}判定${stopped ? "(途中で停止)" : paused ? "(中断中。再開できる)" : ""}`);
L(`条件: 分類モデルは ${PRIMARY_MODEL} のみ、1判定につき分類器 ${VOTES}回並行。v2・v3 は同じ分類器の結果に、それぞれの照合を当てた(対の比較)`);
if (stopped) L(`★ 停止の理由: ${stopped}`);
if (paused) L(`★ ${paused}`);
L("");
L(`【採用の条件】 ${adopted ? "すべて満たす" : "満たさないものがある"}`);
L(`  明示的な表現の見逃しゼロ(v3)                     : ${criteria.explicit_zero_miss ? "満たす" : `満たさない(${explicitMissV3}回)`}`);
L(`  どの Tier A の発話も v2 より見逃し率が悪化しない   : ${criteria.no_tier_a_item_worsened ? "満たす" : `満たさない(${worsened.length}件)`}`);
L(`  none が段階2になる回数が v2 より増えない           : ${criteria.none_to_stage2_not_increased ? "満たす" : "満たさない"}(v2 ${noneTo2("v2")}回 → v3 ${noneTo2("v3")}回)`);
L(`  watch が段階0に落ちる回数が v2 より増えない        : ${criteria.watch_to_none_not_increased ? "満たす" : "満たさない"}(v2 ${watchTo0("v2")}回 → v3 ${watchTo0("v3")}回)`);
L(`  3章の表記ゆれがすべて当たる(v3)                  : ${criteria.all_variants_hit ? "満たす" : "満たさない"}`);
L(`  3章の誤検知の確認で、段階2の回数が v2 より増えない : ${criteria.false_positive_stage2_not_increased ? "満たす" : "満たさない"}(v2 ${fpTo2("v2")}回 → v3 ${fpTo2("v3")}回)`);
L("");
L("【Tier A の発話ごとの見逃し(判定回数中の見逃し回数)】");
for (const type of ["explicit", "passive"]) {
  L(`  ■ ${type === "explicit" ? "明示" : "受動・示唆"}`);
  for (const p of tierA.filter((x) => x.type === type)) {
    L(`    v2 ${rate(missN(p, "v2"), p.rs.length).padEnd(6)} v3 ${rate(missN(p, "v3"), p.rs.length).padEnd(6)} v3の検出: ${JSON.stringify(ruleBreak(p.rs.filter((r) => r.v3.tier_a), "v3"))} 「${p.text}」${worsened.includes(p) ? "  ← 悪化" : ""}`);
  }
}
const worst = (v) => [...tierA].sort((a, b) => missN(b, v) / b.rs.length - missN(a, v) / a.rs.length)[0];
const w2 = worst("v2"), w3 = worst("v3");
L(`  最も見逃されやすい発話: v2「${w2?.text}」${rate(missN(w2 ?? { rs: [] }, "v2"), w2?.rs.length)} / v3「${w3?.text}」${rate(missN(w3 ?? { rs: [] }, "v3"), w3?.rs.length)}`);
L("");
L("【段階を下げた語・外した語を含む発話(v2 → v3。段階0 / 1 / 2 / 第三者の回数)】");
const lowered = rows.filter((p) => p.lowered.length);
if (!lowered.length) L("  (該当する発話なし)");
for (const p of lowered) {
  const d = (v) => `${stageCount(p, v, 0)}/${stageCount(p, v, 1)}/${stageCount(p, v, 2)}/${stageCount(p, v, "third")}`;
  const miss = p.tier_a ? `  見逃し v2 ${missN(p, "v2")} → v3 ${missN(p, "v3")}${missN(p, "v3") > missN(p, "v2") ? " ← 増えた(この語は段階2に戻す)" : ""}` : "";
  L(`  [${p.label}] 語=${p.lowered.join("・")}  v2 ${d("v2")} → v3 ${d("v3")}${miss} 「${p.text}」`);
}
L("");
L("【none・watch の段階の分布(判定回数)】  段階0 / 段階1 / 段階2 / 第三者");
for (const label of ["none", "watch"]) {
  const rs = mainRecs.filter((r) => r.true_label === label);
  for (const v of ["v2", "v3"]) L(`  ${label.padEnd(5)} ${v}: ${count(rs, (r) => r[v].stage === 0)} / ${count(rs, (r) => r[v].stage === 1)} / ${count(rs, (r) => r[v].stage === 2)} / ${count(rs, (r) => r[v].stage === "third")}(${rs.length}判定)`);
}
for (const v of ["v2", "v3"]) {
  const xs = mainRecs.filter((r) => r.true_label === "none" && r[v].stage === 2);
  if (xs.length) { L(`  ${v} で none が段階2になった発話:`); for (const r of xs) L(`    「${r.text}」 規則=${r[v].decided_by.join(",")} ${r[v].hits.join(" ")}`); }
}
L("");
L("【3章の例文(開発用)】  段階0 / 段階1 / 段階2(判定回数)");
for (const g of ["variant", "false_positive", "abuse"]) {
  L(`  ■ ${g === "variant" ? "表記ゆれ(段階2になるべき)" : g === "false_positive" ? "誤検知の確認(段階2になってはいけない)" : "他人への暴言"}`);
  for (const p of rows.filter((x) => x.label === g)) {
    const d = (v) => `${stageCount(p, v, 0)}/${stageCount(p, v, 1)}/${stageCount(p, v, 2) + stageCount(p, v, "third")}`;
    L(`    v2 ${d("v2").padEnd(6)} v3 ${d("v3").padEnd(6)} 「${p.text}」 ${p.rs[0]?.v3.hits.join(" ") ?? ""}`);
  }
}
L("");
L("【どの規則で段階2(Tier A)と判定されたか(のべ)】");
for (const v of ["v2", "v3"]) L(`  ${v}: ${JSON.stringify(ruleBreak(recs.filter((r) => r.tier_a && r[v].tier_a), v))}`);
L(`  分類器エラー: ${rate(count(recs, (r) => r.classifier_error), recs.length)}`);

const report = lines.join("\n");
console.log("\n" + report);
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, report + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify({
  set: path.relative(ROOT, SET_PATH), dev: DEV_PATH ? path.relative(ROOT, DEV_PATH) : null, reps: { tier_a: REPS_TIER_A, other: REPS_OTHER, dev: REPS_DEV }, votes: VOTES,
  judgments_done: recs.length, judgments_planned: total, stopped, paused, conditions: { classifier_model: PRIMARY_MODEL, timeout_ms: Number(TIMEOUT_MS) },
  criteria, adopted, worsened: worsened.map((p) => p.text),
}, null, 2));
console.log(`\n集計を保存しました: ${path.relative(ROOT, base)}-summary.txt / .json`);

const xl = spawnSync("python3", [path.join(__dirname, "export-crisis-keywords-v3-xlsx.py"), OUT], { encoding: "utf8" });
if (xl.status === 0) console.log(xl.stdout.trim());
else console.log(`エクセルファイルの書き出しに失敗しました: ${String(xl.stderr || xl.error?.message || "").slice(0, 300)}`);
process.exitCode = stopped ? 2 : paused ? 3 : 0;
