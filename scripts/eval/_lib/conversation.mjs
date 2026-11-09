// ============================================================================
//  会話の読み込みと、生徒の画面に出た形の書き出し(会話ログの自動評価 と 心理士さんの採点用の書き出しで共通。2026年11月9日)
//
//  読み込み: テストの記録(.jsonl。画面と同じ API の経路で流した合成の台本)・DB のセッション
//  書き出し: 生徒の画面に表示されたやり取り「だけ」(内部の判定・版・日付・セッションIDは書かない)。発言ごとに「## 番号」を付ける
//            (採点の根拠のターンの番号に使う。AI の返事は、その前の発言と同じ番号)
//  scripts/export-review-logs.mjs(心理士さんの採点用)と scripts/eval/export-bundle.mjs(Claude の採点用)が同じ形で書き出す
//  (第4部で、心理士さんと Claude が同じ見た目のログを採点するため)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// 画面と同じ窓口(src/app/page.tsx の HOTLINES・CLOSING_HOTLINES と同じ。変えたら合わせる)
export const HOTLINES = [
  ["24時間子供SOSダイヤル", "0120-0-78310"],
  ["チャイルドライン", "0120-99-7777"],
  ["よりそいホットライン", "0120-279-338"],
  ["こころの健康相談統一ダイヤル", "0570-064-556"],
  ["いますぐ危ないとき", "119"],
];
const CLOSING_HOTLINES = HOTLINES.filter(([name]) => name !== "いますぐ危ないとき");
const CARE_LINE = (await import(path.join(ROOT, "src/crisis-response.mjs"))).CARE_LINE_PROVISIONAL;

const versionOfRow = (m) => m.settings?.app_version ?? String(m.prompt_version ?? "").split("#")[0];
// 会話の版(返事をしたモデル・プロンプトの版・ナレッジの版)。AI の返事の行の記録から集める
export function versionsOf(rows) {
  const ai = (rows ?? []).filter((m) => m.role === "ai");
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    app_version: uniq(ai.map(versionOfRow)),
    models: uniq(ai.map((m) => m.model)),
    knowledge_version: uniq(ai.map((m) => m.knowledge_version)),
  };
}

// ---- テストの記録(scripts/test-api-path.mjs --out=… の形。1行1会話)----
export function loadJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r, i) => ({
    source: { kind: "jsonl", file: path.relative(ROOT, path.resolve(file)), line: i + 1, scenario: r.name ?? null, rep: r.rep ?? null, label: r.label ?? null },
    id: `${r.name}#${r.rep}(${r.label})`,
    rows: (r.stored ?? []).map((m) => ({ ...m })),
    events: (r.events ?? []).map((e) => ({ ...e })),
  }));
}

// ---- DB のセッション ----
// requireMarked: true のとき、「開発メンバーのテスト」の印(21節 dev_test)か、テストスクリプトのセッション(is_synthetic)だけを読む。
// 印の無いセッションが1つでもあれば、何も読まずに止める(実際の生徒の会話を書き出さないため。設計 2-3)
const MSG_COLS = "seq,role,body,crisis,crisis_step,closing,safety_card,choices,choice_set,choice_id,flags,created_at,mode,summarized";
const MSG_COLS_V16 = `${MSG_COLS},model,prompt_version,knowledge_version,settings`;
export async function loadDbSessions(db, ids, { requireMarked = true } = {}) {
  if (!ids?.length) throw new Error("セッションIDを1つずつ指定してください(期間での指定は受け付けません)");
  if (requireMarked) {
    const r = await db.from("sessions").select("id,dev_test,is_synthetic").in("id", ids);
    if (r.error) throw new Error(`「開発メンバーのテスト」の印を読めません(db/schema.sql 21節が未実行かもしれません): ${r.error.message}`);
    const ok = new Set((r.data ?? []).filter((s) => s.dev_test === true || s.is_synthetic === true).map((s) => s.id));
    const ng = ids.filter((id) => !ok.has(id));
    if (ng.length) throw new Error(`「開発メンバーのテスト」の印の無いセッションがあります(書き出しません): ${ng.join(", ")}`);
  }
  const convs = [];
  for (const id of ids) {
    // 新しい節の列から順に試す(未実行の DB では、無い列を外して読み直す)
    let rows = null;
    for (const cols of [`${MSG_COLS_V16},failure,referral`, `${MSG_COLS_V16},failure`, MSG_COLS_V16, MSG_COLS]) {
      const r = await db.from("messages").select(cols).eq("session_id", id).order("seq");
      if (!r.error) { rows = r.data ?? []; break; }
    }
    if (rows == null) throw new Error(`${id}: 会話を読めません`);
    if (!rows.length) continue;
    const ev = await db.from("safety_events").select("*").eq("session_id", id).order("seq");
    convs.push({ source: { kind: "db", session_id: id }, id, rows, events: ev.error ? [] : ev.data ?? [] });
  }
  return convs;
}

// ---- 画面に出た形の文 ----
const quote = (t) => String(t ?? "").trim().split("\n").map((l) => `> ${l}`).join("\n");
const hotlineList = (list) => list.map(([n, num]) => `${n} ${num}`).join(" ／ ");
function cardText(m) {
  const card = m.safety_card ?? (m.crisis && m.crisis_step == null ? "crisis" : null);
  const out = [];
  if (card === "crisis") out.push(`〔窓口のカード〕話せる窓口:${hotlineList(HOTLINES)}。どれも無料で、名前を言わなくても話せます。学校の先生や保健室の先生に、この画面を見せるだけでも伝わります。`);
  if (card === "care") out.push(`〔気づかいのカード〕${CARE_LINE}(その下に、閉じた状態の「話せる窓口」)`);
  if (card === "hotlines") out.push("〔閉じた状態の「話せる窓口」〕");
  if (m.closing) out.push(`〔区切りのカード〕また話したくなったら:${hotlineList(CLOSING_HOTLINES)}。しんどくなったら、ここに書いたところにも頼っていいからね。もちろん、また続きをここで話しに来てくれてもいいよ。`);
  return out;
}

// title: 見出し(「会話 03」「L001」など)。turns: ターンの番号 → そのターンに画面に出た文(根拠の引用の確かめに使う)
export function renderConversation(title, rows) {
  const lines = [`# ${title}`, "",
    "(生徒の画面に表示されたやり取りだけを、上から順に書いています。画面の下には、いつも「119」「24時間子供SOSダイヤル」が表示されています。)", ""];
  const turns = {};
  let turn = 0;
  const add = (t) => { turns[turn] = `${turns[turn] ?? ""}\n${t}`; };
  for (const m of rows) {
    if (m.role === "user") {
      turn++;
      lines.push(`## ${turn}`, "", m.choice_id ? "**生徒**(選択肢から)" : "**生徒**", "", quote(m.body), "");
      add(String(m.body ?? ""));
    } else if (m.role === "ai") {
      if (turn === 0 && !turns[0]) lines.push("## 0", "");
      if (String(m.body ?? "").trim()) { lines.push("**AI**", "", quote(m.body), ""); add(String(m.body ?? "")); }
      for (const c of cardText(m)) { lines.push(`　${c}`, ""); add(c); }
      if (Array.isArray(m.choices) && m.choices.length) {
        const ch = `〔選択肢〕${m.choices.map((c) => `［${c.label}］`).join(" ")}`;
        lines.push(`　${ch}`, ""); add(ch);
      }
    }
  }
  return { markdown: lines.join("\n"), turns };
}

// 書き出したログ(Markdown)から、ターンの番号 → 文 を読み直す(取り込みで、根拠の引用を確かめるため)
export function turnsOfMarkdown(md) {
  const turns = {};
  let cur = null;
  for (const line of String(md ?? "").split("\n")) {
    const h = line.match(/^## (\d+)\s*$/);
    if (h) { cur = Number(h[1]); turns[cur] = ""; continue; }
    if (cur == null) continue;
    const t = line.replace(/^> ?/, "").replace(/^　/, "");
    if (/^\*\*(生徒|AI)\*\*/.test(t)) continue;
    turns[cur] += `${t}\n`;
  }
  return turns;
}

// 順番を混ぜる(seed で再現できる)
export function shuffle(arr, s) {
  const a = [...arr]; let x = s || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
