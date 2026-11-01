// ============================================================================
//  本番でテスト用・無料枠の Gemini のキーを使わないための止め(src/key-guard.mjs)のオフラインテスト
//    node scripts/test-key-guard.mjs
//  Gemini には送らない(fetch を差し替えて、送ろうとした回数を数える)。キーは偽の文字列
// ============================================================================
import { geminiKeyGuard, testKeyValues, resetKeyGuardForTest, isFreeTierQuotaBody } from "../src/key-guard.mjs";
import { callGemini, failureTag } from "../src/classify.mjs";

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) pass++; else { fail++; console.log(`✗ ${name}`); } };

const FAKE_TEST = "fake-test-key-1";
const FAKE_PROD = "fake-prod-key";
const set = (vars) => {
  for (const k of Object.keys(process.env)) if (/^TEST_GEMINI_API_KEY|^GEMINI_API_KEY$|^VERCEL_ENV$/.test(k)) delete process.env[k];
  Object.assign(process.env, vars);
};
let sent = 0;
let nextResponse = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }), { status: 200 });
globalThis.fetch = async () => { sent++; return nextResponse(); };
const call = async () => {
  try { await callGemini(["gemini-x"], "sys", [{ role: "user", parts: [{ text: "合成" }] }]); return { ok: true }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
};

// 1. テスト用のキーの集め方
set({ TEST_GEMINI_API_KEY1: "a", TEST_GEMINI_API_KEYS: "b, c", TEST_GEMINI_API_KEY_PAID: "d" });
check("テスト用のキーを全部集める", ["a", "b", "c", "d"].every((k) => testKeyValues().includes(k)));

// 2. 本番で、GEMINI_API_KEY がテスト用のキーと同じ → 送らない
set({ VERCEL_ENV: "production", GEMINI_API_KEY: FAKE_TEST, TEST_GEMINI_API_KEY1: FAKE_TEST });
resetKeyGuardForTest(); sent = 0;
let r = await call();
check("本番でテスト用のキー: 止める", geminiKeyGuard().block === true);
check("本番でテスト用のキー: Gemini に送らない", sent === 0 && !r.ok && r.msg.includes("[KEY_GUARD]"));
check("失敗の種類の記録", failureTag(r.msg) === "本番に無料枠・テスト用のキー");

// 3. Preview・テストでは止めない(テストの仕組みは今までどおり)
set({ VERCEL_ENV: "preview", GEMINI_API_KEY: FAKE_TEST, TEST_GEMINI_API_KEY1: FAKE_TEST });
sent = 0; r = await call();
check("Preview では止めない", geminiKeyGuard().block === false && sent === 1 && r.ok);
set({ GEMINI_API_KEY: FAKE_TEST, TEST_GEMINI_API_KEY1: FAKE_TEST });
sent = 0; r = await call();
check("VERCEL_ENV が無い(手元のテスト)では止めない", sent === 1 && r.ok);

// 4. 本番で別のキー → 送る。テスト用のキーが本番に置かれているだけなら注意を出す
set({ VERCEL_ENV: "production", GEMINI_API_KEY: FAKE_PROD, TEST_GEMINI_API_KEY1: FAKE_TEST });
resetKeyGuardForTest(); sent = 0; r = await call();
check("本番で別のキー: 送る", sent === 1 && r.ok && geminiKeyGuard().block === false);
check("本番にテスト用のキーが置かれている: 注意", !!geminiKeyGuard().warn);
set({ VERCEL_ENV: "production", GEMINI_API_KEY: FAKE_PROD });
check("本番にテスト用のキーが無い: 注意なし", geminiKeyGuard().warn === null);

// 5. 本番で無料枠の 429 を受けたら、以後送らない
const FREE_429 = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota", details: [{ violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }] }] } });
check("無料枠の本文を見分ける", isFreeTierQuotaBody(FREE_429) && !isFreeTierQuotaBody('{"error":{"code":429,"message":"Resource exhausted"}}'));
resetKeyGuardForTest(); sent = 0;
nextResponse = () => new Response(FREE_429, { status: 429 });
r = await call();
check("無料枠の 429 を受けた: 1回は送ってしまう(見分けられるのは応答から)", sent === 1 && !r.ok);
check("無料枠の 429 のあと: 止める", geminiKeyGuard().block === true);
nextResponse = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 });
sent = 0; r = await call();
check("無料枠の 429 のあと: 以後送らない", sent === 0 && !r.ok && r.msg.includes("[KEY_GUARD]"));
// 課金済みのキーのふつうの 429(上限)では止めない
resetKeyGuardForTest();
nextResponse = () => new Response('{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota)."}}', { status: 429 });
await call();
check("課金済みのキーのふつうの 429 では止めない", geminiKeyGuard().block === false);
// Preview で無料枠の 429 を受けても止めない(テスト用のキーを使う場所なので)
set({ VERCEL_ENV: "preview", GEMINI_API_KEY: FAKE_TEST });
resetKeyGuardForTest(); nextResponse = () => new Response(FREE_429, { status: 429 });
await call();
check("Preview の無料枠の 429 では止めない", geminiKeyGuard().block === false);

console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
