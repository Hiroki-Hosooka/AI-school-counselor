// ============================================================================
//  会話ログの自動評価の管理画面の確かめ(2026年11月10日。docs/design-auto-eval.md 2-3・3-3)。画面と同じ API の経路・偽の DB・模擬のモデル
//
//    node scripts/test-eval-admin.mjs
//
//  1. コードの指標(admin_eval_metrics・セッションの詳細の eval_metrics): 合言葉が無ければ断る・数が返る・相談の本文を返さない
//  2. 「開発メンバーのテスト」の印(admin_mark_dev_test): 付けた印が一覧と詳細に出る
//  3. 21節が未実行の DB: 印は付けられないが、一覧・詳細・会話は止まらない
// ============================================================================
import path from "node:path";
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, l, d = "") => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}${d ? `  ${d}` : ""}`); } };
const TOKEN = "test-admin-token-long-and-random";
Object.assign(process.env, { API_PATH_ROOT: ROOT, SUPABASE_URL: "http://fake.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake", ADMIN_TOKEN: TOKEN });
delete process.env.CRISIS_RESPONSE; delete process.env.REFERRAL_FLAG; delete process.env.BATCH_MODE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 模擬のモデル: 問いの無い受け止めだけを返す(受け止めのみの連続を数えられるか)
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return new Response("ok");
  const body = JSON.parse(init.body);
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  const out = schema.risk ? { risk: "none", subject: "self", evidence: "", reason: "模擬" }
    : { reply: "そうなんだね。話してくれてうれしい。", weight: "rapport", relation: "visitor", question_level: "none", role: "listen", did_summarize: false, hypothesis: "", why: "", used: [], notes: {} };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
};
const KNOW = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8")).map((k) => ({
  id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [], body: k.text, updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
}));
const { POST } = await import(pathToFileURL(path.join(ROOT, "src/app/api/chat/route.ts")).href);
const call = async (p) => { const r = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(p) })); return { status: r.status, body: await r.json() }; };

async function talk(db, cid) {
  globalThis.__FAKE_DB__ = db;
  const s = await call({ action: "start", client_id: cid });
  const sid = s.body.session.id;
  Object.assign(db.tables.sessions.find((x) => x.id === sid), { phase: "phase2", intake_step: "done", recommended_mode: ["LISTEN_ONLY"] });
  for (const t of ["部活の先輩のことで悩んでる", "練習のあとにいつも言われる", "もう行きたくない気もする", "どうしたらいいかな"]) {
    await call({ action: "chat", client_id: cid, session_id: sid, text: t });
  }
  return sid;
}

// ---- 1・2. 21節がある DB ----
{
  console.log("■ 21節がある DB");
  const db = createFakeDb({ knowledge: KNOW });
  const sid = await talk(db, "eval-admin-1");
  const no = await call({ action: "admin_eval_metrics", admin_token: "wrong" });
  ok(no.status === 401, "合言葉が違えば断る");
  const r = await call({ action: "admin_eval_metrics", admin_token: TOKEN });
  const m = r.body.metrics?.[sid];
  ok(r.status === 200 && m, "コードの指標が返る", JSON.stringify(r.body).slice(0, 120));
  ok(typeof m?.receive_only_max === "number" && typeof m?.read_first === "number" && m?.secret_promise && typeof m.secret_promise.candidates === "number", "指標の形");
  const text = JSON.stringify(r.body);
  ok(!/部活の先輩|練習のあと|行きたくない|話してくれてうれしい/.test(text), "指標に相談の本文・返事の本文を含めない");
  const d = await call({ action: "admin_session_detail", admin_token: TOKEN, session_id: sid });
  ok(d.status === 200 && typeof d.body.eval_metrics?.receive_only_max === "number", "詳細にコードの指標");
  ok(d.body.session.dev_test === false && d.body.session.dev_test_available === true, "印は最初は無い・付けられる", JSON.stringify(d.body.session).slice(0, 80));
  const mk = await call({ action: "admin_mark_dev_test", admin_token: TOKEN, session_id: sid, on: true });
  ok(mk.status === 200 && db.tables.sessions.find((x) => x.id === sid).dev_test === true, "印を付けられる");
  const mkNo = await call({ action: "admin_mark_dev_test", admin_token: "wrong", session_id: sid, on: false });
  ok(mkNo.status === 401 && db.tables.sessions.find((x) => x.id === sid).dev_test === true, "合言葉が違えば印を変えない");
  const d2 = await call({ action: "admin_session_detail", admin_token: TOKEN, session_id: sid });
  ok(d2.body.session.dev_test === true, "詳細に印が出る");
  const off = await call({ action: "admin_mark_dev_test", admin_token: TOKEN, session_id: sid, on: false });
  ok(off.status === 200 && db.tables.sessions.find((x) => x.id === sid).dev_test === false, "印を外せる");
}

// ---- 3. 21節が未実行の DB ----
{
  console.log("■ 21節が未実行の DB");
  const db = createFakeDb({ knowledge: KNOW, missingColumns: { sessions: ["dev_test", "dev_test_at"] } });
  const sid = await talk(db, "eval-admin-2");
  ok(db.tables.messages.filter((x) => x.session_id === sid && x.role === "ai").length >= 4, "会話は止まらない");
  const d = await call({ action: "admin_session_detail", admin_token: TOKEN, session_id: sid });
  ok(d.status === 200 && d.body.session.dev_test_available === false, "詳細は出る・印は付けられないと示す", JSON.stringify(d.body.session ?? d.body).slice(0, 100));
  const mk = await call({ action: "admin_mark_dev_test", admin_token: TOKEN, session_id: sid, on: true });
  ok(mk.status === 400 && /21節/.test(mk.body.error ?? ""), "印の保存はできないと返す");
  const r = await call({ action: "admin_eval_metrics", admin_token: TOKEN });
  ok(r.status === 200 && r.body.metrics?.[sid], "コードの指標は出る");
}

console.log(fail ? `\n${fail}件が通りませんでした(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
