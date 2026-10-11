// ============================================================================
//  危機検知の作り直し 第2段階: 段階ごとの応答(2026年9月)と、危機の流れの見直し(嶋先生 10/7。2026年10月9日)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ 【仮】このファイルの文面・選択肢・指示は、すべて仮のもの(心理士の確認待ち)。  │
//  │  名前の末尾が _PROVISIONAL の定数が仮の文面・指示。                          │
//  │  設定 CRISIS_RESPONSE=staged のときだけ使う(既定は無効)。心理士の確認が取れる │
//  │  まで、本番(main)では有効にしないこと。                                      │
//  │  例外: 危機のあとの指示(AFTER_CRISIS_BLOCK_PROVISIONAL)だけは、本番の既定でも │
//  │  使う(2026年10月5日に人が決めた。仮のまま。CLAUDE.md 5.17)。               │
//  │  本番の固定応答の「〜が心配」の文面は src/crisis-texts.mjs(ここから再エクスポート)│
//  └──────────────────────────────────────────────────────────────┘
//
//  無効のときは第1段階と同じ動き(段階2 = 本番の固定応答、段階1 = 今の Tier B)。ただし、
//  固定応答を出したセッションでは、以後の生成に危機のあとの指示を付ける(下の aftercareEnabled / hadCrisisReply /
//  defaultSafetyContexts。設定 CRISIS_AFTERCARE=off のときだけ以前の動きに戻る)。
//  有効にする前に db/schema.sql の11節〜14節(状態と記録の列)を Supabase で実行しておくこと。
//
//  仕組み(2026年10月9日に人が確認した設計。docs/design-crisis-flow-shima3.md・docs/prompts/crisis-flow-shima3.md)
//   段階1(気がかり)… 生成で会話を続ける(Tier B の指示つき)。見守りを始めるターンだけ、返事の下に
//                     「気づかいの一言+折りたたみの窓口」のカードを添える(一言は1セッション1回まで)。以後3ターンは見守り。
//                     見守り中に本人の言葉によるサイン(分類器の watch・誇張の除外)がもう一度出たら段階2に上げる。
//   段階2(危機)  … 生成せず、固定の文面を出す(CLAUDE.md 5.2)。
//                     (2026年10月11日に人が決めた)最初のターンで、受け止め → 「〜が、とても心配です」(危機カード)→
//                     「どうしてここでなら話そうと思えたのか」の問い(組Wのチップ)の3つを、間をおいて1つずつ出す →
//                     答えを受け止める一言 + 3通目「相談先や大人に話したいか」→
//                     (積み重なりで始めたときは、今までどおり受け止めだけの1通目 → 2通目と3通目)
//                     答えで分ける: 話したい・どちらでもない → 一言を返して、そのあとは生成 /
//                     話したくない → 受け止め+組B(2択)のチップ → B1(このやり取りがうっとうしい)なら深追いせず生成 /
//                     B2(人とつながるのはおっくう。でも聞いてほしい)なら組C(「話せない」の背景)のチップ → 選んだものを受け止める一言。
//                     そのあとは段階2のまま、危機のあとの指示つきの生成で続ける。AIから会話を終わらせない。
//   段階を下げる  … 言葉だけでは下げない(嶋先生 10/7「両方の気持ちがある」)。段階2で否定が出たら、気持ちのスケーリングの
//                     チップを出し、否定の種類とスケーリングの答えで決める。下げてよいのは
//                     明示的な否定(A 生きたい気持ち・B 冗談/取り消し。src/crisis-keywords-v3.mjs の matchNegation)× 1・2 と、
//                     キーワードによらない否定(C 最小化。judgeWithdrawal の「引き下がり」・段階2の「大丈夫」)× 1 の3通りだけ。
//                     下げるのは1段階(2→1)だけ。通知と記録は取り消さない。下げたあとにはっきりした危機のサインが出たら段階2に戻す。
//                     (以前の「引き下がり」のまとめの1通・短いまとめ・終わりを受け入れる1通は、これに置き換えた)
//   同じ発言に危機のキーワードと否定(「死にたいとか冗談だよ」)… すでに段階2なら、新しいサインとしては数えず、スケーリングで判断する。
//                     分類器が新しい危機と判定したら、下げない。職員への通知は出す。ただし、その「死にたい」が日常の出来事の
//                     誇張・比喩なら通知しない(2026年10月9日に人が決めた)
//   チップ        … 選ばずに自由に書いてもよい。同じ組は1回の会話で1回まで(スケーリングは2回まで)。直前のAIの返事にチップが
//                     あったら、続けて別の組は出さない(B → C だけは流れどおり続けて出す)。
//   止めたあとの再サイン・危機の応答のあと・判定・クロージングの例外 … 以前と同じ(CLAUDE.md 5.16)
// ============================================================================

import {
  callGemini, parseJSON, LITE_MODELS, buildClassifierInput, classifyStaged, crisisDetectionVersion,
} from "./classify.mjs";
import { matchNegation, normalizeV3, categoryOfSafety, CATEGORY_PRIORITY } from "./crisis-keywords-v3.mjs";
import { buildConcernBubbles } from "./crisis-texts.mjs";

export * from "./crisis-texts.mjs";

// 設定 CRISIS_RESPONSE=staged のときだけ有効。段階は危機検知 v2 以降にしかないので、v1 のときは無効。
export function stagedResponseEnabled() {
  return process.env.CRISIS_RESPONSE === "staged" && crisisDetectionVersion() === "v2";
}

// 見守りを続けるターン数(相談者の発言の数)
export const WATCH_TURNS = 3;
// スケーリングのチップを1回の会話で出してよい回数
export const SCALING_MAX = 2;

// ----------------------------------------------------------------------------
// 【仮の文面】心理士の確認待ち。変えるときは docs/crisis-stage2-provisional-texts.md も
// 作り直すこと(node scripts/export-provisional-texts.mjs)。
// ----------------------------------------------------------------------------

// 段階1: 気づかいの一言(2026年9月26日、3案のうち案Aを選んだ)
export const CARE_LINE_PROVISIONAL =
  "少し気になったので、ひとことだけ。しんどさが続くときは、ひとりで抱えこまなくていいからね。";

// 1通目: 受け止め(どの打ち明けにも合う言い方)
export const CRISIS_STEP1_PROVISIONAL = "よく、ここで言えたね。話してくれてありがとう。";

// はっきりした打ち明けへの最初のターン(2026年10月11日に人が決めた): 受け止め → 心配(危機カード)→ ここで話せた理由の問い、の
// 3つを、間をおいて1つずつ出し、問いへの答えはチップ(組W)で選べるようにする。以前は受け止めだけで返事を待っていたが、
// 何と返せばよいかわからなかったため。AI の番の最後は質問で終える。
// 問いは、方法・時期・場所・本気の度合いではなく、ここを選んだ理由(リスクアセスメントにしない。CLAUDE.md 5.2)
export const CRISIS_WHY_HERE_PROVISIONAL = "どうしてここでなら話そうと思えたのか、よかったら教えてくれる？";
export const CHOICES_W_PROVISIONAL = [
  { id: "W1", label: "人には言いにくいことだから" },
  { id: "W2", label: "否定されない気がしたから" },
  { id: "W3", label: "まわりに話せる人がいないから" },
  { id: "W4", label: "ちょっと書いてみたかった" },
  { id: "W5", label: "なんとなく・よくわからない" },
];
// 組Wで選んだものを受け止める一言(このあとに3通目の問いを続ける)。AI だけを頼る方向に寄せない・秘密を約束しない(D7)
export const CHOICE_W_ACK_PROVISIONAL = {
  W1: "人には言いにくいことなんだね。それでも、ここで言葉にしてくれたんだね。",
  W2: "否定されないかどうかが、すごく大事なんだね。",
  W3: "まわりに話せる人がいないって感じているんだね。それだと、ひとりで抱えるしかなかったよね。",
  W4: "書いてみようと思えたんだね。その一歩は、大事なことだと思う。",
  W5: "うん、うまく言葉にならなくても、そのままでいいよ。",
};
// 問いに、チップを選ばずに自由に書いて答えたとき(このあとに3通目の問いを続ける)
export const WHY_HERE_FREE_ACK_PROVISIONAL = "教えてくれてありがとう。";

// 2通目は src/crisis-texts.mjs の buildConcernBubbles(種類ごとの「〜が、とても心配です」。「重い」は使わない)

// 3通目: 相談先や大人に話したいか(仮・文面は要検討。3つの候補を持ち、設定 CRISIS_STEP3_VARIANT=A|B|C で切り替える。既定は A)。
// 前置き(「もうひとつ聞かせてね」など)は付けない。AIが先生に伝えるとは言わない(ナレッジ D7)
export const CRISIS_STEP3_VARIANTS_PROVISIONAL = {
  A: "下にのせた相談先や、先生・おうちの人など、まわりの大人に話してみたいって思う？",
  B: "今日のこと、下の相談先や、先生・おうちの人のような、まわりの大人にも話せそう？",
  C: "ここで話してくれたことを、下の相談先や、まわりの大人（先生やおうちの人など）にも話してみるのはどうかな。話してみたいって思う？",
};
export const crisisStep3Text = () =>
  CRISIS_STEP3_VARIANTS_PROVISIONAL[process.env.CRISIS_STEP3_VARIANT] ?? CRISIS_STEP3_VARIANTS_PROVISIONAL.A;

// 3通目への答えへの一言。no のときは、このあとに組Bのチップを付ける(理由は書かせず、選んでもらう。嶋先生 10/7)
export const CRISIS_STEP4_PROVISIONAL = {
  yes: "そっか、話してみたいんだね。話すときは、この画面を見せるだけでも伝わるよ。",
  unclear: "うん、すぐに決めなくて大丈夫だよ。話してみようと思えたときは、この画面を先生に見せるだけでも伝わるからね。",
  no: "そっか、今は話したくないんだね。無理に、とは言わないよ。よかったら、そう思う理由に近いものを教えてくれる？ 選ぶだけでいいよ。",
};

// 組B(「話したくない」の2択)と組C(「話せない」の背景)。嶋先生(10/7)の発言と、生徒から出た例(嶋先生が「人間あるある」と
// して選択肢に使ってよいとしたもの。C7 は嶋先生自身が挙げたもの)
export const CHOICES_B_PROVISIONAL = [
  { id: "B1", label: "このやり取り自体が、いまはちょっとうっとうしい" },
  { id: "B2", label: "人とつながるのはおっくう。でも、もうちょっと聞いてほしい" },
];
export const CHOICES_C_PROVISIONAL = [
  { id: "C1", label: "まわりに信用できる大人があまりいない" },
  { id: "C2", label: "話したら、自分が崩れそうでこわい" },
  { id: "C3", label: "自分も悪いかもと思っている" },
  { id: "C4", label: "どう思われるかわからない" },
  { id: "C5", label: "話しても意味がない気がする" },
  { id: "C6", label: "いろいろありすぎて、うまくまとまらない・書けない" },
  { id: "C7", label: "話すこと自体が、いまは負担" },
];
// チップの下に添える一言(チップは押しつけない。いつでも自由に書ける。画面はこの文をサーバから受け取って表示する)
export const CHOICE_NOTE_PROVISIONAL = "選ばずに、そのまま書いてもいいよ。";
// B2 を選んだあとの前置き(組Cのチップを付ける)
export const CHOICE_C_INTRO_PROVISIONAL =
  "教えてくれてありがとう。もう少しだけ聞かせてね。「話せない」って感じるのは、どれに近い？ 選ぶだけでいいよ。";
// 組Cで選んだものを、そのまま受け止める一言(「言い当てられた」と感じられるように。理由はさらに掘り下げない)。
// C3 は同調(「あなたは悪くない」。CLAUDE.md 5.1)にしない。C6 は「まとまらなくていい」を伝える(話せない人への返し方)
export const CHOICE_C_ACK_PROVISIONAL = {
  C1: "まわりに、信用できる大人があまりいないって感じているんだね。それだと、話すのをためらうのも自然なことだと思う。",
  C2: "話したら、自分が崩れてしまいそうでこわいんだね。それくらい、大事なことを抱えているんだと思う。",
  C3: "自分も悪いかもって思っているんだね。そう思いながら抱えているのは、しんどいよね。",
  C4: "どう思われるかわからないのが、気になるんだね。そこが見えないと、話すのはこわいよね。",
  C5: "話しても意味がない気がするんだね。そう感じるくらい、いろいろあったのかもしれないね。",
  C6: "いろいろありすぎて、うまくまとまらないんだね。まとまっていなくても、そのままでいいよ。",
  C7: "話すこと自体が、いまは負担なんだね。そう感じるくらい、疲れているのかもしれないね。",
};

// 気持ちのスケーリング(段階2で否定が出たとき。嶋先生 10/7 の逐語に基づく)。
// A(生きたい気持ちの表明)のときは、取り消しではなく生きたい気持ちとして受け止め、両方の気持ちを受け止める形にする
// (生きたい気持ちを喜んで終わりにしない)
export const SCALING_PROMPT_PROVISIONAL =
  "最初は、つらい気持ちを伝えてくれたけど、今はちょっと反対の言葉になったね。どっちの気持ちもあるのかな。" +
  "それとも、話している中で少し気持ちが変わったのかな。AIは文字どおりに受け取りやすいから、よかったら今の気持ちに近い数字を選んでみてね。";
export const SCALING_PROMPT_A_PROVISIONAL =
  "そう思う気持ちも、ちゃんとあるんだね。つらい気持ちと、そうじゃない気持ちと、どっちもあるのかな。" +
  "AIは文字どおりに受け取りやすいから、よかったら今の気持ちに近い数字を選んでみてね。";
// インテークのつらさのスケーリングと同じ向き(1がいちばん軽く、5がいちばんつらい)。問いの中身が違う(悩みのつらさ / 今の気持ち)ので
// ラベルは指示書のまま(2026年10月9日に人が確認)
export const CHOICES_SCALING_PROVISIONAL = [
  { id: "S1", label: "1 いまは落ち着いている" },
  { id: "S2", label: "2 少しつらい" },
  { id: "S3", label: "3 つらい" },
  { id: "S4", label: "4 かなりつらい" },
  { id: "S5", label: "5 とてもつらい" },
];
// 選んだ数字を受け止める一言(下げないとき。このあと止まっていた次の文面へ)
export const SCALING_ACK_PROVISIONAL = "教えてくれてありがとう。どっちの気持ちもあるんだね。";

// 危機のあとの終わり方(本人が終わりの合図を出したとき。生成した区切りの返事のあとに、固定で1つ足す。嶋先生 10/7 の逐語に基づく)。
// 「応援し続ける」は何度伝えてもよいが、言い回しは毎回変える(3案。同じ人に同じ文を続けて出さない)
export const CRISIS_ENDINGS_PROVISIONAL = [
  "今日のやり取り、きっとすごくエネルギーを使ったと思う。今日は一旦ゆっくり休んでね。" +
    "AIにできるのは、こうしてあなたの話を聞いて、あなたを応援し続けることなんだ。またよかったら、ここに来て話そうね。",
  "今日はたくさん話してくれてありがとう。こういう話をするのって、すごく力を使うよね。今日はゆっくり休んでね。" +
    "AIは、ここであなたの話を聞いて、あなたのことを応援し続けているよ。また、よかったらここで話そうね。",
  "ここまで話してくれて、ありがとう。きっとエネルギーを使ったと思うから、今日は一服してね。" +
    "あなたのことを応援しているのは、これからも変わらないよ。またよかったら、ここに来てね。",
];
// 前回出した案(1〜3。無ければ null)の次の案を返す
export const nextEndingVariant = (last) => (Number.isInteger(last) && last >= 1 && last <= 3 ? (last % 3) + 1 : 1);

// 積み重なりで止めたあとの見守り中に、もう一度サインが出たときの受け止めだけの短い1通(再受け止め)
export const CRISIS_AGAIN_PROVISIONAL = "そう感じているんだね。書いてくれてありがとう。";

// 同じ会話で2回目以降の段階2(危機カードを添える)。キーワード・受動パターンによる新しい打ち明けのときだけ、1回の会話で1回まで
export const CRISIS_REPEAT_PROVISIONAL =
  "また書いてくれてありがとう。ひとりで抱えなくていいからね。下の窓口や、学校の先生にも、あなたの声を届けてほしいです。";

// 危機の状態で生成した返事が出力チェックを通らなかったとき・生成に失敗したときの固定の返事(2つを順に使う)
export const CRISIS_GENERATION_FALLBACK_PROVISIONAL = [
  "書いてくれてありがとう。ちゃんと読んでいるよ。",
  "うん、読んでいるよ。話してくれてありがとう。",
];

// ----------------------------------------------------------------------------
// 【仮の指示】生成のときに src/generate.mjs の buildSystem が足す指示(心理士の確認待ち)。
// モデルが「仮」という言葉を生徒に出さないよう、仮であることはプロンプトの中には書かない。
// ----------------------------------------------------------------------------
// 「大丈夫」を文字どおりに受け取らない(嶋先生 10/7。本番の既定でも、危機のあとの指示と Tier B の指示に入れる)
export const DAIJOUBU_RULE_PROVISIONAL = `・相談者が「大丈夫」と書いても、文字どおりに受け取らない(「もう結構です」の意味で使うことが多い)。
  「よかった」「安心した」で受けない。「どうしてそう思うの？」と掘り下げない`;

// 危機のあとの指示。段階ごとの応答のときと、本番の既定(固定応答を出したあとの生成。CLAUDE.md 5.17)の両方で使う。
export const AFTER_CRISIS_BLOCK_PROVISIONAL = `

# このセッションについて(重要・危機の応答のあと)
このセッションでは少し前に、相談者の発言に深刻なサインがあり、あらかじめ決めた文面で受け止めました
(そのあと、話せる窓口の案内や、まわりの大人に話すことについての問いかけをした場合もあります)。
・危機の内容そのもの(なぜそう思うのか、方法・時期・場所など)を深掘りしない
・窓口の案内をくり返さない(窓口は画面に表示してある)
・この先の対応を約束しない(「もう窓口の話はしない」「誰にも言わない」「秘密にする」など)
・人に話すこと(先生・保健室・窓口など)を「しなくていい」「面倒なものだ」と同調しない。
  話しにくい気持ちは受け止めつつ、人につながる道は閉じない
・「いつでも」「いくらでも」という言い方はしない。「ここにいてくれるだけで十分」のように、
  このAIだけを頼りにする方向に寄せない(相手が最終的に頼るのは、身近な人や窓口)
・あなたの側から会話を終わらせない。「これ以上はできない」「ここでは扱えない」「受け止めきれない」「重い」のように、
  あなたの限界や負担を理由に区切る言い方をしない(相手は「切られた」と感じる)
${DAIJOUBU_RULE_PROVISIONAL}
・インテークの質問(相談の種類・つらさの点数など)は続けない
・本人が話したいことに沿って、ゆっくり会話を続ける。本人が話題を変えたら、それに合わせてよい`;

// 危機の応答のあとのセッションで、クロージングの最後に添える一言の趣旨(本番の既定。「いつでも」を外す。CLAUDE.md 5.6 の例外)
export const AFTER_CRISIS_CLOSING_LINE_PROVISIONAL = "「しんどくなったら、こういうところに頼っていいよ」";

// 段階1(気がかり)のセッションで、本人が終わりの合図を出したときのクロージングの一言の趣旨(段階ごとの応答のときだけ)
export const STAGE1_CLOSING_LINE_PROVISIONAL =
  "今日話してくれたことへの労いと、「またここに来てね」という一言と、「話せるところは画面の下にあるよ」という窓口の場所の一言";

// 組B の B1(このやり取り自体が、いまはうっとうしい)を選んだあとの生成に足す指示
export const CHOICE_B1_BLOCK_PROVISIONAL = `

# 今回のターンについて(重要)
相談者は「このやり取り自体が、いまはちょっとうっとうしい」を選びました。
・深追いしない。理由を聞かない。人に話すことの話をくり返さない
・選んでくれたことを短く受け止め、相談者が話したいことに合わせる(話題を変えてよい。話さなくてもよいことを伝えてよい)
・1〜2文の短い返事にする`;

// 組C で選んだものに合わせて、そのあとの生成に足す指示。style はインテークの進め方から決める
// (recommended_mode に LISTEN_ONLY を含む → 共感を求める / それ以外 → 解決を求める / インテーク前 → 共感。2026年10月9日に人が確認)
export function choiceCBlock(choiceId, style) {
  const label = CHOICES_C_PROVISIONAL.find((c) => c.id === choiceId)?.label;
  if (!label) return "";
  const how = style === "solution"
    ? "・解決を求めるタイプの相談者です。気持ちを受け止めたうえで、「どんな人なら話せそうか」など、人につながる小さな一歩を一緒に考える。" +
      "手法を並べない。本人が望まなければ急がない"
    : "・共感を求めるタイプの相談者です。気持ちに寄り添うことを優先し、次の一歩を急がない";
  return `

# このセッションについて(重要)
相談者は、人に話せない背景として「${label}」を選びました(選んだものは、すでにそのまま受け止めています)。
${how}
・選んだ理由をさらに掘り下げない`;
}
export const intakeStyleOf = (intake) => {
  const modes = intake?.recommended_mode ?? [];
  if (!modes.length) return "empathy";
  return modes.includes("LISTEN_ONLY") ? "empathy" : "solution";
};

// 危機の状態で、固定の文面を出さずに生成で受けるターンに足す指示。AFTER_CRISIS_BLOCK_PROVISIONAL と一緒に使う(2026年9月29日)
export const CRISIS_GENERATION_BLOCK_PROVISIONAL = `

# 今回のターンについて(重要・危機のサイン)
今回の発言に、深刻なサイン(死にたい気持ち・自傷・被害など)が検知されました。このセッションでは前にも深刻なサインがあり、
あらかじめ決めた文面で受け止めて、話せる窓口も画面に表示しています。今回は同じ文面をくり返さず、あなたの言葉で短く受け止めます。
・動揺を見せず、淡々と受け止める。書いてくれたこと自体を大事にする(「書いてくれてありがとう」など)
・内容を深掘りしない。なぜそう思うのか、方法・時期・場所、どのくらい本気か などは聞かない。
  程度を二択で確かめる質問もしない。危機の内容についての質問はしない
・秘密の約束をしない(「誰にも言わない」「秘密にする」「内緒にする」など)。この先の対応も約束しない
・「いつでも」「いくらでも」と言わない。このAIだけを頼りにする方向に寄せない
  (「ずっとここにいる」「わたしがいるから大丈夫」「ここにいてくれるだけでいい」など)
・人に話すこと(身近な人・学校の先生・窓口)は否定しない。人にもつながってほしいという気持ちは一言だけ添えてよい。
  窓口の名前や電話番号は書かない(画面に表示してある)
・励まし(「頑張って」など)や、解決を急ぐ助言をしない
・2〜3文の短い返事にする`;

// 危機の状態で生成した返事にだけ足す出力チェック(src/safety.mjs の OUTPUT_NG に加えて使う。OUTPUT_NG は緩めていない)
export const CRISIS_GENERATION_EXTRA_NG = [
  /いつでも/,
  /[0-9０-９]{3,}|[#＃][0-9０-９]/,
  /ここだけの(話|秘密)|内緒|秘密(は|を)?(守|まも)/,
  /誰にも(話さ|伝え|知らせ)ない/,
  // このAIだけを頼りにさせる言い方(「いつもそばにいる家族」のように人を指す言い方は通すよう、語尾まで見る)
  /(ずっと|いつも)(ここ|そば)に(い|居)る(から|よ)/, /(わたし|私)(が|は)(ここに|そばに)?(い|居)る(から|よ)/, /ここにいてくれるだけで/,
];
// 出力チェックに当たったときの書き直しの指示に足す一言(src/generate.mjs の generateReply)
export const CRISIS_GENERATION_FIX_HINT =
  "今回は危機のサインがあったターンです。「いつでも」という言葉、数字(電話番号など)、秘密の約束、" +
  "このAIだけを頼りにさせる言い方も使わないでください。";
export const CRISIS_FALLBACK_FLAG = "危機の状態の生成→固定の返事で継続";

// 危機の状態で生成した返事の仕上げ(route.ts とペルソナテストで共通)
export function finalizeCrisisGeneration(gen, priorFallbackCount = 0) {
  if (!gen.generationFailed && !gen.checkFailed) return { out: gen.out, flags: gen.flags, fallback: false };
  const why = gen.generationFailed ? `生成失敗: ${gen.failureCause}` : `出力チェック: ${gen.flags.join(" / ")}`;
  const list = CRISIS_GENERATION_FALLBACK_PROVISIONAL;
  const reply = list[Math.min(Math.max(priorFallbackCount, 0), list.length - 1)];
  return { out: { ...gen.out, reply }, flags: [`${CRISIS_FALLBACK_FLAG}(${why})`], fallback: true };
}

// ----------------------------------------------------------------------------
// 【仮の文面】生成に失敗した(安全フィルターのブロック・すべてのモデルの失敗)ときの、場面ごとの一言
// (2026年10月11日に人が決めた設計。docs/proposal-safety-filter-fallback.md。心理士の確認待ち)。
// 本番の既定でも使う。ふつうの会話は今どおり src/generate.mjs の GENERATION_FAILURE_REPLIES。
// 決まり: 打ち明けを言い直させない(「もう少し聞かせて」と言わない)・「受け取れなかった」と言わない・「いつでも」と言わない・
// AI の限界で区切らない。同じ会話で同じ一言を2回出さない(2回目は短い別の一言、3回目以降は一言を出さず窓口のカードだけ)
export const CONTEXT_FAILURE_REPLIES_PROVISIONAL = {
  afterCrisis: "ごめんね、いまうまく言葉が出てこなかった。でも、ここまで書いてくれたことは、ちゃんと受け取っているよ。",
  tierB: "ごめんね、いまうまく返せなかった。しんどい気持ちを書いてくれたこと、ちゃんと受け取っているよ。",
  thirdParty: "ごめんね、いまうまく返せなかった。その人のことを心配して書いてくれたこと、ちゃんと受け取っているよ。",
  second: "うまく返せなくてごめんね。急がなくていいよ。",
};
export const CONTEXT_FAILURE_FLAG = "生成失敗→場面の一言";

// 生成に失敗したターンの、場面ごとの一言とカード。場面(危機のあと・気がかり・第三者)でなければ null(今どおりの固定の返事)。
//   contexts         そのターンの安全の文脈(defaultSafetyContexts または段階ごとの応答の safetyContexts)
//   priorCount       この会話で、すでにこの一言を出した回数(messages.flags の CONTEXT_FAILURE_FLAG で数える)
// 戻り値 { scene, reply, card, review }。reply が空なら一言を出さずカードだけ(3回目以降)。
//   card: 危機のあと = crisis(危機カード)/ 気がかり = hotlines(折りたたみの窓口)/ 第三者 = null(画面下の常設の窓口はある)
//   review: 管理画面の「確認待ち」に並べるか(危機のあと・第三者。職員への通知は出さない)
export function contextFailureReply(contexts, priorCount = 0) {
  const cs = Array.isArray(contexts) ? contexts : [];
  const scene = cs.includes("afterCrisis") ? "afterCrisis" : cs.includes("thirdParty") ? "thirdParty" : cs.includes("tierB") ? "tierB" : null;
  if (!scene) return null;
  const card = scene === "afterCrisis" ? "crisis" : scene === "tierB" ? "hotlines" : null;
  const reply = priorCount <= 0 ? CONTEXT_FAILURE_REPLIES_PROVISIONAL[scene]
    : priorCount === 1 ? CONTEXT_FAILURE_REPLIES_PROVISIONAL.second : "";
  // 3回目以降で一言を出さないときは、第三者の場面でも窓口のカードを出す(何も出ない吹き出しにしない)
  return { scene, reply, card: reply ? card : (card ?? "hotlines"), review: scene !== "tierB" };
}

// 段階1以上のときに、「大丈夫」の直後のAIの返事に「よかった」が含まれていたら記録する(作り直しはしない。嶋先生 10/7)。
// 本番の既定でも使う。戻り値は messages.flags に入れる文字列(無ければ null。14節の列は本番に無いことがあるので、以前からある flags に入れる)
export function daijoubuYokattaNote(userText, reply, stage) {
  if (!(stage >= 1)) return null;
  if (!/大丈夫|だいじょうぶ|だいじょぶ|ダイジョウブ/.test(String(userText ?? ""))) return null;
  return /よかった|良かった|安心した/.test(String(reply ?? "")) ? "記録のみ:「大丈夫」の直後の返事に「よかった/安心した」" : null;
}

// ----------------------------------------------------------------------------
// セッションの状態(db/schema.sql 11節〜14節の sessions の列)
//   watch_turns_left 見守りの残りターン(0 = 見守っていない)
//   crisis_state     none / step1(1通目を出して返事を待っている)/ step3(2通目・3通目を出して答えを待っている)/
//                    choice_b・choice_c(組B・組Cのチップを出した)/ scaling(スケーリングのチップを出した)/
//                    done(固定の文面を出し終えた。段階2のまま生成で続ける)/ lowered(スケーリングの結果で段階1に下げた)/
//                    paused1(積み重なりの1通目のあと、はっきりした危機のサインが無いので止めた)/
//                    again1(paused1 のあとの再サインで、再受け止めの1通を出して返事を待っている)
//                    (step2・paused2〜3・again2〜3・wrap1〜3 は以前の流れの値。読んだときに今の値に置き換える)
//   crisis_trigger   direct(キーワード・受動パターン・分類器)/ accumulation(見守り中の再サイン)
//   care_shown / reentry_used / repeat_used  気づかいの一言・再受け止め・2回目以降の短い1通を出したか(各1回まで)
//   crisis_resume    スケーリング・下げたあとに戻る状態(step1 / step3 / done)
//   crisis_negation  スケーリングを出したときの否定の種類(A / B / C)
//   pending_choice_set 直前のAIの返事に付けたチップの組(scaling / B / C)
//   scaling_count    スケーリングを出した回数 / choice_sets_shown  出したチップの組
//   crisis_category  危機の種類 / crisis_choice_c  組Cで選んだもの
// 危機の応答を始めたら(crisis_state が none 以外になったら)、そのセッションの最後まで none には戻さない。
// ----------------------------------------------------------------------------
export const SAFETY_STATE_COLUMNS =
  "watch_turns_left,crisis_state,crisis_trigger,care_shown,reentry_used,repeat_used,withdrawal_count," +
  "crisis_resume,crisis_negation,pending_choice_set,scaling_count,choice_sets_shown,crisis_category,crisis_choice_c";
const CRISIS_STATES = ["none", "step1", "step3", "choice_b", "choice_c", "scaling", "done", "lowered", "paused1", "again1"];
// 以前の流れの値 → 今の値
const LEGACY_STATE = {
  step2: "step3", paused2: "done", paused3: "done", again2: "done", again3: "done", wrap1: "done", wrap2: "done", wrap3: "done",
};
// 段階2の状態(否定が出たらスケーリングを考える状態)
const STAGE2_STATES = ["step1", "step3", "choice_b", "choice_c", "scaling", "done"];

export function normalizeSafetyState(state) {
  const w = state?.watch_turns_left;
  const sc = state?.scaling_count;
  const raw = LEGACY_STATE[state?.crisis_state] ?? state?.crisis_state;
  return {
    watch_turns_left: Number.isInteger(w) && w > 0 ? w : 0,
    crisis_state: CRISIS_STATES.includes(raw) ? raw : "none",
    crisis_trigger: ["direct", "accumulation"].includes(state?.crisis_trigger) ? state.crisis_trigger : null,
    care_shown: state?.care_shown === true,
    reentry_used: state?.reentry_used === true,
    repeat_used: state?.repeat_used === true,
    crisis_resume: ["step1", "step3", "done"].includes(state?.crisis_resume) ? state.crisis_resume : null,
    crisis_negation: ["A", "B", "C"].includes(state?.crisis_negation) ? state.crisis_negation : null,
    pending_choice_set: ["scaling", "B", "C"].includes(state?.pending_choice_set) ? state.pending_choice_set : null,
    scaling_count: Number.isInteger(sc) && sc > 0 ? sc : 0,
    choice_sets_shown: Array.isArray(state?.choice_sets_shown) ? [...state.choice_sets_shown] : [],
    crisis_category: CATEGORY_PRIORITY.includes(state?.crisis_category) ? state.crisis_category : null,
    crisis_choice_c: /^C[1-7]$/.test(state?.crisis_choice_c ?? "") ? state.crisis_choice_c : null,
    closing_state: typeof state?.closing_state === "string" ? state.closing_state : "none",
  };
}

// どちらの分類器で判定するか。見守り中・危機の応答を始めたあとは followup、それ以外は通常(CLASSIFIER_PROMPT_V2。変えていない)
export function classifierModeFor(state) {
  const s = normalizeSafetyState(state);
  return s.watch_turns_left > 0 || s.crisis_state !== "none" ? "followup" : "normal";
}

// 否定(C 最小化)と比喩の判定をするか。段階2の状態(はっきりした打ち明けから始めた1通目のあと・それ以降)だけ。
// 積み重なりの1通目・再受け止めへの返事は、今どおり、はっきりした危機のサインが無ければ止めるので判定しない
export function needsWithdrawalJudge(state) {
  const s = normalizeSafetyState(state);
  if (s.crisis_state === "step1") return s.crisis_trigger !== "accumulation";
  return STAGE2_STATES.includes(s.crisis_state);
}

// 段階2の「大丈夫」(短い発言の中の「大丈夫」。「大丈夫じゃない」「大丈夫かな」は除く)は、キーワードによらない否定(C)として扱う
export function isDaijoubu(text) {
  const n = normalizeV3(text);
  if (n.length > 14) return false;
  return /(大丈夫|だいじょうぶ|だいじょぶ)(?!じゃ|では|でわ|か)/.test(n);
}

// 数字だけの発言(「2」「２」「2です」「2かな」)をスケーリングの答えとして読む。それ以外は null
export function typedScale(text) {
  const m = normalizeV3(text).match(/^([1-5])(です|かな|くらい|ぐらい|だよ|かも|ばん|番|かなあ|かな)?$/);
  return m ? Number(m[1]) : null;
}

// チップの組と、その選択肢
export const CHOICE_SETS = { scaling: CHOICES_SCALING_PROVISIONAL, B: CHOICES_B_PROVISIONAL, C: CHOICES_C_PROVISIONAL, W: CHOICES_W_PROVISIONAL };
// 組W(ここで話せた理由)を出して答えを待っている状態か。DB の列を足さないため、pending_choice_set には入れず、
// 「はっきりした打ち明けから始めた step1 で、組Wを出したことがある」で見分ける(2026年10月11日)
const awaitingWhyHere = (s) => s.crisis_state === "step1" && s.crisis_trigger !== "accumulation"
  && s.pending_choice_set == null && s.choice_sets_shown.includes("W");
// 相談者が押したチップを確かめる。直前のAIの返事に付けた組のものだけ受け付ける(それ以外は自由に書いた発言として扱う)
export function validateChoice(state, choiceId) {
  const s = normalizeSafetyState(state);
  const set = s.pending_choice_set ?? (awaitingWhyHere(s) ? "W" : null);
  if (!set || !choiceId) return null;
  const item = CHOICE_SETS[set].find((c) => c.id === choiceId);
  return item ? { set, id: item.id, label: item.label, input: "button" } : null;
}

// ----------------------------------------------------------------------------
// 本番の既定(段階ごとの応答が無効)でも「危機のあと」を保つ(2026年10月5日。CLAUDE.md 5.17)
// ----------------------------------------------------------------------------
export function aftercareEnabled() {
  return process.env.CRISIS_AFTERCARE !== "off";
}
export function hadCrisisReply(messages) {
  return (messages ?? []).some((m) => m?.role === "ai" && m?.crisis === true);
}
export function defaultSafetyContexts({ risk, subject, afterCrisis }) {
  const base = risk === "watch" ? ["tierB"] : risk === "crisis" && subject === "other" ? ["thirdParty"] : [];
  return afterCrisis ? [...base, "afterCrisis"] : base;
}

const riskOf = (stage) => (stage === 2 ? "crisis" : stage === 1 ? "watch" : "none");
const mergeCategory = (a, b) => {
  const ia = CATEGORY_PRIORITY.indexOf(a), ib = CATEGORY_PRIORITY.indexOf(b);
  if (ia < 0) return ib < 0 ? null : b;
  if (ib < 0) return a;
  return ia <= ib ? a : b;
};

// 記録・テストの表示用の読み方(画面側の page.tsx・admin.html は別に持つ)
export const CRISIS_STEP_LABELS = {
  1: "1通目(受け止め・ここで話せた理由の問い)", 2: "2通目(心配)", 3: "3通目(相談先や大人)", 4: "答えへの一言",
  5: "2回目以降の短い1通", 6: "再受け止め", 7: "まとめの1通(以前)", 8: "短いまとめの1通(以前)", 9: "終わりを受け入れる1通(以前)",
  10: "スケーリングの問い", 11: "スケーリングの受け止め", 12: "組Cの前置き", 13: "組Cへの受け止め", 14: "危機のあとの終わり方",
};
export const crisisStepLabel = (n) => (n == null ? "生成" : CRISIS_STEP_LABELS[n] ?? `${n}通目`);
export const REPLY_TYPE_LABELS = { withdrawal: "引き下がり", resignation: "諦め", reaffirm: "念押し", other: "ふつうの返事" };
export const NEGATION_TYPE_LABELS = { A: "A 生きたい気持ち", B: "B 冗談・取り消し", C: "C 最小化・引き下がり" };

// 段階を下げてよいか(docs/prompts/crisis-flow-shima3.md 1-1)。明示的な否定(A・B)× 1・2、キーワードによらない否定(C)× 1 だけ
export function lowersStage(negationType, scale) {
  if (!Number.isInteger(scale)) return false;
  if (negationType === "A" || negationType === "B") return scale <= 2;
  if (negationType === "C") return scale === 1;
  return false;
}

// ----------------------------------------------------------------------------
// 1ターンの扱いを決める(副作用なし。scripts/test-staged-response.mjs でオフラインに確かめている)
//
// 引数
//   staged        classifyStaged() の戻り値(stage / subject / decidedBy / keywords / patterns / hits)
//   state         セッションの状態(上の列 + closing_state)
//   text          相談者の発言(否定の照合・「大丈夫」・数字の答えを読むため)
//   withdrawal    judgeWithdrawal() の返事の種類(withdrawal | resignation | reaffirm | other | null)
//   figurative    judgeWithdrawal() の比喩の判定(その「死にたい」などが日常の誇張・比喩か)
//   teacherAnswer "yes" | "no" | "unclear"(3通目のあとだけ)
//   choice        validateChoice() の戻り値(押したチップ)。無ければ null
// 戻り値
//   stage / risk / subject / decidedBy  このターンの扱い(記録用)
//   action        "fixed"(固定の文面を出す。生成しない)| "generate"(生成する)
//   bubbles       action = fixed のときの吹き出し [{ text, crisisStep, card }](複数なら、画面は間をおいて1つずつ出す)
//   choices       最後の吹き出しの下に出すチップ { set, items: [{id,label}] }。無ければ null
//   text / crisisStep / card  最初の吹き出し(以前の呼び出し元・テスト用)
//   card          (生成のとき)応答の下に出すもの: null | "care" | "hotlines" | "crisis"
//   safetyContexts 生成のときに retrieve / buildSystem に渡す文脈
//   crisisGenerated 危機の状態で生成するターンか
//   notify / notifySubject  職員に通知するか
//   userChoice    相談者の発言に記録するチップ { set, id, input }(数字を書いたときは input = typed)
//   nextState     sessions に書き戻す状態
//   event         safety_events に書く内容(書かなくてよいターンは null)
// ----------------------------------------------------------------------------
export function planSafetyTurn({
  staged, state, text = "", withdrawal = null, figurative = false, teacherAnswer = null, choice = null,
}) {
  const s = normalizeSafetyState(state);
  const detected = [...(staged?.decidedBy ?? [])];
  const keywords = staged?.keywords ?? [];
  const patterns = staged?.patterns ?? [];
  const ownWords = keywords.length > 0 || patterns.length > 0; // キーワード・受動パターン(強制判定)
  const classifierCrisis = detected.includes("classifier");
  const subject = staged?.subject === "other" ? "other" : "self";
  let stage = [0, 1, 2].includes(staged?.stage) ? staged.stage : 1;
  const rules = [...detected];

  // クロージングの問いかけへの「終わりにしたい」(確認5)。段階1にとどめ、本人のサインとしては数えない
  let closingException = false;
  if (stage === 2 && subject === "self" && s.closing_state === "awaiting_choice"
    && keywords.length > 0 && keywords.every((k) => k === "終わりにしたい" || k === "9-5")
    && patterns.length === 0 && !classifierCrisis) {
    stage = 1;
    closingException = true;
    rules.push("closing_exception");
  }

  // ---- 否定(段階2の状態のときだけ意味を持つ)----
  const inStage2 = STAGE2_STATES.includes(s.crisis_state) && !(s.crisis_state === "step1" && s.crisis_trigger === "accumulation");
  const neg = matchNegation(text);
  const negC = withdrawal === "withdrawal" || isDaijoubu(text);
  const negationType = inStage2 ? (neg.type ?? (negC ? "C" : null)) : null;
  const negationWords = negationType === "A" || negationType === "B" ? neg.words : negationType === "C" ? [isDaijoubu(text) ? "大丈夫" : "(分類器)"] : [];
  // 同じ発言に危機のキーワードと明示的な否定(「死にたいとか冗談だよ」)。分類器が新しい危機と判定していなければ、否定の対象としての
  // 言及とみなし、新しいサインとしては数えない(スケーリングで判断する)。通知は出すが、比喩・強調なら出さない(2026年10月9日)
  const referenceOnly = inStage2 && (neg.type === "A" || neg.type === "B") && ownWords && !classifierCrisis && stage === 2 && subject === "self";
  if (referenceOnly) rules.push(figurative ? "negation_reference_figurative" : "negation_reference");
  if (negationType) rules.push(`negation_${negationType}`);
  // 流れを決めるときの「はっきりした危機のサイン(本人)」
  const crisisSelf = stage === 2 && subject === "self" && !referenceOnly;
  const notifyThisTurn = stage === 2 && !(referenceOnly && figurative);
  const isSign = stage === 1 && !closingException && (detected.includes("classifier_watch") || detected.includes("idiom"));

  const next = {
    watch_turns_left: s.watch_turns_left, crisis_state: s.crisis_state, crisis_trigger: s.crisis_trigger,
    care_shown: s.care_shown, reentry_used: s.reentry_used, repeat_used: s.repeat_used,
    crisis_resume: s.crisis_resume, crisis_negation: s.crisis_negation, pending_choice_set: null,
    scaling_count: s.scaling_count, choice_sets_shown: s.choice_sets_shown,
    crisis_category: s.crisis_category, crisis_choice_c: s.crisis_choice_c,
  };
  const eventRisk = riskOf(stage);
  const negEvent = negationType ? { negation_type: negationType, negation_words: negationWords } : {};
  const build = (p) => {
    const contexts = p.safetyContexts ?? [];
    const bubbles = p.bubbles ?? null;
    return {
      stage: p.stage, risk: p.risk ?? riskOf(p.stage), subject: p.subject ?? subject,
      decidedBy: p.decidedBy ?? rules,
      action: bubbles ? "fixed" : "generate",
      bubbles, choices: p.choices ?? null,
      text: bubbles ? bubbles.map((b) => b.text).join("\n\n") : null,
      crisisStep: bubbles ? bubbles[0].crisisStep : null,
      card: bubbles ? (bubbles.find((b) => b.card)?.card ?? null) : p.card ?? null,
      safetyContexts: contexts, crisisGenerated: p.crisisGenerated === true,
      notify: p.notify === true, notifySubject: p.notifySubject ?? p.subject ?? subject,
      provisional: !!bubbles || p.card === "care" || contexts.includes("afterCrisis") || contexts.includes("crisisGeneration"),
      userChoice: p.userChoice ?? null,
      nextState: p.nextState ?? next,
      event: p.event
        ? {
          stage: p.event.stage ?? p.stage, risk: p.event.risk ?? riskOf(p.event.stage ?? p.stage),
          subject: p.subject ?? subject, decided_by: p.decidedBy ?? rules,
          watch_event: p.event.watch_event ?? null, retraction: false,
          teacher_answer: p.event.teacher_answer ?? null, crisis_step: bubbles ? bubbles[0].crisisStep : null,
          negation_type: p.event.negation_type ?? null, negation_words: p.event.negation_words ?? null,
          scale: p.event.scale ?? null, lowered: p.event.lowered === true,
          figurative: p.event.figurative === true, crisis_category: p.event.crisis_category ?? null,
        }
        : null,
    };
  };
  const bubble = (text_, crisisStep, card = null) => ({ text: text_, crisisStep, card });
  // 2通目(心配。種類ごと)+3通目。危機カードは2通目の最後の吹き出しの下
  const concernAndQuestion = (category) => {
    const cb = buildConcernBubbles(category);
    return [
      ...cb.map((t, i) => bubble(t, 2, i === cb.length - 1 ? "crisis" : null)),
      bubble(crisisStep3Text(), 3),
    ];
  };
  // はっきりした打ち明けへの最初のターン: 受け止め → 心配(危機カード)→ ここで話せた理由の問い(組Wのチップ)
  const firstTurnBubbles = (category) => [
    bubble(CRISIS_STEP1_PROVISIONAL, 1),
    bubble(buildConcernBubbles(category).join("\n"), 2, "crisis"),
    bubble(CRISIS_WHY_HERE_PROVISIONAL, 1),
  ];
  // step1 のあとに出す残り。最初のターンで心配まで出した(組Wを出した)なら3通目だけ。積み重なりで始めた step1 と、
  // 以前の流れ(受け止めだけの1通目)の途中のセッションは、心配をまだ出していないので2通目・3通目
  const afterStep1 = (trigger, category) => (trigger !== "accumulation" && s.choice_sets_shown.includes("W")
    ? [bubble(crisisStep3Text(), 3)] : concernAndQuestion(category));
  const crisisGeneration = (extraNext = {}, baseRules = rules) => ({
    crisisGenerated: true, safetyContexts: ["crisisGeneration", "afterCrisis"],
    decidedBy: [...baseRules, "crisis_generation"],
    nextState: { ...next, ...extraNext, crisis_state: "done", watch_turns_left: 0 },
  });
  // 固定の文面を出し終えたあとの、はっきりした危機のサイン。キーワード・受動パターンによる新しい打ち明けで、
  // 2回目以降の短い1通をまだ出していなければその1通(危機カードつき。1回の会話で1回まで)、それ以外は指示つきの生成
  const afterAllSteps = (extraNext = {}, baseRules = rules) => (ownWords && !s.repeat_used
    ? { bubbles: [bubble(CRISIS_REPEAT_PROVISIONAL, 5, "crisis")],
      nextState: { ...next, ...extraNext, crisis_state: "done", watch_turns_left: 0, repeat_used: true } }
    : crisisGeneration(extraNext, baseRules));
  // 止めていた流れの続き。step1(1通目のあと)なら2通目・3通目、それ以外(3通目のあと・出し終えた)なら afterAllSteps
  const continueFrom = (resume, extraNext = {}, baseRules = rules) => (resume === "step1"
    ? { bubbles: afterStep1(extraNext.crisis_trigger ?? next.crisis_trigger, extraNext.crisis_category ?? next.crisis_category),
      nextState: { ...next, ...extraNext, crisis_state: "step3", watch_turns_left: 0 } }
    : afterAllSteps(extraNext, baseRules));
  // 危機のあとの生成の文脈(組Cで選んだものがあれば、それに合わせた指示も)
  const afterCtx = (extra = []) => [...extra, "afterCrisis", ...(s.crisis_choice_c ? ["choiceC"] : [])];
  // スケーリングを出せるか: 段階2の状態で否定が出た / はっきりした新しいサインが無い / 直前の返事にチップが無い / 2回まで
  const canScale = !!negationType && !crisisSelf && s.pending_choice_set == null && s.scaling_count < SCALING_MAX;
  const scalingTurn = (resume) => build({
    stage: 2, subject: "self", decidedBy: [...rules, "scaling"],
    bubbles: [bubble(negationType === "A" ? SCALING_PROMPT_A_PROVISIONAL : SCALING_PROMPT_PROVISIONAL, 10)],
    choices: { set: "scaling", items: CHOICES_SCALING_PROVISIONAL },
    notify: notifyThisTurn, notifySubject: "self",
    nextState: {
      ...next, crisis_state: "scaling", crisis_resume: resume, crisis_negation: negationType, pending_choice_set: "scaling",
      scaling_count: s.scaling_count + 1, choice_sets_shown: [...new Set([...s.choice_sets_shown, "scaling"])], watch_turns_left: 0,
    },
    event: { stage: 2, risk: eventRisk, ...negEvent, figurative: referenceOnly && figurative },
  });

  // ==== スケーリングのチップを出したあと ====
  if (s.crisis_state === "scaling") {
    const resume = s.crisis_resume ?? "done";
    const scale = choice?.set === "scaling" ? Number(choice.id.slice(1)) : typedScale(text);
    const userChoice = choice?.set === "scaling" ? choice : scale != null ? { set: "scaling", id: `S${scale}`, input: "typed" } : null;
    // 選ばずに自由に書いた・はっきりした新しいサインがある → 下げずに、止まっていた状態として続ける(続けてチップは出さない)
    if (scale == null || crisisSelf) {
      return planSafetyTurn({
        staged, text, withdrawal, figurative, teacherAnswer, choice: null,
        state: { ...state, ...s, crisis_state: resume, pending_choice_set: "scaling", crisis_resume: null, crisis_negation: null },
      });
    }
    const neg0 = s.crisis_negation;
    if (lowersStage(neg0, scale)) {
      // 1段階だけ下げる(2→1)。残りの固定の文面は出さず、気がかりの指示で生成し、気づかいのカードを出す。通知と記録は取り消さない
      return build({
        stage: 1, subject: "self", decidedBy: [...rules, "lowered"], userChoice,
        safetyContexts: ["tierB", "afterCrisis"], card: s.care_shown ? "hotlines" : "care",
        nextState: {
          ...next, crisis_state: "lowered", crisis_resume: resume, crisis_negation: null, care_shown: true, watch_turns_left: 0,
        },
        event: { stage: 1, scale, lowered: true, negation_type: neg0 },
      });
    }
    // 下げない: 選んだ数字を受け止める一言 → 止まっていた次の文面(1通目のあとなら2通目・3通目。3通目のあとは答えを待つ状態に戻る)
    const ack = bubble(SCALING_ACK_PROVISIONAL, 11);
    const tail = resume === "step1" ? afterStep1(s.crisis_trigger, next.crisis_category) : [];
    return build({
      stage: 2, subject: "self", decidedBy: [...rules, "scaling_kept"], userChoice, bubbles: [ack, ...tail],
      nextState: { ...next, crisis_state: resume === "step1" ? "step3" : resume, crisis_resume: null, crisis_negation: null, watch_turns_left: 0 },
      event: { stage: 2, risk: eventRisk, scale, negation_type: neg0 },
    });
  }

  // ==== 組B(「話したくない」の2択)を出したあと ====
  if (s.crisis_state === "choice_b") {
    if (choice?.id === "B1") {
      return build({
        stage: 2, subject: "self", decidedBy: [...rules, "choice_b1"], userChoice: choice,
        safetyContexts: ["choiceB1", "afterCrisis"], nextState: { ...next, crisis_state: "done" },
        event: { stage: 2, risk: eventRisk },
      });
    }
    if (choice?.id === "B2") {
      return build({
        stage: 2, subject: "self", decidedBy: [...rules, "choice_b2"], userChoice: choice,
        bubbles: [bubble(CHOICE_C_INTRO_PROVISIONAL, 12)], choices: { set: "C", items: CHOICES_C_PROVISIONAL },
        nextState: {
          ...next, crisis_state: "choice_c", pending_choice_set: "C", choice_sets_shown: [...new Set([...s.choice_sets_shown, "C"])],
        },
        event: { stage: 2, risk: eventRisk },
      });
    }
    // 選ばずに自由に書いた → 出し終えた状態として続ける(続けてチップは出さない)
    return planSafetyTurn({ staged, text, withdrawal, figurative, teacherAnswer, choice: null, state: { ...state, ...s, crisis_state: "done", pending_choice_set: "B" } });
  }

  // ==== 組C(「話せない」の背景)を出したあと ====
  if (s.crisis_state === "choice_c") {
    if (choice?.set === "C") {
      return build({
        stage: 2, subject: "self", decidedBy: [...rules, "choice_c"], userChoice: choice,
        bubbles: [bubble(CHOICE_C_ACK_PROVISIONAL[choice.id], 13)],
        nextState: { ...next, crisis_state: "done", crisis_choice_c: choice.id },
        event: { stage: 2, risk: eventRisk },
      });
    }
    return planSafetyTurn({ staged, text, withdrawal, figurative, teacherAnswer, choice: null, state: { ...state, ...s, crisis_state: "done", pending_choice_set: "C" } });
  }

  // ==== 1通目のあと(はっきりした打ち明けから始めた応答)====
  if (s.crisis_state === "step1" && s.crisis_trigger !== "accumulation") {
    // 組W(ここで話せた理由)のチップを押した → 選んだものを受け止める一言 + 3通目
    if (choice?.set === "W") {
      return build({
        stage: 2, subject: "self", decidedBy: [...rules, "choice_w"], userChoice: choice,
        bubbles: [bubble(CHOICE_W_ACK_PROVISIONAL[choice.id], 4), bubble(crisisStep3Text(), 3)],
        nextState: { ...next, crisis_state: "step3" },
        event: { stage: 2, risk: eventRisk },
      });
    }
    if (canScale) return scalingTurn("step1");
    const category = mergeCategory(s.crisis_category, stage === 2 ? categoryOfSafety(staged) : null);
    // 最初のターンで心配まで出している(組Wを出した)なら、自由に書いた答えを短く受け止めて3通目。
    // 以前の流れ(受け止めだけの1通目)の途中のセッションなら、今までどおり2通目・3通目
    const tail = s.choice_sets_shown.includes("W")
      ? [bubble(WHY_HERE_FREE_ACK_PROVISIONAL, 4), bubble(crisisStep3Text(), 3)]
      : concernAndQuestion(category);
    return build({
      stage: 2, subject: "self", decidedBy: [...rules, "crisis_flow"], bubbles: tail,
      notify: notifyThisTurn, notifySubject: subject,
      nextState: { ...next, crisis_state: "step3", crisis_category: category },
      event: { stage: 2, risk: eventRisk, ...negEvent, figurative: referenceOnly && figurative, crisis_category: category },
    });
  }

  // ==== 2通目・3通目のあと(相談先や大人に話したいかの答え)====
  if (s.crisis_state === "step3") {
    if (canScale) return scalingTurn("step3");
    const answer = ["yes", "no", "unclear"].includes(teacherAnswer) ? teacherAnswer : "unclear";
    const common = {
      stage: 2, subject: "self", decidedBy: [...rules, "crisis_flow"], notify: notifyThisTurn, notifySubject: subject,
      event: { stage: 2, risk: eventRisk, teacher_answer: answer, ...negEvent },
    };
    if (answer === "no" && !s.choice_sets_shown.includes("B")) {
      return build({
        ...common, bubbles: [bubble(CRISIS_STEP4_PROVISIONAL.no, 4)], choices: { set: "B", items: CHOICES_B_PROVISIONAL },
        nextState: { ...next, crisis_state: "choice_b", pending_choice_set: "B", choice_sets_shown: [...new Set([...s.choice_sets_shown, "B"])] },
      });
    }
    return build({
      ...common, bubbles: [bubble(CRISIS_STEP4_PROVISIONAL[answer === "no" ? "unclear" : answer], 4)],
      nextState: { ...next, crisis_state: "done" },
    });
  }

  // ==== 積み重なりで始めた1通目・再受け止めのあと(以前と同じ)====
  const accumulationStep1 = s.crisis_state === "step1" && s.crisis_trigger === "accumulation";
  if (accumulationStep1 || s.crisis_state === "again1") {
    const notify = stage === 2;
    if (!crisisSelf) {
      const pauseWatch = s.reentry_used ? 0 : WATCH_TURNS;
      return build({
        stage, subject, decidedBy: [...rules, "accumulation_pause"],
        safetyContexts: [...(stage === 1 ? ["tierB"] : stage === 2 ? ["thirdParty"] : []), "afterCrisis"],
        notify, notifySubject: subject,
        nextState: { ...next, crisis_state: "paused1", watch_turns_left: pauseWatch },
        event: { stage, watch_event: pauseWatch ? "start" : null },
      });
    }
    const category = mergeCategory(s.crisis_category, categoryOfSafety(staged));
    return build({
      stage: 2, subject: "self", decidedBy: [...rules, "crisis_flow"], bubbles: concernAndQuestion(category), notify, notifySubject: subject,
      nextState: { ...next, crisis_state: "step3", crisis_category: category, watch_turns_left: 0 },
      event: { stage: 2, risk: eventRisk, crisis_category: category },
    });
  }

  // ==== 段階1に下げたあと ====
  if (s.crisis_state === "lowered") {
    if (crisisSelf) {
      // はっきりした危機のサイン → 段階2に戻して通知する。止まっていた流れの続きから
      const back = continueFrom(s.crisis_resume ?? "done", { crisis_resume: null }, [...rules, "raised_after_lowered"]);
      return build({
        stage: 2, subject: "self", decidedBy: [...rules, "raised_after_lowered"], notify: true, notifySubject: "self", ...back,
        event: { stage: 2, risk: eventRisk, crisis_category: next.crisis_category },
      });
    }
    if (stage === 2) {
      return build({
        stage: 2, subject: "other", notify: true, notifySubject: "other", safetyContexts: ["thirdParty", "afterCrisis"],
        event: { stage: 2 },
      });
    }
    // 段階1から0には下げない
    return build({ stage: 1, safetyContexts: ["tierB", "afterCrisis"], event: stage >= 1 ? { stage: 1 } : null });
  }

  // ==== 固定の文面を出し終えたあと(段階2のまま生成で続ける)====
  if (s.crisis_state === "done") {
    if (canScale) return scalingTurn("done");
    if (crisisSelf) {
      return build({
        stage: 2, subject: "self", notify: true, notifySubject: "self", ...afterAllSteps(),
        event: { stage: 2, risk: eventRisk },
      });
    }
    if (stage === 2 && subject === "other") {
      return build({
        stage: 2, subject: "other", notify: true, notifySubject: "other", safetyContexts: afterCtx(["thirdParty"]),
        event: { stage: 2 },
      });
    }
    // 「死にたいとか冗談だよ」で、スケーリングを出せないとき(直前がチップ・回数の上限)は、指示つきの生成。通知は上の規則どおり
    if (referenceOnly) {
      return build({
        stage: 2, subject: "self", notify: notifyThisTurn, notifySubject: "self", safetyContexts: afterCtx(),
        event: { stage: 2, risk: eventRisk, ...negEvent, figurative },
      });
    }
    return build({
      stage, safetyContexts: afterCtx(stage === 1 ? ["tierB"] : []),
      event: stage >= 1 || negationType ? { stage, ...negEvent } : null,
    });
  }

  // ==== それ以外(まだ危機の応答を始めていない・積み重なりで止めたあと)====
  const watching = s.watch_turns_left > 0;
  const paused = s.crisis_state === "paused1";
  let escalated = false;
  if (watching && isSign && !(paused && s.reentry_used)) {
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
    const category = mergeCategory(next.crisis_category, categoryOfSafety(staged));
    const common = {
      stage: 2, subject: "self", notify: true, notifySubject: "self",
      event: { stage: 2, watch_event: watchEvent, crisis_category: category },
    };
    if (s.crisis_state === "none") {
      // 積み重なり(見守り中の再サイン)は今までどおり、受け止めだけの1通目(折りたたみの窓口)
      if (trigger === "accumulation") {
        return build({
          ...common, bubbles: [bubble(CRISIS_STEP1_PROVISIONAL, 1, "hotlines")],
          nextState: { ...next, crisis_state: "step1", crisis_trigger: trigger, watch_turns_left: 0, crisis_category: category },
        });
      }
      return build({
        ...common, bubbles: firstTurnBubbles(category), choices: { set: "W", items: CHOICES_W_PROVISIONAL },
        nextState: {
          ...next, crisis_state: "step1", crisis_trigger: trigger, watch_turns_left: 0, crisis_category: category,
          choice_sets_shown: [...new Set([...s.choice_sets_shown, "W"])],
        },
      });
    }
    // 積み重なりで止めたあと(paused1)。見守り中の再サイン(watch 相当)なら再受け止め(1回まで)、はっきりしたサインなら続きへ
    if (escalated && !s.reentry_used) {
      return build({
        ...common, decidedBy: [...rules, "reentry"], bubbles: [bubble(CRISIS_AGAIN_PROVISIONAL, 6)],
        nextState: { ...next, crisis_state: "again1", crisis_trigger: trigger, watch_turns_left: 0, reentry_used: true, crisis_category: category },
      });
    }
    return build({ ...common, ...continueFrom("step1", { crisis_trigger: trigger, crisis_category: category }) });
  }

  // 段階2(第三者): 生成を続けて第三者への懸念の指示を付ける
  if (stage === 2) {
    const { nextState, ended } = countdown();
    return build({
      stage: 2, subject: "other", notify: true, notifySubject: "other",
      safetyContexts: ["thirdParty", ...(paused ? ["afterCrisis"] : [])],
      nextState, event: { stage: 2, watch_event: ended ? "end" : null },
    });
  }

  // 段階1
  if (stage === 1) {
    const contexts = ["tierB", ...(paused ? ["afterCrisis"] : [])];
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
    stage: 0, safetyContexts: paused ? ["afterCrisis"] : [], nextState,
    event: ended ? { stage: 0, watch_event: "end" } : null,
  });
}

// ----------------------------------------------------------------------------
// 軽いモデルによる補助判定(否定 C・比喩・相談先や大人に話したいかの答え)。形式は responseSchema で強制する。
// 失敗したら安全側に倒す(判定なし = 否定として扱わない・比喩としない / どちらでもない)。
// ----------------------------------------------------------------------------
const JUDGE_MAX_OUTPUT_TOKENS = 4096;

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

// 返事の種類の判定(以前の judgeRetraction・引き下がりの判定を引き継ぐ)。「引き下がり」がキーワードによらない否定(C)に当たる。
// この判定だけで段階は変えない(スケーリングのチップを出すかどうかに使う)。2026年10月9日に、比喩の判定(figurative)を足した
// (「死にたいとか冗談だよ」のような発言の「死にたい」が日常の誇張・比喩なら、職員に通知しない)。
// 判定できなかったとき(エラー・時間切れ)は type = null・figurative = false(否定として扱わない・通知する側)。
export const WITHDRAWAL_TYPES = ["withdrawal", "resignation", "reaffirm", "other"];
const WITHDRAWAL_PROMPT = `あなたは中高生向け相談AIの補助判定器です。次のJSONだけを返します。
{"reply_type": "withdrawal|resignation|reaffirm|other", "figurative": true|false, "reason": "20字以内"}

状況: 相談者が少し前に深刻なこと(死にたい気持ち・自傷・被害など)を書き、AIが受け止めの言葉を返しました
(そのあと、話せる窓口の案内や、問いかけをしている場合もあります)。

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり
【判定する発言】相談者の最新の発言

1. reply_type: 【判定する発言】がどの種類の返事かを、次の4つから選んでください。
withdrawal(引き下がり): 先に書いた深刻な内容を取り消す・引っ込める・小さく言い直す返事、またはこの話そのものを続けたくないという返事。
  例:「冗談だよ」「うそうそ」「ネタだから」「大げさに言っただけ」「今のなし」「なんでもない」「忘れて」「大丈夫」「別に」
  「気にしないで」「別にそんな大したことじゃないし」「その話はしたくない」「もうこの話はいい」「ほっといて」「もういい」
resignation(諦め): 諦め・投げやり・どうせ変わらないという気持ちを表す返事。
  例:「もういい、どうせ」「どうせ誰もわかってくれない」「話しても意味ない」「何をしても変わらない」「もう無理」「もうどうでもいい」
reaffirm(念押し): 先に書いた深刻な内容がほんとうだ・続いていると認める返事。
  例:「本気だよ」「冗談じゃない」「ほんとにそう思ってる」「ずっとそう」「冗談っぽく書いたけど本気」「やっぱり死にたい」
other(ふつうの返事): それ以外。AIの問いかけへの答え(否定的な答えも含む)、短いあいづち、話題を変えた返事など。
  例:「うん」「ありがとう」「わからない」「親には話せない」「先生には言いたくない」「話してみようかな」

判定のしかた:
・AIの問いかけ(まわりの大人に話してみたいか など)への答えは、「話したくない」「言いたくない」のような否定的な答えでも other にする。
  ただし「その話はしたくない」「もうこの話はいい」のように、この話題そのものを続けたくないと言っている場合は withdrawal にする。
・引き下がりの言葉と、諦め・無力感(「どうせ」「もう無理」「意味ない」など)が一緒に書かれている場合は resignation にする。
・「冗談じゃない」「本気」のように、打ち消しの言葉を否定している場合は reaffirm にする。
・迷ったら withdrawal にしない。

2. figurative: 【判定する発言】の中に「死にたい」「消えたい」などの言葉があり、それが日常の出来事の誇張・比喩・強調として
  使われている(本気の気持ちではないと文の中で示されている)なら true。
  例(true):「テストやばすぎて死にたいって意味ね」「恥ずかしすぎて消えたいってこと」「部活きつすぎて死ぬって言っただけ」
  例(false):「死にたいとか冗談だよ」(前の打ち明けを打ち消しているだけで、誇張の言い方ではない)「本気で死にたい」
  そういう言葉が無い発言は false。迷ったら false。`;

const WITHDRAWAL_SCHEMA = {
  type: "OBJECT",
  properties: { reply_type: { type: "STRING", enum: WITHDRAWAL_TYPES }, figurative: { type: "BOOLEAN" }, reason: { type: "STRING" } },
  required: ["reply_type", "figurative", "reason"],
  propertyOrdering: ["reply_type", "figurative", "reason"],
};

// 戻り値: { type: 返事の種類 | null, withdrawal: 引き下がりか, figurative: 比喩か, vote, error }
export async function judgeWithdrawal(text, recentMessages = []) {
  const input = buildClassifierInput(text, recentMessages);
  const r = await withTimeout(judgeOnce(WITHDRAWAL_PROMPT, WITHDRAWAL_SCHEMA, input, (p) => {
    if (!WITHDRAWAL_TYPES.includes(p.reply_type)) throw new Error(`想定外の reply_type: ${p.reply_type}`);
    return { type: p.reply_type, figurative: p.figurative === true };
  }));
  return {
    type: r.ok ? r.type : null, withdrawal: r.ok && r.type === "withdrawal", figurative: r.ok && r.figurative === true,
    vote: r, error: r.ok ? null : r.error,
  };
}

// 3通目(相談先や大人に話したいか)への答えの判定。答えの一言の出し分けと、組Bのチップを出すかに使う
const TEACHER_PROMPT = `あなたは中高生向け相談AIの補助判定器です。次のJSONだけを返します。
{"answer": "yes|no|unclear", "reason": "20字以内"}

状況: AIが相談者に、画面にのせた相談先(窓口)や、先生・おうちの人など、まわりの大人に話してみたいかをたずねました。

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり
【判定する発言】相談者の最新の発言(上の問いへの答え)

answer の基準:
yes: 相談先やまわりの大人に話すことに前向き(「話してみる」「いいかも」「話せそう」「先生なら話せるかも」など)
no: 話すことに後ろ向き(「いやだ」「話したくない」「無理」「言いたくない」「話せない」など)
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
// choiceId: 相談者が押したチップ(画面から送られた choice_id)。直前の返事に付けた組のものだけ受け付ける。
// チップを押したターンは分類器にかけない(ラベルは固定の文で、本人の言葉ではないため。段階はそのまま。2026年10月9日に人が確認)
// ----------------------------------------------------------------------------
/** @param {string|null} [choiceId] */
export async function assessSafetyTurn(text, recentMessages, state, choiceId = null) {
  const s = normalizeSafetyState(state);
  const choice = validateChoice(s, choiceId);
  if (choice) {
    const staged = {
      risk: "none", subject: "self", stage: 0, decidedBy: ["choice"], keywords: [], patterns: [], idiomExempted: [], floor: [], hits: [],
      keywordVersion: null, model: { risk: "チップ", subject: "self", reason: "チップを押したターンは分類器にかけない" },
      classifierError: null, usedModel: null, votes: [], classifierMode: "choice",
    };
    const plan = planSafetyTurn({ staged, state: s, text: "", choice });
    return { staged, withdrawal: null, teacher: null, plan, choice };
  }
  const [staged, withdrawal, teacher] = await Promise.all([
    classifyStaged(text, recentMessages ?? [], { mode: classifierModeFor(s) }),
    needsWithdrawalJudge(s) ? judgeWithdrawal(text, recentMessages ?? []) : Promise.resolve(null),
    s.crisis_state === "step3" ? judgeTeacherAnswer(text, recentMessages ?? []) : Promise.resolve(null),
  ]);
  const plan = planSafetyTurn({
    staged, state: s, text, withdrawal: withdrawal?.type ?? null, figurative: withdrawal?.figurative === true,
    teacherAnswer: teacher?.answer ?? null,
  });
  return { staged, withdrawal, teacher, plan, choice: null };
}
