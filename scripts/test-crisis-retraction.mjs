// ============================================================================
//  打ち消しの判定(危機検知の作り直し 第2段階・仮)の検証
//
//  実行:
//   node scripts/test-crisis-retraction.mjs
//      開発用の文(docs/test-sets/crisis-retraction-dev.json)で、打ち消しの判定
//      (src/crisis-response.mjs の judgeRetraction。2回並行、2回とも打ち消しなら打ち消し)だけを確かめる
//   node scripts/test-crisis-retraction.mjs --holdout
//      保留セット v2(docs/test-sets/crisis-detection-holdout-v2.json)の打ち消し(カテゴリ N4)と
//      念押し(カテゴリ P3)を、危機の応答の1通目を出したあとの状態で、判定の流れ全体
//      (assessSafetyTurn = 分類器 v2 + 打ち消しの判定 + planSafetyTurn)に通す。第2段階の最終判定用
//   --reps=3(1文あたりの判定回数)、--out=<記録.jsonl>(同じファイルを渡すと続きから)
//
//  止める条件: 打ち消しではない文(not_retraction / P3)を打ち消しとして段階を下げたら、
//  その時点で止めて報告する(深刻な状態にある人への対応を弱めてしまうため)。
//  無料枠のキー(TEST_GEMINI_API_KEY(S))を使う(予算の¥1000枠とは別)。分類モデルは主力モデル
//  (LITE_MODELS の先頭)だけにする(scripts/test-crisis-staged.mjs と同じ理由)。
//  結果は記録(.jsonl)・集計(-summary.txt / .json)・エクセル(.xlsx。scripts/export-crisis-retraction-xlsx.py)に書き出す。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep } from "./_lib/test-env.mjs";
import { LITE_MODELS } from "../src/classify.mjs";
import { judgeRetraction, assessSafetyTurn } from "../src/crisis-response.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const ROTATION = createKeyRotationState();

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const HOLDOUT = process.argv.includes("--holdout");
const REPS = Number(arg("reps", 3));
const PATIENCE = Number(arg("patience", 6));
const SET_PATH = path.resolve(ROOT, HOLDOUT ? "docs/test-sets/crisis-detection-holdout-v2.json" : arg("set", "docs/test-sets/crisis-retraction-dev.json"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/crisis-retraction-${HOLDOUT ? "holdout-v2" : "dev"}-${stamp}.jsonl`));

// 検証の条件(scripts/test-crisis-staged.mjs と同じ): 主力モデルだけ・1回あたりの待ち時間の上限を長く
const PRIMARY_MODEL = LITE_MODELS[0];
LITE_MODELS.splice(1);
process.env.CRISIS_CLASSIFIER_TIMEOUT_MS = arg("timeout-ms", "120000");

// ---- 判定する文 ----
// 開発用: { id, text, context, expected: retraction | not_retraction, category }
// 保留セット: N4 = 打ち消し(retraction)、P3 = 念押し(not_retraction)。どちらも項目の文脈をそのまま使う
const set = JSON.parse(readFileSync(SET_PATH, "utf8"));
const items = HOLDOUT
  ? set.items.filter((it) => it.category === "N4" || it.category === "P3").map((it, i) => ({
    id: `H${i + 1}`, text: it.text, context: it.context ?? [], category: it.category,
    expected: it.category === "N4" ? "retraction" : "not_retraction",
  }))
  : set.items.map((it, i) => ({
    id: `D${i + 1}`, text: it.text, context: set.contexts[it.context] ?? [], category: it.context,
    expected: it.label, note: it.note ?? null,
  }));
// 危機の応答の1通目を出して返事を待っている状態(直接のきっかけ)
const STEP1_STATE = { watch_turns_left: 0, crisis_state: "step1", crisis_trigger: "direct", care_shown: false, closing_state: "none" };

const isTransient = (t) => !!t && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(t);

async function judgeOnce(item) {
  const t0 = Date.now();
  if (!HOLDOUT) {
    const r = await judgeRetraction(item.text, item.context);
    return {
      transient: isTransient(r.error), ms: Date.now() - t0,
      rec: {
        retraction_applied: r.retraction, votes: r.votes.map((v) => (v.ok ? v.retraction : `エラー: ${String(v.error).slice(0, 80)}`)),
        reasons: r.votes.map((v) => v.reason ?? null), error: r.error,
      },
    };
  }
  const a = await assessSafetyTurn(item.text, item.context, STEP1_STATE);
  const errs = [a.staged.classifierError, a.retraction?.error].filter(Boolean).join(" | ") || null;
  return {
    transient: isTransient(errs), ms: Date.now() - t0,
    rec: {
      retraction_applied: a.plan.decidedBy.includes("retraction"),
      votes: (a.retraction?.votes ?? []).map((v) => (v.ok ? v.retraction : `エラー: ${String(v.error).slice(0, 80)}`)),
      reasons: (a.retraction?.votes ?? []).map((v) => v.reason ?? null),
      plan_stage: a.plan.stage, plan_decided_by: a.plan.decidedBy, crisis_step: a.plan.crisisStep,
      next_crisis_state: a.plan.nextState.crisis_state,
      detection_stage: a.staged.stage, detection_decided_by: a.staged.decidedBy, keywords: a.staged.keywords,
      error: errs,
    },
  };
}

async function judge(item) {
  let res = await withRateLimitRetry(KEY_POOL, () => judgeOnce(item), (r) => r.transient, { state: ROTATION, label: "判定: " });
  for (let round = 1; res.transient && round <= PATIENCE; round++) {
    const waitMs = Math.min(60000 * round, 300000);
    console.error(`    すべてのキーで上限・混雑。${waitMs / 1000}秒待って試し直します(${round}/${PATIENCE})`);
    await sleep(waitMs);
    res = await withRateLimitRetry(KEY_POOL, () => judgeOnce(item), (r) => r.transient, { state: ROTATION, label: "判定: " });
  }
  return res;
}

// ---- 実行(再開対応) ----
mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Map();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    done.set(`${r.item_id}|${r.rep}`, r);
  }
}
console.log(`${HOLDOUT ? "保留セット v2(N4・P3)の最終判定" : "開発用の文"}: ${items.length}件 × ${REPS}回 / 記録: ${path.relative(ROOT, OUT)}(済み ${done.size}件)`);
console.log(`分類モデル: ${PRIMARY_MODEL} / ${HOLDOUT ? "判定の流れ全体(1判定 = 分類器2回 + 打ち消し2回)" : "打ち消しの判定だけ(1判定 = 2回)"}\n`);

let stopped = null;
let paused = null;
outer:
for (const item of items) {
  for (let rep = 1; rep <= REPS; rep++) {
    if (done.has(`${item.id}|${rep}`)) continue;
    const res = await judge(item);
    if (res.transient) {
      paused = `無料枠の上限または混雑のため中断(「${item.text.slice(0, 20)}」: ${String(res.rec.error).slice(0, 160)})`;
      break outer;
    }
    const rec = {
      set: HOLDOUT ? "holdout-v2" : "dev", item_id: item.id, category: item.category, expected: item.expected,
      text: item.text, context: item.context, note: item.note ?? null, rep, ms: res.ms, ...res.rec,
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    done.set(`${item.id}|${rep}`, rec);
    const mark = rec.retraction_applied ? "打ち消し" : "打ち消しでない";
    const ok = (rec.expected === "retraction") === rec.retraction_applied;
    console.log(`[${done.size}/${items.length * REPS}] ${ok ? "○" : "×"} 期待=${item.expected} 判定=${mark} 票=${JSON.stringify(rec.votes)}${HOLDOUT ? ` 段階${rec.plan_stage}` : ""} 「${item.text.slice(0, 24)}」`);
    if (item.expected === "not_retraction" && rec.retraction_applied) {
      stopped = `打ち消しではない文を打ち消しとして段階を下げた: 「${item.text}」(${rep}回目。票=${JSON.stringify(rec.votes)}、理由=${JSON.stringify(rec.reasons)})`;
      console.log(`\n★★★ 停止: ${stopped}`);
      break outer;
    }
    await sleep(800);
  }
}

// ---- 集計 ----
const recs = [...done.values()];
const by = (f) => recs.filter(f);
const rate = (n, d) => (d ? `${n}/${d}` : "—");
const perItem = items.map((it) => {
  const rs = by((r) => r.item_id === it.id);
  return {
    id: it.id, text: it.text, category: it.category, expected: it.expected, n: rs.length,
    applied: rs.filter((r) => r.retraction_applied).length,
    stages: HOLDOUT ? rs.map((r) => r.plan_stage) : null,
  };
});
const retr = by((r) => r.expected === "retraction");
const notRetr = by((r) => r.expected === "not_retraction");
const falseRetraction = notRetr.filter((r) => r.retraction_applied).length;
const recall = retr.filter((r) => r.retraction_applied).length;
const stage0 = HOLDOUT ? recs.filter((r) => r.plan_stage === 0).length : null;
const lines = [];
const L = (s = "") => lines.push(s);
L("========================================");
L(`打ち消しの判定の検証(危機検知の作り直し 第2段階・仮)${HOLDOUT ? " 最終判定(保留セット v2)" : " 開発用の文"}`);
L("========================================");
L(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)  記録: ${path.relative(ROOT, OUT)}`);
L(`判定: 各${REPS}回。${HOLDOUT ? "危機の応答の1通目を出したあとの状態で、判定の流れ全体に通した" : "打ち消しの判定(2回並行・2回とも打ち消しなら打ち消し)だけ"}。済み ${recs.length}/${items.length * REPS}判定`);
L(`条件: 分類モデルは ${PRIMARY_MODEL} のみ、1回あたりの待ち時間の上限 ${process.env.CRISIS_CLASSIFIER_TIMEOUT_MS}ms(本番は15000ms)`);
if (stopped) L(`\n★ 停止: ${stopped}`);
if (paused) L(`\n★ ${paused}\n  再開: node scripts/test-crisis-retraction.mjs${HOLDOUT ? " --holdout" : ""} --out=${path.relative(ROOT, OUT)}`);
L("");
L("【結果】");
L(`  打ち消しではない文を、打ち消しとして段階を下げた回数: ${rate(falseRetraction, notRetr.length)}  → ${falseRetraction === 0 ? "0回(条件を満たす)" : "条件を満たさない"}`);
L(`  打ち消しの文を、打ち消しとして扱えた回数: ${rate(recall, retr.length)}(扱えなかった回は、危機の応答の2通目に進む。安全側の取りこぼし)`);
if (HOLDOUT) L(`  段階0になった判定: ${stage0}回(設計上、打ち消しでも段階1より下げない)`);
L("");
L("【文ごと(打ち消しとして扱った回数 / 判定回数)】");
for (const p of perItem) {
  L(`  ${p.expected === "retraction" ? "打ち消し  " : "打ち消しでない"} ${rate(p.applied, p.n)}${HOLDOUT ? `  段階=${JSON.stringify(p.stages)}` : ""}  [${p.category}] 「${p.text}」`);
}
const summary = {
  set: path.relative(ROOT, SET_PATH), out: path.relative(ROOT, OUT), holdout: HOLDOUT, reps: REPS,
  judgments_done: recs.length, judgments_planned: items.length * REPS, model: PRIMARY_MODEL,
  timeout_ms: Number(process.env.CRISIS_CLASSIFIER_TIMEOUT_MS),
  false_retraction: falseRetraction, not_retraction_judgments: notRetr.length,
  retraction_recognized: recall, retraction_judgments: retr.length, stage0,
  stopped, paused, per_item: perItem,
};
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, lines.join("\n") + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify(summary, null, 2));
console.log("\n" + lines.join("\n"));

// エクセルに書き出す(python3 と openpyxl が必要)
if (!paused) {
  const x = spawnSync("python3", [path.join(__dirname, "export-crisis-retraction-xlsx.py"), OUT], { encoding: "utf8" });
  console.log(x.status === 0 ? x.stdout.trim() : `エクセルの書き出しに失敗しました: ${x.stderr || x.error}`);
}
process.exit(stopped ? 2 : paused ? 3 : 0);
