// ============================================================================
//  嶋先生のログレビュー5回目の反映の確かめ(画面と同じ API の経路・偽の DB・模擬のモデル。2026年11月13日)
//
//    node scripts/test-shima5.mjs
//
//  1. 答えにくい問いへの謝罪(作り直し K)が作り直しでも残ったら、謝罪の文だけを消す(案2。人が決めた)
//  2. 答えにくさの返事でないターンの謝罪は消さない
// ============================================================================
import path from "node:path";
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, l, d = "") => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}${d ? `  ${d}` : ""}`); } };
Object.assign(process.env, { API_PATH_ROOT: ROOT, SUPABASE_URL: "http://fake.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake", ADMIN_TOKEN: "x".repeat(32) });
delete process.env.CRISIS_RESPONSE; delete process.env.REFERRAL_FLAG; delete process.env.BATCH_MODE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 模擬のモデル: いつも謝罪 + 受け止め + 問い を返す(作り直しても謝る)
const REPLY = "ごめんね、急かしちゃって。今はそれどころじゃない感じだよね。いま一番気になってるのはどんなこと?";
let genCalls = 0;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return new Response("ok");
  const body = JSON.parse(init.body);
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  let out;
  if (schema.risk) out = { risk: "none", subject: "self", evidence: "", reason: "模擬" };
  else { genCalls++; out = { reply: REPLY, weight: "rapport", relation: "complainant", question_level: "data", role: "listen", did_summarize: false, hypothesis: "", why: "", used: [], notes: {} }; }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
};
const KNOW = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8")).map((k) => ({
  id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [], body: k.text, updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
}));
const { POST } = await import(pathToFileURL(path.join(ROOT, "src/app/api/chat/route.ts")).href);
const call = async (p) => { const r = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(p) })); return { status: r.status, body: await r.json() }; };

const db = createFakeDb({ knowledge: KNOW });
globalThis.__FAKE_DB__ = db;
const cid = "shima5-1";
const s = await call({ action: "start", client_id: cid });
const sid = s.body.session.id;
Object.assign(db.tables.sessions.find((x) => x.id === sid), { phase: "phase2", intake_step: "done", recommended_mode: ["NARRATIVE"], user_goal: "一緒に整理したい" });

const r1 = await call({ action: "chat", client_id: cid, session_id: sid, text: "親のカードを使ってしまって、言えない" });
ok(r1.status === 200 && /ごめん/.test(r1.body.reply), "答えにくさの返事でないターンの謝罪は消さない", r1.body.reply);
const before = genCalls;
const r2 = await call({ action: "chat", client_id: cid, session_id: sid, text: "そんなこと考えてる余裕なんてない" });
const ai2 = db.tables.messages.filter((m) => m.session_id === sid && m.role === "ai").at(-1);
ok(genCalls - before >= 2, "答えにくさへの謝罪は作り直した", String(genCalls - before));
ok(r2.status === 200 && !/ごめん/.test(r2.body.reply) && r2.body.reply.startsWith("今はそれどころじゃない") && /\?$/.test(r2.body.reply), "作り直しても残った謝罪の文を消した", r2.body.reply);
ok((ai2.flags ?? []).some((f) => String(f).startsWith("記録のみ:作り直しても残った謝罪の文を消した")), "消したことを記録に残す", JSON.stringify(ai2.flags));
ok(ai2.body === r2.body.reply, "保存した返事も消したあとの文");

console.log(fail ? `\n${fail}件が通りませんでした(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
