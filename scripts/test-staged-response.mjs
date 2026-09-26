// ============================================================================
//  段階ごとの応答(危機検知の作り直し 第2段階・仮)のオフライン回帰テスト
//
//  実行: node scripts/test-staged-response.mjs(API・DB は使わない。費用なし)
//
//  確かめること
//   1. src/crisis-response.mjs の planSafetyTurn の状態の移り変わり
//      (段階1と見守り・見守り中の再サイン・分割した危機の応答・打ち消し・積み重なりの場合の止め方・
//       打ち消しのあとの再受け止め・危機の応答のあと・2回目以降の段階2・第三者・クロージングの例外)
//      2026年9月26日のペルソナテスト(B2・B5)で見つかった「同じ1通が毎ターン続く」「打ち消しのあとの
//      『だるい』程度の発言で重い2通目に進む」を、記録した判定の並びで再現して、起きないことを確かめる
//   2. 仮の文面が出力チェック(OUTPUT_NG)に引っかからないこと
//   3. Gemini の応答を差し替えて、classifyStaged と補助判定(打ち消し・先生についての答え)を確かめる
//      ・第三者の危機が段階2として記録され、risk・subject は以前の判定と変わらないこと
//      ・打ち消しは、並行した回が2回とも打ち消しのときだけ。エラーは安全側(打ち消しではない)
//   4. buildSystem / retrieve の文脈の配列化と、危機の応答のあとのインテークの停止
// ============================================================================

import {
  planSafetyTurn, judgeRetraction, judgeTeacherAnswer, assessSafetyTurn, WATCH_TURNS,
  CARE_LINE_PROVISIONAL, CRISIS_STEP1_PROVISIONAL, CRISIS_STEP2_PROVISIONAL, CRISIS_STEP3_PROVISIONAL,
  CRISIS_STEP4_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL, CRISIS_AGAIN_PROVISIONAL,
} from "../src/crisis-response.mjs";
import { classifyStaged } from "../src/classify.mjs";
import { checkOutput, buildSystem, retrieve } from "../src/generate.mjs";

let failed = 0;
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; return; }
  failed++;
  console.log(`  NG   ${name}${detail ? ` … ${detail}` : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 分類器の結果を手で作る(classifyStaged の戻り値と同じ形) ----
const det = (stage, decidedBy = [], { subject = "self", keywords = [], patterns = [] } = {}) =>
  ({ stage, subject, decidedBy, keywords, patterns, idiomExempted: [] });
const S0 = det(0);
const S1_WATCH = det(1, ["classifier_watch"]);
const S1_IDIOM = det(1, ["idiom"]);
const S1_ERROR = det(1, ["classifier_error"]);
const S2_KEYWORD = det(2, ["keyword"], { keywords: ["死にたい"] });
const S2_CLASSIFIER = det(2, ["classifier"]);
const S2_OTHER = det(2, ["classifier"], { subject: "other" });
const fresh = { watch_turns_left: 0, crisis_state: "none", crisis_trigger: null, care_shown: false, reentry_used: false, closing_state: "none" };

// ============================================================================
console.log("1. planSafetyTurn の状態の移り変わり");
// ============================================================================
{
  const p = planSafetyTurn({ staged: S0, state: fresh });
  check("段階0: 生成・カードなし・記録なし", p.action === "generate" && p.card === null && p.event === null && p.stage === 0);
}
{
  const p = planSafetyTurn({ staged: S1_WATCH, state: fresh });
  check("段階1: 見守り開始・気づかいのカード・Tier B の指示",
    p.action === "generate" && p.card === "care" && p.nextState.watch_turns_left === WATCH_TURNS
      && p.nextState.care_shown === true && p.event?.watch_event === "start" && eq(p.safetyContexts, ["tierB"]) && !p.notify);
  const p2 = planSafetyTurn({ staged: S1_WATCH, state: { ...fresh, care_shown: true } });
  check("段階1(気づかいの一言は出し済み): 折りたたみの窓口だけ", p2.card === "hotlines");
}
{
  const watching = { ...fresh, watch_turns_left: 3, care_shown: true };
  const p = planSafetyTurn({ staged: S1_WATCH, state: watching });
  check("見守り中の再サイン(watch)→ 段階2・1通目・積み重なり",
    p.stage === 2 && p.action === "fixed" && p.crisisStep === 1 && p.text === CRISIS_STEP1_PROVISIONAL
      && p.card === "hotlines" && p.notify && p.decidedBy.includes("watch_repeat")
      && p.nextState.crisis_state === "step1" && p.nextState.crisis_trigger === "accumulation"
      && p.nextState.watch_turns_left === 0 && p.event?.watch_event === "escalate");
  const p2 = planSafetyTurn({ staged: S1_IDIOM, state: watching });
  check("見守り中の再サイン(慣用表現)→ 段階2", p2.stage === 2 && p2.crisisStep === 1);
  const p3 = planSafetyTurn({ staged: S1_ERROR, state: watching });
  check("見守り中の分類器のエラー → 上げない(1ターン進める)",
    p3.stage === 1 && p3.action === "generate" && p3.nextState.watch_turns_left === 2 && p3.card === null);
  const p4 = planSafetyTurn({ staged: S0, state: { ...watching, watch_turns_left: 1 } });
  check("見守りの最後のターンが段階0 → 見守り終了を記録",
    p4.nextState.watch_turns_left === 0 && p4.event?.watch_event === "end" && p4.event?.stage === 0);
  const p5 = planSafetyTurn({ staged: S0, state: watching });
  check("見守り中の段階0 → 残りを1減らすだけ(記録なし)", p5.nextState.watch_turns_left === 2 && p5.event === null);
}
{
  const p = planSafetyTurn({ staged: S2_KEYWORD, state: fresh });
  check("キーワードの段階2 → 1通目(受け止めだけ+折りたたみの窓口)・直接のきっかけ",
    p.action === "fixed" && p.crisisStep === 1 && p.card === "hotlines" && p.notify && p.notifySubject === "self"
      && p.nextState.crisis_state === "step1" && p.nextState.crisis_trigger === "direct" && p.risk === "crisis");
}
{
  const step1 = { ...fresh, crisis_state: "step1", crisis_trigger: "direct" };
  const p = planSafetyTurn({ staged: S0, state: step1 });
  check("1通目のあと(直接のきっかけ)の返事が段階0でも → 2通目(危機カード)",
    p.action === "fixed" && p.crisisStep === 2 && p.text === CRISIS_STEP2_PROVISIONAL && p.card === "crisis"
      && p.nextState.crisis_state === "step2" && p.event?.risk === "none" && p.event?.stage === 2 && !p.notify);
  const pk = planSafetyTurn({ staged: S2_CLASSIFIER, state: step1 });
  check("1通目のあとの返事が段階2 → 2通目・通知する", pk.crisisStep === 2 && pk.notify && pk.event?.risk === "crisis");
}
{
  const step1acc = { ...fresh, crisis_state: "step1", crisis_trigger: "accumulation" };
  const p = planSafetyTurn({ staged: S0, state: step1acc });
  check("積み重なりの1通目への返事が段階0 → 2通目に進まず見守りに戻す(確認4)",
    p.action === "generate" && p.nextState.crisis_state === "paused1" && p.nextState.watch_turns_left === WATCH_TURNS
      && p.decidedBy.includes("accumulation_pause") && eq(p.safetyContexts, ["afterCrisis"]));
  const p2 = planSafetyTurn({ staged: S1_WATCH, state: step1acc });
  check("積み重なりの1通目への返事にもサイン → 2通目", p2.action === "fixed" && p2.crisisStep === 2);
}
{
  const p = planSafetyTurn({ staged: S0, state: { ...fresh, crisis_state: "step2", crisis_trigger: "direct" } });
  check("2通目のあと → 3通目(先生について)", p.crisisStep === 3 && p.text === CRISIS_STEP3_PROVISIONAL && p.card === null && p.nextState.crisis_state === "step3");
}
{
  const step3 = { ...fresh, crisis_state: "step3", crisis_trigger: "direct" };
  for (const [answer, text] of [["yes", CRISIS_STEP4_PROVISIONAL.yes], ["no", CRISIS_STEP4_PROVISIONAL.no], ["unclear", CRISIS_STEP4_PROVISIONAL.unclear]]) {
    const p = planSafetyTurn({ staged: S0, state: step3, teacherAnswer: answer });
    check(`3通目のあと(答え=${answer})→ 4通目・終了・見守らない`,
      p.crisisStep === 4 && p.text === text && p.nextState.crisis_state === "done"
        && p.nextState.watch_turns_left === 0 && p.event?.teacher_answer === answer && p.event?.watch_event === null);
  }
  const pn = planSafetyTurn({ staged: S0, state: step3, teacherAnswer: null });
  check("3通目への答えが判定できない → どちらでもない の一言", pn.text === CRISIS_STEP4_PROVISIONAL.unclear && pn.event?.teacher_answer === "unclear");
}
{
  const step1 = { ...fresh, crisis_state: "step1", crisis_trigger: "direct" };
  const p = planSafetyTurn({ staged: S2_CLASSIFIER, state: step1, retraction: { retraction: true } });
  check("1通目のあとの打ち消し → 段階1(見守り)・残りの文面は出さない",
    p.stage === 1 && p.action === "generate" && p.nextState.crisis_state === "paused1"
      && p.nextState.watch_turns_left === WATCH_TURNS && p.event?.retraction === true && p.card === null
      && eq(p.safetyContexts, ["retraction", "afterCrisis"]) && !p.notify);
  const pk = planSafetyTurn({ staged: S2_KEYWORD, state: step1, retraction: { retraction: true } });
  check("打ち消しでもキーワードがあれば → 強制判定を優先して2通目",
    pk.action === "fixed" && pk.crisisStep === 2 && pk.decidedBy.includes("retraction_ignored_keyword") && pk.event?.retraction === false);
  const pf = planSafetyTurn({ staged: S2_CLASSIFIER, state: step1, retraction: { retraction: false } });
  check("打ち消しでない → 2通目", pf.crisisStep === 2);
  const p3 = planSafetyTurn({ staged: S0, state: { ...step1, crisis_state: "step3" }, retraction: { retraction: true }, teacherAnswer: "no" });
  check("3通目のあとの打ち消し → 段階1・paused3", p3.stage === 1 && p3.nextState.crisis_state === "paused3");
}
{
  // 打ち消し等で止めたあと(paused)の段階2
  const paused1 = { ...fresh, crisis_state: "paused1", crisis_trigger: "direct" };
  const pw = planSafetyTurn({ staged: S1_WATCH, state: { ...paused1, watch_turns_left: 2 } });
  check("止めたあとの見守り中の再サイン → 再受け止め(受け止めだけの短い1通)・1回だけ",
    pw.stage === 2 && pw.action === "fixed" && pw.crisisStep === 6 && pw.text === CRISIS_AGAIN_PROVISIONAL && pw.card === null
      && pw.nextState.crisis_state === "again1" && pw.nextState.reentry_used === true && pw.notify
      && pw.decidedBy.includes("watch_repeat") && pw.decidedBy.includes("reentry"));
  const pc = planSafetyTurn({ staged: S2_CLASSIFIER, state: paused1 });
  check("止めたあとの分類器だけの危機 → 再受け止め", pc.crisisStep === 6 && pc.nextState.crisis_state === "again1");
  const pk = planSafetyTurn({ staged: S2_KEYWORD, state: paused1 });
  check("止めたあとのキーワード → 続きの2通目", pk.crisisStep === 2 && pk.nextState.crisis_state === "step2" && pk.nextState.reentry_used === false);
  const pu = planSafetyTurn({ staged: S2_CLASSIFIER, state: { ...paused1, reentry_used: true } });
  check("再受け止めを使ったあとの分類器だけの危機 → 続きの2通目", pu.crisisStep === 2);
  const ps = planSafetyTurn({ staged: S1_WATCH, state: { ...paused1, reentry_used: true } });
  check("再受け止めを使ったあとのサイン(見守り外)→ 生成だけ(カードなし・上げない)",
    ps.stage === 1 && ps.action === "generate" && ps.card === null && eq(ps.safetyContexts, ["tierB", "afterCrisis"]));
  const p2 = planSafetyTurn({ staged: S2_CLASSIFIER, state: { ...fresh, crisis_state: "paused2" } });
  check("止めたあと(2通目まで)の分類器だけの危機 → 再受け止め", p2.crisisStep === 6 && p2.nextState.crisis_state === "again2");
  const p3 = planSafetyTurn({ staged: S2_KEYWORD, state: { ...fresh, crisis_state: "paused3" } });
  check("止めたあと(3通目まで)のキーワード → 短い1通", p3.crisisStep === 5 && p3.nextState.crisis_state === "done" && p3.card === "crisis");
}
{
  // 再受け止め(again)への返事
  const again1 = { ...fresh, crisis_state: "again1", crisis_trigger: "accumulation", reentry_used: true };
  const ps = planSafetyTurn({ staged: S1_WATCH, state: again1 });
  check("再受け止めへの返事にもサイン → 続きの2通目", ps.crisisStep === 2 && ps.nextState.crisis_state === "step2");
  const p0 = planSafetyTurn({ staged: S0, state: again1 });
  check("再受け止めへの返事が段階0 → 止める(見守らない)",
    p0.action === "generate" && p0.nextState.crisis_state === "paused1" && p0.nextState.watch_turns_left === 0 && p0.decidedBy.includes("accumulation_pause"));
  const pr = planSafetyTurn({ staged: S2_CLASSIFIER, state: again1, retraction: { retraction: true } });
  check("再受け止めのあとの打ち消し → 止める(見守らない)", pr.stage === 1 && pr.nextState.crisis_state === "paused1" && pr.nextState.watch_turns_left === 0);
  const p3 = planSafetyTurn({ staged: S1_WATCH, state: { ...again1, crisis_state: "again3" } });
  check("再受け止め(3通目のあと)への返事にサイン → 短い1通", p3.crisisStep === 5 && p3.nextState.crisis_state === "done");
}
{
  // 危機の応答を終えたあと(done)
  const done = { ...fresh, crisis_state: "done", crisis_trigger: "direct", care_shown: true };
  const pd = planSafetyTurn({ staged: S2_KEYWORD, state: done });
  check("終えたあとのはっきりした危機 → 短い1通(危機カード)・見守らない",
    pd.crisisStep === 5 && pd.card === "crisis" && pd.nextState.crisis_state === "done" && pd.nextState.watch_turns_left === 0 && pd.notify);
  const ps = planSafetyTurn({ staged: S1_WATCH, state: { ...done, watch_turns_left: 2 } });
  check("終えたあとは、見守り中の再サインでも上げない(生成だけ)", ps.stage === 1 && ps.action === "generate" && !ps.decidedBy.includes("watch_repeat"));
  const p1 = planSafetyTurn({ staged: S1_WATCH, state: done });
  check("終えたあとの段階1 → Tier B と危機のあとの指示・カードなし・見守らない",
    eq(p1.safetyContexts, ["tierB", "afterCrisis"]) && p1.card === null && p1.nextState.watch_turns_left === 0);
  const p0 = planSafetyTurn({ staged: S0, state: done });
  check("終えたあとの段階0 → 危機のあとの指示を付けて生成", p0.action === "generate" && eq(p0.safetyContexts, ["afterCrisis"]));
}
{
  const p = planSafetyTurn({ staged: S2_OTHER, state: fresh });
  check("第三者の危機 → 生成(第三者の指示)・通知(other)・危機の応答は始めない",
    p.action === "generate" && eq(p.safetyContexts, ["thirdParty"]) && p.notify && p.notifySubject === "other"
      && p.subject === "other" && p.nextState.crisis_state === "none" && p.event?.stage === 2);
  const pw = planSafetyTurn({ staged: S2_OTHER, state: { ...fresh, watch_turns_left: 3 } });
  check("見守り中の第三者の危機 → 見守りは1ターン進めるだけ", pw.nextState.watch_turns_left === 2 && pw.action === "generate");
  const pf = planSafetyTurn({ staged: S2_OTHER, state: { ...fresh, crisis_state: "step1", crisis_trigger: "direct" } });
  check("危機の応答の途中の第三者の話 → 危機の応答を続ける", pf.crisisStep === 2);
}
{
  const closing = { ...fresh, closing_state: "awaiting_choice" };
  const owari = det(2, ["keyword"], { keywords: ["終わりにしたい"] });
  const p = planSafetyTurn({ staged: owari, state: closing });
  check("クロージングの問いかけへの「終わりにしたい」(キーワードだけ)→ 段階1(確認5)",
    p.stage === 1 && p.action === "generate" && p.decidedBy.includes("closing_exception") && !p.notify && p.card === "care");
  const pc = planSafetyTurn({ staged: det(2, ["keyword", "classifier"], { keywords: ["終わりにしたい"] }), state: closing });
  check("分類器も危機と判定していれば → 例外にしない(段階2)", pc.stage === 2 && pc.action === "fixed");
  const pk = planSafetyTurn({ staged: det(2, ["keyword"], { keywords: ["終わりにしたい", "死にたい"] }), state: closing });
  check("ほかのキーワードもあれば → 例外にしない", pk.stage === 2 && pk.action === "fixed");
  const pn = planSafetyTurn({ staged: owari, state: fresh });
  check("クロージングの問いかけの状態でなければ → 例外にしない", pn.stage === 2 && pn.action === "fixed");
  const pw = planSafetyTurn({ staged: owari, state: { ...closing, watch_turns_left: 3 } });
  check("見守り中のクロージングの例外 → 本人のサインとして数えない(上げない)", pw.stage === 1 && pw.action === "generate" && pw.nextState.watch_turns_left === 2);
}
{
  const p = planSafetyTurn({ staged: { ...S0, stage: undefined }, state: fresh });
  check("想定外の段階 → 段階1として扱う(段階0に落とさない)", p.stage === 1);
}

// ---- 2026年9月26日のペルソナテスト(B2・B5)の判定の並びを、新しい規則に通す ----
// 各ターン: [分類器まで含めた判定, 打ち消しの判定(危機の応答の途中のときに使う。記録の値), 3通目への答え]
function replay(turns) {
  let state = { ...fresh };
  const out = [];
  for (const [staged, retr, teacher] of turns) {
    const p = planSafetyTurn({ staged, state, retraction: retr == null ? null : { retraction: retr }, teacherAnswer: teacher ?? null });
    out.push(p);
    state = { ...state, ...p.nextState };
  }
  return out;
}
const fixedTexts = (ps) => ps.filter((p) => p.action === "fixed").map((p) => p.text);
const maxSameInARow = (ps) => {
  let best = 0, run = 0, prev = null;
  for (const p of ps) {
    const t = p.action === "fixed" ? p.text : null;
    run = t && t === prev ? run + 1 : t ? 1 : 0;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
};
{
  // B2(自己否定が続く子): T1〜T15 は分類器が毎回 watch(段階1)。T3 は打ち消し(2回とも)、T7 の3通目への答えは「無理」
  const W = S1_WATCH;
  const b2 = replay([[W], [W], [W, true], [W], [W], [W, false], [W, false, "no"], [W], [W], [W], [W], [W], [W], [W], [W]]);
  const steps = b2.map((p) => p.crisisStep ?? "-").join(",");
  check("B2 の並び: 同じ固定の文面が続けて2回出ない", maxSameInARow(b2) === 1, `何通目: ${steps}`);
  check("B2 の並び: 危機の応答を出し終えたあとは生成に戻る(T8〜T15 は固定の文面なし)",
    b2.slice(7).every((p) => p.action === "generate"), `何通目: ${steps}`);
  check("B2 の並び: 1通目 → 打ち消し → 再受け止め → 2通目 → 3通目 → 4通目", eq(b2.slice(0, 7).map((p) => p.crisisStep), [null, 1, null, 6, 2, 3, 4]), `何通目: ${steps}`);
}
{
  // B5(誇張表現を多用する子): T1「部活きつすぎて死ぬ」(分類器が危機)、T2 打ち消し、T4「だるい」(watch)、
  // T5 打ち消し、T6「恥ずかしすぎて消えたい」(慣用表現)、T9「課題多すぎて無理死ぬ」(分類器が危機)、T10 打ち消し
  const b5 = replay([[S2_CLASSIFIER], [S0, true], [S0], [S1_WATCH], [S0, true], [S1_IDIOM], [S0], [S0], [S2_CLASSIFIER], [S1_WATCH, true], [S0], [S0]]);
  const steps = b5.map((p) => p.crisisStep ?? "-").join(",");
  check("B5 の並び: 打ち消しのあとの「だるい」(T4)は重い2通目ではなく再受け止め", b5[3].crisisStep === 6, `何通目: ${steps}`);
  check("B5 の並び: 再受け止めを使ったあとの慣用表現(T6)では上げない", b5[5].action === "generate", `何通目: ${steps}`);
  check("B5 の並び: 固定の文面は3通まで(以前は7通)", fixedTexts(b5).length <= 3, `何通目: ${steps}`);
  check("B5 の並び: 同じ固定の文面が続けて2回出ない", maxSameInARow(b5) === 1, `何通目: ${steps}`);
}

// ============================================================================
console.log("2. 仮の文面が出力チェック(OUTPUT_NG)に引っかからない");
// ============================================================================
for (const [name, text] of [
  ["気づかいの一言", CARE_LINE_PROVISIONAL], ["1通目", CRISIS_STEP1_PROVISIONAL], ["2通目", CRISIS_STEP2_PROVISIONAL],
  ["3通目", CRISIS_STEP3_PROVISIONAL], ["4通目(前向き)", CRISIS_STEP4_PROVISIONAL.yes],
  ["4通目(後ろ向き)", CRISIS_STEP4_PROVISIONAL.no], ["4通目(どちらでもない)", CRISIS_STEP4_PROVISIONAL.unclear],
  ["2回目以降の短い1通", CRISIS_REPEAT_PROVISIONAL], ["再受け止め", CRISIS_AGAIN_PROVISIONAL],
]) {
  const hits = checkOutput(text);
  check(`${name}`, hits.length === 0, hits.join(", "));
}

// ============================================================================
console.log("3. Gemini の応答を差し替えて、判定の関数を確かめる");
// ============================================================================
const queues = { classifier: [], retraction: [], teacher: [] };
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
  const kind = sys.includes("安全判定器") ? "classifier"
    : sys.includes("打ち消す") ? "retraction"
      : sys.includes("学校の先生に話してみるとしたら") ? "teacher" : "other";
  const next = queues[kind]?.shift();
  if (!next) throw new Error(`差し替えの応答が足りない: ${kind}`);
  if (next.status) return { ok: false, status: next.status, text: async () => "差し替えたエラー" };
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }], usageMetadata: {} }),
  };
};
const vote = (risk, subject = "self") => ({ risk, subject, reason: "差し替え" });
// 1回の判定がエラーになるまでの呼び出し(再試行1回 × モデル2つ = 4回)
const failures = () => [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

{
  // 以前の判定(第三者の段階を上げなかった頃)の risk・subject と同じになることを確かめる
  const cases = [
    { name: "両方とも第三者の危機", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("crisis", "other")], risk: "crisis", subject: "other", stage: 2 },
    { name: "第三者の危機+第三者の watch", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("watch", "other")], risk: "crisis", subject: "other", stage: 2 },
    { name: "第三者の危機+本人の watch", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("watch", "self")], risk: "crisis", subject: "self", stage: 2 },
    { name: "本人の watch+none", text: "最近しんどい", votes: [vote("watch"), vote("none")], risk: "watch", subject: "self", stage: 1 },
    { name: "両方とも none", text: "部活の話", votes: [vote("none"), vote("none")], risk: "none", subject: "self", stage: 0 },
    { name: "キーワード+第三者の watch", text: "友達が死にたいって言ってる", votes: [vote("watch", "other"), vote("none", "other")], risk: "crisis", subject: "other", stage: 2 },
  ];
  for (const c of cases) {
    queues.classifier.push(...c.votes);
    const r = await classifyStaged(c.text, []);
    check(`classifyStaged: ${c.name} → risk=${c.risk}/${c.subject}・段階${c.stage}`,
      r.risk === c.risk && r.subject === c.subject && r.stage === c.stage,
      `実際: ${r.risk}/${r.subject}・段階${r.stage}・${r.decidedBy.join(",")}`);
  }
}
{
  queues.retraction.push({ retraction: true, reason: "a" }, { retraction: true, reason: "b" });
  check("打ち消し: 2回とも打ち消し → 打ち消し", (await judgeRetraction("冗談だよ", [])).retraction === true);
  queues.retraction.push({ retraction: true, reason: "a" }, { retraction: false, reason: "b" });
  check("打ち消し: 1回だけ → 打ち消しではない", (await judgeRetraction("冗談だよ", [])).retraction === false);
  queues.retraction.push({ retraction: false, reason: "a" }, { retraction: false, reason: "b" });
  check("打ち消し: 2回とも違う → 打ち消しではない", (await judgeRetraction("本気だよ", [])).retraction === false);
  // 並行した2回の呼び出しは交互に届くので、1回目=打ち消し、2回目=エラー(4回分)になるよう並べる
  queues.retraction.push({ retraction: true, reason: "a" }, ...failures());
  const rErr = await quiet(() => judgeRetraction("冗談だよ", []));
  check("打ち消し: 片方がエラー → 打ち消しではない(安全側)", rErr.retraction === false && !!rErr.error, JSON.stringify(rErr.error));
  queues.teacher.push({ answer: "yes", reason: "a" });
  check("先生についての答え: 前向き", (await judgeTeacherAnswer("話してみようかな", [])).answer === "yes");
  queues.teacher.push(...failures());
  check("先生についての答え: エラー → どちらでもない", (await quiet(() => judgeTeacherAnswer("うーん", []))).answer === "unclear");
}
{
  const step1 = { ...fresh, crisis_state: "step1", crisis_trigger: "direct" };
  const ctx = [{ role: "user", text: "もう全部終わらせたい" }, { role: "ai", text: CRISIS_STEP1_PROVISIONAL }];
  queues.classifier.push(vote("crisis"), vote("crisis"));
  queues.retraction.push({ retraction: true, reason: "a" }, { retraction: true, reason: "b" });
  const a = await assessSafetyTurn("いや冗談冗談、本気にしないで", ctx, step1);
  check("assessSafetyTurn: 1通目のあとの打ち消し(文脈で分類器は危機)→ 段階1", a.plan.stage === 1 && a.plan.nextState.crisis_state === "paused1");
  queues.classifier.push(vote("crisis"), vote("crisis"));
  queues.retraction.push({ retraction: true, reason: "a" }, { retraction: true, reason: "b" });
  const b = await assessSafetyTurn("死にたいとか冗談だよ", ctx, step1);
  check("assessSafetyTurn: 打ち消しの中にキーワード → 2通目", b.plan.crisisStep === 2);
  queues.classifier.push(vote("none"), vote("none"));
  const c = await assessSafetyTurn("部活の話なんだけど", [], fresh);
  check("assessSafetyTurn: 危機の応答の途中でなければ補助判定を呼ばない", c.retraction === null && c.teacher === null && c.plan.stage === 0);
  check("(差し替えの応答が余っていない)", queues.classifier.length === 0 && queues.retraction.length === 0 && queues.teacher.length === 0,
    JSON.stringify({ c: queues.classifier.length, r: queues.retraction.length, t: queues.teacher.length }));
}

// ============================================================================
console.log("4. buildSystem / retrieve の文脈の配列化と、危機の応答のあとのインテークの停止");
// ============================================================================
{
  const rows = [
    { id: "P1", src: "嶋石", cat: "principle", body: "原則", tags: [], weight: "any" },
    { id: "N1", src: "設", cat: "ng", lv: 3, body: "禁止", tags: [], weight: "any" },
    { id: "T31", src: "嶋", cat: "limit", body: "深掘りしない", tags: [], weight: "any" },
    { id: "T32", src: "嶋", cat: "limit", body: "突然切らない", tags: [], weight: "any" },
    { id: "D3", src: "設", cat: "limit", body: "二択で確認しない", tags: [], weight: "any" },
    { id: "D5", src: "設", cat: "resp", body: "第三者", tags: [], weight: "any" },
  ];
  const intake = { phase: "intake", closing_state: "none", recommended_mode: [] };
  const sysIntake = buildSystem(rows, [], "rapport", {}, 0, null, "tierB", intake);
  check("インテーク中(Tier B のみ)→ インテークの台本のまま", sysIntake.includes("# 現在のフェーズ:インテーク") && sysIntake.includes("曖昧な危機のサイン"));
  const sysAfter = buildSystem(rows, [], "rapport", {}, 0, null, ["tierB", "afterCrisis"], intake);
  check("インテーク中でも危機の応答のあと → 台本を止めて自由な進め方",
    !sysAfter.includes("# 現在のフェーズ:インテーク") && sysAfter.includes("# 進め方")
      && sysAfter.includes("曖昧な危機のサイン") && sysAfter.includes("危機の応答のあと"));
  const sysRetraction = buildSystem(rows, [], "rapport", {}, 0, null, ["retraction", "afterCrisis"], { phase: "phase2", closing_state: "none", recommended_mode: [] });
  check("打ち消しの指示と危機のあとの指示を両方入れる", sysRetraction.includes("打ち消し") && sysRetraction.includes("危機の応答のあと"));
  check("仮であることはプロンプトに書かない", !/仮の(文面|指示)|心理士の確認待ち/.test(sysRetraction + sysAfter));
  const ids = (ctx) => retrieve(rows, "こんにちは", "rapport", "visitor", undefined, ctx, []).map((k) => k.id);
  check("retrieve: 文脈1つ(文字列)は今まで通り", ids("thirdParty").includes("D5"));
  check("retrieve: 文脈の配列から知識を合わせて引く", ["T31", "T32", "D3"].every((id) => ids(["retraction", "afterCrisis"]).includes(id)));
}

console.log(`\n${failed === 0 ? "全件通過" : `失敗 ${failed}件`}(${passed + failed}件中)`);
process.exit(failed === 0 ? 0 : 1);
