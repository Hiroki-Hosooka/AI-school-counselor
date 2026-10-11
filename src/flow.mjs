// ============================================================================
//  会話の流れ(「会話が展開しない問題」と「他人事感」の修正。2026年10月11日に人が確認した設計)
//
//  材料: 相談ログ 16f362dd(docs/review-logs/2026-10-11-16f362dd.md)と、相談した本人の感想
//        (「同じような返され方しかされないと、まともに相手にされていない気がする」「すごく他人事感がある」)
//  設計: docs/design-conversation-flow.md(第1部・第2部)。指示書: docs/prompts/conversation-flow-fix.md・conversation-engagement-fix.md
//  根拠: 石田先生 IS4(「そうなの」の次に一言)・V4・V5(コンプレイナントへの問い)・IS8(一回まとめてみようか)・IS14(熱量を合わせる)、
//        嶋先生 T16(気づきの問い)、嶋石 X3(友達でも親でもない)・X5(相手が主体。本人が自分で気づいていくのを支える)、
//        JILPT 資料の自己一致・診断的な問い(Q4)
//
//  route.ts・scripts/test-persona-regression.mjs・scripts/test-conversation-flow.mjs で同じものを使う。
//  判断はサーバ側(CLAUDE.md 6節)。DB の列は足さない(messages の question_level・summarized・flags・mode・choices から数える)。
//
//  決まり
//   ・受け止めのみ(問いも選択肢も無い返事)は続けて2回まで。3回目は、問い(1つ)・まとめ・選択肢のどれか
//     例外(傾聴): 相談者がはっきり言ったとき(聞いてほしいだけ・アドバイスはいらない等)/インテークのゴールが吐き出すことだけ/
//     チップで「もう少しこのまま話したい」を選んだとき。モデルの推測では切り替えない(人が決めた)
//   ・まとめは「合ってるかな?」で終える。気づきの問い(T16)は次のターン。直されたら、直された内容の受け止めが先
//   ・汎用の受け止めの言葉は、意味でまとめた組ごとに1回の会話で1回まで。一般化(〜って時あるよね)も1回まで
//   ・つなぎ(3〜4ターンに一度)・仮の見立て(条件つき・4ターンに1回まで)・気になったこと(5ターンに1回まで)。
//     出してよいかはサーバが判定してプロンプトに渡す(モデルに数えさせない)
//   ・作り直し(1回だけ)の理由 A 受け止めのみの3回目 / B 汎用の言葉の組の2回目 / D 「整理してみたい」と言ってまとめていない /
//     E 一般化の2回目 / F 人間のふり・AI が感情的になる / G 出してよくない見立て・気になったこと。
//     ログでは 8・11・12 ターンが当たる(人が確認した範囲)
//   ・記録のみ: 同じ終わり方が3回続いた・強い言葉・重さを足す言葉(相談者自身が使った言葉は数えない)・返し方(つなぎ等)
//
//  チップ(組G)の文面は仮(心理士の確認待ち。名前の末尾が _PROVISIONAL)。
//  危機の流れ(段階2の固定の文面・チップ)には関わらない。危機のあと・危機の状態で生成するターンでは、
//  受け止めのみの作り直し・整理の提案・見立て・気になったことは出さない。
// ============================================================================

// ---- 整理・作業の提案のチップ(組G。仮)----
export const CHOICES_G_PROVISIONAL = [
  { id: "G1", label: "もう少しこのまま話したい" },
  { id: "G2", label: "一緒に整理してみたい" },
];
export const FLOW_CHOICE_SET = "G";
export const ORGANIZE_OFFER_MAX = 2;      // 1回の会話で出してよい回数
export const ORGANIZE_AFTER_TURNS = 3;    // 吐き出しのターンがこれだけ続いたら提案する
export const RECEIVE_ONLY_MAX = 2;        // 受け止めのみの上限(続けて)
export const LINK_EVERY = 3;              // つなぎの目安(3〜4ターンに一度)
export const HYPOTHESIS_EVERY = 4;        // 仮の見立ては4ターンに1回まで
export const HYPOTHESIS_AFTER = 3;        // フェーズ2に入って3ターン以上たってから
export const NOTICED_EVERY = 5;           // 気になったことは5ターンに1回まで

// ---- 文の形 ----
export const hasQuestion = (t) => /[？?]/.test(String(t ?? ""));
export const sentencesOf = (t) => String(t ?? "").split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
// 終わり方の形(問い / 〜んだね / 〜よね / 〜ね / 〜よ / それ以外は最後の3文字)
export function endingClass(t) {
  const last = sentencesOf(t).at(-1) ?? "";
  if (/[？?]$/.test(last)) return "Q";
  const b = last.replace(/[。！!…\s]+$/, "");
  if (/んだね$/.test(b)) return "んだね";
  if (/よね$/.test(b)) return "よね";
  if (/ね$/.test(b)) return "ね";
  if (/よ$/.test(b)) return "よ";
  return `他:${b.slice(-3)}`;
}
export const ENDING_LABELS = { Q: "問い", んだね: "〜んだね", よね: "〜よね", ね: "〜ね", よ: "〜よ" };
export const endingLabel = (e) => ENDING_LABELS[e] ?? `「…${String(e).replace(/^他:/, "")}」`;

// ---- 汎用の受け止めの言葉(組ごとに1回の会話で1回まで。組は意味でまとめる)----
// 「頑張ってきたんだね」「踏ん張ってきたんだね」「耐えて頑張ってきたんだね」は同じ組(頑張ってきた)
export const GENERIC_GROUPS = [
  { key: "頑張ってきた", re: /(ずっと|一人|ひとり|自分だけ|会長だから|一人きり).{0,14}(頑張|がんば|抱え|背負|踏ん張|耐え|こらえ|我慢し)|(頑張|がんば|背負|踏ん張|耐え|抱え|持ちこたえ|こらえ|我慢し|やり続け)(って|て|込んで|こんで|続けて)?(き|来)た|(よく|すごく|ずっと|本当に)(頑張|がんば|踏ん張)って(る|い)|踏ん張って(る|い)/ },
  { key: "しんどい", re: /しんど(い|かった)(よね|ね|んだね|よな)/ },
  { key: "大変", re: /大変(だった|だ|なんだ)?(ね|よね|でしょ)/ },
  { key: "つらい", re: /(つら|辛)(い|かった)(よね|ね|んだね)/ },
  { key: "苦しい", re: /苦し(い|かった)(時間|こと)?(だった)?(よね|ね|んだね)/ },
  { key: "無理もない", re: /無理(も|は)?ない(よ|ね)/ },
  { key: "当然・自然", re: /(当然|当たり前|自然な?こと)(だよ|だと思う|だね|なんだよ)/ },
  { key: "わかるよ", re: /(気持ち|それ|すごく)?(わかる|分かる)(よ|なあ|な)/ },
  { key: "汎用の促し", re: /その気持ち、?(もう少し|もっと)聞かせて/ },
  { key: "モヤモヤ・嫌", re: /(モヤモヤ|もやもや)する(よね|ね)|嫌だった(よね|ね)|きつかった(よね|ね)|きつい(よね|ね)/ },
];
export const genericGroupsIn = (t) => GENERIC_GROUPS.filter((g) => g.re.test(String(t ?? ""))).map((g) => g.key);
// 一般化(誰にでもあることとして広げる言い方)。1回の会話で1回まで(心理教育のモードは除く)
export const GENERALIZATION_RE = /(時|とき|こと)って?(も)?ある(よね|よ)|みんな.{0,12}(だよ|よね|あるよ)|誰にでも(ある|起こ)|よくあること/;
// 人間のふり・AI が相談者以上に感情的になる
export const HUMAN_PRETENSE_RE = /(わたし|私|僕|ぼく)も(そういう|同じ|似た|経験|わかる|つらい|辛い|悲しい|苦しい)|わかるよ、?(わたし|私)も|胸が(痛|締め付け|ぎゅっ)|(わたし|私)まで(つらく|悲しく|苦しく)/;
// 見立て・気になったことの言い方(申告が無くても照合する)
const HYPOTHESIS_RE = /もしかして/;
const NOTICED_RE = /(ちょっと|少し)?気になった/;

// 「整理してみたい」「まとめてみたい」と言った
export const ORGANIZE_SAID_RE = /(整理|まとめ)(して)?み(たい|よう|ようか|るね|ます)/;
const CONFIRM_RE = /(合ってる|あってる|合ってた|あってた|ずれてない|ズレてない|ずれてる|違ってたら|ちがってたら|違うところ)/;
// 意味を見失った言葉(ヒントとして使う。決めるのはモデル)
export const LOST_MEANING_RE = /(わから|わかん|分から|分かん)(ない|ん|なく)|なんで.{0,14}(てる|てん|のか|んだろ|るんだ)|何のため|なんのため|意味(が|ある|ない|わかん)/;
// 傾聴に切り替えてよい、相談者のはっきりした言葉
export const LISTEN_ONLY_SAID_RE = /(聞いて(ほしい|欲しい|くれる)だけ|聞いてもらう?だけ|アドバイス(は|とか)?(いらない|要らない|いらん|なしで)|解決(は|とか)?(しなくて|いらない|求めて)|ただ聞いて|吐き出したいだけ|愚痴を?聞いて(ほしい|欲しい))/;

// まとめてよいかをたずねて終えている(最後の問いの、最後の読点のあとが まとめ・整理 について)
export function asksSummaryPermission(reply) {
  const lastQ = sentencesOf(reply).filter((x) => /[？?]$/.test(x)).at(-1) ?? "";
  const lastClause = lastQ.split(/[、,]/).at(-1) ?? "";
  return /(まとめ|整理|並べ)/.test(lastClause);
}

// まとめの形を満たしているか(相談者の言葉で2〜4個並べる + 確かめ)
export function isValidSummary(reply) {
  const t = String(reply ?? "");
  if (!CONFIRM_RE.test(t)) return false;
  const quotes = (t.match(/「[^」]+」/g) ?? []).length;
  const commas = (t.match(/、/g) ?? []).length;
  const dots = (t.match(/・/g) ?? []).length;
  return quotes >= 2 || commas >= 2 || dots >= 1;
}

// ---- 強い言葉(記録のみ。2段。人が決めた)----
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
const INTAKE_SCALE_TEXT_RE = /限界に近い|もう耐えられない/g; // インテークのつらさスケールの選択肢の文は数えない
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
export const SAME_ENDING_FLAG = "記録のみ:同じ終わり方が3回続いた";
export const FLOW_REGEN_PREFIX = "会話の流れで作り直し";
export const MOVES = { link: "つなぎ", hypothesis: "仮の見立て", noticed: "気になったこと", summary: "まとめ", work: "作業の提案" };
export const MOVE_FLAG_PREFIX = "記録のみ:返し方";
export const moveFlag = (move) => `${MOVE_FLAG_PREFIX}(${MOVES[move]})`;
const moveOfFlags = (flags) => {
  const f = (Array.isArray(flags) ? flags : []).find((x) => String(x).startsWith(MOVE_FLAG_PREFIX));
  if (!f) return null;
  return Object.keys(MOVES).find((k) => f === moveFlag(k)) ?? null;
};

// 生成した返事か(危機の流れの固定の文面は数えない)
const isGeneratedAi = (m) => m?.role === "ai" && !m?.crisis;
const hasMode = (m) => Array.isArray(m?.mode) && m.mode.length > 0;
// 危機のあと・危機の状態で生成するターン
export const crisisContext = (contexts) => (contexts ?? []).some((c) => c === "afterCrisis" || c === "crisisGeneration");

// ---- 履歴から数える ----
// hist: そのセッションの messages(古い順)。role・body・question_level・summarized・flags・crisis・mode・choices・choice_set・choice_id
// sess: sessions の行(user_goal・phase・recommended_mode・relation)
// opts.choiceId: このターンに押したチップ / opts.stage: このターンの安全の段階(0/1/2)/ opts.contexts: safetyContext の配列
export function flowStats(hist, sess, opts = {}) {
  const msgs = hist ?? [];
  const contexts = opts.contexts ?? [];
  const ais = msgs.filter(isGeneratedAi);
  let receiveOnlyStreak = 0;
  for (let i = ais.length - 1; i >= 0; i--) {
    const m = ais[i];
    const receiveOnly = m.question_level === "none" && !hasQuestion(m.body) && !(Array.isArray(m.choices) && m.choices.length);
    if (!receiveOnly) break;
    receiveOnlyStreak++;
  }
  const lastEndings = ais.slice(-2).map((m) => endingClass(m.body));
  const lastSentenceCounts = ais.slice(-2).map((m) => sentencesOf(m.body).length);
  const usedGeneric = [...new Set(ais.flatMap((m) => genericGroupsIn(m.body)))];
  const generalizationUsed = ais.some((m) => GENERALIZATION_RE.test(String(m.body ?? "")));
  // フェーズ2の何ターン目か(mode が入った最初の行はインテークを終えたターンなので数えない)
  const modeRows = ais.filter(hasMode).length;
  const phase2Index = sess?.phase === "phase2" ? Math.max(0, modeRows - 1) + 1 : 0;
  const firstMoveUsed = ais.some((m) => Array.isArray(m.flags) && m.flags.includes(FIRST_MOVE_FLAG));
  // 返し方ごとに、前回から何ターンたったか(使っていなければ Infinity)
  const sinceMove = (move) => {
    for (let i = ais.length - 1, n = 1; i >= 0; i--, n++) if (moveOfFlags(ais[i].flags) === move) return n;
    return Infinity;
  };
  const sinceLink = sinceMove("link"), sinceHypothesis = sinceMove("hypothesis"), sinceNoticed = sinceMove("noticed");
  // 組G
  const offers = ais.filter((m) => m.choice_set === FLOW_CHOICE_SET).length;
  const lastAi = ais.at(-1);
  const lastOfferedG = lastAi?.choice_set === FLOW_CHOICE_SET;
  const chosen = lastOfferedG && opts.choiceId ? CHOICES_G_PROVISIONAL.find((c) => c.id === opts.choiceId) ?? null : null;
  const pastChoices = msgs.filter((m) => m.role === "user" && m.choice_set === FLOW_CHOICE_SET).map((m) => m.choice_id);
  const lastChoice = (chosen ? [...pastChoices, chosen.id] : pastChoices).at(-1) ?? null;
  // 吐き出しのターン: フェーズ2で、前回のまとめ・組G・作業の提案のあとに続いている生成した返事の数(インテークを終えたターンは数えない)
  let ventTurns = 0;
  if (sess?.phase === "phase2") {
    for (let i = ais.length - 1; i >= 0; i--) {
      const m = ais[i];
      if (m.summarized || m.choice_set === FLOW_CHOICE_SET || moveOfFlags(m.flags) === "work" || !hasMode(m)) break;
      ventTurns++;
    }
    if (ventTurns > 0 && ventTurns === modeRows) ventTurns--;
  }
  const lastWasSummary = lastAi?.summarized === true;
  // 前回のまとめのあとに、まとめてよいかをもうたずねたか(たずねるのは1回まで。2回目からは、たずねずにまとめる)
  let askedSummaryPermission = false;
  for (let i = ais.length - 1; i >= 0; i--) {
    if (ais[i].summarized) break;
    if (!isValidSummary(ais[i].body) && asksSummaryPermission(ais[i].body)) { askedSummaryPermission = true; break; }
  }
  // 傾聴に切り替えてよいか(この3つのときだけ。モデルの推測では切り替えない)
  const userTexts = msgs.filter((m) => m.role === "user" && !m.choice_set).map((m) => String(m.body ?? ""));
  const goal = String(sess?.user_goal ?? "");
  const goalOrganize = /整理|まとめ|考え|解決|どうしたら|どうすれば/.test(goal);
  const goalVentOnly = /吐き出|聞いて|話したい|聞いてほしい|聞いてもら/.test(goal) && !goalOrganize;
  const listenSaid = userTexts.some((t) => LISTEN_ONLY_SAID_RE.test(t));
  const listenOnly = listenSaid || goalVentOnly || lastChoice === "G1";
  const listenOnlyReason = listenSaid ? "said" : lastChoice === "G1" ? "chip" : goalVentOnly ? "goal" : null;
  const modes = Array.isArray(sess?.recommended_mode) ? sess.recommended_mode : [];
  const workMode = modes.includes("CBT") || modes.includes("PROBLEM_SOLVING");
  const stage = [0, 1, 2].includes(opts.stage) ? opts.stage : 0;
  const crisis = crisisContext(contexts) || stage >= 2;
  // このターンに出してよいか(サーバが判定する)
  const hypothesisAllowed = !crisis && phase2Index > HYPOTHESIS_AFTER && sess?.relation !== "visitor" && sinceHypothesis >= HYPOTHESIS_EVERY;
  const noticedAllowed = !crisis && phase2Index >= 1 && sinceNoticed >= NOTICED_EVERY;
  const linkDue = !crisis && phase2Index >= 2 && sinceLink > LINK_EVERY && userTexts.length >= 3;
  return {
    receiveOnlyStreak, lastEndings, lastSentenceCounts, usedGeneric, generalizationUsed,
    phase2Index, firstMoveUsed, sinceLink, sinceHypothesis, sinceNoticed,
    offers, lastOfferedG, chosen, lastChoice, ventTurns, lastWasSummary, askedSummaryPermission,
    goal, goalOrganize, workMode, listenOnly, listenOnlyReason, userTexts, modes, stage, crisis,
    hypothesisAllowed, noticedAllowed, linkDue,
  };
}

// 押したチップが組G のものか(直前の AI の返事に組G を付けたときだけ)
export function flowChoiceOf(hist, choiceId) {
  const ais = (hist ?? []).filter(isGeneratedAi);
  if (ais.at(-1)?.choice_set !== FLOW_CHOICE_SET || !choiceId) return null;
  const item = CHOICES_G_PROVISIONAL.find((c) => c.id === choiceId);
  return item ? { set: FLOW_CHOICE_SET, id: item.id, label: item.label, input: "button" } : null;
}

// 組G(整理・作業の提案)を出してよいか: ゴールに整理、またはモードが CBT・問題解決
export function canOfferOrganize(stats) {
  return !stats.crisis && (stats.goalOrganize || stats.workMode) && stats.offers < ORGANIZE_OFFER_MAX
    && !stats.lastOfferedG && stats.lastChoice !== "G2";
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

// ---- プロンプト: 決まり(フェーズ2のときだけ。進め方のあとに置く)----
export const FLOW_RULES_BLOCK = `# この人の、この話にしか言えない返事にする(最重要の一つ)
関わっているけれど、相手の話の主役を奪わない距離にする。相手が主体で、本人が自分で話して自分で気づいていくのを支える(X5)。
・返事には、相談者が直前までに書いた具体的なこと(場面・人・出来事・本人の言葉)を少なくとも1つ入れる。気持ちの言葉(しんどい・つらい)だけで返さない。
  相談者の発言に中身が無い(「うん」「わかんない」など)ときは、次につながる一言で返す。
  例(他人事に聞こえる返事 → この人の話にしか言えない返事)
  「すごく苦しい時間だったよね」→「みんなが談笑してる横で、自分だけ手を動かしてるんだね」
  「心がすり減っているんだね」→「『自分しかできない』って、生徒会の中でそう思う場面が多いんだね」
・「しんどいよね」「大変だったね」「つらかったね」「頑張ってきたんだね」「無理もないよ」「すごく苦しかったね」「よく頑張ってるね」のような、
  どの話にも言える受け止めの言葉は、同じ意味のものを1回の会話で1回まで(下の「会話の流れ」に、もう使ったものを書く)。
・「〜って時あるよね」「みんな〜だよ」のように、誰にでもあることとして広げる言い方は、1回の会話で1回まで
  (心理教育の進め方で、体や心の反応を「誰にでも起こる自然な反応」と説明するときは別)。
・相談者が使っていない強い言葉(すり減る・限界・逃げ場・取り残され・耐えられない・苦しい・重い・背負う など)を、受け止めの中で足さない。
  相談者が「虚無」と言ったら「虚無」で返す。相談者の言葉より重くしない。相談者の熱量より、こちらの言葉の熱量を上げない(IS14)。
・毎回同じ型にしない。相手の発言が短く、受け止めるだけで十分なときは一言の返事でもよい。受け止めの形を回す
  (くり返し・言い換え・要約・気持ちの明確化・是認・問い)。同じ終わり方(「〜んだね。」など)を続けない。
・人間のふりをしない(「わたしもそういう経験がある」「わかるよ、わたしも」と言わない)。相談者以上に感情的にならない(「わたしもつらい」「胸が痛い」と言わない)。
  友達でも親でもない一線を保つ(X3)。ずっと一緒にいる・いつでも話せると約束しない。このAIだけを頼らせる言い方をしない。

# 受け止めと問い
・受け止めだけの返事(問いも選択肢も無い)は、続けて2回まで。3回目は、問い(1つだけ)・まとめ・進め方を選んでもらう選択肢のどれかにする。
  問いを減らしてよいのは、下の「会話の流れ」にそう書いてあるときだけ(相談者がはっきり「聞いてほしいだけ」と言った等)。
  自分の推測(「この人は聞いてほしいだけかもしれない」)で問いをやめない。そう感じたら、本人に聞く(例:「いまは聞いてほしい感じかな、それとも一緒に考えたい感じかな?」)。
・問いでない返事でも、最後に「次につながる一言」を置く。相談者の直前の言葉を使う(例:「その時のこと、もう少し聞かせてくれる?」「〇〇と△△、どっちの方が近い?」)。
  「その気持ち、もう少し聞かせてもらえる?」のような、誰にでも言える一言を使い回さない。
・ここでいう問いは、出来事・考え・気持ち・望みを聞くもの。危険度を確かめる問いや見立て(方法・時期・場所・どのくらい本気か・二択で程度を確かめる)はしない。

# 関わり方の選択肢(1回の返事で使うのは、この中から1つまで。どれも問いの代わりなので、同じ返事に別の問いを足さない)
・つなぎ(link): 前に言ったことと今の言葉を結びつけ、結論を言わずに本人に確かめる。
  例:「さっき『会長だから』って言ってたけど、『自分しかできない』っていうのも、そこにつながってる感じがする?」
・仮の見立て(hypothesis): 「もしかして〜?」の形で、言い切らずに確かめる。仮説は仮説にとどめる。本人が否定したら引っ込め、否定の内容を次の話として受ける。
  誰かを悪く言う見立てにしない(同調しない)。危険度についての見立ては出さない。下の「会話の流れ」で出してよいときだけ。
  例:「もしかして、しんどいのは仕事の量そのものより、『誰も一緒にやってくれない』ってところの方が大きい?」
・気になったこと(noticed): 相談者の具体的な言葉に対して、聞き手として気になったことを正直に、短く言う(自己一致)。下の「会話の流れ」で言ってよいときだけ。
  例:「『なんで頑張ってるのかわからない』って言葉、ちょっと気になった。」
・まとめ(summary): 下の「まとめの形」。
・作業の提案(work): 何をするかがわかる形で、一緒に作業することを提案する。例:「生徒会で『一人だな』って感じる場面、いくつか一緒に並べてみない?」
  作業を始めたら、こちらも手を動かす(出てきた場面を並べ直す・共通点を確かめる問いを出す)。相談者にだけ書かせない。
使ったら出力の "move" に link / hypothesis / noticed / summary / work のどれかを入れる(使わなければ none)。

# まとめの形
「整理してみたい」「まとめてみたい」と言ったら、そのターンでまとめる(言っただけで別の問いに移らない)。まとめは次の形にする(IS8・T16)。
1. 「一回まとめてみるね」と断る(たずねる形にするのは1回まで。たずねたら、次のターンでは、たずね直さずにまとめる)
2. 相談者の言葉を使って、出てきたことを2〜4個並べる(言い換えすぎない。重くしない)
3. 「合ってるかな?」と確かめて終える(問いはこれ1つ。結論を言い切らない)
気づきの問い(「ここまで話してみて、何か感じたことってある?」)は、まとめが合っていると本人が答えた次のターンで聞く。
"did_summarize" は、この形(2〜4個並べて確かめる)を満たしたときだけ true にする。「整理してみたい」と言っただけでは true にしない。`;

// ---- プロンプト: いまの状態(フェーズ2のときだけ。サーバが数えたもの)----
// text: 相談者の今回の発言
export function buildFlowBlock(stats, intake, text) {
  const lines = ["# 会話の流れ(いまの状態。サーバが数えたもの)"];
  if (stats.goal) lines.push(`・インテークで聞いた、本人の期待するゴール:「${stats.goal}」。この会話がそこに向かっているかを意識する。`);
  if (stats.crisis) {
    lines.push("・いまは危機のあとの状態。仮の見立て・気になったこと・作業の提案はしない。上の危機のあとの指示を優先する。");
  }
  // 受け止めのみ
  if (stats.listenOnly) {
    const why = stats.listenOnlyReason === "said" ? "本人が「聞いてほしい」とはっきり言った"
      : stats.listenOnlyReason === "chip" ? "本人が「もう少しこのまま話したい」を選んだ" : "インテークのゴールが吐き出すことだけ";
    lines.push(`・いまは問いを減らしてよい(${why})。ただし返事の最後に、相談者の直前の言葉を使った「次につながる一言」を必ず置く。`);
  } else {
    lines.push(`・受け止めだけ(問いも選択肢も無い返事)が、いま${stats.receiveOnlyStreak}回続いている。続けて${RECEIVE_ONLY_MAX}回まで。`);
    if (stats.receiveOnlyStreak >= RECEIVE_ONLY_MAX && !stats.crisis) {
      lines.push("  ★ この返事は、問い(1つだけ)・まとめ・進め方を選んでもらう選択肢のどれかにする。受け止めだけで終えない。");
    }
  }
  // まとめ
  if (stats.lastWasSummary) {
    lines.push("・前のターンでまとめを返した。本人の返事がまとめを認めるもの(合ってる・うん・そう 等)なら、この返事で「ここまで話してみて、何か感じたことってある?」と聞く。"
      + "本人がまとめを直した(そうじゃなくて・ちょっと違う 等)なら、気づきの問いは出さず、直された内容を受け止めるのを先にする。気づきの問いは、まとめが本人の感覚と合ってから。");
  } else if (stats.askedSummaryPermission && !stats.crisis) {
    lines.push("・★ 前の返事で、まとめてよいかをもうたずねている。もうたずねない。本人が嫌がっていなければ、この返事で「一回まとめてみるね」と断って、まとめの形でまとめる。");
  } else if (LOST_MEANING_RE.test(String(text ?? "")) && !stats.crisis) {
    lines.push("・★ 相談者が、意味を見失ったような言葉を出している(「わからない」「なんで〜してるのか」など)。受け止めを重ねるより、この返事で「一回まとめてみるね」と断って、まとめる(「まとめの形」)。");
  }
  // 整理・作業の提案(組G)
  if (stats.chosen?.id === "G2") {
    lines.push("・本人は「一緒に整理してみたい」を選んだ。この返事で、そのまま一緒に作業を始める(ここまでに出てきた場面や言葉を、相談者の言葉で並べて見せ、確かめる問いを1つ)。相談者にだけ書かせない。");
  } else if (stats.chosen?.id === "G1") {
    lines.push("・本人は「もう少しこのまま話したい」を選んだ。整理を急がず、続きを聞く。");
  } else if (canOfferOrganize(stats) && stats.ventTurns >= ORGANIZE_AFTER_TURNS) {
    lines.push(`・★ 吐き出す話が${stats.ventTurns}ターン続いている(本人のゴール・進め方から、一緒に整理する作業が合う)。この返事で、何をするかがわかる形で作業を提案し、このまま話すか一緒に整理するかを本人に選んでもらう。出力の "offer_organize" を true、"move" を work にする。選択肢の文はサーバが付けるので、本文に選択肢を並べない。`);
  }
  // 最初の一手
  const fm = firstMoveText(intake?.recommended_mode);
  if (fm && !stats.firstMoveUsed && stats.phase2Index >= 1 && stats.phase2Index <= 3 && !stats.crisis) {
    const star = stats.phase2Index >= 2 ? "★ " : "";
    lines.push(`・${star}判定した進め方の「最初の一手」をまだ使っていない(フェーズ2の${stats.phase2Index}ターン目。3ターン以内に一度は使う):${fm}。使ったら出力の "mode_first_move" を true にする。本人が拒んだら続けない。`);
  }
  // 関わり方の選択肢
  const allowed = [];
  if (stats.linkDue) allowed.push("つなぎ(そろそろ前の発言と今の発言を結びつけるとよい)");
  if (stats.hypothesisAllowed) allowed.push("仮の見立て(出してよい)");
  if (stats.noticedAllowed) allowed.push("気になったこと(言ってよい)");
  lines.push(`・関わり方の選択肢:${allowed.length ? allowed.join("、") : "このターンは特に無し"}。`
    + `${stats.hypothesisAllowed ? "" : "仮の見立ては、このターンは出さない。"}${stats.noticedAllowed ? "" : "気になったことは、このターンは言わない。"}`);
  // くり返し
  if (stats.usedGeneric.length) {
    lines.push(`・この会話でもう使った汎用の受け止め:${stats.usedGeneric.map((k) => `「${k}」`).join("、")}。同じ意味のものはもう言わない。`);
  }
  if (stats.generalizationUsed) lines.push("・誰にでもあることとして広げる言い方(〜って時あるよね 等)は、この会話でもう使った。もう言わない。");
  if (stats.lastEndings.length) {
    lines.push(`・直前の返事の終わり方と文の数:${stats.lastEndings.map((e, i) => `${endingLabel(e)}(${stats.lastSentenceCounts[i]}文)`).join("、")}。同じ型を続けない。`);
  }
  return lines.join("\n");
}

// ---- 出力チェック(作り直し1回)----
// 戻り値: 当たった理由の配列(空なら作り直さない)
export function flowCheck(out, stats) {
  const reply = String(out?.reply ?? "");
  const reasons = [];
  const offered = out?.offer_organize === true && canOfferOrganize(stats);
  if (!hasQuestion(reply) && !offered && stats.receiveOnlyStreak >= RECEIVE_ONLY_MAX && !stats.listenOnly && !stats.crisis) {
    reasons.push("A受け止めのみの3回目");
  }
  const dupGeneric = genericGroupsIn(reply).filter((k) => stats.usedGeneric.includes(k));
  if (dupGeneric.length) reasons.push(`B汎用の言葉の2回目(${dupGeneric.join("・")})`);
  if (ORGANIZE_SAID_RE.test(reply) && !isValidSummary(reply)) {
    // まとめてよいかをたずねて終えている(最後の問いが まとめ・整理 について)なら、1回目は当てない
    // (「一回整理してみたいんだけど、どんな場面が多い?」のように、同じ文の中で別の問いに移ったものは当てる)
    if (!asksSummaryPermission(reply)) reasons.push("D整理すると言ってまとめていない");
  }
  // まとめてよいかを、2回続けてたずねない(相談ログの再生で、たずねるだけが5回続いた。2026年10月11日)
  if (stats.askedSummaryPermission && asksSummaryPermission(reply) && !isValidSummary(reply)) reasons.push("Dまとめてよいかを2回たずねた");
  if (GENERALIZATION_RE.test(reply) && stats.generalizationUsed && !stats.modes.includes("PSYCHOEDUCATION")) reasons.push("E一般化の2回目");
  if (HUMAN_PRETENSE_RE.test(reply)) reasons.push("F人間のふり・感情的");
  const move = out?.move;
  if (!stats.hypothesisAllowed && (move === "hypothesis" || HYPOTHESIS_RE.test(reply))) reasons.push("G出してよくない見立て");
  if (!stats.noticedAllowed && (move === "noticed" || NOTICED_RE.test(reply))) reasons.push("G出してよくない気になったこと");
  return reasons;
}

const FIX_HINTS = {
  A: "受け止めだけの返事が続いています。今回は、相談者の直前の言葉を使った問いを1つ置くか、ここまでの話をまとめの形でまとめてください(危険度を確かめる問いはしない)。",
  B: "どの話にも言える受け止めの言葉(しんどいよね・頑張ってきたんだね・無理もないよ など)と同じ意味のものを、この会話ですでに言っています。今回は言わず、相談者が今回書いた具体的な場面や言葉に触れてください。",
  D: "まとめると言った(または、まとめてよいかをもうたずねた)のに、まとめていません。たずねずに「一回まとめてみるね」と断って、このターンでまとめの形(相談者の言葉で2〜4個並べて「合ってるかな?」)にしてください。",
  E: "誰にでもあることとして広げる言い方を、この会話ですでに使っています。今回は使わないでください。",
  F: "人間のふりをする言い方、または相談者以上に感情的な言い方が入っています。こちらの経験や感情を語らず、相談者の言葉に戻ってください。",
  G: "このターンは、仮の見立て(「もしかして〜?」)・気になったこと(「気になった」)は出さないでください。",
};
export function flowFixHint(reasons) {
  const keys = [...new Set(reasons.map((r) => r[0]))];
  return `# 修正指示(会話の流れ)\n${keys.map((k) => `・${FIX_HINTS[k] ?? k}`).join("\n")}\n相談者が使っていない強い言葉は足さないでください。問いは1つまで。`;
}

// 生成のあとに、モデルの申告を確かめて記録を作る(作り直しの判定のあと)
// 戻り値: { out(did_summarize を確かめたもの), notes(flags に足す記録), offerChoices(組G を付けるか)}
export function finalizeFlow(out, stats) {
  const notes = [];
  let fixed = out;
  const reply = String(out?.reply ?? "");
  if (out?.did_summarize === true && !isValidSummary(reply)) {
    fixed = { ...out, did_summarize: false };
    notes.push(SUMMARY_FORM_FLAG);
  }
  if (out?.mode_first_move === true && !stats.firstMoveUsed) notes.push(FIRST_MOVE_FLAG);
  const offerChoices = out?.offer_organize === true && canOfferOrganize(stats);
  // 返し方の記録(申告と、まとめの確かめ・組G の結果から)
  let move = Object.keys(MOVES).includes(out?.move) ? out.move : null;
  if (fixed?.did_summarize === true) move = "summary";
  else if (move === "summary") move = null;
  if (offerChoices) move = "work";
  if (move) notes.push(moveFlag(move));
  // 同じ終わり方が3回続いた(記録のみ)
  const ec = endingClass(reply);
  if (ec !== "Q" && stats.lastEndings.length === 2 && stats.lastEndings.every((e) => e === ec)) {
    notes.push(`${SAME_ENDING_FLAG}(${endingLabel(ec)})`);
  }
  notes.push(...addedWordNotes(reply, stats.userTexts));
  return { out: fixed, notes, offerChoices };
}

// フェーズ2の出力 JSON に足すもの
export const FLOW_OUTPUT_SCHEMA = `,
  "move": "none または link または hypothesis または noticed または summary または work",
  "offer_organize": このまま話すか一緒に整理するかを選んでもらう提案をしたらtrue。それ以外はfalse,
  "mode_first_move": 判定した進め方の「最初の一手」をこの返事で使ったらtrue。それ以外はfalse`;

// 管理画面・検証で使う集計(本文と flags から。DB の列は使わない)
export function flowSummaryOfSession(hist) {
  const ais = (hist ?? []).filter(isGeneratedAi);
  const sentenceDist = {};
  const endingDist = {};
  let maxSameEnding = 0, run = 0, prev = null;
  let maxReceiveOnly = 0, ro = 0;
  for (const m of ais) {
    const n = sentencesOf(m.body).length;
    sentenceDist[n] = (sentenceDist[n] ?? 0) + 1;
    const e = endingClass(m.body);
    endingDist[e] = (endingDist[e] ?? 0) + 1;
    run = e !== "Q" && e === prev ? run + 1 : e !== "Q" ? 1 : 0;
    prev = e;
    maxSameEnding = Math.max(maxSameEnding, run);
    const receiveOnly = m.question_level === "none" && !hasQuestion(m.body) && !(Array.isArray(m.choices) && m.choices.length);
    ro = receiveOnly ? ro + 1 : 0;
    maxReceiveOnly = Math.max(maxReceiveOnly, ro);
  }
  const genericCounts = {};
  for (const m of ais) for (const k of genericGroupsIn(m.body)) genericCounts[k] = (genericCounts[k] ?? 0) + 1;
  const genericRepeats = Object.values(genericCounts).reduce((a, c) => a + Math.max(0, c - 1), 0);
  return { sentenceDist, endingDist, maxSameEnding, maxReceiveOnly, genericCounts, genericRepeats };
}

// ---- 管理画面(admin.html)に出す、返事ごとの会話の流れ(サーバで作る。画面は表示だけ)----
// msgs: messages(古い順。created_at・safety_stage を含む)/ events: safety_events(古い順)
// 返事ごとに: 安全の段階と根拠(このターンの safety_events から。段階の列が無い DB では risk から 0/1/2 に読み替える)・
// 受け止めのみの連続・前回のまとめから何ターンか・文の数・終わり方・返し方
const riskStage = (r) => (r === "crisis" ? 2 : r === "watch" ? 1 : 0);
export function annotateForAdmin(msgs, events) {
  const evs = events ?? [];
  let lastUserAt = null, prevAiAt = null;
  let streak = 0, sinceSummary = 0, crisisSeen = false;
  const out = (msgs ?? []).map((m) => {
    if (m.role === "user") { lastUserAt = m.created_at; return { ...m }; }
    const from = lastUserAt ?? prevAiAt;
    const turnEvents = evs.filter((e) => (!from || e.created_at >= from) && (!m.created_at || e.created_at <= m.created_at)
      && (!prevAiAt || e.created_at > prevAiAt));
    prevAiAt = m.created_at;
    const evStage = turnEvents.length ? Math.max(...turnEvents.map((e) => (typeof e.stage === "number" ? e.stage : riskStage(e.risk)))) : null;
    const stage = typeof m.safety_stage === "number" ? m.safety_stage : evStage ?? (m.crisis ? 2 : 0);
    const basis = [...new Set(turnEvents.flatMap((e) => (Array.isArray(e.decided_by) && e.decided_by.length ? e.decided_by
      : [...(Array.isArray(e.keywords) && e.keywords.length ? [`keywords:${e.keywords.join("・")}`] : []), ...(e.model_risk ? [`model:${e.model_risk}`] : [])])))];
    const view = { stage, basis, afterCrisis: crisisSeen && !m.crisis };
    if (m.crisis) crisisSeen = true;
    if (!m.crisis) {
      const receiveOnly = m.question_level === "none" && !hasQuestion(m.body) && !(Array.isArray(m.choices) && m.choices.length);
      streak = receiveOnly ? streak + 1 : 0;
      sinceSummary = m.summarized ? 0 : sinceSummary + 1;
      Object.assign(view, {
        receiveOnlyStreak: streak, sinceSummary, sentences: sentencesOf(m.body).length,
        ending: endingLabel(endingClass(m.body)), move: moveOfFlags(m.flags), generic: genericGroupsIn(m.body),
      });
    }
    return { ...m, flow_view: view };
  });
  const summary = flowSummaryOfSession(msgs);
  return {
    messages: out,
    flow_summary: { ...summary, endingDist: Object.fromEntries(Object.entries(summary.endingDist).map(([k, v]) => [endingLabel(k), v])) },
  };
}

// 「違和感があった」の理由(管理画面のチップ)
export const DISCOMFORT_REASONS = ["同じ返し", "他人事", "重すぎる", "その他"];

// ---- 検証・ペルソナテストの自動判定で使う指標(本文と記録から)----
// 合格の目安(2026年10月11日に人が仮に採用。最初の1回を回したあとに見直す。最終の判断は人がログを読んで行う)
export const FLOW_PASS_TARGETS = { maxReceiveOnly: 2, summaryMinTurns: 10, firstMoveWithin: 3, concreteRate: 0.7, genericRepeats: 0, maxSameEnding: 2 };
export function conversationMetrics(hist) {
  const msgs = hist ?? [];
  const ais = msgs.filter(isGeneratedAi);
  const base = flowSummaryOfSession(msgs);
  const flagsOf = (m) => (Array.isArray(m.flags) ? m.flags.map(String) : []);
  const regenFlags = ais.flatMap((m) => flagsOf(m).filter((f) => f.startsWith(FLOW_REGEN_PREFIX)));
  // フェーズ2の何ターン目に最初の一手が出たか(mode が入った最初の行はインテークを終えたターン)
  let p2 = 0, firstMoveAt = null, phase2Turns = 0;
  const summaryAt = [];
  ais.forEach((m, i) => {
    if (hasMode(m)) { p2++; if (p2 >= 2) phase2Turns++; }
    const idx = p2 >= 2 ? p2 - 1 : 0;
    if (firstMoveAt == null && flagsOf(m).includes(FIRST_MOVE_FLAG)) firstMoveAt = idx;
    if (m.summarized) summaryAt.push(i + 1);
  });
  const strong = ais.flatMap((m) => flagsOf(m).filter((f) => f.startsWith(STRONG_FLAG)));
  const heavy = ais.flatMap((m) => flagsOf(m).filter((f) => f.startsWith(HEAVY_FLAG)));
  const moves = {};
  for (const m of ais) { const mv = moveOfFlags(m.flags); if (mv) moves[mv] = (moves[mv] ?? 0) + 1; }
  return {
    aiTurns: ais.length, ...base, regenCount: regenFlags.length, regenFlags,
    summaries: summaryAt.length, summaryAt, firstMoveAt, phase2Turns,
    strongCount: strong.length, heavyCount: heavy.length, strongFlags: strong, heavyFlags: heavy, moves,
  };
}
