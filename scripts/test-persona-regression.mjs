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
import { requireTestGeminiKeyPool, requireSupabaseEnv, withRateLimitRetry, createKeyRotationState, sleep } from "./_lib/test-env.mjs";
import { LITE_MODELS, callGemini, parseJSON, classify, CRISIS_REPLY } from "../src/classify.mjs";
import {
  getDb, loadKnowledge, knowledgeVersion, retrieve, buildSystem, generateReply, PRIMARY_MODELS,
  applyTurnUpdate, applyIntakeUpdate, applyModeUpdate, applyClosingUpdate,
} from "../src/generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 複数キーのプール(2026年9月・検証一式)。TEST_GEMINI_API_KEYS(カンマ区切り)が
// あればそれを、無ければ単一のTEST_GEMINI_API_KEYを使う。
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
// 役割ごとに別々の状態を持つ(生徒役・相談AI本体・分類器で直近成功したキーの
// 位置がズレていても、お互いに干渉しないようにするため)。
const STUDENT_KEY_ROTATION = createKeyRotationState();
const COUNSELOR_KEY_ROTATION = createKeyRotationState();
const CLASSIFIER_KEY_ROTATION = createKeyRotationState();
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

// 生徒役の1行を生成する。レート制限は複数キーを切り替えながら再試行する
// (2026年9月。詳細はtest-env.mjsのwithRateLimitRetry参照)。
// それ以外の失敗(ブロック等)はnullを返し、呼び出し側でそのペルソナの会話を打ち切る。
// 戻り値は { line, model }(検証一式・2026年9月。callGemini()が{text, model}を返すようになった
// のに合わせ、実際に発言を生成したモデルIDもログに残せるようにする)。
async function generatePersonaLine(system, contents) {
  const result = await withRateLimitRetry(
    KEY_POOL,
    async () => {
      try {
        // thinkingBudgetは-1固定(LITE_MODELSは0を受け付けないため。src/classify.mjs参照)。
        // maxOutputTokensは150→800。-1(dynamic)は思考トークン消費が読めないため余裕を持たせた
        // (実際の生徒発言は1〜2文の短さのまま。src/classify.mjsのcallGemini()コメント参照)。
        const r = await callGemini(LITE_MODELS, system, contents, 800, -1);
        const line = String(parseJSON(r.text).line ?? "").trim();
        if (!line) return { ok: false, rateLimited: false, error: "生徒役の発言が空でした" };
        return { ok: true, line, model: r.model };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, rateLimited: msg.includes("[RATE_LIMIT]"), error: msg };
      }
    },
    (r) => !r.ok && r.rateLimited,
    { label: "生徒役: ", state: STUDENT_KEY_ROTATION },
  );
  if (!result.ok) {
    console.error("生徒役の発言生成に失敗しました:", result.error);
    return null;
  }
  return { line: result.line, model: result.model };
}

// 相談AI本体の生成。レート制限は複数キーを切り替えながら再試行する。
async function generateWithRetry(system, messages) {
  return withRateLimitRetry(
    KEY_POOL,
    () => generateReply(system, messages),
    (r) => r.generationFailed && r.failureCause === "レート制限(429)",
    { label: "相談AI: ", state: COUNSELOR_KEY_ROTATION },
  );
}

// 危機判定。レート制限は複数キーを切り替えながら再試行する(ブロック等はそのまま
// 記録する。テスト1と同じ考え方)。
async function classifyWithRetry(text) {
  return withRateLimitRetry(
    KEY_POOL,
    () => classify(text),
    (r) => !!r.classifierError && r.classifierError.startsWith("[RATE_LIMIT]"),
    { label: "分類器: ", state: CLASSIFIER_KEY_ROTATION },
  );
}

// 実際に使われたモデルの内訳(検証一式・2026年9月)。turnLog(student_model/classifier_model/
// counselor_model)から集計する。
function countBy(rows, fn) {
  const counts = {};
  for (const r of rows) {
    const v = fn(r);
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

// 人が読めるトークログ(検証一式・2026年9月。「AI同士の会話をログとして残す」要望への対応)。
// admin.htmlは要ログインでDB接続が要るため、ログインなしでもAI同士の生の会話を
// そのまま確認できるよう、結果JSONと同じ実行から、同じファイル名(拡張子だけ違う)で
// プレーンテキストの書き起こしを必ず残す。session_id/client_idを両方に載せることで、
// admin.htmlで見る実際のログと、このトークログ・結果JSONの3つを相互に照合できるようにする。
function buildTranscript({ startedAt, finishedAt, version, jsonFileName, personaReports, turnsRequested }) {
  const lines = [];
  lines.push("=".repeat(40));
  lines.push("検証一式 テスト4/5: ペルソナ多ターン回帰テスト トークログ");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`実行日時: ${startedAt.toISOString()}`);
  lines.push(`終了日時: ${finishedAt.toISOString()}`);
  lines.push(`ナレッジ世代: ${version}`);
  lines.push(`要求ターン数: ${turnsRequested}`);
  lines.push(`対応する結果JSON(裏側の判定・使用モデル等の全データ): ${jsonFileName}`);
  lines.push("admin.htmlでの確認: 下記の client_id で検索すると、実データと同じ形の会話ログを閲覧できます");
  lines.push("");

  for (const r of personaReports) {
    lines.push("-".repeat(40));
    lines.push(`[${r.persona}] ${r.label ?? ""}`);
    lines.push(`session_id: ${r.session_id}`);
    lines.push(`client_id : ${r.client_id}`);
    lines.push(
      `完了ターン: ${r.turns_completed}/${turnsRequested}  危機分岐: ${r.crisis_turns}回  ` +
      `禁止表現flags: ${r.flagged_turns}回${r.stopped_early ? `  途中終了: ${r.stopped_early}` : ""}`,
    );
    lines.push(
      `最終状態  : relation=${r.final_relation} phase=${r.final_phase}` +
      `${r.recommended_mode.length ? ` mode=${r.recommended_mode.join("+")}` : ""}` +
      `${r.final_closing_state !== "none" ? ` closing=${r.final_closing_state}` : ""}`,
    );
    lines.push("-".repeat(40));
    for (const t of r.turn_log) {
      lines.push(`T${t.turn} 生徒   [model=${t.student_model ?? "不明"}]: ${t.student}`);
      if (t.crisis) {
        lines.push(`T${t.turn} 相談AI [判定モデル=${t.classifier_model ?? "不明"}] → 危機分岐(固定応答):`);
        lines.push(`  ${t.counselor}`);
      } else {
        lines.push(
          `T${t.turn} 相談AI [model=${t.counselor_model ?? "不明"} weight=${t.weight} ` +
          `relation=${t.relation} question_level=${t.question_level}]: ${t.counselor}`,
        );
        if (t.flags && t.flags.length) lines.push(`  ⚠ flags: ${JSON.stringify(t.flags)}`);
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(40));
  lines.push("まとめ");
  lines.push("=".repeat(40));
  for (const r of personaReports) {
    lines.push(
      `[${r.persona}] session=${r.session_id} 完了${r.turns_completed}/${turnsRequested}ターン ` +
      `危機分岐${r.crisis_turns}回 flags発生${r.flagged_turns}回 最終relation=${r.final_relation} ` +
      `phase=${r.final_phase}${r.recommended_mode.length ? ` mode=${r.recommended_mode.join("+")}` : ""}` +
      `${r.final_closing_state !== "none" ? ` closing=${r.final_closing_state}` : ""}` +
      `${r.stopped_early ? ` (${r.stopped_early})` : ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

// startedAtから直接runIdを作る(2026年9月・検証一式のログ紐付け要望への対応)。
// 以前はrunIdを別のnew Date()から作っていたため、DBのclient_idに埋め込まれる
// runIdと、結果JSON/トークログのファイル名の時刻がずれ得た(数秒差だが、
// 人が見比べて照合するには不便だった)。同じstartedAtから両方を作ることで、
// admin.htmlで見るclient_id(TEST-PERSONA-<persona>-<runId>)と、
// docs/test-results/配下のファイル名が確実に対応するようにする。
const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 14);

console.log(`ペルソナ: ${personas.map((p) => p.id).join(", ")} / ターン数: ${TURNS} / runId: ${runId}`);
console.log(`生徒役モデル: ${LITE_MODELS.join(" → ")} / 相談AI本体モデル: ${PRIMARY_MODELS.join(" → ")}(ともにTEST_GEMINI_API_KEY)\n`);

const db = getDb();
const rows = await loadKnowledge(db);
const version = knowledgeVersion(rows);

const personaReports = [];

for (const persona of personas) {
  const clientId = `TEST-PERSONA-${persona.id}-${runId}`;
  const personaSystem = personaSystemPrompt(persona);

  // phase以下は構造化面接AI統合 手順5(フェーズ1インテーク)用。新規セッションは
  // db/schema.sqlのdefaultによりphase='intake'で作られる。
  const { data: sessionRow, error: sessionErr } = await db.from("sessions")
    .insert({ client_id: clientId, knowledge_version: version })
    .select("id,weight,relation,turns_since_summary,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state")
    .single();
  if (sessionErr || !sessionRow) {
    console.error(`[${persona.id}] セッション作成に失敗しました:`, sessionErr);
    continue;
  }
  const sessionId = sessionRow.id;
  console.log(`[${persona.id}] ${persona.label ?? ""} session=${sessionId} client_id=${clientId}`);

  let sessState = {
    weight: sessionRow.weight, relation: sessionRow.relation,
    turns_since_summary: sessionRow.turns_since_summary, notes: sessionRow.notes ?? {},
    phase: sessionRow.phase,
    chief_complaint_category: sessionRow.chief_complaint_category,
    onset_context: sessionRow.onset_context,
    distress_level: sessionRow.distress_level,
    physical_mental_symptoms: sessionRow.physical_mental_symptoms,
    user_goal: sessionRow.user_goal,
    ambivalence_detected: sessionRow.ambivalence_detected,
    recommended_mode: sessionRow.recommended_mode,
    closing_state: sessionRow.closing_state,
  };
  const history = []; // { speaker: 'student'|'counselor', text, crisis? }
  const turnLog = [];
  let crisisTurns = 0;
  let stoppedEarly = null;

  for (let turn = 1; turn <= TURNS; turn++) {
    const personaContents = history.length
      ? history.map((h) => ({ role: h.speaker === "counselor" ? "user" : "model", parts: [{ text: h.text }] }))
      : [{ role: "user", parts: [{ text: "(相談室に入ってきた場面です。最初の一言を話してください)" }] }];

    const studentResult = await generatePersonaLine(personaSystem, personaContents);
    if (!studentResult) { stoppedEarly = `turn${turn}: 生徒役の発言生成に失敗`; break; }
    const { line: studentText, model: studentModel } = studentResult;

    await db.from("messages").insert({ session_id: sessionId, role: "user", body: studentText });
    history.push({ speaker: "student", text: studentText });
    process.stdout.write(`  [T${turn}] 生徒: ${studentText.slice(0, 24)}\n`);
    await sleep(1500);

    const safety = await classifyWithRetry(studentText);
    await sleep(1500);

    // 構造化面接AI統合 手順4より、risk==="crisis"でもsubject==="self"のときだけ
    // 固定応答(route.tsと同じ分岐)。それ以外(watch/第三者)はsafetyContext付きで生成する。
    const isSelfCrisis = safety.risk === "crisis" && safety.subject === "self";
    if (isSelfCrisis) {
      crisisTurns++;
      await db.from("messages").insert({
        session_id: sessionId, role: "ai", body: CRISIS_REPLY, crisis: true,
      });
      await db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId);
      history.push({ speaker: "counselor", text: CRISIS_REPLY, crisis: true });
      turnLog.push({
        turn, student: studentText, student_model: studentModel,
        classifier_model: safety.usedModel, crisis: true, counselor: CRISIS_REPLY,
      });
      console.log(`  [T${turn}] → 危機分岐(本人・固定応答。通知・safety_eventsへの記録は行っていません。判定モデル=${safety.usedModel ?? "不明"})`);
      continue;
    }

    const safetyContext = safety.risk === "watch" ? "tierB"
      : (safety.risk === "crisis" && safety.subject === "other") ? "thirdParty"
      : null;
    const chunks = retrieve(
      rows, studentText, sessState.weight, sessState.relation, undefined, safetyContext,
      sessState.recommended_mode,
    );
    const system = buildSystem(
      rows, chunks, sessState.weight, sessState.notes, sessState.turns_since_summary, null,
      safetyContext, sessState,
    );
    const counselorMessages = history
      .filter((h) => !h.crisis)
      .map((h) => ({ role: h.speaker === "student" ? "user" : "model", parts: [{ text: h.text }] }));

    const { out, flags, usedModel: counselorModel } = await generateWithRetry(system, counselorMessages);
    const updated = applyTurnUpdate(sessState, out);
    // フェーズ1(インテーク)のスロット更新(構造化面接AI統合 手順5)。route.tsと同じ、
    // 差分(intakePatch)をsessionsへ、このターン時点の現在値(mergedIntake)をmessagesへ。
    // applyModeUpdate/applyClosingUpdate(手順6・7)はphase2の時だけ働く。それぞれ
    // 別のキーしか返さないので、route.tsと同じくそのままマージしてよい。
    const intakePatch = {
      ...applyIntakeUpdate(sessState, out), ...applyModeUpdate(sessState, out),
      ...applyClosingUpdate(sessState, out),
    };
    const mergedIntake = { ...sessState, ...intakePatch };
    const justClosed = intakePatch.closing_state === "closed";

    await db.from("messages").insert({
      session_id: sessionId, role: "ai", body: out.reply,
      weight: updated.weight, relation: updated.relation,
      question_level: out.question_level, role_kind: out.role,
      summarized: out.did_summarize === true,
      hypothesis: out.hypothesis ?? null, why: out.why ?? null,
      used: out.used ?? chunks.map((c) => c.id), flags,
      distress_level: mergedIntake.distress_level ?? null,
      mode: mergedIntake.recommended_mode ?? [],
      ambivalence_detected: mergedIntake.ambivalence_detected ?? null,
      closing: justClosed,
    });
    await db.from("sessions").update({
      weight: updated.weight, relation: updated.relation,
      turns_since_summary: updated.turns_since_summary, notes: updated.notes,
      last_at: new Date().toISOString(),
      ...intakePatch,
    }).eq("id", sessionId);

    sessState = { ...sessState, ...updated, ...intakePatch };
    history.push({ speaker: "counselor", text: out.reply });
    turnLog.push({
      turn, student: studentText, student_model: studentModel,
      classifier_model: safety.usedModel, counselor: out.reply, counselor_model: counselorModel,
      weight: updated.weight, relation: updated.relation,
      question_level: out.question_level, flags,
    });
    console.log(`  [T${turn}] AI: ${out.reply.slice(0, 30)} (weight=${updated.weight} relation=${updated.relation} phase=${mergedIntake.phase} model=${counselorModel ?? "不明"}${mergedIntake.closing_state && mergedIntake.closing_state !== "none" ? ` closing=${mergedIntake.closing_state}` : ""}${flags.length ? ` flags=${JSON.stringify(flags)}` : ""})`);
    await sleep(1500);
  }

  await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", sessionId);

  personaReports.push({
    persona: persona.id, label: persona.label ?? null,
    session_id: sessionId, client_id: clientId,
    turns_completed: turnLog.length, crisis_turns: crisisTurns,
    stopped_early: stoppedEarly,
    final_weight: sessState.weight, final_relation: sessState.relation,
    final_phase: sessState.phase, recommended_mode: sessState.recommended_mode ?? [],
    final_closing_state: sessState.closing_state ?? "none",
    flagged_turns: turnLog.filter((t) => t.flags && t.flags.length).length,
    models_used: {
      counselor: countBy(turnLog, (t) => t.counselor_model),
      classifier: countBy(turnLog, (t) => t.classifier_model),
      student: countBy(turnLog, (t) => t.student_model),
    },
    turn_log: turnLog,
  });
  console.log("");
}

const finishedAt = new Date();

console.log("=== まとめ ===");
console.log(`ナレッジ世代: ${version}`);
for (const r of personaReports) {
  console.log(`  [${r.persona}] session=${r.session_id} 完了${r.turns_completed}/${TURNS}ターン 危機分岐${r.crisis_turns}回 flags発生${r.flagged_turns}回 最終relation=${r.final_relation} phase=${r.final_phase}${r.recommended_mode.length ? ` mode=${r.recommended_mode.join("+")}` : ""}${r.final_closing_state !== "none" ? ` closing=${r.final_closing_state}` : ""}${r.stopped_early ? ` (${r.stopped_early})` : ""}`);
}
console.log("\nadmin.html でセッションIDを検索するか、一覧から探して会話を確認してください。");
console.log("(ログインなしで会話全文を見たい場合は、下記で保存するトークログ(.txt)も参照してください)");

// 全ペルソナ横断の、実際に使われたモデルの内訳(検証一式・2026年9月)。
const overallModelsUsed = { counselor: {}, classifier: {}, student: {} };
for (const p of personaReports) {
  for (const kind of ["counselor", "classifier", "student"]) {
    for (const [m, c] of Object.entries(p.models_used[kind])) {
      overallModelsUsed[kind][m] = (overallModelsUsed[kind][m] ?? 0) + c;
    }
  }
}
console.log("\n=== 実際に使われたモデルの内訳(検証一式・全ペルソナ合計) ===");
console.log(`  相談AI本体(設定順: ${PRIMARY_MODELS.join(" → ")}): ${JSON.stringify(overallModelsUsed.counselor)}`);
console.log(`  分類器(設定順: ${LITE_MODELS.join(" → ")}): ${JSON.stringify(overallModelsUsed.classifier)}`);
console.log(`  生徒役(設定順: ${LITE_MODELS.join(" → ")}): ${JSON.stringify(overallModelsUsed.student)}`);

const resultsDir = path.join(ROOT, "docs/test-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const jsonFileName = `persona-regression-${stamp}.json`;
const transcriptFileName = `persona-regression-${stamp}-transcript.txt`;
const outPath = path.join(resultsDir, jsonFileName);
const transcriptPath = path.join(resultsDir, transcriptFileName);

writeFileSync(outPath, JSON.stringify({
  run_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  elapsed_ms: finishedAt - startedAt,
  turns_requested: TURNS,
  knowledge_version: version,
  counselor_models: PRIMARY_MODELS,
  support_models: LITE_MODELS,
  // 人が読めるトークログ(検証一式・2026年9月)。同じ実行から、拡張子だけ違う
  // ファイル名で必ずペアで残す(buildTranscript参照)。
  transcript_file: transcriptFileName,
  model_usage: {
    counts: overallModelsUsed,
    note: "相談AI本体(counselor)・危機分類器(classifier)・生徒役(student)、それぞれ実際に" +
      "使われたモデルIDごとの件数(検証一式・2026年9月)。2番目以降のモデルが0件でなければ、" +
      "実行中にフォールバックが実際に発生したことを示す。",
  },
  personas: personaReports,
}, null, 2));

writeFileSync(transcriptPath, buildTranscript({
  startedAt, finishedAt, version, jsonFileName, personaReports, turnsRequested: TURNS,
}));

console.log(`結果(JSON)を保存しました  : ${path.relative(ROOT, outPath)}`);
console.log(`トークログ(txt)を保存しました: ${path.relative(ROOT, transcriptPath)}`);
