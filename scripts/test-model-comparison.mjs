// ============================================================================
//  モデル横断のコスト・パフォーマンス比較(2026年9月・ユーザー要望)
//
//  背景:年内(2026年)はGemini 3.6/3.7/3.8-flashが導入価格でgemini-3.5-flashより
//  大幅に安い(下記PRICING参照)。PRIMARY_MODELS(本生成)にどれを採用するかを、
//  勘ではなく実測(コスト・レイテンシ・禁止表現の漏れ率)で決めるための検証。
//
//  実行: node scripts/test-model-comparison.mjs [--limit=N] [--repeats=N]
//        (npm run test:model-comparison でも同じ)
//
//  やること
//   ・docs/test-sets/ng-leak-rate-inputs.json の入力(同調・励まし待ちの場面)を、
//     候補モデルそれぞれに単独で(フォールバック無効。generateReplyのmodels引数に
//     [そのモデルID]だけを渡す)既定10回ずつ通す
//   ・モデルごとに: 成功率・NG漏れ率(test-ng-leak-rate.mjsと同じ定義)・レイテンシ・
//     実際のトークン使用量(usageMetadata)・実コスト(ドル)を集計する
//   ・課金設定済みの単一キー(TEST_GEMINI_API_KEY_PAID)を使う。無料枠4本のプール
//     (TEST_GEMINI_API_KEYS)とは別管理(CLAUDE.md 5.10。合成データなので本番の
//     privacy上の懸念自体は無いが、無料枠は実運用でレート制限が厳しすぎたための
//     やむを得ない切り替え。詳細はCLAUDE.md 5.10の追記を参照)
//   ・DBには書き込まない(単発生成の集計のみ。test-ng-leak-rate.mjsと同じ)
//
//  対象モデル(2026年9月・実際にGemini ListModels APIで存在確認済み):
//    gemini-3.5-flash-lite / gemini-2.5-flash / gemini-3.1-flash-lite /
//    gemini-3.5-flash / gemini-3.6-flash / gemini-3.7-flash / gemini-3.8-flash
//  ※ユーザー指定の「3.1」に対応する無印のgemini-3.1-flash(非lite)は存在しない
//    (ListModelsで確認。3.1系はpro-previewとflash-liteのみ)。そのため
//    gemini-3.1-flash-liteで代替している。
//
//  価格(2026年9月・ai.google.dev/gemini-api/docs/pricing 実測。1Mトークンあたり・ドル):
//    3.6/3.7/3.8-flashは2026年内の導入価格(2027年1月から値上げ予定)。
//    thoughtsTokenCount(思考トークン)はGoogleの課金上「出力」として扱われるため、
//    コスト計算ではcandidatesTokenCountと合算している。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPaid, requireSupabaseEnv, withRateLimitRetry, createKeyRotationState, sleep, isTransientGenerateFailure, PRICING, costUsd } from "./_lib/test-env.mjs";
import { getDb, loadKnowledge, retrieve, buildSystem, generateReply } from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const KEY_POOL = requireTestGeminiKeyPaid(ROOT); // [paidKey] の1要素配列
const KEY_ROTATION = createKeyRotationState();
requireSupabaseEnv(ROOT);

// PRICING/costUsdはscripts/_lib/test-env.mjsに集約した(2026年9月・予算台帳導入時。
// 以前はここに重複して持っていた)。

// lite系はthinkingBudget:0(思考を完全に無効化)を受け付けず400になる
// (2026年9月・実機curl検証。src/classify.mjsのcallGeminiOnceのコメント参照)。
// -1(dynamic)を渡し、その分maxOutputTokensも大きめにする。
const CANDIDATE_MODELS = [
  { id: "gemini-3.5-flash-lite", lite: true },
  { id: "gemini-2.5-flash", lite: false },
  { id: "gemini-3.1-flash-lite", lite: true },
  { id: "gemini-3.5-flash", lite: false },
  { id: "gemini-3.6-flash", lite: false },
  { id: "gemini-3.7-flash", lite: false },
  { id: "gemini-3.8-flash", lite: false },
];

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

const modelsArg = process.argv.find((a) => a.startsWith("--models="));
const modelIds = modelsArg ? modelsArg.slice("--models=".length).split(",") : null;
const modelsToRun = modelIds ? CANDIDATE_MODELS.filter((m) => modelIds.includes(m.id)) : CANDIDATE_MODELS;

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let items = testSet.items ?? [];
if (LIMIT) items = items.slice(0, LIMIT);

function classifyOutcome(flags) {
  if (flags.length === 0) return "clean";
  if (flags[0].startsWith("生成失敗")) return "generation_failed";
  if (flags.length === 1 && flags[0] === "1回目に検知→再生成で解消") return "fixed_by_regen";
  return "still_flagged";
}

async function generateWithRetry(system, messages, model) {
  return withRateLimitRetry(
    KEY_POOL,
    () => generateReply(system, messages, [model.id], model.lite ? 2500 : 1500, model.lite ? -1 : 0),
    isTransientGenerateFailure,
    { state: KEY_ROTATION, label: `[${model.id}] ` },
  );
}

console.log(`入力セット: ${path.relative(ROOT, SET_PATH)}(${items.length}件 × ${REPEATS}回)`);
console.log(`対象モデル: ${modelsToRun.map((m) => m.id).join(", ")}`);
console.log("");

const db = getDb();
const rows = await loadKnowledge(db);
const chunks = retrieve(rows, "", BASELINE_WEIGHT, BASELINE_RELATION);
const system = buildSystem(rows, chunks, BASELINE_WEIGHT, {}, 0, null);

const startedAt = new Date();
const perModel = [];

for (const model of modelsToRun) {
  console.log(`\n### ${model.id} ###`);
  const perInput = [];
  for (const item of items) {
    const messages = [{ role: "user", parts: [{ text: item.text }] }];
    const outcomes = { clean: 0, fixed_by_regen: 0, still_flagged: 0, generation_failed: 0 };
    const attempts = [];

    process.stdout.write(`  [${item.id}] 「${item.text.slice(0, 16)}...」 `);
    for (let i = 0; i < REPEATS; i++) {
      const t0 = Date.now();
      const { out, flags, generationFailed, failureCause, usedModel, usage } =
        await generateWithRetry(system, messages, model);
      const latencyMs = Date.now() - t0;
      const outcome = classifyOutcome(flags);
      outcomes[outcome]++;
      attempts.push({
        attempt: i + 1, outcome, reply: out.reply, flags,
        generation_failed: generationFailed === true, failure_cause: failureCause ?? null,
        used_model: usedModel, latency_ms: latencyMs, usage: usage ?? null,
        cost_usd: usedModel ? costUsd(usage, usedModel) : 0,
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
      attempts,
    });
  }

  const allAttempts = perInput.flatMap((r) => r.attempts);
  const succeeded = allAttempts.filter((a) => !a.generation_failed);
  const totalCost = allAttempts.reduce((s, a) => s + a.cost_usd, 0);
  const totalIn = allAttempts.reduce((s, a) => s + (a.usage?.promptTokenCount ?? 0), 0);
  const totalOut = allAttempts.reduce((s, a) => s + (a.usage?.candidatesTokenCount ?? 0) + (a.usage?.thoughtsTokenCount ?? 0), 0);
  const avgLatency = succeeded.length ? succeeded.reduce((s, a) => s + a.latency_ms, 0) / succeeded.length : null;
  const maxLatency = succeeded.length ? Math.max(...succeeded.map((a) => a.latency_ms)) : null;
  const detectedTotal = perInput.reduce((s, r) => s + r.detected_first_pass, 0);
  const stillFlaggedTotal = perInput.reduce((s, r) => s + r.still_flagged, 0);
  const generationFailedTotal = perInput.reduce((s, r) => s + r.generation_failed, 0);

  const summary = {
    model: model.id,
    runs_total: allAttempts.length,
    success_count: succeeded.length,
    success_rate: succeeded.length / allAttempts.length,
    ng_detected_first_pass: detectedTotal,
    ng_detection_rate: succeeded.length ? detectedTotal / succeeded.length : null,
    ng_still_flagged_after_regen: stillFlaggedTotal,
    generation_failed: generationFailedTotal,
    avg_latency_ms: avgLatency,
    max_latency_ms: maxLatency,
    total_input_tokens: totalIn,
    total_output_tokens_incl_thinking: totalOut,
    total_cost_usd: totalCost,
    avg_cost_usd_per_call: totalCost / allAttempts.length,
  };
  console.log(`  → 成功率${(summary.success_rate * 100).toFixed(0)}% / NG検知率${summary.ng_detection_rate == null ? "N/A" : (summary.ng_detection_rate * 100).toFixed(0) + "%"} / 平均${Math.round(avgLatency ?? 0)}ms / 合計$${totalCost.toFixed(4)}`);

  perModel.push({ summary, per_input: perInput });
}

const finishedAt = new Date();

console.log("\n\n=== モデル横断サマリ ===");
console.log(
  "model".padEnd(24) + "成功率".padEnd(8) + "NG検知率".padEnd(10) +
  "平均ms".padEnd(9) + "input$/1M".padEnd(11) + "output$/1M".padEnd(12) + "合計$".padEnd(9) + "1件あたり$",
);
for (const { summary: s } of perModel) {
  const price = PRICING[s.model];
  console.log(
    s.model.padEnd(24) +
    `${(s.success_rate * 100).toFixed(0)}%`.padEnd(8) +
    (s.ng_detection_rate == null ? "N/A".padEnd(10) : `${(s.ng_detection_rate * 100).toFixed(0)}%`.padEnd(10)) +
    `${Math.round(s.avg_latency_ms ?? 0)}`.padEnd(9) +
    `${price.in}`.padEnd(11) + `${price.out}`.padEnd(12) +
    `${s.total_cost_usd.toFixed(4)}`.padEnd(9) +
    `${s.avg_cost_usd_per_call.toFixed(5)}`,
  );
}

const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outPath = path.join(resultsDir, `model-comparison-${stamp}.json`);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  input_set: path.relative(ROOT, SET_PATH),
  repeats: REPEATS,
  models: modelsToRun.map((m) => m.id),
  pricing_source: "https://ai.google.dev/gemini-api/docs/pricing (2026年9月時点。3.6/3.7/3.8-flashは2026年内導入価格)",
  per_model: perModel,
}, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
