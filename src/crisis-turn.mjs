// ============================================================================
//  本人の危機への返事を「強く縛った生成」で行う(2026年11月1日・危機の作り直し 第3部。docs/design-crisis-rework.md)
//
//  【仮】指示と文面はすべて仮(心理士の確認待ち)。
//  レビュー(相談ログ 1d0a0511・86130eef・55932e90。docs/review-logs/2026-10-28-*)で、固定の返事がどれも同じに見え、
//  書いたことに返事をしてもらえない・危機のあと会話が成り立たない、という指摘があった。そこで、
//    固定のまま残すもの: 種類ごとの窓口のカード(src/crisis-types.mjs・page.tsx)・条件つきの安全の一行(下)・職員への通知と記録
//    生成にするもの    : 受け止め・問い・人につなぐ話(このファイルの指示と、出力チェックで縛る)
//  設定 CRISIS_REPLY_MODE=fixed のときだけ、以前の固定応答(src/crisis-texts.mjs の buildCrisisReply)に戻る。
//  このファイルは何も読み込まない。
// ============================================================================

export const crisisReplyMode = () => (process.env.CRISIS_REPLY_MODE === "fixed" ? "fixed" : "generate");

// 条件つきの安全の一行(固定・仮。指示書の文のまま)。希死念慮・自傷・種類不明の本人の危機のときに、窓口のカードの上に出す
export const CRISIS_SAFETY_LINE_PROVISIONAL =
  "もし今すぐ自分を傷つけてしまいそうなときは、危ないものから少し離れて、誰かのそばにいてね。もう何かしてしまったときは、すぐに119に電話してね。";
export const SAFETY_LINE_FLAG = "安全の一行";
// 危機の状態で生成した返事の印(生成の会話履歴に含める・管理画面で見分ける)
export const CRISIS_GEN_FLAG = "危機の応答(生成)";
// 窓口のカードを出した印(種類つき。同じカードをくり返さないため)
export const CRISIS_CARD_FLAG = "窓口のカード";

const flagsOf = (m) => (Array.isArray(m?.flags) ? m.flags.map(String) : []);

// 安全の一行を出すか: 希死念慮・自傷・種類不明(本人)で、この会話の直近8つの AI の返事に出していないとき
export function needsSafetyLine(types, hist) {
  const t = types ?? [];
  if (t.length && !t.includes("suicidal") && !t.includes("selfharm")) return false;
  const recent = (hist ?? []).filter((m) => m?.role === "ai").slice(-8);
  return !recent.some((m) => flagsOf(m).includes(SAFETY_LINE_FLAG));
}

// 窓口のカードを出すか: この会話で初めての本人の危機か、まだカードに出していない種類があるとき
export function needsCrisisCard(types, hist) {
  const shown = new Set();
  let any = false;
  for (const m of hist ?? []) {
    if (m?.role !== "ai") continue;
    if (m.crisis === true && !flagsOf(m).includes(CRISIS_GEN_FLAG)) any = true; // 以前の固定応答(カードつき)
    for (const f of flagsOf(m)) {
      if (!f.startsWith(`${CRISIS_CARD_FLAG}: `)) continue;
      any = true;
      f.slice(CRISIS_CARD_FLAG.length + 2).split(",").filter(Boolean).forEach((x) => shown.add(x));
    }
  }
  if (!any) return true;
  return (types ?? []).some((t) => !shown.has(t));
}
export const crisisCardFlag = (types) => `${CRISIS_CARD_FLAG}: ${(types ?? []).join(",") || "unknown"}`;

// 怒りの中で書かれているか(「死んでやる」・強い怒りの言葉・感嘆符の連続)。受け止めを怒りに合わせる
const ANGER_RE = /死んでやる|しんでやる|ふざけ|むかつ|ムカつ|腹(が)?立|はらたつ|許せな|ゆるせな|うざ|ウザ|クソ|くそ|[!！]{2,}/;
export const angerIn = (text) => ANGER_RE.test(String(text ?? ""));

// 種類ごとの受け止めの向き(仮)
const TYPE_GUIDE = {
  suicidal: "死にたい・消えたいほどの気持ちを、否定も驚きもせずに受け止める。そう思うほどの何があったのかに目を向ける",
  selfharm: "自分を傷つけることを責めない・「やめて」と言わない。そうしないといられないほどのつらさとして受け止める。笑いや軽い書き方でも軽く扱わない",
  abuse: "暴力を受けたり見たりしていることは、相談者が我慢しなければならないことではない、と伝える。相談者の安全がいちばん大事だという姿勢で受け止める。暴力をふるう人の人柄を評価しない",
  bullying: "いじめを受けていることは、相談者が我慢しなければならないことではない、と伝える。相手の人柄を評価しない",
  other: "身近な人のことを心配して、ひとりで抱えている気持ちを受け止める。その人の状態を根掘り葉掘り聞かない",
};
const TYPE_JA = { suicidal: "死にたい・消えたい気持ち", selfharm: "自分を傷つけること", abuse: "暴力・虐待(家での暴力を見ていることを含む)", bullying: "重大ないじめ", other: "身近な人の危機" };

// 本人の危機のターンの指示(仮)。first = この会話で初めての本人の危機か
export function buildCrisisTurnBlock({ types = [], first = true, anger = false } = {}) {
  const kinds = types.length ? types.map((t) => TYPE_JA[t]).filter(Boolean).join("・") : "種類ははっきりしない";
  const guides = types.map((t) => TYPE_GUIDE[t]).filter(Boolean);
  return `

# 今回のターンについて(重要・相談者自身の深刻なサイン)
今回の発言に、相談者自身の深刻なサインがありました(${kinds})。職員への知らせと、話せる窓口のカードは、サーバが別に出します。
あなたは、この人が書いたことに、あなたの言葉で返事をします。
・相談者が書いた具体的な言葉や出来事に触れて受け止める。決まり文句(「よく言えたね」「書いてくれてありがとう」だけ等)で済ませない。
  ただし、相談者の文をほぼそのまま言い直して始めない・「」で丸ごと引用しない。拾うなら一番気持ちのこもった一語か一句だけ
${guides.map((g) => `・${g}`).join("\n")}
${anger ? "・怒りの中で書かれています。まず怒り・悔しさ・やりきれなさを受け止める(「それくらい腹が立っている」など)。命のことだけを取り出して心配を並べない\n" : ""}${first
    ? "・今回は、いまいちばんつらいこと・困っていることを聞く問いを1つだけして終える。人につなぐ話(先生・窓口など)はまだしない"
    : "・この会話では前にも深刻なサインがありました。同じ受け止めをくり返さず、いま書かれたことに返す"}
・方法・時期・場所・どのくらい本気かを聞かない。程度を二択で確かめない
・秘密を守ると約束しない(「言いふらさない」「誰にも言わない」など)。AI ができないこと(先生に伝える等)を約束しない
・「重い」「受け止めきれない」「ここでは扱えない」など、AI の限界や負担で区切らない。AI から会話を終わらせない
・「いつでも」と言わない。このAIだけを頼りにさせない
・窓口の名前や電話番号は書かない(カードで出す)
・2〜3文。最後は問いか、続きを促す一言で終える`;
}

// 相談者が自分から挙げた、話せそうな人(例:「家政婦さんはいる」「一番見てくれているのは家政婦さんだけ」)。新しい順に2人まで
const NAME_RE = /([一-龯ァ-ヶー]{1,6}(さん|ちゃん|くん|先輩|先生)|おばあちゃん|おじいちゃん|ばあちゃん|じいちゃん|おばさん|おじさん|お姉ちゃん|お兄ちゃん|いとこ)/g;
const CONFIDANT_CUE = /いる|居る|話せ|言え|相談でき|相談しよう|相談するべき|相談すべき|相談してみ|見てくれ|わかってくれ|分かってくれ|味方|信頼|頼れ|聞いてくれ/;
const CONFIDANT_NO = /話せな|言えな|頼れな|信用できな|嫌い|きらい|こわい|怖い|うざ|いない/;
export function confidantsFrom(hist, text) {
  const found = [];
  const msgs = [...(hist ?? []).filter((m) => m?.role === "user" && !m.choice_id).map((m) => String(m.body ?? "")), String(text ?? "")];
  for (const body of msgs) {
    for (const clause of body.split(/[。！？!?\n]/)) {
      if (!CONFIDANT_CUE.test(clause) || CONFIDANT_NO.test(clause)) continue;
      for (const m of clause.matchAll(NAME_RE)) if (!found.includes(m[1])) found.push(m[1]);
    }
  }
  return found.slice(-2);
}
export function confidantBlock(names) {
  if (!names?.length) return "";
  const n = names.join("・");
  return `

# 相談者が自分から挙げた、話せそうな人(重要)
相談者は「${n}」のことを、話せそう・見てくれている人として挙げています。
・人につなぐ話をするときは、まず${n}を挙げる。先生や窓口に置き換えない
・${n}に話すとしたら、どんなふうに話せそうか・何から話せそうかを、一緒に考える`;
}

// 人につなぐ問いを、このターンでたずねるか(危機のあと・2回目以降の返事・まだたずねていない・大人と窓口を断っていない)
const CONNECT_ASKED_RE = /一緒に考えてほしい|話してみたいって思う|まわりの大人に話して/;
export function connectAskDue(hist, declined = []) {
  const ais = (hist ?? []).filter((m) => m?.role === "ai");
  const firstCrisis = ais.findIndex((m) => m.crisis === true);
  if (firstCrisis < 0) return false;
  if (ais.some((m) => CONNECT_ASKED_RE.test(String(m.body ?? "")))) return false;
  if (["teacher", "parent", "counselor", "nurse", "hotline"].every((p) => (declined ?? []).includes(p))) return false;
  return ais.length - firstCrisis >= 2;
}
export function connectAskBlock(names) {
  const who = names?.length ? `${names.join("・")}と` : "誰かと";
  return `

# 今回のターンで(人につなぐ問い)
受け止めのあとに、「${who}一緒に考えてほしいなと思うんだけど、どう思う?」とたずねる(この1つだけを問いにする)。
答えを急がせない。先生に伝える等、AI ができないことは約束しない`;
}
