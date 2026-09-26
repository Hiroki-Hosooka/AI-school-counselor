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
  CARE_LINE_PROVISIONAL, CRISIS_STEP1_PROVISIONAL, CRISIS_STEP2_PROVISIONAL, CRISIS_STEP3_PROVISIONAL,
  CRISIS_STEP4_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL, CRISIS_AGAIN_PROVISIONAL,
  RETRACTION_BLOCK_PROVISIONAL, AFTER_CRISIS_BLOCK_PROVISIONAL,
  WATCH_TURNS,
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

const md = `# 危機の応答(段階2)の仮の文面 1通目〜4通目

> **すべて仮の文面です(心理士さんの確認待ち)。** 本番では使っていません(設定 \`CRISIS_RESPONSE=staged\` のときだけ使う)。
> 文面の正本は \`src/crisis-response.mjs\` です。この文書は \`node scripts/export-provisional-texts.mjs\` で作り直します(手で直さない)。

## どういうときに出すか

相談者の発言が「危機(段階2)」と判定されたとき(はっきりした言葉、受動的な希死念慮、見守り中にもう一度サインが出たとき など)、
AI は返事を生成せず、下の決まった文面を **1通ずつ、相談者の返事を待ちながら** 出します。
嶋先生の「一気に情報量が多いから分割できないか」という指摘に沿って、今までは1通にまとめていた内容を分けています。

- 1通目を受け止めだけにして、誤検知だった場合の負担を小さくし、リスクを尋ねる質問をせずに一呼吸おきます。
- 途中で「冗談だよ」「大げさに言っただけ」などと打ち消された場合は、残りの文面を出さず、見守り(${WATCH_TURNS}ターン)に戻します。
  窓口の表示はそのまま残します。見守り中にもう一度サインが出たときは、続きの重い文面からではなく、
  受け止めだけの短い1通(再受け止め。下の「参考」)から始めます(1回の会話で1回まで)。
- 4通目のあとは、ふだんの会話(生成)に戻し、見守りはしません。そのあとも、危機の内容を深掘りしない・窓口の案内を
  くり返さない・この先の対応を約束しない・人に話すことに同調して否定しない、という指示を付けます。
- 画面下の常設の表示(119番・24時間子供SOSダイヤル)は、どの場面でも変えていません。

## 1通目 受け止めだけ

**出すとき:** 危機(段階2)と判定したとき
**添えるもの:** 折りたたみの窓口(「話せる窓口」を押すと開く。緊急の119番は画面下の常設の表示にあるので入れていない)
${list(consult)}

${quote(CRISIS_STEP1_PROVISIONAL)}

- 例の「そう思うくらい、しんどいんだね」は希死念慮には合いますが、危機には暴力や性被害の打ち明けも含まれるため、
  どの打ち明けにも合う言い方にしています。

## 2通目 重い内容だという正直な表明・窓口の案内・人に話しにくい理由の問い

**出すとき:** 1通目への相談者の返事を受けて
**添えるもの:** 危機カード(話せる窓口の一覧)
${list(hotlines)}

${quote(CRISIS_STEP2_PROVISIONAL)}

- 深掘りしてよいのは「生身の人に言うことの方にどんな障壁があるか」という一点だけ、という嶋先生の指摘(ナレッジ T31)に沿って、
  危機の中身ではなく、人に話しにくい理由をたずねています。
- 「ここで話すのをやめてほしいわけではないよ」は、AI から突然切ると見捨てられた感じを与える、という指摘(T32)への配慮です。

## 3通目 学校の先生に話すことをどう思うか

**出すとき:** 2通目への相談者の返事を受けて
**添えるもの:** なし

${quote(CRISIS_STEP3_PROVISIONAL)}

- 今の仕組みは匿名で、AI から先生に伝える手段がありません。「先生に伝えておくね」のような約束は、
  AI が実行できない約束を禁じるナレッジ D7 に反するため、同意を取るのではなく、本人が先生に話すことをどう思うかをたずねています。
- 答え(前向き / 後ろ向き / どちらでもない)は記録に残り、4通目の出し分けに使います。

## 4通目 3通目への答えに合わせた一言

**出すとき:** 3通目への相談者の返事を受けて(このあと、ふだんの会話に戻る)
**添えるもの:** なし

**前向きな答えのとき**

${quote(CRISIS_STEP4_PROVISIONAL.yes)}

**後ろ向きな答えのとき**(ナレッジ D4「今はまだ話したくないんだね、わかったよ」と一度引く)

${quote(CRISIS_STEP4_PROVISIONAL.no)}

**どちらでもない・わからないとき**

${quote(CRISIS_STEP4_PROVISIONAL.unclear)}

## 相談者から見た流れ(例)

| | 発言 |
|---|---|
| 相談者 | 実は最近、朝が来なければいいのにってずっと思ってる |
| AI(1通目) | ${CRISIS_STEP1_PROVISIONAL}<br>[折りたたみの窓口] |
| 相談者 | (返事) |
| AI(2通目) | ${CRISIS_STEP2_PROVISIONAL.replace(/\n+/g, "<br>")}<br>[危機カード] |
| 相談者 | (返事) |
| AI(3通目) | ${CRISIS_STEP3_PROVISIONAL} |
| 相談者 | (返事) |
| AI(4通目) | 答えに合わせた一言(上の3つのどれか) |
| 相談者 | (返事) |
| AI | ふだんの会話に戻る(生成) |

## 参考:このほかの仮の文面・指示

**気づかいの一言(段階1。3案のうち案Aに決定)** 段階1(気がかり)のときに、生成した返事の下に、折りたたみの窓口と一緒に添える(1回の会話で1回まで)

${quote(CARE_LINE_PROVISIONAL)}

**打ち消しのあとの再受け止め(受け止めだけの短い1通)** 打ち消しのあとの見守り中にもう一度サインが出たとき、
または分類器だけが危機と判定したとき(1回の会話で1回まで。次の返事にもサインがあるときだけ続きの文面に進む)

${quote(CRISIS_AGAIN_PROVISIONAL)}

**同じ会話で2回目以降の危機(短い1通。危機カードを添える)** 4通目まで出し終えたあとに、もう一度はっきりした危機と判定したとき

${quote(CRISIS_REPEAT_PROVISIONAL)}

**打ち消しのときに、生成に付ける指示**

${bullets(RETRACTION_BLOCK_PROVISIONAL)}

**危機の応答のあとに、生成に付ける指示**

${bullets(AFTER_CRISIS_BLOCK_PROVISIONAL)}
`;

writeFileSync(OUT, md);
console.log(`書き出しました: ${path.relative(ROOT, OUT)}`);
