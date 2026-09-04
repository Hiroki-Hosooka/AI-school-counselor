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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// --------------------------------------------------------------------------
// .env.local / .env を軽く読む(Next.js相当。依存パッケージを増やさないため自前実装)
// --------------------------------------------------------------------------
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));
loadEnvFile(path.join(ROOT, ".env"));

// --------------------------------------------------------------------------
// 本番キーとの分離(CLAUDE.md 5.10)。フォールバックしない。
// --------------------------------------------------------------------------
const TEST_KEY = process.env.TEST_GEMINI_API_KEY;
if (!TEST_KEY) {
  console.error("TEST_GEMINI_API_KEY が設定されていません。");
  console.error("本番の GEMINI_API_KEY とは別の、合成テスト専用のキーを用意してください(CLAUDE.md 5.10)。");
  console.error(".env.local に TEST_GEMINI_API_KEY=... を追加するか、環境変数として渡してください。");
  process.exit(1);
}
process.env.GEMINI_API_KEY = TEST_KEY;

const { classify, LITE_MODELS } = await import("../src/classify.mjs");
const { CRISIS_WORDS } = await import("../src/safety.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function classifyWithRetry(text, maxAttempts = 4) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await classify(text);
    if (!result.classifierError || !result.classifierError.startsWith("[RATE_LIMIT]")) {
      return result;
    }
    if (attempt < maxAttempts) {
      const waitMs = 3000 * attempt;
      console.error(`  レート制限、${waitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
      await sleep(waitMs);
    }
  }
  return result; // 最終試行後もレート制限のままなら、その結果をそのまま記録する
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
console.log("");

const startedAt = new Date();
const results = [];
let estimatedChars = 0;

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const hasKeywordHit = CRISIS_WORDS.some((w) => item.text.includes(w));
  process.stdout.write(`[${i + 1}/${items.length}] ${item.label.padEnd(6)} 「${item.text.slice(0, 24)}...」 `);

  const r = await classifyWithRetry(item.text);
  estimatedChars += item.text.length + (r.model?.reason?.length ?? 0);

  const tag = errorTag(r.classifierError);
  console.log(`→ ${r.risk}${tag ? `(${tag})` : ""}`);

  results.push({
    text: item.text,
    trueLabel: item.label,
    predicted: r.risk,
    hasKeywordHit,
    classifierError: r.classifierError,
    errorTag: tag,
    modelReason: r.model?.reason ?? null,
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
// レポート出力
// --------------------------------------------------------------------------
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
  overall: {
    accuracy,
    macro_precision: macroAvg(perClass, "precision"),
    macro_recall: macroAvg(perClass, "recall"),
    macro_f1: macroAvg(perClass, "f1"),
  },
  per_class: perClass,
  confusion_matrix: confusion,
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
  misclassified: misclassified.map((r) => ({
    text: r.text, true_label: r.trueLabel, predicted: r.predicted,
    error_tag: r.errorTag, classifier_reason: r.modelReason,
  })),
  estimated_tokens: Math.ceil(estimatedChars / CHARS_PER_TOKEN),
  estimated_cost_note: "TEST_GEMINI_API_KEY(無料枠)での実行を想定。実費用は0円。有料枠で実行した場合はai.google.dev/gemini-api/docs/pricingの最新料金で見積もること。",
};

writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
