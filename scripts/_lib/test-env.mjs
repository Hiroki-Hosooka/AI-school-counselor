// ============================================================================
//  docs/backlog.md 1-3(自動テスト一式)のスクリプト間で共有する小さなヘルパー。
//  .env.local/.env の軽量読み込みと、TEST_GEMINI_API_KEY の必須化(CLAUDE.md 5.10)。
// ============================================================================

import { readFileSync, existsSync } from "node:fs";

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// 本番の GEMINI_API_KEY とは別の合成テスト専用キーを必須にする(CLAUDE.md 5.10)。
// 無料枠のデータはGoogleの製品改善に使われるため、生徒の会話に使う本番キーとは
// 絶対に混ぜない。見つからなければ本番キーへフォールバックせず、ここで止める。
export function requireTestGeminiKey(root) {
  loadEnvFile(`${root}/.env.local`);
  loadEnvFile(`${root}/.env`);
  const key = process.env.TEST_GEMINI_API_KEY;
  if (!key) {
    console.error("TEST_GEMINI_API_KEY が設定されていません。");
    console.error("本番の GEMINI_API_KEY とは別の、合成テスト専用のキーを用意してください(CLAUDE.md 5.10)。");
    console.error(".env.local に TEST_GEMINI_API_KEY=... を追加するか、環境変数として渡してください。");
    process.exit(1);
  }
  process.env.GEMINI_API_KEY = key;
}

// 複数の合成テスト専用キーをプールとして使う(2026年9月・検証一式。無料枠のレート制限が
// 実機検証で頻発したことへの対応)。TEST_GEMINI_API_KEYS(カンマ区切り)があればそれを、
// 無ければ単一の TEST_GEMINI_API_KEY を1件のプールとして扱う(後方互換)。
// いずれも見つからなければ requireTestGeminiKey と同じ理由で止める。
// 各キーはCLAUDE.md 5.10の対象(合成テスト専用・本番キーとは別)であることが前提。
export function requireTestGeminiKeyPool(root) {
  loadEnvFile(`${root}/.env.local`);
  loadEnvFile(`${root}/.env`);
  const listRaw = process.env.TEST_GEMINI_API_KEYS;
  const pool = listRaw
    ? listRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : (process.env.TEST_GEMINI_API_KEY ? [process.env.TEST_GEMINI_API_KEY] : []);
  if (!pool.length) {
    console.error("TEST_GEMINI_API_KEY(S) が設定されていません。");
    console.error("本番の GEMINI_API_KEY とは別の、合成テスト専用のキーを用意してください(CLAUDE.md 5.10)。");
    console.error(".env.local に TEST_GEMINI_API_KEYS=キー1,キー2,... (複数)");
    console.error("または TEST_GEMINI_API_KEY=... (単一)を追加するか、環境変数として渡してください。");
    process.exit(1);
  }
  process.env.GEMINI_API_KEY = pool[0];
  return pool;
}

// withRateLimitRetry() 呼び出し間で「直近成功したキーの位置」を覚えておくための状態。
// スクリプト起動時に1つ作り、同じ用途(例:相談AI本体の生成)の呼び出し全てに使い回す。
// 2026年9月・実機検証で判明:これが無いと、呼び出すたびに必ずプールの先頭(キー1)から
// 試すため、繰り返し使って消耗している先頭のキーに毎回真っ先にぶつかり、まだ余裕のある
// 後ろの方のキーになかなかたどり着けなかった(1回のテストで数十〜百件以上呼び出す
// ため、この「先頭固定」の無駄が積み重なる)。
export function createKeyRotationState() {
  return { index: 0 };
}

// keyPool を使ったレート制限時の自動キー切り替え+再試行(2026年9月・検証一式)。
// attemptFn() を呼ぶ前に process.env.GEMINI_API_KEY をプールの次のキーに切り替える。
// レート制限は「同じキーで待つ」より「別キーで即試す」方が速いため(別キーは独立した
// クォータを持つ)、1周(プールの全キーを1回ずつ)試してもダメだった場合だけ、
// 実際に待つ(fallbackWaitMs)。isRateLimited(result) で「この結果がレート制限による
// 失敗か」を呼び出し側が判定する(classify()とgenerateReply()で失敗の表現が違うため)。
// opts.state(createKeyRotationState()で作った、呼び出し元が使い回すオブジェクト)を
// 渡すと、成功したキーの位置を覚えて次回そこから始める。渡さなければ毎回キー1から
// (単発呼び出し用途、または挙動を単純にしたい場合向けの後方互換)。
export async function withRateLimitRetry(keyPool, attemptFn, isRateLimited, opts = {}) {
  // 既定はプールを2周分(1周目はキーを切り替えるだけで待たない。2周目は
  // 1周目が全滅した場合の保険で、間に1回だけ実際に待つ)。単一キーのプールなら
  // 4回(=以前と同じ既定値)になる。
  const maxAttempts = opts.maxAttempts ?? Math.max(keyPool.length * 2, 4);
  const fallbackWaitMs = opts.fallbackWaitMs ?? 10000;
  const label = opts.label ?? "";
  const state = opts.state ?? { index: 0 };
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const keyIndex = (state.index + attempt - 1) % keyPool.length;
    process.env.GEMINI_API_KEY = keyPool[keyIndex];
    result = await attemptFn();
    if (!isRateLimited(result)) {
      state.index = keyIndex; // 次回の呼び出しはこの成功したキーから始める
      return result;
    }
    if (attempt < maxAttempts) {
      const justCycled = keyPool.length > 1 && attempt % keyPool.length === 0;
      if (justCycled) {
        console.error(`    ${label}全${keyPool.length}キーでレート制限、${fallbackWaitMs}ms待って再試行します`);
        await sleep(fallbackWaitMs);
      } else if (keyPool.length > 1) {
        console.error(`    ${label}レート制限、キー${(keyIndex + 1) % keyPool.length + 1}/${keyPool.length}に切り替えて再試行します`);
      } else {
        console.error(`    ${label}レート制限、${fallbackWaitMs}ms待って再試行します(${attempt}/${maxAttempts - 1})`);
        await sleep(fallbackWaitMs);
      }
    }
  }
  return result;
}

// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY は本番と同じものを使う想定
// (ナレッジ・会話ログの読み書き自体はGemini無料枠の話とは無関係。CLAUDE.md 5.10参照)。
export function requireSupabaseEnv(root) {
  loadEnvFile(`${root}/.env.local`);
  loadEnvFile(`${root}/.env`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません。");
    console.error(".env.local に追加するか、環境変数として渡してください。");
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
