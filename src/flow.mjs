// ============================================================================
//  会話の流れ(会話が展開しない問題の修正。2026年10月11日に人が確認した設計)
//
//  材料: 相談ログ 16f362dd(docs/review-logs/2026-10-11-16f362dd.md)。設計: docs/design-conversation-flow.md
//  根拠: 石田先生 IS4(「そうなの」の次に一言)・V4・V5(コンプレイナントへの問い)・IS8(一回まとめてみようか)、嶋先生 T16(気づきの問い)
//
//  route.ts・scripts/test-persona-regression.mjs・scripts/test-conversation-flow.mjs で同じものを使う。
//  判断はサーバ側(CLAUDE.md 6節)。DB の列は足さない(messages の question_level・summarized・flags・mode・choices から数える)。
//
//  決まり
//   ・受け止めのみ(question_level = none)は続けて2回まで。3回目は、問い(1つ)・まとめ・選択肢のどれか
//     例外(傾聴): 相談者がはっきり言ったとき(聞いてほしいだけ・アドバイスはいらない等)/インテークのゴールが吐き出すことだけ/
//     チップで「もう少しこのまま話したい」を選んだとき。モデルの推測では切り替えない(人が決めた。ログは整理も望んでいた人に受け止めだけが続いた失敗)
//   ・まとめは「合ってるかな?」で終える。気づきの問い(T16)は次のターン。直されたら、直された内容の受け止めが先
//   ・作り直し(1回だけ)の決まり A 受け止めのみの3回目 / B 同じ意味の労い(直前3回にもある)/ C 終わり方が直前2回と同じ /
//     D 「整理してみたい」と言ったのにまとめていない。ログでは 8・11・12 ターンが当たる(人が確認した範囲)
//   ・強い言葉・重さを足す言葉は記録のみ(相談者自身が使った言葉は数えない)
//
//  チップ(組G)の文面は仮(心理士の確認待ち。名前の末尾が _PROVISIONAL)。
//  危機の流れ(段階2の固定の文面・チップ)には関わらない。危機の状態で生成するターンでは、この作り直しはしない。
// ============================================================================

// ---- 整理の提案のチップ(組G。仮)----
export const CHOICES_G_PROVISIONAL = [
  { id: "G1", label: "もう少しこのまま話したい" },
  { id: "G2", label: "一緒に整理してみたい" },
];
export const FLOW_CHOICE_SET = "G";
// 1回の会話で出してよい回数
export const ORGANIZE_OFFER_MAX = 2;
// 吐き出しのターンがこれだけ続いたら、整理に移ることを提案する
export const ORGANIZE_AFTER_TURNS = 3;
// 受け止めのみの上限(続けて)
export const RECEIVE_ONLY_MAX = 2;

// ---- 文の形 ----
export const hasQuestion = (t) => /[？?]/.test(String(t ?? ""));
const sentences = (t) => String(t ?? "").split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
// 終わり方の形。問いで終わる / 〜ね / 〜よ / それ以外は最後の3文字
export function endingClass(t) {
  const last = sentences(t).at(-1) ?? "";
  if (/[？?]$/.test(last)) return "Q";
  const b = last.replace(/[。！!…\s]+$/, "");
  if (/ね$/.test(b)) return "ね";
  if (/よ$/.test(b)) return "よ";
  return `他:${b.slice(-3)}`;
}
// 頑張り・抱え込みへの労い(「ずっと一人で頑張ってきたんだね」と同じ意味)
export const EFFORT_RE = /(ずっと|一人|ひとり|自分だけ|会長だから|一人きり).{0,14}(頑張|がんば|抱え|背負|踏ん張|耐え)|(頑張|がんば|背負|踏ん張|耐え|抱え)(って|て|込んで|こんで)?(き|来)た/;
// 「整理してみたい」「まとめてみたい」と言った
export const ORGANIZE_SAID_RE = /(整理|まとめ)(して)?み(たい|よう|ようか|るね|ます)/;
// まとめの確かめ
const CONFIRM_RE = /(合ってる|あってる|合ってた|あってた|ずれてない|ズレてない|ずれてる|違ってたら|ちがってたら|違うところ)/;
// 意味を見失った言葉(ヒントとして使う。決めるのはモデル)
export const LOST_MEANING_RE = /(わから|わかん|分から|分かん)(ない|ん|なく)|なんで.{0,14}(てる|てん|のか|んだろ|るんだ)|何のため|なんのため|意味(が|ある|ない|わかん)/;
// 傾聴に切り替えてよい、相談者のはっきりした言葉
export const LISTEN_ONLY_SAID_RE = /(聞いて(ほしい|欲しい|くれる)だけ|聞いてもらう?だけ|話を聞いて(ほしい|欲しい)|アドバイス(は|とか)?(いらない|要らない|いらん|なしで)|解決(は|とか)?(しなくて|いらない|求めて)|ただ聞いて|吐き出したいだけ|愚痴を?聞いて)/;

// まとめの形を満たしているか(3-2: 相談者の言葉で2〜4個並べる + 確かめ)
export function isValidSummary(reply) {
  const t = String(reply ?? "");
  if (!CONFIRM_RE.test(t)) return false;
  const quotes = (t.match(/「[^」]+」/g) ?? []).length;
  const commas = (t.match(/、/g) ?? []).length;
  const dots = (t.match(/・/g) ?? []).length;
  return quotes >= 2 || commas >= 2 || dots >= 1;
}

// ---- 強い言葉(記録のみ。2段。人が決めた)----
// 語幹で照合する。相談者自身がその言葉を使っていたら数えない
export const STRONG_WORDS = [
  { key: "すり減る", re: /(すり|擦り|磨り)減/ },
  { key: "限界", re: /限界/ },
  { key: "逃げ場", re: /逃げ場/ },
  { key: "取り残され", re: /取り残/ },
  { key: "耐えられない", re: /耐えられ/ },
];
export const HEAVY_WORDS = [
  { key: "苦しい", re: /苦し/ },
  { key: "重い", re: /重(い|く|かっ|たい|さ)/ },
  { key: "重荷", re: /重荷/ },
  { key: "背負", re: /背負/ },
];
// インテークのつらさスケールの選択肢の文は数えない
const INTAKE_SCALE_TEXT_RE = /限界に近い|もう耐えられない/g;
export const STRONG_FLAG = "記録のみ:相談者の言っていない強い言葉";
export const HEAVY_FLAG = "記録のみ:重さを足す言葉";
export function addedWords(reply, userTexts) {
  const r = String(reply ?? "").replace(INTAKE_SCALE_TEXT_RE, "");
  const said = (userTexts ?? []).map(String).join("\n");
  const pick = (list) => list.filter((w) => w.re.test(r) && !w.re.test(said)).map((w) => w.key);
  return { strong: pick(STRONG_WORDS), heavy: pick(HEAVY_WORDS) };
}
export function addedWordNotes(reply, userTexts) {
  const { strong, heavy } = addedWords(reply, userTexts);
  return [
    ...(strong.length ? [`${STRONG_FLAG}(${strong.join("・")})`] : []),
    ...(heavy.length ? [`${HEAVY_FLAG}(${heavy.join("・")})`] : []),
  ];
}

// ---- 記録の印(messages.flags)----
export const FIRST_MOVE_FLAG = "記録のみ:モードの最初の一手";
export const SUMMARY_FORM_FLAG = "記録のみ:まとめの形を満たしていない(区切りとして数えない)";
export const FLOW_REGEN_PREFIX = "会話の流れで作り直し";

// 生成した返事か(危機の流れの固定の文面は数えない)
const isGeneratedAi = (m) => m?.role === "ai" && !m?.crisis;

// ---- 履歴から数える ----
// hist: そのセッションの messages(古い順)。role・body・question_level・summarized・flags・crisis・mode・choice_set・choice_id
// sess: sessions の行(user_goal・phase・recommended_mode)
// choiceId: このターンに押したチップ(組G のときだけ意味を持つ)
export function flowStats(hist, sess, choiceId = null) {
  const msgs = hist ?? [];
  const ais = msgs.filter(isGeneratedAi);
  // 受け止めのみの連続(問いも選択肢も無い返事)
  let receiveOnlyStreak = 0;
  for (let i = ais.length - 1; i >= 0; i--) {
    const m = ais[i];
    const receiveOnly = m.question_level === "none" && !hasQuestion(m.body) && !(Array.isArray(m.choices) && m.choices.length);
    if (!receiveOnly) break;
    receiveOnlyStreak++;
  }
  const lastEndings = ais.slice(-2).map((m) => endingClass(m.body));
  const recentEffort = ais.slice(-3).some((m) => EFFORT_RE.test(String(m.body ?? "")));
  const effortCount = ais.filter((m) => EFFORT_RE.test(String(m.body ?? ""))).length;
  // フェーズ2の何ターン目か(mode が入った最初の行はインテークを終えたターンなので数えない)
  const modeRows = ais.filter((m) => Array.isArray(m.mode) && m.mode.length).length;
  const phase2Index = sess?.phase === "phase2" ? Math.max(0, modeRows - 1) + 1 : 0;
  const firstMoveUsed = ais.some((m) => Array.isArray(m.flags) && m.flags.includes(FIRST_MOVE_FLAG));
  // 組G を出した回数・直前の返事に組G があったか・押したもの
  const offers = ais.filter((m) => m.choice_set === FLOW_CHOICE_SET).length;
  const lastAi = ais.at(-1);
  const lastOfferedG = lastAi?.choice_set === FLOW_CHOICE_SET;
  const chosen = lastOfferedG && choiceId ? CHOICES_G_PROVISIONAL.find((c) => c.id === choiceId) ?? null : null;
  const pastChoices = msgs.filter((m) => m.role === "user" && m.choice_set === FLOW_CHOICE_SET).map((m) => m.choice_id);
  const choices = chosen ? [...pastChoices, chosen.id] : pastChoices;
  const lastChoice = choices.at(-1) ?? null;
  // 吐き出しのターン: フェーズ2で、前回のまとめ・組G のあとに続いている生成した返事の数
  let ventTurns = 0;
  if (sess?.phase === "phase2") {
    for (let i = ais.length - 1; i >= 0; i--) {
      const m = ais[i];
      if (m.summarized || m.choice_set === FLOW_CHOICE_SET || !(Array.isArray(m.mode) && m.mode.length)) break;
      ventTurns++;
    }
    // インテークを終えたターン(mode が入った最初の行)は吐き出しに数えない
    if (ventTurns > 0 && ventTurns === modeRows) ventTurns--;
  }
  const lastWasSummary = lastAi?.summarized === true;
  // 傾聴に切り替えてよいか(この3つのときだけ。モデルの推測では切り替えない)
  const userTexts = msgs.filter((m) => m.role === "user" && !m.choice_set).map((m) => String(m.body ?? ""));
  const goal = String(sess?.user_goal ?? "");
  const goalOrganize = /整理|まとめ|考え|解決|どうしたら|どうすれば/.test(goal);
  const goalVentOnly = /吐き出|聞いて|話したい|聞いてほしい|聞いてもら/.test(goal) && !goalOrganize;
  const listenSaid = userTexts.some((t) => LISTEN_ONLY_SAID_RE.test(t));
  const listenOnly = listenSaid || goalVentOnly || lastChoice === "G1";
  const listenOnlyReason = listenSaid ? "said" : lastChoice === "G1" ? "chip" : goalVentOnly ? "goal" : null;
  return {
    receiveOnlyStreak, lastEndings, recentEffort, effortCount, phase2Index, firstMoveUsed,
    offers, lastOfferedG, chosen, lastChoice, ventTurns, lastWasSummary,
    goal, goalOrganize, listenOnly, listenOnlyReason, userTexts,
  };
}

// 押したチップが組G のものか(直前の AI の返事に組G を付けたときだけ)
export function flowChoiceOf(hist, choiceId) {
  const ais = (hist ?? []).filter(isGeneratedAi);
  if (ais.at(-1)?.choice_set !== FLOW_CHOICE_SET || !choiceId) return null;
  const item = CHOICES_G_PROVISIONAL.find((c) => c.id === choiceId);
  return item ? { set: FLOW_CHOICE_SET, id: item.id, label: item.label, input: "button" } : null;
}

// 危機のあと・危機の状態で生成するターンでは、受け止めのみの作り直しと整理の提案はしない
const crisisContext = (contexts) => (contexts ?? []).some((c) => c === "afterCrisis" || c === "crisisGeneration");

// 組G を出してよいか
export function canOfferOrganize(stats, contexts) {
  return !crisisContext(contexts) && stats.goalOrganize && stats.offers < ORGANIZE_OFFER_MAX && !stats.lastOfferedG
    && stats.lastChoice !== "G2";
}

// ---- モードの最初の一手 ----
export const FIRST_MOVES = {
  CBT: "出来事・そのときの考え・気持ちを分けて聞く(例:「その瞬間、頭の中ではどんなことが浮かんでる?」)",
  SFBT: "うまくいっている時・例外を聞く(例:「少しでもましだった日ってあった?」)",
  NARRATIVE: "問題を本人から切り離して呼ぶ(例:「その『しんどさ』に名前をつけるなら、どんな感じ?」。技法名は言わない)",
  ASSERTION: "誰に・どんな場面で・何を伝えたいかを具体的に聞く",
  PROBLEM_SOLVING: "困りごとを具体的に言葉にしてもらい、今日話したいものを選んでもらう",
  PSYCHOEDUCATION: "心や体に出ている様子を具体的に聞く",
  LISTEN_ONLY: "問いは減らすが、相談者の直前の言葉を使った「次につながる一言」は必ず付ける",
};
function firstMoveText(modes) {
  const list = (modes ?? []).filter((m) => FIRST_MOVES[m]);
  if (!list.length) return null;
  const others = list.filter((m) => m !== "LISTEN_ONLY");
  if (list.includes("LISTEN_ONLY") && others.length) {
    return `傾聴で受け止めたあと、次の一手に移る:${others.map((m) => FIRST_MOVES[m]).join(" / ")}`;
  }
  return list.map((m) => FIRST_MOVES[m]).join(" / ");
}

// ---- プロンプトに足す「会話の流れ」(フェーズ2のときだけ)----
// text: 相談者の今回の発言。contexts: safetyContext の配列
export function buildFlowBlock(stats, intake, text, contexts) {
  const lines = ["# 会話の流れ(いまの状態。サーバが数えたもの)"];
  if (stats.goal) lines.push(`・インテークで聞いた、本人の期待するゴール:「${stats.goal}」。この会話がそこに向かっているかを意識する。`);
  // 受け止めのみ
  if (stats.listenOnly) {
    const why = stats.listenOnlyReason === "said" ? "本人が「聞いてほしい」とはっきり言った"
      : stats.listenOnlyReason === "chip" ? "本人が「もう少しこのまま話したい」を選んだ" : "インテークのゴールが吐き出すことだけ";
    lines.push(`・いまは問いを減らしてよい(${why})。ただし返事の最後に、相談者の直前の言葉を使った「次につながる一言」を必ず置く。`);
  } else {
    lines.push(`・受け止めだけ(問いも選択肢も無い返事)が、いま${stats.receiveOnlyStreak}回続いている。続けて${RECEIVE_ONLY_MAX}回まで。`);
    if (stats.receiveOnlyStreak >= RECEIVE_ONLY_MAX && !crisisContext(contexts)) {
      lines.push(`  ★ この返事は、問い(1つだけ)・まとめ・進め方を選んでもらう選択肢のどれかにする。受け止めだけで終えない。`);
    }
  }
  // まとめ
  if (stats.lastWasSummary) {
    lines.push("・前のターンでまとめを返した。本人の返事がまとめを認めるもの(合ってる・うん・そう 等)なら、この返事で「ここまで話してみて、何か感じたことってある?」と聞く(気づきを本人の言葉にしてもらう)。"
      + "本人がまとめを直した(そうじゃなくて・ちょっと違う 等)なら、気づきの問いは出さず、直された内容を受け止めるのを先にする。気づきの問いは、まとめが本人の感覚と合ってから。");
  } else if (LOST_MEANING_RE.test(String(text ?? "")) && !crisisContext(contexts)) {
    lines.push("・★ 相談者が、意味を見失ったような言葉を出している(「わからない」「なんで〜してるのか」など)。受け止めを重ねるより、この返事でまとめを提案するか、まとめる(下の「まとめの形」)。");
  }
  // 整理の提案
  if (stats.lastChoice === "G2" && stats.chosen?.id === "G2") {
    lines.push("・本人は「一緒に整理してみたい」を選んだ。この返事は、まとめの形で、ここまでに出てきたことを並べるところから始める。");
  } else if (stats.chosen?.id === "G1") {
    lines.push("・本人は「もう少しこのまま話したい」を選んだ。整理を急がず、続きを聞く。");
  } else if (canOfferOrganize(stats, contexts) && stats.ventTurns >= ORGANIZE_AFTER_TURNS) {
    lines.push(`・★ 本人のゴールに「整理」が入っていて、吐き出す話が${stats.ventTurns}ターン続いている。この返事で、このまま話すか、一緒に整理するかを本人に選んでもらう提案をし、出力の "offer_organize" を true にする(選択肢の文はサーバが付けるので、返事の本文に選択肢を並べない。「このまま話してもいいし、一回整理してみてもいいよ。どっちがいい?」のような一言で終える)。`);
  }
  // 最初の一手
  const fm = firstMoveText(intake?.recommended_mode);
  if (fm && !stats.firstMoveUsed && stats.phase2Index >= 1 && stats.phase2Index <= 3 && !crisisContext(contexts)) {
    const star = stats.phase2Index >= 2 ? "★ " : "";
    lines.push(`・${star}判定した進め方の「最初の一手」をまだ使っていない(フェーズ2の${stats.phase2Index}ターン目。3ターン以内に一度は使う):${fm}。使ったら出力の "mode_first_move" を true にする。本人が拒んだら続けない。`);
  }
  // くり返し
  if (stats.lastEndings.length) {
    lines.push(`・直前の返事の終わり方:${stats.lastEndings.map((e) => (e === "Q" ? "問い" : e.startsWith("他:") ? `「…${e.slice(2)}」` : `「…${e}。」`)).join("、")}。同じ終わり方にしない。`);
  }
  if (stats.effortCount > 0) {
    lines.push("・頑張り・抱え込みへの労い(「ずっと一人で頑張ってきたんだね」と同じ意味の受け止め)は、この会話でもう言った。もう言わない。");
  }
  return lines.join("\n");
}

// 進め方(PHASE2_FLOW_BLOCK)に足す、まとめの形と受け止めの決まり。flow.mjs に置き、generate.mjs から読む
export const FLOW_RULES_BLOCK = `# 受け止めと問い・まとめの決まり
・受け止めだけの返事(問いも選択肢も無い)は、続けて2回まで。3回目は、問い(1つだけ)・まとめ・進め方を選んでもらう選択肢のどれかにする。
  問いを減らしてよいのは、相談者が「聞いてほしいだけ」「アドバイスはいらない」とはっきり言ったときなど、上の「会話の流れ」に書いてあるときだけ。
  自分の推測(「この人は聞いてほしいだけかもしれない」)で問いをやめない。そう感じたら、本人に聞く(例:「いまは聞いてほしい感じかな、それとも一緒に考えたい感じかな?」)。
・問いでない返事でも、最後に「次につながる一言」を置く。相談者の直前の言葉を使う(例:「その時のこと、もう少し聞かせてくれる?」「〇〇と△△、どっちの方が近い?」)。
  「その気持ち、もう少し聞かせてもらえる?」のような、誰にでも言える一言を毎回使い回さない。
・ここでいう問いは、出来事・考え・気持ち・望みを聞くもの。危険度を確かめる問い(方法・時期・場所・どのくらい本気か・二択で程度を確かめる)はしない。
・受け止めの形を回す:くり返し・言い換え・要約・気持ちの明確化・是認・問い。直前2回の返事と同じ終わり方(「〜んだね。」で終わる、など)にしない。
・相談者が使っていない強い言葉(すり減る・限界・逃げ場・取り残され・耐えられない・苦しい・重い・背負う など)を、受け止めの中で足さない。
  相談者が「虚無」と言ったら「虚無」で返す。相談者の言葉より重くしない。
・具体的なことに触れる。相談者が書いた場面・言葉を一つ拾って返す。

# まとめの形
「整理してみたい」「まとめてみたい」と言ったら、そのターンでまとめる(言っただけで別の問いに移らない)。まとめは次の形にする。
1. 「一回まとめてみるね」と断る(または、まとめてよいかを一言たずねる。そのときは、まとめは次のターン)
2. 相談者の言葉を使って、出てきたことを2〜4個並べる(言い換えすぎない。重くしない)
3. 「合ってるかな?」と確かめて終える(問いはこれ1つ。結論を言い切らない)
気づきの問い(「ここまで話してみて、何か感じたことってある?」)は、まとめが合っていると本人が答えた次のターンで聞く。
"did_summarize" は、この形(2〜4個並べて確かめる)を満たしたときだけ true にする。「整理してみたい」と言っただけでは true にしない。`;

// ---- 出力チェック(作り直し1回)----
// 戻り値: 当たった理由の配列(空なら作り直さない)
export function flowCheck(out, stats, contexts) {
  const reply = String(out?.reply ?? "");
  const reasons = [];
  const offered = out?.offer_organize === true && canOfferOrganize(stats, contexts);
  const receiveOnly = !hasQuestion(reply) && !offered;
  if (receiveOnly && stats.receiveOnlyStreak >= RECEIVE_ONLY_MAX && !stats.listenOnly && !crisisContext(contexts)) {
    reasons.push("A受け止めのみの3回目");
  }
  if (EFFORT_RE.test(reply) && stats.recentEffort) reasons.push("B同じ意味の労い");
  const ec = endingClass(reply);
  if (ec !== "Q" && stats.lastEndings.includes(ec)) reasons.push("C終わり方が直前と同じ");
  if (ORGANIZE_SAID_RE.test(reply) && !isValidSummary(reply)) {
    // まとめてよいかをたずねて終えている(最後の問いが まとめ・整理 について)なら当てない
    const lastQ = sentences(reply).filter((s) => /[？?]$/.test(s)).at(-1) ?? "";
    if (!/(まとめ|整理)/.test(lastQ)) reasons.push("D整理すると言ってまとめていない");
  }
  return reasons;
}

const FIX_HINTS = {
  "A受け止めのみの3回目": "受け止めだけの返事が続いています。今回は、相談者の直前の言葉を使った問いを1つ置くか、ここまでの話をまとめの形でまとめてください(危険度を確かめる問いはしない)。",
  "B同じ意味の労い": "「ずっと(一人で)頑張ってきた・背負ってきた・耐えてきた」と同じ意味の受け止めを、直前にも言っています。今回は言わず、相談者が今回書いた具体的な場面や言葉に触れてください。",
  "C終わり方が直前と同じ": "返事の終わり方が直前の返事と同じ形です。終わり方を変えてください(問いで終える・相談者の言葉を短く返す など)。",
  "D整理すると言ってまとめていない": "「整理してみたい」と言ったのに、まとめていません。このターンでまとめの形(相談者の言葉で2〜4個並べて「合ってるかな?」)にしてください。",
};
export function flowFixHint(reasons) {
  return `# 修正指示(会話の流れ)\n${reasons.map((r) => `・${FIX_HINTS[r] ?? r}`).join("\n")}\n相談者が使っていない強い言葉は足さないでください。問いは1つまで。`;
}

// 生成のあとに、モデルの申告を確かめて記録を作る(作り直しの判定のあと)
// 戻り値: { out(did_summarize を確かめたもの), notes(flags に足す記録), offerChoices(組G を付けるか)}
export function finalizeFlow(out, stats, contexts) {
  const notes = [];
  let fixed = out;
  if (out?.did_summarize === true && !isValidSummary(out.reply)) {
    fixed = { ...out, did_summarize: false };
    notes.push(SUMMARY_FORM_FLAG);
  }
  if (out?.mode_first_move === true && !stats.firstMoveUsed) notes.push(FIRST_MOVE_FLAG);
  notes.push(...addedWordNotes(out?.reply, stats.userTexts));
  const offerChoices = out?.offer_organize === true && canOfferOrganize(stats, contexts);
  return { out: fixed, notes, offerChoices };
}

// フェーズ2の出力 JSON に足すもの
export const FLOW_OUTPUT_SCHEMA = `,
  "offer_organize": このまま話すか一緒に整理するかを選んでもらう提案をしたらtrue。それ以外はfalse,
  "mode_first_move": 判定した進め方の「最初の一手」をこの返事で使ったらtrue。それ以外はfalse`;
