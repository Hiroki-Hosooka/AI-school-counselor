// ============================================================================
//  関わりの型判定の安定性(docs/backlog.md 1-3 テスト3)
//  詳細仕様: docs/prompts/automated-testing-harness.md
//
//  実行: node scripts/test-relation-stability.mjs
//        (npm run test:relation-stability でも同じ)
//
//  やること
//   ・docs/test-sets/relation-stability-personas.json の各ペルソナの初回発言を、
//     本番と同じ生成ロジック(src/generate.mjs)に各10回通す
//   ・出てきた relation(visitor/complainant/customer)の多数決を取り、
//     多数決との一致率(揺れの少なさ)を算出する
//   ・揺れが大きかったペルソナの実例を残す
//
//  DBには書き込まない(単発生成の集計のみ)。
//  CLAUDE.md 5.10「Gemini無料枠は合成テスト専用」を守るため、本番の GEMINI_API_KEY とは
//  別の TEST_GEMINI_API_KEY を必須にしている。
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

const repeatsArg = process.argv.find((a) => a.startsWith("--repeats="));
const REPEATS = repeatsArg ? Number(repeatsArg.slice("--repeats=".length)) : 10;

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let personas = testSet.items ?? [];
if (LIMIT) personas = personas.slice(0, LIMIT);

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
console.log("");

const db = getDb();
const rows = await loadKnowledge(db);

const startedAt = new Date();
const perPersona = [];

for (const persona of personas) {
  const chunks = retrieve(rows, persona.text, BASELINE_WEIGHT, BASELINE_RELATION);
  const system = buildSystem(rows, chunks, BASELINE_WEIGHT, {}, 0, null);
  const messages = [{ role: "user", parts: [{ text: persona.text }] }];

  const relations = [];
  const generationFailures = [];

  process.stdout.write(`[${persona.id}] ${persona.label ?? ""} 「${persona.text.slice(0, 20)}...」 `);
  for (let i = 0; i < REPEATS; i++) {
    const { out, generationFailed, failureCause } = await generateWithRetry(system, messages);
    if (generationFailed) {
      generationFailures.push(failureCause);
      process.stdout.write("!");
    } else {
      const r = VALID_RELATIONS.includes(out.relation) ? out.relation : "(不正な値)";
      relations.push(r);
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
  });
}

const finishedAt = new Date();

console.log("\n=== ペルソナごとの一致率 ===");
for (const p of perPersona) {
  const rate = p.agreement_rate === null ? "—" : p.agreement_rate.toFixed(2);
  console.log(`  [${p.id}] 多数決=${p.majority_relation ?? "—"} 一致率=${rate} 内訳=${JSON.stringify(p.relation_counts)}`);
}

const overallRates = perPersona.map((p) => p.agreement_rate).filter((v) => v !== null);
const overallAvg = overallRates.length ? overallRates.reduce((a, b) => a + b, 0) / overallRates.length : null;
console.log(`\n平均一致率: ${overallAvg === null ? "—" : overallAvg.toFixed(2)}`);

const unstable = perPersona.filter((p) => p.agreement_rate !== null && p.agreement_rate < 0.7);
if (unstable.length) {
  console.log("\n=== 揺れが大きいペルソナ(一致率 < 0.7) ===");
  for (const p of unstable) {
    console.log(`  [${p.id}] ${p.label}: ${JSON.stringify(p.all_relations)}`);
  }
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
  repeats: REPEATS,
  overall_average_agreement_rate: overallAvg,
  per_persona: perPersona,
}, null, 2));

console.log(`\n結果を保存しました: ${path.relative(ROOT, outPath)}`);
