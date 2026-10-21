// ============================================================================
//  採点用のログの書き出し(2026年10月21日。docs/prompts/hotfix-before-review.md 4章)
//
//  心理士さんに採点していただくため、生徒の画面に表示されたやり取り「だけ」を、1会話1ファイルの Markdown に書き出す。
//  ・内部の判定(関わりの型・重心・段階・問いの層・見立て・出力チェックの記録など)は書かない
//  ・どの版の会話かがわからないようにする:ファイル名・本文に版・日付・セッションIDを書かない。会話の順番も混ぜる
//  ・番号と版(セッションID・版・日時)の対応は、別のファイル(対応表)に残す。対応表は採点者に渡さない
//  ・窓口のカード・選択肢(チップ)は、画面に出た形で書く(page.tsx の HOTLINES と同じ内容。変えたら合わせる)
//
//  実行:
//    DB から(読むだけ。.env.local の SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY):
//      node scripts/export-review-logs.mjs --sessions=<id>,<id>,... [--out=review-export] [--seed=1]
//      node scripts/export-review-logs.mjs --since=2026-10-21T00:00 [--until=...] [--out=review-export]
//    画面と同じ経路のテストの記録(scripts/test-api-path.mjs --out=...)から:
//      node scripts/export-review-logs.mjs --from-jsonl=<file> [--out=review-export]
//  書き出し先(既定 review-export/)は .gitignore 済み。相談の中身を含むので、リポジトリにコミットしない。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const outDir = path.resolve(arg("out", path.join(ROOT, "review-export")));
const seed = Number(arg("seed", String(Date.now() % 100000)));

// 画面と同じ窓口(src/app/page.tsx の HOTLINES・CLOSING_HOTLINES と同じ。変えたら合わせる)
const HOTLINES = [
  ["24時間子供SOSダイヤル", "0120-0-78310"],
  ["チャイルドライン", "0120-99-7777"],
  ["よりそいホットライン", "0120-279-338"],
  ["こころの健康相談統一ダイヤル", "0570-064-556"],
  ["いますぐ危ないとき", "119"],
];
const CLOSING_HOTLINES = HOTLINES.filter(([name]) => name !== "いますぐ危ないとき");
const CARE_LINE = (await import(path.join(ROOT, "src/crisis-response.mjs"))).CARE_LINE_PROVISIONAL;

// ---- 会話を読む(どちらも同じ形の行の配列にする)----
// 行: { role: "user"|"ai", body, crisis, crisis_step, closing, safety_card, choices: [{id,label}], choice_id }
async function fromDb() {
  const { requireSupabaseEnv } = await import("./_lib/test-env.mjs");
  requireSupabaseEnv(ROOT);
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let ids = arg("sessions", "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) {
    const since = arg("since", ""); if (!since) throw new Error("--sessions か --since を指定してください");
    let q = db.from("sessions").select("id,started_at").gte("started_at", since).order("started_at");
    const until = arg("until", ""); if (until) q = q.lte("started_at", until);
    const { data, error } = await q; if (error) throw new Error(error.message);
    ids = (data ?? []).map((s) => s.id);
  }
  const convs = [];
  for (const id of ids) {
    let r = await db.from("messages")
      .select("seq,role,body,crisis,crisis_step,closing,safety_card,choices,choice_id,created_at,prompt_version,settings")
      .eq("session_id", id).order("seq");
    if (r.error) {   // 16節が未実行の DB(版の列が無い)
      r = await db.from("messages").select("seq,role,body,crisis,crisis_step,closing,safety_card,choices,choice_id,created_at")
        .eq("session_id", id).order("seq");
    }
    if (r.error) throw new Error(`${id}: ${r.error.message}`);
    const rows = r.data ?? [];
    if (!rows.length) continue;
    const ai = rows.filter((m) => m.role === "ai");
    const versions = [...new Set(ai.map((m) => m.settings?.app_version ?? String(m.prompt_version ?? "").split("#")[0]).filter(Boolean))];
    convs.push({ id, version: versions.join(" / ") || "(記録なし)", started: rows[0].created_at ?? "", rows });
  }
  return convs;
}

function fromJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => ({
    id: `${r.name}#${r.rep}(${r.label})`,
    version: [...new Set((r.stored ?? []).map((m) => m.settings?.app_version ?? String(m.prompt_version ?? "").split("#")[0]).filter(Boolean))].join(" / ") || r.label,
    started: "",
    rows: (r.stored ?? []).map((m) => ({ ...m })),
  }));
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
function render(no, conv) {
  const lines = [`# 会話 ${no}`, "",
    "(生徒の画面に表示されたやり取りだけを、上から順に書いています。画面の下には、いつも「119」「24時間子供SOSダイヤル」が表示されています。)", ""];
  let turn = 0;
  for (const m of conv.rows) {
    if (m.role === "user") {
      turn++;
      lines.push(`## ${turn}`, "", m.choice_id ? "**生徒**(選択肢から)" : "**生徒**", "", quote(m.body), "");
    } else {
      if (String(m.body ?? "").trim()) lines.push("**AI**", "", quote(m.body), "");
      for (const c of cardText(m)) lines.push(`　${c}`, "");
      if (Array.isArray(m.choices) && m.choices.length) lines.push(`　〔選択肢〕${m.choices.map((c) => `［${c.label}］`).join(" ")}`, "");
    }
  }
  return lines.join("\n");
}

// ---- 順番を混ぜて番号を付ける(seed で再現できる)----
function shuffle(arr, s) {
  const a = [...arr]; let x = s || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const jsonl = arg("from-jsonl", "");
const convs = shuffle(jsonl ? fromJsonl(jsonl) : await fromDb(), seed);
if (!convs.length) { console.error("書き出す会話がありません"); process.exit(1); }
fs.mkdirSync(path.join(outDir, "採点用"), { recursive: true });
const width = String(convs.length).length < 2 ? 2 : String(convs.length).length;
const map = [["番号", "セッション", "版", "最初の発言の日時"]];
convs.forEach((c, i) => {
  const no = String(i + 1).padStart(width, "0");
  fs.writeFileSync(path.join(outDir, "採点用", `会話${no}.md`), render(no, c));
  map.push([no, c.id, c.version, c.started]);
});
const csv = map.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
fs.writeFileSync(path.join(outDir, "対応表_採点者に渡さない.csv"), "﻿" + csv + "\n");
console.log(`${convs.length}件を書き出しました: ${path.join(outDir, "採点用")}(対応表: ${path.join(outDir, "対応表_採点者に渡さない.csv")}。seed ${seed})`);
