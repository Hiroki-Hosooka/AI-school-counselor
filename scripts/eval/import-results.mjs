// ============================================================================
//  会話ログの自動評価 第5部: 採点の結果の取り込み・集計・回帰の表(2026年11月9日。docs/design-auto-eval.md 6章)
//
//    node scripts/eval/import-results.mjs --batch=<束> --from=<評価専用のフォルダの results/> --rater-model=<採点に使ったモデル>
//    node scripts/eval/import-results.mjs --compare=<前の束>,<後の束>      (取り込み済みの2つの束を並べる)
//    node scripts/eval/import-results.mjs --batch=<束> --metrics-only      (採点を待たずに、コードの指標だけの報告)
//
//  eval/batches/<束>/ に書く:
//    results-raw/run1〜3/  採点の会話が書いた JSON の控え(そのまま)
//    results.json          ログごと: 元の記録と版・コードの指標・AI の採点(3回の真ん中の値・揺れ・確かめで外した理由・違和感の印)
//    report.md             回帰の表(コードの指標で悪くなったものを先に)・人が先に読む一覧・AI の採点(未較正は別の段)
//  AI の点は、第4部で使えると決まった項目(docs/evaluation/rubric-v1-validated.json)だけを「使える」として出す。
//  それ以外は「未較正」として表の下の段に分ける(判断に使わない)。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { turnsOfMarkdown } from "./_lib/conversation.mjs";
import { ITEMS, ITEM_NAMES, validateResult, aggregateLog } from "./_lib/results.mjs";
import { METRIC_LABELS, WORSE_IF_HIGHER, metricValue, readFirstScore } from "../../src/eval-metrics.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BATCHES = path.join(ROOT, "eval/batches");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const validatedItems = (rubricVersion, root = ROOT) => {
  try {
    const v = readJson(path.join(root, `docs/evaluation/${rubricVersion}-validated.json`));
    return v.rubric_version === rubricVersion && Array.isArray(v.validated) ? v.validated : [];
  } catch { return []; }
};

// 1つの束の結果を取り込む(テストからも呼ぶ)
export function importBatch({ bdir, from, raterModel, root = ROOT }) {
  const mapping = readJson(path.join(bdir, "mapping.json"));
  const metrics = readJson(path.join(bdir, "code-metrics.json")).logs ?? {};
  const logs = {};
  const missing = [];
  for (const m of mapping.logs) {
    const turns = turnsOfMarkdown(fs.readFileSync(path.join(bdir, "logs", `${m.log_id}.md`), "utf8"));
    const runs = [];
    const problems = {};
    for (let r = 1; r <= (mapping.runs ?? 3); r++) {
      const src = from ? path.join(from, `run${r}`, `${m.log_id}.json`) : null;
      const kept = path.join(bdir, "results-raw", `run${r}`, `${m.log_id}.json`);
      if (src && fs.existsSync(src)) { fs.mkdirSync(path.dirname(kept), { recursive: true }); fs.copyFileSync(src, kept); }
      if (!fs.existsSync(kept)) { missing.push(`run${r}/${m.log_id}`); continue; }
      let json = null;
      try { json = readJson(kept); } catch (e) { problems[`run${r}`] = [`JSON として読めない: ${String(e.message).slice(0, 60)}`]; continue; }
      const result = validateResult(json, { logId: m.log_id, run: r, rubricVersion: mapping.rubric_version, turns });
      const itemProblems = ITEMS.flatMap((it) => (result.items[it]?.problems ?? []).map((p) => `${it}: ${p}`));
      if (result.problems.length || itemProblems.length) problems[`run${r}`] = [...result.problems, ...itemProblems];
      runs.push({ run: r, result });
    }
    logs[m.log_id] = {
      side: m.side, part: m.part, source: m.source, versions: m.versions, code_metrics: metrics[m.log_id] ?? null,
      ai: runs.length ? aggregateLog(runs) : null, problems,
    };
  }
  const out = {
    batch: mapping.batch, rubric_version: mapping.rubric_version, metrics_version: mapping.metrics_version,
    rater_model: raterModel ?? null, imported_at: new Date().toISOString(),
    validated_items: validatedItems(mapping.rubric_version, root), missing, logs,
  };
  fs.writeFileSync(path.join(bdir, "results.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

const mean = (xs) => { const a = xs.filter((x) => Number.isFinite(x)); return a.length ? Math.round((a.reduce((p, q) => p + q, 0) / a.length) * 100) / 100 : null; };
const fmt = (x) => (x == null ? "—" : String(x));

// 報告(回帰の表)。groups: [{ name, logs: { id: log } }]。2つ以上あれば、最初を「前」、最後を「後」として比べる
export function buildReport(title, groups, { raterModel = null, rubricVersion = "rubric-v1", validated = [], missing = [] } = {}) {
  const L = [`# ${title}`, ""];
  L.push(`- 採点基準: ${rubricVersion} / 採点に使ったモデル: ${raterModel ?? "(未記入)"} / コードの指標: ${groups[0] && Object.values(groups[0].logs)[0]?.code_metrics?.metrics_version || "—"}`);
  L.push(`- 使える(心理士さんの採点と一致した)項目: ${validated.length ? validated.join("・") : "なし(すべて未較正。第4部が終わるまで AI の点を判断に使わない)"}`);
  if (missing.length) L.push(`- 採点の結果が無い: ${missing.length}件(${missing.slice(0, 8).join("・")}${missing.length > 8 ? " …" : ""})`);
  L.push("");
  const before = groups[0], after = groups.at(-1);
  const cmp = groups.length >= 2;

  // ---- 1. コードの指標 ----
  L.push("## 1. コードの指標(AI を使わない。毎回同じ結果)", "");
  const rows = Object.keys(METRIC_LABELS).map((key) => {
    const vals = groups.map((g) => mean(Object.values(g.logs).map((l) => metricValue(l.code_metrics, key))));
    const worse = cmp && WORSE_IF_HIGHER.includes(key) && vals[0] != null && vals.at(-1) != null && vals.at(-1) > vals[0];
    return { key, vals, worse };
  });
  rows.sort((a, b) => Number(b.worse) - Number(a.worse));
  L.push(`| | 指標(会話あたりの平均) | ${groups.map((g) => g.name).join(" | ")} |`, `|---|---|${groups.map(() => "---").join("|")}|`);
  for (const r of rows) L.push(`| ${r.worse ? "**悪くなった**" : ""} | ${METRIC_LABELS[r.key]} | ${r.vals.map(fmt).join(" | ")} |`);
  L.push("");

  // ---- 2. 人が先に読む一覧(コードの指標と、くり返し付いた違和感の印。AI の点は使わない)----
  L.push("## 2. 人が先に読む一覧", "", "コードの指標で気になる数が多い順(同じなら、2回以上の採点で付いた違和感の印が多い順)。", "");
  const all = groups.flatMap((g) => Object.entries(g.logs).map(([id, l]) => ({ id, group: g.name, l })));
  all.sort((a, b) => readFirstScore(b.l.code_metrics) - readFirstScore(a.l.code_metrics)
    || (b.l.ai?.flags?.filter((f) => f.repeated).length ?? 0) - (a.l.ai?.flags?.filter((f) => f.repeated).length ?? 0));
  L.push("| ログ | 束・前後 | 目安 | 気になったこと | くり返し付いた違和感の印 |", "|---|---|---|---|---|");
  for (const { id, group, l } of all.slice(0, 20)) {
    const d = (l.code_metrics?.details ?? []).slice(0, 3).join(" / ");
    const f = (l.ai?.flags ?? []).filter((x) => x.repeated).map((x) => `T${x.turn} ${x.label}`).join("・");
    L.push(`| ${id} | ${group}${l.side && l.side !== group ? `・${l.side}` : ""} | ${readFirstScore(l.code_metrics)} | ${d || "—"} | ${f || "—"} |`);
  }
  L.push("");

  // ---- 3. AI の採点 ----
  const anyAi = all.some((x) => x.l.ai);
  L.push("## 3. AI の採点(3回の真ん中の値の平均)", "");
  if (!anyAi) { L.push("まだ取り込んでいない。", ""); return L.join("\n"); }
  const table = (items, label) => {
    if (!items.length) return;
    L.push(label, "", `| 項目 | ${groups.map((g) => g.name).join(" | ")} | 揺れた会話 | 外した採点 |`, `|---|${groups.map(() => "---").join("|")}|---|---|`);
    for (const it of items) {
      const vals = groups.map((g) => mean(Object.values(g.logs).map((l) => l.ai?.items?.[it]?.median)));
      const unstable = all.filter((x) => x.l.ai?.items?.[it]?.unstable).length;
      const invalid = all.reduce((s, x) => s + (x.l.ai?.items?.[it]?.invalid ?? 0), 0);
      L.push(`| ${it} ${ITEM_NAMES[it]} | ${vals.map(fmt).join(" | ")} | ${unstable} | ${invalid} |`);
    }
    L.push("");
  };
  table(ITEMS.filter((it) => validated.includes(it)), "### 使える項目");
  table(ITEMS.filter((it) => !validated.includes(it)), "### 未較正(心理士さんの採点と比べていない。判断に使わない)");
  L.push("揺れた会話 = 3回の採点で差が2以上。外した採点 = 根拠の引用がログに無い・点数の形が違うなどで数えなかった回の数。", "");
  void before; void after;
  return L.join("\n");
}

// ---- コマンドとして動かしたとき ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  try {
    const compare = arg("compare", "");
    if (compare) {
      const names = compare.split(",").map((x) => x.trim()).filter(Boolean);
      const res = names.map((n) => ({ name: n, r: readJson(path.join(BATCHES, n, "results.json")) }));
      const md = buildReport(`回帰の表: ${names.join(" → ")}`, res.map(({ name, r }) => ({ name, logs: r.logs })),
        { raterModel: [...new Set(res.map((x) => x.r.rater_model))].join(" / "), rubricVersion: res[0].r.rubric_version, validated: validatedItems(res[0].r.rubric_version) });
      const file = path.join(BATCHES, names.at(-1), `compare-${names[0]}.md`);
      fs.writeFileSync(file, md + "\n");
      console.log(`書き出しました: ${path.relative(ROOT, file)}`);
    } else {
      const batch = arg("batch", "");
      if (!batch) throw new Error("--batch=<束の名前> を指定してください");
      const bdir = path.join(BATCHES, batch);
      const metricsOnly = process.argv.includes("--metrics-only");
      const raterModel = arg("rater-model", "");
      if (!metricsOnly && !raterModel) throw new Error("--rater-model=<採点に使ったモデルの名前> を指定してください(/status で確かめた名前)");
      const r = importBatch({ bdir, from: metricsOnly ? null : arg("from", "") ? path.resolve(arg("from", "")) : null, raterModel: raterModel || null });
      // 束の中に前と後があれば、前と後で分けて並べる(無ければ1列)
      const sides = [...new Set(Object.values(r.logs).map((l) => l.side ?? "(前後なし)"))].sort((a, b) => (a === "before" ? -1 : b === "before" ? 1 : a.localeCompare(b)));
      const groups = sides.map((s) => ({ name: s, logs: Object.fromEntries(Object.entries(r.logs).filter(([, l]) => (l.side ?? "(前後なし)") === s)) }));
      const md = buildReport(`会話ログの評価: ${batch}`, groups, { raterModel: r.rater_model, rubricVersion: r.rubric_version, validated: r.validated_items, missing: metricsOnly ? [] : r.missing });
      fs.writeFileSync(path.join(bdir, "report.md"), md + "\n");
      const bad = Object.entries(r.logs).filter(([, l]) => Object.keys(l.problems).length);
      console.log(`取り込みました: ${Object.keys(r.logs).length}件(結果が無い ${r.missing.length}・確かめで外したものがあるログ ${bad.length})`);
      for (const [id, l] of bad.slice(0, 10)) console.log(`  ${id}: ${Object.entries(l.problems).map(([k, v]) => `${k} ${v.slice(0, 2).join(" / ")}`).join(" | ")}`);
      console.log(`報告: ${path.relative(ROOT, path.join(bdir, "report.md"))}`);
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
