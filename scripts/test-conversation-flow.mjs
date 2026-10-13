// ============================================================================
//  会話の流れ・他人事感の修正の検証(無料枠・合成データだけ。2026年10月11日)
//
//  ・replay  : 相談ログ 16f362dd の生徒の発言(1〜12ターン)を固定の台本として流し、AI の返事を作り直す
//  ・persona : 新しいペルソナ P1(よく話すが、行き詰まっている子。docs/test-sets/personas.json)と話させる
//  修正前(--variant=before。--before-root に修正前のコミットを置いた作業ツリー)と修正後(--variant=after)を比べる。
//
//  実行例:
//    node scripts/test-conversation-flow.mjs --variant=after --mode=replay --reps=3 --knowledge=<seed の JSON> --out=<記録.jsonl>
//    node scripts/test-conversation-flow.mjs --variant=before --before-root=<作業ツリー> --mode=replay --reps=3 --knowledge=... --out=<同じ記録>
//    node scripts/test-conversation-flow.mjs --rate --out=<記録.jsonl>      (返事を軽いモデルで採点して、同じ記録に足す)
//    node scripts/test-conversation-flow.mjs --summary --out=<記録.jsonl>   (集計とエクセル。scripts/export-conversation-flow-xlsx.py)
//  同じ --out を渡すと、終わった回は飛ばして続きから。
//
//  ナレッジ: --knowledge に、DB の knowledge(active)を JSON の配列にしたものを渡す(DB の行と同じ列)。
//   省略すると Supabase(SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY)から読む。
//  流れは本番の既定と同じ(段階ごとの応答は無効・危機のあとの指示は有効)。修正前も修正後も同じ流れで比べる。
//  キーは無料枠の TEST_GEMINI_API_KEY(S) だけ(CLAUDE.md 5.10)。実際の生徒の会話は使わない(ログは開発メンバーが試したもの)。
// ============================================================================

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep, isTransientGenerateFailure,
} from "./_lib/test-env.mjs";
import { rateReply, rateConversation } from "./_lib/flow-rater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/conversation-flow-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const ROT_GEN = createKeyRotationState();
const ROT_CLS = createKeyRotationState();
const ROT_STU = createKeyRotationState();
const ROT_RATE = createKeyRotationState();
const PATIENCE = Number(arg("patience", 8));

// 指標(本文と記録から)は修正後の src/flow.mjs で、修正前・修正後とも同じものさしで数える
const F_METRICS = await import(pathToFileURL(path.join(ROOT, "src/flow.mjs")).href);

const readRecords = () => (existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- ログ 16f362dd の生徒の発言 ----
function logStudentTurns() {
  const md = readFileSync(path.join(ROOT, "docs/review-logs/2026-10-11-16f362dd.md"), "utf8");
  return [...md.matchAll(/^\| (\d+) \| 生徒 \| (.*?) \|/gm)].map((m) => ({ turn: +m[1], text: m[2].replace(/<br>/g, "\n") }));
}

async function patient(fn, isTransient, rot, label) {
  let r = await withRateLimitRetry(KEY_POOL, fn, isTransient, { state: rot, label });
  for (let round = 1; isTransient(r) && round <= PATIENCE; round++) {
    const waitMs = Math.min(60000 * round, 300000);
    console.error(`    すべてのキーで上限・混雑。${waitMs / 1000}秒待って試し直します(${round}/${PATIENCE})`);
    await sleep(waitMs);
    r = await withRateLimitRetry(KEY_POOL, fn, isTransient, { state: rot, label });
  }
  return r;
}

// ---- 1回分の会話 ----
async function runOne({ variant, mode, rep, root, knowledge }) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const G = await imp("src/generate.mjs");
  const C = await imp("src/classify.mjs");
  const R = await imp("src/crisis-response.mjs");
  const F = variant === "after" ? await imp("src/flow.mjs") : null;
  const rows = knowledge ?? await G.loadKnowledge();
  const personaSet = JSON.parse(readFileSync(path.join(ROOT, "docs/test-sets/personas.json"), "utf8"));
  const persona = personaSet.items.find((p) => p.id === arg("persona", "P1"));
  const script = mode === "replay" ? logStudentTurns() : null;
  const maxTurns = mode === "replay" ? script.length : persona.max_turns;

  let sess = {
    weight: "rapport", relation: "visitor", turns_since_summary: 0, notes: {}, phase: "intake",
    chief_complaint_category: null, onset_context: null, distress_level: null, physical_mental_symptoms: null,
    user_goal: null, ambivalence_detected: null, recommended_mode: [], closing_state: "none",
  };
  const hist = []; // messages と同じ形の行
  let pendingChoices = null;
  for (let turn = 1; turn <= maxTurns; turn++) {
    // 生徒の発言
    let text, choiceId = null;
    if (mode === "replay") {
      text = script[turn - 1].text;
    } else if (pendingChoices && persona.choices?.[pendingChoices.set]) {
      const c = pendingChoices.items.find((x) => x.id === persona.choices[pendingChoices.set]);
      text = c.label; choiceId = c.id;
    } else if (turn === 1) {
      text = persona.first_message;
    } else if ((persona.scripted_turns ?? []).some((s) => s.turn === turn)) {
      text = persona.scripted_turns.find((s) => s.turn === turn).text;
    } else {
      const sys = `${personaSet.common_student_instruction}\n\n【この生徒の設定】\n${persona.setup}\n\n【話し方の追加ルール】\n${persona.speech_notes}\n\n出力は次のJSON形式のみ。\n{"line": "生徒の発言本文"}`;
      const contents = hist.filter((h) => !h.crisis || h.role === "ai").map((h) => ({ role: h.role === "ai" ? "user" : "model", parts: [{ text: h.body }] }));
      const r = await patient(async () => {
        try {
          const res = await C.callGemini(C.LITE_MODELS, sys, contents, 800, -1);
          const line = String(C.parseJSON(res.text).line ?? "").trim();
          return line ? { ok: true, line } : { ok: false, transient: true };
        } catch (e) { return { ok: false, transient: !String(e).includes("[BLOCKED]"), error: String(e) }; }
      }, (x) => !x.ok && x.transient, ROT_STU, "生徒役: ");
      if (!r.ok) throw new Error(`生徒役の発言を作れませんでした: ${r.error ?? ""}`);
      text = r.line;
    }
    pendingChoices = null;
    const flowChoice = F ? F.flowChoiceOf(hist, choiceId) : null;
    hist.push({ role: "user", body: text, ...(flowChoice ? { choice_set: flowChoice.set, choice_id: flowChoice.id } : {}) });

    // 判定(本番の既定と同じ。固定応答のあとは「その発言そのもの」を見る判定)
    let safety;
    if (flowChoice) {
      safety = R.assessFlowChoiceTurn({}).staged;
    } else {
      const ctx = hist.slice(0, -1).slice(-C.CLASSIFIER_CONTEXT_MESSAGES).map((h) => ({ role: h.role === "ai" ? "ai" : "user", text: h.body }));
      const afterFixed = R.aftercareEnabled() && R.hadCrisisReply(hist);
      safety = await patient(() => C.classifyStaged(text, ctx, afterFixed ? { mode: "followup" } : undefined),
        (x) => !!x.classifierError && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(x.classifierError), ROT_CLS, "判定: ");
    }
    const rec = { variant, mode, rep, turn, student: text, choice: choiceId, stage: safety.stage, risk: safety.risk, decided_by: safety.decidedBy, classifier_reason: safety.model?.reason ?? null };

    if (safety.risk === "crisis" && safety.subject === "self") {
      const K = await imp("src/crisis-keywords-v3.mjs");
      const reply = R.buildCrisisReply(K.categoryOfSafety(safety));
      hist.push({ role: "ai", body: reply, crisis: true });
      appendFileSync(OUT, JSON.stringify({ ...rec, counselor: reply, crisis: true }) + "\n");
      console.log(`  [${variant}/${mode}#${rep} T${turn}] 危機の固定応答`);
      continue;
    }
    const afterCrisis = R.aftercareEnabled() && R.hadCrisisReply(hist);
    const safetyContext = R.defaultSafetyContexts({ risk: safety.risk, subject: safety.subject, afterCrisis });
    const turnStage = Math.max(safety.risk === "crisis" ? 2 : safety.risk === "watch" ? 1 : 0, afterCrisis ? 1 : 0);
    const flowPhase = G.flowPhaseFor(sess, safetyContext);
    const stats = F ? F.flowStats(hist, sess, { choiceId: flowChoice?.id ?? null, stage: turnStage, contexts: safetyContext }) : null;
    const summaryKnowledge = F && flowPhase === "phase2" && !stats.crisis
      && ((sess.turns_since_summary ?? 0) >= 6 || F.LOST_MEANING_RE.test(text) || flowChoice?.id === "G2" || stats.lastWasSummary)
      ? ["IS8", "T16"] : undefined;
    const chunks = G.retrieve(rows, text, sess.weight, sess.relation, undefined, safetyContext, sess.recommended_mode, summaryKnowledge);
    const system = G.buildSystem(rows, chunks, sess.weight, sess.notes, sess.turns_since_summary, null, safetyContext, sess, F ? { stats, text } : undefined);
    const messages = hist.filter((h) => !h.crisis).map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.body }] }));
    const priorFailureCount = hist.filter((h) => (h.flags ?? []).some((f) => String(f).startsWith("生成失敗→"))).length;
    const useFlow = !!F && flowPhase === "phase2";
    const generated = await patient(
      () => G.generateReply(system, messages, undefined, undefined, undefined, priorFailureCount,
        useFlow ? { flowCheck: (o) => F.flowCheck(o, stats), flowFixHint: F.flowFixHint } : undefined),
      (x) => isTransientGenerateFailure(x), ROT_GEN, "生成: ");
    let out = generated.out;
    let flags = [...generated.flags];
    let offerChoices = false;
    if (useFlow && !generated.generationFailed) {
      const done = F.finalizeFlow(out, stats);
      out = done.out; flags = [...flags, ...done.notes]; offerChoices = done.offerChoices;
    }
    const declined = G.distressDeclinedNote ? G.distressDeclinedNote(sess, out) : null;
    if (declined) flags.push(declined);
    const upd = G.applyTurnUpdate(sess, out);
    const patch = { ...G.applyIntakeUpdate(sess, out), ...G.applyModeUpdate(sess, out), ...G.applyClosingUpdate(sess, out, flowPhase) };
    const merged = { ...sess, ...patch };
    const aiRow = {
      role: "ai", body: out.reply, question_level: out.question_level, summarized: out.did_summarize === true,
      mode: merged.recommended_mode ?? [], flags,
      ...(offerChoices ? { choices: F.CHOICES_G_PROVISIONAL, choice_set: F.FLOW_CHOICE_SET } : {}),
    };
    hist.push(aiRow);
    sess = { ...sess, ...upd, ...patch, ...(declined ? { distress_declined: true } : {}) };
    if (offerChoices) pendingChoices = { set: F.FLOW_CHOICE_SET, items: F.CHOICES_G_PROVISIONAL };
    appendFileSync(OUT, JSON.stringify({
      ...rec, counselor: out.reply, crisis: false, phase: sess.phase, flow_phase: flowPhase, relation: upd.relation, weight: upd.weight,
      question_level: out.question_level, did_summarize: out.did_summarize === true, move: out.move ?? null,
      recommended_mode: sess.recommended_mode, user_goal: sess.user_goal, flags, choices: offerChoices ? F.CHOICES_G_PROVISIONAL.map((c) => c.label) : null,
      flow_regens: generated.flowRegens ?? 0, model: generated.usedModel, why: out.why ?? null,
      generation_failed: generated.generationFailed === true, failure_cause: generated.failureCause || null,
      allowed: stats ? { hypothesis: stats.hypothesisAllowed, noticed: stats.noticedAllowed, link: stats.linkDue } : null,
      ai_row: aiRow,
    }) + "\n");
    console.log(`  [${variant}/${mode}#${rep} T${turn}] ${String(out.reply).slice(0, 40)}${flags.length ? ` flags=${JSON.stringify(flags).slice(0, 120)}` : ""}`);
    await sleep(500);
  }
  appendFileSync(OUT, JSON.stringify({ variant, mode, rep, last: true }) + "\n");
}

// ---- 採点(軽いモデル。1回の会話をまとめて1回で。--rate-each で返事ごと)----
async function rateBatch() {
  const recs = readRecords();
  const rated = new Set(recs.filter((r) => r.rating_of).map((r) => r.rating_of));
  const groups = {};
  for (const r of recs.filter((x) => x.turn && !x.rating_of)) (groups[`${r.variant}|${r.mode}|${r.rep}`] ??= []).push(r);
  for (const [key, list] of Object.entries(groups)) {
    list.sort((a, b) => a.turn - b.turn);
    const need = list.filter((r) => !r.crisis && !rated.has(`${key}|${r.turn}`));
    if (!need.length) continue;
    const turns = list.map((r) => ({ turn: r.turn, student: r.student, counselor: r.crisis ? null : r.counselor }));
    const res = await patient(() => rateConversation(turns, KEY_POOL, ROT_RATE), (x) => !x.ok && x.transient, ROT_RATE, "採点: ");
    if (!res.ok) { console.error(`  採点できませんでした ${key}: ${String(res.error ?? "").slice(0, 80)}`); continue; }
    for (const r of need) {
      const it = res.items[r.turn];
      if (it) appendFileSync(OUT, JSON.stringify({ rating_of: `${key}|${r.turn}`, ...it }) + "\n");
    }
    console.log(`  採点 ${key}: ${need.filter((r) => res.items[r.turn]).length}/${need.length}件`);
    await sleep(1000);
  }
}

// ---- 採点(軽いモデル)----
async function rateAll() {
  const recs = readRecords();
  const rated = new Set(recs.filter((r) => r.rating_of).map((r) => r.rating_of));
  const groups = {};
  for (const r of recs.filter((x) => x.turn && !x.rating_of)) (groups[`${r.variant}|${r.mode}|${r.rep}`] ??= []).push(r);
  for (const [key, list] of Object.entries(groups)) {
    list.sort((a, b) => a.turn - b.turn);
    const ctx = [];
    for (const r of list) {
      ctx.push({ role: "user", text: r.student });
      const id = `${key}|${r.turn}`;
      if (!r.crisis && !rated.has(id)) {
        const res = await patient(() => rateReply(ctx, r.counselor, KEY_POOL, ROT_RATE), (x) => !x.ok && x.transient, ROT_RATE, "採点: ");
        // 採点できなかったもの(上限など)は残さない(次に --rate を流したときに採点し直す)
        if (!res.ok) { console.error(`  採点できませんでした ${id}: ${String(res.error ?? "").slice(0, 80)}`); ctx.push({ role: "ai", text: r.counselor }); continue; }
        appendFileSync(OUT, JSON.stringify({ rating_of: id, ...res }) + "\n");
        console.log(`  採点 ${id}: 具体=${res.concrete} つなぎ=${res.link} 見立て=${res.hypothesis} 気になった=${res.noticed} 他人事=${res.generic} CBT=${res.cbt_move}`);
        await sleep(300);
      }
      ctx.push({ role: "ai", text: r.counselor });
    }
  }
}

// ---- 集計 ----
function summarize() {
  const recs = readRecords();
  const ratings = Object.fromEntries(recs.filter((r) => r.rating_of && r.ok).map((r) => [r.rating_of, r]));
  const groups = {};
  for (const r of recs.filter((x) => x.turn && !x.rating_of)) (groups[`${r.variant}|${r.mode}|${r.rep}`] ??= []).push(r);
  const runs = [];
  for (const [key, list] of Object.entries(groups)) {
    const [variant, mode, rep] = key.split("|");
    list.sort((a, b) => a.turn - b.turn);
    const hist = list.flatMap((r) => [
      { role: "user", body: r.student, ...(r.choice ? { choice_set: "G", choice_id: r.choice } : {}) },
      r.crisis ? { role: "ai", body: r.counselor, crisis: true }
        : { role: "ai", body: r.counselor, question_level: r.question_level, summarized: r.did_summarize, mode: r.recommended_mode ?? [], flags: r.flags ?? [], choices: r.choices },
    ]);
    const m = F_METRICS.conversationMetrics(hist);
    // 強い言葉は、修正前も同じものさしで数える(修正前は記録の印が無いので本文から)
    let strong = 0, heavy = 0;
    const userSoFar = [];
    for (const r of list) {
      userSoFar.push(r.student);
      if (r.crisis || (r.flow_phase ?? (r.phase === "phase2" ? "phase2" : "intake")) !== "phase2") continue;
      const w = F_METRICS.addedWords(r.counselor, userSoFar);
      strong += w.strong.length; heavy += w.heavy.length;
    }
    const gen = list.filter((r) => !r.crisis);
    const rt = gen.map((r) => ratings[`${key}|${r.turn}`]).filter(Boolean);
    const concreteDen = rt.filter((x) => x.concrete === "yes" || x.concrete === "no").length;
    // フェーズ2の最初のターン = 進め方がフェーズ2で生成した最初の返事(インテークを終えたターンの次)
    const p2 = gen.filter((r) => r.flow_phase === "phase2");
    const firstP2 = p2.length ? p2[0].turn : null;
    const cbtTurns = gen.filter((r) => ratings[`${key}|${r.turn}`]?.cbt_move === "yes").map((r) => r.turn);
    const cbtAfterP2 = firstP2 != null ? cbtTurns.filter((t) => t >= firstP2) : [];
    // サーバの記録(修正後だけ。モデルが「最初の一手を使った」と申告したターン)
    const flagTurn = gen.find((r) => (r.flags ?? []).includes("記録のみ:モードの最初の一手"))?.turn ?? null;
    runs.push({
      variant, mode, rep: +rep, turns: list.length,
      max_receive_only: m.maxReceiveOnly, regen_count: m.regenCount, regen_flags: m.regenFlags,
      summaries: gen.filter((r) => r.did_summarize).map((r) => r.turn),
      summary_form_flags: gen.filter((r) => (r.flags ?? []).some((f) => String(f).includes("まとめの形"))).map((r) => r.turn),
      cbt_first_move_turn: cbtAfterP2[0] ?? null, first_move_flag_turn: flagTurn, phase2_start_turn: firstP2,
      strong_words: strong, heavy_words: heavy, generic_repeats: m.genericRepeats, generic_counts: m.genericCounts,
      max_same_ending: m.maxSameEnding, sentence_dist: m.sentenceDist,
      concrete_rate: concreteDen ? rt.filter((x) => x.concrete === "yes").length / concreteDen : null, rated: rt.length,
      links: rt.filter((x) => x.link === "yes").length, hypotheses: rt.filter((x) => x.hypothesis === "yes").length,
      noticed: rt.filter((x) => x.noticed === "yes").length, generic_feel: rt.filter((x) => x.generic === "yes").length,
      hypothesis_out_of_rule: gen.filter((r) => ratings[`${key}|${r.turn}`]?.hypothesis === "yes" && r.allowed && !r.allowed.hypothesis).map((r) => r.turn),
      noticed_out_of_rule: gen.filter((r) => ratings[`${key}|${r.turn}`]?.noticed === "yes" && r.allowed && !r.allowed.noticed).map((r) => r.turn),
      generation_failures: gen.filter((r) => r.generation_failed).length,
      stage_by_turn: Object.fromEntries(list.map((r) => [r.turn, r.stage])),
    });
  }
  const summaryPath = OUT.replace(/\.jsonl$/, "-summary.json");
  writeFileSync(summaryPath, JSON.stringify({ out: path.relative(ROOT, OUT), targets: F_METRICS.FLOW_PASS_TARGETS, runs }, null, 2));
  const lines = runs.sort((a, b) => `${a.mode}${a.variant}${a.rep}`.localeCompare(`${b.mode}${b.variant}${b.rep}`)).map((r) =>
    `${r.mode}/${r.variant}#${r.rep}: 受け止めのみ最大${r.max_receive_only} 作り直し${r.regen_count} まとめ${JSON.stringify(r.summaries)} CBTの一手T${r.cbt_first_move_turn ?? "-"}(記録T${r.first_move_flag_turn ?? "-"}・P2開始T${r.phase2_start_turn ?? "-"}) `
    + `強い言葉${r.strong_words} 重さ${r.heavy_words} 汎用の2回目${r.generic_repeats} 同じ終わり方最大${r.max_same_ending} 具体${r.concrete_rate == null ? "-" : Math.round(r.concrete_rate * 100) + "%"} `
    + `つなぎ${r.links} 見立て${r.hypotheses}(条件外${r.hypothesis_out_of_rule.length}) 気になった${r.noticed}(条件外${r.noticed_out_of_rule.length}) 他人事${r.generic_feel}/${r.rated}`);
  writeFileSync(OUT.replace(/\.jsonl$/, "-summary.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  const py = spawnSync("python3", [path.join(ROOT, "scripts/export-conversation-flow-xlsx.py"), OUT], { stdio: "inherit" });
  if (py.status !== 0) console.error("エクセルを作れませんでした");
}

// ---- 実行 ----
mkdirSync(path.dirname(OUT), { recursive: true });
if (flag("rate")) { await rateBatch(); process.exit(0); }
if (flag("rate-each")) { await rateAll(); process.exit(0); }
if (flag("summary")) { summarize(); process.exit(0); }
const variant = arg("variant", "after");
const mode = arg("mode", "replay");
const reps = Number(arg("reps", 3));
const root = variant === "before" ? path.resolve(arg("before-root", "")) : ROOT;
if (variant === "before" && !existsSync(path.join(root, "src/generate.mjs"))) {
  console.error("--before-root に、修正前のコミットを置いた作業ツリーを指定してください"); process.exit(1);
}
const knowledgePath = arg("knowledge", "");
const knowledge = knowledgePath ? JSON.parse(readFileSync(path.resolve(knowledgePath), "utf8")) : null;
const done = new Set(readRecords().filter((r) => r.last).map((r) => `${r.variant}|${r.mode}|${r.rep}`));
for (let rep = 1; rep <= reps; rep++) {
  if (done.has(`${variant}|${mode}|${rep}`)) { console.log(`${variant}/${mode}#${rep} は済み`); continue; }
  // 途中で止まった回の記録は、集計では最後まで終わった回だけを使う(同じ回をやり直すと、あとの記録で上書きされる扱い)
  console.log(`\n=== ${variant} / ${mode} #${rep} ===`);
  await runOne({ variant, mode, rep, root, knowledge });
}
