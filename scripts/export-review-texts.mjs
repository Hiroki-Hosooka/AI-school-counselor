// ============================================================================
//  心理士さんに確認していただく文面を、1つの文書にまとめて書き出す(2026年10月7日)
//
//  実行: node scripts/export-review-texts.mjs
//  出力: docs/psychologist-review-texts.md(心理士さんに見ていただく用)
//
//  本番で生徒に出ている文面(危機の固定応答・窓口のカード・会話を区切るときのカード・返事が作れなかったときの文面)、
//  本番で AI に付けている「危機のあと」の指示、段階ごとの応答(仮・本番では無効)の文面、最初の受付の質問を、
//  確認したいことと一緒に並べる。
//
//  文面の正本はコード(src/・src/app/page.tsx)と db/seed_knowledge*.sql。文書を手で直すとずれるので、
//  文面を変えたらこのスクリプトで作り直す。画面の文言は page.tsx から読み、見つからなければ止まる
//  (画面の書き方が変わったら、下の読み取り方も合わせて直す)。
//  関連: docs/crisis-stage2-provisional-texts.md(段階ごとの応答の詳しい説明)、
//        docs/psychologist-review-checklist.md(確認してほしいことの一覧)
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CRISIS_REPLY } from "../src/classify.mjs";
import { buildSystem, GENERATION_FAILURE_REPLIES } from "../src/generate.mjs";
import { MAX_TEXT_LENGTH, TOO_LONG_NOTICE, RATE_LIMIT_NOTICE, SEND_FAILED_NOTICE, NOT_CONNECTED_NOTICE } from "../src/notices.mjs";
import {
  CRISIS_STEP1_PROVISIONAL, CRISIS_STEP2_PROVISIONAL, CRISIS_STEP3_PROVISIONAL, CRISIS_STEP4_PROVISIONAL,
  CRISIS_WRAPUP_PROVISIONAL, CRISIS_WRAPUP_SHORT_PROVISIONAL, CRISIS_WITHDRAW_END_PROVISIONAL,
  CARE_LINE_PROVISIONAL, CRISIS_AGAIN_PROVISIONAL, CRISIS_REPEAT_PROVISIONAL, CRISIS_GENERATION_FALLBACK_PROVISIONAL,
  AFTER_CRISIS_BLOCK_PROVISIONAL, CRISIS_GENERATION_BLOCK_PROVISIONAL,
} from "../src/crisis-response.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs/psychologist-review-texts.md");

// 見つからなければ止める(黙って空の文書を作らない)
function must(value, label) {
  if (value == null || value === "") throw new Error(`${label} が見つかりません。読み取り方を直してください`);
  return value;
}

// ---------------------------------------------------------------------------
// 画面の文言(src/app/page.tsx)
// ---------------------------------------------------------------------------
const page = readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");
const jsxText = (s) => s.replace(/<br\s*\/>/g, "\n").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n+/g, "\n").trim();
const hotlinesBlock = must(page.match(/const HOTLINES[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1], "page.tsx の HOTLINES");
const hotlines = [...hotlinesBlock.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
const consult = hotlines.filter(([name]) => name !== "いますぐ危ないとき");
const crisisCardNote = must(page.match(/<div className="crisis-card">[\s\S]*?<p>([^<]+)<\/p>/)?.[1], "危機カードの説明文");
const foldedTitle = must(page.match(/<details className="care-hotlines">\s*<summary>([^<]+)<\/summary>/)?.[1], "折りたたみの窓口の見出し");
const foldedNote = must(page.match(/<details className="care-hotlines">[\s\S]*?<p>([^<]+)<\/p>/)?.[1], "折りたたみの窓口の説明文");
const closingCard = page.match(/<div className="closing-card">\s*<h4>([^<]+)<\/h4>[\s\S]*?<p>([^<]+)<\/p>/);
const closingTitle = must(closingCard?.[1], "区切りのカードの見出し");
const closingNote = must(closingCard?.[2], "区切りのカードの説明文");
const footNote = jsxText(must(page.match(/<div className="foot-note">([\s\S]*?)<\/div>/)?.[1], "画面下の常設の表示"));
const emptyText = jsxText(must(page.match(/<div className="empty">\s*([\s\S]*?)<em>/)?.[1], "最初の画面のあいさつ"));
const chips = [...must(page.match(/const CHIPS = \[([^\]]*)\]/)?.[1], "最初の画面の書き出しの例").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// 生成のプロンプトから取り出すもの(src/generate.mjs の buildSystem)
// ---------------------------------------------------------------------------
const phase2 = { phase: "phase2", closing_state: "none", recommended_mode: [] };
const sysNormal = buildSystem([], [], "rapport", {}, 0, null, [], phase2);
const sysAfter = buildSystem([], [], "rapport", {}, 0, null, ["afterCrisis"], phase2);
const sysIntake = buildSystem([], [], "rapport", {}, 0, null, [], { phase: "intake" });
// クロージング(会話を区切るとき)の最後に添える一言の指示
function closingLine(sys) {
  const start = sys.indexOf("最後に「", sys.indexOf("要約の作り方"));
  const end = sys.indexOf("本人が続けたいと", start);
  must(start >= 0 && end > start ? "ok" : null, "クロージングの一言の指示");
  return sys.slice(start, end).replace(/\n\s*/g, "").trim();
}
// インテーク(最初の受付)の進め方
function intakeSteps(sys) {
  const start = sys.indexOf("## 進め方");
  const end = sys.indexOf("## インテーク完了時", start);
  must(start >= 0 && end > start ? "ok" : null, "インテークの進め方");
  return sys.slice(start, end).replace(/^## 進め方[^\n]*\n/, "").trim();
}

// ---------------------------------------------------------------------------
// ナレッジ(db/seed_knowledge*.sql の本文。DB で直した場合は DB の方が新しい)
// ---------------------------------------------------------------------------
const seedSql = ["db/seed_knowledge.sql", "db/seed_knowledge_structured.sql", "db/seed_knowledge_safety.sql", "db/seed_knowledge_boundaries.sql"]
  .map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
function knowledgeBody(id) {
  const re = new RegExp(`\\('${id}',\\s*'[^']*',\\s*'[^']*',\\s*'[^']*',\\s*(?:NULL|\\d+),\\s*'[^']*',\\s*`
    + `(?:'\\{\\}'::text\\[\\]|ARRAY\\[[^\\]]*\\]::text\\[\\]),\\s*'((?:[^']|'')*)'`);
  return must(seedSql.match(re)?.[1], `ナレッジ ${id} の本文`).replace(/''/g, "'");
}

// ---------------------------------------------------------------------------
// 書き方
// ---------------------------------------------------------------------------
const quote = (text) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
const list = (rows) => rows.map(([name, num]) => `- ${name} ${num}`).join("\n");
const asks = (items) => `**確認したいこと**\n\n${items.map((t) => `- ${t}`).join("\n")}`;
// 生成への指示は、見出しを除いた部分だけを載せる
const instruction = (block) => block.trim().split("\n").filter((l) => !l.startsWith("#")).join("\n");
const fence = (text) => "```text\n" + text + "\n```";

const md = `# 心理士さんに確認していただきたい文面

このAI(中高生向けの、文字で相談できるスクールカウンセリング支援AI)が相談者に出す文面のうち、
まだ心理士さんに確認していただいていないものを集めました。

- **A・B は、今の仕組みでそのまま使っているもの**です。いちばん確かめていただきたいところです。
- **C は、試作中の「分けて出す版」**です。本番ではまだ使っていません。確認をいただけたら使い始めます。
- **D は、まだ文面が無いもの**です。方針をご相談したいところです。
- **E は参考**です。最初の受付で聞く質問です(本番で使っています)。

文面を変えたら作り直す文書です(手で直していません)。2026年10月7日時点の文面です。

## 前提:このAIが危機のサインにどう応えるか

- 「死にたい」などのはっきりした言葉や、「朝が来なければいいのに」のような遠回しな言い方を見つけると、
  AI は自分で言葉を作らず、あらかじめ決めた文面を出します。同時に、学校の職員に通知します
  (送るのはセッションの番号と時刻だけで、相談の内容は送りません)。
- 石田先生が危機のときに確かめていらっしゃる「方法・時期・場所」の質問(リスクアセスメント)は、AI ではしません。
  訓練を受けた人が、対面で、学校につなげられる状態でこそ働く手順だと考えたためです。取り入れたのは態度だけです
  (淡々と受ける・話せたこと自体を受け止める・人につなぐ)。
- 1回に送れる字数(${MAX_TEXT_LENGTH}字)や、1時間に送れる回数の上限を超えた発言でも、はっきりした言葉・遠回しな言い方の照合だけは
  通し、危機のサインがあれば、上限で止めずに A1 の文面を出して職員に通知します(2026年10月7日から)。
- 画面の下には、いつも次の表示があります。

${quote(footNote)}

---

## A. いま本番で、生徒に出ている文面

### A1. 危機の固定の文面

**出るとき:** 本人の危機のサイン(「死にたい」など)があったとき。AI は返事を作らず、この文面を出します。

${quote(CRISIS_REPLY)}

**一緒に出るカード「話せる窓口」**

${list(hotlines)}

${quote(crisisCardNote)}

${asks([
  "打ち明けた直後の中高生が読んで、重すぎる・長すぎるところはありますか。",
  "「どうしてここでなら言えると思ったのか、あとで聞かせてもらえたら嬉しい」は、AI が守れない約束(あとで聞く)に聞こえませんか。",
  "嶋先生の「一気に情報量が多いから分割できないか」というご指摘から、分けて出す版(C)を作りました。本番をそちらに置き換えてよいでしょうか。",
])}

### A2. 会話を区切るときのカード

**出るとき:** 相談者がはっきり「今日はここまで」と望み、AI が今日の話のまとめを返したとき(まとめの下に出ます)。

**${closingTitle}**

${list(consult)}

${quote(closingNote)}

**AI のまとめに添えさせている一言(AI への指示)**

- ふだんの会話: ${closingLine(sysNormal)}
- 危機の文面を出したあとの会話: ${closingLine(sysAfter)}

${asks([
  "石田先生の「あ、よかったね。また何かあったら、いつでもどうぞ」(扉は開けておくが、無制限には開けない)に沿って、ふだんは「いつでも」を入れています。打ち明けがあった会話では「いつでも」を外しました。どちらがよいでしょうか。",
  "カードの「もちろん、また続きをここで話しに来てくれてもいいよ」は、打ち明けがあった会話でも、このままでよいでしょうか(AI だけを頼りにさせない、という点で)。",
])}

### A3. 返事が作れなかったときの文面

**出るとき:** システムの不具合などで AI の返事が作れなかったとき。同じ文面を2回出さないよう、1回目と2回目以降で変えています。

${GENERATION_FAILURE_REPLIES.map((t, i) => `${i === 0 ? "1回目" : "2回目以降"}\n\n${quote(t)}`).join("\n\n")}

${asks([
  "「もう少しだけ聞かせてもらえる?」は、つらい話をもう一度書かせる負担になりませんか。",
  "打ち明けのあとの会話で不具合が起きたときにも、この文面が出ます。それでよいでしょうか。",
])}

### A4. 送れなかったとき・上限のときの文面

2026年10月7日から、技術的なエラーの中身(英語のメッセージなど)は生徒に見せず、次の文面にしています。
上限を超えた発言でも、危機のサインがあれば、これらではなく A1 を出します。

**1回に送れる字数(${MAX_TEXT_LENGTH}字)を超えたとき**

${quote(TOO_LONG_NOTICE)}

**1時間に送れる回数の上限を超えたとき**

${quote(RATE_LIMIT_NOTICE)}

**通信の失敗やシステムの不具合で送れなかったとき**

${quote(SEND_FAILED_NOTICE)}

**最初につながらなかったとき(画面の上の帯に出ます)**

${quote(NOT_CONNECTED_NOTICE)}

${asks([
  "上限のときの文面は、突き放した感じになっていないでしょうか。",
  "「いますぐ誰かと話したいときは、画面の下の窓口に電話することもできます」を添えるのは、送れなかった場面に合っていますか。",
])}

---

## B. いま本番で、AI に付けている指示(生徒には見えません)

### B1. 打ち明けのあとの会話で守らせているルール

**付けるとき:** 危機の文面(A1)を出したあとの、同じ会話のすべての返事。2026年10月5日から使っています。

${fence(instruction(AFTER_CRISIS_BLOCK_PROVISIONAL))}

${asks([
  "打ち明けのあとの会話で AI が守るべきことは、これで足りていますか。",
  "逆に、縛りすぎて冷たくなるところはありますか(たとえば「窓口の案内をくり返さない」「受付の質問を続けない」)。",
])}

---

## C. 分けて出す版(試作。本番ではまだ使っていません)

嶋先生の「一気に情報量が多いから分割できないか」というご指摘から、A1 を4通に分け、相談者の返事を待ちながら1通ずつ出す形にしました。
流れの例と、それぞれの文面をいつ出すかの詳しい説明は \`docs/crisis-stage2-provisional-texts.md\` にあります。

### C1. 1通目(受け止めだけ)

${quote(CRISIS_STEP1_PROVISIONAL)}

**添えるもの:** 折りたたみの「${foldedTitle}」(押すと開きます。119番は画面下の常設の表示にあるので入れていません)

${list(consult)}

${quote(foldedNote)}

${asks([
  "受け止めだけを返して一呼吸おく形でよいでしょうか。",
  "暴力や性被害の打ち明けにも合う言い方でしょうか。",
])}

### C2. 2通目(重い内容だという正直な表明・窓口・人に話しにくい理由の問い)

${quote(CRISIS_STEP2_PROVISIONAL)}

**添えるもの:** 「話せる窓口」のカード(A1 と同じ)

${asks([
  "「わたしだけで受け止めるには重い」は、突き放された感じ(見捨てられ感)を与えませんか。",
  "「身近な人に話すとしたら、どんなところが話しにくい？」という問いはよいでしょうか(深掘りしてよいのは「生身の人に言うことの方にどんな障壁があるか」という一点だけ、という嶋先生のご指摘に沿っています)。",
])}

### C3. 3通目(学校の先生に話すことをどう思うか)

${quote(CRISIS_STEP3_PROVISIONAL)}

${asks([
  "今の仕組みは匿名で、AI から先生に伝える手段がありません。そのため同意は取らず、本人が先生に話すことをどう思うかだけをたずねています。この聞き方でよいでしょうか。",
])}

### C4. 4通目(3通目への答えに合わせた一言)

前向きな答えのとき

${quote(CRISIS_STEP4_PROVISIONAL.yes)}

後ろ向きな答えのとき

${quote(CRISIS_STEP4_PROVISIONAL.no)}

どちらでもない・わからないとき

${quote(CRISIS_STEP4_PROVISIONAL.unclear)}

${asks([
  "後ろ向きな答えのとき、このように一度引いたあと、どこまでその話に触れずにいてよいでしょうか。",
])}

### C5. 打ち明けのあとに「なんでもない」「忘れて」「冗談だよ」と引き下がったとき

考え方は「引き下がりは問いを止める理由にはなるが、窓口を伝えない理由にはならない」です。危機の扱いは下げず、通知も取り消しません。

1通目のあとに引き下がったとき(折りたたみの窓口を添えます)

${quote(CRISIS_WRAPUP_PROVISIONAL)}

2通目・3通目のあとに引き下がったとき(窓口はすでに届いているので、添えません)

${quote(CRISIS_WRAPUP_SHORT_PROVISIONAL)}

2回目に引き下がったとき

${quote(CRISIS_WITHDRAW_END_PROVISIONAL)}

${asks([
  "打ち明けのあとに引っ込められたとき、先生方は実際にどうしていらっしゃいますか。",
  "この考え方(問いはやめるが、窓口は伝える)でよいでしょうか。",
  "2回目の「この話は、今はここまでにしようね」は、早く閉じすぎていないでしょうか。",
])}

### C6. 「もう無理」「限界」のような、気がかりな言葉への一言

**出るとき:** 危機とまでは言えないが気がかりな言葉があったとき。AI の返事の下に、折りたたみの窓口と一緒に添えます(1回の会話で1回まで)。

${quote(CARE_LINE_PROVISIONAL)}

${asks(["重すぎる、または軽すぎることはありませんか。"])}

### C7. そのほかの短い文面

**気がかりなサインがもう一度出たとき(受け止めだけの短い1通。1回の会話で1回まで)**

${quote(CRISIS_AGAIN_PROVISIONAL)}

**4通目まで出したあと、同じ会話で新しい打ち明けがあったとき(1回の会話で1回まで。窓口のカードを添えます)**

${quote(CRISIS_REPEAT_PROVISIONAL)}

**AI が作った返事がルールに合わなかったときに、代わりに出す返事(2つを順に使います)**

${CRISIS_GENERATION_FALLBACK_PROVISIONAL.map((t) => quote(t)).join("\n\n")}

### C8. 2回目以降の打ち明けを、AI が自分の言葉で受け止めるときのルール

同じ決まった文面のくり返しは「受け止めてもらえていない」感じを与えるため(模擬の会話テストで、生徒役が「うるさいしほっといてよ」と反応しました)、
2回目以降の打ち明けは、決まった文面ではなく、次のルールを付けて AI が短く受け止めます(B1 のルールも一緒に付けます)。
ルールに合わない返事は、C7 の代わりの返事に置き換えます。職員への通知は毎回出します。

${fence(instruction(CRISIS_GENERATION_BLOCK_PROVISIONAL))}

${asks(["安全の面で、これでよいでしょうか。それとも、毎回決まった文面のほうがよいでしょうか。"])}

---

## D. まだ文面が無いもの(方針をご相談したい)

### D1. 「先生には言わないで」と言われたとき

AI は秘密の約束をしません。会話の記録は保存され、心理士の先生が見られるためです。今の AI に入れている知識は次のとおりです。

**秘密の約束をしない(このプロジェクトで決めたこと)**

${quote(knowledgeBody("D7"))}

**先生につなぐときは、本人に断ってから(石田先生のお話から)**

${quote(knowledgeBody("V14"))}

**断られたら、一度引く(このプロジェクトで決めたこと)**

${quote(knowledgeBody("D4"))}

${asks([
  "「先生には言わないで」と言われたとき、AI はどう返すのがよいでしょうか。",
  "会話の記録が残ることを、その場で正直に伝えるべきでしょうか。",
])}

---

## E. 参考:最初の受付で聞く4つの質問(本番で使っています)

最初の数ターンで、相談の種類・きっかけ・つらさ・ゴールを1つずつたずねます。AI への指示の一部で、AI はやりとりに合わせて言い回しを自然に調整します。
最初の画面には、次のあいさつと、書き出しの例(押すとそのまま送られます)が出ます。

${quote(emptyText)}

${chips.map((c) => `- ${c}`).join("\n")}

${fence(intakeSteps(sysIntake))}

${asks([
  "つらさの数字の言い方(1:少し気になる 〜 5:もう耐えられない)はよいでしょうか。",
  "4か5と答えたときの受け止め方で、気をつけることはありますか。",
])}

---

<details>
<summary>開発メモ(この文書の作り方)</summary>

- 作り直し: \`node scripts/export-review-texts.mjs\`(手で直さない)
- A1 \`src/classify.mjs\` の \`CRISIS_REPLY\`。窓口・カード・画面の文言は \`src/app/page.tsx\`
- A2 の一言、E の受付の質問は \`src/generate.mjs\` の \`buildSystem\` が組み立てる指示から取り出している
- A3 \`src/generate.mjs\` の \`GENERATION_FAILURE_REPLIES\`。A4 \`src/notices.mjs\`
- B・C \`src/crisis-response.mjs\`(名前の末尾が \`_PROVISIONAL\`)
- D のナレッジは \`db/seed_knowledge*.sql\` の本文(DB で直した場合は DB の方が新しい)

</details>
`;

writeFileSync(OUT, md);
console.log(`書き出しました: ${path.relative(ROOT, OUT)}`);
