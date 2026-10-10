// ============================================================================
//  段階ごとの応答(危機検知の作り直し 第2段階)の仮の文面を、1つの文書にまとめて書き出す
//
//  実行: node scripts/export-provisional-texts.mjs
//  出力: docs/crisis-stage2-provisional-texts.md(心理士さんに確認してもらう用)
//
//  文面の正本は src/crisis-response.mjs。文書を手で直すとずれるので、文面を変えたら
//  このスクリプトで作り直す。窓口の一覧は src/app/page.tsx の HOTLINES から読む。
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CARE_LINE_PROVISIONAL, CRISIS_STEP1_PROVISIONAL, CRISIS_STEP3_VARIANTS_PROVISIONAL,
  CRISIS_STEP4_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL, CRISIS_AGAIN_PROVISIONAL,
  CHOICES_B_PROVISIONAL, CHOICES_C_PROVISIONAL, CHOICE_C_INTRO_PROVISIONAL, CHOICE_C_ACK_PROVISIONAL, CHOICE_NOTE_PROVISIONAL,
  SCALING_PROMPT_PROVISIONAL, SCALING_PROMPT_A_PROVISIONAL, CHOICES_SCALING_PROVISIONAL, SCALING_ACK_PROVISIONAL,
  CRISIS_ENDINGS_PROVISIONAL, STAGE1_CLOSING_LINE_PROVISIONAL, CHOICE_B1_BLOCK_PROVISIONAL, choiceCBlock,
  AFTER_CRISIS_BLOCK_PROVISIONAL, CRISIS_GENERATION_BLOCK_PROVISIONAL, AFTER_CRISIS_CLOSING_LINE_PROVISIONAL,
  CRISIS_GENERATION_FALLBACK_PROVISIONAL, CONCERN_TEXT_PROVISIONAL, buildConcernBubbles, buildCrisisReply,
  WATCH_TURNS, SCALING_MAX,
} from "../src/crisis-response.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs/crisis-stage2-provisional-texts.md");

// 画面の窓口の一覧(page.tsx の HOTLINES)。危機カードは全件、折りたたみの窓口は119を除いたもの
const page = readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");
const block = page.match(/const HOTLINES[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? "";
const hotlines = [...block.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
const consult = hotlines.filter(([name]) => name !== "いますぐ危ないとき");
const list = (rows) => rows.map(([name, num]) => `  - ${name} ${num}`).join("\n");

// 文面を引用として書く(改行は引用の中の空行にする)
const quote = (text) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
// 生成への指示は、見出しを除いた箇条書きの部分だけを載せる
const bullets = (block) => block.trim().split("\n").filter((l) => !l.startsWith("#")).join("\n");

const CATEGORY_JA = { suicidal: "希死念慮", selfharm: "自傷・過量服薬", violence: "暴力・虐待", sexual: "性被害", bullying: "重大ないじめ", unknown: "種類不明" };
const chips = (items) => items.map((c) => `  - ${c.id} ${c.label}`).join("\n");

const md = `# 危機の応答(段階2)の仮の文面(嶋先生 10/7 を反映した流れ)

> **すべて仮の文面です(心理士さんの確認待ち)。** 段階ごとの応答は本番では使っていません(設定 \`CRISIS_RESPONSE=staged\` のときだけ使う)。
> ただし、本番の固定応答(最後の「本番の固定応答」)と、「危機の応答のあとに、生成に付ける指示」(最後の「参考」)は、本番の既定で使っています。
> 文面の正本は \`src/crisis-response.mjs\`・\`src/crisis-texts.mjs\` です。この文書は \`node scripts/export-provisional-texts.mjs\` で作り直します(手で直さない)。
> 設計と、そのもとになった嶋先生のお話は \`docs/design-crisis-flow-shima3.md\`・\`docs/interviews/2026-10-07-shima-3-summary.md\`。

## どういうときに出すか(流れ)

相談者の発言が「危機(段階2)」と判定されたとき、AI は返事を生成せず、下の決まった文面を出します。

| 順番 | 出すもの |
|---|---|
| 1通目 | 受け止めだけ(+折りたたみの窓口)。**相手の返事を待つ** |
| 2通目 | 「〜が、とても心配です」(危機の種類ごとの文面)と窓口。短い吹き出しに分け、1.5秒おいて1つずつ出す |
| 3通目 | 相談先や大人に話したいかの問い(2通目と同じターンに、最後の吹き出しとして) |
| 分岐 | 話したい・どちらでもない → 一言 / 話したくない → 受け止め+チップ(組B → 組C) |
| そのあと | 危機のあとの指示を付けた生成で会話を続ける。**AIから会話を終わらせない** |

- **「重い」は使いません。** 嶋先生「『私だけで受け止めるには重い』は意外と傷つく言葉。シャッターガラガラって言う感覚がある」。
  代わりに「心配」を使い、何が心配かを危機の種類ごとに示します(危機の場面では AI に言葉を選ばせないので、固定の文面)。
- **言葉だけでは段階を下げません。** 段階2で「冗談だよ」「なんでもない」「死にたくない」のような否定が出たら、気持ちのスケーリングの
  チップを出します。下げてよいのは、明示的な否定(A 生きたい気持ち・B 冗談/取り消し)で1か2を選んだときと、
  キーワードによらない否定(C 最小化。「大丈夫」「なんでもない」「別に」など)で1を選んだときだけです。下げるのは1段階(危機 → 気がかり)だけで、
  職員への通知と記録は取り消しません。チップを選ばずに書き続けたときは下げません。
- チップは押しつけません。いつでも自由に書けます。同じ組は1回の会話で1回まで(スケーリングは${SCALING_MAX}回まで)。続けて別の組は出しません
  (「話したくない」→ 組B → 組C だけは続けて出します)。
- 同じ会話で2回目以降の危機や、見守り中に気がかりなサインが重なったとき(積み重なり)の扱いは、以前と同じです(下の「参考」)。
  見守りは${WATCH_TURNS}ターンです。
- 画面下の常設の表示(119番・24時間子供SOSダイヤル)は、どの場面でも変えていません。

## 1通目 受け止めだけ

**添えるもの:** 折りたたみの窓口
${list(consult)}

${quote(CRISIS_STEP1_PROVISIONAL)}

## 2通目 「〜が、とても心配です」(危機の種類ごと)

**出すとき:** 1通目への返事を受けて。**添えるもの:** 危機カード(最後の吹き出しの下)
${list(hotlines)}

吹き出し(1.5秒おいて1つずつ。〇〇の種類は、当たった危機の言葉から決める。分類器だけで危機と判定したときは種類不明):

${Object.keys(CONCERN_TEXT_PROVISIONAL).map((c) => `**${CATEGORY_JA[c]}**\n\n${buildConcernBubbles(c === "unknown" ? null : c).map((t, i) => `${i + 1}. ${t}`).join("\n")}`).join("\n\n")}

- 「心配」は、教員向けの自殺予防の対応原則(TALK の原則)の Tell「言葉に出して心配していることを伝える」とも一致します。
- 以前の2通目にあった「身近な人に話すとしたら、どんなところが話しにくい？」の問いは消しました(「話したくない」の分岐のチップで扱う)。

## 3通目 相談先や大人に話したいか(候補3つ。設定で切り替え。既定は A)

${Object.entries(CRISIS_STEP3_VARIANTS_PROVISIONAL).map(([k, t]) => `**候補${k}**\n\n${quote(t)}`).join("\n\n")}

- AI が先生に伝えるとは言いません(今の仕組みは匿名で、AI から先生に伝える手段が無い。ナレッジ D7)。

## 3通目への答え

**話したい(前向き)** そのあと、本人が望めば、誰に・いつ・どう切り出すかを一緒に考える(手法を並べない)

${quote(CRISIS_STEP4_PROVISIONAL.yes)}

**どちらでもない**

${quote(CRISIS_STEP4_PROVISIONAL.unclear)}

**話したくない(後ろ向き)** → 下に組B のチップ

${quote(CRISIS_STEP4_PROVISIONAL.no)}

**組B(2択)**
${chips(CHOICES_B_PROVISIONAL)}

- B1 を選んだら: 深追いしない・理由を聞かない。相談者の話したいことに合わせて会話を続ける(固定の文面は出さず、指示つきの生成)
- B2 を選んだら: 下の前置き+組C のチップ

${quote(CHOICE_C_INTRO_PROVISIONAL)}

**組C(「話せない」の背景。C1〜C6 は生徒から出た例を嶋先生が「人間あるある」として選択肢に使ってよいとしたもの。C7 は嶋先生が挙げたもの)**
${chips(CHOICES_C_PROVISIONAL)}

**組Cで選んだものを受け止める一言**(「言い当てられた」と感じられるように。理由はさらに掘り下げない)

${CHOICES_C_PROVISIONAL.map((c) => `- ${c.id}: ${CHOICE_C_ACK_PROVISIONAL[c.id]}`).join("\n")}

そのあとの返し方は、インテークで「共感を求める」(進め方が「まず聞く」)か「解決を求める」かで変えます(生成への指示。下の「参考」)。

**チップの下に添える一言**

${quote(CHOICE_NOTE_PROVISIONAL)}

## 気持ちのスケーリング(段階2で否定が出たとき)

**否定が A(生きたい気持ち。「死にたくない」「生きたい」など)のとき**

${quote(SCALING_PROMPT_A_PROVISIONAL)}

**否定が B・C(冗談・取り消し / 最小化)のとき**(嶋先生の逐語に基づく)

${quote(SCALING_PROMPT_PROVISIONAL)}

**チップ**(インテークのつらさのスケーリングと同じ向き。1がいちばん軽い)
${chips(CHOICES_SCALING_PROVISIONAL)}

**下げないときに、選んだ数字を受け止める一言**(このあと、止まっていた次の文面へ)

${quote(SCALING_ACK_PROVISIONAL)}

下げたとき(1段階だけ)は、気がかりの指示で返事を生成し、気づかいの一言と折りたたみの窓口のカードを添えます。

## 終わり方(本人が終わりの合図を出したとき)

| 段階 | 終わり方 |
|---|---|
| 通常 | 今まで通り(石田先生「あ、よかったね。また何かあったら、いつでもどうぞ」の趣旨) |
| 気がかり | ${STAGE1_CLOSING_LINE_PROVISIONAL}(生成への指示) |
| 危機のあと | 生成した区切りの返事のあとに、下の3案から前回と違うものを1つ添える(窓口の表示は残す) |

${CRISIS_ENDINGS_PROVISIONAL.map((t, i) => `**${i + 1}案目**\n\n${quote(t)}`).join("\n\n")}

- 嶋先生「今日のやり取りも結構エネルギー使ったと思うから、今日は一旦ゆっくり休んでね、でまた、おしゃべりしようね」
  「AIができることは、このメッセージを発信し続けることなんだ」。「応援し続ける」は何度伝えてもよいが、言い回しは毎回変えます。

## 本番の固定応答(段階ごとの応答が無効のとき。本番の既定で使っている)

本人の危機と判定したとき、生成をスキップして1通で返します。「わたしだけで受け止めるには重い内容です」を消し、
「〜が、とても心配です」の型にしました(2026年10月9日)。〇〇は2通目と同じく種類ごと。例(希死念慮):

${quote(buildCrisisReply("suicidal"))}

## 参考:このほかの仮の文面・指示

**気づかいの一言(段階1。3案のうち案Aに決定)** 段階1(気がかり)のときに、生成した返事の下に、折りたたみの窓口と一緒に添える(1回の会話で1回まで)

${quote(CARE_LINE_PROVISIONAL)}

**止めたあとの再受け止め(受け止めだけの短い1通)** 積み重なりで止めたあとの見守り中に、気がかりなサインがもう一度出たとき
(1回の会話で1回まで。次の返事に、はっきりした危機のサインがあるときだけ続きの文面に進む)

${quote(CRISIS_AGAIN_PROVISIONAL)}

**同じ会話で2回目以降の危機(短い1通。危機カードを添える)** 決まった文面を出し終えたあと(3通目への答えのあと)に、危機を示す言葉・受動的な希死念慮の
言い方による新しい打ち明けがあったとき(1回の会話で1回まで)

${quote(CRISIS_REPEAT_PROVISIONAL)}

**危機の状態の生成が出力チェックを通らなかったときの固定の返事** 危機の状態で生成した返事が、禁止表現・秘密の約束・
「いつでも」などのチェックを書き直しても通らなかったとき、または生成に失敗したとき(同じ返事を2回出さないよう、2つを順に使う)

${CRISIS_GENERATION_FALLBACK_PROVISIONAL.map((t, i) => `${i + 1}つ目\n\n${quote(t)}`).join("\n\n")}

**危機の応答のあとに、生成に付ける指示**(2026年10月5日から、本番の既定でも、固定応答を出したあとの生成に付ける)

${bullets(AFTER_CRISIS_BLOCK_PROVISIONAL)}

**危機の応答のあとのセッションで、会話を区切るときの一言**(2026年10月6日から。本番の既定でも、固定応答を出したあとのセッションで使う)
ふだんのセッションでは、会話を区切るときに「しんどくなったら、いつでもこういうところに頼っていいよ」という趣旨の一言を添える
(扉を開けておくため、ここでは「いつでも」を言う)。危機の応答のあとのセッションでは、上の指示が「いつでも」を禁じているので、
次の趣旨の一言にしている(窓口の名前・番号はAIに書かせず、画面のカードで表示する)。

${quote(AFTER_CRISIS_CLOSING_LINE_PROVISIONAL)}

**組B の B1(このやり取りがうっとうしい)を選んだあとの生成に足す指示**

${bullets(CHOICE_B1_BLOCK_PROVISIONAL)}

**組Cで選んだあとの生成に足す指示**(例: C4・解決を求める人 / C4・共感を求める人)

${bullets(choiceCBlock("C4", "solution"))}

${bullets(choiceCBlock("C4", "empathy"))}

**危機の状態で、固定の文面を出さずに生成で受けるときに足す指示**(上の「危機の応答のあと」の指示と一緒に付ける)

${bullets(CRISIS_GENERATION_BLOCK_PROVISIONAL)}
`;

writeFileSync(OUT, md);
console.log(`書き出しました: ${path.relative(ROOT, OUT)}`);
