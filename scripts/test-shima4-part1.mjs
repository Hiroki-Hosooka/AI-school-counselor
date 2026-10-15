// ============================================================================
//  嶋先生4回目を受けた第1部(不具合)のオフラインテスト(2026年10月14日)
//
//  実行: node scripts/test-shima4-part1.mjs。API・DB は使わない。
//  設計: docs/design-shima4-part1-topscreen.md 1章。指示書: docs/prompts/fix-after-shima4.md 第1部
//  確かめること
//   1. チップの受け取り(状態ではなく直前の返事の記録から。押した・手で打った・数字)
//   2. 相談ログ 86130eef の不具合の再現(状態の保存の失敗で step3 に止まる)と、直したあとの流れ
//   3. 同じ固定の文を1回の会話で2回出さない(段階ごとの応答・本番の既定)
//   4. 状態の保存に失敗した会話では固定の文を出さない
//   5. 本人が断った相手(見つけ方・固定の文・生成の出力チェック)
//   6. AI から会話を終える形の検知
//   7. スケーリングとインテークのラベルがそろっている
// ============================================================================

import {
  planSafetyTurn, validateChoice, resolveChoice, stateForChoice, dedupeFixedPlan, toGenerationPlan, stateUnreliable,
  defaultCrisisReplyFor, CHOICES_SCALING_PROVISIONAL, CHOICES_B_PROVISIONAL, CHOICE_C_INTRO_PROVISIONAL, CRISIS_STEP4_PROVISIONAL,
  CRISIS_STEP3_VARIANTS_PROVISIONAL, crisisStep3Text, crisisStep4Text, crisisRepeatText, buildCrisisReply, buildConcernBubbles,
  STATE_SAVE_FAILED_FLAG, declinedPeopleFrom, declineChangesIn, declinedNg, declinedEstimateFlag, DISTRESS_LABELS_PROVISIONAL,
  SCALING_PROMPT_SECOND_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL,
} from "../src/crisis-response.mjs";
import { endsConversation, aiEndingCheck, CHOICES_G_PROVISIONAL } from "../src/flow.mjs";
import { buildSystem } from "../src/generate.mjs";

process.env.CRISIS_RESPONSE = "staged";
let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  OK   ${label}`); } else { failed++; console.log(`  NG   ${label}${detail ? ` … ${detail}` : ""}`); }
}
const none = { stage: 0, decidedBy: [], keywords: [], patterns: [], subject: "self" };
const ai = (body, extra = {}) => ({ role: "ai", body, crisis: true, ...extra });
const user = (body, extra = {}) => ({ role: "user", body, ...extra });

// ---------------------------------------------------------------------------
console.log("\n1. チップの受け取り(直前の返事に保存したチップから)");
const histB = [ai(CRISIS_STEP4_PROVISIONAL.no, { choices: CHOICES_B_PROVISIONAL, choice_set: "B" })];
check("choice_id で受け取る(button)", resolveChoice(histB, "B2", "人とつながるのはおっくう。でも、もうちょっと聞いてほしい")?.input === "button");
check("同じラベルを手で打っても受け取る(typed)",
  resolveChoice(histB, null, "人とつながるのはおっくう。でも、もうちょっと聞いてほしい")?.id === "B2");
check("空白・記号の違いは無視する", resolveChoice(histB, null, "人とつながるのはおっくう でも もうちょっと聞いてほしい")?.id === "B2");
check("ラベルと違う文章は自由記述", resolveChoice(histB, null, "人と話すのは苦手だな") === null);
check("直前の返事に無い組の choice_id は受け取らない", resolveChoice(histB, "S4", "4 限界に近い") === null);
check("数字だけは B の組では受け取らない", resolveChoice(histB, null, "2") === null);
const histS = [ai("今の気持ちに近い数字を選んでみてね", { choices: CHOICES_SCALING_PROVISIONAL, choice_set: "scaling" })];
check("スケーリング: 数字だけ → チップ", resolveChoice(histS, null, "4")?.id === "S4");
check("スケーリング: 「4です」 → チップ", resolveChoice(histS, null, "4です")?.id === "S4");
check("スケーリング: 数字を除いたラベル → チップ", resolveChoice(histS, null, "限界に近い")?.id === "S4");
check("スケーリング: 画面に出した古いラベル(4 かなりつらい)も受け取る",
  resolveChoice([ai("x", { choices: [{ id: "S4", label: "4 かなりつらい" }], choice_set: "scaling" })], null, "4 かなりつらい")?.id === "S4");
const histG = [{ role: "ai", body: "どうしたい?", crisis: false, choices: CHOICES_G_PROVISIONAL, choice_set: "G" }];
check("組G も同じ関数で受け取る", resolveChoice(histG, "G2", "一緒に整理してみたい")?.set === "G");
check("最後の AI の返事にチップが無ければ受け取らない",
  resolveChoice([...histB, ai("ふつうの返事")], "B2", "x") === null);

// ---------------------------------------------------------------------------
console.log("\n2. 相談ログ 86130eef の不具合(状態の保存の失敗で 3通目のあとに止まる)の再現と、直したあと");
const stuck = { crisis_state: "step3", crisis_trigger: "accumulation", choice_sets_shown: [] };
// 以前の受け取り方(状態だけを見る)
const oldChoice = validateChoice(stuck, "B2");
const oldT8 = planSafetyTurn({ staged: none, state: stuck, text: CHOICES_B_PROVISIONAL[1].label, teacherAnswer: "no", choice: oldChoice });
check("[再現] 以前: B2 を押しても受け付けられない", oldChoice === null);
check("[再現] 以前: 7ターン目と同じ文(「今は話したくないんだね」)がもう一度出る", oldT8.text === CRISIS_STEP4_PROVISIONAL.no);
const oldT11 = planSafetyTurn({ staged: none, state: stuck, text: "4 かなりつらい", teacherAnswer: "unclear", choice: validateChoice(stuck, "S4") });
check("[再現] 以前: 「4 かなりつらい」に 3通目への「どちらでもない」の返事", oldT11.text === CRISIS_STEP4_PROVISIONAL.unclear);
// 直したあと: 直前の返事の記録からチップを受け取り、状態をそろえる
const picked = resolveChoice(histB, "B2", CHOICES_B_PROVISIONAL[1].label);
const aligned = stateForChoice(stuck, picked);
check("直したあと: 状態のずれを見つける", aligned.mismatch === true && aligned.state.crisis_state === "choice_b");
const newT8 = planSafetyTurn({ staged: none, state: aligned.state, text: "", choice: picked });
check("直したあと: B2 → 組C の前置き(億劫の流れ)", newT8.text === CHOICE_C_INTRO_PROVISIONAL && newT8.choices?.set === "C");
const pickedS = resolveChoice(histS, "S4", "4 限界に近い");
const alignedS = stateForChoice(stuck, pickedS);
const newT11 = planSafetyTurn({ staged: none, state: alignedS.state, text: "", choice: pickedS });
check("直したあと: スケーリングの答えとして受け取る(3通目への答えにしない)",
  newT11.text !== CRISIS_STEP4_PROVISIONAL.unclear && newT11.userChoice?.id === "S4", newT11.text);
check("直したあと: 否定の種類がわからない(状態を失った)ときは段階を下げない", newT11.stage === 2);

// ---------------------------------------------------------------------------
console.log("\n3. 同じ固定の文を1回の会話で2回出さない");
const planNo = planSafetyTurn({ staged: none, state: { crisis_state: "step3", choice_sets_shown: [] }, text: "いや", teacherAnswer: "no" });
const dupHist = [ai(CRISIS_STEP4_PROVISIONAL.no, { choices: CHOICES_B_PROVISIONAL, choice_set: "B" }), user("いや")];
const deduped = dedupeFixedPlan(planNo, dupHist);
check("最後の吹き出し(チップつき)が重なる → 指示つきの生成に切り替える",
  deduped.action === "generate" && deduped.crisisGenerated === true && deduped.safetyContexts.includes("crisisGeneration"));
check("切り替えたら、チップの組の待ちを残さない", deduped.nextState.pending_choice_set === null && deduped.nextState.crisis_state === "done");
check("切り替えても段階・通知・記録はそのまま", deduped.stage === 2 && deduped.notify === planNo.notify && !!deduped.event);
check("重ならなければそのまま", dedupeFixedPlan(planNo, [user("x")]) === planNo);
const multi = { action: "fixed", stage: 2, subject: "self", decidedBy: [], bubbles: [{ text: "A", crisisStep: 1 }, { text: "B", crisisStep: 3 }], nextState: {}, event: {} };
const partial = dedupeFixedPlan(multi, [ai("A")]);
check("途中の吹き出しだけ重なる → その吹き出しだけ出さない", partial.action === "fixed" && partial.bubbles.length === 1 && partial.bubbles[0].text === "B");
check("2回目のスケーリングは別の問いの文", planSafetyTurn({
  staged: none, state: { crisis_state: "done", scaling_count: 1, choice_sets_shown: ["scaling"] }, text: "冗談だよ",
}).text === SCALING_PROMPT_SECOND_PROVISIONAL);
// 本番の既定
const cat = "suicidal";
check("本番の既定: 1回目は固定応答", defaultCrisisReplyFor([user("死にたい")], cat).kind === "full");
const h1 = [user("死にたい"), ai(buildCrisisReply(cat)), user("うん"), { role: "ai", body: "そっか", crisis: false }, user("やっぱり死にたい")];
const d2 = defaultCrisisReplyFor(h1, cat);
check("本番の既定: 2回目は短い別の固定の1通", d2.kind === "repeat" && d2.text === crisisRepeatText());
const h2 = [...h1, ai(crisisRepeatText()), user("死にたい")];
check("本番の既定: 3回目からは指示つきの生成", defaultCrisisReplyFor(h2, cat).kind === "generate");
check("本番の既定: 2回目の1通も、断った先生を挙げない", !defaultCrisisReplyFor(h1, cat, ["teacher"]).text.includes("先生"));

// ---------------------------------------------------------------------------
console.log("\n4. 状態の保存に失敗した会話では固定の文を出さない");
const failedHist = [user("x"), { role: "ai", body: "y", flags: [`${STATE_SAVE_FAILED_FLAG}(テスト)`] }];
check("印を見つける", stateUnreliable(failedHist) && !stateUnreliable([user("x")]));
check("本番の既定: 1回目の打ち明けでも生成", defaultCrisisReplyFor([...failedHist, user("死にたい")], cat).kind === "generate");
const firstPlan = planSafetyTurn({ staged: { stage: 2, decidedBy: ["keyword"], keywords: ["死にたい"], patterns: [], subject: "self" }, state: {}, text: "死にたい" });
const gen = toGenerationPlan(firstPlan, "state_unreliable");
check("段階ごとの応答: 固定の文 → 指示つきの生成(危機カードは残す・通知も残す)",
  gen.action === "generate" && gen.card === "crisis" && gen.notify === true && gen.crisisGenerated === true);

// ---------------------------------------------------------------------------
console.log("\n5. 本人が断った相手");
const cases = [
  ["先生とは話したくない", ["teacher"]],
  ["親には言えない", ["parent"]],
  ["カウンセラーの先生は信用できない", ["counselor"]],
  ["保健室の先生には話しにくい", ["nurse"]],
  ["先生は無理", ["teacher"]],
  ["親には話せないけど先生なら話せるかも", ["parent"]],
  ["先生に怒られるのが嫌", []],
  ["先生と話した", []],
];
for (const [t, want] of cases) {
  const got = declineChangesIn(t).add.sort();
  check(`「${t}」→ ${want.join(",") || "なし"}`, JSON.stringify(got) === JSON.stringify([...want].sort()), JSON.stringify(got));
}
const hDecl = [user("先生とは話したくない"), ai("x"), user("やっぱり先生なら話せるかも")];
check("あとで前向きに書いたら外す", declinedPeopleFrom(hDecl).length === 0);
check("チップのラベル(本人の言葉ではない)は数えない", declinedPeopleFrom([user("先生には話したくない", { choice_id: "X1" })]).length === 0);
check("推定の印も数える", declinedPeopleFrom([{ role: "ai", body: "x", flags: [declinedEstimateFlag(["parent"])] }])[0] === "parent");
check("断った相手が無いときの文は以前と同じ(3通目 A)", crisisStep3Text([]) === "下にのせた相談先や、先生・おうちの人など、まわりの大人に話してみたいって思う？");
check("断った相手が無いときの文は以前と同じ(3通目 B・C)",
  CRISIS_STEP3_VARIANTS_PROVISIONAL.B === "今日のこと、下の相談先や、先生・おうちの人のような、まわりの大人にも話せそう？"
  && CRISIS_STEP3_VARIANTS_PROVISIONAL.C === "ここで話してくれたことを、下の相談先や、まわりの大人（先生やおうちの人など）にも話してみるのはどうかな。話してみたいって思う？");
check("断った相手が無いときの文は以前と同じ(2回目の1通)",
  CRISIS_REPEAT_PROVISIONAL === "また書いてくれてありがとう。ひとりで抱えなくていいからね。下の窓口や、学校の先生にも、あなたの声を届けてほしいです。");
check("断った相手が無いときの文は以前と同じ(本番の固定応答)",
  buildCrisisReply(cat).includes("学校の先生や保健室、スクールカウンセラー、家の人など、あなたの声が届く人"));
check("先生を断った: 3通目に先生が出ない", !crisisStep3Text(["teacher"]).includes("先生") && crisisStep3Text(["teacher"]).includes("おうちの人"));
check("先生と親を断った: 3通目は相談先だけ", crisisStep3Text(["teacher", "parent"]) === "下にのせた相談先に話してみたいって思う？");
check("先生を断った: 「先生に見せる」を言わない", !crisisStep4Text("unclear", ["teacher"]).includes("先生"));
check("先生を断った: 本番の固定応答に先生が出ない", !buildCrisisReply(cat, ["teacher"]).includes("先生"));
check("全員断った: 本番の固定応答の文がつながる", buildCrisisReply(cat, ["teacher", "parent", "counselor", "nurse"]).includes("その気持ちを、あなたの声が届く人とも"));
check("カウンセラーを断った: 2通目に出ない", !buildConcernBubbles(cat, ["counselor"]).join("").includes("カウンセラー"));
const stepPlan = planSafetyTurn({ staged: none, state: { crisis_state: "step3", choice_sets_shown: [] }, text: "わからない", teacherAnswer: "unclear", declined: ["teacher"] });
check("planSafetyTurn にも渡る(先生を断った「どちらでもない」)", !stepPlan.text.includes("先生"));
const ng = declinedNg(["teacher", "parent"]);
check("出力チェック: 先生に勧める言い方に当たる", ng.some((re) => re.test("担任の先生に話してみるのはどうかな?")));
check("出力チェック: 親に相談を勧める言い方に当たる", ng.some((re) => re.test("おうちの人に相談してみるのもいいかも")));
check("出力チェック: 断った事実を受け止める言い方には当たらない", !ng.some((re) => re.test("先生には話したくないんだね。")));
check("出力チェック: カウンセラーの先生は先生として扱わない", !declinedNg(["teacher"]).some((re) => re.test("カウンセラーの先生に話してみるのは?")));
const sys = buildSystem([], [], "rapport", {}, 0, null, ["afterCrisis"], { phase: "phase2" }, { declined: ["teacher"] });
check("生成の指示に断った相手が入る", sys.includes("相談者が断った相手") && sys.includes("先生"));

// ---------------------------------------------------------------------------
console.log("\n6. AI から会話を終える形");
check("「今日はゆっくり休んでね。」だけ → 終わりの形", endsConversation("話してくれてありがとう。今日はゆっくり休んでね。"));
check("「また話そうね」→ 終わりの形", endsConversation("そっか、大変だったね。また話そうね。"));
check("問いで終わる → 終わりの形ではない", !endsConversation("今日はゆっくり休んでね。最後に一つだけ、今どんな気持ち?"));
check("続きを促す一言がある → 終わりの形ではない", !endsConversation("今日はゆっくり休んでね。もう少し話せそうなら聞かせてね。"));
check("ふつうの受け止め → 終わりの形ではない", !endsConversation("それはしんどかったね。"));
check("本人が終わりの合図を出したら当てない", !aiEndingCheck({ reply: "今日はゆっくり休んでね。" }, { text: "もう寝るね" }));
check("合図が無ければ当てる", aiEndingCheck({ reply: "今日はゆっくり休んでね。" }, { text: "うん" }));
// 相談ログ 83fe3472 の T8(危機の状態の生成。問いも続きの一言も無い)
const L83 = "話してみたいとは思わないんだね。そう感じるのも無理はないよ。大人や相談先には話しにくい気持ち、そのまま教えてくれてありがとう。";
check("危機の状態の生成: 受け止めて終わるだけなら当てる(83fe3472 T8)", aiEndingCheck({ reply: L83 }, { text: "思わない", requireNext: true }));
check("ふつうの生成では受け止めのみに当てない(2回までは許す)", !aiEndingCheck({ reply: L83 }, { text: "思わない" }));
check("危機の状態の生成: 問いがあれば当てない",
  !aiEndingCheck({ reply: "話してみたいとは思わないんだね。今、いちばん気になっていることはある？" }, { text: "思わない", requireNext: true }));
check("危機の状態の生成: 続きを促す一言があれば当てない",
  !aiEndingCheck({ reply: "そう感じるのも無理はないよ。もう少し話せそうなら、続けて聞かせてね。" }, { text: "思わない", requireNext: true }));
check("危機の状態の生成でも、本人の終わりの合図があれば当てない",
  !aiEndingCheck({ reply: L83 }, { text: "もう寝るね", requireNext: true }));
check("区切りを聞いて本人が区切りを選んだら当てない",
  !aiEndingCheck({ reply: "今日はゆっくり休んでね。", closing_event: "close" }, { text: "うん", closingState: "awaiting_choice" }));

// ---------------------------------------------------------------------------
console.log("\n7. ラベルをそろえる");
check("スケーリングのラベルはインテークのつらさと同じ",
  CHOICES_SCALING_PROVISIONAL.map((c) => c.label).join("/") === "1 少し気になる/2 まあまあモヤモヤする/3 かなりつらい/4 限界に近い/5 もう耐えられない");
check("インテークの指示の文と同じ語", DISTRESS_LABELS_PROVISIONAL.every((l) => buildSystem([], [], "rapport", {}, 0, null, [], { phase: "intake" }, {}).includes(l)));

// ---------------------------------------------------------------------------
console.log("\n8. トップ画面とインテーク(コードで進める。src/intake.mjs)");
{
  const { planIntakeTurn, finishIntakeTurn, topScreenChoice, modesFromGoal, CATEGORY_CHOICES_PROVISIONAL } = await import("../src/intake.mjs");
  const sess = (step, extra = {}) => ({ phase: "intake", intake_step: step, ...extra });
  check("ボタンは最初の発言でだけ受け取る", topScreenChoice([], "K3", "家族・家のこと")?.id === "K3"
    && topScreenChoice([{ role: "ai", body: "x" }], "K3", "家族・家のこと") === null);
  check("同じラベルを手で打っても受け取る(印は typed)", topScreenChoice([], null, "家族・家のこと")?.input === "typed");
  check("ラベルと違う文は受け取らない", topScreenChoice([], null, "家族のことで") === null);
  check("6 つのボタンがある(6 = どれに当てはまるかわからない)", CATEGORY_CHOICES_PROVISIONAL.length === 6
    && CATEGORY_CHOICES_PROVISIONAL[5].label === "どれに当てはまるかわからない");
  for (const k of [1, 2, 3, 4, 5, 6]) {
    const t = planIntakeTurn({ sess: sess("category"), picked: { set: "K", id: `K${k}`, label: "x" }, text: "x", lastOffered: null });
    check(`K${k}: 主訴 ${k}・出どころ button・次は背景`, t.patch.chief_complaint_category === k && t.patch.chief_complaint_source === "button"
      && t.patch.intake_step === "background");
  }
  const free = finishIntakeTurn(planIntakeTurn({ sess: sess("category"), picked: null, text: "部活がつらい", lastOffered: null }),
    { intake: { chief_complaint_category: 2, background_present: false } });
  check("自由に書いたら主訴は AI の推定(出どころ estimated)", free.patch.chief_complaint_category === 2 && free.patch.chief_complaint_source === "estimated");
  const bad = finishIntakeTurn(planIntakeTurn({ sess: sess("category"), picked: null, text: "x", lastOffered: null }), { intake: { chief_complaint_category: 9 } });
  check("推定が範囲の外なら 6(未分類)", bad.patch.chief_complaint_category === 6);
  const bg = finishIntakeTurn(planIntakeTurn({ sess: sess("background"), picked: null, text: "先週から", lastOffered: null }), { intake: { onset_context: "先週から" } });
  check("背景のあとに、つらさの問い(チップつき)", bg.question?.choice_set === "D" && bg.patch.intake_step === "distress");
  const d2 = planIntakeTurn({ sess: sess("distress"), picked: { set: "D", id: "D2", label: "2" }, text: "2", lastOffered: "D" });
  check("つらさ 1〜3 はそのままゴールの問いへ", d2.after === "goal" && d2.contexts.length === 0 && d2.patch.distress_level === 2);
  for (const n of [4, 5]) {
    const d = planIntakeTurn({ sess: sess("distress"), picked: { set: "D", id: `D${n}`, label: `${n}` }, text: `${n}`, lastOffered: "D" });
    check(`つらさ ${n} は、コードで指示を付け、ゴールの問いは次のターン`, d.contexts.includes("intakeHighDistress") && d.after === null && d.patch.distress_level === n);
  }
  const dt = planIntakeTurn({ sess: sess("distress"), picked: null, text: "けっこうしんどい", lastOffered: "D" });
  check("つらさを言葉で答えたら数字を求め直さない", dt.after === "goal" && dt.patch.distress_level === undefined && dt.patch.intake_step === "goal");
  const again = planIntakeTurn({ sess: sess("distress"), picked: null, text: "うん", lastOffered: null });
  check("つらさの問いをまだ出していなければ、受け止めのあとに出す", again.prompt === "askDistressAgain" && again.after === "distress");
  const g = planIntakeTurn({ sess: sess("goal"), picked: { set: "H", id: "H2", label: "一緒に整理したい" }, text: "一緒に整理したい", lastOffered: "H" });
  check("ゴールを選んだらフェーズ2へ", g.patch.phase === "phase2" && g.patch.intake_step === "done" && g.patch.user_goal === "一緒に整理したい");
  check("進め方: H1・H4 は傾聴、H2 は AI の見立てか CBT、H3 は傾聴+",
    modesFromGoal("H1", ["CBT"]).join() === "LISTEN_ONLY" && modesFromGoal("H4", []).join() === "LISTEN_ONLY"
    && modesFromGoal("H2", []).join() === "CBT" && modesFromGoal("H2", ["SFBT"]).join() === "SFBT"
    && modesFromGoal("H3", []).join() === "LISTEN_ONLY,CBT");
  check("フェーズ2・危機のあとでは動かない", planIntakeTurn({ sess: { phase: "phase2", intake_step: "goal" }, picked: null, text: "x", lastOffered: null }) === null
    && planIntakeTurn({ sess: { phase: "intake", intake_step: null }, picked: null, text: "x", lastOffered: null }) === null);
}

console.log(`\n${failed ? `失敗 ${failed}件` : "全件通過"}(${passed + failed}件中)`);
process.exit(failed ? 1 : 0);
