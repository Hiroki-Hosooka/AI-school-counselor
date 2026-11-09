// ============================================================================
//  連投と、まとめての返事(2026年11月3日。設計 docs/design-batch-messages.md。人が確認)
//
//  発言は送られたらすぐ1通ずつ保存し、危機の判定もその1通ごとにすぐ行う(route.ts の post)。
//  返事は、画面が「入力が止まった」と判断したときに、まだ返事をしていない発言のまとまりに1回だけ作る(route.ts の chat に to_seq)。
//  このファイルは、その決まりのうち DB にも画面にも触れない部分(テストで確かめられるもの)。
//
//  設定 BATCH_MODE=on のときだけ動く。段階ごとの応答(CRISIS_RESPONSE=staged)とは一緒に使わない(人が確認。
//  チップで進む流れが1通ごとの返事を前提にしているため)。DB の17節の列が無いときも使わない(route.ts が確かめる)。
// ============================================================================

export const batchModeRequested = (env = process.env) => env.BATCH_MODE === "on";

// 返事をする時機(秒数はすべて仮。開発メンバーが使って調整する。設定 BATCH_TIMING に JSON で上書きできる)
export const BATCH_TIMING_DEFAULTS = Object.freeze({
  idle_ms: 1500,          // 送ったあと、入力の気配がない
  typing_ms: 3000,        // 送ったあと、続けて入力している → 入力が止まってから
  max_ms: 20000,          // 最初のまだ返事をしていない発言から、最長
  crisis_idle_ms: 1000,   // 段階2の危機を検知した → 入力が止まってから
  crisis_max_ms: 5000,    // 段階2の危機を検知した → 最長
});
export function batchTiming(env = process.env) {
  let custom = {};
  try { custom = env.BATCH_TIMING ? JSON.parse(env.BATCH_TIMING) : {}; } catch { custom = {}; }
  const out = { ...BATCH_TIMING_DEFAULTS };
  for (const k of Object.keys(out)) {
    const v = Number(custom?.[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 120000) out[k] = v;
  }
  return out;
}

// 発言の数の上限(1時間。仮)。返事の数の上限は今までの RATE_LIMIT_PER_HOUR(60)を、まとまりの数で数える
export const batchPostLimit = (env = process.env) => {
  const n = Number(env.BATCH_POST_LIMIT_PER_HOUR ?? "200");
  return Number.isFinite(n) && n > 0 ? n : 200;
};

// まとまりの発言の数の上限(これを超えたら、画面は入力中でも返事を求める。サーバも超えた分は次のまとまりにはしない)
export const BATCH_MAX_MESSAGES = 20;

// 画面が付ける番号(client_msg_id・batch_id)の確かめ。英数字と - _ だけ・64文字まで
export const cleanId = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

// まとまりを決める。rows は会話の全部の行(seq の順)。to_seq までの、前の AI の返事より後の生徒の発言がまとまり。
//   replied: to_seq より後に AI の返事がある(もう返事をした。2回作らない)
//   newer:   to_seq より後に届いた生徒の発言(次のまとまり。作っている途中に届いたかの確かめにも使う)
export function batchOf(rows, toSeq) {
  const list = (rows ?? []).filter((r) => r && typeof r.seq === "number").sort((a, b) => a.seq - b.seq);
  const replied = list.some((r) => r.role === "ai" && r.seq > toSeq);
  const newer = list.filter((r) => r.role === "user" && r.seq > toSeq);
  const upto = list.filter((r) => r.seq <= toSeq);
  let start = upto.length;
  while (start > 0 && upto[start - 1].role === "user") start--;
  const batch = upto.slice(start);
  return { batch, replied, newer };
}

// 生成に渡すときの、まとまりの発言のつなぎ方(順番と区切りを残す)
export const joinBatch = (bodies) => (bodies ?? []).map((b) => String(b ?? "").trim()).filter(Boolean).join("\n");

// 会話の記録の中で続いている生徒の発言を1つにまとめる(生成・会話の流れの数え方に使う。過去のまとまりも同じ)
export function mergeUserRuns(hist) {
  const out = [];
  for (const h of hist ?? []) {
    const prev = out[out.length - 1];
    if (h?.role === "user" && prev?.role === "user") {
      out[out.length - 1] = {
        ...prev, ...h,
        body: joinBatch([prev.body, h.body]),
        flags: [...(Array.isArray(prev.flags) ? prev.flags : []), ...(Array.isArray(h.flags) ? h.flags : [])],
        batch_size: (prev.batch_size ?? 1) + 1,
      };
    } else {
      out.push(h);
    }
  }
  return out;
}

// 1通ごとの判定の結果のうち、記録に残すもの(messages.safety。JSON)
export function safetyToStore(s, extra = {}) {
  if (!s) return null;
  return {
    risk: s.risk ?? "none", subject: s.subject ?? "self", stage: s.stage ?? (s.risk === "crisis" ? 2 : s.risk === "watch" ? 1 : 0),
    decidedBy: s.decidedBy ?? [], keywords: s.keywords ?? [], patterns: s.patterns ?? [], idiomExempted: s.idiomExempted ?? [],
    floor: s.floor ?? [], hits: s.hits ?? [], keywordVersion: s.keywordVersion ?? null,
    // evidence: 分類器の根拠の引用(2026年11月9日。会話ログの自動評価の第1部「発言に根拠のない段階2」を数えるため。記録だけ)
    model: { risk: s.model?.risk ?? null, subject: s.model?.subject ?? null, reason: String(s.model?.reason ?? "").slice(0, 400),
      ...(s.model?.evidence ? { evidence: String(s.model.evidence).slice(0, 200) } : {}) },
    classifierMode: s.classifierMode ?? null,
    ...extra,
  };
}

// 危機の重さの順(本人の危機 > 第三者の危機 > 気がかり > なし)
const rankOf = (s) => (!s ? 0 : s.risk === "crisis" ? (s.subject === "other" ? 3 : 4) : s.risk === "watch" ? 2 : 1);

// まとまりの判定: いちばん重い1通の判定を使い、危機の種類はまとまり全体を合わせる(順番どおり・重ねない)。
// 判定が残っていない発言がある(保存に失敗した)ときは missing を返す(route.ts がその場で判定し直す)
export function aggregateBatchSafety(batch) {
  let best = null;
  const types = [];
  let missing = false;
  for (const r of batch ?? []) {
    const s = r?.safety;
    if (!s || typeof s !== "object") { missing = true; continue; }
    if (rankOf(s) >= rankOf(best)) best = s;
    for (const t of Array.isArray(s.types) ? s.types : []) if (!types.includes(t)) types.push(t);
  }
  return { safety: best, types, missing, crisis: !!best && best.risk === "crisis" };
}

// 同じまとまりで、すでに職員への通知を出したか(通知はまとまりの中で最初の1回だけ。人が確認)。
// notify_handled = そのまとまりの通知を受け持った発言(Webhook が無い環境では通知の結果が false でも、受け持ったことは残す)
export const notifiedInBatch = (rows, batchId) =>
  !!batchId && (rows ?? []).some((r) => r?.role === "user" && r.batch_id === batchId && r.safety?.notify_handled === true);

// 返事を作っている途中に新しい発言が届いたとき、作った返事を捨てて作り直すか。
// 保存の前なら捨てる。段階2のまとまりでは、作り直しは1回まで(危機の返事を遅らせない。人が確認)
export function shouldSupersede({ newer, crisis, rebuilt }) {
  if (!newer) return false;
  if (crisis && (Number(rebuilt) || 0) >= 1) return false;
  return true;
}

// 生成の指示に足す一行(まとまりが2通以上のとき)
export const BATCH_PROMPT_LINE =
  "・相談者は短い発言を続けて送ることがある(今回は{n}通を続けて送った。改行が区切り)。いちばん気持ちのこもった言葉を拾って、まとまり全体に1回で応える。1通ずつ順番に答えない。";
export const batchPromptLine = (n) => (n > 1 ? BATCH_PROMPT_LINE.replace("{n}", String(n)) : "");
