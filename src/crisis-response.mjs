// ============================================================================
//  危機検知の作り直し 第2段階: 段階ごとの応答(2026年9月)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ 【仮】このファイルの文面・指示は、すべて仮のもの(心理士の確認待ち)。        │
//  │  名前の末尾が _PROVISIONAL の定数が仮の文面・指示。                          │
//  │  設定 CRISIS_RESPONSE=staged のときだけ使う(既定は無効)。心理士の確認が取れる │
//  │  まで、本番(main)では有効にしないこと。                                      │
//  └──────────────────────────────────────────────────────────────┘
//
//  無効のときは第1段階と同じ動き(段階2 = 今の固定応答 CRISIS_REPLY、段階1 = 今の Tier B)のまま。
//  有効にする前に db/schema.sql の11節(状態と記録の列)を Supabase で実行しておくこと。
//
//  このファイルに置くもの
//   ・仮の文面・仮の指示(_PROVISIONAL)
//   ・1ターンの扱いを決める planSafetyTurn(状態の移り変わり。副作用なし)
//   ・打ち消しの判定 judgeRetraction / 先生についての答えの判定 judgeTeacherAnswer(軽いモデル)
//   ・それらをまとめて呼ぶ assessSafetyTurn(src/app/api/chat/route.ts と
//     scripts/test-persona-regression.mjs が同じものを使う)
//
//  仕組み(設計は2026年9月26日に人が確認済み。CLAUDE.md 5.16)
//   段階1(気がかり)… 生成で会話を続ける(今の Tier B の指示つき)。見守りを始めるターンだけ、
//                     返事の下に「気づかいの一言+折りたたみの窓口」のカードを添える(一言は1セッション1回まで)。
//                     以後3ターンは見守り。見守り中に本人の言葉によるサイン(分類器の watch、
//                     慣用表現に包まれたキーワード)がもう一度出たら段階2に上げる。
//                     分類器のエラーは本人のサインではないので、上げる理由にしない。
//   段階2(危機)  … 生成せず、固定の文面を分けて出す(CLAUDE.md 5.2 の「危機の場面でAIに言葉を選ばせない」を保つ)。
//                     1通目 受け止めだけ(+折りたたみの窓口)→ 2通目 重い内容だという正直な表明・窓口の案内
//                     (危機カード)・人に話しにくい理由の問い → 3通目 先生に話すことをどう思うか →
//                     4通目 答えに合わせた一言。そのあとは生成に戻す(危機のあとの指示つき)。
//                     見守り中の再サインで上がった段階2(積み重なり)は、1通目への返事が段階0なら
//                     2通目に進まず見守りに戻す。
//   打ち消し      … 危機の応答の途中(1〜3通目のあと)に「冗談だよ」等と打ち消したら
//                     (2回並行の判定が2回とも打ち消し)、段階1(見守り)にして残りの文面は出さない。
//                     ただし発言にキーワード・受動パターンが入っていれば、キーワードの強制判定を優先する。
//   打ち消しのあとの再サイン … 見守り中の再サイン、または分類器だけの危機の判定で、もう一度段階2に上がるときは、
//                     重い続きの文面からではなく、受け止めだけの短い1通(再受け止め)から始める(1回の会話で1回まで)。
//                     次の返事にもサインがあるときだけ続きの文面に進む。キーワード・受動パターンなら続きの文面へ。
//   危機の応答のあと … 4通目まで出したあとは見守らない(見守り中のサインで段階2に上げない)。本人の言葉による
//                     はっきりした危機(段階2)のときだけ、短い受け止めと危機カードの1通を出す。
//                     (2026年9月26日の検証で、見守りを続けたために「もう無理」系の発言のたびに同じ1通が
//                     9回続いた不具合があったため。打ち消しのあとの再サインも、重い2通目にいきなり進んで
//                     「だるい」程度の発言に窓口の案内が出たため、上の再受け止めを足した)
//   クロージング  … AIが「続けるか、今日はここまでにするか」を選んでもらっている状態(closing_state =
//                     awaiting_choice)で、段階2の理由がキーワード「終わりにしたい」だけなら段階1にとどめる。
// ============================================================================

import {
  callGemini, parseJSON, LITE_MODELS, buildClassifierInput, classifyStaged, crisisDetectionVersion,
} from "./classify.mjs";

// 設定 CRISIS_RESPONSE=staged のときだけ有効。段階は危機検知 v2 にしかないので、v1 のときは無効。
export function stagedResponseEnabled() {
  return process.env.CRISIS_RESPONSE === "staged" && crisisDetectionVersion() === "v2";
}

// 見守りを続けるターン数(相談者の発言の数)
export const WATCH_TURNS = 3;

// ----------------------------------------------------------------------------
// 【仮の文面】心理士の確認待ち。変えるときは docs/crisis-stage2-provisional-texts.md も
// 作り直すこと(node scripts/export-provisional-texts.mjs)。
// ----------------------------------------------------------------------------

// 段階1: 気づかいの一言(2026年9月26日、3案のうち案Aを選んだ)
export const CARE_LINE_PROVISIONAL =
  "少し気になったので、ひとことだけ。しんどさが続くときは、ひとりで抱えこまなくていいからね。";

// 段階2の1通目: 受け止めだけ。Tier A には暴力・性被害の打ち明けも含まれるので、
// どの打ち明けにも合う言い方にしている(「そう思うくらい、しんどいんだね」は希死念慮にしか合わない)。
export const CRISIS_STEP1_PROVISIONAL = "よく、ここで言えたね。話してくれてありがとう。";

// 2通目: 重い内容だという正直な表明・窓口の案内(危機カードを添える)・人に話しにくい理由の問い(T31)。
// 「話すのをやめてほしいわけではない」は、突然切ると見捨てられた感じを与えるという指摘(T32)への配慮。
export const CRISIS_STEP2_PROVISIONAL =
  "いま書いてくれたことは、とても大事なことだと思う。正直に言うと、わたしだけで受け止めるには重いことなので、" +
  "あなたの声が届く人にもつながってほしいです。ここで話すのをやめてほしいわけではないよ。" +
  "下に、名前を言わなくても話せる窓口をのせておくね。\n\n" +
  "それと、よかったら教えてほしいな。身近な人に話すとしたら、どんなところが話しにくい？";

// 3通目: 先生に話すことをどう思うか。今の仕組みは匿名で、AIから先生に伝える手段が無い
// (「先生に伝えておくね」はナレッジ D7 が禁じる、実行できない約束になる)ので、
// 同意を取るのではなく、本人が先生に話すことをどう思うかをたずねる(2026年9月26日確認)。
export const CRISIS_STEP3_PROVISIONAL =
  "教えてくれてありがとう。もうひとつだけ聞かせてね。今日のことを、学校の先生" +
  "（保健室の先生やスクールカウンセラーの先生）に話してみるとしたら、どう思う？";

// 4通目: 3通目への答えに合わせた一言。後ろ向きのときは D4 の言い回しで一度引く。
export const CRISIS_STEP4_PROVISIONAL = {
  yes: "そう思えたんだね。先生に話すときは、この画面を見せるだけでも伝わるよ。ここでの話も、続けたければ続けようね。",
  no: "そっか、今はまだ話したくないんだね。わかったよ。無理に、とは言わないね。",
  unclear: "うん、すぐに決めなくて大丈夫だよ。話してみようと思えたときは、この画面を先生に見せるだけでも伝わるからね。",
};

// 打ち消しのあとの見守り中に、もう一度サインが出たときの受け止めだけの短い1通(再受け止め)。
// 1通目と同じ文面を2回出さないための別の言い方。見守り中のサインは気持ちの表現(watch 相当)が多いので、
// 気持ちを受け止める言い方にしている。
export const CRISIS_AGAIN_PROVISIONAL = "そう感じているんだね。書いてくれてありがとう。";

// 同じ会話で2回目以降の段階2(危機カードを添える)。1通目から繰り返さないための短い1通。
export const CRISIS_REPEAT_PROVISIONAL =
  "また書いてくれてありがとう。ひとりで抱えなくていいからね。下の窓口や、学校の先生にも、あなたの声を届けてほしいです。";

// ----------------------------------------------------------------------------
// 【仮の指示】生成のときに src/generate.mjs の buildSystem が足す指示(心理士の確認待ち)。
// モデルが「仮」という言葉を生徒に出さないよう、仮であることはプロンプトの中には書かない。
// ----------------------------------------------------------------------------
export const RETRACTION_BLOCK_PROVISIONAL = `

# 今回のターンについて(重要・打ち消し)
少し前に相談者が深刻なことを書き、あらかじめ決めた文面で受け止めました。今回の発言で、相談者はそれを
「冗談」「大げさに言っただけ」などと打ち消しています。
・打ち消しを否定したり、本当かどうかを問い詰めたりしない
・深刻なことを書いたこと自体を責めたり、茶化したりしない
・「冗談だったとしても、しんどいときは話していい場所だよ」という趣旨を、押しつけずに一度だけ短く伝えてよい
  (「いつでも」「いくらでも」という言い方はしない)
・窓口の案内をくり返さない(窓口は画面に表示したままになっている)
・この先の対応を約束しない(「もう窓口の話はしない」「誰にも言わない」など)
・そのあとは、本人が話したいことに沿って、ふだんの会話に戻る`;

export const AFTER_CRISIS_BLOCK_PROVISIONAL = `

# このセッションについて(重要・危機の応答のあと)
このセッションでは少し前に、相談者の発言に深刻なサインがあり、あらかじめ決めた文面で受け止めました
(そのあと、話せる窓口の案内や、学校の先生に話すことについての問いかけをした場合もあります)。
・危機の内容そのもの(なぜそう思うのか、方法・時期・場所など)を深掘りしない
・窓口の案内をくり返さない(窓口は画面に表示してある)
・この先の対応を約束しない(「もう窓口の話はしない」「誰にも言わない」「秘密にする」など)
・人に話すこと(先生・保健室・窓口など)を「しなくていい」「面倒なものだ」と同調しない。
  話しにくい気持ちは受け止めつつ、人につながる道は閉じない
・インテークの質問(相談の種類・つらさの点数など)は続けない
・本人が話したいことに沿って、ゆっくり会話を続ける。本人が話題を変えたら、それに合わせてよい`;

// ----------------------------------------------------------------------------
// セッションの状態(db/schema.sql 11節の sessions の列)
//   watch_turns_left 見守りの残りターン(0 = 見守っていない)
//   crisis_state     none / step1〜3(その文面を出して返事を待っている)/ done(4通目まで出した)/
//                    paused1〜3(その文面のあと、打ち消し等で止めた)/
//                    again1〜3(paused のあとの再サインで、再受け止めの1通を出して返事を待っている)
//   crisis_trigger   いまの危機の応答のきっかけ: direct(キーワード・受動パターン・分類器の危機)/
//                    accumulation(見守り中の再サイン)
//   care_shown       気づかいの一言をこのセッションで出したか
//   reentry_used     再受け止めをこのセッションで出したか(1回まで)
// ----------------------------------------------------------------------------
export const SAFETY_STATE_COLUMNS = "watch_turns_left,crisis_state,crisis_trigger,care_shown,reentry_used";
const CRISIS_STATES = ["none", "step1", "step2", "step3", "done", "paused1", "paused2", "paused3", "again1", "again2", "again3"];
const FLOW_STEP = { step1: 1, step2: 2, step3: 3 };
const PAUSED_STEP = { paused1: 1, paused2: 2, paused3: 3 };
const AGAIN_STEP = { again1: 1, again2: 2, again3: 3 };

export function normalizeSafetyState(state) {
  const w = state?.watch_turns_left;
  return {
    watch_turns_left: Number.isInteger(w) && w > 0 ? w : 0,
    crisis_state: CRISIS_STATES.includes(state?.crisis_state) ? state.crisis_state : "none",
    crisis_trigger: ["direct", "accumulation"].includes(state?.crisis_trigger) ? state.crisis_trigger : null,
    care_shown: state?.care_shown === true,
    reentry_used: state?.reentry_used === true,
    closing_state: typeof state?.closing_state === "string" ? state.closing_state : "none",
  };
}

// 危機の応答の途中(1〜3通目・再受け止めを出して返事を待っている)か。打ち消しの判定はこのときだけ行う
export function isInCrisisFlow(state) {
  const st = normalizeSafetyState(state).crisis_state;
  return FLOW_STEP[st] != null || AGAIN_STEP[st] != null;
}

const riskOf = (stage) => (stage === 2 ? "crisis" : stage === 1 ? "watch" : "none");

// ----------------------------------------------------------------------------
// 1ターンの扱いを決める(副作用なし。scripts/test-staged-response.mjs でオフラインに確かめている)
//
// 引数
//   staged        classifyStaged() の戻り値(stage / subject / decidedBy / keywords / patterns)
//   state         セッションの状態(上の列 + closing_state)
//   retraction    judgeRetraction() の戻り値(危機の応答の途中だけ)。無ければ null
//   teacherAnswer "yes" | "no" | "unclear"(3通目のあとだけ)。無ければ null
// 戻り値
//   stage / risk / subject / decidedBy  このターンの扱い(記録用。decidedBy には第2段階の規則も足す:
//        watch_repeat 見守り中の再サイン / reentry 打ち消しのあとの再受け止め / closing_exception クロージングの例外 /
//        retraction 打ち消し / retraction_ignored_keyword キーワード等があるので打ち消しを採らなかった /
//        accumulation_pause 積み重なり・再受け止めへの返事が段階0なので止めた / crisis_flow 危機の応答の続き)
//   action        "fixed"(固定の文面を出す。生成しない)| "generate"(生成する)
//   text          action = fixed のときの文面
//   crisisStep    危機の応答の何通目か(1〜4。5 = 2回目以降の短い1通、6 = 再受け止め)。危機の応答でなければ null
//   card          応答の下に出すもの: null | "care"(気づかいの一言+折りたたみの窓口)|
//                 "hotlines"(折りたたみの窓口だけ)| "crisis"(危機カード)
//   safetyContexts 生成のときに retrieve / buildSystem に渡す文脈("tierB"|"thirdParty"|"retraction"|"afterCrisis")
//   notify / notifySubject  職員に通知するか(段階2を検知するたび。今と同じ)と、その本人/第三者の区別
//   nextState     sessions に書き戻す状態
//   event         safety_events に書く内容(書かなくてよいターンは null)
// ----------------------------------------------------------------------------
export function planSafetyTurn({ staged, state, retraction = null, teacherAnswer = null }) {
  const s = normalizeSafetyState(state);
  const detected = [...(staged?.decidedBy ?? [])];
  const keywords = staged?.keywords ?? [];
  const patterns = staged?.patterns ?? [];
  const ownWords = keywords.length > 0 || patterns.length > 0; // キーワード・受動パターン(強制判定)
  const subject = staged?.subject === "other" ? "other" : "self";
  // 想定外の段階は段階1として扱う(段階0には落とさない)
  let stage = [0, 1, 2].includes(staged?.stage) ? staged.stage : 1;
  const rules = [...detected];

  // クロージングの問いかけへの「終わりにしたい」(確認5)。段階1にとどめ、本人のサインとしては数えない
  let closingException = false;
  if (stage === 2 && subject === "self" && s.closing_state === "awaiting_choice"
    && keywords.length > 0 && keywords.every((k) => k === "終わりにしたい")
    && patterns.length === 0 && !detected.includes("classifier")) {
    stage = 1;
    closingException = true;
    rules.push("closing_exception");
  }
  const isSign = stage === 1 && !closingException
    && (detected.includes("classifier_watch") || detected.includes("idiom"));

  const next = {
    watch_turns_left: s.watch_turns_left, crisis_state: s.crisis_state,
    crisis_trigger: s.crisis_trigger, care_shown: s.care_shown, reentry_used: s.reentry_used,
  };
  // 危機の応答を始めたあと(止めている・終えた)は、生成に危機のあとの指示を付ける
  const afterCrisis = s.crisis_state === "done" || PAUSED_STEP[s.crisis_state] != null;
  // 打ち消し等で止めたあとの見守りは、再受け止めをまだ使っていないときだけ(使ったあとは見守らない)
  const pauseWatch = s.reentry_used ? 0 : WATCH_TURNS;
  const build = (p) => {
    const contexts = p.safetyContexts ?? [];
    return {
      stage: p.stage, risk: p.risk ?? riskOf(p.stage), subject: p.subject ?? subject,
      decidedBy: p.decidedBy ?? rules,
      action: p.action ?? "generate", text: p.text ?? null, crisisStep: p.crisisStep ?? null,
      card: p.card ?? null, safetyContexts: contexts,
      notify: p.notify === true, notifySubject: p.notifySubject ?? p.subject ?? subject,
      provisional: p.action === "fixed" || p.card === "care"
        || contexts.includes("retraction") || contexts.includes("afterCrisis"),
      nextState: p.nextState ?? next,
      event: p.event
        ? {
          stage: p.event.stage ?? p.stage, risk: p.event.risk ?? riskOf(p.event.stage ?? p.stage),
          subject: p.subject ?? subject, decided_by: p.decidedBy ?? rules,
          watch_event: p.event.watch_event ?? null, retraction: p.event.retraction === true,
          teacher_answer: p.event.teacher_answer ?? null, crisis_step: p.crisisStep ?? null,
        }
        : null,
    };
  };
  // n: 1〜4 = 危機の応答の n通目、5 = 2回目以降の短い1通、6 = 再受け止め
  const fixedStep = (n, extra = {}) => ({
    action: "fixed", crisisStep: n,
    text: n === 1 ? CRISIS_STEP1_PROVISIONAL
      : n === 2 ? CRISIS_STEP2_PROVISIONAL
        : n === 3 ? CRISIS_STEP3_PROVISIONAL
          : n === 5 ? CRISIS_REPEAT_PROVISIONAL
            : n === 6 ? CRISIS_AGAIN_PROVISIONAL
              : CRISIS_STEP4_PROVISIONAL[extra.teacherAnswer] ?? CRISIS_STEP4_PROVISIONAL.unclear,
    card: n === 1 ? "hotlines" : (n === 2 || n === 5) ? "crisis" : null,
  });
  // 止めていた n通目の続き(n+1通目。3通目のあとなら短い1通。4通目は3通目への答えでしか出さない)
  const continueAfter = (n, extra) => (n === 3
    ? { ...fixedStep(5), nextState: { ...next, ...extra, crisis_state: "done", watch_turns_left: 0 } }
    : { ...fixedStep(n + 1), nextState: { ...next, ...extra, crisis_state: `step${n + 1}`, watch_turns_left: 0 } });

  // ---- 危機の応答の途中(1〜3通目・再受け止めを出して返事を待っている) ----
  const flowN = FLOW_STEP[s.crisis_state];
  const againN = AGAIN_STEP[s.crisis_state];
  if (flowN != null || againN != null) {
    const n = flowN ?? againN;
    if (retraction?.retraction === true) {
      if (!ownWords) {
        // 打ち消し → 段階1(見守り)。残りの文面は出さない。窓口の表示(1通目以降の下)はそのまま残る
        return build({
          stage: 1, subject: "self", decidedBy: [...rules, "retraction"],
          safetyContexts: ["retraction", "afterCrisis"],
          nextState: { ...next, crisis_state: `paused${n}`, watch_turns_left: pauseWatch },
          event: { stage: 1, watch_event: pauseWatch ? "start" : null, retraction: true },
        });
      }
      rules.push("retraction_ignored_keyword"); // キーワードの強制判定を優先する
    }
    const notify = staged?.stage === 2 && subject === "self";
    const flowRules = [...rules, "crisis_flow"];
    // 記録の risk は、この発言そのものの判定にする(「うん」等の返事まで未対応の危機として pending_safety に並ばないように)
    const eventRisk = riskOf(staged?.stage ?? 0);
    // 積み重なりの1通目・再受け止めへの返事が段階0なら、続きの文面に進まず止める(確認4)
    if ((againN != null || (flowN === 1 && s.crisis_trigger === "accumulation")) && stage === 0) {
      return build({
        stage: 0, subject: "self", decidedBy: [...rules, "accumulation_pause"],
        safetyContexts: ["afterCrisis"],
        nextState: { ...next, crisis_state: `paused${n}`, watch_turns_left: pauseWatch },
        event: { stage: 0, watch_event: pauseWatch ? "start" : null },
      });
    }
    if (againN != null) {
      // 再受け止めへの返事にもサインがある → 止めていた続きの文面へ
      return build({ stage: 2, subject: "self", decidedBy: flowRules, notify, ...continueAfter(n), event: { stage: 2, risk: eventRisk } });
    }
    if (flowN === 3) {
      const answer = ["yes", "no", "unclear"].includes(teacherAnswer) ? teacherAnswer : "unclear";
      return build({
        stage: 2, subject: "self", decidedBy: flowRules, ...fixedStep(4, { teacherAnswer: answer }), notify,
        nextState: { ...next, crisis_state: "done", watch_turns_left: 0 },
        event: { stage: 2, risk: eventRisk, teacher_answer: answer },
      });
    }
    // 次の文面へ(返事の内容にかかわらず)
    return build({
      stage: 2, subject: "self", decidedBy: flowRules, ...fixedStep(flowN + 1), notify,
      nextState: { ...next, crisis_state: `step${flowN + 1}` },
      event: { stage: 2, risk: eventRisk },
    });
  }

  // ---- それ以外 ----
  const watching = s.watch_turns_left > 0;
  const pausedN = PAUSED_STEP[s.crisis_state];
  let escalated = false;
  // 見守り中の再サインで段階2に上げる(危機の応答を終えたあとは見守らないので上げない)
  if (watching && isSign && s.crisis_state !== "done") {
    stage = 2;
    escalated = true;
    rules.push("watch_repeat");
  }
  const countdown = () => {
    const left = watching ? s.watch_turns_left - 1 : 0;
    return { nextState: { ...next, watch_turns_left: left }, ended: watching && left === 0 };
  };

  // 段階2(本人)
  if (stage === 2 && subject === "self") {
    const trigger = escalated ? "accumulation" : "direct";
    const watchEvent = watching ? (escalated ? "escalate" : "end") : null;
    const common = { stage: 2, subject: "self", notify: true, notifySubject: "self", event: { stage: 2, watch_event: watchEvent } };
    if (s.crisis_state === "none") {
      return build({
        ...common, ...fixedStep(1),
        nextState: { ...next, crisis_state: "step1", crisis_trigger: trigger, watch_turns_left: 0 },
      });
    }
    if (pausedN != null) {
      // 打ち消し等で止めたあとの段階2。キーワード・受動パターンなら続きの文面へ。見守り中の再サイン・
      // 分類器だけの判定なら、再受け止め(受け止めだけの短い1通)から始める(1回の会話で1回まで)
      if (!ownWords && !s.reentry_used) {
        return build({
          ...common, decidedBy: [...rules, "reentry"], ...fixedStep(6),
          nextState: { ...next, crisis_state: `again${pausedN}`, crisis_trigger: trigger, watch_turns_left: 0, reentry_used: true },
        });
      }
      return build({ ...common, ...continueAfter(pausedN, { crisis_trigger: trigger }) });
    }
    // done: 1〜4通目は出し終えているので、短い1通(危機カードつき)。見守りは始めない
    return build({
      ...common, ...fixedStep(5),
      nextState: { ...next, crisis_state: "done", crisis_trigger: trigger, watch_turns_left: 0 },
    });
  }

  // 段階2(第三者): 今と同じく、生成を続けて第三者への懸念の指示を付ける。見守りは1ターン進める
  if (stage === 2) {
    const { nextState, ended } = countdown();
    return build({
      stage: 2, subject: "other", notify: true, notifySubject: "other",
      safetyContexts: ["thirdParty", ...(afterCrisis ? ["afterCrisis"] : [])],
      nextState, event: { stage: 2, watch_event: ended ? "end" : null },
    });
  }

  // 段階1
  if (stage === 1) {
    const contexts = ["tierB", ...(afterCrisis ? ["afterCrisis"] : [])];
    // 見守り中(分類器のエラー・クロージングの例外は本人のサインではないので上げない)、
    // または危機の応答を始めたあと(窓口はすでに表示している)は、カードを出さず生成するだけ
    if (watching || s.crisis_state !== "none") {
      const { nextState, ended } = countdown();
      return build({ stage: 1, safetyContexts: contexts, nextState, event: { stage: 1, watch_event: ended ? "end" : null } });
    }
    return build({
      stage: 1, safetyContexts: contexts, card: s.care_shown ? "hotlines" : "care",
      nextState: { ...next, watch_turns_left: WATCH_TURNS, care_shown: true },
      event: { stage: 1, watch_event: "start" },
    });
  }

  // 段階0
  const { nextState, ended } = countdown();
  return build({
    stage: 0, safetyContexts: afterCrisis ? ["afterCrisis"] : [], nextState,
    event: ended ? { stage: 0, watch_event: "end" } : null,
  });
}

// ----------------------------------------------------------------------------
// 軽いモデルによる補助判定(打ち消し・先生についての答え)。形式は responseSchema で強制する。
// 失敗したら安全側に倒す(打ち消しではない / どちらでもない)。
// ----------------------------------------------------------------------------
const JUDGE_MAX_OUTPUT_TOKENS = 4096; // 思考トークンで JSON が途中で切れないよう、分類器 v2 と同じ幅を取る

function judgeTimeoutMs() {
  const n = Number(process.env.CRISIS_CLASSIFIER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

async function judgeOnce(prompt, schema, input, validate) {
  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callGemini(
        LITE_MODELS, prompt, [{ role: "user", parts: [{ text: input }] }], JUDGE_MAX_OUTPUT_TOKENS, -1, { responseSchema: schema },
      );
      const parsed = parseJSON(result.text);
      const value = validate(parsed);
      return { ok: true, ...value, reason: parsed.reason ?? "", model: result.model, usage: result.usage, ms: Date.now() - started };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError, ms: Date.now() - started };
}

function withTimeout(promise) {
  const limit = judgeTimeoutMs();
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `[TIMEOUT] ${limit}ms以内に判定が返らなかった`, ms: limit }), limit);
    }),
  ]);
}

// 打ち消しの判定。段階を下げる判定なので、並行した回が「すべて」打ち消しと判定したときだけ
// 打ち消しとする(段階を上げるときは1回で上げるので、その逆)。1回でもエラーなら打ち消しではない。
const RETRACTION_PROMPT = `あなたは中高生向け相談AIの補助判定器です。次のJSONだけを返します。
{"retraction": true または false, "reason": "20字以内"}

状況: 相談者が少し前に深刻なこと(死にたい気持ち・自傷・被害など)を書き、AIが受け止めの言葉を返しました。

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり
【判定する発言】相談者の最新の発言

【判定する発言】が、先に書いた深刻な内容を「冗談」「うそ」「ネタ」「大げさに言っただけ」「今のなし」などと
取り消す(打ち消す)発言かどうかを判定してください。
retraction が true: 先に書いた深刻な内容を、冗談・うそ・大げさ・なかったことにする、と取り消している
retraction が false: それ以外。次のものは打ち消しではない:
  ・「冗談じゃない」「本気」「ほんとのこと」など、深刻さを認める・念押しする発言
  ・「うん」「ありがとう」「わからない」など、取り消しを含まない返事
  ・話題を変えただけの発言
迷ったら false にすること(打ち消しと取り違えると、深刻な状態にある人への対応を弱めてしまうため)。`;

const RETRACTION_SCHEMA = {
  type: "OBJECT",
  properties: { retraction: { type: "BOOLEAN" }, reason: { type: "STRING" } },
  required: ["retraction", "reason"],
  propertyOrdering: ["retraction", "reason"],
};

export async function judgeRetraction(text, recentMessages = [], { votes = 2 } = {}) {
  const input = buildClassifierInput(text, recentMessages);
  const results = await Promise.all(Array.from({ length: votes }, () => withTimeout(judgeOnce(
    RETRACTION_PROMPT, RETRACTION_SCHEMA, input,
    (p) => {
      if (typeof p.retraction !== "boolean") throw new Error(`想定外の retraction: ${p.retraction}`);
      return { retraction: p.retraction };
    },
  ))));
  const retraction = results.length > 0 && results.every((r) => r.ok && r.retraction === true);
  const errors = results.filter((r) => !r.ok).map((r) => r.error);
  return { retraction, votes: results, error: errors.length ? errors.join(" | ") : null };
}

// 3通目(先生に話すことをどう思うか)への答えの判定。記録と4通目の出し分けにだけ使う。
const TEACHER_PROMPT = `あなたは中高生向け相談AIの補助判定器です。次のJSONだけを返します。
{"answer": "yes|no|unclear", "reason": "20字以内"}

状況: AIが相談者に「今日のことを、学校の先生に話してみるとしたら、どう思う？」とたずねました。

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり
【判定する発言】相談者の最新の発言(上の問いへの答え)

answer の基準:
yes: 先生に話すことに前向き(「話してみる」「いいかも」「話せそう」など)
no: 先生に話すことに後ろ向き(「いやだ」「話したくない」「無理」「先生には言いたくない」など)
unclear: どちらとも言えない、わからない、問いに答えていない`;

const TEACHER_SCHEMA = {
  type: "OBJECT",
  properties: { answer: { type: "STRING", enum: ["yes", "no", "unclear"] }, reason: { type: "STRING" } },
  required: ["answer", "reason"],
  propertyOrdering: ["answer", "reason"],
};

export async function judgeTeacherAnswer(text, recentMessages = []) {
  const input = buildClassifierInput(text, recentMessages);
  const r = await withTimeout(judgeOnce(TEACHER_PROMPT, TEACHER_SCHEMA, input, (p) => {
    if (!["yes", "no", "unclear"].includes(p.answer)) throw new Error(`想定外の answer: ${p.answer}`);
    return { answer: p.answer };
  }));
  return { answer: r.ok ? r.answer : "unclear", vote: r, error: r.ok ? null : r.error };
}

// ----------------------------------------------------------------------------
// 1ターン分の判定をまとめて行う(route.ts とペルソナテストで共通)。
// 分類器 v2 と、必要なときだけ打ち消し・先生についての答えの判定を並行して呼ぶ。
// ----------------------------------------------------------------------------
export async function assessSafetyTurn(text, recentMessages, state) {
  const s = normalizeSafetyState(state);
  const inFlow = FLOW_STEP[s.crisis_state] != null || AGAIN_STEP[s.crisis_state] != null;
  const [staged, retraction, teacher] = await Promise.all([
    classifyStaged(text, recentMessages ?? []),
    inFlow ? judgeRetraction(text, recentMessages ?? []) : Promise.resolve(null),
    s.crisis_state === "step3" ? judgeTeacherAnswer(text, recentMessages ?? []) : Promise.resolve(null),
  ]);
  const plan = planSafetyTurn({ staged, state: s, retraction, teacherAnswer: teacher?.answer ?? null });
  return { staged, retraction, teacher, plan };
}
