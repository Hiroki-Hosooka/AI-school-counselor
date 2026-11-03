// ============================================================================
//  Gemini のトークン数の記録(2026年11月3日。トークン数の測定。docs/token-usage-20261103.md)
//
//  Gemini の呼び出しはすべて src/classify.mjs の callGemini → callGeminiOnce を通る。そこで、応答の usageMetadata
//  (入力 promptTokenCount・出力 candidatesTokenCount・思考 thoughtsTokenCount・キャッシュ cachedContentTokenCount)を、
//  呼び出しの種類のラベル(下の USAGE_LABELS)つきで「台帳」に足す。
//
//  台帳は 1つのリクエストの中だけで共有する(node:async_hooks の AsyncLocalStorage。Node の標準の機能で、依存は増やしていない)。
//  同じサーバで同時に来たほかの生徒のリクエストとは混ざらない。台帳が無いところ(テストのスクリプトなど)では何もしない。
//  ・route.ts の会話のターン: 台帳を作り、そのターンの分を messages.timings.tokens に書く(列は足していない。db/schema.sql 17節)
//  ・scripts/test-api-path.mjs: 1回の POST ごとに台帳を作り、測定の生データにする
//
//  **返事・判定・安全層の動きは変えない。** 記録するだけ。記録で失敗しても、呼び出しそのものには影響させない。
//  相談の本文は台帳に入れない(ラベル・モデル名・トークン数・所要時間・失敗の種類・分類器の判定の値だけ)。
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

// 呼び出しの種類(ラベル)。callGemini の opts.label で渡す。渡さない呼び出し(テストの採点・生徒役など)は "other"
export const USAGE_LABELS = {
  classifier: "危機の分類器(通常の判定。1回分)",
  classifier_followup: "危機の分類器(危機のあと・見守り中の判定。1回分)",
  classifier_v1: "危機の分類器(v1。設定 CRISIS_DETECTION=v1 のときだけ)",
  judge_withdrawal: "否定・引き下がりの判定(段階ごとの応答のときだけ)",
  judge_teacher: "3通目への答えの判定(段階ごとの応答のときだけ)",
  generate: "生成(1回目)",
  generate_retry: "生成(失敗したあとの再試行)",
  regen_ng: "作り直し(禁止表現)",
  regen_flow: "作り直し(会話の流れ)",
  regen_end: "作り直し(AIから終える形)",
  memory_summary: "人単位のメモの要約",
  other: "その他(テストの採点など)",
};

const als = new AsyncLocalStorage();

export function newUsageLedger() {
  return { calls: [], votes: [], pending: 0 };
}

// fn を、新しい台帳(または渡した台帳)の中で動かす。戻り値は fn の戻り値
export function runWithUsageLedger(fn, ledger = newUsageLedger()) {
  return als.run(ledger, fn);
}

// いまの台帳を返す。無ければ作って、このリクエストの残りの処理(await のあとも)で使う(route.ts の会話のターン用)。
// 外側ですでに台帳を作っている(テストの経路)ときは、それをそのまま使う
export function ensureUsageLedger() {
  let l = als.getStore();
  if (!l) {
    l = newUsageLedger();
    als.enterWith(l);
  }
  return l;
}

export const currentUsageLedger = () => als.getStore() ?? null;

// usageMetadata を短い形にそろえる(Gemini が返さない項目は 0)
export function normalizeUsage(u) {
  if (!u) return null;
  return {
    prompt: u.promptTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    thoughts: u.thoughtsTokenCount ?? 0,
    cached: u.cachedContentTokenCount ?? 0,
    total: u.totalTokenCount ?? 0,
  };
}

// 1回の呼び出し(1つのモデルへの1回の送信)を台帳に足す。usage が null の呼び出し(429・時間切れ等)も、回数として残す
export function recordUsage({ label, model, ok, tag = "", usage = null, ms = 0 }) {
  const l = als.getStore();
  if (!l) return;
  try {
    l.calls.push({ label: label || "other", model, ok, tag, ms, usage: normalizeUsage(usage) });
  } catch { /* 記録の失敗で呼び出しを止めない */ }
}

// 呼び出しの開始と終わり(テストが、待たずに確定した分類器の残りの1回の終わりまで待てるように)
export function usageCallStarted() { const l = als.getStore(); if (l) l.pending++; }
export function usageCallEnded() { const l = als.getStore(); if (l) l.pending = Math.max(0, l.pending - 1); }

// 分類器の1回分の判定の結果(2回並行の判定が食い違った割合を測るため。危機を返した回で確定して、待たなかった回の結果も残る)
export function recordVote({ mode, risk, subject, ok }) {
  const l = als.getStore();
  if (!l) return;
  l.votes.push({ mode, risk: risk ?? null, subject: subject ?? null, ok });
}

// 台帳の呼び出しを、ラベルごとに合計する。messages.timings.tokens に書く形
//  { n: 呼び出しの回数, by: { ラベル: { n, ok, prompt, output, thoughts, cached } }, total: { prompt, output, thoughts, cached } }
export function summarizeUsage(calls) {
  const by = {};
  const total = { prompt: 0, output: 0, thoughts: 0, cached: 0 };
  for (const c of calls ?? []) {
    const b = (by[c.label] ??= { n: 0, ok: 0, prompt: 0, output: 0, thoughts: 0, cached: 0 });
    b.n++;
    if (c.ok) b.ok++;
    for (const k of ["prompt", "output", "thoughts", "cached"]) {
      const v = c.usage?.[k] ?? 0;
      b[k] += v;
      total[k] += v;
    }
  }
  return { n: (calls ?? []).length, by, total };
}
