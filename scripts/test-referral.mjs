// ============================================================================
//  人につなぐ印のテスト(2026年11月9日。docs/design-referral-flag.md。オフライン)
//
//    node scripts/test-referral.mjs
//
//  1. 決まり(src/referral.mjs): 案の3章の5つの例・数えないもの・根拠の引用の確かめ・段階・指示・研究の指標
//  2. 画面と同じ API の経路(route.ts の POST をそのまま呼ぶ。DB はメモリ上の偽物。Gemini は模擬):
//     設定が無いときは判定しない / 本人が書いたターンだけ判定する / 会話全体で数えて印が付く / 印が付いたターンはまず聞く /
//     次のターンから指示が付く / 危機の流れでは指示を付けない / 断ったら勧めない / 段階は本人の言葉の引用で進む / 20節が無い DB でも止まらない
// ============================================================================
import path from "node:path";
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";
import {
  referralState, cleanReferralJudgment, referralBlock, referralMetrics, REFERRAL_JUDGE_PROMPT, REFERRAL_BLOCK_PROVISIONAL,
} from "../src/referral.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}`); } };
const cue = (kind, extra = {}) => ({ kind, evidence: "x", temporary: false, ...extra });

console.log("■ 決まり");
{
  // 案の3章の5つの例
  const ex = [
    ["2週間眠れず、ぼーっと、水も飲まない、大丈夫をくり返す", [{ cues: [cue("B"), cue("duration"), cue("D")] }, { cues: [cue("A"), cue("impact"), cue("denial")] }, { cues: [cue("denial")] }], 7, true],
    ["テスト前で眠れない", [{ cues: [cue("B", { temporary: true }), cue("short_term")] }], 0, false],
    ["仲間外れでつらい(期間・影響なし)", [{ cues: [cue("C")] }], 1, false],
    ["自己否定・長期・孤立", [{ cues: [cue("E"), cue("duration"), cue("no_support")] }], 3, false],
    ["1か月学校に行けていない", [{ cues: [cue("B"), cue("F"), cue("impact"), cue("duration"), cue("school_absence")] }], 5, true],
  ];
  for (const [name, recs, total, flagged] of ex) {
    const st = referralState(recs);
    ok(st.total === total && st.flagged === flagged, `例「${name}」: ${total}点・印${flagged ? "付く" : "付かない"}(${st.total}点・${st.flagged})`);
  }
  // 領域だけ・支えだけでは付かない
  ok(!referralState([{ cues: [cue("A"), cue("B"), cue("C"), cue("D"), cue("E")] }]).flagged, "領域だけでは、5点でも付かない");
  ok(!referralState([{ cues: [cue("no_support")] }, { cues: [cue("denial")] }, { cues: [cue("denial")] }]).flagged, "支えだけでは付かない");
  ok(referralState([{ cues: [cue("A"), cue("no_support")], watch: true }]).standalone.includes("watch_no_support"), "気がかり+相談できる人がいない は、それだけで付く");
  ok(referralState([{ cues: [cue("eating")] }]).flagged && referralState([{ cues: [cue("med_overuse")] }]).flagged, "食べること・薬の使いすぎは、それだけで付く");
  ok(referralState([{ cues: [cue("denial")] }]).supportScore === 0, "打ち消しは1回だけでは数えない(くり返されたら1点)");
  ok(referralState([{ cues: [cue("A")] }, { cues: [cue("A")] }, { cues: [cue("A")] }]).total === 1, "同じ領域は何度出ても1点");
  ok(referralState([{ cues: [cue("A"), cue("duration")] }], { distressLevel: 5 }).total === 3, "インテークのつらさ4・5は程度の1点");
  // 印が付いた時点と段階
  const st = referralState([{ cues: [cue("A")], stage: "aware" }, { cues: [cue("impact"), cue("B")] }, { cues: [], stage: "person" }]);
  ok(st.flagged && st.flaggedAt === 1 && st.startStage === 1 && st.stage === 2 && st.turnsSinceFlag === 1, `付いた時点・始まりの段階・今の段階(${st.flaggedAt}・${st.startStage}→${st.stage})`);
  ok(referralState([{ cues: [cue("A"), cue("impact"), cue("B")] }, { cues: [], stage: "declined" }]).declined, "断ったことを覚える");
  // 判定の出力の確かめ
  const cj = cleanReferralJudgment({
    cues: [{ kind: "B", evidence: "眠れない", about: "self", temporary: false }, { kind: "A", evidence: "楽しくない", about: "self", temporary: false },
      { kind: "C", evidence: "不安", about: "other", temporary: false }, { kind: "Z", evidence: "眠れない", about: "self", temporary: false }],
    stage_signal: "person", stage_evidence: "母になら話せる",
  }, "最近ずっと眠れない。母になら話せるかも");
  ok(cj.cues.length === 1 && cj.cues[0].kind === "B", "根拠の引用が今の発言に無い・本人以外・知らない種類は捨てる");
  ok(cj.stage === "person", "段階の合図は引用があれば採る");
  ok(cleanReferralJudgment({ cues: [], stage_signal: "plan", stage_evidence: "明日行く" }, "どうしよう").stage === "none", "段階の合図も、引用が無ければ採らない(AI の思い込みで進めない)");
  // 指示
  const flagged = referralState([{ cues: [cue("A"), cue("impact"), cue("B")] }]);
  const b0 = referralBlock(flagged, {});
  ok(b0.includes(REFERRAL_BLOCK_PROVISIONAL.listen), "印が付いたターンは、まず聞く(人につなぐ話はまだしない)");
  const b1 = referralBlock(referralState([{ cues: [cue("A"), cue("impact"), cue("B")] }, { cues: [] }]), { declinedPeople: ["先生"] });
  ok(b1.includes(REFERRAL_BLOCK_PROVISIONAL.stage[1]) && b1.includes("先生"), "次のターンから「気づく」の一歩。断った相手は挙げない");
  ok(referralBlock(referralState([{ cues: [cue("A"), cue("impact"), cue("B")], stage: "aware" }, { cues: [] }])).includes(REFERRAL_BLOCK_PROVISIONAL.stage[2]), "すでに気づいている人は「思い浮かぶ」から");
  ok(referralBlock(referralState([{ cues: [cue("A"), cue("impact"), cue("B")] }, { cues: [], stage: "declined" }])).includes(REFERRAL_BLOCK_PROVISIONAL.declined), "断ったら勧めない");
  ok(referralBlock(referralState([{ cues: [cue("A")] }])) === "", "印が無ければ指示を付けない");
  const common = REFERRAL_BLOCK_PROVISIONAL.common;
  ok(/病名を出さない/.test(common) && /2歩以上進めない/.test(common) && /電話番号は書かない/.test(common) && /相談者には言葉で示さない/.test(common), "共通の決まり(病名・2歩以上進めない・窓口を書かない・ゴールを示さない)");
  ok(!/いつでも/.test(Object.values(REFERRAL_BLOCK_PROVISIONAL).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))).join("")), "指示に「いつでも」を書かない");
  ok(/誇張や冗談/.test(REFERRAL_JUDGE_PROMPT) && /about=other/.test(REFERRAL_JUDGE_PROMPT) && /病名は書きません/.test(REFERRAL_JUDGE_PROMPT), "判定の指示に、数えないもの(誇張・第三者)と病名を書かないこと");
  const m = referralMetrics([{ flagged: true, start_stage: 0, stage: 2 }, { flagged: true, start_stage: 1, stage: 1 }, { flagged: true, start_stage: 1, stage: 3 }, { flagged: false }]);
  ok(m.flagged === 3 && m.advanced === 2 && m.reached2 === 2 && m.reached3 === 1, `研究の指標(${JSON.stringify(m)})`);
}

// ---------------------------------------------------------------------------
console.log("■ 画面と同じ API の経路(模擬)");
process.env.API_PATH_ROOT = ROOT;
process.env.SUPABASE_URL = "http://fake.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.CRISIS_WEBHOOK_URL = "http://webhook.invalid/hook";
process.env.DEV_PANEL = "on";
delete process.env.CRISIS_RESPONSE;
delete process.env.BATCH_MODE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 判定の模擬: 発言の言葉から手がかりを返す(根拠の引用は発言そのものから取る)
const RULES = [
  [/眠れない/, "B"], [/楽しくない/, "A"], [/ぼーっと/, "D"], [/学校(に)?行けて?ない/, "impact"], [/2週間|ずっと/, "duration"],
  [/大丈夫/, "denial"], [/話せる人(が|は)?いない/, "no_support"],
];
let judgeCalls = 0;
const systems = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://webhook.invalid")) return new Response("ok");
  const body = JSON.parse(init.body);
  const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  const last = body.contents?.[0]?.parts?.[0]?.text ?? "";
  let out;
  if (sys.startsWith("あなたは、学校の相談AIの記録係")) {
    judgeCalls++;
    const t = (last.match(/【今回の発言】\n([\s\S]*)$/)?.[1] ?? "").trim();
    const cues = RULES.filter(([re]) => re.test(t)).map(([re, kind]) => ({ kind, evidence: t.match(re)[0], about: "self", temporary: false }));
    const stage = /母になら/.test(t) ? ["person", "母になら"] : /今は(誰にも)?相談したくない/.test(t) ? ["declined", "相談したくない"] : ["none", ""];
    out = { cues, stage_signal: stage[0], stage_evidence: stage[1] };
  } else if (schema.risk) {
    const t = (last.match(/【判定する発言】\s*([\s\S]*)$/)?.[1] ?? last).trim();
    out = /死にたい/.test(t) ? { risk: "crisis", subject: "self", reason: "模擬", evidence: "死にたい" } : { risk: "none", subject: "self", reason: "模擬", evidence: "" };
  } else if (schema.reply_type || schema.answer) {
    out = schema.answer ? { answer: "unclear", declined: [], reason: "模擬" } : { reply_type: "other", figurative: false, reason: "模擬" };
  } else if (/出力形式/.test(sys)) {
    systems.push(sys);
    out = { reply: "そっか。そのとき、どんな感じだった?", weight: "rapport", relation: "visitor", question_level: "data", role: "listen", did_summarize: false, hypothesis: "", why: "", used: [], notes: {} };
  } else out = { summary: "模擬" };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
};
const KNOW = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8")).map((k) => ({
  id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [], body: k.text,
  updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
}));
const { POST } = await import(pathToFileURL(path.join(ROOT, "src/app/api/chat/route.ts")).href);
const call = async (p) => { const r = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(p) })); return { status: r.status, body: await r.json() }; };
let n = 0;
async function conv(missing = {}, opts = {}) {
  const db = createFakeDb({ knowledge: KNOW, missingColumns: missing });
  globalThis.__FAKE_DB__ = db;
  const clientId = `ref-${n++}`;
  const s = await call({ action: "start", client_id: clientId });
  // フェーズ2から始める(印の指示はインテーク中には付けない。下で別に確かめる)
  if (opts.phase !== "intake") Object.assign(db.tables.sessions.find((x) => x.id === s.body.session.id), { phase: "phase2", intake_step: "done", recommended_mode: ["LISTEN_ONLY"] });
  return { db, clientId, sessionId: s.body.session.id };
}
const say = (c, text, extra = {}) => call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, text, ...extra });
const lastSys = () => systems[systems.length - 1] ?? "";
const HEAD = "# 人につなぐことを、心にとめておく";

// 設定が無いときは判定しない
{
  delete process.env.REFERRAL_FLAG;
  const c = await conv();
  judgeCalls = 0;
  await say(c, "最近ずっと眠れない");
  ok(judgeCalls === 0 && !lastSys().includes(HEAD), "REFERRAL_FLAG が無いときは判定も指示もしない(既定は無効)");
  ok(!c.db.tables.messages.some((m) => m.referral), "記録もしない");
}
process.env.REFERRAL_FLAG = "on";
// 会話全体で数えて印が付く・まず聞く・次のターンから指示
{
  const c = await conv();
  judgeCalls = 0;
  await say(c, "最近ずっと眠れない");
  ok(judgeCalls === 1, `本人が書いたターンで判定する(${judgeCalls})`);
  const u1 = c.db.tables.messages.filter((m) => m.role === "user").at(-1);
  ok(u1.referral?.cues?.map((x) => x.kind).sort().join() === "B,duration", `発言の行に手がかりと引用を残す(${JSON.stringify(u1.referral?.cues)})`);
  ok(!lastSys().includes(HEAD), "まだ印は付かない(2点)");
  await say(c, "うん");
  ok(judgeCalls === 1, "短いあいづちでは判定しない");
  await say(c, "学校行けてないし、楽しくない");
  // 返事のあとにインテークの決まった問いの行が続くことがあるので、印の記録がある返事の行を見る
  const ai = c.db.tables.messages.filter((m) => m.role === "ai" && m.referral).at(-1);
  ok(ai.referral?.flagged === true && ai.referral.total === 5, `会話全体で数えて印が付く(${JSON.stringify(ai.referral)})`);
  ok(lastSys().includes(HEAD) && lastSys().includes(REFERRAL_BLOCK_PROVISIONAL.listen), "印が付いたターンは、まず聞く指示");
  ok((ai.flags ?? []).some((f) => f.startsWith("記録のみ:人につなぐ印")), "印の内訳を記録に残す");
  await say(c, "なんか疲れたんだよね、毎日");
  ok(lastSys().includes(REFERRAL_BLOCK_PROVISIONAL.stage[1]), "次のターンから「気づく」の一歩の指示");
  await say(c, "母になら話せるかも");
  await say(c, "でもまだ言えてない");
  ok(lastSys().includes(REFERRAL_BLOCK_PROVISIONAL.stage[3]), "本人が話せそうな人を挙げたら、次は「決まる」");
  const last = c.db.tables.messages.filter((m) => m.role === "ai" && m.referral).at(-1);
  ok(last.referral.start_stage === 0 && last.referral.stage === 2, `始まりの段階と今の段階を残す(${last.referral.start_stage}→${last.referral.stage})`);
  const res = await call({ action: "admin_session_detail", admin_token: "x", session_id: c.sessionId });
  ok(res.status === 401, "管理画面は合言葉で守られている");
}
// 断ったら勧めない
{
  const c = await conv();
  await say(c, "2週間眠れないし学校行けてない、楽しくない");
  await say(c, "今は相談したくない");
  ok(lastSys().includes(REFERRAL_BLOCK_PROVISIONAL.declined) && !lastSys().includes(REFERRAL_BLOCK_PROVISIONAL.stage[1]), "断ったら、その会話では勧めない");
}
// 危機の流れでは指示を付けない(危機が先)
{
  const c = await conv();
  await say(c, "2週間眠れないし学校行けてない、楽しくない");
  await say(c, "もう死にたい");
  ok(!lastSys().includes(HEAD), "本人の危機のターンには印の指示を付けない");
  await say(c, "うまく言えないけど、ずっと眠れない");
  ok(!lastSys().includes(HEAD), "危機のあとも印の指示を付けない");
  const ai = c.db.tables.messages.filter((m) => m.role === "ai" && m.referral).at(-1);
  ok(ai?.referral?.flagged === true, "印の記録は続ける");
}
// インテーク中は指示を付けない(記録は続ける)
{
  const c = await conv({}, { phase: "intake" });
  await say(c, "2週間眠れないし学校行けてない、楽しくない");
  await say(c, "うまく言えないけど、ずっとそう");
  ok(!lastSys().includes(HEAD), "インテーク中は印の指示を付けない(台本に混ぜない)");
  ok(c.db.tables.messages.some((m) => m.role === "ai" && m.referral?.flagged), "インテーク中も印の記録は続ける");
}
// 20節が無い DB
{
  const c = await conv({ messages: ["referral"] });
  const r = await say(c, "2週間眠れないし学校行けてない、楽しくない");
  ok(r.status === 200 && typeof r.body.reply === "string", "20節が無い DB でも会話は止まらない");
  ok(c.db.tables.messages.filter((m) => m.role === "ai").length >= 1, "返事は保存できる(列を外して書く)");
}

console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
