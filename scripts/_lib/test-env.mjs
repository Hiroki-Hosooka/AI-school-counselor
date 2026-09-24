// ============================================================================
//  docs/backlog.md 1-3(自動テスト一式)のスクリプト間で共有する小さなヘルパー。
//  .env.local/.env の軽量読み込みと、TEST_GEMINI_API_KEY の必須化(CLAUDE.md 5.10)。
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

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

// 課金設定済みの単一キー(2026年9月・モデル比較検証)。無料枠4本のプール
// (requireTestGeminiKeyPool)とは別管理。PRIMARY_MODELS系の呼び出しはモデル選定自体が
// 検証対象であり、フォールバックを無効化して1モデルずつ単独で呼ぶため、無料枠のような
// レート制限による自動切り替えはそもそも起きにくい(課金アカウントはRPM上限が高い)。
// withRateLimitRetry には[key]という1要素の配列として渡し、既存の再試行の仕組み
// (一時的な失敗時の待機付き再試行)だけをそのまま再利用する。
export function requireTestGeminiKeyPaid(root) {
  loadEnvFile(`${root}/.env.local`);
  loadEnvFile(`${root}/.env`);
  const key = process.env.TEST_GEMINI_API_KEY_PAID;
  if (!key) {
    console.error("TEST_GEMINI_API_KEY_PAID が設定されていません。");
    console.error(".env.local に TEST_GEMINI_API_KEY_PAID=... を追加してください(無料枠のキーとは別)。");
    process.exit(1);
  }
  return [key];
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

// withRateLimitRetry()に渡す「この結果は再試行すべきか」の共通判定(2026年9月・
// モデル比較検証)。429(レート制限)に加え、Google側の一時的な過負荷(503
// "currently experiencing high demand")も対象にする。503は数十秒後の直接curl
// 再現テストで同じリクエストが成功しており、リクエスト内容の問題ではなくGoogle側の
// 一時的な状態によるものと判断した(モデル比較検証で複数モデルにまたがって頻発)。
// generateReply()の戻り値(failureCause)用。
export function isTransientGenerateFailure(r) {
  return r.generationFailed && (r.failureCause === "レート制限(429)" || r.failureCause === "サービス過負荷(503)");
}

// classify()の戻り値(classifierError。生のエラー文字列)用。
export function isTransientClassifierError(r) {
  return !!r.classifierError && (r.classifierError.startsWith("[RATE_LIMIT]") || r.classifierError.startsWith("[HTTP_503]"));
}

// ============================================================================
//  実コスト計算 + 予算台帳(2026年9月・ペルソナテスト新仕様)
//
//  価格はai.google.dev/gemini-api/docs/pricingを実測した時点のもの(1Mトークンあたり・
//  ドル)。3.6/3.7/3.8-flashは2026年内の導入価格。Google側の値上げ・値下げがあれば
//  ここを更新すること。以前はtest-model-comparison.mjs/test-ng-leak-rate.mjsに
//  重複して持っていたが、予算台帳が全スクリプト共通で必要になったためここに集約した。
// ============================================================================
export const PRICING = {
  "gemini-3.5-flash-lite": { in: 0.30, out: 2.50 },
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.50 },
  "gemini-3.5-flash": { in: 1.50, out: 9.00 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
};

export function costUsd(usage, model) {
  if (!usage || !model) return 0;
  const price = PRICING[model];
  if (!price) return 0;
  const inTok = usage.promptTokenCount ?? 0;
  const outTok = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return (inTok * price.in + outTok * price.out) / 1_000_000;
}

// USD→JPY換算(2026年9月24日実測。158.8〜159円台。予算の上限判定で使うため、
// 超過側に倒れないよう少し高め・切りのいい値に丸めている)。実際のレートと
// 大きく乖離したら更新すること。為替APIは追加していない(このプロジェクトの
// 規模でリアルタイム性を持たせる必要が無いため)。
export const USD_TO_JPY = 160;

const LEDGER_REL_PATH = "docs/test-results/budget-ledger.json";

function loadLedger(root) {
  const p = path.join(root, LEDGER_REL_PATH);
  if (!existsSync(p)) return { entries: [], cumulative_yen: 0 };
  return JSON.parse(readFileSync(p, "utf8"));
}

function saveLedger(root, ledger) {
  mkdirSync(path.dirname(path.join(root, LEDGER_REL_PATH)), { recursive: true });
  writeFileSync(path.join(root, LEDGER_REL_PATH), JSON.stringify(ledger, null, 2));
}

// 台帳の状態を持つオブジェクトを作る。1スクリプト実行につき1つ作り、
// 呼び出しのたびにrecordCall()で加算していく。
export function createBudgetTracker(root) {
  const ledger = loadLedger(root);
  const limitYen = Number(process.env.TEST_BUDGET_YEN ?? 1000);
  return { root, ledger, limitYen, sessionCostUsd: 0, sessionCalls: 0 };
}

export function budgetRemainingYen(tracker) {
  return tracker.limitYen - tracker.ledger.cumulative_yen;
}

export function budgetExceeded(tracker) {
  return budgetRemainingYen(tracker) <= 0;
}

// 1回のGemini呼び出し分を台帳(このtrackerインスタンス内。まだファイルには書かない)に加算する。
export function recordCall(tracker, usage, model) {
  const usd = costUsd(usage, model);
  tracker.sessionCostUsd += usd;
  tracker.sessionCalls += 1;
  tracker.ledger.cumulative_yen += usd * USD_TO_JPY;
  return usd;
}

// 実行前に、見込み額が残り予算を超えないか確認する。超える場合はここで終了する
// (プロセスを止めるので、呼び出し元で追加のエラーハンドリングは不要)。
// estimatedCostPerCallUsdは呼び出し元が判断する(初回は保守的な既定値、
// 2回目以降は台帳の実績から算出するなど)。
export function checkBudgetBeforeRun(tracker, estimatedCalls, estimatedCostPerCallUsd, label) {
  const estimatedYen = estimatedCalls * estimatedCostPerCallUsd * USD_TO_JPY;
  const remaining = budgetRemainingYen(tracker);
  console.log(`[予算] 上限¥${tracker.limitYen} / 使用済み¥${Math.round(tracker.ledger.cumulative_yen)} / 残り¥${Math.round(remaining)}`);
  console.log(`[予算] 今回(${label})の見込み: ${estimatedCalls}回 × 約$${estimatedCostPerCallUsd.toFixed(5)} ≈ ¥${Math.round(estimatedYen)}`);
  if (estimatedYen > remaining) {
    console.error(`[予算] 残り予算(¥${Math.round(remaining)})を超える見込みのため実行しません。`);
    console.error(`[予算] TEST_BUDGET_YENを見直すか、実行範囲(--stage等)を縮小してください。`);
    process.exit(1);
  }
}

// このスクリプト実行の結果を台帳ファイルに追記する(実行の最後に1回呼ぶ)。
export function finalizeBudgetTracker(tracker, label, extra = {}) {
  tracker.ledger.entries.push({
    run_at: new Date().toISOString(),
    script: label,
    calls: tracker.sessionCalls,
    cost_usd: tracker.sessionCostUsd,
    cost_yen: tracker.sessionCostUsd * USD_TO_JPY,
    cumulative_yen_after: tracker.ledger.cumulative_yen,
    ...extra,
  });
  saveLedger(tracker.root, tracker.ledger);
  console.log(`[予算] 今回: $${tracker.sessionCostUsd.toFixed(4)}(≈¥${Math.round(tracker.sessionCostUsd * USD_TO_JPY)}) / 累計: ¥${Math.round(tracker.ledger.cumulative_yen)} / 上限¥${tracker.limitYen}`);
  return tracker.ledger.cumulative_yen;
}

// 台帳の過去実績から、あるスクリプト(label)の1回あたり平均コスト(USD)を推定する。
// 実績が無ければnull(呼び出し元が保守的な既定値にフォールバックする)。
export function estimateCostPerCallFromLedger(root, label) {
  const ledger = loadLedger(root);
  const matching = ledger.entries.filter((e) => e.script === label && e.calls > 0);
  if (!matching.length) return null;
  const totalCalls = matching.reduce((s, e) => s + e.calls, 0);
  const totalCostUsd = matching.reduce((s, e) => s + e.cost_usd, 0);
  return totalCostUsd / totalCalls;
}
