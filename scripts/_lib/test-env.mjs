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
