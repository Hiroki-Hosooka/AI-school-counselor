// ============================================================================
//  引き下がりの判定(危機検知の作り直し 第2段階・仮。2026年10月5日)の検証
//
//  以前の打ち消しの判定(scripts/test-crisis-retraction.mjs。2回とも打ち消しなら段階1に下げて残りの文面を止める)を
//  置き換えた。引き下がりは問いを止める理由にはなるが、窓口を伝えない理由にはならない(段階は下げない。CLAUDE.md 5.16)。
//
//  実行:
//   node scripts/test-crisis-withdrawal.mjs
//      開発用の文(docs/test-sets/crisis-withdrawal-dev.json)を、文脈ごとの状態(1通目・2通目・3通目のあと、
//      まとめの1通のあと)で、判定の流れ全体(assessSafetyTurn = 分類器 + 引き下がりの判定 + 先生についての答え +
//      planSafetyTurn)に通す
//   node scripts/test-crisis-withdrawal.mjs --holdout
//      保留セット v2 の打ち消し(カテゴリ N4)と念押し(P3)を、1通目のあとの状態で通す(第2段階の最終判定用。
//      人が求めるまで使わない)
//   --reps=3(1文あたりの判定回数)、--out=<記録.jsonl>(同じファイルを渡すと続きから)
//   --dry-run   API を使わず、ラベルを判定の代わりにして、状態の流れ・集計・エクセルの書き出しだけを確かめる
//               (新しいサイン = 分類器の危機判定、諦め = watch、それ以外 = 段階0。返事の種類 = ラベル)
//
//  止める条件: 新しいサイン(new_sign)の文が段階2にならなかったら、その時点で止めて報告する(明示的な表現の見逃し)。
//  確かめること:
//   ・引き下がりの文が、まとめの1通(1通目のあと)・短いまとめの1通(2・3通目のあと)・終わりを受け入れる1通
//     (まとめの1通のあと)に進むか
//   ・諦め・念押し・ふつうの返事を、引き下がりとして扱わないか(とくに「もういい、どうせ」のような諦め)
//   ・諦めの文が、分類器で新しいサイン(段階2)として拾われるか。拾われないときも、次の文面へ進むか
//   ・新しいサインは、引き下がりより優先して次の文面へ進み、通知するか
//  無料枠のキー(TEST_GEMINI_API_KEY(S))を使う(予算の¥1000枠とは別)。分類モデルは主力モデル
//  (LITE_MODELS の先頭)だけにする(scripts/test-crisis-staged.mjs と同じ理由)。
//  結果は記録(.jsonl)・集計(-summary.txt / .json)・エクセル(.xlsx。scripts/export-crisis-withdrawal-xlsx.py)に書き出す。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep } from "./_lib/test-env.mjs";
import { LITE_MODELS } from "../src/classify.mjs";
import {
  assessSafetyTurn, planSafetyTurn, normalizeSafetyState, needsWithdrawalJudge,
  CRISIS_STEP1_PROVISIONAL, CRISIS_STEP2_PROVISIONAL, CRISIS_STEP3_PROVISIONAL, CRISIS_WRAPUP_PROVISIONAL,
} from "../src/crisis-response.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const HOLDOUT = process.argv.includes("--holdout");
const DRY = process.argv.includes("--dry-run");
const KEY_POOL = DRY ? null : requireTestGeminiKeyPool(ROOT);
const ROTATION = createKeyRotationState();
const REPS = Number(arg("reps", DRY ? 1 : 3));
const PATIENCE = Number(arg("patience", 6));
const SET_PATH = path.resolve(ROOT, HOLDOUT ? "docs/test-sets/crisis-detection-holdout-v2.json" : arg("set", "docs/test-sets/crisis-withdrawal-dev.json"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(ROOT, arg("out", DRY
  ? path.join(os.tmpdir(), `crisis-withdrawal-dry-run-${stamp}.jsonl`)
  : `docs/test-results/crisis-withdrawal-${HOLDOUT ? "holdout-v2" : "dev"}-${stamp}.jsonl`));

// 検証の条件(scripts/test-crisis-staged.mjs と同じ): 主力モデルだけ・1回あたりの待ち時間の上限を長く
const PRIMARY_MODEL = LITE_MODELS[0];
LITE_MODELS.splice(1);
process.env.CRISIS_CLASSIFIER_TIMEOUT_MS = arg("timeout-ms", "120000");

// 文脈の AI の発言(fixed = 仮の文面の何通目か)は、今の文面に置き換える
const FIXED = { 1: CRISIS_STEP1_PROVISIONAL, 2: CRISIS_STEP2_PROVISIONAL, 3: CRISIS_STEP3_PROVISIONAL, 7: CRISIS_WRAPUP_PROVISIONAL };
const LABEL_JA = { withdrawal: "引き下がり", resignation: "諦め", reaffirm: "念押し", other: "ふつうの返事", new_sign: "新しいサイン" };
const STEP_JA = { 5: "2回目以降の短い1通", 6: "再受け止め", 7: "まとめの1通", 8: "短いまとめの1通", 9: "終わりを受け入れる1通" };
const stepJa = (n) => (n == null ? "生成" : STEP_JA[n] ?? `${n}通目`);

// ---- 判定する文 ----
const set = JSON.parse(readFileSync(SET_PATH, "utf8"));
const STEP1_STATE = { crisis_state: "step1", crisis_trigger: "direct" };
const items = HOLDOUT
  ? set.items.filter((it) => it.category === "N4" || it.category === "P3").map((it, i) => ({
    id: `H${i + 1}`, text: it.text, context: it.context ?? [], contextId: "1通目のあと", category: it.category,
    label: it.category === "N4" ? "withdrawal" : "reaffirm", note: null, state: STEP1_STATE,
  }))
  : set.items.map((it, i) => {
    const ctx = set.contexts[it.context];
    if (!ctx) throw new Error(`文脈 ${it.context} が見つからない(${it.text})`);
    return {
      id: `W${i + 1}`, text: it.text, contextId: it.context, category: it.context, label: it.label, note: it.note ?? null,
      context: ctx.messages.map((m) => (m.role === "ai" ? { role: "ai", text: FIXED[m.fixed] } : { role: "user", text: m.text })),
      state: { crisis_trigger: "direct", ...ctx.state },
    };
  });

// 期待する扱い(固定の文面の何通目か。null = 生成)。引き下がり → 1通目のあとはまとめの1通、2・3通目のあとは短いまとめの1通、
// まとめのあとは終わりを受け入れる1通。それ以外は今どおり次の文面(まとめのあとは生成。新しいサインなら止めていた続き)
function expectedStep(item) {
  const st = item.state.crisis_state;
  const wrap = st.startsWith("wrap");
  const n = Number(st.replace(/\D/g, ""));
  if (item.label === "withdrawal") return wrap ? 9 : n === 1 ? 7 : 8;
  if (item.label === "new_sign") return n + 1;
  return wrap ? null : n + 1;
}

const isTransient = (t) => !!t && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(t);

// 試し実行(--dry-run)の判定の代わり。分類器・引き下がりの判定はラベルから作る
function dryAssess(item) {
  const stage = item.label === "new_sign" ? 2 : item.label === "resignation" ? 1 : 0;
  const decidedBy = ["followup", ...(stage === 2 ? ["classifier"] : stage === 1 ? ["classifier_watch"] : [])];
  const staged = {
    stage, subject: "self", decidedBy, keywords: [], patterns: [], idiomExempted: [], classifierMode: "followup",
    votes: [{ ok: true, risk: ["none", "watch", "crisis"][stage], subject: "self", reason: "(試し実行)" }], classifierError: null,
  };
  const state = normalizeSafetyState(item.state);
  const type = item.label === "new_sign" ? "withdrawal" : item.label;
  const withdrawal = needsWithdrawalJudge(state) ? { type, withdrawal: type === "withdrawal", vote: { ok: true, reason: "(試し実行)" }, error: null } : null;
  const teacher = state.crisis_state === "step3" ? { answer: "unclear", error: null } : null;
  const plan = planSafetyTurn({ staged, state, withdrawal: withdrawal?.type ?? null, teacherAnswer: teacher?.answer ?? null });
  return { staged, withdrawal, teacher, plan };
}

async function judgeOnce(item) {
  const t0 = Date.now();
  const a = DRY ? dryAssess(item) : await assessSafetyTurn(item.text, item.context, item.state);
  const errs = [a.staged.classifierError, a.withdrawal?.error, a.teacher?.error].filter(Boolean).join(" | ") || null;
  const p = a.plan;
  const expected = expectedStep(item);
  const withdrawalRoute = [7, 8, 9].includes(p.crisisStep) || p.decidedBy.includes("withdrawal_repeat");
  return {
    transient: isTransient(errs), ms: Date.now() - t0,
    rec: {
      state_before: item.state.crisis_state,
      classifier_mode: a.staged.classifierMode, detection_stage: a.staged.stage, detection_decided_by: a.staged.decidedBy,
      votes: (a.staged.votes ?? []).filter((v) => !v.skipped).map((v) => (v.ok ? `${v.risk}/${v.subject}` : "エラー")),
      reasons: (a.staged.votes ?? []).filter((v) => !v.skipped).map((v) => v.reason ?? null),
      keywords: a.staged.keywords ?? [], patterns: a.staged.patterns ?? [],
      reply_type: a.withdrawal ? (a.withdrawal.type ?? "エラー") : null,
      reply_reason: a.withdrawal?.vote?.reason ?? null,
      teacher_answer: a.teacher ? a.teacher.answer : null,
      plan_stage: p.stage, plan_decided_by: p.decidedBy, action: p.action, crisis_step: p.crisisStep, card: p.card,
      notify: p.notify, next_state: p.nextState.crisis_state, withdrawal_route: withdrawalRoute,
      expected_step: expected,
      ok: p.crisisStep === expected && (item.label !== "new_sign" || (p.notify && a.staged.stage === 2)),
      error: errs,
    },
  };
}

async function judge(item) {
  if (DRY) return judgeOnce(item);
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
console.log(`${HOLDOUT ? "保留セット v2(N4・P3)" : "開発用の文"}${DRY ? "(試し実行・API を使わない)" : ""}: ${items.length}件 × ${REPS}回 / 記録: ${path.relative(ROOT, OUT)}(済み ${done.size}件)`);
console.log(`分類モデル: ${DRY ? "(使わない)" : PRIMARY_MODEL} / 判定の流れ全体(分類器 + 引き下がりの判定 + 先生についての答え + planSafetyTurn)\n`);

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
      set: HOLDOUT ? "holdout-v2" : DRY ? "dev(試し実行)" : "dev", item_id: item.id, context_id: item.contextId,
      category: item.category, label: item.label, text: item.text, context: item.context, note: item.note, rep, ms: res.ms, ...res.rec,
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    done.set(`${item.id}|${rep}`, rec);
    console.log(`[${done.size}/${items.length * REPS}] ${rec.ok ? "○" : "×"} ${LABEL_JA[item.label]}(${item.contextId}) → `
      + `返事の種類=${rec.reply_type ? LABEL_JA[rec.reply_type] ?? rec.reply_type : "判定なし"} 分類器の段階${rec.detection_stage} `
      + `→ ${stepJa(rec.crisis_step)}(期待: ${stepJa(rec.expected_step)})${rec.notify ? " 通知" : ""} 「${item.text.slice(0, 24)}」`);
    if (item.label === "new_sign" && rec.detection_stage !== 2) {
      stopped = `新しいサインの文が段階2にならなかった(明示的な表現の見逃し): 「${item.text}」(${rep}回目。分類器の判定=${JSON.stringify(rec.votes)}、`
        + `理由=${JSON.stringify(rec.reasons)})`;
      console.log(`\n★★★ 停止: ${stopped}`);
      break outer;
    }
    if (!DRY) await sleep(800);
  }
}

// ---- 集計 ----
const recs = [...done.values()];
const by = (f) => recs.filter(f);
const rate = (n, d) => (d ? `${n}/${d}` : "—");
const count = (rs, f) => rs.filter(f).length;
const labelsOrder = ["withdrawal", "resignation", "reaffirm", "other", "new_sign"];
const typesOrder = ["withdrawal", "resignation", "reaffirm", "other", "エラー", null];
const W = by((r) => r.label === "withdrawal");
const notW = by((r) => ["resignation", "reaffirm", "other"].includes(r.label));
const R = by((r) => r.label === "resignation");
const N = by((r) => r.label === "new_sign");
const confusion = Object.fromEntries(labelsOrder.map((l) => [l, Object.fromEntries(typesOrder.map((t) => [
  t ?? "判定なし", count(recs, (r) => r.label === l && (r.reply_type ?? null) === t)]))]));
const perItem = items.map((it) => {
  const rs = by((r) => r.item_id === it.id).sort((a, b) => a.rep - b.rep);
  return {
    id: it.id, text: it.text, context_id: it.contextId, label: it.label, n: rs.length,
    ok: count(rs, (r) => r.ok), withdrawal_route: count(rs, (r) => r.withdrawal_route),
    reply_types: rs.map((r) => r.reply_type), detection_stages: rs.map((r) => r.detection_stage),
    steps: rs.map((r) => r.crisis_step), expected_step: expectedStep(it), notify: rs.map((r) => r.notify),
  };
});
const summaryNumbers = {
  withdrawal_routed: count(W, (r) => r.withdrawal_route), withdrawal_judgments: W.length,
  withdrawal_ok: count(W, (r) => r.ok),
  non_withdrawal_routed_as_withdrawal: count(notW, (r) => r.withdrawal_route), non_withdrawal_judgments: notW.length,
  resignation_routed_as_withdrawal: count(R, (r) => r.withdrawal_route), resignation_judgments: R.length,
  resignation_stage: [0, 1, 2].map((s) => count(R, (r) => r.detection_stage === s)),
  resignation_type_resignation: count(R, (r) => r.reply_type === "resignation"),
  new_sign_stage2: count(N, (r) => r.detection_stage === 2), new_sign_notified: count(N, (r) => r.notify),
  new_sign_continued: count(N, (r) => r.ok), new_sign_judgments: N.length,
  all_ok: count(recs, (r) => r.ok), judgments: recs.length,
};
const lines = [];
const L = (s = "") => lines.push(s);
L("========================================");
L(`引き下がりの判定の検証(危機検知の作り直し 第2段階・仮)${HOLDOUT ? " 最終判定(保留セット v2)" : " 開発用の文"}${DRY ? "【試し実行・API を使わない】" : ""}`);
L("========================================");
L(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)  記録: ${path.relative(ROOT, OUT)}`);
L(`判定: 各${REPS}回。文脈ごとの状態で、判定の流れ全体に通した(引き下がりの判定は1回)。済み ${recs.length}/${items.length * REPS}判定`);
L(DRY
  ? "条件: 試し実行。分類器・引き下がりの判定の代わりにラベルを使った(状態の流れ・集計・エクセルの書き出しだけの確認。判定の精度は測っていない)"
  : `条件: 分類モデルは ${PRIMARY_MODEL} のみ、1回あたりの待ち時間の上限 ${process.env.CRISIS_CLASSIFIER_TIMEOUT_MS}ms(本番は15000ms)`);
if (stopped) L(`\n★ 停止: ${stopped}`);
if (paused) L(`\n★ ${paused}\n  再開: node scripts/test-crisis-withdrawal.mjs${HOLDOUT ? " --holdout" : ""} --out=${path.relative(ROOT, OUT)}`);
L("");
L("【結果】");
L(`  引き下がりの文が、まとめの1通・短いまとめ・終わりを受け入れる1通に進んだ: ${rate(summaryNumbers.withdrawal_routed, W.length)}`
  + `(期待どおりの文面: ${rate(summaryNumbers.withdrawal_ok, W.length)}。進まなかった回は今どおり次の文面。問いが1つ多くなる側の取りこぼし)`);
L(`  諦め・念押し・ふつうの返事を、引き下がりとして扱った: ${rate(summaryNumbers.non_withdrawal_routed_as_withdrawal, notW.length)}`
  + `(扱うと、そこで問いをやめる。窓口は出る)`);
L(`  うち諦め(「もういい、どうせ」など)を引き下がりとして扱った: ${rate(summaryNumbers.resignation_routed_as_withdrawal, R.length)}`);
L(`  諦めの文の分類器の段階(段階0 / 1 / 2): ${summaryNumbers.resignation_stage.join(" / ")}(段階2 = 新しいサインとして拾われ、通知する)`);
L(`  諦めの文を、返事の種類として「諦め」と判定した: ${rate(summaryNumbers.resignation_type_resignation, R.length)}`);
L(`  新しいサインの文: 段階2 ${rate(summaryNumbers.new_sign_stage2, N.length)} / 通知 ${rate(summaryNumbers.new_sign_notified, N.length)}`
  + ` / 引き下がりより優先して次の文面へ ${rate(summaryNumbers.new_sign_continued, N.length)}`);
L(`  期待どおりの扱い(全体): ${rate(summaryNumbers.all_ok, recs.length)}`);
L("");
L("【返事の種類の判定(行 = ラベル、列 = 判定)】");
L(`  ${"".padEnd(8, "　")}${typesOrder.map((t) => (t ? LABEL_JA[t] ?? t : "判定なし")).join(" / ")}`);
for (const l of labelsOrder) L(`  ${LABEL_JA[l].padEnd(8, "　")}${typesOrder.map((t) => confusion[l][t ?? "判定なし"]).join(" / ")}`);
L("");
L("【文ごと(期待どおりの回数 / 判定回数。返事の種類・分類器の段階・出した文面は回の順)】");
for (const p of perItem) {
  L(`  ${p.id.padEnd(4)} ${LABEL_JA[p.label]}(${p.context_id}) ${rate(p.ok, p.n)}  種類=${JSON.stringify(p.reply_types.map((t) => (t ? LABEL_JA[t] ?? t : "判定なし")))}`
    + ` 段階=${JSON.stringify(p.detection_stages)} 文面=${JSON.stringify(p.steps.map(stepJa))}(期待: ${stepJa(p.expected_step)})  「${p.text}」`);
}
const summary = {
  set: path.relative(ROOT, SET_PATH), out: path.relative(ROOT, OUT), holdout: HOLDOUT, dry_run: DRY, reps: REPS,
  judgments_done: recs.length, judgments_planned: items.length * REPS, model: DRY ? null : PRIMARY_MODEL,
  timeout_ms: Number(process.env.CRISIS_CLASSIFIER_TIMEOUT_MS), ...summaryNumbers, confusion,
  stopped, paused, per_item: perItem,
};
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, lines.join("\n") + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify(summary, null, 2));
console.log("\n" + lines.join("\n"));

// エクセルに書き出す(python3 と openpyxl が必要)
if (!paused) {
  const x = spawnSync("python3", [path.join(__dirname, "export-crisis-withdrawal-xlsx.py"), OUT], { encoding: "utf8" });
  console.log(x.status === 0 ? x.stdout.trim() : `エクセルの書き出しに失敗しました: ${x.stderr || x.error}`);
}
process.exit(stopped ? 2 : paused ? 3 : 0);
