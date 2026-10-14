// ============================================================================
//  トップ画面から始めるインテーク(2026年10月14日に人が確認した設計。docs/design-shima4-part1-topscreen.md 2章・3章、
//  指示書 docs/prompts/top-screen-intake.md)
//
//  流れの判断はコードで決め、AI は言葉だけを担う(指示書 3章「流れはコードで決める」)。
//  次に何を聞くかは sessions.intake_step(db/schema.sql 16節)だけで決める。AI の出力(intake_complete など)では進めない。
//
//   1 主訴        … トップ画面の6つのボタン(コードが記録。source = button)。ボタンを押さずに書いたときは、
//                    主訴を聞き直さず、AI の推定を記録する(source = estimated)。背景がすでに書かれていれば2を飛ばす(AI の推定・記録する)
//   2 きっかけ・背景 … AI が言葉で1つだけ聞く。相談者は自由に書く(この答えは危機の判定にかける)
//   3 つらさ      … AI の短い受け止め(1文)のあとに、決まった問いと 1〜5 のチップ(コード)
//   4 なりたい姿  … AI の短い受け止め(1文)のあとに、決まった問いとチップ(コード)。つらさが4・5のときは次のターンに回す
//   → 4つそろったらフェーズ2へ(コード)
//
//  チップを押した・同じ数字や言葉を打った答えは、危機の判定にかけない(src/crisis-response.mjs の resolveChoice)。
//  文章で答えたときは本人の言葉なので、今までどおり判定にかける。
//  インテークの中だけ、つらさ(3)となりたい姿(4)のチップが続いてよい(あいだに必ず AI の受け止めを挟む)。
//
//  【仮】問いの文・チップの文・指示の文は仮(心理士の確認待ち。名前の末尾が _PROVISIONAL)。
//  このファイルは何も読み込まない(crisis-response.mjs・generate.mjs・route.ts から使う)。
// ============================================================================

export const INTAKE_STEPS = ["category", "background", "distress", "goal", "done"];

// 1. 主訴(トップ画面の6つのボタン)。6 = どれに当てはまるかわからない(未分類)
export const CATEGORY_SET = "K";
export const CATEGORY_CHOICES_PROVISIONAL = [
  { id: "K1", label: "友達・人間関係" },
  { id: "K2", label: "勉強・進路・部活" },
  { id: "K3", label: "家族・家のこと" },
  { id: "K4", label: "自分の気持ちや性格" },
  { id: "K5", label: "うまく言えない" },
  { id: "K6", label: "どれに当てはまるかわからない" },
];
export const CATEGORY_JA = { 1: "友達・人間関係", 2: "勉強・進路・部活", 3: "家族・家のこと", 4: "自分の気持ちや性格", 5: "うまく言えない(なんとなくしんどい)", 6: "どれに当てはまるかわからない(未分類)" };

// 3. つらさ(インテークと危機の気持ちのスケーリングで同じラベル。2026年10月14日にそろえた)
export const DISTRESS_SET = "D";
export const DISTRESS_LABELS_PROVISIONAL = ["少し気になる", "まあまあモヤモヤする", "かなりつらい", "限界に近い", "もう耐えられない"];
export const DISTRESS_CHOICES_PROVISIONAL = DISTRESS_LABELS_PROVISIONAL.map((l, i) => ({ id: `D${i + 1}`, label: `${i + 1} ${l}` }));
export const DISTRESS_QUESTION_PROVISIONAL = "今、そのことで感じているつらさに近いのはどれかな？";

// 4. なりたい姿
export const GOAL_SET = "H";
export const GOAL_CHOICES_PROVISIONAL = [
  { id: "H1", label: "吐き出したい" },
  { id: "H2", label: "一緒に整理したい" },
  { id: "H3", label: "どっちも" },
  { id: "H4", label: "まだわからない" },
];
export const GOAL_QUESTION_PROVISIONAL = "今日ここで話していく中で、どうなれたらいいかな？";

// つらさが4・5のときに、そのターンの生成に足す指示(コードが値を見て付ける。危機の判定ではなく、インテークの決まり。
// 2026年10月14日に人が決めた。CLAUDE.md 5.13)
export const INTAKE_HIGH_DISTRESS_BLOCK_PROVISIONAL = `

# 今回のターンについて(重要)
相談者は、今のつらさを「4 限界に近い」か「5 もう耐えられない」と答えました。
・まず、そのつらさを受け止める。数字の意味を確かめたり、どのくらいかを二択で聞いたりしない(危険度を確かめる問いはしない)
・ひとりで抱えなくていいこと、まわりの信頼できる人や画面の下の窓口に頼ってよいことを、一言だけ添える(押しつけない)
・次の問い(どうなれたらいいか)は、このターンでは書かない。受け止めと、続きを話してよいことを伝える一言で終える`;

// ---------------------------------------------------------------------------
// そのターンの段階ごとの指示(buildSystem のインテークの進め方として使う)
// ---------------------------------------------------------------------------
const COMMON = `# 現在のフェーズ:インテーク(最初の数ターン)
次に何を聞くかは、システムが決めています。あなたは、このターンで決められたことだけを、自然な言葉で行ってください。
- 文章の中に番号つきの選択肢(1.〜 2.〜)を並べない。数字で選んでもらう問いは書かない(必要な選択肢は、システムがボタンで出します)
- 主訴(どんなことで来たか)を聞き直さない
- 返事は短く。受け止めは1つで十分。相談者の言葉を一つ拾って返す
- 危機のサインが出た場合は、この手順よりも安全への配慮(別に指示している内容)を優先する`;

export function buildIntakeStepBlock(turn) {
  const cat = turn?.category ? CATEGORY_JA[turn.category] : null;
  switch (turn?.prompt) {
    case "afterCategoryButton":
      if (turn.category === 5) {
        return `${COMMON}

## このターンですること
相談者は最初の画面で「うまく言えない」を選びました(なんとなくしんどくて、言葉にならない人)。
- きっかけを急かさない。「うまく言えなくても大丈夫。話したかったら話してもいいし、別の話題でもいいよ」という姿勢で(石田先生 V6)
- そのうえで、話しやすいところから少しだけ聞く問いを1つ(例: 最近、どんなときにしんどいなって感じる?)`;
      }
      if (turn.category === 6) {
        return `${COMMON}

## このターンですること
相談者は最初の画面で「どれに当てはまるかわからない」を選びました(話したいことはあるが、どの分類にも当てはまらない人)。
- どんなことかを、自由に書いてもらう問いを1つ(例: よかったら、どんなことか、思いつくままに書いてみてくれる?)`;
      }
      return `${COMMON}

## このターンですること
相談者は最初の画面で「${cat}」を選びました。主訴はこれで記録済みです。
- 選んでくれたことを短く受け止め、きっかけ・背景(いつ頃からか、どんなことがあったか)を言葉で1つだけ聞く
- カテゴリに応じて視点を変える(人間関係→誰と・どんな場面 / 勉強・進路・部活→どの場面か将来のことか / 家族→どの関係・どのくらい / 気持ちや性格→どんなところが気になるか)`;
    case "afterFreeText":
      return `${COMMON}

## このターンですること
相談者は最初の画面のボタンを押さずに、自分の言葉で書きました。主訴を聞き直さないでください。
- 書かれた内容から主訴を推定し、出力の "intake" の "chief_complaint_category" に入れる(1 友達・人間関係 / 2 勉強・進路・部活 /
  3 家族・家のこと / 4 自分の気持ちや性格 / 5 うまく言えない・なんとなくしんどい / 6 どれにも当てはまらない)
- 書かれた内容に、きっかけ・背景(いつ頃から・どんなことがあったか)がすでに含まれているなら、"background_present" を true にし、
  "onset_context" に短く要約する。このときは問いを書かず、相談者の言葉を一つ拾った短い受け止め(1文)だけにする
- 含まれていなければ "background_present" は false。受け止め(1文)のあと、きっかけ・背景を言葉で1つだけ聞く`;
    case "afterBackground":
      return `${COMMON}

## このターンですること
相談者が、きっかけ・背景について書きました。
- 相談者の言葉を一つ拾って、短く受け止める(1文)。**問いは書かない**(このあとに、システムが決まった問いを続けます)
- "onset_context" に、時期・きっかけを短く要約する。話したくない様子なら「本人は今は話したくない」のように書く`;
    case "askDistressAgain":
      return `${COMMON}

## このターンですること
- 相談者の言葉を一つ拾って、短く受け止める(1文)。**問いは書かない**(このあとに、システムが決まった問いを続けます)`;
    case "afterDistress":
      return `${COMMON}

## このターンですること
相談者は、今のつらさを「${turn.distressLabel}」と答えました(記録済み)。
- 短く受け止める(1文)。数字を復唱しすぎない。**問いは書かない**(このあとに、システムが決まった問いを続けます)`;
    case "afterDistressHigh":
      return `${COMMON}

## このターンですること
相談者は、今のつらさを「${turn.distressLabel}」と答えました(記録済み)。下の「今回のターンについて」に従ってください。`;
    case "afterDistressText":
      return `${COMMON}

## このターンですること
相談者は、つらさを数字ではなく言葉で答えました。数字をもう一度求めないでください。
- 相談者の言葉を一つ拾って、短く受け止める(1文)。**問いは書かない**(このあとに、システムが決まった問いを続けます)`;
    case "beforeGoal":
      return `${COMMON}

## このターンですること
- 相談者の言葉を一つ拾って、短く受け止める(1文)。**問いは書かない**(このあとに、システムが決まった問いを続けます)`;
    case "afterGoal":
      return `${COMMON}

## このターンですること
相談者は、今日なりたい姿を「${turn.goalLabel}」と答えました(記録済み)。これで最初の受付は終わりです。
- 短く受け止め、これから話を聞かせてほしいことが伝わる一言か、話の入り口になる問いを1つ添える
- 出力の "intake" の "recommended_mode" に、ここまでの話から合いそうな進め方を入れる(複合可。判定基準は下)。名前は相談者に出さない
  LISTEN_ONLY(ただ聞いてほしい・つらさが高い)/ CBT(捉え方の整理)/ SFBT(工夫や一歩を本人の資源から)/ ASSERTION(伝え方)/
  NARRATIVE(自己否定が強い)/ PROBLEM_SOLVING(具体的・実務的な問題)/ PSYCHOEDUCATION(心身の反応の理解)`;
    default:
      return COMMON;
  }
}

// インテークの段階のときに出力に足すフィールド
export const INTAKE_STEP_OUTPUT_SCHEMA = `,
  "intake": {
    "chief_complaint_category": 1から6の数値(主訴を推定するよう指示されたときだけ。それ以外はnull),
    "background_present": true または false(指示されたときだけ。それ以外はfalse),
    "onset_context": "時期・きっかけの要約。指示されていなければ空文字",
    "ambivalence_detected": true または false,
    "recommended_mode": ["指示されたときだけ。それ以外は空配列"]
  }`;

// ---------------------------------------------------------------------------
// そのターンの段取り(生成の前)。戻り値:
//  { step: このターンの段階, prompt: 指示の種類, patch: sessions に書く値, contexts: 足す指示, flags: 記録,
//    category, distressLabel, goalLabel, after: 生成のあとに決まった問いを続けるか(null | "distress" | "goal") }
// picked: resolveChoice で受け取ったチップ(相談者の最初の発言では、トップ画面のボタン)。lastOffered: 直前の返事のチップの組
// ---------------------------------------------------------------------------
export const INTAKE_DISTRESS_TEXT_FLAG = "記録のみ:つらさを数字ではなく言葉で答えた";
export const INTAKE_ESTIMATED_FLAG = "記録のみ:主訴はAIの推定";

export function planIntakeTurn({ sess, picked, text, lastOffered }) {
  const step = INTAKE_STEPS.includes(sess?.intake_step) ? sess.intake_step : null;
  if (!step || step === "done" || sess?.phase !== "intake") return null;
  const base = { step, patch: {}, contexts: [], flags: [], after: null };
  if (step === "category") {
    if (picked?.set === CATEGORY_SET) {
      const n = Number(picked.id.slice(1));
      return { ...base, prompt: "afterCategoryButton", category: n,
        patch: { chief_complaint_category: n, chief_complaint_source: "button", intake_step: "background" } };
    }
    // ボタンを押さずに書いた: 主訴は AI の推定(生成のあとに決める)
    return { ...base, prompt: "afterFreeText" };
  }
  if (step === "background") {
    return { ...base, prompt: "afterBackground", after: "distress", patch: { intake_step: "distress" } };
  }
  if (step === "distress") {
    if (lastOffered !== DISTRESS_SET) {
      // まだつらさの問いを出していない(危機の応答で止まっていた など)→ 受け止めのあとに問いを出す
      return { ...base, prompt: "askDistressAgain", after: "distress" };
    }
    if (picked?.set === DISTRESS_SET) {
      const n = Number(picked.id.slice(1));
      const distressLabel = DISTRESS_CHOICES_PROVISIONAL[n - 1].label;
      if (n >= 4) {
        return { ...base, prompt: "afterDistressHigh", distressLabel, contexts: ["intakeHighDistress"],
          patch: { distress_level: n, intake_step: "goal" } };
      }
      return { ...base, prompt: "afterDistress", distressLabel, after: "goal", patch: { distress_level: n, intake_step: "goal" } };
    }
    // 言葉で答えた(数字を求め直さない。言葉は心身の様子として残す)
    return { ...base, prompt: "afterDistressText", after: "goal", flags: [INTAKE_DISTRESS_TEXT_FLAG],
      patch: { physical_mental_symptoms: String(text ?? "").slice(0, 200), intake_step: "goal" } };
  }
  if (step === "goal") {
    if (lastOffered !== GOAL_SET) return { ...base, prompt: "beforeGoal", after: "goal" };
    const goalLabel = picked?.set === GOAL_SET ? picked.label : String(text ?? "").slice(0, 100);
    return { ...base, prompt: "afterGoal", goalLabel, goalId: picked?.set === GOAL_SET ? picked.id : null,
      patch: { user_goal: goalLabel, intake_step: "done", phase: "phase2", intake_completed_at: new Date().toISOString() } };
  }
  return null;
}

// なりたい姿から決まる進め方(コード)と、AI の見立て(曖昧な判定。記録で区別)を合わせる
const MODES = ["CBT", "SFBT", "NARRATIVE", "ASSERTION", "LISTEN_ONLY", "PROBLEM_SOLVING", "PSYCHOEDUCATION"];
export function modesFromGoal(goalId, aiModes) {
  const ai = (Array.isArray(aiModes) ? aiModes : []).filter((m) => MODES.includes(m) && m !== "LISTEN_ONLY");
  if (goalId === "H1" || goalId === "H4") return ["LISTEN_ONLY"];
  if (goalId === "H2") return ai.length ? ai : ["CBT"];
  if (goalId === "H3") return ["LISTEN_ONLY", ...(ai.length ? ai : ["CBT"])];
  // 言葉で答えた: AI の見立て(無ければ傾聴)
  const all = (Array.isArray(aiModes) ? aiModes : []).filter((m) => MODES.includes(m));
  return all.length ? all : ["LISTEN_ONLY"];
}

// 生成のあと: AI の出力から、このターンで決まる値と、続ける決まった問いを決める
export function finishIntakeTurn(turn, out) {
  if (!turn) return null;
  const i = out?.intake ?? {};
  const patch = { ...turn.patch };
  const flags = [...turn.flags];
  let after = turn.after;
  if (turn.prompt === "afterFreeText") {
    const n = Number.isInteger(i.chief_complaint_category) && i.chief_complaint_category >= 1 && i.chief_complaint_category <= 6
      ? i.chief_complaint_category : 6;
    patch.chief_complaint_category = n;
    patch.chief_complaint_source = "estimated";
    flags.push(`${INTAKE_ESTIMATED_FLAG}(${CATEGORY_JA[n]})`);
    if (i.background_present === true && String(i.onset_context ?? "").trim()) {
      patch.onset_context = String(i.onset_context).slice(0, 300);
      patch.intake_step = "distress";
      after = "distress";
      flags.push("記録のみ:最初の書き込みに背景が含まれていたので、きっかけの問いを飛ばした(AIの推定)");
    } else {
      patch.intake_step = "background";
    }
  }
  if (turn.prompt === "afterBackground") {
    patch.onset_context = String(i.onset_context ?? "").trim().slice(0, 300) || "(記録なし)";
  }
  if (turn.prompt === "afterGoal") {
    patch.recommended_mode = modesFromGoal(turn.goalId, i.recommended_mode);
    if (typeof i.ambivalence_detected === "boolean") patch.ambivalence_detected = i.ambivalence_detected;
  }
  const question = after === "distress"
    ? { body: DISTRESS_QUESTION_PROVISIONAL, choices: DISTRESS_CHOICES_PROVISIONAL, choice_set: DISTRESS_SET }
    : after === "goal" ? { body: GOAL_QUESTION_PROVISIONAL, choices: GOAL_CHOICES_PROVISIONAL, choice_set: GOAL_SET } : null;
  return { patch, flags, question };
}

// トップ画面のボタン(会話の最初の発言のときだけ。直前の AI の返事が無いので resolveChoice では受け取れない)
export function topScreenChoice(prior, choiceId, text) {
  if ((prior ?? []).some((m) => m?.role === "ai")) return null;
  const norm = (t) => String(t ?? "").replace(/\s+/g, "");
  const item = CATEGORY_CHOICES_PROVISIONAL.find((c) => c.id === choiceId)
    ?? CATEGORY_CHOICES_PROVISIONAL.find((c) => norm(c.label) === norm(text));
  if (!item) return null;
  return { set: CATEGORY_SET, id: item.id, label: item.label, input: item.id === choiceId ? "button" : "typed" };
}
