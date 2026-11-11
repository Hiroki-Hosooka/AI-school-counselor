// ============================================================================
//  会話ログの自動評価 第2部: 評価専用のフォルダを作る(2026年11月9日。docs/design-auto-eval.md 2章)
//
//    テストの記録から(合成の台本。前と後を混ぜる):
//      node scripts/eval/export-bundle.mjs --out=~/sc-eval --batch=<束の名前> --jsonl=before:<記録.jsonl>,after:<記録.jsonl>
//    DB のセッションから(「開発メンバーのテスト」の印 = db/schema.sql 21節 か、テストスクリプトのセッションだけ):
//      node scripts/eval/export-bundle.mjs --out=~/sc-eval --batch=<束の名前> --sessions=<id>,<id>
//    そのほか: --seed=<数>(順番の混ぜ方)・--per-part=10(1回の会話で採点する数)
//
//  評価専用のフォルダ(--out。プロジェクトの外。中に入れると止める):
//    rubric.md(採点の会話への指示 + 採点基準)・HOW-TO-RUN.md・.claude/settings.json・logs/part-a/L001.md …・results/run1〜3/
//  プロジェクトの中(eval/batches/<束>/。合成の台本と開発メンバーのテストだけなのでコミットしてよい):
//    mapping.json(通し番号 → 元の記録・版・前か後か。評価専用のフォルダには置かない)・logs/(同じログの控え)・code-metrics.json(第1部)
//  実際の生徒の会話は書き出さない: 期間での指定を受け付けず、DB は印のあるセッションだけ(設計 2-3)。
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonl, loadDbSessions, renderConversation, shuffle, versionsOf } from "./_lib/conversation.mjs";
import { conversationMetricsForEval, EVAL_METRICS_VERSION } from "../../src/eval-metrics.mjs";
import { GENERATION_FAILURE_REPLIES } from "../../src/generate.mjs";
import { GENERATION_STUCK_NOTICE } from "../../src/notices.mjs";

// 生成に失敗したときの文(返事の代わりに出る文)を含む会話か(2026年11月11日。無料枠の上限で作り直しても届かず、
// 「仕組みの調子が悪く」が3回入った会話を書き出していた。採点の対象にしても意味が無いので、書き出さない)
const FAILURE_TEXTS = [...GENERATION_FAILURE_REPLIES, GENERATION_STUCK_NOTICE];
export const hasFailureText = (rows) => (rows ?? []).some((r) => r?.role === "ai" && FAILURE_TEXTS.some((t) => String(r.body ?? "").includes(t)));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const RUBRIC_VERSION = "rubric-v1";
export const RUNS = 3;

// プロジェクトの中(またはその下)か。中なら評価専用のフォルダにしない(Claude Code は親のフォルダの CLAUDE.md も読むため)
export function insideProject(dir, root = ROOT) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

// 採点の会話に渡す rubric.md(指示 + 採点基準。版の名前を1行目に)
export function rubricText(root = ROOT) {
  const ins = fs.readFileSync(path.join(root, "docs/evaluation/scoring-instructions-v1.md"), "utf8");
  const rub = fs.readFileSync(path.join(root, "docs/evaluation/rubric-v1.md"), "utf8");
  return `<!-- ${RUBRIC_VERSION} -->\n${ins.trim()}\n\n---\n\n${rub.trim()}\n`;
}

// 会話の束を、通し番号・part に割り当てる(順番は seed で混ぜる)
export function assignIds(convs, { seed, perPart = 10 }) {
  const mixed = shuffle(convs, seed);
  return mixed.map((c, i) => ({
    ...c, log_id: `L${String(i + 1).padStart(3, "0")}`, part: `part-${String.fromCharCode(97 + Math.floor(i / perPart))}`,
  }));
}

// 評価専用のフォルダとプロジェクトの控えを書く(テストからも呼ぶ)
export function writeBundle({ out, batch, convs, seed, perPart = 10, root = ROOT, batchesDir = path.join(root, "eval/batches"), allowFailureTexts = false }) {
  if (insideProject(out, root)) throw new Error(`評価専用のフォルダは、プロジェクトの外に作ってください(${out})`);
  if (fs.existsSync(path.join(out, "logs")) && fs.readdirSync(path.join(out, "logs")).length) {
    throw new Error(`${out}/logs にすでにログがあります。別の束と混ざらないよう、空のフォルダを指定してください`);
  }
  if (!/^[\w.-]+$/.test(batch)) throw new Error("束の名前は英数字・._- だけにしてください");
  const bdir = path.join(batchesDir, batch);
  if (fs.existsSync(path.join(bdir, "mapping.json"))) throw new Error(`束 ${batch} はすでにあります`);
  if (!convs.length) throw new Error("書き出す会話がありません");
  const failed = convs.filter((c) => hasFailureText(c.rows));
  if (failed.length && !allowFailureTexts) {
    throw new Error(`生成に失敗したときの文を含む会話が${failed.length}件あります(${failed.map((c) => c.source?.scenario ?? c.id ?? "?").join(", ")})。`
      + "外して書き出すか、わざと含めるときは --allow-failure-texts を付けてください");
  }

  const items = assignIds(convs, { seed, perPart });
  fs.mkdirSync(path.join(out, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(out, "rubric.md"), rubricText(root));
  fs.copyFileSync(path.join(root, "docs/evaluation/HOW-TO-RUN.md"), path.join(out, "HOW-TO-RUN.md"));
  fs.copyFileSync(path.join(root, "docs/evaluation/eval-settings.json"), path.join(out, ".claude/settings.json"));
  for (let r = 1; r <= RUNS; r++) fs.mkdirSync(path.join(out, "results", `run${r}`), { recursive: true });
  fs.mkdirSync(path.join(bdir, "logs"), { recursive: true });

  const mapping = [];
  const metrics = {};
  for (const it of items) {
    const { markdown } = renderConversation(it.log_id, it.rows);
    fs.mkdirSync(path.join(out, "logs", it.part), { recursive: true });
    fs.writeFileSync(path.join(out, "logs", it.part, `${it.log_id}.md`), markdown);
    fs.writeFileSync(path.join(bdir, "logs", `${it.log_id}.md`), markdown);
    mapping.push({ log_id: it.log_id, part: it.part, side: it.side ?? null, source: it.source, versions: versionsOf(it.rows) });
    metrics[it.log_id] = conversationMetricsForEval(it.rows, it.events);
  }
  const meta = {
    batch, created: new Date().toISOString(), rubric_version: RUBRIC_VERSION, metrics_version: EVAL_METRICS_VERSION,
    seed, per_part: perPart, runs: RUNS, count: items.length,
    note: "通し番号と元の記録・版の対応。評価専用のフォルダ(採点の会話)には渡さない",
  };
  fs.writeFileSync(path.join(bdir, "mapping.json"), JSON.stringify({ ...meta, logs: mapping }, null, 2) + "\n");
  fs.writeFileSync(path.join(bdir, "code-metrics.json"), JSON.stringify({ metrics_version: EVAL_METRICS_VERSION, logs: metrics }, null, 2) + "\n");
  return { items, bdir };
}

// ---- コマンドとして動かしたとき ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  if (process.argv.some((a) => a.startsWith("--since") || a.startsWith("--until"))) {
    console.error("期間での指定は受け付けません(実際の生徒の会話を書き出さないため)。--sessions でセッションIDを1つずつ指定してください");
    process.exit(1);
  }
  const out = path.resolve(expandHome(arg("out", "")));
  if (!arg("out", "")) { console.error("--out=<評価専用のフォルダ(プロジェクトの外)> を指定してください"); process.exit(1); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const batch = arg("batch", `eval-${stamp}`);
  const seed = Number(arg("seed", String(Date.now() % 100000)));
  const perPart = Number(arg("per-part", "10"));
  const convs = [];
  for (const spec of arg("jsonl", "").split(",").filter(Boolean)) {
    const m = spec.match(/^([\w-]+):(.+)$/);
    const [side, file] = m ? [m[1], m[2]] : [null, spec];
    for (const c of loadJsonl(path.resolve(file))) convs.push({ ...c, side: side ?? c.source.label ?? null });
  }
  const ids = arg("sessions", "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length) {
    const { requireSupabaseEnv } = await import("../_lib/test-env.mjs");
    requireSupabaseEnv(ROOT);
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const side = arg("side", null);
    for (const c of await loadDbSessions(db, ids)) convs.push({ ...c, side });
  }
  try {
    const { items, bdir } = writeBundle({ out, batch, convs, seed, perPart, allowFailureTexts: process.argv.includes("--allow-failure-texts") });
    const parts = [...new Set(items.map((i) => i.part))];
    console.log(`${items.length}件を書き出しました(${parts.join("・")})。seed ${seed}`);
    console.log(`  評価専用のフォルダ: ${out}(手順は HOW-TO-RUN.md)`);
    console.log(`  対応表・控え・コードの指標: ${path.relative(ROOT, bdir)}/`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
