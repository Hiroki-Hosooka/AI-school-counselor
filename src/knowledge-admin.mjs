// ============================================================================
//  ナレッジ管理画面(public/knowledge.html)の入力の確かめ(docs/backlog.md 1-1。2026年10月11日)
//
//  心理士さんが Supabase の英語の画面を使わずに、ナレッジを直せるようにする。判断(確かめ)はサーバ側に置き、
//  画面は表示と入力だけ(CLAUDE.md 6節)。route.ts の admin_knowledge_* から使い、scripts/test-knowledge-admin.mjs で
//  オフラインに確かめる。
//
//  決まり(backlog 1-1・CLAUDE.md 3節)
//   ・削除はさせない。使わなくするときは active を外す(履歴は knowledge_history に残る)
//   ・新しく足すときは src(出典)・school(流派)・cat(種別)・weight(重心)を必ず埋める。流派の違う知識を混ぜないため
//   ・tags は、原則(principle)・禁止(ng)以外は1つ以上(原則・禁止は検索せず毎回プロンプトに全件載るので、タグは要らない。CLAUDE.md 7節)。
//     もともとタグの無い行(技法カタログ)を直すときは、空のままでもよい
//   ・禁止(ng)は強さ(lv 1〜3)が要る。禁止以外は lv を持たない
//   ・原則・禁止を全部使わない状態にはできない(最後の1件の active を外す・種別を変えることはできない)
//   ・逐語(verbatim)は要約しない(画面で注意を出す。ここでは本文が空でないことだけ確かめる)
// ============================================================================

export const KNOWLEDGE_CATS = ["principle", "ng", "stance", "ask", "resp", "read", "role", "verbatim", "limit", "ctx"];
export const KNOWLEDGE_WEIGHTS = ["rapport", "main", "goal", "plan", "any"];
export const KNOWLEDGE_SRCS = ["嶋", "石", "嶋石", "理", "設", "技"];
export const KNOWLEDGE_MODES = ["CBT", "SFBT", "NARRATIVE", "ASSERTION", "LISTEN_ONLY", "PROBLEM_SOLVING", "PSYCHOEDUCATION", "MI"];
// 原則・禁止は、最低1件は使う状態のまま残す
export const PROTECTED_CATS = ["principle", "ng"];

const ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_BODY = 2000;
const MAX_NOTE = 2000;

const str = (v) => (typeof v === "string" ? v.trim() : "");

// tags は配列か、読点・カンマ・空白で区切った文字列で受け取る
export function parseTags(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、\s]+/) : [];
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
}

// input: 画面から来た1件。existing: いまの全件(active でないものも含む)。isNew: 新しく足すか
// 戻り値: { ok: true, row }(DB に書く列だけ)か { ok: false, error }(生徒の目に触れない、心理士さん向けの日本語)
export function validateKnowledgeInput(input, existing, isNew) {
  const rows = Array.isArray(existing) ? existing : [];
  const id = str(input?.id);
  if (!ID_RE.test(id)) return { ok: false, error: "ID は半角の英数字・ハイフン・アンダースコアで、20字までにしてください" };
  const current = rows.find((r) => r.id === id) ?? null;
  if (isNew && current) return { ok: false, error: `ID「${id}」はもう使われています。別の ID にしてください` };
  if (!isNew && !current) return { ok: false, error: `ID「${id}」が見つかりません` };

  const src = str(input?.src);
  const school = str(input?.school);
  const cat = str(input?.cat);
  const weight = str(input?.weight) || "any";
  const body = str(input?.body);
  const note = str(input?.note);
  const tags = parseTags(input?.tags);
  const mode = str(input?.mode) || null;
  const active = input?.active !== false;
  const updatedBy = str(input?.updated_by).slice(0, 40);

  if (!KNOWLEDGE_SRCS.includes(src)) return { ok: false, error: `出典は ${KNOWLEDGE_SRCS.join("・")} のどれかにしてください` };
  if (!school) return { ok: false, error: "流派を入れてください(流派の違う知識を混ぜないため)" };
  if (!KNOWLEDGE_CATS.includes(cat)) return { ok: false, error: "種別を選んでください" };
  if (!KNOWLEDGE_WEIGHTS.includes(weight)) return { ok: false, error: "重心を選んでください" };
  if (!body) return { ok: false, error: "本文を入れてください" };
  if (body.length > MAX_BODY) return { ok: false, error: `本文は${MAX_BODY}字までにしてください` };
  if (note.length > MAX_NOTE) return { ok: false, error: `補足は${MAX_NOTE}字までにしてください` };
  // 直すときは、もともとタグが無い行(技法カタログなど)はそのままでもよい
  if (!PROTECTED_CATS.includes(cat) && tags.length === 0 && (isNew || (current?.tags?.length ?? 0) > 0 || current?.cat !== cat)) {
    return { ok: false, error: "タグを1つ以上入れてください(原則・禁止以外は、タグで検索して使うため)" };
  }
  let lv = null;
  if (cat === "ng") {
    lv = Number(input?.lv);
    if (![1, 2, 3].includes(lv)) return { ok: false, error: "禁止の強さ(3 絶対にしない / 2 避ける / 1 好ましくない)を選んでください" };
  }
  if (mode && !KNOWLEDGE_MODES.includes(mode)) return { ok: false, error: "モードの値が正しくありません" };

  // 原則・禁止を全部使わない状態にしない
  if (current && PROTECTED_CATS.includes(current.cat) && current.active !== false && (!active || cat !== current.cat)) {
    const othersActive = rows.filter((r) => r.id !== id && r.cat === current.cat && r.active !== false).length;
    if (othersActive === 0) {
      const ja = current.cat === "principle" ? "原則" : "禁止";
      return { ok: false, error: `使っている${ja}がこの1件だけなので、使わなくする・種別を変えることはできません` };
    }
  }

  return {
    ok: true,
    row: { id, src, school, cat, lv, weight, tags, body, note: note || null, mode, active, updated_by: updatedBy || "ナレッジ管理画面" },
  };
}
