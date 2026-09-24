// ============================================================================
//  関わりの型・モード判定の安定性(docs/backlog.md 1-3 テスト3)
//  詳細仕様: docs/prompts/automated-testing-harness.md(旧・関わりの型部分)/
//            docs/prompts/structured-verification-suite.md テスト3(モード判定部分。2026年9月追加)
//
//  実行: node scripts/test-relation-stability.mjs
//        (npm run test:relation-stability でも同じ)
//
//  やること(2本立て)
//   1. docs/test-sets/relation-stability-personas.json の各ペルソナの初回発言を、
//      本番と同じ生成ロジック(src/generate.mjs)に各10回通す。
//      出てきた relation(visitor/complainant/customer)の多数決を取り、
//      多数決との一致率(揺れの少なさ)を算出する
//   2. docs/test-sets/mode-stability-intakes.json のインテーク4ターン分(主訴カテゴリ・
//      背景・つらさスケール・ゴール)が出そろった会話を、phase="intake"のまま
//      同じ生成ロジックに各10回通す。recommended_mode(複合可の配列)を、
//      ソートして結合した文字列に正規化したうえで1と同じ多数決ロジックにかけ、
//      判定の一致率を見る
//   いずれも揺れが大きかった例を残す
//
//  DBには書き込まない(単発生成の集計のみ)。
//  CLAUDE.md 5.10「Gemini無料枠は合成テスト専用」を守るため、本番の GEMINI_API_KEY とは
//  別の TEST_GEMINI_API_KEY を必須にしている。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, requireSupabaseEnv, withRateLimitRetry, createKeyRotationState, sleep, isTransientGenerateFailure } from "./_lib/test-env.mjs";
import { getDb, loadKnowledge, retrieve, buildSystem, generateReply, PRIMARY_MODELS } from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 複数キーのプール(2026年9月・検証一式)。TEST_GEMINI_API_KEYS(カンマ区切り)が
// あればそれを、無ければ単一のTEST_GEMINI_API_KEYを使う。KEY_ROTATIONは直近成功した
// キーの位置を覚えておくための状態(毎回キー1から試して消耗させないため)。
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const KEY_ROTATION = createKeyRotationState();
requireSupabaseEnv(ROOT);

// 新規セッションの初回発言という想定なので、db/schema.sql の sessions のデフォルトに合わせる。
// (retrieve() に渡す relation も、実際の"start"直後の値と同じ"visitor"にする。
//  これは「このペルソナが本来どの型か」ではなく、「初回はまだ何も分かっていない」という
//  本番の実際の状態を再現するため。CLAUDE.md 4節の通りrelationは会話の中で見えてくるもの)
const BASELINE_WEIGHT = "rapport";
const BASELINE_RELATION = "visitor";
const VALID_RELATIONS = ["visitor", "complainant", "customer"];

const setPathArg = process.argv.find((a) => a.startsWith("--set="));
const SET_PATH = setPathArg
  ? path.resolve(ROOT, setPathArg.slice("--set=".length))
  : path.join(ROOT, "docs/test-sets/relation-stability-personas.json");

// モード判定用の入力セット(2026年9月・検証一式テスト3の新規部分)。
const modeSetPathArg = process.argv.find((a) => a.startsWith("--mode-set="));
const MODE_SET_PATH = modeSetPathArg
  ? path.resolve(ROOT, modeSetPathArg.slice("--mode-set=".length))
  : path.join(ROOT, "docs/test-sets/mode-stability-intakes.json");

const repeatsArg = process.argv.find((a) => a.startsWith("--repeats="));
const REPEATS = repeatsArg ? Number(repeatsArg.slice("--repeats=".length)) : 10;

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

// --skip-relation / --skip-mode で片方だけ実行できる(動作確認・再実行時に便利)。
const SKIP_RELATION = process.argv.includes("--skip-relation");
const SKIP_MODE = process.argv.includes("--skip-mode");

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let personas = testSet.items ?? [];
if (LIMIT) personas = personas.slice(0, LIMIT);

const modeTestSet = JSON.parse(readFileSync(MODE_SET_PATH, "utf8"));
let intakePatterns = modeTestSet.items ?? [];
if (LIMIT) intakePatterns = intakePatterns.slice(0, LIMIT);

// MODES(src/generate.mjs)と同じ並び。ここでは検証専用に複製せず、実際の判定結果
// (out.intake.recommended_mode)をそのままソート・結合するだけなので複製不要。
function canonicalizeModes(modes) {
  const arr = Array.isArray(modes) ? modes.filter((m) => typeof m === "string" && m) : [];
  return arr.length ? [...arr].sort().join("+") : "(なし)";
}

async function generateWithRetry(system, messages) {
  return withRateLimitRetry(
    KEY_POOL,
    () => generateReply(system, messages),
    isTransientGenerateFailure,
    { state: KEY_ROTATION },
  );
}

function majorityVote(labels) {
  const counts = {};
  for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
  let best = null, bestCount = -1;
  for (const [label, count] of Object.entries(counts)) {
    if (count > bestCount) { best = label; bestCount = count; }
  }
  return { majority: best, counts };
}

console.log(`ペルソナセット: ${path.relative(ROOT, SET_PATH)}(${personas.length}件 × ${REPEATS}回)`);
console.log(`モード判定セット: ${path.relative(ROOT, MODE_SET_PATH)}(${intakePatterns.length}件 × ${REPEATS}回)`);
console.log(`生成モデル: ${PRIMARY_MODELS.join(" → ")}`);
console.log("");

// 実際に使われたモデルの内訳(検証一式・2026年9月)。attempts配列(used_model)から集計する。
function countBy(rows, fn) {
  const counts = {};
  for (const r of rows) {
    const v = fn(r);
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

const db = getDb();
const rows = await loadKnowledge(db);

const startedAt = new Date();
const perPersona = [];

for (const persona of (SKIP_RELATION ? [] : personas)) {
  const chunks = retrieve(rows, persona.text, BASELINE_WEIGHT, BASELINE_RELATION);
  const system = buildSystem(rows, chunks, BASELINE_WEIGHT, {}, 0, null);
  const messages = [{ role: "user", parts: [{ text: persona.text }] }];

  const relations = [];
  const generationFailures = [];
  // 集計値(all_relations)だけでなく、10回全ての生の応答も残す
  // (2026年9月・検証一式のログ充実要望への対応)。
  const attempts = [];

  process.stdout.write(`[${persona.id}] ${persona.label ?? ""} 「${persona.text.slice(0, 20)}...」 `);
  for (let i = 0; i < REPEATS; i++) {
    const { out, generationFailed, failureCause, usedModel } = await generateWithRetry(system, messages);
    if (generationFailed) {
      generationFailures.push(failureCause);
      attempts.push({ attempt: i + 1, generation_failed: true, failure_cause: failureCause ?? null });
      process.stdout.write("!");
    } else {
      const r = VALID_RELATIONS.includes(out.relation) ? out.relation : "(不正な値)";
      relations.push(r);
      attempts.push({
        attempt: i + 1, generation_failed: false, relation: r,
        reply: out.reply, hypothesis: out.hypothesis ?? "", why: out.why ?? "",
        used_model: usedModel, // 実際に採用された判定を生成したモデルID(検証一式)
      });
      process.stdout.write(r[0].toUpperCase());
    }
    if (i < REPEATS - 1) await sleep(1500);
  }
  console.log("");

  const { majority, counts } = majorityVote(relations);
  const agreementRate = relations.length ? (counts[majority] ?? 0) / relations.length : null;

  perPersona.push({
    id: persona.id, label: persona.label ?? null, text: persona.text,
    runs: REPEATS, valid_runs: relations.length,
    relation_counts: counts, majority_relation: majority,
    agreement_rate: agreementRate,
    generation_failures: generationFailures,
    all_relations: relations,
    models_used: countBy(attempts, (a) => a.used_model),
    attempts,
  });
}

// ----------------------------------------------------------------------------
// モード判定の安定性(2026年9月・検証一式テスト3の新規部分)。
// 各パターンの4ターン分の会話をそのまま履歴として渡し、intake引数には
// 「最後のターン(ゴールの回答)を処理する直前」の状態(主訴カテゴリ・背景・
// つらさスケールの3項目のみ)を渡す。これは本番でこの瞬間に実際にsessステートが
// 持っている内容と同じ(ゴールはまだ処理されておらず、直前のuserメッセージに
// 生のテキストとして含まれるのみ)。モデルは会話履歴からゴールの答えを読み取り、
// intake_complete=true と recommended_mode を出力することが期待される
// (src/generate.mjs buildIntakeBlockの指示どおり)。
// ----------------------------------------------------------------------------
const perIntake = [];

for (const pattern of (SKIP_MODE ? [] : intakePatterns)) {
  const messages = pattern.turns.map((t) => ({
    role: t.role === "model" ? "model" : "user",
    parts: [{ text: t.text }],
  }));
  const lastUserText = [...pattern.turns].reverse().find((t) => t.role === "user")?.text ?? "";

  const intakeArg = {
    phase: "intake",
    ...pattern.intake_before_final_turn,
  };
  const chunks = retrieve(rows, lastUserText, BASELINE_WEIGHT, BASELINE_RELATION);
  const system = buildSystem(rows, chunks, BASELINE_WEIGHT, {}, 0, null, null, intakeArg);

  const modeCombos = [];
  const generationFailures = [];
  const attempts = [];

  process.stdout.write(`[${pattern.id}] ${pattern.label ?? ""}(狙い:${pattern.target_mode_hint ?? "—"}) `);
  for (let i = 0; i < REPEATS; i++) {
    const { out, generationFailed, failureCause, usedModel } = await generateWithRetry(system, messages);
    if (generationFailed) {
      generationFailures.push(failureCause);
      attempts.push({ attempt: i + 1, generation_failed: true, failure_cause: failureCause ?? null });
      process.stdout.write("!");
    } else {
      const combo = canonicalizeModes(out.intake?.recommended_mode);
      modeCombos.push(combo);
      attempts.push({
        attempt: i + 1, generation_failed: false,
        recommended_mode: out.intake?.recommended_mode ?? [], mode_combo: combo,
        intake_complete: out.intake?.intake_complete === true,
        reply: out.reply, used_model: usedModel,
      });
      process.stdout.write(".");
    }
    if (i < REPEATS - 1) await sleep(1500);
  }
  console.log("");

  const { majority, counts } = majorityVote(modeCombos);
  const agreementRate = modeCombos.length ? (counts[majority] ?? 0) / modeCombos.length : null;
  const incompleteCount = attempts.filter((a) => !a.generation_failed && !a.intake_complete).length;

  perIntake.push({
    id: pattern.id, label: pattern.label ?? null, target_mode_hint: pattern.target_mode_hint ?? null,
    runs: REPEATS, valid_runs: modeCombos.length,
    mode_combo_counts: counts, majority_mode_combo: majority,
    agreement_rate: agreementRate,
    intake_incomplete_count: incompleteCount, // 期待に反し1ターンで完了しなかった件数
    generation_failures: generationFailures,
    all_mode_combos: modeCombos,
    models_used: countBy(attempts, (a) => a.used_model),
    attempts,
  });
}

const finishedAt = new Date();

console.log("\n=== 関わりの型: ペルソナごとの一致率 ===");
for (const p of perPersona) {
  const rate = p.agreement_rate === null ? "—" : p.agreement_rate.toFixed(2);
  console.log(`  [${p.id}] 多数決=${p.majority_relation ?? "—"} 一致率=${rate} 内訳=${JSON.stringify(p.relation_counts)}`);
}

const overallRates = perPersona.map((p) => p.agreement_rate).filter((v) => v !== null);
const overallAvg = overallRates.length ? overallRates.reduce((a, b) => a + b, 0) / overallRates.length : null;
console.log(`\n関わりの型 平均一致率: ${overallAvg === null ? "—" : overallAvg.toFixed(2)}`);

const unstable = perPersona.filter((p) => p.agreement_rate !== null && p.agreement_rate < 0.7);
if (unstable.length) {
  console.log("\n=== 関わりの型: 揺れが大きいペルソナ(一致率 < 0.7) ===");
  for (const p of unstable) {
    console.log(`  [${p.id}] ${p.label}: ${JSON.stringify(p.all_relations)}`);
  }
}

console.log("\n=== モード判定: パターンごとの一致率 ===");
for (const p of perIntake) {
  const rate = p.agreement_rate === null ? "—" : p.agreement_rate.toFixed(2);
  console.log(`  [${p.id}] 狙い=${p.target_mode_hint ?? "—"} 多数決=${p.majority_mode_combo ?? "—"} 一致率=${rate} 内訳=${JSON.stringify(p.mode_combo_counts)}`);
}

const modeOverallRates = perIntake.map((p) => p.agreement_rate).filter((v) => v !== null);
const modeOverallAvg = modeOverallRates.length
  ? modeOverallRates.reduce((a, b) => a + b, 0) / modeOverallRates.length : null;
console.log(`\nモード判定 平均一致率: ${modeOverallAvg === null ? "—" : modeOverallAvg.toFixed(2)}`);

const modeUnstable = perIntake.filter((p) => p.agreement_rate !== null && p.agreement_rate < 0.7);
if (modeUnstable.length) {
  console.log("\n=== モード判定: 揺れが大きいパターン(一致率 < 0.7) ===");
  for (const p of modeUnstable) {
    console.log(`  [${p.id}] ${p.label}: ${JSON.stringify(p.all_mode_combos)}`);
  }
}
const modeIncomplete = perIntake.filter((p) => p.intake_incomplete_count > 0);
if (modeIncomplete.length) {
  console.log("\n=== モード判定: 1ターンで完了しなかった件数がある例(参考) ===");
  for (const p of modeIncomplete) {
    console.log(`  [${p.id}] ${p.label}: ${p.intake_incomplete_count}/${p.runs}件`);
  }
}

const allAttempts = [...perPersona.flatMap((p) => p.attempts), ...perIntake.flatMap((p) => p.attempts)];
const globalModelsUsed = countBy(allAttempts, (a) => a.used_model);
console.log("\n=== 実際に使われたモデルの内訳(検証一式・両方合算) ===");
console.log(`  設定上のフォールバック順: ${PRIMARY_MODELS.join(" → ")}`);
for (const [m, c] of Object.entries(globalModelsUsed)) {
  console.log(`  ${m}: ${c}件${m === PRIMARY_MODELS[0] ? "" : "  ← フォールバックが発生"}`);
}

const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outPath = path.join(resultsDir, `relation-stability-${stamp}.json`);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  persona_set: path.relative(ROOT, SET_PATH),
  mode_set: path.relative(ROOT, MODE_SET_PATH),
  repeats: REPEATS,
  generation_models: PRIMARY_MODELS,
  model_usage: {
    counts: globalModelsUsed,
    note: "実際に採用された判定を生成したモデルIDごとの件数(検証一式・2026年9月。" +
      "関わりの型・モード判定の両方を合算)。generation_modelsは設定上のフォールバック順であり、" +
      "ここが2番目以降のモデルでも0件でなければ実行中にフォールバックが実際に発生したことを示す。",
  },
  relation_stability: {
    overall_average_agreement_rate: overallAvg,
    per_persona: perPersona,
  },
  mode_stability: {
    overall_average_agreement_rate: modeOverallAvg,
    note: "recommended_mode(複合可の配列)をソート・結合した文字列(mode_combo)に正規化し、" +
      "同じ内容のインテークに対する判定がどれだけ安定しているかを見る(検証一式・2026年9月)。" +
      "intake_incomplete_countは、本来この1ターンでintake_complete=trueになるはずが、" +
      "そうならなかった件数(0件が望ましい)。",
    per_intake_pattern: perIntake,
  },
}, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
