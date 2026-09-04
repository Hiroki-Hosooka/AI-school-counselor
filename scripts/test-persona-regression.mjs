// ============================================================================
//  ペルソナ多ターン回帰テスト(docs/backlog.md 1-3 テスト4)
//  詳細仕様: docs/prompts/automated-testing-harness.md
//
//  実行: node scripts/test-persona-regression.mjs [--turns=10] [--persona=<id>]
//        (npm run test:persona-regression でも同じ)
//
//  やること
//   ・生徒役AI(LITE_MODELS。無料枠でよい)と相談AI本体(src/generate.mjsの
//     generateReply。PRIMARY_MODELS)を、ペルソナごとに複数ターン会話させる
//   ・sessions/messages に本番と同じ形で保存し、admin.html から通常の会話ログと
//     同様に閲覧できるようにする
//   ・実行時のナレッジ世代(sessions.knowledge_version)を記録する
//
//  安全上の配慮(route.ts本体・スキーマは変更していない):
//   ・client_id は "TEST-PERSONA-<persona>-<runId>" にする。実際の匿名UUIDとは
//     見た目からして違う文字列にすることで、admin.htmlの一覧で実データと
//     混同しないようにする(client_id_shortの先頭が"TEST-PER"になる)
//   ・危機分岐(classify()がcrisisを返した場合)は固定応答(CRISIS_REPLY)を
//     会話には残すが、notifyCrisis()もsafety_eventsへの書き込みも行わない。
//     合成ペルソナの発言で実際の学校スタッフに誤って通知が飛ぶ事態を避けるため
//     (CLAUDE.md 5.3の精神:相談本文を届けない、の逆側のリスクとして
//     「実在しない生徒の危機」を人に届けてしまわないこと)
//   ・person_memory は更新しない(一回きりの合成会話であり、引き継ぐ相手がいないため)
//
//  CLAUDE.md 5.10「Gemini無料枠は合成テスト専用」を守るため、本番の GEMINI_API_KEY とは
//  別の TEST_GEMINI_API_KEY を必須にしている。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKey, requireSupabaseEnv, sleep } from "./_lib/test-env.mjs";
import { LITE_MODELS, callGemini, parseJSON, classify, CRISIS_REPLY } from "../src/classify.mjs";
import {
  getDb, loadKnowledge, knowledgeVersion, retrieve, buildSystem, generateReply, applyTurnUpdate,
} from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

requireTestGeminiKey(ROOT);
requireSupabaseEnv(ROOT);

const turnsArg = process.argv.find((a) => a.startsWith("--turns="));
const TURNS = turnsArg ? Number(turnsArg.slice("--turns=".length)) : 10;

const personaArg = process.argv.find((a) => a.startsWith("--persona="));
const ONLY_PERSONA = personaArg ? personaArg.slice("--persona=".length) : null;

const setPathArg = process.argv.find((a) => a.startsWith("--set="));
const SET_PATH = setPathArg
  ? path.resolve(ROOT, setPathArg.slice("--set=".length))
  : path.join(ROOT, "docs/test-sets/persona-regression-personas.json");

const testSet = JSON.parse(readFileSync(SET_PATH, "utf8"));
let personas = testSet.items ?? [];
if (ONLY_PERSONA) personas = personas.filter((p) => p.id === ONLY_PERSONA);
if (!personas.length) {
  console.error("対象のペルソナがありません(--persona の値を確認してください)。");
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

function personaSystemPrompt(persona) {
  return `あなたはロールプレイで、学校のカウンセリングAI(スクールカウンセリング支援AI)と話す
中学生・高校生を演じます。docs/backlog.md 1-3(ペルソナ多ターン回帰テスト)用の合成テストです。

【この生徒の設定】
${persona.brief}

【ロールプレイのルール】
・あなたは「生徒」側です。カウンセリングAIの発言を受けて、この生徒らしい返答を1〜2文で返してください。
・AIであることや、ロールプレイであることには絶対に言及しないでください。
・設定に忠実に。不自然に協力的にならないでください(はぐらかす、黙り込むような素っ気なさ、
  話をそらす、なども設定次第でありえます)。

出力は次のJSON形式のみ。前後に説明や記号を付けないでください。
{"line": "生徒の発言本文"}`;
}

// 生徒役の1行を生成する。レート制限は間隔を空けて再試行。
// それ以外の失敗(ブロック等)はnullを返し、呼び出し側でそのペルソナの会話を打ち切る。
async function generatePersonaLine(system, contents, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await callGemini(LITE_MODELS, system, contents, 150);
      const line = String(parseJSON(raw).line ?? "").trim();
      if (line) return line;
      throw new Error("生徒役の発言が空でした");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("[RATE_LIMIT]") && attempt < maxAttempts) {
        const waitMs = 3000 * attempt;
        console.error(`    生徒役がレート制限、${waitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
        await sleep(waitMs);
        continue;
      }
      console.error("生徒役の発言生成に失敗しました:", e);
      return null;
    }
  }
  return null;
}

// 相談AI本体の生成。レート制限は間隔を空けて再試行。
async function generateWithRetry(system, messages, maxAttempts = 4) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await generateReply(system, messages);
    if (!result.generationFailed || result.failureCause !== "レート制限(429)") return result;
    if (attempt < maxAttempts) {
      const waitMs = 3000 * attempt;
      console.error(`    相談AIがレート制限、${waitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
      await sleep(waitMs);
    }
  }
  return result;
}

// 危機判定。レート制限は間隔を空けて再試行(ブロック等はそのまま記録する。テスト1と同じ考え方)。
async function classifyWithRetry(text, maxAttempts = 4) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await classify(text);
    if (!result.classifierError || !result.classifierError.startsWith("[RATE_LIMIT]")) return result;
    if (attempt < maxAttempts) {
      const waitMs = 3000 * attempt;
      console.error(`    分類器がレート制限、${waitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
      await sleep(waitMs);
    }
  }
  return result;
}

console.log(`ペルソナ: ${personas.map((p) => p.id).join(", ")} / ターン数: ${TURNS} / runId: ${runId}`);
console.log("(生徒役はLITE_MODELS、相談AI本体はPRIMARY_MODELSを使用。ともにTEST_GEMINI_API_KEY)\n");

const db = getDb();
const rows = await loadKnowledge(db);
const version = knowledgeVersion(rows);

const startedAt = new Date();
const personaReports = [];

for (const persona of personas) {
  const clientId = `TEST-PERSONA-${persona.id}-${runId}`;
  const personaSystem = personaSystemPrompt(persona);

  const { data: sessionRow, error: sessionErr } = await db.from("sessions")
    .insert({ client_id: clientId, knowledge_version: version })
    .select("id,weight,relation,turns_since_summary,notes").single();
  if (sessionErr || !sessionRow) {
    console.error(`[${persona.id}] セッション作成に失敗しました:`, sessionErr);
    continue;
  }
  const sessionId = sessionRow.id;
  console.log(`[${persona.id}] ${persona.label ?? ""} session=${sessionId} client_id=${clientId}`);

  let sessState = { weight: sessionRow.weight, relation: sessionRow.relation, turns_since_summary: sessionRow.turns_since_summary, notes: sessionRow.notes ?? {} };
  const history = []; // { speaker: 'student'|'counselor', text, crisis? }
  const turnLog = [];
  let crisisTurns = 0;
  let stoppedEarly = null;

  for (let turn = 1; turn <= TURNS; turn++) {
    const personaContents = history.length
      ? history.map((h) => ({ role: h.speaker === "counselor" ? "user" : "model", parts: [{ text: h.text }] }))
      : [{ role: "user", parts: [{ text: "(相談室に入ってきた場面です。最初の一言を話してください)" }] }];

    const studentText = await generatePersonaLine(personaSystem, personaContents);
    if (!studentText) { stoppedEarly = `turn${turn}: 生徒役の発言生成に失敗`; break; }

    await db.from("messages").insert({ session_id: sessionId, role: "user", body: studentText });
    history.push({ speaker: "student", text: studentText });
    process.stdout.write(`  [T${turn}] 生徒: ${studentText.slice(0, 24)}\n`);
    await sleep(1500);

    const safety = await classifyWithRetry(studentText);
    await sleep(1500);

    if (safety.risk === "crisis") {
      crisisTurns++;
      await db.from("messages").insert({
        session_id: sessionId, role: "ai", body: CRISIS_REPLY, crisis: true,
      });
      await db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId);
      history.push({ speaker: "counselor", text: CRISIS_REPLY, crisis: true });
      turnLog.push({ turn, student: studentText, crisis: true, counselor: CRISIS_REPLY });
      console.log(`  [T${turn}] → 危機分岐(固定応答。通知・safety_eventsへの記録は行っていません)`);
      continue;
    }

    const chunks = retrieve(rows, studentText, sessState.weight, sessState.relation);
    const system = buildSystem(rows, chunks, sessState.weight, sessState.notes, sessState.turns_since_summary, null);
    const counselorMessages = history
      .filter((h) => !h.crisis)
      .map((h) => ({ role: h.speaker === "student" ? "user" : "model", parts: [{ text: h.text }] }));

    const { out, flags } = await generateWithRetry(system, counselorMessages);
    const updated = applyTurnUpdate(sessState, out);

    await db.from("messages").insert({
      session_id: sessionId, role: "ai", body: out.reply,
      weight: updated.weight, relation: updated.relation,
      question_level: out.question_level, role_kind: out.role,
      summarized: out.did_summarize === true,
      hypothesis: out.hypothesis ?? null, why: out.why ?? null,
      used: out.used ?? chunks.map((c) => c.id), flags,
    });
    await db.from("sessions").update({
      weight: updated.weight, relation: updated.relation,
      turns_since_summary: updated.turns_since_summary, notes: updated.notes,
      last_at: new Date().toISOString(),
    }).eq("id", sessionId);

    sessState = updated;
    history.push({ speaker: "counselor", text: out.reply });
    turnLog.push({
      turn, student: studentText, counselor: out.reply,
      weight: updated.weight, relation: updated.relation,
      question_level: out.question_level, flags,
    });
    console.log(`  [T${turn}] AI: ${out.reply.slice(0, 30)} (weight=${updated.weight} relation=${updated.relation}${flags.length ? ` flags=${JSON.stringify(flags)}` : ""})`);
    await sleep(1500);
  }

  await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", sessionId);

  personaReports.push({
    persona: persona.id, label: persona.label ?? null,
    session_id: sessionId, client_id: clientId,
    turns_completed: turnLog.length, crisis_turns: crisisTurns,
    stopped_early: stoppedEarly,
    final_weight: sessState.weight, final_relation: sessState.relation,
    flagged_turns: turnLog.filter((t) => t.flags && t.flags.length).length,
    turn_log: turnLog,
  });
  console.log("");
}

const finishedAt = new Date();

console.log("=== まとめ ===");
console.log(`ナレッジ世代: ${version}`);
for (const r of personaReports) {
  console.log(`  [${r.persona}] session=${r.session_id} 完了${r.turns_completed}/${TURNS}ターン 危機分岐${r.crisis_turns}回 flags発生${r.flagged_turns}回 最終relation=${r.final_relation}${r.stopped_early ? ` (${r.stopped_early})` : ""}`);
}
console.log("\nadmin.html でセッションIDを検索するか、一覧から探して会話を確認してください。");

const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outPath = path.join(resultsDir, `persona-regression-${stamp}.json`);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  turns_requested: TURNS,
  knowledge_version: version,
  personas: personaReports,
}, null, 2));

console.log(`結果を保存しました: ${path.relative(ROOT, outPath)}`);
