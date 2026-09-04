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
import { requireTestGeminiKey, requireSupabaseEnv, sleep } from "./_lib/test-env.mjs";
import { getDb, loadKnowledge, retrieve, buildSystem, generateReply } from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

requireTestGeminiKey(ROOT);
requireSupabaseEnv(ROOT);

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

// レート制限は間隔を空けて再試行する。生成失敗(レート制限)はやり直し、
// それ以外(ブロック等)はそのまま「生成失敗」として記録する。
async function generateWithRetry(system, messages, maxAttempts = 4) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await generateReply(system, messages);
    if (!result.generationFailed || result.failureCause !== "レート制限(429)") return result;
    if (attempt < maxAttempts) {
      const waitMs = 3000 * attempt;
      console.error(`    レート制限、${waitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
      await sleep(waitMs);
    }
  }
  return result;
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

console.log(`入力セット: ${path.relative(ROOT, SET_PATH)}(${items.length}件 × ${REPEATS}回)`);
console.log("");

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

  process.stdout.write(`[${item.id}] ${item.bait ?? ""} 「${item.text.slice(0, 20)}...」 `);
  for (let i = 0; i < REPEATS; i++) {
    const { out, flags } = await generateWithRetry(system, messages);
    const outcome = classifyOutcome(flags);
    outcomes[outcome]++;
    if (outcome === "still_flagged") {
      stillFlaggedExamples.push({ reply: out.reply, flags });
    }
    process.stdout.write(outcome === "clean" ? "." : outcome === "fixed_by_regen" ? "o" : outcome === "still_flagged" ? "X" : "!");
    if (i < REPEATS - 1) await sleep(1500);
  }
  console.log("");

  const detectedFirstPass = outcomes.fixed_by_regen + outcomes.still_flagged;
  perInput.push({
    id: item.id, bait: item.bait ?? null, text: item.text,
    runs: REPEATS, ...outcomes,
    detected_first_pass: detectedFirstPass,
    detection_rate: detectedFirstPass / REPEATS,
    still_flagged_examples: stillFlaggedExamples,
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
const outPath = path.join(resultsDir, `ng-leak-rate-${stamp}.json`);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  input_set: path.relative(ROOT, SET_PATH),
  repeats: REPEATS,
  totals,
  per_input: perInput,
}, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
