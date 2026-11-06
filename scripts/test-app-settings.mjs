// ============================================================================
//  管理画面から変える設定のテスト(2026年11月6日。db/schema.sql 19節。オフライン)
//
//    node scripts/test-app-settings.mjs
//
//  画面と同じ API の経路(route.ts の POST をそのまま呼ぶ。DB はメモリ上の偽物。Gemini は呼ばない模擬)で確かめる:
//  ・合言葉が無いと読めない・変えられない
//  ・分類器の思考を管理画面で変えると、次の判定の呼び出しの thinkingBudget が変わる(デプロイし直さない)
//  ・決まる順: 管理画面 > 環境変数 LITE_THINKING_BUDGET > 既定(動的 -1)。「設定しない」で環境変数・既定に戻る
//  ・選べない値は断る。変えた記録が残る。19節が無い DB でも会話は止まらない
// ============================================================================
import path from "node:path";
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}`); } };
process.env.API_PATH_ROOT = ROOT;
process.env.SUPABASE_URL = "http://fake.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.ADMIN_TOKEN = "test-admin-token-long-and-random";
delete process.env.LITE_THINKING_BUDGET;
delete process.env.CRISIS_RESPONSE;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// 分類器への呼び出しの thinkingBudget を記録する
const budgets = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes("generativelanguage.googleapis.com")) return new Response("ok");
  const body = JSON.parse(init.body);
  const schema = body.generationConfig?.responseSchema?.properties ?? {};
  let out;
  if (schema.risk) { budgets.push(body.generationConfig?.thinkingConfig?.thinkingBudget); out = { risk: "none", subject: "self", reason: "模擬" }; }
  else out = { reply: "そっか。どのあたりが気になってる?", weight: "rapport", relation: "visitor", question_level: "data", role: "listen", did_summarize: false, hypothesis: "", why: "", used: [], notes: {} };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
};
const KNOW = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8")).map((k) => ({
  id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [], body: k.text, updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
}));
const { POST } = await import(pathToFileURL(path.join(ROOT, "src/app/api/chat/route.ts")).href);
const call = async (p) => { const r = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(p) })); return { status: r.status, body: await r.json() }; };
const admin = (action, extra = {}) => call({ action, admin_token: process.env.ADMIN_TOKEN, ...extra });
async function turnBudget(db) {
  const s = await call({ action: "start", client_id: `c-${Math.random()}` });
  budgets.length = 0;
  await call({ action: "chat", client_id: s.body.session.client_id ?? "x", session_id: s.body.session.id, text: "部活のことで少し話したい" });
  return budgets[0];
}

{
  const db = createFakeDb({ knowledge: KNOW });
  globalThis.__FAKE_DB__ = db;
  ok((await call({ action: "admin_settings_get" })).status === 401, "合言葉が無いと読めない");
  ok((await call({ action: "admin_settings_save", key: "classifier_thinking", value: "128" })).status === 401, "合言葉が無いと変えられない");
  const g = await admin("admin_settings_get");
  ok(g.body.available === true && g.body.classifier_thinking === -1 && g.body.source === "default", `既定は動的(${JSON.stringify(g.body).slice(0, 80)})`);
  ok(await turnBudget(db) === -1, "既定では分類器の思考は動的(-1)");
  const s1 = await admin("admin_settings_save", { key: "classifier_thinking", value: "128", note: "費用を減らす試し" });
  ok(s1.status === 200 && s1.body.classifier_thinking === 128 && s1.body.source === "admin", "128 に変えられる");
  const b = await turnBudget(db);
  ok(b === 128, `変えたあとの判定は上限 128 で送る(${b})`);
  ok((await admin("admin_settings_save", { key: "classifier_thinking", value: "99999" })).status === 400, "選べない値は断る");
  ok((await admin("admin_settings_save", { key: "other", value: "1" })).status === 400, "ほかの設定は変えられない");
  process.env.LITE_THINKING_BUDGET = "512";
  ok(await turnBudget(db) === 128, "管理画面の値は環境変数より優先");
  await admin("admin_settings_save", { key: "classifier_thinking", value: "" });
  ok(await turnBudget(db) === 512, "「設定しない」で環境変数に戻る");
  delete process.env.LITE_THINKING_BUDGET;
  await admin("admin_settings_save", { key: "classifier_thinking", value: "dynamic" });
  ok(await turnBudget(db) === -1, "動的に戻せる");
  const h = (await admin("admin_settings_get")).body.history;
  ok(Array.isArray(h) && h.length === 3 && h.some((r) => r.after === "128" && r.note === "費用を減らす試し"), `変えた記録が残る(${h?.length})`);
}
{
  const db = createFakeDb({ knowledge: KNOW, noAppSettings: true });
  globalThis.__FAKE_DB__ = db;
  await new Promise((r) => setTimeout(r, 0));
  const g = await admin("admin_settings_get");
  ok(g.status === 200 && g.body.available === false, "19節が無い DB では、無いことを知らせる");
  ok((await admin("admin_settings_save", { key: "classifier_thinking", value: "128" })).status === 400, "19節が無い DB では保存できない(エラーを返す)");
}
console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
