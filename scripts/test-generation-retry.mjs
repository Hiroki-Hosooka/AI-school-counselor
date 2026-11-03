// ============================================================================
//  生成に失敗したときの作り直しのテスト(2026年11月4日。docs/generation-format-error-20261104.md。オフライン)
//
//    node scripts/test-generation-retry.mjs
//
//  画面と同じ API の経路(route.ts の POST をそのまま呼ぶ。DB はメモリ上の偽物)で、生成の失敗をわざと起こして確かめる。
//  ・形の崩れ(返事の途中で切れた JSON)・長さの上限・安全フィルター・429 → 返事を保存せず pending_retry を返す(固定の一言を出さない)
//  ・失敗の記録(AI が返した出力・終わった理由・モデル・場面)が発言の行に残る。失敗の種類の印が残る
//  ・retry_seq で作り直す → 返事は1つだけ。2回目は already(返事を二重にしない)。発言も二重にしない
//  ・待つあいだに書き足した発言 → そちらの返事に、前の発言も含めて作る。古い作り直しは already / superseded
//  ・返事の欄が閉じていれば、形が崩れていても返事だけを取り出す(記録のみ)
//  ・1回目が形の崩れで、作り直しで通る → 返事を出し、失敗の記録は AI の返事の行に残る
//  ・本人の危機(危機のターンの生成)の失敗 → 今までどおり固定の文と窓口のカード(第4部は対象外)
//  ・18節が無い DB でも止まらない
// ============================================================================
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";
import { failureKindOf } from "../src/generate.mjs";
import { salvageReply } from "../src/classify.mjs";
import { GENERATION_WAIT_NOTICE_PROVISIONAL } from "../src/notices.mjs";
import { CONTEXT_FAILURE_REPLIES_PROVISIONAL } from "../src/crisis-response.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${label}`); } };

// ---------------------------------------------------------------------------
console.log("■ 決まり(オフライン)");
{
  ok(failureKindOf(new Error("x"), "MAX_TOKENS") === "長さの上限", "MAX_TOKENS は長さの上限");
  ok(failureKindOf(new Error("x"), "SAFETY") === "安全フィルター", "SAFETY は安全フィルター");
  ok(failureKindOf(new Error("応答をJSONとして読み取れませんでした"), "STOP") === "形の崩れ", "読み取れない JSON は形の崩れ");
  ok(failureKindOf(new Error("[RATE_LIMIT] 429"), null) === "利用上限(429)", "429");
  ok(failureKindOf(new Error("[TIMEOUT] 8000ms"), null) === "時間切れ", "時間切れ");
  ok(salvageReply('{"reply":"そっか。\\n何があったの？","weight":"rap') === "そっか。\n何があったの？", "返事の欄が閉じていれば取り出す");
  ok(salvageReply('{"reply":"そっか。何があっ') === null, "返事の途中で切れていれば取り出さない");
}

// ---------------------------------------------------------------------------
console.log("■ 画面と同じ API の経路(注入した失敗)");
process.env.API_PATH_ROOT = ROOT;
process.env.SUPABASE_URL = "http://fake.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.CRISIS_WEBHOOK_URL = "http://webhook.invalid/hook";
process.env.DEV_PANEL = "on";
delete process.env.BATCH_MODE;
delete process.env.CRISIS_RESPONSE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 生成の答え方を、呼び出しごとに決める(先頭から順に使い、空なら ok)
//   ok / cut(返事の途中で切れる・MAX_TOKENS)/ cutAfterReply(返事の欄は閉じている)/ safety / rate / garbled(STOP で崩れた形)
const plan = [];
const genInputs = [];
let webhook = 0;
const realFetch = globalThis.fetch;
const GOOD = {
  reply: "そっか。いちばん気になっているのは、どのあたり？", weight: "rapport", relation: "visitor", question_level: "data", role: "listen",
  did_summarize: false, hypothesis: "", why: "模擬", used: [], notes: {},
  intake: { chief_complaint_category: 6, onset_context: null, distress_level: null, user_goal: null, intake_complete: false },
};
const gem = (text, finishReason = "STOP") => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56, totalTokenCount: 1290 }, modelVersion: "mock",
}), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://webhook.invalid")) { webhook++; return new Response("ok"); }
  if (!u.includes("generativelanguage.googleapis.com")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  const system = body.systemInstruction?.parts?.[0]?.text ?? "";
  const kind = schema.risk ? "classifier" : (schema.reply_type || schema.answer) ? "other" : /出力形式/.test(system) ? "generate" : "other";
  const lastText = body.contents?.[0]?.parts?.[0]?.text ?? "";
  if (kind === "classifier") {
    const t = (lastText.match(/【判定する発言】\s*([\s\S]*)$/)?.[1] ?? lastText).trim();
    return gem(JSON.stringify(/死にたい/.test(t) ? { risk: "crisis", subject: "self", reason: "模擬", evidence: "死にたい" }
      : { risk: "none", subject: "self", reason: "模擬" }));
  }
  if (kind === "other") {
    return gem(JSON.stringify(schema.answer ? { answer: "unclear", declined: [], reason: "模擬" }
      : schema.reply_type ? { reply_type: "other", figurative: false, reason: "模擬" } : { summary: "模擬" }));
  }
  genInputs.push(body.contents ?? []);
  const step = plan.shift() ?? "ok";
  if (step === "cut") return gem('{"reply":"そっか、それはしんどかったね。いちばん気になっ', "MAX_TOKENS");
  if (step === "cutAfterReply") return gem('{"reply":"そっか。いちばん気になっているのは、どのあたり？","weight":"rapp', "MAX_TOKENS");
  if (step === "garbled") return gem("そっか。いちばん気になっているのは", "STOP");
  if (step === "safety") return new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 });
  if (step === "rate") return new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), { status: 429 });
  return gem(JSON.stringify(GOOD));
};

const knowledge = (await import("node:fs")).default.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8");
const KNOW = JSON.parse(knowledge).map((k) => ({
  id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [],
  body: k.text, updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
}));
const { POST } = await import(pathToFileURL(path.join(ROOT, "src/app/api/chat/route.ts")).href);
const call = async (payload) => {
  const res = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(payload) }));
  return { status: res.status, body: await res.json() };
};
let n = 0;
async function newConversation(missing = {}) {
  const db = createFakeDb({ knowledge: KNOW, missingColumns: missing });
  globalThis.__FAKE_DB__ = db;
  const clientId = `retry-${Date.now().toString(36)}${(n++).toString(36)}`;
  const start = await call({ action: "start", client_id: clientId });
  return { db, clientId, sessionId: start.body.session?.id };
}
const chat = (c, text, extra = {}) => call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, text, ...extra });
const retry = (c, seq) => call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, retry_seq: seq });
const rows = (c) => c.db.tables.messages.filter((m) => m.session_id === c.sessionId);
const ai = (c) => rows(c).filter((m) => m.role === "ai");
const users = (c) => rows(c).filter((m) => m.role === "user");
const OLD_FAIL_TEXTS = Object.values(CONTEXT_FAILURE_REPLIES_PROVISIONAL).flat().map((x) => (typeof x === "string" ? x : x?.text ?? "")).filter(Boolean);
const usesOldText = (c) => ai(c).some((m) => OLD_FAIL_TEXTS.some((t) => t && m.body?.includes(t)) || /ちゃんと受け取っているよ/.test(m.body ?? ""));
const t0 = Date.now();

// 1. 形が崩れたまま(3回とも)→ 作り直し待ち。作り直しで返事。2回目は already
{
  console.log("  1. 形の崩れが続く → 作り直し待ち → 作り直しで返事");
  const c = await newConversation();
  plan.length = 0; plan.push("cut", "cut", "cut");
  const r = await chat(c, "最近ちょっと学校のことで考えてて");
  ok(r.status === 200 && r.body.pending_retry === true, `作り直し待ちを返す(${JSON.stringify(r.body).slice(0, 120)})`);
  ok(r.body.notice === GENERATION_WAIT_NOTICE_PROVISIONAL, "待っていてね、の一言(仮)");
  ok(typeof r.body.user_seq === "number", "どの発言かの番号を返す");
  ok(ai(c).length === 0, "AI の返事は保存しない(固定の一言を出さない)");
  const u = users(c)[0];
  ok((u.flags ?? []).some((f) => /生成の失敗の内訳: 長さの上限/.test(f)), `失敗の種類の印(${(u.flags ?? []).join(" / ").slice(0, 160)})`);
  const rec = Array.isArray(u.failure) ? u.failure[0] : null;
  ok(rec?.failures?.[0]?.maxOutputTokens === 1500 && rec?.failures?.[1]?.maxOutputTokens === 3000, `長さの上限で切れたら、作り直しで上限を広げる(${rec?.failures?.map((x) => x.maxOutputTokens).join(",")})`);
  ok(rec && rec.failures?.length >= 2 && rec.failures[0].finishReason === "MAX_TOKENS" && /いちばん気になっ/.test(rec.failures[0].raw)
    && rec.failures[0].promptTokens === 1234 && rec.scene, `失敗の記録(出力・終わった理由・トークン・場面)(${JSON.stringify(rec)?.slice(0, 200)})`);
  const r2 = await retry(c, r.body.user_seq);
  ok(r2.status === 200 && typeof r2.body.reply === "string" && !r2.body.pending_retry, "作り直しで返事が届く");
  ok(ai(c).length === 1 && users(c).length === 1, `返事は1つ・発言も1つのまま(AI ${ai(c).length}・発言 ${users(c).length})`);
  const r3 = await retry(c, r.body.user_seq);
  ok(r3.body.already === true && ai(c).length === 1, "同じ作り直しをもう一度送っても、返事を二重にしない");
  ok(!usesOldText(c), "「ちゃんと受け取っているよ」の固定の一言を使わない");
  ok(webhook === 0, "職員への通知は出さない");
}

// 2. 待つあいだに書き足した → 書き足した発言の返事に、前の発言も含める。古い作り直しは already
{
  console.log("  2. 待つあいだに書き足す");
  const c = await newConversation();
  // 429 はモデルの切り替えで吸収されるので、どのモデルでも失敗させる
  plan.length = 0; plan.push(...Array(30).fill("rate"));
  const r = await chat(c, "部活のことで");
  plan.length = 0;
  ok(r.body.pending_retry === true && r.body.retry_after_ms >= 10000, `429 は長めに待つ(${r.body.retry_after_ms})`);
  ok((users(c)[0].flags ?? []).some((f) => /利用上限\(429\)/.test(f)), "失敗の種類は利用上限(429)");
  genInputs.length = 0;
  const aiBefore = ai(c).length;
  const r2 = await chat(c, "先輩と気まずい");
  ok(typeof r2.body.reply === "string", "書き足した発言に返事が届く");
  const aiAfter = ai(c).length;
  const lastUser = genInputs[genInputs.length - 1]?.filter((x) => x.role === "user").pop()?.parts?.[0]?.text ?? "";
  ok(/部活のことで/.test(lastUser) && /先輩と気まずい/.test(lastUser), `前の発言も含めて作る(${lastUser.slice(0, 60)})`);
  ok(aiBefore === 0 && users(c).length === 2, `失敗したあいだは返事が無い・発言は2つ(AI ${aiBefore}・発言 ${users(c).length})`);
  const r3 = await retry(c, r.body.user_seq);
  ok(r3.body.already === true && ai(c).length === aiAfter, "古い作り直しは already(返事を二重にしない)");
}

// 3. 作り直しを送ったが、あとの発言がもう届いている → superseded
{
  console.log("  3. あとの発言が届いている作り直し");
  const c = await newConversation();
  plan.length = 0; plan.push(...Array(30).fill("safety"));
  const r = await chat(c, "家のことで");
  ok(r.body.pending_retry === true, "安全フィルターでも作り直し待ち");
  ok((users(c)[0].flags ?? []).some((f) => /安全フィルター/.test(f)), "失敗の種類は安全フィルター");
  plan.length = 0; plan.push(...Array(30).fill("safety"));
  const r2 = await chat(c, "うまく言えないけど");
  plan.length = 0;
  ok(r2.body.pending_retry === true, "書き足した発言も失敗 → 作り直し待ち");
  const r3 = await retry(c, r.body.user_seq);
  ok(r3.body.superseded === true && ai(c).length === 0, "古い発言の作り直しは superseded(作らない)");
  const r4 = await retry(c, r2.body.user_seq);
  ok(typeof r4.body.reply === "string" && ai(c).filter((m) => m.body === r4.body.reply).length === 1, "新しい発言の作り直しで、まとめて1つの返事");
  const lastUser = genInputs[genInputs.length - 1]?.filter((x) => x.role === "user").pop()?.parts?.[0]?.text ?? "";
  ok(/家のことで/.test(lastUser) && /うまく言えないけど/.test(lastUser), "作り直しも、続いた発言をまとめて作る");
  const recs = users(c).flatMap((m) => (Array.isArray(m.failure) ? m.failure : []));
  ok(recs.length === 2, `失敗の記録は発言ごと(${recs.length})`);
  const reviews = c.db.tables.safety_events.filter((e) => e.session_id === c.sessionId && /生成失敗/.test(e.model_reason ?? ""));
  ok(reviews.length === 0, "ふつうの場面では確認待ちに並べない");
}

// 4. 返事の欄が閉じていれば取り出す / 1回目が形の崩れで作り直しで通る
{
  console.log("  4. 取り出し・作り直しで通る");
  const c = await newConversation();
  plan.length = 0; plan.push("cutAfterReply");
  const r = await chat(c, "テストのこと");
  ok(typeof r.body.reply === "string" && /いちばん気になって/.test(r.body.reply), "返事の欄が閉じていれば、その返事を出す");
  const a = ai(c)[0];
  ok((a?.flags ?? []).some((f) => /取り出した/.test(f)), "取り出した印(記録のみ)");
  ok(Array.isArray(a?.failure) && a.failure[0]?.salvaged === true, "失敗の記録は AI の返事の行に残る");
  plan.length = 0; plan.push("garbled");
  const r2 = await chat(c, "まだある");
  ok(typeof r2.body.reply === "string" && !r2.body.pending_retry, "1回目が崩れても、作り直しで通れば返事を出す");
  const a2 = ai(c)[1];
  ok((a2?.flags ?? []).some((f) => /作り直して通った/.test(f)) && Array.isArray(a2?.failure), "作り直して通った印と失敗の記録");
}

// 5. 本人の危機の生成の失敗 → 今までどおり固定の文と窓口のカード
{
  console.log("  5. 本人の危機");
  const c = await newConversation();
  plan.length = 0; plan.push("cut", "cut", "cut", "cut", "cut", "cut");
  webhook = 0;
  const r = await chat(c, "もう死にたい");
  ok(!r.body.pending_retry, "危機のターンは作り直し待ちにしない");
  ok(r.body.crisis === true || r.body.card === "crisis", `窓口のカードを出す(${JSON.stringify(r.body).slice(0, 160)})`);
  ok(ai(c).length >= 1, "返事を保存する");
  ok(webhook >= 1, "職員への通知を出す");
}

// 6. 危機のあとの失敗 → 作り直し待ち(固定の一言は出さない)。確認待ちは最初の1回だけ
{
  console.log("  6. 危機のあと");
  const c = await newConversation();
  plan.length = 0;
  await chat(c, "もう死にたい");
  const before = ai(c).length;
  plan.length = 0; plan.push("cut", "cut", "cut");
  const r = await chat(c, "うん");
  ok(r.body.pending_retry === true && ai(c).length === before, "危機のあとも作り直し待ち(古い固定の一言を出さない)");
  plan.length = 0; plan.push("cut", "cut", "cut");
  const r2 = await retry(c, r.body.user_seq);
  ok(r2.body.pending_retry === true, "作り直しも失敗 → また作り直し待ち");
  const reviews = c.db.tables.safety_events.filter((e) => e.session_id === c.sessionId && /生成失敗/.test(e.model_reason ?? ""));
  ok(reviews.length === 1, `確認待ちは最初の1回だけ(${reviews.length})`);
  plan.length = 0;
  const r3 = await retry(c, r.body.user_seq);
  ok(typeof r3.body.reply === "string" && ai(c).length === before + 1, "作り直しで返事");
  ok(!usesOldText(c), "「ちゃんと受け取っているよ」の固定の一言を使わない");
}

// 7. 18節が無い DB
{
  console.log("  7. 18節が無い DB");
  const c = await newConversation({ messages: ["failure"] });
  plan.length = 0; plan.push("cut", "cut", "cut");
  const r = await chat(c, "ねえ");
  ok(r.body.pending_retry === true, "作り直し待ちを返す");
  ok((users(c)[0].flags ?? []).some((f) => /生成の失敗の内訳/.test(f)), "印は残る");
  plan.length = 0; plan.push("garbled");
  const r2 = await retry(c, r.body.user_seq);
  ok(typeof r2.body.reply === "string" && ai(c).length === 1, "返事を保存できる(失敗の記録の列を外して書く)");
}

console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}秒)`);
console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
