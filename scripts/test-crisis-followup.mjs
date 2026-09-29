// ============================================================================
//  見守り中・危機の応答を始めたあと用の分類器(危機検知の作り直し 第2段階・2026年9月29日)の検証
//
//  実行:
//   node scripts/test-crisis-followup.mjs
//      開発用の文(docs/test-sets/crisis-followup-dev.json)を、見守り中・危機のあとの判定
//      (src/classify.mjs の classifyStaged(…, { mode: "followup" }))に通す
//   --reps=3(1文あたりの判定回数)、--out=<記録.jsonl>(同じファイルを渡すと続きから)、
//   --compare-normal(比べるために、通常の判定(第1段階で採用したもの。変えていない)にも1回ずつ通す)
//
//  止める条件: 危機(crisis)でなければならない文(明示的な表現・受動的な希死念慮・念押し)が段階2に
//  ならなかったら、その時点で止めて報告する(見守り中・危機のあとの判定で、新しい危機のサインを見逃さないため)。
//  保留セットは使わない。無料枠のキー(TEST_GEMINI_API_KEY(S))を使う(予算の¥1000枠とは別)。
//  分類モデルは主力モデル(LITE_MODELS の先頭)だけにする(scripts/test-crisis-staged.mjs と同じ理由)。
//  結果は記録(.jsonl)・集計(-summary.txt / .json)・エクセル(.xlsx。scripts/export-crisis-followup-xlsx.py)に書き出す。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep } from "./_lib/test-env.mjs";
import { LITE_MODELS, classifyStaged } from "../src/classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const ROTATION = createKeyRotationState();

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const REPS = Number(arg("reps", 3));
const PATIENCE = Number(arg("patience", 6));
const COMPARE_NORMAL = process.argv.includes("--compare-normal");
const SET_PATH = path.resolve(ROOT, arg("set", "docs/test-sets/crisis-followup-dev.json"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/crisis-followup-dev-${stamp}.jsonl`));

// 検証の条件(scripts/test-crisis-staged.mjs と同じ): 主力モデルだけ・1回あたりの待ち時間の上限を長く
const PRIMARY_MODEL = LITE_MODELS[0];
LITE_MODELS.splice(1);
process.env.CRISIS_CLASSIFIER_TIMEOUT_MS = arg("timeout-ms", "120000");

const set = JSON.parse(readFileSync(SET_PATH, "utf8"));
const items = set.items.map((it, i) => ({
  id: `F${i + 1}`, text: it.text, context: set.contexts[it.context] ?? [], context_id: it.context,
  expected: it.label, category: it.category,
}));
const MUST_BE_CRISIS = new Set(["explicit", "passive", "restate"]);

const isTransient = (t) => !!t && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(t);

async function judgeOnce(item, mode) {
  const t0 = Date.now();
  const r = await classifyStaged(item.text, item.context, { mode });
  const done = r.votes.filter((v) => !v.skipped);
  return {
    transient: isTransient(r.classifierError), ms: Date.now() - t0,
    rec: {
      mode, stage: r.stage, risk: r.risk, subject: r.subject, decided_by: r.decidedBy,
      keywords: r.keywords, patterns: r.patterns, idiom_exempted: r.idiomExempted,
      votes: done.map((v) => (v.ok ? `${v.risk}/${v.subject}` : `エラー: ${String(v.error).slice(0, 80)}`)),
      reasons: done.map((v) => v.reason ?? null), error: r.classifierError,
    },
  };
}

async function judge(item, mode) {
  let res = await withRateLimitRetry(KEY_POOL, () => judgeOnce(item, mode), (r) => r.transient, { state: ROTATION, label: "判定: " });
  for (let round = 1; res.transient && round <= PATIENCE; round++) {
    const waitMs = Math.min(60000 * round, 300000);
    console.error(`    すべてのキーで上限・混雑。${waitMs / 1000}秒待って試し直します(${round}/${PATIENCE})`);
    await sleep(waitMs);
    res = await withRateLimitRetry(KEY_POOL, () => judgeOnce(item, mode), (r) => r.transient, { state: ROTATION, label: "判定: " });
  }
  return res;
}

// ---- 実行(再開対応) ----
mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Map();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    done.set(`${r.item_id}|${r.mode}|${r.rep}`, r);
  }
}
const plan = [];
for (const item of items) {
  for (let rep = 1; rep <= REPS; rep++) plan.push({ item, mode: "followup", rep });
  if (COMPARE_NORMAL) plan.push({ item, mode: "normal", rep: 1 });
}
console.log(`見守り中・危機のあとの判定の開発用の文: ${items.length}件 × ${REPS}回${COMPARE_NORMAL ? "(+ 比べるための通常の判定 1回ずつ)" : ""}`);
console.log(`記録: ${path.relative(ROOT, OUT)}(済み ${done.size}件) / 分類モデル: ${PRIMARY_MODEL}(1判定 = 分類器2回)\n`);

let stopped = null;
let paused = null;
for (const { item, mode, rep } of plan) {
  if (done.has(`${item.id}|${mode}|${rep}`)) continue;
  const res = await judge(item, mode);
  if (res.transient) {
    paused = `無料枠の上限または混雑のため中断(「${item.text.slice(0, 20)}」: ${String(res.rec.error).slice(0, 160)})`;
    break;
  }
  const rec = {
    set: "followup-dev", item_id: item.id, category: item.category, expected: item.expected,
    text: item.text, context_id: item.context_id, context: item.context, rep, ms: res.ms, ...res.rec,
  };
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
  done.set(`${item.id}|${mode}|${rep}`, rec);
  const ok = item.expected === "crisis" ? rec.stage === 2 : item.expected === "watch" ? rec.stage >= 1 : rec.stage === 0;
  console.log(`[${done.size}/${plan.length}] ${ok ? "○" : "×"} ${mode === "normal" ? "(通常の判定) " : ""}期待=${item.expected} 段階${rec.stage} 票=${JSON.stringify(rec.votes)} [${item.context_id}]「${item.text.slice(0, 24)}」`);
  // 止める条件は、見守り中・危機のあとの判定だけに当てる(比べるための通常の判定は変えていないので対象外)
  if (mode === "followup" && MUST_BE_CRISIS.has(item.category) && rec.stage !== 2) {
    stopped = `危機でなければならない文が段階${rec.stage}になった: 「${item.text}」(区分=${item.category}、文脈=${item.context_id}、${rep}回目。票=${JSON.stringify(rec.votes)}、理由=${JSON.stringify(rec.reasons)})`;
    console.log(`\n★★★ 停止: ${stopped}`);
    break;
  }
  await sleep(600);
}

// ---- 集計 ----
const recs = [...done.values()];
const CATS = [
  ["explicit", "明示的な表現(危機)"], ["passive", "受動的な希死念慮(危機)"], ["restate", "念押し・言い直し(危機)"],
  ["watch", "気がかり(watch 相当)"], ["ordinary", "ふつうの返事"], ["hyperbole", "日常の誇張"],
];
const byMode = (mode) => recs.filter((r) => r.mode === mode);
const stageCount = (rs) => [0, 1, 2].map((s) => rs.filter((r) => r.stage === s).length);
const lines = [];
const L = (s = "") => lines.push(s);
L("========================================");
L("見守り中・危機のあと用の分類器の検証(危機検知の作り直し 第2段階・開発用の文)");
L("========================================");
L(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)  記録: ${path.relative(ROOT, OUT)}`);
L(`判定: 各${REPS}回(見守り中・危機のあとの判定)${COMPARE_NORMAL ? "。比べるために通常の判定にも1回ずつ" : ""}。済み ${recs.length}/${plan.length}判定`);
L(`条件: 分類モデルは ${PRIMARY_MODEL} のみ、1回あたりの待ち時間の上限 ${process.env.CRISIS_CLASSIFIER_TIMEOUT_MS}ms(本番は15000ms)`);
if (stopped) L(`\n★ 停止: ${stopped}`);
if (paused) L(`\n★ ${paused}\n  再開: node scripts/test-crisis-followup.mjs --out=${path.relative(ROOT, OUT)}${COMPARE_NORMAL ? " --compare-normal" : ""}`);
L("");
L("【区分ごとの段階(段階0 / 段階1 / 段階2 の回数)】");
const perCategory = {};
for (const [cat, label] of CATS) {
  const f = byMode("followup").filter((r) => r.category === cat);
  if (!f.length) continue;
  const n = byMode("normal").filter((r) => r.category === cat);
  const [f0, f1, f2] = stageCount(f);
  const [n0, n1, n2] = stageCount(n);
  perCategory[cat] = { followup: { n: f.length, stages: [f0, f1, f2] }, normal: n.length ? { n: n.length, stages: [n0, n1, n2] } : null };
  L(`  ${label.padEnd(16)} 見守り中・危機のあとの判定: ${f0} / ${f1} / ${f2}(${f.length}判定)` +
    (n.length ? `   通常の判定(比較): ${n0} / ${n1} / ${n2}(${n.length}判定)` : ""));
}
const missCrisis = byMode("followup").filter((r) => MUST_BE_CRISIS.has(r.category) && r.stage !== 2);
const ordinaryCrisis = byMode("followup").filter((r) => r.category === "ordinary" && r.stage === 2);
const ordinaryWatch = byMode("followup").filter((r) => r.category === "ordinary" && r.stage === 1);
const hyperCrisis = byMode("followup").filter((r) => r.category === "hyperbole" && r.stage === 2);
const watchMiss = byMode("followup").filter((r) => r.category === "watch" && r.stage === 0);
L("");
L("【結果】");
L(`  危機でなければならない文の見逃し(段階2にならなかった): ${missCrisis.length}回 → ${missCrisis.length === 0 ? "0回(条件を満たす)" : "条件を満たさない"}`);
L(`  ふつうの返事を段階2にした: ${ordinaryCrisis.length}回 / 段階1にした: ${ordinaryWatch.length}回`);
if (perCategory.hyperbole) L(`  日常の誇張を段階2にした: ${hyperCrisis.length}回`);
L(`  気がかりの文を段階0にした(watch の見逃し): ${watchMiss.length}回`);
L("");
L("【文ごと(見守り中・危機のあとの判定の段階の並び。通常の判定があれば後ろに)】");
for (const it of items) {
  const f = byMode("followup").filter((r) => r.item_id === it.id).sort((a, b) => a.rep - b.rep);
  const n = byMode("normal").filter((r) => r.item_id === it.id);
  if (!f.length && !n.length) continue;
  L(`  ${it.id.padEnd(4)} [${it.category}/${it.context_id}] 段階=${JSON.stringify(f.map((r) => r.stage))}${n.length ? ` 通常=${JSON.stringify(n.map((r) => r.stage))}` : ""}  「${it.text}」`);
}
const summary = {
  set: path.relative(ROOT, SET_PATH), out: path.relative(ROOT, OUT), reps: REPS, compare_normal: COMPARE_NORMAL,
  judgments_done: recs.length, judgments_planned: plan.length, model: PRIMARY_MODEL,
  timeout_ms: Number(process.env.CRISIS_CLASSIFIER_TIMEOUT_MS),
  crisis_misses: missCrisis.length, ordinary_crisis: ordinaryCrisis.length, ordinary_watch: ordinaryWatch.length,
  hyperbole_crisis: perCategory.hyperbole ? hyperCrisis.length : null, watch_misses: watchMiss.length,
  per_category: perCategory, stopped, paused,
};
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, lines.join("\n") + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify(summary, null, 2));
console.log("\n" + lines.join("\n"));

// エクセルに書き出す(python3 と openpyxl が必要)
if (!paused) {
  const x = spawnSync("python3", [path.join(__dirname, "export-crisis-followup-xlsx.py"), OUT], { encoding: "utf8" });
  console.log(x.status === 0 ? x.stdout.trim() : `エクセルの書き出しに失敗しました: ${x.stderr || x.error}`);
}
process.exit(stopped ? 2 : paused ? 3 : 0);
