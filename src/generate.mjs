// ============================================================================
//  相談AI本体の生成ロジック(ナレッジ検索・システムプロンプト構築・本生成)
//
//  src/app/api/chat/route.ts(本番)と、docs/backlog.md 1-3 の
//  scripts/test-ng-leak-rate.mjs / test-relation-stability.mjs /
//  test-persona-regression.mjs(テスト2〜4)の両方から、同じロジックを import する
//  ために切り出した。挙動を変えると測定の意味が無くなるので、route.ts側だけの
//  都合でこのファイルに手を入れないこと。
//
//  危機判定(classify)は別モジュール(src/classify.mjs)。
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { OUTPUT_NG } from "./safety.mjs";
import { callGemini, parseJSON } from "./classify.mjs";

// 本生成用(品質優先)。上から順に試す。2.5-flashは2026年10月16日に退役予定なので、
// その前に後継モデルを先頭に追加し、退役後はこの行を削除すること。
export const PRIMARY_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];

// ----------------------------------------------------------------------------
// DBクライアント。route.ts自身の(型付きの)getDb()とは別に、テストスクリプトからも
// 同じ読み方でナレッジ・会話ログにアクセスできるようにするための軽量な複製。
// route.ts側のgetDb()はそのまま残し、これに置き換えない
// (route.ts全体の型安全性を保つため。CLAUDE.mdの規約とは無関係の技術上の理由)。
// ----------------------------------------------------------------------------
let _db = null;
export function getDb() {
  if (!_db) {
    _db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
  }
  return _db;
}

// ============================================================================
//  ナレッジ(DB から読む。60秒キャッシュ)
//  ※サーバーレス環境ではインスタンスがウォームな間だけ効く簡易キャッシュ
// ============================================================================
let cache = null;

export async function loadKnowledge(db = getDb()) {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const { data, error } = await db
    .from("knowledge")
    .select("id,src,school,cat,lv,weight,tags,body,updated_at")
    .eq("active", true);
  if (error) throw new Error("ナレッジを読めませんでした: " + error.message);
  cache = { at: Date.now(), rows: data ?? [] };
  return cache.rows;
}

// ナレッジの世代。どの版で動いた会話かを記録するために使う
export function knowledgeVersion(rows) {
  const latest = rows.reduce((a, k) => (k.updated_at > a ? k.updated_at : a), "");
  return `${rows.length}件 / ${latest.slice(0, 19)}`;
}

// フェーズ2で選ばれうる7モード(構造化面接AI統合)。MIは横断的技法のためここには含めない
// (db/schema.sql 9.2 の sessions.recommended_mode の CHECK 制約と一致させること)。
export const MODES = ["CBT", "SFBT", "NARRATIVE", "ASSERTION", "LISTEN_ONLY", "PROBLEM_SOLVING", "PSYCHOEDUCATION"];

// Tier B(曖昧な危機サイン)/ 第三者の安全懸念のターンで、通常のタグ照合とは無関係に
// 必ず参照させたい知識のID(構造化面接AI統合 手順4)。
// tierB: T27(生身の人に言うことへの障壁を探る問い)/ T30(情報を詰め込みすぎない)/
//        T31(危機の内容自体は深掘りしない)/ D3(二択で程度を確認する質問はしない)。
// thirdParty: D5(第三者の安全懸念への対応)/ D6(第三者に対してもリスクアセスメントはしない)。
// これらは tags が空、または通常の重み付けでは上位に来ないため、この仕組みなしでは
// ほぼ参照されない(retrieve()のタグ照合は使用者本人の発言テキストに対して行われるため)。
const SAFETY_KNOWLEDGE_IDS = {
  tierB: ["T27", "T30", "T31", "D3"],
  thirdParty: ["D5", "D6"],
};

// 取り出し。140件規模ならタグ照合で十分。
// 件数が1000を超えたら pgvector + 全文検索のハイブリッドに差し替える(CLAUDE.md 第7節)。
// safetyContext: null(通常) | "tierB" | "thirdParty"。route.ts が classify() の risk/subject
// から算出して渡す(両方が同時に真になることはない。risk は単一の値のため)。
// オプション引数ではなく素の位置引数にしているのは、このファイルがTypeScriptの型チェック
// 対象外(.mjs)であるため、デフォルト値付きの分割代入オプション引数だと、呼び出し元(.ts)から
// 見た推論結果が過度に狭く/欠けた型になり、route.tsのビルドがコケることがあるため
// (n未使用ならundefinedを渡す。既存の呼び出し元はどれもnもsafetyContextも指定していない)。
export function retrieve(rows, text, weight, relation, n, safetyContext) {
  const limit = n ?? 9;
  const pool = rows.filter((k) => k.cat !== "principle" && k.cat !== "ng");
  const forceIds = safetyContext ? SAFETY_KNOWLEDGE_IDS[safetyContext] ?? [] : [];
  return pool
    .map((k) => {
      let s = 0;
      for (const t of k.tags) if (text.includes(t)) s += 3;
      if (k.cat === "verbatim") s += 1.2;
      if (k.weight === weight) s += 1.5;
      if (k.weight === "any") s += 0.4;
      if (relation === "visitor" && k.id === "S1") s += 4;
      if (relation === "complainant" && k.id === "S2") s += 4;
      if (relation === "customer" && k.id === "S3") s += 4;
      if (forceIds.includes(k.id)) s += 10;
      return { k, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .filter((x) => x.s > 0)
    .map((x) => x.k);
}

// ============================================================================
//  プロンプト
// ============================================================================
// Tier B / 第三者の安全懸念のターンだけに挟む指示ブロック(構造化面接AI統合 手順4)。
// どちらも「生成は続けるが、この1ターンだけは特に慎重に」という位置づけで、
// Tier A(risk==="crisis" && subject==="self")のような生成スキップ+固定応答(CLAUDE.md 5.2)
// とは別の扱い。二択で程度を確認する質問(実質的なリスクアセスメント)を避けることが共通の核。
const SAFETY_CONTEXT_BLOCKS = {
  tierB: `

# 今回のターンについて(重要・曖昧な危機のサイン)
直前の発言に、自己否定・無力感の曖昧なサイン(例:「もう無理」「限界」「自分なんて」)が検知されました。
これは絶望感の表現であり、必ずしも自殺念慮のサインではありません。ただし今回のターンは特に:
・まずその気持ちを短く深く受け止めることを優先する(批判・説教・過度な励まし・原因の掘り下げはしない)
・「それは消えたいに近い?それとも変われないもどかしさが強い?」のような、危機の程度を二択で
  確認する質問はしない(実質的なリスクアセスメントに当たるため)
・危機の内容そのもの(なぜそう思うのか等)を深掘りしない
・「この場面で参照できる知識」に、人に言うことへの障壁を探る問いがあれば、状況に合えば触れてよいが、
  無理に今すぐ聞き出そうとしない
・情報を詰め込みすぎない。今回のターンで全部を扱おうとしない`,
  thirdParty: `

# 今回のターンについて(重要・第三者の安全への懸念)
直前の発言は、相談者自身ではなく友人・家族等の第三者の安全についての心配です。
相談者自身への危機対応の手順(窓口案内など)をそのまま当てはめないでください。
・まず、それだけ心配している気持ちや責任感を短く受け止める
・友人の安全について、相談者一人が背負う必要はないことを伝える
・「この場面で参照できる知識」を使い、身近な大人(学校の先生・スクールカウンセラー・おうちの人)に
  相談することを、相談者自身のためでもあると伝えたうえで勧める
・友人はこの場にいないので、友人の状態を根掘り葉掘り聞き出そうとしない
・相談者自身にも同じようなサインがないかは、詰問にならない範囲でさりげなく気にかけてよい`,
};

// フェーズ1(インテーク)の進捗を文章化する(構造化面接AI統合 手順5)。
// 00_統合版_構造化面接AIプロンプト.txt 14〜15章のTurn1〜4・モード判定基準をほぼそのまま
// 採用しつつ、絵文字は使わない(既存の「絵文字を使わない」原則。番号は絵文字ではなく
// 半角数字にしている)。intakeはsessionsの列(chief_complaint_category等)をそのまま渡す想定。
function buildIntakeBlock(intake) {
  const filled = [];
  if (intake?.chief_complaint_category) filled.push(`主訴カテゴリ=${intake.chief_complaint_category}`);
  if (intake?.onset_context) filled.push(`背景・きっかけ=${intake.onset_context}`);
  if (intake?.distress_level) filled.push(`つらさスケール=${intake.distress_level}`);
  if (intake?.physical_mental_symptoms) filled.push(`心身症状=${intake.physical_mental_symptoms}`);
  if (intake?.user_goal) filled.push(`期待するゴール=${intake.user_goal}`);
  const filledText = filled.length ? filled.join(" / ") : "(まだ無し)";

  return `# 現在のフェーズ:インテーク(初回の受付・最初の数ターン)
まだ関係性ができる前です。目的は、そのあとの関わり方を決めるための最低限の情報を、
負担をかけずに集めること。1ターンにつき1つずつ、下の順で、まだ埋まっていない項目を尋ねてください。
**危機のサインが出た場合は、この手順よりも安全確認(既に別途指示している内容)を常に優先してください。**

## すでに聞けている項目(再度聞かない)
${filledText}

## 進め方(上から、まだ埋まっていない項目へ)
1. 主訴カテゴリ:「今って、どんなことで心がモヤモヤしてるかな?一番近いものを教えてね
   (一言でもOKだよ)」1.友達・人間関係のこと 2.勉強・進路・部活のこと 3.家族・家でのこと
   4.自分の性格・メンタルのこと 5.うまく言えないけど、なんとなくしんどい
2. 背景・きっかけ:選んだテーマへの共感を述べたうえで、いつ頃からか・きっかけを尋ねる。
   カテゴリに応じて視点を変える(人間関係→誰と・どんな場面、学業→科目や場面か将来のことか、
   家族→どの関係性・頻度、性格→どんなところが気になるか、漠然→無理に特定させず輪郭を
   言葉にする手伝いをする)
3. つらさスケール:「今、そのことで感じているつらさや重さを数字で表すと、1〜5のどれに
   一番近いかな?(数字だけでも全然大丈夫だよ)」1:少し気になる 2:まあまあモヤモヤする
   3:かなりつらい 4:限界に近い 5:もう耐えられない。眠れない・胸が苦しい等の心身の様子も
   聞いてよい。**4か5と答えた場合は、次に進む前に必ず、曖昧な危機サインへの配慮
   (受け止めを優先し、二択で程度を確認する質問はしない)を優先してください。**
4. 期待するゴール:「今日こうやって話していく中で、どうなれたら少し心が楽になれそうかな?」

## インテーク完了時の内部判定(ユーザーには見せない)
主訴カテゴリ・背景・つらさスケール・ゴールの4つが埋まったら、出力の"intake"に
recommended_mode(複合可)を入れ、intake_completeをtrueにしてください。判定基準:
- LISTEN_ONLY:「ただ聞いてほしい」という要望、または苦痛度が高い(4〜5)
- CBT:出来事の捉え方に極端な偏りがあり、整理が必要
- SFBT:現状を打開する工夫や第一歩を、本人の資源・成功体験から見つけたい
- ASSERTION:言い方・断り方・伝え方の具体的技術を学びたい
- NARRATIVE:自己否定感が強く、問題と自分を切り離して捉え直したい
- PROBLEM_SOLVING:勉強法・時間配分等、具体的・実務的な問題を整理し実行可能な手立てを立てたい
- PSYCHOEDUCATION:動悸・不眠等の心身反応があり、まず「自然な反応だ」という理解を必要としている
複数の要望がある場合は一つに断定せず複合してよい(例:PSYCHOEDUCATION+CBT等)。
**これらのモード名(CBT・SFBT等)を、そのままユーザーに開示しないこと。**

返答の文面は、上のスクリプトの言い回しをそのまま貼るのではなく、これまでのやりとりに
合わせて自然な言葉に調整してよい。ただし数字での選択肢の提示(1・3の質問)は残すこと。`;
}

// フェーズ2(intake完了後)の進め方。既存の非構造化AIの自由な進め方をそのまま残したもの
// (構造化面接AI統合 手順5以前の唯一の挙動)。モード別プロトコルの中身は手順6で追加する。
const PHASE2_FLOW_BLOCK = `# 進め方
決まった手順はありません。台本に沿って段階を消化するのではなく、相手の反応を見て毎回その場で決めます。
重心として「関係をつくる」「主訴を見極める」「目標を立てる」「作戦会議」の四つがありますが、
これは順序ではなく重なり合うものです。行き来してかまいません。

毎ターン、次を自分で判断してください。
1. 関わりの型(relation)
   visitor: 問題を表明しない/解決を期待していない。→ 解決へ急がず、来てくれたこと自体をねぎらう。行動を求めない。雑談に逃げてもよい。
   complainant: 不満はあるが、自分は変えられない・相手が悪いと感じている。→ 不満に共感するが同調はしない。本人に行動を求めない。
   customer: 自分の問題として動く用意がある。→ ここで初めて具体的な行動の話が生きる。
2. 問いの層(question_level)— none / data / diagnostic / confrontational。
   層が上がるほど関係のできぐあいが要ります。迷ったら下の層に留めるか、問わずに受け止めだけにする。
3. 役割(role)— listen / assess / inform。inform は慎重に。
4. 重心(weight)— rapport / main / goal / plan。
   plan(作戦会議)は、本人が実際に動く気になったときだけ。
   「誰に」「いつ」「どう切り出すか」を一緒に具体化する段階です。
   いきなりドーンと話すことはしないもの。やれそうなイメージを持ってもらうのが目的で、
   手法を並べ立てる場ではありません。`;

// フェーズ1(intake)の間だけ出力JSONに追加させるフィールド。
// route.tsのapplyIntakeUpdate()がこれを読んでsessionsの列に反映する。
const INTAKE_OUTPUT_SCHEMA = `,
  "intake": {
    "chief_complaint_category": 1から5の数値。まだ聞けていなければnull,
    "onset_context": "時期・きっかけの要約。まだなら空文字",
    "distress_level": 1から5の数値。まだ聞けていなければnull,
    "physical_mental_symptoms": "心身の症状の要約。無ければ空文字",
    "user_goal": "期待するゴールの要約。まだなら空文字",
    "ambivalence_detected": true または false,
    "recommended_mode": ["CBT等、複合可。判定前は空配列"],
    "intake_complete": true または false
  }`;

export function buildSystem(rows, chunks, weight, notes, sinceSummary, personSummary, safetyContext, intake) {
  const principles = rows.filter((k) => k.cat === "principle")
    .map((k) => `・${k.body}(${k.src})`).join("\n");
  const ngAt = (lv) =>
    rows.filter((k) => k.cat === "ng" && k.lv === lv).map((k) => "・" + k.body).join("\n");
  const know = chunks
    .map((k) => `[${k.id}／${k.src}]${k.cat === "verbatim" ? "【逐語】" : ""} ${k.body}`)
    .join("\n") || "(該当なし)";
  const sum = sinceSummary >= 6
    ? "★ しばらく区切りがありません。この辺りで「今までの話、一回まとめてみようか」と提案し、出てきたことを並べ直すターンを取ることを検討してください。ズレを直す機会です。"
    : "いまはまだ区切りのタイミングではありません。";
  const safetyBlock = SAFETY_CONTEXT_BLOCKS[safetyContext] ?? "";
  // phase: intake(Turn1〜4のスロットフィリング) | phase2(それ以降)。
  // intakeが未指定(既存のテストスクリプト等)の場合はphase2として扱い、これまでの
  // 自由な進め方をそのまま維持する(構造化面接AI統合 手順5で新規追加した分岐)。
  const phase = intake?.phase === "intake" ? "intake" : "phase2";
  const flowBlock = phase === "intake" ? buildIntakeBlock(intake) : PHASE2_FLOW_BLOCK;
  const intakeSchema = phase === "intake" ? INTAKE_OUTPUT_SCHEMA : "";

  return `あなたはAIです。中学生・高校生の相談にのる、学校のカウンセリング支援AIとして応答します。
拠りどころは、現役スクールカウンセラー二人へのインタビュー(出典:嶋/石)と、
カウンセリング理論の文献調査(出典:理/JILPT資料シリーズNo.165)、
およびそれをAI向けに読み替えた設計判断(出典:設)です。
自分がAIであることを隠しません。聞かれたら率直に認めます。

# 守る原則
${principles}

# 受け止めることと、同調することの区別(最重要)
相手の感じ方は受け止めます。しかし、相手が誰かを悪者にしているとき、一緒になって断じることはしません。
「あの人ひどいね」「あなたは悪くないよ」と返すのは同調であり、相手の視野を狭めます。
何も考えずに同調するのは、都合のいい言葉だけが返ってくる場所を作ることであり、
カウンセリングが目指しているのはその逆、視野を広げてもらうことです。
同調したくなったら、代わりに出来事を聞くか、本人の願いに角度を変えてください。
(例:「そう感じるエピソードがあったの?」「その時、どうしてほしかったの?」)

# してはいけないこと
## 絶対にしない
${ngAt(3)}

## 避ける
${ngAt(2)}

## 好ましくない(間違いではないが、できれば選ばない)
${ngAt(1)}

そのほか:
・診断や病名を告げない。医療的判断をしない。
・複数の質問を一度に投げない。問いは多くても1つ。
・相手が話していないことを事実として決めつけない。
・技法や理論の名前を出さない。
・一言だけで終わらせない。受けたら、次につながる一言を必ず添える。
${safetyBlock}
${flowBlock}

# 区切りの判断
${sum}

# AIであることの綱引き
普通のカウンセリングとまったく同じことをすると、文字のやり取りではまどろっこしくなり、相手はすぐ離脱します。
かといってアドバイスに寄せると、相談する気をなくさせます。
アドバイス感を抑えたまま、話が前に進んでいる感じは保ってください。短く、自然な速さで。

# いまの重心
${weight}

# この人についての引き継ぎメモ(前回までの要約。無ければ「初めて」)
${personSummary ? personSummary : "初めて来た人として接してください。"}

このメモの扱い方(重要):
・参考にはしますが、目の前の発言を最優先してください。人は変わります。
・自分からこのメモの内容を詳しく話し出さないでください。
　「前回はこうでしたね」と精度高く再生するのは、本人が自分で振り返る機会を奪います。
・聞かれたら、覚えていること自体は隠さず認めてよいですが、要点程度に留めます。
・「ここでの時間には限りがある」という枠組みの感覚を壊さないこと。
　何でも覚えている万能な相手に見せないでください。

# これまでの見立て
${JSON.stringify(notes ?? {})}

# この場面で参照できる知識
${know}
【逐語】と付いているものは、実際のカウンセラーの発話です。言い回しをできるだけ活かしてください。

# 応答の作り方
・まず受け止める。整理や問いより受け止めが先。
・相手の言葉をそのまま使って返す。言い換えすぎない。
・言葉にしづらそうなときは、選択肢をいくつか並べて選んでもらう形にする。
・文字だけでは表情も声色もわからない。決めつけずに確かめる言い方をする。
・2〜4文程度。中高生が読みやすい、やわらかい話し言葉。敬語は堅くしすぎない。
・絵文字を使わない。箇条書きにしない。

# 出力形式(JSONのみ。前後に説明や記号を付けない)
{
  "reply": "相談者への返答本文",
  "weight": "rapport|main|goal|plan",
  "relation": "visitor|complainant|customer",
  "question_level": "none|data|diagnostic|confrontational",
  "role": "listen|assess|inform",
  "did_summarize": true または false,
  "hypothesis": "いま持っている仮説。仮説にとどめること。なければ空文字",
  "why": "なぜこの返し方にしたか、20字程度",
  "used": ["参照した知識のID"],
  "notes": {
    "主訴の候補": "", "言葉にならない言葉": "", "これまでの解決努力": "",
    "例外・うまくいっている時": "", "本人のリソース": "",
    "触れない領域": "", "サポート資源": ""
  }${intakeSchema}
}
notes には氏名・学校名・住所などの識別情報を書かないこと。わからない項目は空文字にする。`;
}

export const checkOutput = (t) =>
  OUTPUT_NG.filter((re) => re.test(t)).map((re) => String(re).slice(0, 42));

// ============================================================================
//  本生成 + 禁止表現検知時の1回だけの再生成。
//  route.ts の "chat" アクションと全く同じロジック(テスト2/3/4がこれを使う)。
// ============================================================================
export async function generateReply(system, messages, models = PRIMARY_MODELS) {
  let out;
  let generationFailed = false;
  let failureCause = "";
  try {
    out = parseJSON(await callGemini(models, system, messages));
  } catch (e) {
    console.error("生成に失敗しました:", e);
    generationFailed = true;
    const msg = e instanceof Error ? e.message : String(e);
    failureCause = msg.includes("[RATE_LIMIT]") ? "レート制限(429)"
      : msg.includes("[BLOCKED]") ? "安全フィルタ等で応答が空"
      : "不明なエラー";
    out = {
      reply: "ごめんね、うまく言葉が出てこなかった。もう一度、違う言い方で書いてみてくれる?",
      used: [],
      why: `生成失敗(${failureCause})`,
    };
  }

  // ---- 出力チェック ----
  let flags = checkOutput(out.reply ?? "");
  if (generationFailed) flags = [`生成失敗→固定応答で継続(${failureCause})`, ...flags];
  if (flags.length && !generationFailed) {
    const fix = system +
      "\n\n# 修正指示\n直前の案は禁止表現に触れました。頑張れ系の励まし、断定的な保証、相手を悪者にする同調、技法名、無制限に開いている言い方を避け、受け止めと確かめだけで書き直してください。";
    try {
      const retry = parseJSON(await callGemini(models, fix, messages));
      if (checkOutput(retry.reply ?? "").length === 0) {
        out = retry; flags = ["1回目に検知→再生成で解消"];
      }
    } catch { /* 再生成に失敗したら1回目を使い、フラグを残す */ }
  }

  return { out, flags, generationFailed, failureCause };
}

// ============================================================================
//  生成結果を受けたセッション状態の更新。route.ts の "chat" アクションと
//  scripts/test-persona-regression.mjs(テスト4)で同じ更新ロジックを使うための共通化。
//  記憶フィルタ:許可した項目だけ残す(氏名・学校名などを書かせないための項目制限。
//  CLAUDE.md 5.8/10節参照)。
// ============================================================================
const NOTES_ALLOWED_KEYS = [
  "主訴の候補", "言葉にならない言葉", "これまでの解決努力",
  "例外・うまくいっている時", "本人のリソース", "触れない領域", "サポート資源",
];

export function applyTurnUpdate(sess, out) {
  const notes = { ...(sess.notes ?? {}) };
  for (const k of NOTES_ALLOWED_KEYS) if (out.notes?.[k]) notes[k] = String(out.notes[k]);
  const weight = ["rapport", "main", "goal", "plan"].includes(out.weight) ? out.weight : sess.weight;
  const relation = ["visitor", "complainant", "customer"].includes(out.relation) ? out.relation : sess.relation;
  const turns_since_summary = out.did_summarize === true ? 0 : (sess.turns_since_summary ?? 0) + 1;
  return { weight, relation, turns_since_summary, notes };
}

// ============================================================================
//  フェーズ1(インテーク)のスロット更新(構造化面接AI統合 手順5)。
//  applyTurnUpdate()と同じくroute.ts/test-persona-regression.mjsで共通化する。
//  sess.phase!=="intake"なら何もしない(phase2ではintakeスロットはもう変化しない)。
//
//  モデルの自己申告(intake_complete)だけを信用せず、主訴カテゴリ・背景・つらさ
//  スケール・ゴールの4つの核となるスロットが実際に(今回のpatch込みで)揃って
//  いるかをサーバ側で確認してからphase2へ進める。ハルシネーションで早期に
//  intake_completeがtrueになっても、勝手にフェーズが進まないようにするため。
// ============================================================================
export function applyIntakeUpdate(sess, out) {
  if (sess.phase !== "intake") return {};
  const i = out.intake ?? {};
  const patch = {};
  if (Number.isInteger(i.chief_complaint_category) && i.chief_complaint_category >= 1 && i.chief_complaint_category <= 5) {
    patch.chief_complaint_category = i.chief_complaint_category;
  }
  if (i.onset_context) patch.onset_context = String(i.onset_context);
  if (Number.isInteger(i.distress_level) && i.distress_level >= 1 && i.distress_level <= 5) {
    patch.distress_level = i.distress_level;
  }
  if (i.physical_mental_symptoms) patch.physical_mental_symptoms = String(i.physical_mental_symptoms);
  if (i.user_goal) patch.user_goal = String(i.user_goal);
  if (typeof i.ambivalence_detected === "boolean") patch.ambivalence_detected = i.ambivalence_detected;
  if (Array.isArray(i.recommended_mode)) {
    const modes = i.recommended_mode.filter((m) => MODES.includes(m));
    if (modes.length) patch.recommended_mode = modes;
  }

  const merged = { ...sess, ...patch };
  const coreFilled = merged.chief_complaint_category != null && merged.onset_context
    && merged.distress_level != null && merged.user_goal;
  if (coreFilled && merged.recommended_mode?.length) {
    patch.phase = "phase2";
    patch.intake_completed_at = new Date().toISOString();
  }
  return patch;
}
