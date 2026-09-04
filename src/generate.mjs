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

// 取り出し。140件規模ならタグ照合で十分。
// 件数が1000を超えたら pgvector + 全文検索のハイブリッドに差し替える(CLAUDE.md 第7節)。
export function retrieve(rows, text, weight, relation, n = 9) {
  const pool = rows.filter((k) => k.cat !== "principle" && k.cat !== "ng");
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
      return { k, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .filter((x) => x.s > 0)
    .map((x) => x.k);
}

// ============================================================================
//  プロンプト
// ============================================================================
export function buildSystem(rows, chunks, weight, notes, sinceSummary, personSummary) {
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

# 進め方
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
   手法を並べ立てる場ではありません。

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
  }
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
