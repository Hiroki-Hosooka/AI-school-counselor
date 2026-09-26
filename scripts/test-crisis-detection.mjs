// ============================================================================
//  危機検知の精度測定(docs/backlog.md 1-3 テスト1)
//  詳細仕様: docs/prompts/automated-testing-harness.md
//
//  実行: node scripts/test-crisis-detection.mjs
//        (npm run test:crisis でも同じ)
//
//  やること
//   ・docs/test-sets/crisis-detection.json のラベル付き発話を、本番と同じ判定ロジック
//     (src/classify.mjs の classify())に通す
//   ・クラス(none/watch/crisis)ごとの適合率・再現率・F1と、全体のマクロ平均を出す
//   ・Geminiの安全フィルターにブロックされた件数を、誤判定とは別枠で集計する
//     (CLAUDE.md 5.11)
//   ・結果を docs/test-results/ 配下にJSONで残す
//
//  CLAUDE.md 5.10「Gemini無料枠は合成テスト専用」を守るため、本番の GEMINI_API_KEY とは
//  別の TEST_GEMINI_API_KEY を必須にしている。未設定の場合は本番キーへフォールバックせず
//  ここで止める。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep, isTransientClassifierError } from "./_lib/test-env.mjs";
import { classify, classifyStaged, crisisDetectionVersion, LITE_MODELS } from "../src/classify.mjs";
import { CRISIS_WORDS, crisisRulesV2 } from "../src/safety.mjs";

// 既定は危機検知 v2(段階つき。src/classify.mjs の classifyStaged。2026年9月26日に採用。本番の既定と同じ)を測る。
// v2 では項目の context(直前のやりとり)も分類器に渡す。設定 CRISIS_DETECTION=v1 のときは v1 を測る。
// v1 と v2 を同じ条件で比べるときは scripts/test-crisis-staged.mjs を使う。
const DETECTION = crisisDetectionVersion();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 複数キーのプール(2026年9月・検証一式)。TEST_GEMINI_API_KEYS(カンマ区切り)が
// あればそれを、無ければ単一のTEST_GEMINI_API_KEYを使う。KEY_ROTATIONは直近成功した
// キーの位置を覚えておくための状態(毎回キー1から試して消耗させないため)。
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const KEY_ROTATION = createKeyRotationState();

// --------------------------------------------------------------------------
// テストセット読み込み
// --------------------------------------------------------------------------
const setPathArg = process.argv.find((a) => a.startsWith("--set="));
const SET_PATH = setPathArg
  ? path.resolve(ROOT, setPathArg.slice("--set=".length))
  : path.join(ROOT, "docs/test-sets/crisis-detection.json");

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let items = testSet.items ?? [];
if (LIMIT) items = items.slice(0, LIMIT);

const LABELS = ["crisis", "watch", "none"];
for (const it of items) {
  if (!LABELS.includes(it.label)) {
    console.error(`不正なラベル "${it.label}"(${it.text})。none/watch/crisis のいずれかにしてください。`);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------
// classify() 呼び出し(レート制限は間隔を空けて再試行。ブロックは再試行しない
// = ブロックは「事実」として記録する対象であり、レート制限のような一時障害ではないため)
// --------------------------------------------------------------------------
async function classifyWithRetry(text, context) {
  return withRateLimitRetry(
    KEY_POOL,
    () => (DETECTION === "v2" ? classifyStaged(text, context ?? []) : classify(text)),
    // v2 は複数の回のエラーを " | " でつないで返すので、文字列全体からタグを探す
    DETECTION === "v2" ? (r) => !!r.classifierError && /\[RATE_LIMIT\]|\[HTTP_503\]/.test(r.classifierError) : isTransientClassifierError,
    { state: KEY_ROTATION },
  );
  // 全滅後もレート制限のままなら、その結果をそのまま記録する(withRateLimitRetryの仕様)。
}

function errorTag(err) {
  if (!err) return null;
  if (err.startsWith("[BLOCKED]")) return "blocked";
  if (err.startsWith("[RATE_LIMIT]")) return "rate_limited";
  return "other_error";
}

// --------------------------------------------------------------------------
// 概算トークン数(あくまで目安。API側の正確な usageMetadata は参照していない)
// 日本語は概ね1〜2文字/トークンと言われるため、保守的に1.5文字/トークンで概算する。
// 無料枠(TEST_GEMINI_API_KEY)での実行を前提としており、費用は原則0円。有料枠で
// 実行する場合は https://ai.google.dev/gemini-api/docs/pricing の最新料金と
// 掛け合わせて見積もること(ここでは料金の断定を避ける)。
// --------------------------------------------------------------------------
const CHARS_PER_TOKEN = 1.5;

// --------------------------------------------------------------------------
// 実行
// --------------------------------------------------------------------------
console.log(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)`);
console.log(`分類モデル: ${LITE_MODELS.join(" → ")}`);
console.log(`判定方式: ${DETECTION}${DETECTION === "v2" ? "(段階つき・文脈あり)" : ""}`);
console.log("");

const startedAt = new Date();
const results = [];
let estimatedChars = 0;

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const hasKeywordHit = DETECTION === "v2"
    ? (() => { const r = crisisRulesV2(item.text); return r.keywords.length > 0 || r.patterns.length > 0; })()
    : CRISIS_WORDS.some((w) => item.text.includes(w));
  process.stdout.write(`[${i + 1}/${items.length}] ${item.label.padEnd(6)} 「${item.text.slice(0, 24)}...」 `);

  const r = await classifyWithRetry(item.text, item.context);
  estimatedChars += item.text.length + (r.model?.reason?.length ?? 0);

  const tag = errorTag(r.classifierError);
  console.log(`→ ${r.risk}${tag ? `(${tag})` : ""}`);

  // Tier A = risk==="crisis" && subject==="self"(CLAUDE.md 5.12・route.tsのisSelfCrisisと同じ定義)。
  // 検証一式 テスト1。risk単体のconfusion_matrixとは別に、この合成軸で見る。
  const trueSubject = item.subject ?? "self";
  results.push({
    text: item.text,
    trueLabel: item.label,
    predicted: r.risk,
    trueSubject: item.subject ?? null, // 構造化面接AI統合 手順4。未指定の既存項目はselfとして扱う(下記参照)
    predictedSubject: r.subject,
    trueTierA: item.label === "crisis" && trueSubject === "self",
    predictedTierA: r.risk === "crisis" && r.subject === "self",
    hasKeywordHit,
    classifierError: r.classifierError,
    errorTag: tag,
    modelReason: r.model?.reason ?? null,
    usedModel: r.usedModel, // 実際に判定に成功したモデルID。全滅時はnull(検証一式)。
    stage: r.stage ?? null, decidedBy: r.decidedBy ?? null, // v2 のときだけ
  });

  // 無料枠(10RPM級)を自分から詰まらせないための間隔。連続で呼びすぎない。
  if (i < items.length - 1) await sleep(2000);
}

const finishedAt = new Date();

// --------------------------------------------------------------------------
// 指標算出
// --------------------------------------------------------------------------
function computeConfusion(rows) {
  const m = {};
  for (const t of LABELS) { m[t] = {}; for (const p of LABELS) m[t][p] = 0; }
  for (const r of rows) m[r.trueLabel][r.predicted] = (m[r.trueLabel][r.predicted] ?? 0) + 1;
  return m;
}

function computePerClass(rows, confusion) {
  const perClass = {};
  for (const c of LABELS) {
    const tp = confusion[c][c] ?? 0;
    const fp = LABELS.reduce((s, t) => (t === c ? s : s + (confusion[t][c] ?? 0)), 0);
    const fn = LABELS.reduce((s, p) => (p === c ? s : s + (confusion[c][p] ?? 0)), 0);
    const support = rows.filter((r) => r.trueLabel === c).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : (precision === 0 || recall === 0 ? 0 : null);
    const blocked = rows.filter((r) => r.trueLabel === c && r.errorTag === "blocked").length;
    perClass[c] = { support, precision, recall, f1, blocked };
  }
  return perClass;
}

function macroAvg(perClass, key) {
  const vals = LABELS.map((c) => perClass[c][key]).filter((v) => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const confusion = computeConfusion(results);
const perClass = computePerClass(results, confusion);
const accuracy = results.length ? results.filter((r) => r.predicted === r.trueLabel).length / results.length : null;

const blockedResults = results.filter((r) => r.errorTag === "blocked");
const rateLimitedResults = results.filter((r) => r.errorTag === "rate_limited");
const otherErrorResults = results.filter((r) => r.errorTag === "other_error");
const misclassified = results.filter((r) => r.predicted !== r.trueLabel);

// 5.11 / classify() の既知の懸念:キーワードに一致しない crisis 発話で、
// 分類器自体がブロック/失敗すると none にフォールバックする(CLAUDE.md 5.11 参照)。
// この経路がどれだけ実際に起きているかを、キーワードなしの crisis 部分集合だけで見る。
const crisisNoKeyword = results.filter((r) => r.trueLabel === "crisis" && !r.hasKeywordHit);
const crisisNoKeywordRecall = crisisNoKeyword.length
  ? crisisNoKeyword.filter((r) => r.predicted === "crisis").length / crisisNoKeyword.length
  : null;
const crisisNoKeywordBlocked = crisisNoKeyword.filter((r) => r.errorTag === "blocked").length;

// --------------------------------------------------------------------------
// subject(self/other)の精度(構造化面接AI統合 手順4で追加)。
// テストセットで subject を指定していない項目は self を期待値として扱う
// (既存の66件は全て相談者自身についての発言のため。docs/test-sets/crisis-detection.json
// の subject_note 参照)。全件でのself方向の過検知(本来selfなのにotherと誤る)と、
// 明示的にラベル付けした新規項目でのother方向の再現率を分けて見る。
// --------------------------------------------------------------------------
const subjectResults = results.map((r) => ({ ...r, expectedSubject: r.trueSubject ?? "self" }));
const subjectAccuracy = subjectResults.length
  ? subjectResults.filter((r) => r.predictedSubject === r.expectedSubject).length / subjectResults.length
  : null;
const labeledOther = subjectResults.filter((r) => r.trueSubject === "other");
const otherRecall = labeledOther.length
  ? labeledOther.filter((r) => r.predictedSubject === "other").length / labeledOther.length
  : null;
const selfMisclassifiedAsOther = subjectResults.filter(
  (r) => r.expectedSubject === "self" && r.predictedSubject === "other",
);

// --------------------------------------------------------------------------
// Tier A/Bの分離の妥当性(検証一式 テスト1・2026年9月)。
// risk単体のconfusion_matrixだけでは、「crisisと判定されたがsubjectがotherだった
// (=固定応答をスキップする経路)」と「crisisと判定されsubjectもselfだった
// (=実際にTier A固定応答になる)」が区別できない。CLAUDE.md 5.12の定義そのままに、
// risk/subjectを合成したTier A軸で、これまでの構成変更(絶望感の表現を
// CRISIS_WORDSから外した=Tier B化)が意図通り機能しているかを見る。
// --------------------------------------------------------------------------
const trueTierAResults = results.filter((r) => r.trueTierA);
const trueWatchResults = results.filter((r) => r.trueLabel === "watch");

const tierARecall = trueTierAResults.length
  ? trueTierAResults.filter((r) => r.predictedTierA).length / trueTierAResults.length
  : null;
const tierAMissed = trueTierAResults.filter((r) => !r.predictedTierA);

const tierBOverDetection = trueWatchResults.filter((r) => r.predictedTierA);
const tierBOverDetectionRate = trueWatchResults.length
  ? tierBOverDetection.length / trueWatchResults.length
  : null;

const blockRate = results.length ? blockedResults.length / results.length : null;

// --------------------------------------------------------------------------
// 実際に使われたモデルの内訳(検証一式・2026年9月)。
// classifier_models(LITE_MODELS)は「試す順番」の設定値でしかなく、実際にどのモデルが
// 応答したか(フォールバックが実際に発生したか)はこの集計でしか分からない。
// --------------------------------------------------------------------------
function countBy(rows, fn) {
  const counts = {};
  for (const r of rows) {
    const v = fn(r);
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}
const modelUsageCounts = countBy(results, (r) => r.usedModel);
const noModelSucceeded = results.filter((r) => !r.usedModel).length;

// --------------------------------------------------------------------------
// レポート出力
// --------------------------------------------------------------------------
console.log("\n=== 実際に使われたモデルの内訳(検証一式) ===");
console.log(`  設定上のフォールバック順: ${LITE_MODELS.join(" → ")}`);
for (const [m, c] of Object.entries(modelUsageCounts)) {
  console.log(`  ${m}: ${c}件${m === LITE_MODELS[0] ? "" : "  ← フォールバックが発生"}`);
}
if (noModelSucceeded) {
  console.log(`  全モデル失敗(キーワードのみで判定・classifierError参照): ${noModelSucceeded}件`);
}

console.log("\n=== Tier A/B分離の妥当性(検証一式 テスト1・最重要) ===");
console.log(`  Tier A再現率(見逃してはいけない)     = ${tierARecall === null ? "—" : tierARecall.toFixed(2)} (support=${trueTierAResults.length})`);
console.log(`  Tier A見逃し件数                       = ${tierAMissed.length} / ${trueTierAResults.length}${tierAMissed.length ? "  ★0件が望ましい。下に発話例あり" : ""}`);
console.log(`  Tier B→Tier A 過剰検知率(下がるべき)  = ${tierBOverDetectionRate === null ? "—" : tierBOverDetectionRate.toFixed(2)} (support=${trueWatchResults.length})`);
console.log(`  Geminiブロック率(精度とは別枠)        = ${blockRate === null ? "—" : blockRate.toFixed(2)} (${blockedResults.length}/${results.length})`);
if (tierAMissed.length) {
  console.log("\n  ★★★ Tier Aの見逃し(本人の危機サインが固定応答に至らなかった発話) ★★★");
  for (const r of tierAMissed) {
    console.log(`    「${r.text}」→ predicted=${r.predicted}/${r.predictedSubject}${r.errorTag ? `(${r.errorTag})` : ""}`);
  }
}

console.log("\n=== クラスごとの指標 ===");
for (const c of LABELS) {
  const p = perClass[c];
  const fmt = (v) => (v === null ? "—" : v.toFixed(2));
  console.log(`  ${c.padEnd(6)} precision=${fmt(p.precision)} recall=${fmt(p.recall)} f1=${fmt(p.f1)} (support=${p.support}, blocked=${p.blocked})`);
}

console.log("\n=== 全体 ===");
console.log(`  accuracy      = ${accuracy === null ? "—" : accuracy.toFixed(2)}`);
console.log(`  macro_precision = ${macroAvg(perClass, "precision")?.toFixed(2) ?? "—"}`);
console.log(`  macro_recall    = ${macroAvg(perClass, "recall")?.toFixed(2) ?? "—"}`);
console.log(`  macro_f1        = ${macroAvg(perClass, "f1")?.toFixed(2) ?? "—"}`);

console.log("\n=== subject(self/other)の精度(構造化面接AI統合 手順4) ===");
console.log(`  全体一致率      = ${subjectAccuracy === null ? "—" : subjectAccuracy.toFixed(2)}`);
console.log(`  other の再現率  = ${otherRecall === null ? "—" : otherRecall.toFixed(2)} (support=${labeledOther.length})`);
console.log(`  self を other と誤った件数 = ${selfMisclassifiedAsOther.length} / ${subjectResults.length}`);
if (selfMisclassifiedAsOther.length) {
  console.log("  ↑ 本人の危機を第三者の心配と誤ると、固定応答(CRISIS_REPLY)が出ずに生成に回ってしまうため特に重要:");
  for (const r of selfMisclassifiedAsOther) console.log(`    「${r.text}」`);
}

console.log("\n=== Geminiブロック(精度の指標とは別枠。CLAUDE.md 5.11) ===");
console.log(`  ブロック件数(全体): ${blockedResults.length} / ${results.length}`);
console.log(`  うち crisis(キーワードなし)の中でのブロック: ${crisisNoKeywordBlocked} / ${crisisNoKeyword.length}`);
console.log(`  crisis(キーワードなし)の再現率: ${crisisNoKeywordRecall === null ? "—" : crisisNoKeywordRecall.toFixed(2)}`);
if (rateLimitedResults.length) {
  console.log(`  再試行後もレート制限のままだった件数: ${rateLimitedResults.length}(結果の信頼度が下がるので注意)`);
}
if (otherErrorResults.length) {
  console.log(`  その他のエラー件数: ${otherErrorResults.length}`);
}

if (misclassified.length) {
  console.log("\n=== 誤判定した発話(抜粋) ===");
  for (const r of misclassified) {
    console.log(`  [${r.trueLabel} → ${r.predicted}]${r.errorTag ? `(${r.errorTag})` : ""} 「${r.text}」`);
  }
}

// --------------------------------------------------------------------------
// JSON出力
// --------------------------------------------------------------------------
const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outPath = path.join(resultsDir, `crisis-detection-${stamp}.json`);

const report = {
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  test_set: path.relative(ROOT, SET_PATH),
  test_set_count: items.length,
  classifier_models: LITE_MODELS,
  detection: DETECTION,
  model_usage: {
    counts: modelUsageCounts,
    no_model_succeeded: noModelSucceeded,
    note: "実際に判定に成功したモデルIDごとの件数(検証一式・2026年9月)。classifier_modelsは" +
      "設定上のフォールバック順であり、ここが2番目以降のモデルでも0件でなければ、実行中に" +
      "フォールバックが実際に発生したことを示す。no_model_succeededは全モデル失敗(キーワード" +
      "一致のみで判定。classifier_error/error_tag参照)。",
  },
  overall: {
    accuracy,
    macro_precision: macroAvg(perClass, "precision"),
    macro_recall: macroAvg(perClass, "recall"),
    macro_f1: macroAvg(perClass, "f1"),
  },
  per_class: perClass,
  confusion_matrix: confusion,
  tier_ab: {
    tier_a_recall: tierARecall,
    tier_a_support: trueTierAResults.length,
    tier_a_missed: tierAMissed.map((r) => ({
      text: r.text, predicted: r.predicted, predicted_subject: r.predictedSubject, error_tag: r.errorTag,
    })),
    tier_b_over_detection_rate: tierBOverDetectionRate,
    tier_b_support: trueWatchResults.length,
    tier_b_over_detection_examples: tierBOverDetection.map((r) => r.text),
    block_rate: blockRate,
    note: "検証一式 テスト1(2026年9月)。Tier A = risk===\"crisis\" && subject===\"self\"(CLAUDE.md 5.12)。" +
      "tier_a_recall/tier_a_missedは本人の危機サインの見逃し(0件が目標)、" +
      "tier_b_over_detection_rateはTier B(絶望感の表現)が誤って固定応答に至った割合" +
      "(今回の設計変更で下がっているはずの指標)を見る。",
  },
  blocked_total: blockedResults.length,
  blocked_examples: blockedResults.map((r) => ({ text: r.text, true_label: r.trueLabel, error: r.classifierError })),
  rate_limited_after_retry: rateLimitedResults.length,
  other_errors: otherErrorResults.length,
  crisis_keyword_free: {
    support: crisisNoKeyword.length,
    recall: crisisNoKeywordRecall,
    blocked: crisisNoKeywordBlocked,
    note: "CRISIS_WORDS に一致しない crisis 発話だけの再現率。分類器(Gemini)単体の実力とブロックの影響を見るための内訳(CLAUDE.md 5.11)。",
  },
  subject: {
    accuracy: subjectAccuracy,
    other_recall: otherRecall,
    other_support: labeledOther.length,
    self_misclassified_as_other: selfMisclassifiedAsOther.map((r) => r.text),
    note: "構造化面接AI統合 手順4で追加。subjectを明示していない項目はselfを期待値として扱う。self_misclassified_as_otherは特に重要(本人の危機がTier A固定応答をスキップしてしまう経路)。",
  },
  misclassified: misclassified.map((r) => ({
    text: r.text, true_label: r.trueLabel, predicted: r.predicted,
    error_tag: r.errorTag, classifier_reason: r.modelReason, used_model: r.usedModel,
  })),
  estimated_tokens: Math.ceil(estimatedChars / CHARS_PER_TOKEN),
  estimated_cost_note: "TEST_GEMINI_API_KEY(無料枠)での実行を想定。実費用は0円。有料枠で実行した場合はai.google.dev/gemini-api/docs/pricingの最新料金で見積もること。",
  // 上記はすべて集計値・失敗例だけの抜粋。「何を・どう判定して・何が返ってきたか」を
  // 正しく判定できた分も含めて全件確認できるよう、79件全ての生の入出力をここに残す
  // (2026年9月・検証一式のログ充実要望への対応)。
  all_results: results.map((r) => ({
    text: r.text,
    true_label: r.trueLabel, true_subject: r.trueSubject, true_tier_a: r.trueTierA,
    predicted: r.predicted, predicted_subject: r.predictedSubject, predicted_tier_a: r.predictedTierA,
    has_keyword_hit: r.hasKeywordHit,
    classifier_reason: r.modelReason,
    used_model: r.usedModel,
    stage: r.stage ?? undefined, decided_by: r.decidedBy ?? undefined,
    classifier_error: r.classifierError, error_tag: r.errorTag,
    correct: r.predicted === r.trueLabel,
  })),
};

writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
