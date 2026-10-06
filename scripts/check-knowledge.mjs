// ============================================================================
//  DB のナレッジ(有効なもの)が、db/seed_knowledge*.sql の行とそろっているかを確かめる(2026年10月6日)。
//  本番の DB を含め、seed の流し忘れが無いかを1コマンドで確かめるためのもの。DB は読むだけで変えない。
//
//    npm run check:knowledge
//
//  .env.local(または環境変数)の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を使う。Gemini は呼ばない(費用なし)。
//  出典ごとの件数(README.md「2. テーブルを作る」の確認と同じもの)を表示し、seed にあるのに DB に無い
//  (または無効になっている)行があれば、どのファイルを SQL Editor で実行すればよいかを表示して、終了コード1で終わる。
//  DB にだけある行(あとから DB に足したもの)は参考として表示するだけ(ナレッジの唯一の情報源は DB。CLAUDE.md 3節)。
//
//  背景: 2026年9月のペルソナテストの記録では、ナレッジが169件(140件+構造化の29件)で、
//  D3〜D7(seed_knowledge_safety.sql・seed_knowledge_boundaries.sql)が入っていなかった可能性がある
//  (docs/project-history.md 7-8節)。
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireSupabaseEnv } from "./_lib/test-env.mjs";
import { compareKnowledgeWithSeeds } from "./_lib/knowledge-check.mjs";
import { getDb, loadKnowledge, knowledgeVersion } from "../src/generate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSupabaseEnv(ROOT);

const rows = await loadKnowledge(getDb());
const bySrc = {};
for (const k of rows) bySrc[k.src] = (bySrc[k.src] ?? 0) + 1;
console.log(`ナレッジの世代: ${knowledgeVersion(rows)}`);
console.log(`出典ごとの件数: ${Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" / ")}`);

const r = compareKnowledgeWithSeeds(rows);
if (r.extra.length) console.log(`(参考)DB にだけあるナレッジ ${r.extra.length}件: ${r.extra.join(", ")}`);
if (!r.missing.length) {
  console.log(`OK: seed の ${r.seedCount}件はすべて DB に入っている(有効なもの ${r.dbCount}件)`);
  process.exit(0);
}
const byFile = {};
for (const m of r.missing) (byFile[m.file] ??= []).push(m.id);
console.error(`NG: seed にある ${r.missing.length}件が、DB の有効なナレッジに入っていません。`);
for (const [file, ids] of Object.entries(byFile)) console.error(`  ${file}: ${ids.join(", ")}`);
console.error("Supabase の SQL Editor で上のファイルを実行してください(README.md「2. テーブルを作る」の順番)。");
console.error("実行すると、そのファイルにある行は seed の内容で上書きされます(DB で本文を直した行があれば、先に控えておく)。");
console.error("わざと無効にしている(active = false の)行なら、そのままでよい(seed を実行しても有効には戻らない)。");
process.exit(1);
