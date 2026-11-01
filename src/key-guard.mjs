// ============================================================================
//  本番で、テスト用・無料枠の Gemini のキーを使わないための止め(2026年11月1日。CLAUDE.md 5.10)
//
//  経緯: 本番(Vercel の Production)の GEMINI_API_KEY に、テスト用(無料枠)のキーが入っていた(人が見つけた)。
//  無料枠は送った内容が Google の製品改善に使われるので、実際の生徒の相談を送ってはいけない。
//  キーの入れ替えは人の作業(Vercel の環境変数)。このファイルは、同じことが起きたときに
//  「送る前に止める」「送ってしまったら、それ以上送らない」ための仕組み。
//
//    1. 送る前: 本番で、GEMINI_API_KEY が TEST_GEMINI_API_KEY* のどれかと同じなら、Gemini に送らない
//       (callGeminiOnce が [KEY_GUARD] として失敗させる。分類器・生成・記憶の要約のすべてが止まる)
//    2. 送ったあと: 本番で、Google の 429 の本文に無料枠の印(free_tier)があったら、そのインスタンスでは以後送らない
//       (無料枠かどうかは、上限に当たったときの本文でしか見分けられない)
//
//  止まっているあいだも、キーワード・受動パターンの照合(AI を使わない)・危機の固定応答・職員への通知・
//  画面の下の窓口は動く(Gemini を使わないため)。返事の生成は失敗の扱い(場面の固定の一言)になる。
//  本番かどうかは Vercel の VERCEL_ENV === "production" で決める(Preview・Development・テストでは止めない)。
//  このファイルは何も読み込まない(classify.mjs から読むため)。
// ============================================================================

export const KEY_GUARD_TAG = "[KEY_GUARD]";

export const isProduction = (env = process.env) => env.VERCEL_ENV === "production";

// テスト用のキーとして設定されている値(TEST_GEMINI_API_KEY / KEY1,2,… / KEYS(カンマ区切り)/ KEY_PAID)
export function testKeyValues(env = process.env) {
  const vals = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^TEST_GEMINI_API_KEY/.test(k) || typeof v !== "string") continue;
    for (const part of k === "TEST_GEMINI_API_KEYS" ? v.split(",") : [v]) {
      const t = part.trim();
      if (t) vals.push(t);
    }
  }
  return vals;
}

// インスタンスの中だけで持つ印(無料枠の 429 を見たか)
let freeTierSeenAt = null;
export const markFreeTier = () => { freeTierSeenAt ??= new Date().toISOString(); };
export const freeTierSeen = () => freeTierSeenAt;
export const resetKeyGuardForTest = () => { freeTierSeenAt = null; };

// Google の 429 の本文が無料枠のものか(quotaMetric が generate_content_free_tier_* など)
export const isFreeTierQuotaBody = (body) => /free_tier|FreeTier/i.test(String(body ?? ""));

// 本番のキーの状態。block = true なら Gemini に送らない
export function geminiKeyGuard(env = process.env) {
  if (!isProduction(env)) return { block: false, reason: null, warn: null };
  const key = String(env.GEMINI_API_KEY ?? "").trim();
  const tests = testKeyValues(env);
  if (key && tests.includes(key)) {
    return { block: true, reason: "本番の GEMINI_API_KEY がテスト用のキー(TEST_GEMINI_API_KEY*)と同じ", warn: null };
  }
  if (freeTierSeenAt) {
    return { block: true, reason: `本番のキーで無料枠の上限(free_tier)の応答を受けた(${freeTierSeenAt})`, warn: null };
  }
  // テスト用のキーが本番に置かれているだけでも、取り違えのもとになる(README: Vercel には設定しない)
  const warn = tests.length ? "本番の環境変数に TEST_GEMINI_API_KEY* が設定されている(Vercel から外してください)" : null;
  return { block: false, reason: null, warn };
}
