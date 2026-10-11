// ============================================================================
//  段階ごとの応答(危機検知の作り直し 第2段階・仮)と、危機の流れの見直し(嶋先生 10/7)のオフライン回帰テスト
//
//  実行: node scripts/test-staged-response.mjs(API・DB は使わない。費用なし)
//
//  確かめること(2026年10月9日に、危機の流れの見直しに合わせて書き直した。docs/prompts/crisis-flow-shima3.md 7章)
//   1. src/crisis-response.mjs の planSafetyTurn の状態の移り変わり
//      ・段階を下げる条件の表(1-1)のすべての組み合わせ(明示的な否定 A・B / キーワードによらない否定 C × スケーリング1〜5 ×
//        戻る先 step1・step3・done、選ばなかった場合)。下げてよいのは A・B × 1・2 と C × 1 の3通りだけ
//      ・念押し(「冗談じゃない」など)は否定に数えない / 段階1から0に下がらない / 下げても通知と記録は取り消さない /
//        下げたあとのはっきりした危機のサインで段階2に戻す
//      ・3通目の答えの3つの分岐と、「話したくない」→ 組B → 組C の流れ / チップの組が続けて出ない / スケーリングは2回まで
//      ・同じ発言に危機のキーワードと否定(「死にたいとか冗談だよ」): 通知する・比喩なら通知しない・分類器が危機なら下げない
//      ・2通目の「〜が、とても心配です」が種類ごとの文面になる / 積み重なり・見守り・第三者・クロージングの例外(以前と同じ)
//   2. 仮の文面とチップのラベルが、すべて出力チェック(OUTPUT_NG)を通ること。危機の状態の生成に足す出力チェックの確かめ
//   3. Gemini の応答を差し替えて、classifyStaged と補助判定(返事の種類・比喩・相談先や大人に話したいか)を確かめる
//   4. buildSystem / retrieve の文脈(組B1・組C・終わり方・「大丈夫」の指示)と、危機の応答のあとのインテークの停止
//   5. 本番の既定(段階ごとの応答が無効)でも、固定応答を出したあとは危機のあとの指示を付けること(CLAUDE.md 5.17)。
//      本番の固定応答に「重い」を使わず、種類ごとに「〜が、とても心配です」を組むこと
// ============================================================================

import {
  planSafetyTurn, judgeWithdrawal, judgeTeacherAnswer, assessSafetyTurn, classifierModeFor, needsWithdrawalJudge, WATCH_TURNS,
  CARE_LINE_PROVISIONAL, CRISIS_STEP1_PROVISIONAL, CRISIS_STEP3_VARIANTS_PROVISIONAL, crisisStep3Text,
  CRISIS_STEP4_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL, CRISIS_AGAIN_PROVISIONAL,
  CHOICES_B_PROVISIONAL, CHOICES_C_PROVISIONAL, CHOICE_C_INTRO_PROVISIONAL, CHOICE_C_ACK_PROVISIONAL, CHOICE_NOTE_PROVISIONAL,
  SCALING_PROMPT_PROVISIONAL, SCALING_PROMPT_A_PROVISIONAL, CHOICES_SCALING_PROVISIONAL, SCALING_ACK_PROVISIONAL,
  CRISIS_ENDINGS_PROVISIONAL, nextEndingVariant, CHOICE_B1_BLOCK_PROVISIONAL, choiceCBlock, intakeStyleOf,
  CRISIS_GENERATION_FALLBACK_PROVISIONAL, CRISIS_GENERATION_EXTRA_NG, CRISIS_GENERATION_FIX_HINT, SCALING_MAX,
  CRISIS_FALLBACK_FLAG, finalizeCrisisGeneration, aftercareEnabled, hadCrisisReply, defaultSafetyContexts,
  lowersStage, typedScale, isDaijoubu, validateChoice, daijoubuYokattaNote,
  CONCERN_TEXT_PROVISIONAL, buildCrisisReply, buildConcernBubbles,
  CRISIS_WHY_HERE_PROVISIONAL, CHOICES_W_PROVISIONAL, CHOICE_W_ACK_PROVISIONAL, WHY_HERE_FREE_ACK_PROVISIONAL,
} from "../src/crisis-response.mjs";
import { classifyStaged, CRISIS_REPLY } from "../src/classify.mjs";
import { checkOutput, buildSystem, retrieve, generateReply, applyClosingUpdate, flowPhaseFor, applyIntakeUpdate, distressDeclinedNote, DISTRESS_DECLINED_FLAG } from "../src/generate.mjs";

let failed = 0;
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; return; }
  failed++;
  console.log(`  NG   ${name}${detail ? ` … ${detail}` : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 分類器の結果を手で作る(classifyStaged の戻り値と同じ形) ----
const det = (stage, decidedBy = [], { subject = "self", keywords = [], patterns = [], hits = [] } = {}) =>
  ({ stage, subject, decidedBy, keywords, patterns, idiomExempted: [], hits });
const S0 = det(0);
const S1_WATCH = det(1, ["classifier_watch"]);
const S1_IDIOM = det(1, ["idiom"]);
const S1_ERROR = det(1, ["classifier_error"]);
const S2_KEYWORD = det(2, ["keyword"], { keywords: ["死にたい"] });
const S2_VIOLENCE = det(2, ["keyword"], { keywords: ["殴られ"] });
const S2_CLASSIFIER = det(2, ["classifier"]);
const S2_KW_CLASSIFIER = det(2, ["keyword", "classifier"], { keywords: ["死にたい"] });
const S2_OTHER = det(2, ["classifier"], { subject: "other" });
const fresh = {
  watch_turns_left: 0, crisis_state: "none", crisis_trigger: null, care_shown: false, reentry_used: false, repeat_used: false,
  closing_state: "none", crisis_resume: null, crisis_negation: null, pending_choice_set: null, scaling_count: 0,
  choice_sets_shown: [], crisis_category: null, crisis_choice_c: null,
};
const st = (o) => ({ ...fresh, crisis_trigger: "direct", ...o });
const steps = (p) => (p.bubbles ?? []).map((b) => b.crisisStep);
const isCrisisGeneration = (p) => p.action === "generate" && p.crisisGenerated === true && p.stage === 2
  && eq(p.safetyContexts, ["crisisGeneration", "afterCrisis"]) && p.card === null && p.crisisStep === null
  && p.notify && p.notifySubject === "self" && p.decidedBy.includes("crisis_generation")
  && p.event?.stage === 2 && p.event?.crisis_step === null && p.nextState.crisis_state === "done" && p.nextState.watch_turns_left === 0;
// 否定の例(A・B は語の照合、C は返事の種類の判定 withdrawal と段階2の「大丈夫」)
const NEG = {
  A: { text: "ほんとは死にたくない", withdrawal: "other" },
  B: { text: "冗談だよ", withdrawal: "withdrawal" },
  C: { text: "なんでもない", withdrawal: "withdrawal" },
};

// ============================================================================
console.log("1. planSafetyTurn の状態の移り変わり");
// ============================================================================
{
  const p = planSafetyTurn({ staged: S0, state: fresh });
  check("段階0: 生成・カードなし・記録なし", p.action === "generate" && p.card === null && p.event === null && p.stage === 0);
  const p1 = planSafetyTurn({ staged: S1_WATCH, state: fresh });
  check("段階1: 見守り開始・気づかいのカード・Tier B の指示",
    p1.action === "generate" && p1.card === "care" && p1.nextState.watch_turns_left === WATCH_TURNS
      && p1.nextState.care_shown === true && p1.event?.watch_event === "start" && eq(p1.safetyContexts, ["tierB"]) && !p1.notify);
  check("段階1(気づかいの一言は出し済み): 折りたたみの窓口だけ", planSafetyTurn({ staged: S1_WATCH, state: { ...fresh, care_shown: true } }).card === "hotlines");
  const w = planSafetyTurn({ staged: S1_WATCH, state: { ...fresh, watch_turns_left: 2, care_shown: true } });
  check("見守り中の再サイン → 段階2(積み重なり)の1通目", w.stage === 2 && eq(steps(w), [1]) && w.nextState.crisis_trigger === "accumulation" && w.notify);
  const we = planSafetyTurn({ staged: S1_ERROR, state: { ...fresh, watch_turns_left: 2, care_shown: true } });
  check("見守り中の分類器エラーは本人のサインではない(上げない)", we.stage === 1 && we.action === "generate");
}
{
  // 打ち明け → 受け止め・心配(危機カード)・ここで話せた理由の問い(組Wのチップ)の3つ(2026年10月11日に人が決めた)。種類を覚えておく
  const p = planSafetyTurn({ staged: S2_KEYWORD, state: fresh });
  check("段階2: 受け止め → 心配(危機カード)→ ここで話せた理由の問い(組Wのチップ)を1つずつ・通知",
    eq(steps(p), [1, 2, 1]) && p.bubbles[0].text === CRISIS_STEP1_PROVISIONAL && p.bubbles[0].card === null
      && p.bubbles[1].card === "crisis" && p.bubbles[1].text.includes("とても心配です") && p.bubbles[2].text === CRISIS_WHY_HERE_PROVISIONAL
      && p.choices?.set === "W" && p.notify
      && p.nextState.crisis_state === "step1" && p.nextState.crisis_category === "suicidal" && p.nextState.choice_sets_shown.includes("W"));
  check("AI の番の最後は質問で終わる", /？$/.test(p.bubbles[p.bubbles.length - 1].text));
  const sw = { ...st({ crisis_state: "step1", crisis_category: "suicidal" }), choice_sets_shown: ["W"] };
  const wChoice = validateChoice(sw, "W3");
  check("組Wのチップは、最初のターンのあとだけ受け付ける", wChoice?.set === "W" && validateChoice(st({ crisis_state: "step1" }), "W3") === null
    && validateChoice({ ...sw, crisis_state: "step3" }, "W3") === null);
  const pw = planSafetyTurn({ staged: S0, state: sw, choice: wChoice });
  check("組Wを押した → 選んだものを受け止める一言 + 3通目(心配はくり返さない)",
    eq(steps(pw), [4, 3]) && pw.bubbles[0].text === CHOICE_W_ACK_PROVISIONAL.W3 && pw.nextState.crisis_state === "step3"
      && pw.userChoice?.id === "W3" && !pw.notify);
  const pf = planSafetyTurn({ staged: S0, state: sw, text: "なんとなく", withdrawal: "other" });
  check("問いに自由に書いて答えた → 短い受け止め + 3通目", eq(steps(pf), [4, 3]) && pf.bubbles[0].text === WHY_HERE_FREE_ACK_PROVISIONAL
    && pf.nextState.crisis_state === "step3");
  const ps = planSafetyTurn({ staged: S0, state: sw, text: "冗談だよ", withdrawal: "withdrawal" });
  const pk = planSafetyTurn({ staged: S0, state: { ...ps.nextState, closing_state: "none" }, choice: validateChoice(ps.nextState, "S4") });
  check("問いへの答えが否定 → スケーリング → 下げないなら受け止め + 3通目だけ(心配はくり返さない)",
    ps.choices?.set === "scaling" && eq(steps(pk), [11, 3]) && pk.nextState.crisis_state === "step3");
  const acc = planSafetyTurn({ staged: S1_WATCH, state: { ...fresh, watch_turns_left: 2, care_shown: true } });
  check("積み重なりの1通目は今までどおり受け止めだけ(折りたたみの窓口)", eq(steps(acc), [1]) && acc.bubbles[0].card === "hotlines" && acc.choices === null);
  // 1通目への返事 → 2通目(心配。短い吹き出し3つ)+3通目。危機カードは2通目の最後の吹き出し
  const r = planSafetyTurn({ staged: S0, state: st({ crisis_state: "step1", crisis_category: "suicidal" }), text: "うん", withdrawal: "other" });
  check("1通目への返事 → 2通目(心配)の吹き出し3つ+3通目を同じターンに",
    eq(steps(r), [2, 2, 2, 3]) && r.bubbles[2].card === "crisis" && r.bubbles[0].text === `${CONCERN_TEXT_PROVISIONAL.suicidal}が、とても心配です。`
      && r.bubbles[3].text === crisisStep3Text() && r.nextState.crisis_state === "step3" && !r.notify);
  check("2通目に「重い」「話しにくい」の問いを使わない", !r.bubbles.some((b) => /重い|話しにくい/.test(b.text)));
  const v = planSafetyTurn({ staged: S2_VIOLENCE, state: fresh });
  const v2 = planSafetyTurn({ staged: S0, state: { ...st({ crisis_state: "step1" }), crisis_category: v.nextState.crisis_category }, text: "うん" });
  check("種類(暴力・虐待)→「安全が守られていないかもしれないこと」「そのこと」",
    v.nextState.crisis_category === "violence" && v2.bubbles[0].text.startsWith(CONCERN_TEXT_PROVISIONAL.violence) && v2.bubbles[1].text.includes("そのこと"));
  const u = planSafetyTurn({ staged: S0, state: st({ crisis_state: "step1" }), text: "うん" });
  check("種類不明(分類器だけで危機など)→「書いてくれたつらさが、とても心配です」", u.bubbles[0].text === "書いてくれたつらさが、とても心配です。");
  const merged = planSafetyTurn({ staged: S2_KEYWORD, state: st({ crisis_state: "step1", crisis_category: "violence" }), text: "殴られて死にたい" });
  check("1通目への返事でほかの種類にも当たったら、優先の高いほう(希死念慮)", merged.nextState.crisis_category === "suicidal" && merged.notify);
  const savedV = process.env.CRISIS_STEP3_VARIANT;
  process.env.CRISIS_STEP3_VARIANT = "C";
  const c = planSafetyTurn({ staged: S0, state: st({ crisis_state: "step1" }), text: "うん" });
  if (savedV === undefined) delete process.env.CRISIS_STEP3_VARIANT; else process.env.CRISIS_STEP3_VARIANT = savedV;
  check("3通目の候補は設定 CRISIS_STEP3_VARIANT で切り替える", c.bubbles[3].text === CRISIS_STEP3_VARIANTS_PROVISIONAL.C);
}
{
  // 3通目への答えの3つの分岐
  const s3 = st({ crisis_state: "step3" });
  const yes = planSafetyTurn({ staged: S0, state: s3, text: "話してみようかな", withdrawal: "other", teacherAnswer: "yes" });
  check("3通目 → 話したい: 一言を返して、そのあとは生成(出し終えた)", eq(steps(yes), [4]) && yes.bubbles[0].text === CRISIS_STEP4_PROVISIONAL.yes
    && yes.nextState.crisis_state === "done" && yes.choices === null && yes.event?.teacher_answer === "yes");
  const un = planSafetyTurn({ staged: S0, state: s3, text: "わかんない", withdrawal: "other", teacherAnswer: "unclear" });
  check("3通目 → どちらでもない: 一言を返して出し終えた", un.bubbles[0].text === CRISIS_STEP4_PROVISIONAL.unclear && un.nextState.crisis_state === "done");
  const no = planSafetyTurn({ staged: S0, state: s3, text: "話したくない", withdrawal: "other", teacherAnswer: "no" });
  check("3通目 → 話したくない: 受け止め+組B(2択)のチップ", no.bubbles[0].text === CRISIS_STEP4_PROVISIONAL.no
    && no.choices?.set === "B" && eq(no.choices.items, CHOICES_B_PROVISIONAL) && no.nextState.crisis_state === "choice_b"
    && no.nextState.pending_choice_set === "B" && no.nextState.choice_sets_shown.includes("B"));
  // 組B
  const b = no.nextState;
  const b1 = planSafetyTurn({ staged: S0, state: b, choice: { set: "B", id: "B1", input: "button" } });
  check("組B の B1(うっとうしい)→ 深追いしない指示で生成・チップなし", b1.action === "generate" && eq(b1.safetyContexts, ["choiceB1", "afterCrisis"])
    && b1.nextState.crisis_state === "done" && b1.choices === null && eq(b1.userChoice, { set: "B", id: "B1", input: "button" }));
  const b2 = planSafetyTurn({ staged: S0, state: b, choice: { set: "B", id: "B2", input: "button" } });
  check("組B の B2(聞いてほしい)→ 前置き+組C のチップ(B → C は続けて出す)", eq(steps(b2), [12]) && b2.bubbles[0].text === CHOICE_C_INTRO_PROVISIONAL
    && b2.choices?.set === "C" && b2.choices.items.length === 7 && b2.nextState.crisis_state === "choice_c");
  const bf = planSafetyTurn({ staged: S0, state: b, text: "別に。どっちでもない", withdrawal: "withdrawal" });
  check("組B を選ばずに自由に書いた → 出し終えた状態で生成。続けてスケーリングのチップは出さない",
    bf.action === "generate" && bf.choices === null && bf.nextState.crisis_state === "done" && bf.safetyContexts.includes("afterCrisis"));
  // 組C
  const cst = b2.nextState;
  for (const c of CHOICES_C_PROVISIONAL) {
    const r = planSafetyTurn({ staged: S0, state: cst, choice: { set: "C", id: c.id, input: "button" } });
    check(`組C の ${c.id} → 選んだものをそのまま受け止める一言・出し終えた・選んだものを覚える`,
      eq(steps(r), [13]) && r.bubbles[0].text === CHOICE_C_ACK_PROVISIONAL[c.id] && r.nextState.crisis_state === "done" && r.nextState.crisis_choice_c === c.id);
  }
  const after = planSafetyTurn({ staged: S0, state: { ...cst, crisis_state: "done", crisis_choice_c: "C6" }, text: "うん" });
  check("組C のあと → 危機のあとの指示+組Cの指示で生成(AIから終わらせない)", after.action === "generate" && eq(after.safetyContexts, ["afterCrisis", "choiceC"]));
  const cf = planSafetyTurn({ staged: S0, state: cst, text: "うまく言えない" });
  check("組C を選ばずに自由に書いた → 出し終えた状態で生成", cf.action === "generate" && cf.nextState.crisis_state === "done" && cf.nextState.crisis_choice_c === null);
  const again = planSafetyTurn({ staged: S0, state: { ...s3, choice_sets_shown: ["B"] }, text: "話したくない", teacherAnswer: "no" });
  check("同じ組は1回まで(組B を出したあとにもう一度「話したくない」→ どちらでもないの一言)", again.choices === null && again.bubbles[0].text === CRISIS_STEP4_PROVISIONAL.unclear);
}
{
  // ---- 段階を下げる条件の表(1-1): すべての組み合わせ ----
  for (const resume of ["step1", "step3", "done"]) {
    for (const type of ["A", "B", "C"]) {
      const n = NEG[type];
      const sp = planSafetyTurn({ staged: S0, state: st({ crisis_state: resume }), text: n.text, withdrawal: n.withdrawal, teacherAnswer: "unclear" });
      check(`否定${type}(${resume}のあと)→ スケーリングのチップ`, eq(steps(sp), [10]) && sp.choices?.set === "scaling"
        && eq(sp.choices.items, CHOICES_SCALING_PROVISIONAL) && sp.nextState.crisis_state === "scaling" && sp.nextState.crisis_resume === resume
        && sp.nextState.crisis_negation === type && sp.nextState.scaling_count === 1 && sp.event?.negation_type === type
        && sp.bubbles[0].text === (type === "A" ? SCALING_PROMPT_A_PROVISIONAL : SCALING_PROMPT_PROVISIONAL) && !sp.notify);
      for (const scale of [1, 2, 3, 4, 5]) {
        const want = (type === "C" && scale === 1) || (type !== "C" && scale <= 2);
        for (const via of ["button", "typed"]) {
          const r = planSafetyTurn({
            staged: S0, state: sp.nextState, text: via === "typed" ? `${scale}` : "",
            choice: via === "button" ? { set: "scaling", id: `S${scale}`, input: "button" } : null,
          });
          const lowered = r.stage === 1 && r.nextState.crisis_state === "lowered" && r.event?.lowered === true;
          check(`否定${type} × スケーリング${scale}(${resume}のあと・${via === "typed" ? "数字を書いた" : "ボタン"})→ ${want ? "1段階下げる" : "下げない"}`,
            lowered === want && r.event?.scale === scale && r.userChoice?.id === `S${scale}` && r.userChoice?.input === via
              && (want
                ? r.action === "generate" && eq(r.safetyContexts, ["tierB", "afterCrisis"]) && ["care", "hotlines"].includes(r.card) && !r.notify
                : r.stage === 2 && r.bubbles[0].crisisStep === 11 && r.bubbles[0].text === SCALING_ACK_PROVISIONAL
                  && (resume === "step1" ? eq(steps(r), [11, 2, 2, 2, 3]) && r.nextState.crisis_state === "step3" : eq(steps(r), [11]) && r.nextState.crisis_state === resume)),
            JSON.stringify({ stage: r.stage, state: r.nextState.crisis_state, steps: steps(r) }));
        }
      }
      // 選ばずに自由に書いた → 下げない(止まっていた状態として続ける。続けてチップは出さない)
      const free = planSafetyTurn({ staged: S0, state: sp.nextState, text: "わかんない", withdrawal: "other", teacherAnswer: "unclear" });
      check(`否定${type} → 選ばずに自由に書いた(${resume}のあと)→ 下げない・続けてチップを出さない`,
        free.stage !== 1 && free.nextState.crisis_state !== "lowered" && free.choices === null
          && (resume === "step1" ? eq(steps(free), [2, 2, 2, 3]) : resume === "step3" ? eq(steps(free), [4]) : free.action === "generate"));
    }
  }
  check("下げてよいのは3通りだけ(lowersStage)", [["A", 1], ["A", 2], ["B", 1], ["B", 2], ["C", 1]].every(([t, n]) => lowersStage(t, n))
    && [["A", 3], ["B", 3], ["C", 2], ["C", 3], ["A", 5], [null, 1], ["A", null]].every(([t, n]) => !lowersStage(t, n)));
  check("数字だけの発言はスケーリングの答え(「2」「２」「2です」「2かな」)", [["2", 2], ["２", 2], ["2です", 2], ["2かな", 2], ["5", 5]].every(([t, n]) => typedScale(t) === n)
    && [["2と3の間", null], ["12", null], ["6", null], ["0", null], ["2回目", null]].every(([t, n]) => typedScale(t) === n));
}
{
  // 念押し・絶望感は否定に数えない
  const s1 = st({ crisis_state: "step1" });
  for (const t of ["冗談じゃない", "本気だよ", "マジで", "うそじゃないよ"]) {
    const r = planSafetyTurn({ staged: S0, state: s1, text: t, withdrawal: "reaffirm" });
    check(`念押し「${t}」は否定に数えない(スケーリングを出さず2通目へ)`, eq(steps(r), [2, 2, 2, 3]) && r.choices === null);
  }
  const res = planSafetyTurn({ staged: S1_WATCH, state: s1, text: "もういい、どうせ", withdrawal: "resignation" });
  check("絶望感「もういい、どうせ」は否定ではない(諦め。2通目へ)", eq(steps(res), [2, 2, 2, 3]) && res.choices === null);
  const dj = planSafetyTurn({ staged: S0, state: s1, text: "大丈夫", withdrawal: "other" });
  check("段階2の「大丈夫」は否定C(判定が引き下がりでなくても)", dj.nextState.crisis_negation === "C" && dj.choices?.set === "scaling");
  check("「大丈夫じゃない」「大丈夫かな」は否定ではない", !isDaijoubu("大丈夫じゃない") && !isDaijoubu("大丈夫かな") && isDaijoubu("大丈夫です") && isDaijoubu("だいじょぶ"));
}
{
  // 段階1から0に下げない / 下げたあとのはっきりした危機のサインで段階2に戻す
  const low = st({ crisis_state: "lowered", crisis_resume: "step1", crisis_category: "suicidal" });
  const z = planSafetyTurn({ staged: S0, state: low, text: "部活の話なんだけど" });
  check("下げたあとの段階0の発言も段階1のまま(Tier B+危機のあと)", z.stage === 1 && eq(z.safetyContexts, ["tierB", "afterCrisis"]) && z.nextState.crisis_state === "lowered");
  const wch = planSafetyTurn({ staged: S1_WATCH, state: low, text: "しんどい" });
  check("下げたあとの watch 相当だけでは段階2に戻さない", wch.stage === 1 && !wch.notify && wch.nextState.crisis_state === "lowered");
  const back = planSafetyTurn({ staged: S2_KEYWORD, state: low, text: "やっぱり死にたい" });
  check("下げたあと、はっきりした危機のサイン → 段階2に戻して通知。止まっていた続き(2通目・3通目)から",
    back.stage === 2 && back.notify && eq(steps(back), [2, 2, 2, 3]) && back.nextState.crisis_state === "step3" && back.decidedBy.includes("raised_after_lowered"));
  const backDone = planSafetyTurn({ staged: S2_KEYWORD, state: { ...low, crisis_resume: "done" }, text: "やっぱり死にたい" });
  check("下げたあと(出し終えたあとに下げた)の危機のサイン → 2回目以降の短い1通・通知", backDone.notify && eq(steps(backDone), [5]) && backDone.nextState.repeat_used);
  const backCls = planSafetyTurn({ staged: S2_CLASSIFIER, state: { ...low, crisis_resume: "done", repeat_used: true }, text: "…" });
  check("下げたあと、分類器だけの危機 → 危機の状態の生成・通知", isCrisisGeneration(backCls));
  // 下げたターンでも、それより前の段階2の通知と記録はそのまま(取り消す仕組みが無い。下げたターンの記録は lowered)
  const sp = planSafetyTurn({ staged: S0, state: st({ crisis_state: "done" }), text: "冗談だよ", withdrawal: "withdrawal" });
  const lw = planSafetyTurn({ staged: S0, state: sp.nextState, choice: { set: "scaling", id: "S1", input: "button" } });
  check("下げたターン: 段階1・lowered を記録・通知しない・危機の状態は none に戻さない",
    lw.event?.stage === 1 && lw.event.lowered && !lw.notify && lw.nextState.crisis_state === "lowered" && lw.nextState.crisis_state !== "none");
}
{
  // チップの組を続けて出さない / スケーリングは2回まで
  const sp = planSafetyTurn({ staged: S0, state: st({ crisis_state: "done" }), text: "冗談だよ", withdrawal: "withdrawal" });
  const twice = planSafetyTurn({ staged: S0, state: sp.nextState, text: "なんでもないって", withdrawal: "withdrawal" });
  check("スケーリングのすぐあとの否定 → 続けてチップを出さない(下げない)", twice.choices === null && twice.nextState.crisis_state !== "lowered" && twice.nextState.pending_choice_set === null);
  const second = planSafetyTurn({ staged: S0, state: { ...twice.nextState }, text: "冗談だって", withdrawal: "withdrawal" });
  check("1ターンあけば、2回目のスケーリングを出せる", second.choices?.set === "scaling" && second.nextState.scaling_count === 2);
  const third = planSafetyTurn({ staged: S0, state: { ...st({ crisis_state: "done" }), scaling_count: SCALING_MAX }, text: "冗談だよ", withdrawal: "withdrawal" });
  check(`スケーリングは1回の会話で${SCALING_MAX}回まで`, third.choices === null && third.action === "generate");
  const afterB = planSafetyTurn({ staged: S0, state: st({ crisis_state: "choice_b", pending_choice_set: "B", choice_sets_shown: ["B"] }), text: "冗談だよ", withdrawal: "withdrawal" });
  check("組B のすぐあとの否定 → スケーリングを続けて出さない", afterB.choices === null);
  check("押したチップは、直前に付けた組のものだけ受け付ける", validateChoice({ pending_choice_set: "B" }, "B2")?.id === "B2"
    && validateChoice({ pending_choice_set: "B" }, "C1") === null && validateChoice({ pending_choice_set: null }, "S1") === null
    && validateChoice({ pending_choice_set: "scaling" }, "S9") === null);
}
{
  // 同じ発言に危機のキーワードと否定(「死にたいとか冗談だよ」。1-3)
  const s1 = st({ crisis_state: "step1" });
  const ref = planSafetyTurn({ staged: S2_KEYWORD, state: s1, text: "死にたいとか冗談だよ", withdrawal: "withdrawal", figurative: false });
  check("「死にたいとか冗談だよ」→ 新しいサインとして数えず、スケーリング。通知は出す", ref.choices?.set === "scaling" && ref.notify
    && ref.decidedBy.includes("negation_reference") && ref.event?.negation_type === "B");
  const fig = planSafetyTurn({ staged: S2_KEYWORD, state: s1, text: "テストやばすぎて死にたいって意味だよ、冗談", withdrawal: "withdrawal", figurative: true });
  check("比喩・強調の「死にたい」→ 通知しない(スケーリングは出す)", fig.choices?.set === "scaling" && !fig.notify && fig.event?.figurative === true);
  const cls = planSafetyTurn({ staged: S2_KW_CLASSIFIER, state: s1, text: "死にたいとか冗談だよ", withdrawal: "withdrawal" });
  check("分類器が新しい危機と判定 → スケーリングを出さず(下げない)流れを続け、通知", cls.choices === null && eq(steps(cls), [2, 2, 2, 3]) && cls.notify);
  const first = planSafetyTurn({ staged: S2_KEYWORD, state: fresh, text: "死にたいとか冗談だよ", withdrawal: null });
  check("まだ危機の応答を始めていないときの「死にたいとか冗談だよ」→ 今どおり打ち明けとして最初のターン", eq(steps(first), [1, 2, 1]) && first.notify);
  const done = planSafetyTurn({ staged: S2_KEYWORD, state: { ...st({ crisis_state: "done" }), scaling_count: SCALING_MAX }, text: "死にたいとか冗談だよ", withdrawal: "withdrawal" });
  check("スケーリングを出せないときの「死にたいとか冗談だよ」→ 危機のあとの指示で生成・通知(2回目以降の短い1通は出さない)",
    done.action === "generate" && !done.crisisGenerated && done.notify && done.safetyContexts.includes("afterCrisis") && !done.nextState.repeat_used);
}
{
  // 出し終えたあと(以前と同じ: 新しい打ち明けは短い1通を1回まで、それ以降は危機の状態の生成)
  const d = st({ crisis_state: "done" });
  const r1 = planSafetyTurn({ staged: S2_KEYWORD, state: d, text: "やっぱり死にたい" });
  check("出し終えたあとの新しい打ち明け → 2回目以降の短い1通(危機カード)・通知", eq(steps(r1), [5]) && r1.bubbles[0].card === "crisis" && r1.notify && r1.nextState.repeat_used);
  const r2 = planSafetyTurn({ staged: S2_KEYWORD, state: r1.nextState, text: "死にたい" });
  check("2回目の打ち明け → 同じ文面をくり返さず危機の状態の生成", isCrisisGeneration(r2));
  const r3 = planSafetyTurn({ staged: S2_CLASSIFIER, state: d, text: "…" });
  check("分類器だけの危機 → 危機の状態の生成", isCrisisGeneration(r3));
  const r4 = planSafetyTurn({ staged: S1_WATCH, state: d, text: "しんどい" });
  check("出し終えたあとの watch 相当 → Tier B+危機のあとの指示で生成(見守らない)", r4.action === "generate" && eq(r4.safetyContexts, ["tierB", "afterCrisis"]) && !r4.notify);
  const r5 = planSafetyTurn({ staged: S2_OTHER, state: d, text: "友達が" });
  check("出し終えたあとの第三者の危機 → 第三者+危機のあとの指示・通知", r5.subject === "other" && r5.notify && eq(r5.safetyContexts, ["thirdParty", "afterCrisis"]));
}
{
  // 積み重なり(以前と同じ。2通目・3通目は1ターンで出す)
  const acc = st({ crisis_state: "step1", crisis_trigger: "accumulation", care_shown: true });
  const pz = planSafetyTurn({ staged: S1_WATCH, state: acc, text: "しんどい" });
  check("積み重なりの1通目への返事に、はっきりしたサインが無い → 止めて見守り(否定のスケーリングは出さない)",
    pz.decidedBy.includes("accumulation_pause") && pz.nextState.crisis_state === "paused1" && pz.nextState.watch_turns_left === WATCH_TURNS && pz.choices === null);
  const nz = planSafetyTurn({ staged: S0, state: acc, text: "なんでもない", withdrawal: "withdrawal" });
  check("積み重なりの1通目への「なんでもない」→ 止める(スケーリングは出さない)", nz.decidedBy.includes("accumulation_pause") && nz.choices === null);
  const go = planSafetyTurn({ staged: S2_KEYWORD, state: acc, text: "死にたい" });
  check("積み重なりの1通目への返事に、はっきりした危機のサイン → 2通目・3通目", eq(steps(go), [2, 2, 2, 3]) && go.notify);
  const re = planSafetyTurn({ staged: S1_WATCH, state: pz.nextState, text: "もう無理" });
  check("止めたあとの見守り中の再サイン → 再受け止め(1回まで)", eq(steps(re), [6]) && re.nextState.crisis_state === "again1" && re.nextState.reentry_used);
  const rz = planSafetyTurn({ staged: S1_WATCH, state: re.nextState, text: "しんどい" });
  check("再受け止めへの返事にはっきりしたサインが無い → 止める(以後は見守らない)", rz.nextState.crisis_state === "paused1" && rz.nextState.watch_turns_left === 0);
  const rk = planSafetyTurn({ staged: S2_KEYWORD, state: rz.nextState, text: "死にたい" });
  check("止めたあとの、はっきりした危機のサイン → 止めていた続き(2通目・3通目)", eq(steps(rk), [2, 2, 2, 3]) && rk.notify);
}
{
  // 第三者・クロージングの例外(以前と同じ)
  const o = planSafetyTurn({ staged: S2_OTHER, state: fresh });
  check("第三者の危機 → 生成を続ける・第三者の指示・通知", o.action === "generate" && o.subject === "other" && o.notify && eq(o.safetyContexts, ["thirdParty"]));
  const ce = planSafetyTurn({ staged: det(2, ["keyword"], { keywords: ["終わりにしたい"] }), state: { ...fresh, closing_state: "awaiting_choice" } });
  check("クロージングの問いかけへの「終わりにしたい」→ 段階1にとどめる", ce.stage === 1 && ce.decidedBy.includes("closing_exception") && !ce.notify);
}
{
  // 以前の流れの値(13節まで)が入っていても動く
  const legacy = planSafetyTurn({ staged: S0, state: { ...fresh, crisis_state: "wrap1" }, text: "うん" });
  check("以前の値(wrap1)→ 出し終えた状態として扱う", legacy.action === "generate" && legacy.nextState.crisis_state === "done");
  check("補助判定を呼ぶ状態: 段階2の状態だけ(積み重なりの1通目は呼ばない)",
    needsWithdrawalJudge({ crisis_state: "step1", crisis_trigger: "direct" }) && needsWithdrawalJudge({ crisis_state: "done" })
      && needsWithdrawalJudge({ crisis_state: "scaling" }) && !needsWithdrawalJudge({ crisis_state: "step1", crisis_trigger: "accumulation" })
      && !needsWithdrawalJudge({ crisis_state: "lowered" }) && !needsWithdrawalJudge({ crisis_state: "none" }));
  check("分類器の種類: 見守り中・危機の応答を始めたあとは followup", classifierModeFor({ crisis_state: "lowered" }) === "followup"
    && classifierModeFor({ crisis_state: "none" }) === "normal" && classifierModeFor({ watch_turns_left: 1 }) === "followup");
}
{
  // 2026年9月26日のペルソナテストの不具合(同じ固定の文面が毎ターン続く)が起きないこと: 出し終えたあとに打ち明けが続いても
  // 短い1通は1回だけで、あとは生成
  let state = st({ crisis_state: "done" });
  const fixedTexts = [];
  for (let i = 0; i < 9; i++) {
    const p = planSafetyTurn({ staged: S2_KEYWORD, state, text: "死にたい" });
    if (p.action === "fixed") fixedTexts.push(p.text);
    state = p.nextState;
  }
  check("出し終えたあとに打ち明けが9回続いても、固定の文面は1回だけ", fixedTexts.length === 1, String(fixedTexts.length));
}

// ============================================================================
console.log("2. 仮の文面が出力チェック(OUTPUT_NG)に引っかからない");
// ============================================================================
const ALL_TEXTS = [
  ["気づかいの一言", CARE_LINE_PROVISIONAL], ["1通目", CRISIS_STEP1_PROVISIONAL], ["ここで話せた理由の問い", CRISIS_WHY_HERE_PROVISIONAL],
  ["自由に書いた答えへの受け止め", WHY_HERE_FREE_ACK_PROVISIONAL],
  ...Object.entries(CHOICE_W_ACK_PROVISIONAL).map(([k, v]) => [`組Wへの受け止め ${k}`, v]),
  ...CHOICES_W_PROVISIONAL.map((c) => [`組W ${c.id}`, c.label]),
  ...Object.keys(CONCERN_TEXT_PROVISIONAL).flatMap((c) => buildConcernBubbles(c === "unknown" ? null : c).map((t, i) => [`2通目(${c})${i + 1}`, t])),
  ...Object.entries(CRISIS_STEP3_VARIANTS_PROVISIONAL).map(([k, t]) => [`3通目(候補${k})`, t]),
  ["3通目への答え(前向き)", CRISIS_STEP4_PROVISIONAL.yes], ["3通目への答え(後ろ向き)", CRISIS_STEP4_PROVISIONAL.no],
  ["3通目への答え(どちらでもない)", CRISIS_STEP4_PROVISIONAL.unclear],
  ...CHOICES_B_PROVISIONAL.map((c) => [`組B ${c.id}`, c.label]), ...CHOICES_C_PROVISIONAL.map((c) => [`組C ${c.id}`, c.label]),
  ["組Cの前置き", CHOICE_C_INTRO_PROVISIONAL], ...Object.entries(CHOICE_C_ACK_PROVISIONAL).map(([k, t]) => [`組Cへの受け止め ${k}`, t]),
  ["チップの下の一言", CHOICE_NOTE_PROVISIONAL],
  ["スケーリングの問い", SCALING_PROMPT_PROVISIONAL], ["スケーリングの問い(A)", SCALING_PROMPT_A_PROVISIONAL],
  ...CHOICES_SCALING_PROVISIONAL.map((c) => [`スケーリング ${c.id}`, c.label]), ["スケーリングの受け止め", SCALING_ACK_PROVISIONAL],
  ...CRISIS_ENDINGS_PROVISIONAL.map((t, i) => [`危機のあとの終わり方 ${i + 1}`, t]),
  ["2回目以降の短い1通", CRISIS_REPEAT_PROVISIONAL], ["再受け止め", CRISIS_AGAIN_PROVISIONAL],
  ...CRISIS_GENERATION_FALLBACK_PROVISIONAL.map((t, i) => [`危機の状態の生成の代わりの固定の返事${i + 1}`, t]),
  ...Object.keys(CONCERN_TEXT_PROVISIONAL).map((c) => [`本番の固定応答(${c})`, buildCrisisReply(c === "unknown" ? null : c)]),
];
for (const [name, text] of ALL_TEXTS) {
  const hits = checkOutput(text);
  check(`${name}`, hits.length === 0, hits.join(", "));
}
{
  const extraHits = (t) => CRISIS_GENERATION_EXTRA_NG.filter((re) => re.test(t)).map(String);
  // 危機の流れの固定の文面は、危機の状態の出力チェック(いつでも・番号・秘密・AIだけを頼らせる言い方)にも当たらない
  for (const [name, t] of ALL_TEXTS.filter(([n]) => !n.startsWith("本番の固定応答"))) {
    check(`危機の状態の出力チェックも通る: ${name}`, extraHits(t).length === 0, extraHits(t).join(", "));
  }
  check("どの文面にも「重い」「受け止めきれない」「これ以上は」を使わない", ALL_TEXTS.every(([, t]) => !/重い|受け止めきれ|これ以上は/.test(t)));
  check("危機のあとの終わり方は3案とも違う文", new Set(CRISIS_ENDINGS_PROVISIONAL).size === 3 && CRISIS_ENDINGS_PROVISIONAL.every((t) => /応援/.test(t)));
  check("終わり方の案は順に回る(1→2→3→1。前回が無ければ1)", nextEndingVariant(null) === 1 && nextEndingVariant(1) === 2 && nextEndingVariant(3) === 1);
  // 危機の状態の生成で通さないもの(OUTPUT_NG では通るものも含む)
  for (const t of [
    "つらいときは、いつでも話してね。", "また何かあったら、いつでもどうぞ。", "0120-000-000 に電話してみてね。", "#7119 もあるよ。",
    "ここだけの話にするね。", "秘密は守るよ。", "内緒にしておくね。", "誰にも話さないから安心してね。",
    "ずっとここにいるよ。", "わたしがいるから大丈夫だよ。", "ここにいてくれるだけでいいよ。",
  ]) check(`危機の状態の出力チェックで止める: 「${t}」`, extraHits(t).length > 0 || checkOutput(t).length > 0);
  for (const t of [
    "そう思うくらい、しんどいんだね。書いてくれてありがとう。", "いつもそばにいる家族や、学校の先生にも話してみてほしいな。",
    "画面にのせてある窓口にも、あなたの声を届けてほしいです。", "うん、ちゃんと読んでいるよ。",
  ]) check(`危機の状態の出力チェックで通す: 「${t}」`, extraHits(t).length === 0 && checkOutput(t).length === 0, [...extraHits(t), ...checkOutput(t)].join(", "));
  // 「大丈夫」の直後の「よかった」は記録だけ(段階1以上のとき)
  check("「大丈夫」の直後の「よかった」を記録する(段階1以上)", !!daijoubuYokattaNote("大丈夫", "よかった、安心したよ", 1)
    && daijoubuYokattaNote("大丈夫", "よかった", 0) === null && daijoubuYokattaNote("うん", "よかった", 2) === null
    && daijoubuYokattaNote("大丈夫", "そっか", 2) === null);
}
{
  const ok = finalizeCrisisGeneration({ out: { reply: "書いてくれてありがとう。" }, flags: [], generationFailed: false, checkFailed: false }, 0);
  check("危機の状態の生成: 出力チェックを通れば、そのまま使う", ok.out.reply === "書いてくれてありがとう。" && !ok.fallback);
  const ng = finalizeCrisisGeneration({ out: { reply: "いつでも話してね", weight: "rapport" }, flags: ["/いつでも/"], generationFailed: false, checkFailed: true }, 0);
  check("危機の状態の生成: 通らなければ固定の返事(1つ目)に置き換えて記録する",
    ng.out.reply === CRISIS_GENERATION_FALLBACK_PROVISIONAL[0] && ng.fallback && ng.flags[0].startsWith(CRISIS_FALLBACK_FLAG) && ng.out.weight === "rapport");
  const ng2 = finalizeCrisisGeneration({ out: { reply: "ごめん、いま…" }, flags: ["生成失敗→固定応答で継続(不明なエラー)"], generationFailed: true, failureCause: "不明なエラー", checkFailed: false }, 1);
  check("危機の状態の生成: 生成に失敗したら固定の返事(2回目は2つ目)", ng2.out.reply === CRISIS_GENERATION_FALLBACK_PROVISIONAL[1] && ng2.flags[0].includes("生成失敗"));
}

// ============================================================================
console.log("3. Gemini の応答を差し替えて、判定の関数を確かめる");
// ============================================================================
const queues = { classifier: [], withdrawal: [], teacher: [], generate: [] };
const seenClassifierPrompts = [];
const seenGeneratePrompts = [];
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
  const kind = sys.includes("安全判定器") ? "classifier"
    : sys.includes("withdrawal(引き下がり)") ? "withdrawal"
      : sys.includes("まわりの大人に話してみたいかをたずねました") ? "teacher"
        : sys.startsWith("あなたはAIです") ? "generate" : "other";
  if (kind === "classifier") seenClassifierPrompts.push(sys);
  if (kind === "generate") seenGeneratePrompts.push(sys);
  const next = queues[kind]?.shift();
  if (!next) throw new Error(`差し替えの応答が足りない: ${kind}`);
  if (next.status) return { ok: false, status: next.status, text: async () => "差し替えたエラー" };
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }], usageMetadata: {} }),
  };
};
const vote = (risk, subject = "self") => ({ risk, subject, reason: "差し替え" });
// 1回の判定がエラーになるまでの呼び出し(再試行1回 × モデル2つ = 4回)
const failures = () => [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

{
  // 以前の判定(第三者の段階を上げなかった頃)の risk・subject と同じになることを確かめる
  const cases = [
    { name: "両方とも第三者の危機", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("crisis", "other")], risk: "crisis", subject: "other", stage: 2 },
    { name: "第三者の危機+第三者の watch", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("watch", "other")], risk: "crisis", subject: "other", stage: 2 },
    { name: "第三者の危機+本人の watch", text: "友達のことで相談", votes: [vote("crisis", "other"), vote("watch", "self")], risk: "crisis", subject: "self", stage: 2 },
    { name: "本人の watch+none", text: "最近しんどい", votes: [vote("watch"), vote("none")], risk: "watch", subject: "self", stage: 1 },
    { name: "両方とも none", text: "部活の話", votes: [vote("none"), vote("none")], risk: "none", subject: "self", stage: 0 },
    { name: "キーワード+第三者の watch", text: "友達が死にたいって言ってる", votes: [vote("watch", "other"), vote("none", "other")], risk: "crisis", subject: "other", stage: 2 },
  ];
  for (const c of cases) {
    queues.classifier.push(...c.votes);
    const r = await classifyStaged(c.text, []);
    check(`classifyStaged: ${c.name} → risk=${c.risk}/${c.subject}・段階${c.stage}`,
      r.risk === c.risk && r.subject === c.subject && r.stage === c.stage,
      `実際: ${r.risk}/${r.subject}・段階${r.stage}・${r.decidedBy.join(",")}`);
  }
}
{
  // 通常の判定と、見守り中・危機のあとの判定で、分類器に渡すプロンプトが違う(規則・段階の決め方は同じ)
  seenClassifierPrompts.length = 0;
  queues.classifier.push(vote("watch"), vote("none"));
  const n = await classifyStaged("最近しんどい", []);
  const normalPrompts = seenClassifierPrompts.splice(0);
  check("通常の判定: 通常のプロンプトを使い、記録に followup を付けない",
    normalPrompts.length === 2 && normalPrompts.every((p) => !p.includes("新しい危機のサイン")) && n.classifierMode === "normal"
      && !n.decidedBy.includes("followup") && n.stage === 1);
  queues.classifier.push(vote("watch"), vote("none"));
  const f = await classifyStaged("最近しんどい", [], { mode: "followup" });
  const followPrompts = seenClassifierPrompts.splice(0);
  check("見守り中・危機のあとの判定: 別のプロンプトを使い、記録に followup を付ける(段階の決め方は同じ)",
    followPrompts.length === 2 && followPrompts.every((p) => p.includes("新しい危機のサイン")) && f.classifierMode === "followup"
      && f.decidedBy[0] === "followup" && f.stage === 1 && f.decidedBy.includes("classifier_watch"));
  queues.classifier.push(vote("none"), vote("none"));
  const fk = await classifyStaged("やっぱり死にたい", [], { mode: "followup" });
  seenClassifierPrompts.length = 0;
  check("見守り中・危機のあとの判定でも、キーワードの強制判定は外さない", fk.stage === 2 && fk.decidedBy.includes("keyword"));
}
{
  queues.withdrawal.push({ reply_type: "withdrawal", figurative: false, reason: "a" });
  const w1 = await judgeWithdrawal("なんでもない", []);
  check("返事の種類の判定: 1回の判定で決める(引き下がり = 否定C)", w1.type === "withdrawal" && w1.withdrawal === true && w1.figurative === false && queues.withdrawal.length === 0);
  queues.withdrawal.push({ reply_type: "withdrawal", figurative: true, reason: "a" });
  const wf = await judgeWithdrawal("テストやばすぎて死にたいって意味", []);
  check("返事の種類の判定: 比喩・強調の判定を返す", wf.figurative === true);
  queues.withdrawal.push({ reply_type: "resignation", figurative: false, reason: "a" });
  const w2 = await judgeWithdrawal("もういい、どうせ", []);
  check("返事の種類の判定: 諦めは引き下がりではない", w2.type === "resignation" && w2.withdrawal === false);
  queues.withdrawal.push(...failures());
  const w3 = await quiet(() => judgeWithdrawal("なんでもない", []));
  check("返事の種類の判定: エラー → 判定なし(否定として扱わない・比喩としない = 通知する側)", w3.type === null && w3.withdrawal === false && w3.figurative === false && !!w3.error);
  queues.withdrawal.push({ reply_type: "maybe", figurative: false, reason: "a" }, { reply_type: "maybe", figurative: false, reason: "b" });
  const w4 = await quiet(() => judgeWithdrawal("うーん", []));
  check("返事の種類の判定: 想定外の値 → 判定なし", w4.type === null && w4.withdrawal === false);
  queues.teacher.push({ answer: "yes", reason: "a" });
  check("相談先や大人に話したいかの答え: 前向き", (await judgeTeacherAnswer("話してみようかな", [])).answer === "yes");
  queues.teacher.push(...failures());
  check("相談先や大人に話したいかの答え: エラー → どちらでもない", (await quiet(() => judgeTeacherAnswer("うーん", []))).answer === "unclear");
}
{
  const step1 = { ...fresh, crisis_state: "step1", crisis_trigger: "direct" };
  const ctx = [{ role: "user", text: "もう全部終わらせたい" }, { role: "ai", text: CRISIS_STEP1_PROVISIONAL }];
  queues.classifier.push(vote("watch"), vote("none"));
  queues.withdrawal.push({ reply_type: "withdrawal", figurative: false, reason: "a" });
  const a = await assessSafetyTurn("いや冗談冗談、本気にしないで", ctx, step1);
  check("assessSafetyTurn: 1通目のあとの「冗談」→ スケーリングのチップ(否定B)",
    a.plan.choices?.set === "scaling" && a.plan.nextState.crisis_negation === "B" && a.withdrawal?.type === "withdrawal");
  queues.classifier.push(vote("none"), vote("none"));
  queues.withdrawal.push({ reply_type: "withdrawal", figurative: false, reason: "a" });
  const b = await assessSafetyTurn("死にたいとか冗談だよ", ctx, step1);
  check("assessSafetyTurn: 「死にたいとか冗談だよ」(分類器は危機と判定しない)→ スケーリング・通知", b.plan.choices?.set === "scaling" && b.plan.notify);
  queues.classifier.push(vote("crisis"), vote("crisis"));
  queues.withdrawal.push({ reply_type: "withdrawal", figurative: false, reason: "a" });
  const bc = await assessSafetyTurn("忘れて。もう薬ためてるし", ctx, step1);
  check("assessSafetyTurn: 引き下がりの中に分類器の危機判定 → 新しいサインを優先して2通目・3通目・通知", bc.plan.bubbles?.[0].crisisStep === 2 && bc.plan.notify);
  queues.classifier.push(vote("none"), vote("none"));
  const acc = await assessSafetyTurn("なんでもない", ctx, { ...step1, crisis_trigger: "accumulation" });
  check("assessSafetyTurn: 積み重なりの1通目への返事では、補助判定を呼ばない(今どおり止める)",
    acc.withdrawal === null && acc.plan.decidedBy.includes("accumulation_pause"));
  queues.classifier.push(vote("none"), vote("none"));
  queues.withdrawal.push({ reply_type: "other", figurative: false, reason: "a" });
  queues.teacher.push({ answer: "no", reason: "a" });
  const t3 = await assessSafetyTurn("言いたくない", ctx, { ...step1, crisis_state: "step3" });
  check("assessSafetyTurn: 3通目への後ろ向きの答え → 受け止め+組B のチップ",
    t3.plan.choices?.set === "B" && t3.plan.bubbles[0].text === CRISIS_STEP4_PROVISIONAL.no && t3.teacher?.answer === "no");
  // チップを押したターンは分類器にかけない
  seenClassifierPrompts.length = 0;
  const ch = await assessSafetyTurn(CHOICES_B_PROVISIONAL[1].label, ctx, t3.plan.nextState, "B2");
  check("assessSafetyTurn: チップを押したターンは分類器・補助判定にかけない(組C へ)", seenClassifierPrompts.length === 0 && ch.plan.choices?.set === "C"
    && ch.choice?.id === "B2" && ch.staged.decidedBy.includes("choice"));
  queues.classifier.push(vote("none"), vote("none"));
  queues.withdrawal.push({ reply_type: "other", figurative: false, reason: "a" });
  const wrong = await assessSafetyTurn("C1", ctx, t3.plan.nextState, "C1");
  check("assessSafetyTurn: 直前に付けていない組の choice_id は、自由に書いた発言として扱う", wrong.choice === null && wrong.plan.action === "generate");
  queues.classifier.push(vote("none"), vote("none"));
  seenClassifierPrompts.length = 0;
  const c = await assessSafetyTurn("部活の話なんだけど", [], fresh);
  check("assessSafetyTurn: 危機の応答の途中でなければ補助判定を呼ばない", c.withdrawal === null && c.teacher === null && c.plan.stage === 0);
  check("assessSafetyTurn: ふつうの状態では通常の分類器", seenClassifierPrompts.splice(0).every((p) => !p.includes("新しい危機のサイン")) && c.staged.classifierMode === "normal");
  queues.classifier.push(vote("none"), vote("none"));
  const w = await assessSafetyTurn("別に", [], { ...fresh, watch_turns_left: 2, care_shown: true });
  check("assessSafetyTurn: 見守り中は見守り中・危機のあと用の分類器", seenClassifierPrompts.splice(0).every((p) => p.includes("新しい危機のサイン"))
    && w.staged.classifierMode === "followup" && w.plan.stage === 0 && w.plan.nextState.watch_turns_left === 1);
  queues.classifier.push(vote("none"), vote("none"));
  queues.withdrawal.push({ reply_type: "other", figurative: false, reason: "a" });
  const d = await assessSafetyTurn("うん", ctx, step1);
  check("assessSafetyTurn: 危機の応答の途中も見守り中・危機のあと用の分類器", seenClassifierPrompts.splice(0).every((p) => p.includes("新しい危機のサイン"))
    && d.staged.classifierMode === "followup" && d.plan.bubbles?.[0].crisisStep === 2 && !d.plan.notify);
  check("(差し替えの応答が余っていない)", queues.classifier.length === 0 && queues.withdrawal.length === 0 && queues.teacher.length === 0,
    JSON.stringify({ c: queues.classifier.length, w: queues.withdrawal.length, t: queues.teacher.length }));
}
{
  // 危機の状態の生成: 出力チェックを強めて再生成し、それでも通らなければ checkFailed を返す
  const reply = (text) => ({ reply: text, used: [], why: "差し替え" });
  const opts = { extraNg: CRISIS_GENERATION_EXTRA_NG, fixHint: CRISIS_GENERATION_FIX_HINT };
  seenGeneratePrompts.length = 0;
  queues.generate.push(reply("いつでも話してね。"), reply("書いてくれてありがとう。ちゃんと読んでいるよ。"));
  const g1 = await generateReply("あなたはAIです。(差し替え)", [], ["m"], 100, 0, 0, opts);
  check("危機の状態の生成: 「いつでも」→ 再生成で解消", g1.out.reply.startsWith("書いてくれて") && !g1.checkFailed && eq(g1.flags, ["1回目に検知→再生成で解消"]));
  check("危機の状態の生成: 書き直しの指示に、危機のターンの一言を足す", seenGeneratePrompts.splice(0)[1]?.includes(CRISIS_GENERATION_FIX_HINT));
  queues.generate.push(reply("ずっとここにいるよ。"), reply("わたしがいるから大丈夫だよ。"));
  const g2 = await generateReply("あなたはAIです。(差し替え)", [], ["m"], 100, 0, 0, opts);
  const fin = finalizeCrisisGeneration(g2, 0);
  check("危機の状態の生成: 再生成しても通らない → checkFailed → 固定の返事に置き換え",
    g2.checkFailed && fin.fallback && fin.out.reply === CRISIS_GENERATION_FALLBACK_PROVISIONAL[0]);
  queues.generate.push(reply("また何かあったら、いつでもどうぞ。"));
  const g3 = await generateReply("あなたはAIです。(差し替え)", [], ["m"], 100, 0, 0);
  check("通常の生成(強めた出力チェックなし)は今まで通り「いつでもどうぞ」を通す", !g3.checkFailed && g3.flags.length === 0);
  seenGeneratePrompts.length = 0;
  check("(差し替えの生成の応答が余っていない)", queues.generate.length === 0, String(queues.generate.length));
}

// ============================================================================
console.log("4. buildSystem / retrieve の文脈の配列化と、危機の応答のあとのインテークの停止");
// ============================================================================
{
  const rows = [
    { id: "P1", src: "嶋石", cat: "principle", body: "原則", tags: [], weight: "any" },
    { id: "N1", src: "設", cat: "ng", lv: 3, body: "禁止", tags: [], weight: "any" },
    { id: "T31", src: "嶋", cat: "limit", body: "深掘りしない", tags: [], weight: "any" },
    { id: "T32", src: "嶋", cat: "limit", body: "突然切らない", tags: [], weight: "any" },
    { id: "D3", src: "設", cat: "limit", body: "二択で確認しない", tags: [], weight: "any" },
    { id: "D5", src: "設", cat: "resp", body: "第三者", tags: [], weight: "any" },
    { id: "D1", src: "設", cat: "limit", body: "リスクアセスメントをしない理由", tags: [], weight: "any" },
    { id: "D2", src: "設", cat: "limit", body: "取り入れるのは態度", tags: [], weight: "any" },
  ];
  const intake = { phase: "intake", closing_state: "none", recommended_mode: [] };
  const sysIntake = buildSystem(rows, [], "rapport", {}, 0, null, "tierB", intake);
  check("インテーク中(Tier B のみ)→ インテークの台本のまま", sysIntake.includes("# 現在のフェーズ:インテーク") && sysIntake.includes("曖昧な危機のサイン"));
  const sysAfter = buildSystem(rows, [], "rapport", {}, 0, null, ["tierB", "afterCrisis"], intake);
  check("インテーク中でも危機の応答のあと → 台本を止めて自由な進め方",
    !sysAfter.includes("# 現在のフェーズ:インテーク") && sysAfter.includes("# 進め方")
      && sysAfter.includes("曖昧な危機のサイン") && sysAfter.includes("危機の応答のあと"));
  const sysTier = buildSystem(rows, [], "rapport", {}, 0, null, ["tierB", "afterCrisis"], { phase: "phase2", closing_state: "none", recommended_mode: [] });
  check("Tier B の指示と危機のあとの指示を両方入れる", sysTier.includes("曖昧な危機のサイン") && sysTier.includes("危機の応答のあと"));
  check("仮であることはプロンプトに書かない", !/仮の(文面|指示)|心理士の確認待ち/.test(sysTier + sysAfter));
  check("以前の打ち消しの指示はもう使わない(文脈に入れても何も足さない)",
    buildSystem(rows, [], "rapport", {}, 0, null, ["retraction"], { phase: "phase2", closing_state: "none", recommended_mode: [] })
      === buildSystem(rows, [], "rapport", {}, 0, null, [], { phase: "phase2", closing_state: "none", recommended_mode: [] }));
  const ids = (ctx) => retrieve(rows, "こんにちは", "rapport", "visitor", undefined, ctx, []).map((k) => k.id);
  check("retrieve: 文脈1つ(文字列)は今まで通り", ids("thirdParty").includes("D5"));
  check("retrieve: 文脈の配列から知識を合わせて引く(Tier B と危機のあと)", ["T31", "T32", "D3"].every((id) => ids(["tierB", "afterCrisis"]).includes(id)));
  check("retrieve: 危機の状態の生成では D1・D2 も引く", ["D1", "D2", "T31", "T32", "D3"].every((id) => ids(["crisisGeneration", "afterCrisis"]).includes(id)));
  const sysGen = buildSystem(rows, [], "rapport", {}, 0, null, ["crisisGeneration", "afterCrisis"], intake);
  check("危機の状態の生成: 危機のサインの指示と危機のあとの指示を入れ、インテークの台本は止める",
    sysGen.includes("重要・危機のサイン") && sysGen.includes("危機の応答のあと") && !sysGen.includes("# 現在のフェーズ:インテーク")
      && !/仮の(文面|指示)|心理士の確認待ち/.test(sysGen));
}

// ============================================================================
console.log("5. 本番の既定(段階ごとの応答が無効)でも、固定応答を出したあとは危機のあとの指示を付ける(CLAUDE.md 5.17)");
// ============================================================================
{
  check("固定応答を出したかは、AI の発言の crisis で決める",
    hadCrisisReply([{ role: "user", crisis: false }, { role: "ai", crisis: true }])
      && !hadCrisisReply([{ role: "user", crisis: true }, { role: "ai", crisis: false }]) && !hadCrisisReply([]) && !hadCrisisReply(null));
  check("文脈: 固定応答の前は今まで通り(段階0は何も付けない・watch は Tier B・第三者は第三者)",
    eq(defaultSafetyContexts({ risk: "none", subject: "self", afterCrisis: false }), [])
      && eq(defaultSafetyContexts({ risk: "watch", subject: "self", afterCrisis: false }), ["tierB"])
      && eq(defaultSafetyContexts({ risk: "crisis", subject: "other", afterCrisis: false }), ["thirdParty"]));
  check("文脈: 固定応答のあとは、どのターンにも危機のあとの指示を足す(「なんでもない」でもふつうの会話に戻らない)",
    eq(defaultSafetyContexts({ risk: "none", subject: "self", afterCrisis: true }), ["afterCrisis"])
      && eq(defaultSafetyContexts({ risk: "watch", subject: "self", afterCrisis: true }), ["tierB", "afterCrisis"])
      && eq(defaultSafetyContexts({ risk: "crisis", subject: "other", afterCrisis: true }), ["thirdParty", "afterCrisis"]));
  const saved = process.env.CRISIS_AFTERCARE;
  delete process.env.CRISIS_AFTERCARE;
  const onByDefault = aftercareEnabled();
  process.env.CRISIS_AFTERCARE = "off";
  const offWhenSet = !aftercareEnabled();
  if (saved === undefined) delete process.env.CRISIS_AFTERCARE; else process.env.CRISIS_AFTERCARE = saved;
  check("設定: 既定は有効、CRISIS_AFTERCARE=off のときだけ以前の動き", onByDefault && offWhenSet);
  const rows = [
    { id: "P1", src: "嶋石", cat: "principle", body: "原則", tags: [], weight: "any" },
    { id: "T31", src: "嶋", cat: "limit", body: "深掘りしない", tags: [], weight: "any" },
    { id: "T32", src: "嶋", cat: "limit", body: "突然切らない", tags: [], weight: "any" },
    { id: "D3", src: "設", cat: "limit", body: "二択で確認しない", tags: [], weight: "any" },
  ];
  const intake = { phase: "intake", closing_state: "none", recommended_mode: [] };
  const before = buildSystem(rows, [], "rapport", {}, 0, null, defaultSafetyContexts({ risk: "none", subject: "self", afterCrisis: false }), intake);
  const after = buildSystem(rows, [], "rapport", {}, 0, null, defaultSafetyContexts({ risk: "none", subject: "self", afterCrisis: true }), intake);
  check("固定応答の前の生成は、今までと同じプロンプト(文脈なし = null と同じ)",
    before === buildSystem(rows, [], "rapport", {}, 0, null, null, intake));
  check("固定応答のあとの生成: 危機のあとの指示(深掘りしない・秘密を約束しない・人につながる道を閉じない)を入れ、インテークの台本は止める",
    after.includes("危機の応答のあと") && after.includes("深掘りしない") && after.includes("秘密にする") && after.includes("人につながる道は閉じない")
      && !after.includes("# 現在のフェーズ:インテーク"));
  const ids = retrieve(rows, "なんでもない", "rapport", "visitor", undefined, defaultSafetyContexts({ risk: "none", afterCrisis: true }), []).map((k) => k.id);
  // インテーク中に固定応答を出したあと: 自由な進め方(クロージングのルールつき)で生成するので、クロージングも記録する(2026年10月6日)
  const afterCtx = defaultSafetyContexts({ risk: "none", subject: "self", afterCrisis: true });
  check("インテーク中でも危機のあとは、生成の進め方が phase2(台本を止める)", flowPhaseFor(intake, afterCtx) === "phase2" && flowPhaseFor(intake, []) === "intake");
  check("インテーク中で危機のあとのターンの「区切る」(closing_event = close)を記録する",
    eq(applyClosingUpdate(intake, { closing_event: "close" }, flowPhaseFor(intake, afterCtx)), { closing_state: "closed" })
      && eq(applyClosingUpdate(intake, { closing_event: "close" }), {}));
  // 危機のあとのセッションでは、クロージングの一言からも「いつでも」を外す(危機のあとの指示とぶつからないように)
  const phase2 = { phase: "phase2", closing_state: "none", recommended_mode: [] };
  const closingAfter = buildSystem(rows, [], "rapport", {}, 0, null, afterCtx, phase2);
  const closingNormal = buildSystem(rows, [], "rapport", {}, 0, null, [], phase2);
  // (指示の文面そのものは「『いつでも』という言い方はしない」と書くので、勧める一言の側だけを見る)
  check("危機のあとのクロージングの一言に「いつでも」を入れない(ふだんのクロージングは今まで通り)",
    closingAfter.includes("「しんどくなったら、こういうところに頼っていいよ」") && !closingAfter.includes("しんどくなったら、いつでも")
      && closingNormal.includes("しんどくなったら、いつでも"));
  check("固定応答のあとの生成: 深掘りしない等の知識(T31・T32・D3)を必ず引く", ["T31", "T32", "D3"].every((id) => ids.includes(id)), ids.join(","));
}

// ============================================================================
console.log("6. 危機の流れの見直し(嶋先生 10/7)の指示・本番の固定応答");
// ============================================================================
{
  const rows = [{ id: "P1", src: "嶋石", cat: "principle", body: "原則", tags: [], weight: "any" }];
  const phase2 = { phase: "phase2", closing_state: "none", recommended_mode: ["CBT"] };
  const b1 = buildSystem(rows, [], "rapport", {}, 0, null, ["choiceB1", "afterCrisis"], phase2);
  check("組B1 のあと: 深追いしない・理由を聞かない指示", b1.includes("うっとうしい") && b1.includes("深追いしない"));
  const cSol = buildSystem(rows, [], "rapport", {}, 0, null, ["afterCrisis", "choiceC"], { ...phase2, crisis_choice_c: "C4" });
  const cEmp = buildSystem(rows, [], "rapport", {}, 0, null, ["afterCrisis", "choiceC"], { ...phase2, recommended_mode: ["LISTEN_ONLY"], crisis_choice_c: "C4" });
  const cPre = buildSystem(rows, [], "rapport", {}, 0, null, ["afterCrisis", "choiceC"], { ...phase2, recommended_mode: [], crisis_choice_c: "C4" });
  check("組C のあと: 選んだもの+解決を求める人には小さな一歩(LISTEN_ONLY 以外)", cSol.includes("どう思われるかわからない") && cSol.includes("解決を求める"));
  check("組C のあと: 共感を求める人(LISTEN_ONLY)には寄り添いを優先", cEmp.includes("共感を求める") && !cEmp.includes("解決を求める"));
  check("組C のあと: インテーク前は共感の側(急がない)", cPre.includes("共感を求める") && intakeStyleOf({}) === "empathy" && intakeStyleOf({ recommended_mode: ["SFBT"] }) === "solution");
  check("組C を選んでいなければ組Cの指示は空", choiceCBlock(null, "empathy") === "" && CHOICE_B1_BLOCK_PROVISIONAL.length > 0);
  const tierB = buildSystem(rows, [], "rapport", {}, 0, null, ["tierB"], phase2);
  const after = buildSystem(rows, [], "rapport", {}, 0, null, ["afterCrisis"], phase2);
  check("「大丈夫」を「よかった」で受けない・掘り下げない指示が、Tier B と危機のあとの指示に入る(本番の既定でも)",
    tierB.includes("「大丈夫」と書いても、文字どおりに受け取らない") && after.includes("「大丈夫」と書いても、文字どおりに受け取らない"));
  check("危機のあとの指示: AIの限界・負担を理由に区切らない", after.includes("あなたの側から会話を終わらせない") && after.includes("ここでは扱えない"));
  const endCrisis = buildSystem(rows, [], "rapport", {}, 0, null, ["afterCrisis", "crisisEnding"], phase2);
  const endS1 = buildSystem(rows, [], "rapport", {}, 0, null, ["tierB", "stage1Ending"], phase2);
  check("終わり方(危機のあと・段階ごとの応答): 締めの挨拶は書かせない(決まった文面を足す)", endCrisis.includes("決まった締めの文面"));
  check("終わり方(段階1・段階ごとの応答): 労い+「またここに来てね」+窓口の場所", endS1.includes("またここに来てね") && endS1.includes("窓口の場所"));
  check("終わり方(段階0): 今まで通り「いつでも」の趣旨", buildSystem(rows, [], "rapport", {}, 0, null, [], phase2).includes("しんどくなったら、いつでも"));
  check("仮であることはプロンプトに書かない", !/仮の(文面|指示)|心理士の確認待ち/.test(b1 + cSol + tierB + after + endCrisis + endS1));
}
{
  check("本番の固定応答に「重い」を使わない", !/重い/.test(CRISIS_REPLY) && Object.keys(CONCERN_TEXT_PROVISIONAL).every((c) => !/重い/.test(buildCrisisReply(c))));
  check("本番の固定応答: 種類ごとに「〜が、とても心配です」を組む(暴力・性被害・いじめは「そのこと」)",
    buildCrisisReply("suicidal").includes(`${CONCERN_TEXT_PROVISIONAL.suicidal}が、とても心配です。あなたのために、その気持ちを`)
      && buildCrisisReply("sexual").includes("あなたのために、そのことを") && CRISIS_REPLY.includes("書いてくれたつらさが、とても心配です"));
}

{
  // インテークで、つらさの数字を答えたくない・わからないとき(2026年10月11日・やり残しの一覧 2-7)
  const rows = [{ id: "P1", src: "嶋石", cat: "principle", body: "原則", tags: [], weight: "any" }];
  const base = { phase: "intake", chief_complaint_category: 2, onset_context: "春から", distress_level: null, user_goal: null, recommended_mode: null };
  const declineOut = { intake: { distress_declined: true, distress_level: null } };
  check("インテーク: 数字を答えないと示したターンは印(記録のみ)を残す", distressDeclinedNote(base, declineOut) === DISTRESS_DECLINED_FLAG);
  check("インテーク: 数字を答えたターンは印を残さない", distressDeclinedNote(base, { intake: { distress_declined: true, distress_level: 3 } }) === null);
  check("インテーク: すでに印があれば二度残さない", distressDeclinedNote({ ...base, distress_declined: true }, declineOut) === null);
  check("インテーク: 数字を答えないだけでは、まだ phase2 に進まない(ゴール・モードが無い)", applyIntakeUpdate(base, declineOut).phase === undefined);
  const goalOut = { intake: { user_goal: "少し楽になりたい", recommended_mode: ["LISTEN_ONLY"] } };
  check("インテーク: 前のターンで数字を答えないと示していれば、ゴールとモードがそろって phase2 に進む",
    applyIntakeUpdate({ ...base, distress_declined: true }, goalOut).phase === "phase2");
  check("インテーク: 数字も答えない印も無ければ、今どおり phase2 に進まない", applyIntakeUpdate(base, goalOut).phase === undefined);
  check("インテーク: distress_declined は sessions に書かない(列が無い)", !("distress_declined" in applyIntakeUpdate(base, declineOut)));
  const sys = buildSystem(rows, [], "rapport", {}, 0, null, [], { ...base, distress_declined: true });
  check("インテーク: 印があれば、プロンプトに「数字では答えない(もう聞かない)」と書く", sys.includes("数字では答えない(もう聞かない)"));
  check("インテーク: 答えたくないときは同じ質問をくり返さない指示がある", buildSystem(rows, [], "rapport", {}, 0, null, [], base).includes("同じ質問をくり返さない"));
}

console.log(`\n${failed === 0 ? "全件通過" : `失敗 ${failed}件`}(${passed + failed}件中)`);
process.exit(failed === 0 ? 0 : 1);
