// ============================================================================
//  本番のナレッジの書き出し(ナレッジ管理画面の「JSONで書き出す」)を、リポジトリに取り込む(2026年11月6日。整理)
//
//    node scripts/import-knowledge-export.mjs <knowledge-export-YYYY-MM-DD.json> [--write]
//
//  何をするか:
//  1. 点検の一覧を出す(書き換えはしない): 件数(出典・種別ごと)、使っていない行、出典・流派の欠け、本文が同じ・ほぼ同じ行、
//     逐語(verbatim)の出典が取材(嶋・石・嶋石)でない行、禁止(ng)の強さ(lv)の欠け、技(取材未検証)なのに mode が無い行、
//     seed にあるのに書き出しに無い行・書き出しにだけある行(管理画面で足したもの)
//  2. --write のときだけ、次の2つを書く
//     - db/knowledge.json   使っている行だけ(テストが読むバックアップ。今までと同じ形 id/src/school/cat/lv/w/tags/text/mode)
//     - db/seed_knowledge_all.sql  全件(使っていない行も)を1つにまとめた seed。新しい DB に流すと本番と同じになる
//       (同じ id があれば上書き。insert ... on conflict (id) do update)
//  DB には書かない(読むのはファイルだけ)。ナレッジの唯一の情報源は本番の DB のまま(CLAUDE.md 3節)。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedKnowledgeIds } from "./_lib/knowledge-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const WRITE = args.includes("--write");
if (!file) { console.error("使い方: node scripts/import-knowledge-export.mjs <書き出したJSON> [--write]"); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const all = (Array.isArray(raw) ? raw : raw.knowledge ?? []).slice()
  .sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
const active = all.filter((k) => k.active !== false);
const count = (rows, key) => Object.entries(rows.reduce((o, k) => ((o[k[key] ?? "(なし)"] = (o[k[key] ?? "(なし)"] ?? 0) + 1), o), {}))
  .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ");

const out = [];
const p = (s = "") => out.push(s);
p(`書き出し: ${path.basename(file)}${raw.exported_at ? `(${raw.exported_at})` : ""}`);
p(`全件 ${all.length} / 使っている ${active.length} / 使っていない ${all.length - active.length}`);
p(`出典: ${count(active, "src")}`);
p(`種別: ${count(active, "cat")}`);

const section = (title, rows) => { p(""); p(`■ ${title}(${rows.length})`); for (const r of rows.slice(0, 50)) p(`  ${r}`); if (rows.length > 50) p(`  …ほか ${rows.length - 50}件`); };
const short = (t) => String(t ?? "").replace(/\s+/g, " ").slice(0, 50);

section("使っていない行(active=false)", all.filter((k) => k.active === false).map((k) => `${k.id} [${k.cat}] ${short(k.body)}`));
section("出典(src)か流派(school)が空", active.filter((k) => !k.src || !k.school).map((k) => `${k.id} src=${k.src ?? ""} school=${k.school ?? ""}`));
section("禁止(ng)なのに強さ(lv)が無い", active.filter((k) => k.cat === "ng" && ![1, 2, 3].includes(Number(k.lv))).map((k) => `${k.id} ${short(k.body)}`));
section("逐語(verbatim)なのに出典が取材(嶋・石・嶋石)でない", active.filter((k) => k.cat === "verbatim" && !["嶋", "石", "嶋石"].includes(k.src)).map((k) => `${k.id} src=${k.src}`));
section("出典が技なのに mode が無い", active.filter((k) => k.src === "技" && !k.mode).map((k) => `${k.id} ${short(k.body)}`));

// 本文が同じ・ほぼ同じ(記号と空白を除いて同じ、または片方がもう片方を含む)
const norm = (t) => String(t ?? "").replace(/[\s、。・「」『』()()!?！？…,.]/g, "");
const dup = [];
for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
  const a = norm(active[i].body), b = norm(active[j].body);
  if (!a || !b) continue;
  if (a === b) dup.push(`${active[i].id} と ${active[j].id}: 同じ本文`);
  else if (Math.min(a.length, b.length) >= 15 && (a.includes(b) || b.includes(a))) dup.push(`${active[i].id} と ${active[j].id}: 片方がもう片方を含む`);
}
section("本文が同じ・ほぼ同じ", dup);

// seed との食い違い
let seedRows = [];
try { seedRows = seedKnowledgeIds(ROOT); } catch (e) { p(`(seed を読めませんでした: ${e.message})`); }
const ids = new Set(all.map((k) => k.id));
const seedIds = new Set(seedRows.map((r) => r.id));
section("seed にあるのに書き出しに無い", seedRows.filter((r) => !ids.has(r.id)).map((r) => `${r.id}(${r.file})`));
section("書き出しにだけある(管理画面で足したもの)", all.filter((k) => !seedIds.has(k.id)).map((k) => `${k.id} [${k.src}/${k.cat}] ${short(k.body)}`));

if (WRITE) {
  // db/knowledge.json: 使っている行だけ。テストが読む今までの形にそろえる
  const json = active.map((k) => ({
    id: k.id, src: k.src, ...(k.school ? { school: k.school } : {}), cat: k.cat, ...(k.lv != null ? { lv: k.lv } : {}),
    w: k.weight ?? "any", tags: Array.isArray(k.tags) ? k.tags : [], text: k.body,
    ...(k.mode ? { mode: k.mode } : {}),
  }));
  fs.writeFileSync(path.join(ROOT, "db/knowledge.json"), JSON.stringify(json, null, 2) + "\n");
  // db/seed_knowledge_all.sql: 全件を1つにまとめた seed
  const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const arr = (v) => (Array.isArray(v) && v.length ? `ARRAY[${v.map(q).join(", ")}]::text[]` : "'{}'::text[]");
  // mode は1つの値(text。db/schema.sql 9.1)
  const modeSql = (v) => q(Array.isArray(v) ? (v[0] ?? null) : v ?? null);
  const lines = all.map((k) => `  (${[q(k.id), q(k.src), q(k.school), q(k.cat), k.lv == null ? "NULL" : Number(k.lv), q(k.weight ?? "any"), arr(k.tags), q(k.body), q(k.note ?? null), modeSql(k.mode), k.active === false ? "false" : "true"].join(", ")})`);
  const missingIds = seedRows.filter((r) => !ids.has(r.id));
  const missingNote = missingIds.length
    ? `\n-- ※書き出しの時点で本番に無かった seed の行(${missingIds.map((r) => r.id).join("・")})は入っていない。${[...new Set(missingIds.map((r) => r.file))].join("・")} を別に流す。`
    : "";
  const sql = `-- ナレッジの全件(本番の DB の書き出しから作った。${raw.exported_at ?? ""}。件数 ${all.length}。使っていない行も含む)
-- 作り方: ナレッジ管理画面の「JSONで書き出す」→ node scripts/import-knowledge-export.mjs <ファイル> --write(手で直さない)
-- 新しい DB には db/schema.sql のあとにこれを流す(同じ id があれば上書きする)。${missingNote}
-- 唯一の情報源は本番の DB(CLAUDE.md 3節)。ここは控え。

insert into knowledge (id, src, school, cat, lv, weight, tags, body, note, mode, active) values
${lines.join(",\n")}
on conflict (id) do update set src = excluded.src, school = excluded.school, cat = excluded.cat, lv = excluded.lv,
  weight = excluded.weight, tags = excluded.tags, body = excluded.body, note = excluded.note, mode = excluded.mode, active = excluded.active;
`;
  fs.writeFileSync(path.join(ROOT, "db/seed_knowledge_all.sql"), sql);
  p("");
  p(`書いた: db/knowledge.json(使っている ${json.length}件)・db/seed_knowledge_all.sql(全件 ${all.length}件)`);
}
console.log(out.join("\n"));
