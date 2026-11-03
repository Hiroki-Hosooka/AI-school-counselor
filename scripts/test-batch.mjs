// ============================================================================
//  連投と、まとめての返事のテスト(2026年11月3日。docs/design-batch-messages.md 9章)
//
//    node scripts/test-batch.mjs [--model=mock|free] [--compare]
//
//  1. src/batch.mjs の決まり(オフライン)
//  2. 画面と同じ API の経路(route.ts の POST をそのまま呼ぶ。DB はメモリ上の偽物)で、連投の台本を流す
//     ・短い文を5通続けて送る → 返事が1回だけ・5通すべてが生成に渡る
//     ・連投の途中に「死にたい」→ その1通の post で判定・記録・通知。窓口のカードは1回。通知はまとまりで1回
//     ・返事を作っている途中に追加で送る → 発言が失われない・順番が保たれる・捨てた返事の状態が残らない
//     ・同じ番号で2回送る → 1通だけ保存
//     ・チップ(トップ画面のボタン)→ 待たずにすぐ次に進む
//  3. --compare: 同じ5通を、1通ごとに返事をする今までの形と比べて、呼び出しの数と時間を数える(8章)
//  画面の時機(1.5秒・3秒・20秒・危機は1秒/5秒)は画面の中の決まりなので、scripts/test-batch-ui.mjs(Playwright)で確かめる。
//  --model=free は無料枠のテスト用キー・合成の台本だけ(CLAUDE.md 5.10)
// ============================================================================
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";
import {
  batchOf, mergeUserRuns, aggregateBatchSafety, notifiedInBatch, shouldSupersede, batchTiming, BATCH_TIMING_DEFAULTS, joinBatch, cleanId,
  batchPromptLine,
} from "../src/batch.mjs";
import { flowStats } from "../src/flow.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const modelMode = arg("model", "mock");
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };

// ---------------------------------------------------------------------------
console.log("■ src/batch.mjs の決まり");
{
  const rows = [
    { seq: 1, role: "user", body: "a" }, { seq: 2, role: "ai", body: "x" },
    { seq: 3, role: "user", body: "b" }, { seq: 4, role: "user", body: "c" }, { seq: 5, role: "user", body: "d" },
  ];
  const b = batchOf(rows, 4);
  ok(b.batch.map((r) => r.seq).join() === "3,4", "まとまりは前の返事より後の to_seq まで");
  ok(b.newer.map((r) => r.seq).join() === "5", "to_seq より後の発言は次のまとまり");
  ok(!b.replied, "まだ返事をしていない");
  ok(batchOf([...rows, { seq: 6, role: "ai", body: "y" }], 5).replied, "to_seq より後に返事があれば、もう返事をした");
  const merged = mergeUserRuns(rows);
  ok(merged.length === 3 && merged[2].body === "b\nc\nd", "続いた生徒の発言は改行でつないで1つにする");
  ok(joinBatch([" a ", "", "b"]) === "a\nb", "空の発言は除いてつなぐ");
  const agg = aggregateBatchSafety([
    { safety: { risk: "watch", subject: "self", types: [] } },
    { safety: { risk: "crisis", subject: "self", types: ["suicidal"] } },
    { safety: { risk: "crisis", subject: "other", types: ["other"] } },
  ]);
  ok(agg.safety.risk === "crisis" && agg.safety.subject === "self", "まとまりの判定は、いちばん重い(本人の危機)");
  ok(agg.types.join() === "suicidal,other", "危機の種類はまとまり全体を合わせる");
  ok(aggregateBatchSafety([{ safety: null }]).missing, "判定が残っていない発言があれば、判定し直す");
  ok(notifiedInBatch([{ role: "user", batch_id: "B", safety: { notify_handled: true } }], "B"), "同じまとまりで通知を受け持った発言があれば、通知しない");
  ok(!notifiedInBatch([{ role: "user", batch_id: "A", safety: { notify_handled: true } }], "B"), "別のまとまりなら、また通知する");
  ok(shouldSupersede({ newer: true, crisis: false, rebuilt: 3 }), "ふつうのまとまりは、新しい発言が来たら作り直す");
  ok(shouldSupersede({ newer: true, crisis: true, rebuilt: 0 }) && !shouldSupersede({ newer: true, crisis: true, rebuilt: 1 }), "段階2のまとまりは、作り直しは1回まで");
  ok(!shouldSupersede({ newer: false, crisis: false, rebuilt: 0 }), "新しい発言が無ければ作り直さない");
  ok(batchTiming({}).idle_ms === BATCH_TIMING_DEFAULTS.idle_ms, "秒数の既定");
  ok(batchTiming({ BATCH_TIMING: '{"idle_ms":2500,"max_ms":"x"}' }).idle_ms === 2500 && batchTiming({ BATCH_TIMING: '{"max_ms":"x"}' }).max_ms === 20000, "秒数は設定で変えられる(おかしな値は既定)");
  ok(cleanId("abc-1_2") === "abc-1_2" && cleanId("a b") === null && cleanId("x".repeat(65)) === null, "番号は英数字と - _ だけ");
  ok(batchPromptLine(1) === "" && batchPromptLine(3).includes("3通"), "まとまりが2通以上のときだけ指示を足す");
  // 回数の決まりは、まとまりを1往復と数える
  const st = flowStats([
    { role: "user", body: "a" }, { role: "user", body: "b" }, { role: "ai", body: "x?" },
    { role: "user", body: "c" }, { role: "user", body: "d" }, { role: "user", body: "e" }, { role: "ai", body: "y?" },
  ], { phase: "phase2" }, {});
  ok(st.exchanges === 2, `往復はまとまりで数える(${st.exchanges})`);
}

// ---------------------------------------------------------------------------
console.log("■ 画面と同じ API の経路(モデル: " + modelMode + ")");
process.env.API_PATH_ROOT = ROOT;
process.env.SUPABASE_URL = "http://fake.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.CRISIS_WEBHOOK_URL = "http://webhook.invalid/hook";
process.env.DEV_PANEL = "on";
process.env.BATCH_MODE = "on";
delete process.env.CRISIS_RESPONSE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 呼び出しの数え方(分類器・生成・そのほか・通知)
const counts = { classifier: 0, generate: 0, other: 0, webhook: 0 };
const genInputs = [];
let duringGenerate = null;   // 生成の途中に差し込む処理(作り直しの台本)
const realFetch = globalThis.fetch;
if (modelMode === "free") {
  const { requireTestGeminiKey } = await import("./_lib/test-env.mjs");
  requireTestGeminiKey(ROOT);
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://webhook.invalid")) { counts.webhook++; return new Response("ok"); }
  if (!u.includes("generativelanguage.googleapis.com")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  const system = body.systemInstruction?.parts?.[0]?.text ?? "";
  const kind = schema.risk ? "classifier" : (schema.reply_type || schema.answer) ? "other" : /出力形式/.test(system) ? "generate" : "other";
  counts[kind]++;
  if (kind === "generate") {
    genInputs.push(body.contents ?? []);
    if (duringGenerate) { const f = duringGenerate; duringGenerate = null; await f(); }
  }
  if (modelMode === "free") return realFetch(url, init);
  let out;
  const lastText = body.contents?.[0]?.parts?.[0]?.text ?? "";
  if (kind === "classifier") {
    const t = (lastText.match(/【判定する発言】\s*([\s\S]*)$/)?.[1] ?? lastText).trim();
    out = /死にたい|消えたい/.test(t) ? { risk: "crisis", subject: "self", reason: "模擬", evidence: t.slice(0, 20) }
      : /つらい|しんどい/.test(t) ? { risk: "watch", subject: "self", reason: "模擬" } : { risk: "none", subject: "self", reason: "模擬" };
  } else if (kind === "generate") {
    out = {
      reply: "そっか。いちばん気になっているのは、どのあたり？", weight: "rapport", relation: "visitor", question_level: "data", role: "listen",
      did_summarize: false, hypothesis: "", why: "模擬", used: [], notes: {},
      intake: { chief_complaint_category: 6, onset_context: null, distress_level: null, user_goal: null, intake_complete: false },
    };
  } else {
    out = schema.answer ? { answer: "unclear", declined: [], reason: "模擬" } : schema.reply_type ? { reply_type: "other", figurative: false, reason: "模擬" } : { summary: "模擬" };
  }
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "mock",
  }), { status: 200, headers: { "content-type": "application/json" } });
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
const id = () => `m${Date.now().toString(36)}${(n++).toString(36)}`;

// 新しい会話(トップ画面のボタン「どれに当てはまるかわからない」を押したあとから始める)
async function newConversation(missing = {}) {
  const db = createFakeDb({ knowledge: KNOW, missingColumns: missing });
  globalThis.__FAKE_DB__ = db;
  const clientId = `batch-${id()}`;
  const start = await call({ action: "start", client_id: clientId });
  const sessionId = start.body.session?.id;
  return { db, clientId, sessionId, start };
}
async function post(c, text, batchId, extra = {}) {
  return call({ action: "post", client_id: c.clientId, session_id: c.sessionId, text, client_msg_id: extra.msgId ?? id(), batch_id: batchId, ...extra });
}
async function reply(c, toSeq, extra = {}) {
  return call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, to_seq: toSeq, ...extra });
}
const zero = () => { for (const k of Object.keys(counts)) counts[k] = 0; genInputs.length = 0; };

// 0. start が秒数を返す / 17節が無い DB では連投を使わない
{
  const c = await newConversation();
  ok(c.start.body.batch?.idle_ms === 1500, "start が返事の時機(秒数)を返す");
}

// 1. 短い文を5通続けて送る
{
  const c = await newConversation();
  const chip = await post(c, "どれに当てはまるかわからない", "B1", { choice_id: "K6" });
  await reply(c, chip.body.seq);
  zero();
  const texts = ["きょう学校で", "ちょっと", "嫌なことがあって", "誰にも言えてない", "どうしたらいいかな"];
  let last = null;
  for (const t of texts) last = await post(c, t, "B2");
  ok(last.status === 200 && typeof last.body.seq === "number", "post は番号を返す");
  ok(counts.generate === 0, "post では返事を作らない");
  const r = await reply(c, last.body.seq);
  if (r.status !== 200 || typeof r.body.reply !== "string") console.log("   返事:", r.status, JSON.stringify(r.body).slice(0, 300));
  ok(r.status === 200 && typeof r.body.reply === "string" && r.body.reply.length > 0, "まとまりに返事を1回");
  // 無料枠では、上限・混雑で次のモデルを試すたびに数が増える(呼び出しの数 = 試した回数)ので、回数はモックのときだけ確かめる
  ok(modelMode !== "mock" || counts.generate === 1, `生成は1回(試した呼び出し ${counts.generate})`);
  const lastUser = [...(genInputs[0] ?? [])].reverse().find((x) => x.role === "user")?.parts?.[0]?.text ?? "";
  ok(texts.every((t) => lastUser.includes(t)), "5通すべてが、順番と区切りを残して生成に渡る");
  ok(lastUser === texts.join("\n"), "改行が区切り");
  const ais = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "ai" && m.batch_id === "B2");
  ok(ais.length >= 1, "返事にまとまりの番号が残る");
  const users = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "user" && m.batch_id === "B2");
  ok(users.length === 5 && users.every((u) => u.safety && u.safety.risk), "5通が1通ずつ保存され、判定が残る");
  ok(counts.classifier >= 1, `判定は1通ごと(分類器 ${counts.classifier} 回。短い返事は呼ばない)`);
  const again = await reply(c, last.body.seq);
  ok(again.body.already === true, "同じまとまりに2回返事をしない");
}

// 2. 連投の途中に「死にたい」
{
  const c = await newConversation();
  const chip = await post(c, "どれに当てはまるかわからない", "C1", { choice_id: "K6" });
  await reply(c, chip.body.seq);
  zero();
  const a = await post(c, "最近ずっと", "C2");
  const evBefore = c.db.tables.safety_events.length;
  const b = await post(c, "死にたい", "C2");
  ok(b.body.urgent === true, "危機の1通の post で urgent が返る");
  ok(c.db.tables.safety_events.length === evBefore + 1, "その1通が届いた時点で記録");
  ok(counts.webhook === 1, `その1通が届いた時点で通知(${counts.webhook})`);
  const d = await post(c, "消えたい", "C2");
  ok(counts.webhook === 1, `同じまとまりの2通目の段階2では通知しない(${counts.webhook})`);
  ok(c.db.tables.safety_events.length === evBefore + 2, "記録は1通ごと");
  const r = await reply(c, d.body.seq);
  ok(r.status === 200, "まとまりに返事");
  ok(r.body.card === "crisis", "窓口のカードは返事に1回");
  ok(Array.isArray(r.body.crisis_types) && r.body.crisis_types.includes("suicidal"), "危機の種類はまとまりから");
  const cards = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "ai" && m.safety_card === "crisis");
  ok(cards.length === 1, `窓口のカードは1回(${cards.length})`);
  ok(counts.webhook === 1, "返事のときに通知を重ねない");
  void a;
  // 次のまとまりで段階2なら、また通知する
  const e = await post(c, "やっぱり死にたい", "C3");
  ok(counts.webhook === 2, "別のまとまりでは、また通知する");
  void e;
}

// 3. 返事を作っている途中に追加で送る
{
  const c = await newConversation();
  const chip = await post(c, "どれに当てはまるかわからない", "D1", { choice_id: "K6" });
  await reply(c, chip.body.seq);
  zero();
  const a = await post(c, "部活のことで", "D2");
  let late = null;
  duringGenerate = async () => { late = await post(c, "先輩と気まずい", "D2"); };
  const sessBefore = { ...c.db.tables.sessions.find((s) => s.id === c.sessionId) };
  const r1 = await reply(c, a.body.seq);
  ok(r1.body.superseded === true, "保存の前に新しい発言が届いたら、作った返事を捨てる");
  const aiAfter = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "ai" && m.batch_id === "D2");
  ok(aiAfter.length === 0, "捨てた返事は保存しない");
  const sessAfter = c.db.tables.sessions.find((s) => s.id === c.sessionId);
  ok(sessAfter.turns_since_summary === sessBefore.turns_since_summary && sessAfter.weight === sessBefore.weight, "捨てた返事の状態は残らない");
  const r2 = await reply(c, late.body.seq, { rebuilt: 1 });
  ok(r2.status === 200 && typeof r2.body.reply === "string", "広げたまとまりで返事");
  const lastUser = [...(genInputs.at(-1) ?? [])].reverse().find((x) => x.role === "user")?.parts?.[0]?.text ?? "";
  ok(lastUser === "部活のことで\n先輩と気まずい", "発言は失われず、順番が保たれる");
  const users = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "user").map((m) => m.body);
  ok(users.slice(-2).join() === "部活のことで,先輩と気まずい", "保存の順番も保たれる");
  // 返事を保存したあとに届いた発言は次のまとまり
  const x = await post(c, "あと、もう一つ", "D3");
  const r3 = await reply(c, x.body.seq);
  ok(r3.status === 200 && !r3.body.superseded, "保存したあとに届いた発言は、次のまとまりで返事");
}

// 3b. 段階2のまとまりでは、作り直しは1回まで
{
  const c = await newConversation();
  const chip = await post(c, "どれに当てはまるかわからない", "E1", { choice_id: "K6" });
  await reply(c, chip.body.seq);
  const a = await post(c, "死にたい", "E2");
  duringGenerate = async () => { await post(c, "ほんとに", "E2"); };
  const r = await reply(c, a.body.seq, { rebuilt: 1 });
  ok(r.status === 200 && !r.body.superseded && typeof r.body.reply === "string", "段階2のまとまりの2回目は、新しい発言が来ても返事を出す");
}

// 4. 同じ番号で2回送る
{
  const c = await newConversation();
  const p1 = await post(c, "おなじ", "F1", { msgId: "same-id-1" });
  const p2 = await post(c, "おなじ", "F1", { msgId: "same-id-1" });
  const users = c.db.tables.messages.filter((m) => m.session_id === c.sessionId && m.role === "user" && m.body === "おなじ");
  ok(users.length === 1 && p2.body.duplicate === true && p1.body.seq === p2.body.seq, "同じ番号の発言は1通だけ保存");
}

// 5. チップ(トップ画面のボタン)は待たずにすぐ次に進む
{
  const c = await newConversation();
  zero();
  const p = await post(c, "友達・人間関係", "G1", { choice_id: "K1" });
  ok(counts.classifier === 0, "チップは分類器にかけない");
  const r = await reply(c, p.body.seq);
  ok(r.status === 200 && typeof r.body.reply === "string", "チップのまとまりに、すぐ返事");
  const sess = c.db.tables.sessions.find((s) => s.id === c.sessionId);
  ok(sess.intake_step === "background" && sess.chief_complaint_category === 1, `インテークが進む(${sess.intake_step})`);
}

// 6. 連投が無効なら post は使えず、今までの chat のまま
{
  delete process.env.BATCH_MODE;
  const c = await newConversation();
  ok(c.start.body.batch === null, "BATCH_MODE が無いとき start は秒数を返さない");
  const r = await post(c, "テスト", "H1");
  ok(r.status === 400 && r.body.batch_unavailable === true, "BATCH_MODE が無いとき post は断る");
  const t = await call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, text: "こんにちは" });
  ok(t.status === 200 && typeof t.body.reply === "string", "今までの chat はそのまま");
  process.env.BATCH_MODE = "on";
}

// ---------------------------------------------------------------------------
// 8章: 呼び出しの数と時間(同じ5通を、1通ごとに返事をする形と、まとめて返事をする形で)
if (process.argv.includes("--compare") || true) {
  console.log("■ 呼び出しの数と時間(同じ5通。モデル: " + modelMode + ")");
  const texts = ["きょう学校で", "ちょっと", "嫌なことがあって", "誰にも言えてない", "どうしたらいいかな"];
  const measure = async (mode) => {
    if (mode === "each") delete process.env.BATCH_MODE; else process.env.BATCH_MODE = "on";
    const c = await newConversation();
    if (mode === "each") {
      await call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, text: "どれに当てはまるかわからない", choice_id: "K6" });
    } else {
      const p = await post(c, "どれに当てはまるかわからない", "Z1", { choice_id: "K6" });
      await reply(c, p.body.seq);
    }
    zero();
    const t0 = Date.now();
    let serverMs = 0;
    if (mode === "each") {
      for (const t of texts) { const s = Date.now(); await call({ action: "chat", client_id: c.clientId, session_id: c.sessionId, text: t }); serverMs += Date.now() - s; }
    } else {
      let last;
      for (const t of texts) last = await post(c, t, "Z2");
      const s = Date.now(); await reply(c, last.body.seq); serverMs = Date.now() - s;
    }
    return { mode, ...counts, ms: Date.now() - t0, replyMs: serverMs };
  };
  const each = await measure("each");
  const batch = await measure("batch");
  for (const m of [each, batch]) {
    console.log(`  ${m.mode === "each" ? "1通ごとに返事" : "まとめて返事 "}: 生成 ${m.generate} 回 / 分類器 ${m.classifier} 回 / そのほか ${m.other} 回 / 全体 ${m.ms}ms(返事の呼び出し ${m.replyMs}ms)`);
  }
  ok(batch.generate < each.generate, "まとめると生成の回数が減る");
  process.env.BATCH_MODE = "on";
}

console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
