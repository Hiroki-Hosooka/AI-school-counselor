// ============================================================================
//  禁止表現の漏れ率(docs/backlog.md 1-3 テスト2)
//  詳細仕様: docs/prompts/automated-testing-harness.md
//
//  実行: node scripts/test-ng-leak-rate.mjs
//        (npm run test:ng-leak でも同じ)
//
//  やること
//   ・docs/test-sets/ng-leak-rate-inputs.json の入力(同調・励まし待ちの場面)を、
//     本番と同じ生成ロジック(src/generate.mjs の generateReply())に各10回通す
//   ・出力チェック(OUTPUT_NG)の検知率を集計し、
//     「1回目で検知→再生成で解消」と「再生成でも直らなかった」を分けて数える
//   ・DBには書き込まない(単発生成の集計のみ。会話ログとしては残さない)
//
//  CLAUDE.md 5.10「Gemini無料枠は合成テスト専用」を守るため、本番の GEMINI_API_KEY とは
//  別の TEST_GEMINI_API_KEY を必須にしている。ナレッジの読み込みだけは本番と同じ
//  SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY を使う(ナレッジは要配慮個人情報ではないため)。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPaid, requireSupabaseEnv, withRateLimitRetry, createKeyRotationState, sleep, isTransientGenerateFailure, costUsd } from "./_lib/test-env.mjs";
import { getDb, loadKnowledge, retrieve, buildSystem, generateReply, PRIMARY_MODELS } from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// このテストの生成呼び出しは全てPRIMARY_MODELS(相談AI本体)なので、課金設定済みの
// 単一キーを使う(2026年9月。モデル比較検証・テスト3と同じ判断。本番と同じ課金枠で
// 測るのが本来の姿なうえ、無料枠は過去にレート制限で完走できなかったため)。
const KEY_POOL = requireTestGeminiKeyPaid(ROOT);
const KEY_ROTATION = createKeyRotationState();
requireSupabaseEnv(ROOT);

// PRICING/costUsdはscripts/_lib/test-env.mjsに集約した(2026年9月・予算台帳導入時)。

// 初回セッションと同じ基準値(db/schema.sql の sessions のデフォルトに合わせる)。
// 「同一の入力」を単発で試すテストなので、会話履歴・人単位の記憶は使わない。
const BASELINE_WEIGHT = "rapport";
const BASELINE_RELATION = "visitor";

const setPathArg = process.argv.find((a) => a.startsWith("--set="));
const SET_PATH = setPathArg
  ? path.resolve(ROOT, setPathArg.slice("--set=".length))
  : path.join(ROOT, "docs/test-sets/ng-leak-rate-inputs.json");

const repeatsArg = process.argv.find((a) => a.startsWith("--repeats="));
const REPEATS = repeatsArg ? Number(repeatsArg.slice("--repeats=".length)) : 10;

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let items = testSet.items ?? [];
if (LIMIT) items = items.slice(0, LIMIT);

// レート制限は複数キーを切り替えながら再試行する(2026年9月。詳細はtest-env.mjsの
// withRateLimitRetry参照)。生成失敗(レート制限)はやり直し、それ以外(ブロック等)は
// そのまま「生成失敗」として記録する。
async function generateWithRetry(system, messages) {
  return withRateLimitRetry(
    KEY_POOL,
    () => generateReply(system, messages),
    isTransientGenerateFailure,
    { state: KEY_ROTATION },
  );
}

// flags の形から、この1回の結果を分類する。
// (generateReplyの仕様。CLAUDE.md 5.1のOUTPUT_NG正規表現自体は変更していない)
//   flags = []                          → 検知なし(クリーン)
//   flags = ["1回目に検知→再生成で解消"]  → 検知→再生成で解消
//   flags = [<実際の正規表現一致>, ...]   → 再生成しても直らなかった(または未再生成)
//   flags[0] が "生成失敗→..." で始まる    → 生成そのものが失敗(NG漏れの計測対象外)
function classifyOutcome(flags) {
  if (flags.length === 0) return "clean";
  if (flags[0].startsWith("生成失敗")) return "generation_failed";
  if (flags.length === 1 && flags[0] === "1回目に検知→再生成で解消") return "fixed_by_regen";
  return "still_flagged";
}

// 人が読める詳細ログ(検証一式・2026年9月)。JSONと同じ実行から、拡張子だけ違う
// ファイル名でペアで残す(test-relation-stability.mjs/test-persona-regression.mjsと同じ考え方)。
function buildSummaryText({ startedAt, finishedAt, jsonFileName, perInput, totals, totalCostUsd, globalModelsUsed }) {
  const lines = [];
  lines.push("=".repeat(40));
  lines.push("検証一式 テスト2: 禁止表現の漏れ率 詳細ログ");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`実行日時: ${startedAt.toISOString()}`);
  lines.push(`終了日時: ${finishedAt.toISOString()}`);
  lines.push(`対応する結果JSON(全試行の生データ): ${jsonFileName}`);
  lines.push(`実コスト合計: $${totalCostUsd.toFixed(4)}(課金キー)`);
  lines.push("");

  for (const r of perInput) {
    lines.push("-".repeat(40));
    lines.push(`[${r.id}] ${r.bait ?? ""} 「${r.text}」`);
    lines.push(`  検知${r.detected_first_pass}/${r.runs}(解消${r.fixed_by_regen}・未解消${r.still_flagged}・生成失敗${r.generation_failed})`);
    lines.push(`  使用モデル: ${JSON.stringify(r.models_used)}`);
    for (const a of r.attempts) {
      if (a.generation_failed) {
        lines.push(`    #${a.attempt} [失敗:${a.failure_cause}]`);
      } else {
        lines.push(`    #${a.attempt} [${a.used_model ?? "不明"}] outcome=${a.outcome} cost=$${(a.cost_usd ?? 0).toFixed(5)}`);
        lines.push(`         reply: ${a.reply}`);
        if (a.flags.length) lines.push(`         flags: ${JSON.stringify(a.flags)}`);
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(40));
  lines.push("全体まとめ");
  lines.push("=".repeat(40));
  lines.push(`総実行回数: ${totals.runs}`);
  lines.push(`検知(1回目): ${totals.fixed_by_regen + totals.still_flagged} / ${totals.runs}(解消${totals.fixed_by_regen}・未解消${totals.still_flagged})`);
  lines.push(`生成失敗: ${totals.generation_failed}`);
  lines.push(`使用モデル内訳: ${JSON.stringify(globalModelsUsed)}`);
  lines.push(`実コスト合計: $${totalCostUsd.toFixed(4)}`);

  return lines.join("\n") + "\n";
}

console.log(`入力セット: ${path.relative(ROOT, SET_PATH)}(${items.length}件 × ${REPEATS}回)`);
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
const chunks = retrieve(rows, "", BASELINE_WEIGHT, BASELINE_RELATION);
const system = buildSystem(rows, chunks, BASELINE_WEIGHT, {}, 0, null);

const startedAt = new Date();
const perInput = [];

for (const item of items) {
  const messages = [{ role: "user", parts: [{ text: item.text }] }];
  const outcomes = { clean: 0, fixed_by_regen: 0, still_flagged: 0, generation_failed: 0 };
  const stillFlaggedExamples = [];
  // 集計値だけでなく、10回全ての生の入出力を残す(2026年9月・検証一式の
  // ログ充実要望への対応)。「検知されず正常に通った回」の実際の応答も、
  // 誤って検知しすぎていないかを人が読んで確認できるようにするため。
  const attempts = [];

  process.stdout.write(`[${item.id}] ${item.bait ?? ""} 「${item.text.slice(0, 20)}...」 `);
  for (let i = 0; i < REPEATS; i++) {
    const { out, flags, generationFailed, failureCause, usedModel, usage } = await generateWithRetry(system, messages);
    const outcome = classifyOutcome(flags);
    outcomes[outcome]++;
    if (outcome === "still_flagged") {
      stillFlaggedExamples.push({ reply: out.reply, flags });
    }
    attempts.push({
      attempt: i + 1, outcome, reply: out.reply, flags,
      generation_failed: generationFailed === true, failure_cause: failureCause ?? null,
      used_model: usedModel, // 実際に採用された返答を生成したモデルID(検証一式)
      usage: usage ?? null, cost_usd: costUsd(usage, usedModel), // 実コスト(課金キー。2026年9月)
    });
    process.stdout.write(outcome === "clean" ? "." : outcome === "fixed_by_regen" ? "o" : outcome === "still_flagged" ? "X" : "!");
    if (i < REPEATS - 1) await sleep(500); // 課金プロジェクトはRPM上限が高いため無料枠より短くしている
  }
  console.log("");

  const detectedFirstPass = outcomes.fixed_by_regen + outcomes.still_flagged;
  perInput.push({
    id: item.id, bait: item.bait ?? null, text: item.text,
    runs: REPEATS, ...outcomes,
    detected_first_pass: detectedFirstPass,
    detection_rate: detectedFirstPass / REPEATS,
    still_flagged_examples: stillFlaggedExamples,
    models_used: countBy(attempts, (a) => a.used_model),
    attempts,
  });
}

const finishedAt = new Date();

console.log("\n=== 入力ごとの検知率 ===");
for (const r of perInput) {
  console.log(`  [${r.id}] 検知${r.detected_first_pass}/${r.runs}(解消${r.fixed_by_regen}・未解消${r.still_flagged}・生成失敗${r.generation_failed}) 「${r.text.slice(0, 30)}」`);
}

const totals = perInput.reduce((a, r) => ({
  runs: a.runs + r.runs,
  clean: a.clean + r.clean,
  fixed_by_regen: a.fixed_by_regen + r.fixed_by_regen,
  still_flagged: a.still_flagged + r.still_flagged,
  generation_failed: a.generation_failed + r.generation_failed,
}), { runs: 0, clean: 0, fixed_by_regen: 0, still_flagged: 0, generation_failed: 0 });

console.log("\n=== 全体 ===");
console.log(`  総実行回数: ${totals.runs}`);
console.log(`  検知(1回目): ${totals.fixed_by_regen + totals.still_flagged} / ${totals.runs}`);
console.log(`    うち再生成で解消: ${totals.fixed_by_regen}`);
console.log(`    うち再生成でも直らず: ${totals.still_flagged}`);
console.log(`  生成失敗(集計対象外): ${totals.generation_failed}`);

const allAttempts = perInput.flatMap((r) => r.attempts);
const globalModelsUsed = countBy(allAttempts, (a) => a.used_model);
console.log("\n=== 実際に使われたモデルの内訳(検証一式) ===");
console.log(`  設定上のフォールバック順: ${PRIMARY_MODELS.join(" → ")}`);
for (const [m, c] of Object.entries(globalModelsUsed)) {
  console.log(`  ${m}: ${c}件${m === PRIMARY_MODELS[0] ? "" : "  ← フォールバックが発生"}`);
}

const totalCostUsd = allAttempts.reduce((s, a) => s + (a.cost_usd ?? 0), 0);
console.log(`\n実コスト合計: $${totalCostUsd.toFixed(4)}(課金キー。1回あたり平均$${(totalCostUsd / allAttempts.length).toFixed(5)})`);

const stillFlaggedTotal = perInput.flatMap((r) => r.still_flagged_examples.map((e) => ({ id: r.id, ...e })));
if (stillFlaggedTotal.length) {
  console.log("\n=== 再生成でも直らなかった例(抜粋。プロンプト改善の材料) ===");
  for (const e of stillFlaggedTotal.slice(0, 10)) {
    console.log(`  [${e.id}] 「${e.reply}」 flags=${JSON.stringify(e.flags)}`);
  }
}

const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const jsonFileName = `ng-leak-rate-${stamp}.json`;
const summaryFileName = `ng-leak-rate-${stamp}-detail.txt`;
const outPath = path.join(resultsDir, jsonFileName);
const summaryPath = path.join(resultsDir, summaryFileName);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  input_set: path.relative(ROOT, SET_PATH),
  repeats: REPEATS,
  generation_models: PRIMARY_MODELS,
  detail_log_file: summaryFileName,
  total_cost_usd: totalCostUsd,
  model_usage: {
    counts: globalModelsUsed,
    note: "実際に採用された返答を生成したモデルIDごとの件数(検証一式・2026年9月)。" +
      "generation_modelsは設定上のフォールバック順であり、ここが2番目以降のモデルでも" +
      "0件でなければ実行中にフォールバックが実際に発生したことを示す。",
  },
  totals,
  per_input: perInput,
}, null, 2));

writeFileSync(summaryPath, buildSummaryText({
  startedAt, finishedAt, jsonFileName, perInput, totals, totalCostUsd, globalModelsUsed,
}));

console.log(`\n結果(JSON)を保存しました  : ${path.relative(ROOT, outPath)}`);
console.log(`詳細ログ(txt)を保存しました: ${path.relative(ROOT, summaryPath)}`);
