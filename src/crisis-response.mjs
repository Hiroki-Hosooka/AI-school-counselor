// ============================================================================
//  危機検知の作り直し 第2段階: 段階ごとの応答(2026年9月)
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │ 【仮】このファイルの文面・指示は、すべて仮のもの(心理士の確認待ち)。        │
//  │  名前の末尾が _PROVISIONAL の定数が仮の文面・指示。                          │
//  │  設定 CRISIS_RESPONSE=staged のときだけ使う(既定は無効)。心理士の確認が取れる │
//  │  まで、本番(main)では有効にしないこと。                                      │
//  │  例外: 危機のあとの指示(AFTER_CRISIS_BLOCK_PROVISIONAL)だけは、本番の既定でも │
//  │  使う(2026年10月5日に人が決めた。仮のまま。CLAUDE.md 5.17)。               │
//  └──────────────────────────────────────────────────────────────┘
//
//  無効のときは第1段階と同じ動き(段階2 = 今の固定応答 CRISIS_REPLY、段階1 = 今の Tier B)。ただし、
//  固定応答を出したセッションでは、以後の生成に危機のあとの指示を付ける(下の aftercareEnabled / hadCrisisReply /
//  defaultSafetyContexts。設定 CRISIS_AFTERCARE=off のときだけ以前の動きに戻る)。
//  有効にする前に db/schema.sql の11節〜13節(状態と記録の列)を Supabase で実行しておくこと。
//
//  このファイルに置くもの
//   ・仮の文面・仮の指示(_PROVISIONAL)
//   ・1ターンの扱いを決める planSafetyTurn(状態の移り変わり。副作用なし)
//   ・引き下がりの判定 judgeWithdrawal / 先生についての答えの判定 judgeTeacherAnswer(軽いモデル)
//   ・それらをまとめて呼ぶ assessSafetyTurn(src/app/api/chat/route.ts と
//     scripts/test-persona-regression.mjs が同じものを使う)
//   ・本番の既定で「危機のあと」を保つための関数(aftercareEnabled / hadCrisisReply / defaultSafetyContexts)
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
//                     見守り中の再サインで上がった段階2(積み重なり)は、1通目への返事に、はっきりした危機のサイン
//                     (キーワード・受動パターン・分類器の危機判定)があるときだけ2通目に進む。無ければ見守りに戻す。
//   引き下がり    … 「引き下がりは問いを止める理由にはなるが、窓口を伝えない理由にはならない」(2026年10月5日に人が決めた。
//                     以前の「打ち消し」(2回とも打ち消しなら段階1に下げて残りの文面を止める)をやめて置き換えた)。
//                     はっきりした打ち明けから始めた1通目のあと・2通目・3通目のあとの返事を、軽いモデルで1回判定する
//                     (引き下がり / 諦め / 念押し / ふつうの返事)。段階は下げない(会話は最後まで「危機のあと」。
//                     通知と記録は取り消さない)ので、2回一致は条件にしない。
//                     ・引き下がり(なんでもない・忘れて・冗談だよ など)→ 残りの問いを出さず「まとめの1通」。
//                       1通目のあとは折りたたみの窓口を添える。2・3通目のあとは窓口がすでに届いているので短く。
//                     ・2回目の引き下がり → 終わりを受け入れる短い1通だけ(3回目以降は固定の文面をくり返さず生成)
//                     ・諦め・念押し・ふつうの返事 → 今どおり次の文面へ
//                     ・新しいサイン(キーワード・受動パターン・分類器の危機判定)は、引き下がりより必ず優先し、通知する。
//   止めたあとの再サイン … 積み重なりで止めたあとの見守り中に、watch 相当のサインがもう一度出たら、
//                     受け止めだけの短い1通(再受け止め)を出す(1回の会話で1回まで。出したあとは見守らないので、
//                     以後の watch 相当のサインは危機のあとの指示つきの生成で受ける)。再受け止めへの返事に、はっきりした
//                     危機のサインがあるときだけ続きの文面に進む。止めたあと(積み重なり・引き下がり)に、はっきりした
//                     危機のサインが出たときは、止めていた続きの文面へ進む。
//   危機の応答のあと … 4通目まで出したあとは見守らない(見守り中のサインで段階2に上げない)。キーワード・受動パターンに
//                     よる新しい打ち明けには、短い受け止めと危機カードの1通を出す(1回の会話で1回まで)。
//                     分類器だけの危機の判定と、2回目以降の打ち明けは、固定の文面を出さず、危機の状態の指示を付けた
//                     生成で受ける(出力チェックを通らなければ固定の返事に置き換える。職員への通知は毎回。CLAUDE.md 5.2)。
//   判定          … 見守り中・危機の応答を始めたあとは、分類器に「その発言そのものに新しい危機のサインがあるか」を
//                     判定させる(src/classify.mjs の CLASSIFIER_PROMPT_V2_FOLLOWUP。文脈は指示語・言い直しを
//                     読み取るためだけに使う)。すでに対応した打ち明けを、そのあとの発言で数え直さないため。
//                     通常の状態の判定(CLASSIFIER_PROMPT_V2)は変えていない。
//                     (2026年9月26日のペルソナテストで、見守りを続けたために「もう無理」系の発言のたびに同じ1通が
//                     9回続いた、通常の判定が直前の危機の流れを引きずり「だる」「別に」のようなふつうの返事でも
//                     2通目以降に進んだ、4通目のあとに同じ短い1通が3回続いた、という不具合があったため。
//                     2026年9月29日に人が確認した方針)
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

// 積み重なりで止めたあとの見守り中に、もう一度サインが出たときの受け止めだけの短い1通(再受け止め)。
// 1通目と同じ文面を2回出さないための別の言い方。見守り中のサインは気持ちの表現(watch 相当)が多いので、
// 気持ちを受け止める言い方にしている。
export const CRISIS_AGAIN_PROVISIONAL = "そう感じているんだね。書いてくれてありがとう。";

// 同じ会話で2回目以降の段階2(危機カードを添える)。1通目から繰り返さないための短い1通。
// キーワード・受動パターンによる新しい打ち明けのときだけ、1回の会話で1回まで出す(2026年9月29日)。
export const CRISIS_REPEAT_PROVISIONAL =
  "また書いてくれてありがとう。ひとりで抱えなくていいからね。下の窓口や、学校の先生にも、あなたの声を届けてほしいです。";

// 引き下がり(なんでもない・忘れて・冗談だよ など)への「まとめの1通」(2026年10月5日)。
// 引き下がりは問いを止める理由にはなるが、窓口を伝えない理由にはならない。
// 引き下がる気持ちの受け止め / 「さっき書いてくれたことは、ちゃんと受け取った」を一度だけ /
// ここで話すのをやめてほしいわけではない / 折りたたみの窓口を添える。話しにくい理由・先生についての問いは出さない。
// 1通目のあとの引き下がりに使う(1通目への返事なので、まだ問いかけはしていない)。
export const CRISIS_WRAPUP_PROVISIONAL =
  "そっか、わかった。無理に話さなくていいよ。\n\n" +
  "さっき書いてくれたことは、ちゃんと受け取ったよ。ここで話すのをやめてほしいわけではないからね。" +
  "下に、名前を言わなくても話せる窓口ものせておくね。";

// 2通目・3通目のあとの引き下がりへの、短いまとめの1通。窓口はすでに届いている(2通目の危機カード)ので添えない。
// 2通目・3通目は問いかけなので、「答えなくていい」と受け止める。
export const CRISIS_WRAPUP_SHORT_PROVISIONAL =
  "そっか、わかった。無理に答えなくていいよ。さっき書いてくれたことは、ちゃんと受け取ったよ。" +
  "ここで話すのをやめてほしいわけではないからね。";

// 2回目の引き下がりへの、終わりを受け入れる短い1通。「今は」として、この先の対応(もう触れない など)は約束しない。
export const CRISIS_WITHDRAW_END_PROVISIONAL = "うん、わかった。この話は、今はここまでにしようね。";

// 危機の状態で生成した返事が出力チェック(禁止表現・秘密の約束・いつでも など)を通らなかったとき、
// または生成に失敗したときに、代わりに出す固定の返事(2026年9月29日)。同じ返事を2回出さないよう2つ用意し、
// このセッションで何回目かで選ぶ(3回目以降は2つ目をくり返す)。
export const CRISIS_GENERATION_FALLBACK_PROVISIONAL = [
  "書いてくれてありがとう。ちゃんと読んでいるよ。",
  "うん、読んでいるよ。話してくれてありがとう。",
];

// ----------------------------------------------------------------------------
// 【仮の指示】生成のときに src/generate.mjs の buildSystem が足す指示(心理士の確認待ち)。
// モデルが「仮」という言葉を生徒に出さないよう、仮であることはプロンプトの中には書かない。
// ----------------------------------------------------------------------------
// 危機のあとの指示。段階ごとの応答のときと、本番の既定(固定応答を出したあとの生成。CLAUDE.md 5.17)の両方で使う。
// (以前は打ち消しのターンに RETRACTION_BLOCK_PROVISIONAL も足していたが、2026年10月5日に打ち消しを引き下がりの流れに
// 置き換え、引き下がりには固定の文面で応えるようにしたので、なくした)
export const AFTER_CRISIS_BLOCK_PROVISIONAL = `

# このセッションについて(重要・危機の応答のあと)
このセッションでは少し前に、相談者の発言に深刻なサインがあり、あらかじめ決めた文面で受け止めました
(そのあと、話せる窓口の案内や、学校の先生に話すことについての問いかけをした場合もあります)。
・危機の内容そのもの(なぜそう思うのか、方法・時期・場所など)を深掘りしない
・窓口の案内をくり返さない(窓口は画面に表示してある)
・この先の対応を約束しない(「もう窓口の話はしない」「誰にも言わない」「秘密にする」など)
・人に話すこと(先生・保健室・窓口など)を「しなくていい」「面倒なものだ」と同調しない。
  話しにくい気持ちは受け止めつつ、人につながる道は閉じない
・「いつでも」「いくらでも」という言い方はしない。「ここにいてくれるだけで十分」のように、
  このAIだけを頼りにする方向に寄せない(相手が最終的に頼るのは、身近な人や窓口)
・インテークの質問(相談の種類・つらさの点数など)は続けない
・本人が話したいことに沿って、ゆっくり会話を続ける。本人が話題を変えたら、それに合わせてよい`;

// 危機の状態で、固定の文面を出さずに生成で受けるターン(分類器だけの危機の判定・2回目以降の打ち明け)に足す指示。
// AFTER_CRISIS_BLOCK_PROVISIONAL と一緒に使う(2026年9月29日)。
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

// 危機の状態で生成した返事にだけ足す出力チェック(src/safety.mjs の OUTPUT_NG に加えて使う。OUTPUT_NG は緩めていない)。
// 通常の会話では、クロージングの「また何かあったら、いつでもどうぞ」を通すため「いつでも」を
// OUTPUT_NG で絞っている(CLAUDE.md 5.6)が、危機の状態ではクロージングの場面ではないので、どの「いつでも」も通さない。
// 窓口の番号は画面の固定の表示だけにし、モデルには書かせない(CLAUDE.md 5.15 と同じ考え方)。
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

// 危機の状態で生成した返事の仕上げ(route.ts とペルソナテストで共通)。
// gen は generateReply() の戻り値。出力チェックを通らなかった(checkFailed)とき、または生成に失敗した
// (generationFailed)ときは、固定の返事(CRISIS_GENERATION_FALLBACK_PROVISIONAL)に置き換える。
// priorFallbackCount: このセッションで、すでに固定の返事に置き換えた回数(同じ返事を2回出さないため)
export function finalizeCrisisGeneration(gen, priorFallbackCount = 0) {
  if (!gen.generationFailed && !gen.checkFailed) return { out: gen.out, flags: gen.flags, fallback: false };
  const why = gen.generationFailed ? `生成失敗: ${gen.failureCause}` : `出力チェック: ${gen.flags.join(" / ")}`;
  const list = CRISIS_GENERATION_FALLBACK_PROVISIONAL;
  const reply = list[Math.min(Math.max(priorFallbackCount, 0), list.length - 1)];
  return { out: { ...gen.out, reply }, flags: [`${CRISIS_FALLBACK_FLAG}(${why})`], fallback: true };
}

// ----------------------------------------------------------------------------
// セッションの状態(db/schema.sql 11節〜13節の sessions の列)
//   watch_turns_left 見守りの残りターン(0 = 見守っていない)
//   crisis_state     none / step1〜3(その文面を出して返事を待っている)/ done(4通目まで出した)/
//                    paused1〜3(その文面のあと、積み重なり・引き下がりで止めた)/
//                    again1〜3(paused のあとの再サインで、再受け止めの1通を出して返事を待っている)/
//                    wrap1〜3(その文面のあとの引き下がりに、まとめの1通を出して返事を待っている。13節)
//   crisis_trigger   いまの危機の応答のきっかけ: direct(キーワード・受動パターン・分類器の危機)/
//                    accumulation(見守り中の再サイン)
//   care_shown       気づかいの一言をこのセッションで出したか
//   reentry_used     再受け止めをこのセッションで出したか(1回まで)
//   repeat_used      2回目以降の短い1通(固定)をこのセッションで出したか(1回まで。db/schema.sql 12節)
//   withdrawal_count 危機の応答の中で引き下がった回数(1回目 = まとめの1通、2回目 = 終わりを受け入れる1通。
//                    同じ固定の文面を2回出さないために数える。db/schema.sql 13節)
// 危機の応答を始めたら(crisis_state が none 以外になったら)、そのセッションの最後まで none には戻さない。
// ----------------------------------------------------------------------------
export const SAFETY_STATE_COLUMNS = "watch_turns_left,crisis_state,crisis_trigger,care_shown,reentry_used,repeat_used,withdrawal_count";
const CRISIS_STATES = [
  "none", "step1", "step2", "step3", "done", "paused1", "paused2", "paused3", "again1", "again2", "again3", "wrap1", "wrap2", "wrap3",
];
const FLOW_STEP = { step1: 1, step2: 2, step3: 3 };
const PAUSED_STEP = { paused1: 1, paused2: 2, paused3: 3 };
const AGAIN_STEP = { again1: 1, again2: 2, again3: 3 };
const WRAP_STEP = { wrap1: 1, wrap2: 2, wrap3: 3 };

export function normalizeSafetyState(state) {
  const w = state?.watch_turns_left;
  const wc = state?.withdrawal_count;
  return {
    watch_turns_left: Number.isInteger(w) && w > 0 ? w : 0,
    crisis_state: CRISIS_STATES.includes(state?.crisis_state) ? state.crisis_state : "none",
    crisis_trigger: ["direct", "accumulation"].includes(state?.crisis_trigger) ? state.crisis_trigger : null,
    care_shown: state?.care_shown === true,
    reentry_used: state?.reentry_used === true,
    repeat_used: state?.repeat_used === true,
    withdrawal_count: Number.isInteger(wc) && wc > 0 ? wc : 0,
    closing_state: typeof state?.closing_state === "string" ? state.closing_state : "none",
  };
}

// どちらの分類器で判定するか。見守り中・危機の応答を始めたあとは、その発言そのものに新しい危機のサインが
// あるかだけを判定する分類器(followup)。それ以外は通常の分類器(normal = CLASSIFIER_PROMPT_V2。変えていない)
export function classifierModeFor(state) {
  const s = normalizeSafetyState(state);
  return s.watch_turns_left > 0 || s.crisis_state !== "none" ? "followup" : "normal";
}

// 引き下がりの判定をするか(2026年10月5日)。はっきりした打ち明けから始めた1通目のあと・2通目・3通目のあと
// (問いを止めるかどうかを決める)と、まとめの1通のあと(2回目の引き下がりを見る)だけ。
// 積み重なりの1通目・再受け止めへの返事は、今どおり、はっきりした危機のサインが無ければ止めるので判定しない。
export function needsWithdrawalJudge(state) {
  const s = normalizeSafetyState(state);
  if (s.crisis_state === "step1") return s.crisis_trigger !== "accumulation";
  return s.crisis_state === "step2" || s.crisis_state === "step3" || WRAP_STEP[s.crisis_state] != null;
}

// ----------------------------------------------------------------------------
// 本番の既定(段階ごとの応答が無効)でも「危機のあと」を保つ(2026年10月5日に人が決めた。CLAUDE.md 5.17)。
// 以前は、本人の危機の固定応答(CRISIS_REPLY)の次のターンで「なんでもない」と書くと、ふつうの会話に戻っていた。
// 固定応答を出したセッションでは、以後の生成に危機のあとの指示(AFTER_CRISIS_BLOCK_PROVISIONAL。深掘りしない・
// 秘密を約束しない・人につながる道を閉じない など)を付け続ける。判定(分類器)と固定応答の分岐は変えていない。
// 状態は、そのセッションの messages に固定応答(crisis = true の AI の発言)があるかで決める(列を足さないので、
// db/schema.sql 11節〜13節が未実行の DB でも動く)。設定 CRISIS_AFTERCARE=off のときだけ以前の動きに戻る。
// ----------------------------------------------------------------------------
export function aftercareEnabled() {
  return process.env.CRISIS_AFTERCARE !== "off";
}

// このセッションで、本人の危機の固定応答を出したか(messages の行: { role: "user" | "ai", crisis })
export function hadCrisisReply(messages) {
  return (messages ?? []).some((m) => m?.role === "ai" && m?.crisis === true);
}

// 本番の既定の生成に付ける安全の文脈(段階ごとの応答が無効なとき)。risk・subject は classifyStaged() / classify() の値
export function defaultSafetyContexts({ risk, subject, afterCrisis }) {
  const base = risk === "watch" ? ["tierB"] : risk === "crisis" && subject === "other" ? ["thirdParty"] : [];
  return afterCrisis ? [...base, "afterCrisis"] : base;
}

const riskOf = (stage) => (stage === 2 ? "crisis" : stage === 1 ? "watch" : "none");

// 記録・テストの表示用の読み方(scripts/ の検証スクリプトで共通に使う。画面側の page.tsx・admin.html は別に持つ)
// 危機の応答の何通目か(crisis_step。1〜4 は「n通目」)と、引き下がりの判定の返事の種類
export const CRISIS_STEP_LABELS = { 5: "2回目以降の短い1通", 6: "再受け止め", 7: "まとめの1通", 8: "短いまとめの1通", 9: "終わりを受け入れる1通" };
export const crisisStepLabel = (n) => (n == null ? "生成" : CRISIS_STEP_LABELS[n] ?? `${n}通目`);
export const REPLY_TYPE_LABELS = { withdrawal: "引き下がり", resignation: "諦め", reaffirm: "念押し", other: "ふつうの返事" };

// ----------------------------------------------------------------------------
// 1ターンの扱いを決める(副作用なし。scripts/test-staged-response.mjs でオフラインに確かめている)
//
// 引数
//   staged        classifyStaged() の戻り値(stage / subject / decidedBy / keywords / patterns)
//   state         セッションの状態(上の列 + closing_state)
//   withdrawal    judgeWithdrawal() の判定した返事の種類("withdrawal" 引き下がり | "resignation" 諦め |
//                 "reaffirm" 念押し | "other" ふつうの返事)。判定しないターン・判定できなかったときは null
//   teacherAnswer "yes" | "no" | "unclear"(3通目のあとだけ)。無ければ null
// 戻り値
//   stage / risk / subject / decidedBy  このターンの扱い(記録用。decidedBy には第2段階の規則も足す:
//        watch_repeat 見守り中の再サイン / reentry 止めたあとの再受け止め / closing_exception クロージングの例外 /
//        withdrawal 引き下がり(まとめの1通)/ withdrawal_end 2回目の引き下がり(終わりを受け入れる1通)/
//        withdrawal_repeat 3回目以降の引き下がり(固定の文面をくり返さず生成)/
//        withdrawal_ignored_sign 引き下がりと判定したが、新しいサインがあるので優先した / resignation 諦めと判定(次の文面へ)/
//        accumulation_pause 積み重なり・再受け止めへの返事に、はっきりした危機のサインが無いので止めた /
//        crisis_flow 危機の応答の続き / crisis_generation 危機の状態で、固定の文面を出さずに指示つきの生成で受けた)
//   action        "fixed"(固定の文面を出す。生成しない)| "generate"(生成する)
//   text          action = fixed のときの文面
//   crisisStep    危機の応答の何通目か(1〜4。5 = 2回目以降の短い1通、6 = 再受け止め、7 = まとめの1通、
//                 8 = 短いまとめの1通、9 = 終わりを受け入れる1通)。危機の応答でなければ null
//   card          応答の下に出すもの: null | "care"(気づかいの一言+折りたたみの窓口)|
//                 "hotlines"(折りたたみの窓口だけ)| "crisis"(危機カード)
//   safetyContexts 生成のときに retrieve / buildSystem に渡す文脈
//                 ("tierB"|"thirdParty"|"afterCrisis"|"crisisGeneration")
//   crisisGenerated 危機の状態で生成するターンか(出力チェックを強め、記録で見分けられるようにする。CLAUDE.md 5.2)
//   notify / notifySubject  職員に通知するか(段階2を検知するたび。今と同じ)と、その本人/第三者の区別
//   nextState     sessions に書き戻す状態
//   event         safety_events に書く内容(書かなくてよいターンは null)
// ----------------------------------------------------------------------------
export function planSafetyTurn({ staged, state, withdrawal = null, teacherAnswer = null }) {
  const s0 = normalizeSafetyState(state);
  // まとめの1通を出したあと(wrap)は、止めている状態(見守りなし)として扱う。2回目の引き下がりだけ、下で別に扱う
  const wrapN = WRAP_STEP[s0.crisis_state];
  const s = wrapN != null ? { ...s0, crisis_state: `paused${wrapN}`, watch_turns_left: 0 } : s0;
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
  // はっきりした危機のサイン(本人): キーワード・受動パターン・分類器の危機判定による段階2
  const crisisSelf = stage === 2 && subject === "self";
  // 新しいサイン(キーワード・受動パターン・分類器の危機判定。本人・第三者とも)。引き下がりより必ず優先する(2026年10月5日)
  const newSign = stage === 2;
  // 引き下がり(なんでもない・忘れて・冗談だよ など)と判定した返事か(判定は1回。段階を下げないので2回一致は条件にしない)
  const isWithdrawal = withdrawal === "withdrawal";

  const next = {
    watch_turns_left: s.watch_turns_left, crisis_state: s.crisis_state,
    crisis_trigger: s.crisis_trigger, care_shown: s.care_shown, reentry_used: s.reentry_used,
    repeat_used: s.repeat_used, withdrawal_count: s.withdrawal_count,
  };
  // 危機の応答を始めたあと(止めている・終えた)は、生成に危機のあとの指示を付ける
  const afterCrisis = s.crisis_state === "done" || PAUSED_STEP[s.crisis_state] != null;
  // 積み重なりで止めたあとの見守りは、再受け止めをまだ使っていないときだけ(使ったあとは見守らない)
  const pauseWatch = s.reentry_used ? 0 : WATCH_TURNS;
  const build = (p) => {
    const contexts = p.safetyContexts ?? [];
    return {
      stage: p.stage, risk: p.risk ?? riskOf(p.stage), subject: p.subject ?? subject,
      decidedBy: p.decidedBy ?? rules,
      action: p.action ?? "generate", text: p.text ?? null, crisisStep: p.crisisStep ?? null,
      card: p.card ?? null, safetyContexts: contexts, crisisGenerated: p.crisisGenerated === true,
      notify: p.notify === true, notifySubject: p.notifySubject ?? p.subject ?? subject,
      provisional: p.action === "fixed" || p.card === "care"
        || contexts.includes("afterCrisis") || contexts.includes("crisisGeneration"),
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
  // n: 1〜4 = 危機の応答の n通目、5 = 2回目以降の短い1通、6 = 再受け止め、
  //    7 = まとめの1通(折りたたみの窓口つき)、8 = 短いまとめの1通、9 = 終わりを受け入れる1通
  const FIXED_TEXT = {
    1: CRISIS_STEP1_PROVISIONAL, 2: CRISIS_STEP2_PROVISIONAL, 3: CRISIS_STEP3_PROVISIONAL,
    5: CRISIS_REPEAT_PROVISIONAL, 6: CRISIS_AGAIN_PROVISIONAL,
    7: CRISIS_WRAPUP_PROVISIONAL, 8: CRISIS_WRAPUP_SHORT_PROVISIONAL, 9: CRISIS_WITHDRAW_END_PROVISIONAL,
  };
  const fixedStep = (n, extra = {}) => ({
    action: "fixed", crisisStep: n,
    text: n === 4 ? CRISIS_STEP4_PROVISIONAL[extra.teacherAnswer] ?? CRISIS_STEP4_PROVISIONAL.unclear : FIXED_TEXT[n],
    card: n === 1 || n === 7 ? "hotlines" : n === 2 || n === 5 ? "crisis" : null,
  });
  // 危機の状態で、固定の文面を出さずに指示つきの生成で受ける(2026年9月29日。CLAUDE.md 5.2)。
  // 固定の文面をくり返すと負担になるため。職員への通知は毎回出し、記録で見分けられるようにする
  const crisisGeneration = (extraNext = {}, baseRules = rules) => ({
    action: "generate", crisisGenerated: true, safetyContexts: ["crisisGeneration", "afterCrisis"],
    decidedBy: [...baseRules, "crisis_generation"],
    nextState: { ...next, ...extraNext, crisis_state: "done", watch_turns_left: 0 },
  });
  // 1〜3通目を出し終えたあと(4通目のあと・3通目のあとで止めたあと)の、はっきりした危機のサイン。
  // キーワード・受動パターンによる新しい打ち明けで、2回目以降の短い1通をまだ出していなければ、その1通
  // (危機カードつき。1回の会話で1回まで)。分類器だけの危機の判定と、短い1通を出したあとは、指示つきの生成で受ける
  const afterAllSteps = (extraNext = {}, baseRules = rules) => (ownWords && !s.repeat_used
    ? { ...fixedStep(5), nextState: { ...next, ...extraNext, crisis_state: "done", watch_turns_left: 0, repeat_used: true } }
    : crisisGeneration(extraNext, baseRules));
  // 止めていた n通目の続き(n+1通目。3通目のあとなら上の afterAllSteps。4通目は3通目への答えでしか出さない)
  const continueAfter = (n, extra, baseRules = rules) => (n === 3
    ? afterAllSteps(extra, baseRules)
    : { ...fixedStep(n + 1), nextState: { ...next, ...extra, crisis_state: `step${n + 1}`, watch_turns_left: 0 } });

  // 記録の risk は、この発言そのものの判定にする(「うん」等の返事まで未対応の危機として pending_safety に並ばないように)
  const eventRisk = riskOf(stage);
  // 引き下がり(新しいサインが無いとき。2026年10月5日)。引き下がりは問いを止める理由にはなるが、窓口を伝えない理由には
  // ならない。段階は下げない(このターンも段階2の危機の応答として扱い、会話は最後まで「危機のあと」。通知と記録は
  // 取り消さない)。見守りは始めない(段階を下げないため。危機のあとの指示がこのあとも付き続ける)。
  //  1回目: まとめの1通(n = 1: 1通目のあと。折りたたみの窓口つき / n = 2・3: 窓口はすでに届いているので短く)
  //  2回目: 終わりを受け入れる短い1通 / 3回目以降: 同じ固定の文面をくり返さず、危機のあとの指示つきの生成
  // n は、どの文面のあとで引き下がったか(続きの文面は、はっきりした危機のサインがまた出たときに n+1 から)
  const withdrawalTurn = (n, answer = null) => {
    const count = s.withdrawal_count;
    const common = {
      stage: 2, subject: "self", notify: false,
      event: { stage: 2, risk: eventRisk, retraction: true, teacher_answer: answer },
    };
    if (count === 0) {
      return build({
        ...common, decidedBy: [...rules, "withdrawal"], ...fixedStep(n === 1 ? 7 : 8),
        nextState: { ...next, crisis_state: `wrap${n}`, watch_turns_left: 0, withdrawal_count: 1 },
      });
    }
    if (count === 1) {
      return build({
        ...common, decidedBy: [...rules, "withdrawal_end"], ...fixedStep(9),
        nextState: { ...next, crisis_state: `paused${n}`, watch_turns_left: 0, withdrawal_count: 2 },
      });
    }
    // 返事が watch 相当なら、ほかの段階1の生成と同じく Tier B の指示も付ける(2026年10月6日)
    return build({
      ...common, decidedBy: [...rules, "withdrawal_repeat"], safetyContexts: [...(stage === 1 ? ["tierB"] : []), "afterCrisis"],
      nextState: { ...next, crisis_state: `paused${n}`, watch_turns_left: 0, withdrawal_count: count + 1 },
    });
  };

  // ---- まとめの1通のあと: 2回目の引き下がり(新しいサインが無いとき)は、終わりを受け入れる短い1通だけ ----
  // それ以外(ふつうの返事・諦め・新しいサイン など)は、止めている状態として下の「それ以外」で扱う
  // (新しいサインなら止めていた続きの文面へ、watch 相当なら Tier B と危機のあとの指示で生成)
  if (wrapN != null && isWithdrawal && !newSign) return withdrawalTurn(wrapN);
  if (wrapN != null && isWithdrawal) rules.push("withdrawal_ignored_sign");

  // ---- 危機の応答の途中(1〜3通目・再受け止めを出して返事を待っている) ----
  const flowN = FLOW_STEP[s.crisis_state];
  const againN = AGAIN_STEP[s.crisis_state];
  if (flowN != null || againN != null) {
    const n = flowN ?? againN;
    // 通知は、この発言そのものが段階2のとき(本人・第三者とも。段階2を検知するたび)
    const notify = stage === 2;
    // 積み重なり(見守り中の再サイン)の1通目・再受け止めへの返事に、はっきりした危機のサイン(キーワード・受動パターン・
    // 分類器の危機判定。本人)が無ければ、続きの文面に進まず止める(2026年9月29日。watch 相当のサインだけでは進めない)。
    // 止めたあとの見守りは、再受け止めをまだ出していないときだけ(出したあとは、以後の watch 相当のサインを生成で受ける)
    if ((againN != null || (flowN === 1 && s.crisis_trigger === "accumulation")) && !crisisSelf) {
      return build({
        stage, subject, decidedBy: [...rules, "accumulation_pause"],
        safetyContexts: [...(stage === 1 ? ["tierB"] : stage === 2 ? ["thirdParty"] : []), "afterCrisis"],
        notify, notifySubject: subject,
        nextState: { ...next, crisis_state: `paused${n}`, watch_turns_left: pauseWatch },
        event: { stage, watch_event: pauseWatch ? "start" : null },
      });
    }
    if (againN != null) {
      // 再受け止めへの返事に、はっきりした危機のサインがある → 止めていた続きの文面へ
      const againRules = [...rules, "crisis_flow"];
      return build({
        stage: 2, subject: "self", decidedBy: againRules, notify, notifySubject: subject,
        ...continueAfter(n, {}, againRules), event: { stage: 2, risk: eventRisk },
      });
    }
    // はっきりした打ち明けから始めた1通目のあと・2通目・3通目のあと(2026年10月5日)
    //  引き下がり(新しいサインが無いとき)→ 残りの問いを出さず、まとめの1通(上の withdrawalTurn)
    //  新しいサイン → 引き下がりより優先して、今どおり次の文面へ(通知も出す)
    //  諦め・念押し・ふつうの返事 → 今どおり次の文面へ
    const answer = flowN === 3 ? (["yes", "no", "unclear"].includes(teacherAnswer) ? teacherAnswer : "unclear") : null;
    if (isWithdrawal && !newSign) return withdrawalTurn(flowN, answer);
    if (isWithdrawal) rules.push("withdrawal_ignored_sign");
    if (withdrawal === "resignation") rules.push("resignation");
    const flowRules = [...rules, "crisis_flow"];
    if (flowN === 3) {
      return build({
        stage: 2, subject: "self", decidedBy: flowRules, ...fixedStep(4, { teacherAnswer: answer }), notify, notifySubject: subject,
        nextState: { ...next, crisis_state: "done", watch_turns_left: 0 },
        event: { stage: 2, risk: eventRisk, teacher_answer: answer },
      });
    }
    // 次の文面へ(はっきりした危機の打ち明けから始めた応答と、2通目に進んだあとは、返事の内容にかかわらず)
    return build({
      stage: 2, subject: "self", decidedBy: flowRules, ...fixedStep(flowN + 1), notify, notifySubject: subject,
      nextState: { ...next, crisis_state: `step${flowN + 1}` },
      event: { stage: 2, risk: eventRisk },
    });
  }

  // ---- それ以外 ----
  const watching = s.watch_turns_left > 0;
  const pausedN = PAUSED_STEP[s.crisis_state];
  let escalated = false;
  // 見守り中の再サインで段階2に上げる(危機の応答を終えたあとは見守らないので上げない。
  // 止めたあとに再受け止めを出したあとも上げない。どちらも、ふだんは見守りが0なので起きない)
  if (watching && isSign && s.crisis_state !== "done" && !(pausedN != null && s.reentry_used)) {
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
      // 積み重なり・引き下がりで止めたあとの段階2。見守り中の再サイン(watch 相当)で上がったときは、
      // 受け止めだけの短い1通(再受け止め)を出す(1回の会話で1回まで。引き下がりのあとは見守らないので起きない)。
      // はっきりした危機のサイン(キーワード・受動パターン・分類器の危機判定)なら、止めていた続きの文面へ
      if (escalated && !s.reentry_used) {
        return build({
          ...common, decidedBy: [...rules, "reentry"], ...fixedStep(6),
          nextState: { ...next, crisis_state: `again${pausedN}`, crisis_trigger: trigger, watch_turns_left: 0, reentry_used: true },
        });
      }
      return build({ ...common, ...continueAfter(pausedN, { crisis_trigger: trigger }) });
    }
    // done: 1〜4通目は出し終えている。見守りは始めない。キーワード・受動パターンによる新しい打ち明けなら
    // 短い1通(危機カードつき。1回の会話で1回まで)、それ以外は危機の状態の指示つきの生成
    return build({ ...common, ...afterAllSteps({ crisis_trigger: trigger }) });
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
// 軽いモデルによる補助判定(引き下がり・先生についての答え)。形式は responseSchema で強制する。
// 失敗したら安全側に倒す(判定なし = 今どおり次の文面へ / どちらでもない)。
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

// 引き下がりの判定(2026年10月5日。以前の打ち消しの判定 judgeRetraction を置き換えた)。
// 危機の応答の途中の返事が、引き下がり / 諦め / 念押し / ふつうの返事 のどれかを判定する。
// 引き下がりでも段階は下げない(問いを止めて、まとめの1通にするだけ)ので、1回の判定で決める(2回一致は条件にしない)。
// 判定できなかったとき(エラー・時間切れ)は null を返す(引き下がりとして扱わない = 今どおり次の文面へ)。
// 迷ったら引き下がりにしない(引き下がりとして扱うと、そこで問いかけをやめるため。諦めを引き下がりと取り違えないように)。
export const WITHDRAWAL_TYPES = ["withdrawal", "resignation", "reaffirm", "other"];
const WITHDRAWAL_PROMPT = `あなたは中高生向け相談AIの補助判定器です。次のJSONだけを返します。
{"reply_type": "withdrawal|resignation|reaffirm|other", "reason": "20字以内"}

状況: 相談者が少し前に深刻なこと(死にたい気持ち・自傷・被害など)を書き、AIが受け止めの言葉を返しました
(そのあと、話せる窓口の案内や、問いかけをしている場合もあります)。

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり
【判定する発言】相談者の最新の発言

【判定する発言】がどの種類の返事かを、次の4つから選んでください。
withdrawal(引き下がり): 先に書いた深刻な内容を取り消す・引っ込める返事、またはこの話そのものを続けたくないという返事。
  例:「冗談だよ」「うそうそ」「ネタだから」「大げさに言っただけ」「今のなし」「なんでもない」「忘れて」
  「気にしないで」「別にそんな大したことじゃないし」「その話はしたくない」「もうこの話はいい」「ほっといて」
resignation(諦め): 諦め・投げやり・どうせ変わらないという気持ちを表す返事。
  例:「もういい、どうせ」「どうせ誰もわかってくれない」「話しても意味ない」「何をしても変わらない」「もう無理」
reaffirm(念押し): 先に書いた深刻な内容がほんとうだ・続いていると認める返事。
  例:「本気だよ」「冗談じゃない」「ほんとにそう思ってる」「ずっとそう」「冗談っぽく書いたけど本気」
other(ふつうの返事): それ以外。AIの問いかけへの答え(否定的な答えも含む)、短いあいづち、話題を変えた返事など。
  例:「うん」「ありがとう」「わからない」「親には話せない」「先生には言いたくない」「話してみようかな」

判定のしかた:
・AIの問いかけ(どんなところが話しにくいか・先生に話すことをどう思うか など)への答えは、「話したくない」「言いたくない」の
  ような否定的な答えでも other にする。ただし「その話はしたくない」「もうこの話はいい」のように、この話題そのものを
  続けたくないと言っている場合は withdrawal にする。
・引き下がりの言葉と、諦め・無力感(「どうせ」「もう無理」「意味ない」など)が一緒に書かれている場合は resignation にする。
・「冗談じゃない」「本気」のように、打ち消しの言葉を否定している場合は reaffirm にする。
・死にたい気持ち・自傷・被害などが新しく書かれていても、返事の種類だけを判定する(危機のサインは別に判定している)。
・迷ったら withdrawal にしない(withdrawal と判定すると、AIはそこで問いかけをやめるため)。`;

const WITHDRAWAL_SCHEMA = {
  type: "OBJECT",
  properties: { reply_type: { type: "STRING", enum: WITHDRAWAL_TYPES }, reason: { type: "STRING" } },
  required: ["reply_type", "reason"],
  propertyOrdering: ["reply_type", "reason"],
};

// 戻り値: { type: 返事の種類 | null(判定できなかった), withdrawal: 引き下がりか, vote: 判定の中身, error }
export async function judgeWithdrawal(text, recentMessages = []) {
  const input = buildClassifierInput(text, recentMessages);
  const r = await withTimeout(judgeOnce(WITHDRAWAL_PROMPT, WITHDRAWAL_SCHEMA, input, (p) => {
    if (!WITHDRAWAL_TYPES.includes(p.reply_type)) throw new Error(`想定外の reply_type: ${p.reply_type}`);
    return { type: p.reply_type };
  }));
  return { type: r.ok ? r.type : null, withdrawal: r.ok && r.type === "withdrawal", vote: r, error: r.ok ? null : r.error };
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
// 分類器 v2 と、必要なときだけ引き下がり・先生についての答えの判定を並行して呼ぶ。
// 分類器は、見守り中・危機の応答を始めたあとは、その発言そのものに新しい危機のサインがあるかだけを
// 判定するもの(classifierModeFor)、それ以外は通常のもの(第1段階で採用した判定のまま)。
// ----------------------------------------------------------------------------
export async function assessSafetyTurn(text, recentMessages, state) {
  const s = normalizeSafetyState(state);
  const [staged, withdrawal, teacher] = await Promise.all([
    classifyStaged(text, recentMessages ?? [], { mode: classifierModeFor(s) }),
    needsWithdrawalJudge(s) ? judgeWithdrawal(text, recentMessages ?? []) : Promise.resolve(null),
    s.crisis_state === "step3" ? judgeTeacherAnswer(text, recentMessages ?? []) : Promise.resolve(null),
  ]);
  const plan = planSafetyTurn({ staged, state: s, withdrawal: withdrawal?.type ?? null, teacherAnswer: teacher?.answer ?? null });
  return { staged, withdrawal, teacher, plan };
}
