// ============================================================================
//  テスト用: DB のナレッジ(有効なもの)が、db/seed_knowledge*.sql の行とそろっているかを、
//  生成を使うテスト(課金キーを使うもの)を始める前に確かめる(2026年10月6日)。
//
//  理由: 2026年9月のペルソナテストの記録では、ナレッジの世代がすべて「169件」だった
//  (docs/project-history.md 7-8節)。テストに使った DB に、あとから足した seed
//  (D3〜D6 の seed_knowledge_safety.sql、D7 の seed_knowledge_boundaries.sql)が入っていなかった
//  可能性がある。有料のペルソナテストは文面が決まってから1回だけ回す予定(CLAUDE.md 5.16)なので、
//  ナレッジが欠けたまま回して結果を無駄にしないように、始める前に止める。
//
//  ナレッジの唯一の情報源は DB(CLAUDE.md 3節)なので、DB にだけある行(あとから DB に足したもの)は
//  止める理由にしない(表示だけ)。seed にあるのに DB に無い(または無効になっている)行があれば止める。
//  わざとそうしている場合だけ、--allow-knowledge-mismatch を付けて続けられる。
//  中身(本文)の違いまでは見ない(DB で直した本文が seed と違うのは正しい状態なので)。
// ============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// README.md「2. テーブルを作る」で流す順番
export const SEED_FILES = [
  "db/seed_knowledge.sql",
  "db/seed_knowledge_structured.sql",
  "db/seed_knowledge_safety.sql",
  "db/seed_knowledge_boundaries.sql",
];

// seed の insert 文の各行(  ('ID', '出典', ...)から ID を取り出す
export function seedKnowledgeIds(root = ROOT) {
  const ids = [];
  for (const file of SEED_FILES) {
    const sql = readFileSync(path.join(root, file), "utf8");
    for (const m of sql.matchAll(/^\s*\('([A-Za-z0-9-]+)',/gm)) ids.push({ id: m[1], file });
  }
  return ids;
}

// rows: loadKnowledge() の戻り値(有効なナレッジ)
export function compareKnowledgeWithSeeds(rows, seeds = seedKnowledgeIds()) {
  const inDb = new Set(rows.map((k) => k.id));
  const inSeed = new Set(seeds.map((s) => s.id));
  return {
    seedCount: inSeed.size,
    dbCount: rows.length,
    missing: seeds.filter((s) => !inDb.has(s.id)),
    extra: rows.map((k) => k.id).filter((id) => !inSeed.has(id)),
  };
}

// 結果を表示し、欠けがあれば(--allow-knowledge-mismatch が無いかぎり)ここで止める
export function requireKnowledgeMatchesSeeds(rows, allowMismatch = process.argv.includes("--allow-knowledge-mismatch")) {
  const r = compareKnowledgeWithSeeds(rows);
  if (r.extra.length) {
    console.log(`(参考)DB にだけあるナレッジ ${r.extra.length}件: ${r.extra.slice(0, 10).join(", ")}${r.extra.length > 10 ? " …" : ""}`);
  }
  if (!r.missing.length) {
    console.log(`ナレッジ: DB の有効なもの ${r.dbCount}件。seed の ${r.seedCount}件はすべて入っている`);
    return r;
  }
  const byFile = {};
  for (const m of r.missing) (byFile[m.file] ??= []).push(m.id);
  const lines = Object.entries(byFile)
    .map(([file, ids]) => `  ${file}: ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ` …(${ids.length}件)` : ""}`);
  const msg = `DB の有効なナレッジ(${r.dbCount}件)に、seed にある ${r.missing.length}件が入っていません。\n${lines.join("\n")}\n`
    + "Supabase の SQL Editor で上のファイルを実行してから回してください(README.md「2. テーブルを作る」の順番)。\n"
    + "実行すると、そのファイルにある行は seed の内容で上書きされます(DB で本文を直した行があれば、先に控えておく)。\n"
    + "わざと入れていない(無効にしている)場合だけ、--allow-knowledge-mismatch を付けて続けられます。";
  if (allowMismatch) {
    console.warn(`警告: ${msg}`);
    return r;
  }
  console.error(msg);
  process.exit(1);
}
