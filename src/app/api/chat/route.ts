// ============================================================================
//  スクールカウンセリングAI  API Route(旧 supabase/functions/chat/index.ts)
//  src/app/api/chat/route.ts
//
//  役割
//   1. Gemini の API キーをサーバ側に隠す(ブラウザには絶対に置かない)
//   2. ナレッジを DB(Supabase Postgres)から読む(クライアントには知識を持たせない)
//   3. 入力フィルタ → 生成 → 出力チェック の安全層をすべてここで通す
//   4. 会話・見立て・安全判定を DB に保存する
//   5. 危機判定時に人へ通知する
//
//  Next.js + Vercel 移行に伴う変更点(ロジック自体は変更していない)
//   ・Supabase Edge Function(Deno)ではなく Next.js の Route Handler(Node.js)として動く
//   ・フロントエンドと同一オリジンになったため、CORS(ALLOWED_ORIGIN)の仕組みは廃止した。
//     ブラウザの Origin チェックはそもそも別サイトの埋め込みJSからの無断利用を防ぐためのもので、
//     同一オリジン構成ではその脅威自体が成立しないため
//   ・Supabase は Postgres(データ)としてのみ利用する
//
//  生成モデルを Anthropic Claude から Google Gemini に変更(2026年9月)。
//  安全層(CRISIS_WORDS/OUTPUT_NG)はモデルの出力テキストに対する後段チェックなので、
//  どちらのモデルでも同じように効く。プロンプトの内容・出力JSONスキーマは変更していないが、
//  モデルが変わったことで実際の応答の質・トーンが変わっていないか、必ず会話して確認すること。
//
//  モデルは単一指定ではなく、PRIMARY_MODELS/LITE_MODELS(下記)を上から順に試す
//  フォールバック方式にしている(2026年9月)。理由は2つ:
//   ・レート制限対策 ― 無料枠は1モデルあたりRPMが低く、1ターンで複数回Geminiを呼ぶ
//     この実装だと単一モデルではすぐ詰まる。モデルIDが違えば別の割当枠になる。
//   ・Googleのモデル退役対策 ― Gemini 2.0系は2026年6月に退役済み、
//     2.5-flashも2026年10月16日に退役予定など、モデルの入れ替わりが速い。
//  MODEL環境変数は廃止した。一覧は環境変数ではなくコード(下記)で管理する。
//  古いモデルが退役して1件も繋がらなくなった場合はリストの見直しが必要。
//
//  必要な環境変数(Vercelダッシュボード > Project Settings > Environment Variables)
//   GEMINI_API_KEY           必須  Google AI Studio で発行したキー
//   SUPABASE_URL             必須
//   SUPABASE_SERVICE_ROLE_KEY 必須(RLSを迂回してDBを読み書きするため。絶対にNEXT_PUBLIC_を付けない)
//   CRISIS_WEBHOOK_URL       任意  Slack / Discord などの Incoming Webhook
//   RATE_LIMIT_PER_HOUR      任意  既定 60
//   ADMIN_TOKEN              任意  管理画面(public/admin.html)用の合言葉。
//                                  admin_sessions/admin_session_detail はこれと
//                                  一致しないと401を返す(docs/backlog.md 1-2)
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CRISIS_WORDS, OUTPUT_NG } from "@/safety.mjs";

// 本生成用(品質優先)。上から順に試す。2.5-flashは2026年10月16日に退役予定なので、
// その前に後継モデルを先頭に追加し、退役後はこの行を削除すること。
const PRIMARY_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];
// 安全判定(classify)・人単位の記憶の要約用。軽いタスクなので lite モデルで十分。
// PRIMARY_MODELSと別モデルにすることで、レート制限の枠も分散させている。
const LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

const WEBHOOK = process.env.CRISIS_WEBHOOK_URL ?? "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR ?? "60");
// 人単位の記憶(person_memory)の上限。DB側の check 制約(person_memory_len_check)とも一致させること。
const MEMORY_MAX_CHARS = 600;
// これだけ会話が途切れたら「今回は一区切り」とみなし、要約を更新する。
const SESSION_GAP_MINUTES = 30;

// DBクライアントは初回呼び出し時に作る(モジュール読み込み時に環境変数が
// 無くても next build が壊れないように遅延初期化にしている)
let _db: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (!_db) {
    _db = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _db;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// 管理画面(admin.html)用の合言葉チェック。ログイン画面は作らず、
// admin.html が自分のURLのクエリ文字列(?token=...)から読んで
// リクエストボディに admin_token として載せてくる想定(docs/backlog.md 1-2)。
function checkAdminToken(payload: Record<string, unknown>): boolean {
  const token = String(payload.admin_token ?? "");
  return token.length > 0 && token === process.env.ADMIN_TOKEN;
}

// ============================================================================
//  安全層(クライアントには置かない。CRISIS_WORDS/OUTPUT_NG は src/safety.mjs)
// ============================================================================
const CRISIS_REPLY =
  "よく、ここで言えたね。誰にも言えないと思っていたことを書くのは、すごく力が要ったと思う。\n\n" +
  "どうしてここでなら言えると思ったのか、あとで聞かせてもらえたら嬉しい。\n\n" +
  "そのうえで正直に言うと、いま書いてくれたことは、わたしだけで受け止めるには重い内容です。あなたを軽く扱いたくないので、はっきり言います。心配だから、ここから先はあなたの声が届く人につながってほしい。\n\n" +
  "学校の先生でも、保健室でも、スクールカウンセラーでも、家の人でも、下の窓口でもかまいません。あなたが一番話せそうなところで大丈夫です。";

// ============================================================================
//  人単位の記憶(永続・要約のみ)
//
//  設計原則(CLAUDE.md 5.8と同じ考え方をここにも書く。安全層と同格で守ること):
//   ・生ログは絶対に summary に入れない。要約AIには「短く」を強制する。
//   ・氏名・学校名などの識別情報を書かせない(session notes と同じ制約)。
//   ・「枠組み」を壊さないため、この記憶をAIに詳しく語らせない。
//     buildSystem 側で「聞かれたら答える程度に留め、自分から詳細を持ち出さない」
//     という指示を必ず添える。
// ============================================================================

const SUMMARY_PROMPT =
`あなたは、ある相談者についての「引き継ぎメモ」を更新する係です。
学校のカウンセリングAIが、次にこの人が来たときに参照します。

以下を渡します。
1. これまでの引き継ぎメモ(無ければ空)
2. 今回のセッションで積み上がった見立て(notes)

これらを踏まえて、新しい引き継ぎメモを日本語で書いてください。

厳守事項:
・${MEMORY_MAX_CHARS}字を絶対に超えない。超えるくらいなら削る。
・氏名・学校名・住所など、個人を特定できる情報は書かない。
・具体的な出来事の羅列ではなく、継続して意味を持ちそうな要点だけを残す。
　(例:抱えている大きなテーマ、繰り返し出てくるパターン、これまで試して
　　効かなかった対処、本人のリソース、触れると閉じてしまう話題)
・一度きりの雑談や、その場限りの感情の起伏は残さない。
・前回のメモと今回の内容が矛盾するなら、より新しい方を採用してよい。
・出力はメモ本文のみ。前置きや見出しを付けない。`;

async function updatePersonMemory(clientId: string, sessionNotes: Record<string, unknown>) {
  const hasContent = Object.values(sessionNotes ?? {}).some((v) => v && String(v).trim());
  if (!hasContent) return; // 何も積み上がっていないセッションは要約を更新しない

  const db = getDb();
  const { data: existing } = await db.from("person_memory")
    .select("summary,session_count").eq("client_id", clientId).maybeSingle();

  const prompt = `# 前回までの引き継ぎメモ\n${existing?.summary || "(まだ無い)"}\n\n` +
    `# 今回のセッションの見立て\n${JSON.stringify(sessionNotes)}`;

  let newSummary = existing?.summary ?? "";
  try {
    newSummary = (await callGemini(LITE_MODELS, SUMMARY_PROMPT, [{ role: "user", parts: [{ text: prompt }] }], 400)).trim();
  } catch (e) {
    console.error("人単位の記憶の要約に失敗しました(本体の会話には影響なし):", e);
    return; // 要約生成に失敗しても本体の会話は止めない。次回の更新に任せる。
  }
  if (newSummary.length > MEMORY_MAX_CHARS) newSummary = newSummary.slice(0, MEMORY_MAX_CHARS);

  await db.from("person_memory").upsert({
    client_id: clientId,
    summary: newSummary,
    session_count: (existing?.session_count ?? 0) + 1,
    last_seen: new Date().toISOString(),
  });
}

const CLASSIFIER_PROMPT =
`あなたは中高生向け相談AIの安全判定器です。相談者の発言を読み、次のJSONだけを返します。
{"risk":"none|watch|crisis","reason":"20字以内"}
crisis: 自殺念慮・自傷、死にたい気持ち、虐待や暴力の被害、性被害、いますぐの身の危険、深刻ないじめ被害。
watch : つらさが強く、放置すると悪化しうる。孤立感が強い、眠れない、食べられない、学校に行けない等。
none  : 通常の相談。
迷ったら重いほうを選ぶこと。見逃しのほうが害が大きい。`;

// ============================================================================
//  ナレッジ(DB から読む。60秒キャッシュ)
//  ※サーバーレス環境ではインスタンスがウォームな間だけ効く簡易キャッシュ
// ============================================================================
type Know = {
  id: string; src: string; school: string | null; cat: string;
  lv: number | null; weight: string; tags: string[]; body: string;
  updated_at: string;
};
let cache: { at: number; rows: Know[] } | null = null;

async function loadKnowledge(): Promise<Know[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const { data, error } = await getDb()
    .from("knowledge")
    .select("id,src,school,cat,lv,weight,tags,body,updated_at")
    .eq("active", true);
  if (error) throw new Error("ナレッジを読めませんでした: " + error.message);
  cache = { at: Date.now(), rows: (data ?? []) as Know[] };
  return cache.rows;
}

// ナレッジの世代。どの版で動いた会話かを記録するために使う
function knowledgeVersion(rows: Know[]): string {
  const latest = rows.reduce((a, k) => (k.updated_at > a ? k.updated_at : a), "");
  return `${rows.length}件 / ${latest.slice(0, 19)}`;
}

// 取り出し。140件規模ならタグ照合で十分。
// 件数が1000を超えたら pgvector + 全文検索のハイブリッドに差し替える。
function retrieve(rows: Know[], text: string, weight: string, relation: string, n = 9): Know[] {
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
function buildSystem(
  rows: Know[], chunks: Know[], weight: string, notes: unknown, sinceSummary: number,
  personSummary?: string | null,
) {
  const principles = rows.filter((k) => k.cat === "principle")
    .map((k) => `・${k.body}(${k.src})`).join("\n");
  const ngAt = (lv: number) =>
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

// ============================================================================
//  Gemini 呼び出し
//  contents は Gemini の形式 { role: "user"|"model", parts: [{ text }] }[] で渡す。
//  responseMimeType を application/json にして、後述の出力形式(JSONのみ)を守らせやすくしている
//  (それでも念のため parseJSON() で本文からJSON部分を取り出す形は残す)。
//
//  safetySettings: いじめ・孤立・希死念慮などをそのまま話題にするのがこのアプリの前提だが、
//  Geminiの既定の安全フィルタ(BLOCK_MEDIUM_AND_ABOVE)は支援的な文脈でもこうした話題を
//  ブロックし、応答が空になることがある。相手を傷つける内容の生成を防ぐ目的は保ったまま、
//  高確度で有害と判定されたものだけを止めるBLOCK_ONLY_HIGHに緩めている。
// ============================================================================
async function callGeminiOnce(
  model: string, systemInstruction: string, contents: unknown[], maxOutputTokens: number,
) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY!,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { maxOutputTokens, responseMimeType: "application/json" },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // レート制限(無料枠は1モデルあたりのRPMが低く、1ターンでclassify+本生成の
    // 複数回呼ぶため連投だけでも超えうる)と、それ以外のエラーを区別できるようにしておく。
    // 404はモデルが退役・存在しない場合もここに来るので、フォールバックの対象にする。
    const tag = res.status === 429 ? "[RATE_LIMIT]" : `[HTTP_${res.status}]`;
    throw new Error(`${tag} Gemini(${model}) ${res.status}: ${body}`);
  }
  const d = await res.json();
  const candidate = d.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "").join("");
  if (!text) {
    const reason = d.promptFeedback?.blockReason || candidate?.finishReason || "unknown";
    throw new Error(`[BLOCKED] Gemini(${model})の応答が空でした(理由: ${reason})`);
  }
  return text;
}

// models を上から順に試し、最初に成功したものを返す。
// レート制限・モデル退役・安全フィルタ等、理由を問わず失敗したら次のモデルに移る。
// 全滅したら最後のエラーを投げる(呼び出し側は従来どおり [RATE_LIMIT]/[BLOCKED]/[HTTP_xxx]
// のタグで原因を判別できる)。
async function callGemini(
  models: string[], systemInstruction: string, contents: unknown[], maxOutputTokens = 1000,
) {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await callGeminiOnce(model, systemInstruction, contents, maxOutputTokens);
    } catch (e) {
      lastError = e;
      console.error(`モデル ${model} が失敗、次のモデルにフォールバックします:`, e);
    }
  }
  throw lastError;
}

function parseJSON(raw: string) {
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("応答をJSONとして読み取れませんでした");
  return JSON.parse(raw.slice(s, e + 1));
}

async function classify(text: string) {
  const keywords = CRISIS_WORDS.filter((w: string) => text.includes(w));
  let model = { risk: "none", reason: "判定なし" };
  try {
    model = parseJSON(await callGemini(LITE_MODELS, CLASSIFIER_PROMPT, [{ role: "user", parts: [{ text }] }], 200));
  } catch {
    model = { risk: keywords.length ? "crisis" : "none", reason: "判定器エラー" };
  }
  // キーワードが当たったら判定器の結果によらず crisis 扱い(見逃しを避ける)
  const risk = keywords.length ? "crisis" : model.risk;
  return { risk, keywords, model };
}

const checkOutput = (t: string) =>
  OUTPUT_NG.filter((re: RegExp) => re.test(t)).map((re: RegExp) => String(re).slice(0, 42));

// 危機通知。本文は送らない。
// 未成年の相談内容を Slack 等のチャンネルに流すのは避け、
// 「確認が必要なセッションがある」ことだけを伝えて、詳細は管理画面で見る運用にする。
async function notifyCrisis(sessionId: string) {
  if (!WEBHOOK) return false;
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `【要確認】相談AIで危機判定が出ました\nセッション: ${sessionId}\n時刻: ${new Date().toISOString()}\n内容は管理画面(pending_safety)で確認してください。`,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
//  ハンドラ
// ============================================================================
export async function POST(req: Request) {
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "JSONが不正です" }, 400); }
  const action = String(payload.action ?? "chat");

  try {
    const db = getDb();
    // ------------------------------------------------------------------
    // 評価の記録
    // ------------------------------------------------------------------
    if (action === "rate") {
      const { seq, rating, comment } = payload as { seq: number; rating: number; comment?: string };
      if (!seq || !(rating >= 1 && rating <= 5)) return json({ error: "パラメータが不正です" }, 400);
      await db.from("messages").update({ rating, rating_comment: comment ?? null }).eq("seq", seq);
      return json({ ok: true });
    }

    // ------------------------------------------------------------------
    // 管理画面(admin.html)
    // ログイン画面は作らず、admin.html が自分のURLのクエリ文字列から
    // token を読んで毎回のリクエストに含める(docs/backlog.md 1-2)。
    // ------------------------------------------------------------------
    if (action === "admin_sessions") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const { data, error } = await db.from("session_overview")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,turn_count,unrated_count,has_crisis")
        .order("started_at", { ascending: false });
      if (error) throw new Error(error.message);
      const sessions = (data ?? []).map((s) => ({
        id: s.id,
        client_id_short: String(s.client_id).slice(0, 8),
        started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
        relation: s.relation, weight: s.weight,
        turn_count: s.turn_count, unrated_count: s.unrated_count, has_crisis: s.has_crisis,
      }));
      return json({ sessions });
    }

    if (action === "admin_session_detail") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const sessionId = String(payload.session_id ?? "").trim();
      if (!sessionId) return json({ error: "session_id が必要です" }, 400);
      const { data: s } = await db.from("sessions")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,notes")
        .eq("id", sessionId).maybeSingle();
      if (!s) return json({ error: "セッションが見つかりません" }, 404);
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at")
        .eq("session_id", sessionId).order("seq");
      const allUsedIds = Array.from(new Set((msgs ?? []).flatMap((m) => m.used ?? [])));
      let knowledgeMap: Record<string, { id: string; src: string; cat: string; body: string }> = {};
      if (allUsedIds.length) {
        const { data: kn } = await db.from("knowledge").select("id,src,cat,body").in("id", allUsedIds);
        for (const k of kn ?? []) knowledgeMap[k.id] = k;
      }
      const messages = (msgs ?? []).map((m) => ({
        ...m,
        used: (m.used ?? []).map((id: string) => knowledgeMap[id] ?? { id, src: "", cat: "", body: "(削除済み)" }),
      }));
      return json({
        session: {
          id: s.id, client_id_short: String(s.client_id).slice(0, 8),
          started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
          relation: s.relation, weight: s.weight, notes: s.notes,
        },
        messages,
      });
    }

    // ------------------------------------------------------------------
    // セッション開始 / 再開
    // ------------------------------------------------------------------
    if (action === "start") {
      const clientId = String(payload.client_id ?? "").trim();
      if (!clientId) return json({ error: "client_id が必要です" }, 400);

      // 前回、開いたままのセッションが残っていれば閉じて、
      // その内容を人単位の記憶(要約)に畳み込む。
      // ここでしか要約は更新しない = トークンが際限なく増える経路がそもそも無い。
      const { data: open } = await db.from("sessions")
        .select("id,notes").eq("client_id", clientId).is("closed_at", null)
        .order("last_at", { ascending: false }).limit(1).maybeSingle();
      if (open) {
        await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", open.id);
        await updatePersonMemory(clientId, (open.notes ?? {}) as Record<string, unknown>);
      }

      const rows = await loadKnowledge();
      const { data, error } = await db.from("sessions")
        .insert({ client_id: clientId, knowledge_version: knowledgeVersion(rows) })
        .select("id,weight,relation,turns_since_summary,notes").single();
      if (error) throw new Error(error.message);
      return json({ session: data, knowledge_count: rows.length });
    }

    // ------------------------------------------------------------------
    // 直前のセッションを取り出す(端末をまたいだ引き継ぎにも使う)
    // ------------------------------------------------------------------
    if (action === "resume") {
      const clientId = String(payload.client_id ?? "").trim();
      const { data: s } = await db.from("sessions")
        .select("id,weight,relation,turns_since_summary,notes,last_at")
        .eq("client_id", clientId).is("closed_at", null)
        .order("last_at", { ascending: false }).limit(1).maybeSingle();
      if (!s) return json({ session: null, messages: [] });

      // 前回のやり取りから十分に間があいていたら、続きではなく新しい来訪として扱う。
      // 「待つ時間」を経て戻ってきた、という区切りを技術的にも尊重する。
      const idleMinutes = (Date.now() - new Date(s.last_at).getTime()) / 60000;
      if (idleMinutes > SESSION_GAP_MINUTES) {
        await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", s.id);
        await updatePersonMemory(clientId, (s.notes ?? {}) as Record<string, unknown>);
        return json({ session: null, messages: [] }); // クライアント側が start を呼び直す
      }
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,used,flags,crisis,rating")
        .eq("session_id", s.id).order("seq");
      return json({ session: s, messages: msgs ?? [] });
    }

    // ------------------------------------------------------------------
    // 会話本体
    // ------------------------------------------------------------------
    if (action === "chat") {
      const clientId = String(payload.client_id ?? "").trim();
      const sessionId = String(payload.session_id ?? "").trim();
      const text = String(payload.text ?? "").trim();
      if (!clientId || !sessionId || !text) return json({ error: "パラメータが不足しています" }, 400);
      if (text.length > 2000) return json({ error: "長すぎます" }, 400);

      // レート制限
      const { data: used } = await db.rpc("recent_turn_count", { p_client_id: clientId });
      if ((used ?? 0) >= RATE_LIMIT) {
        return json({ error: "しばらく時間をおいてから、またどうぞ。", rate_limited: true }, 429);
      }

      const { data: sess } = await db.from("sessions")
        .select("id,weight,relation,turns_since_summary,notes")
        .eq("id", sessionId).single();
      if (!sess) return json({ error: "セッションが見つかりません" }, 404);

      // 発言を保存
      const { data: userMsg } = await db.from("messages")
        .insert({ session_id: sessionId, role: "user", body: text }).select("seq").single();

      // ---- 入力フィルタ ----
      const safety = await classify(text);
      if (safety.risk !== "none") {
        const notified = safety.risk === "crisis" ? await notifyCrisis(sessionId) : false;
        await db.from("safety_events").insert({
          session_id: sessionId, risk: safety.risk, keywords: safety.keywords,
          model_risk: safety.model.risk, model_reason: safety.model.reason, notified,
        });
      }

      // 危機なら生成をスキップして固定応答
      if (safety.risk === "crisis") {
        const { data: aiMsg } = await db.from("messages").insert({
          session_id: sessionId, role: "ai", body: CRISIS_REPLY, crisis: true,
        }).select("seq").single();
        await db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId);
        return json({
          reply: CRISIS_REPLY, crisis: true,
          safety: { risk: safety.risk, keywords: safety.keywords.length, model: safety.model.risk },
          user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
        });
      }

      // ---- 生成 ----
      const rows = await loadKnowledge();
      const chunks = retrieve(rows, text, sess.weight, sess.relation);

      const { data: hist } = await db.from("messages")
        .select("role,body,crisis").eq("session_id", sessionId).order("seq");
      const messages = (hist ?? [])
        .filter((h) => !h.crisis)
        .map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.body }] }));

      const { data: memory } = await db.from("person_memory")
        .select("summary").eq("client_id", clientId).maybeSingle();
      const system = buildSystem(
        rows, chunks, sess.weight, sess.notes, sess.turns_since_summary, memory?.summary,
      );

      // Geminiの安全フィルタ等で応答が得られない/JSONとして読めないことがある。
      // その場合も技術的なエラーを生徒にそのまま見せず、受け止めだけの返答で会話を続ける。
      // 見逃さないよう flags に記録し、心理士のレビュー画面で頻度を確認できるようにしておく。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let out: any;
      let generationFailed = false;
      let failureCause = "";
      try {
        out = parseJSON(await callGemini(PRIMARY_MODELS, system, messages));
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
          const retry = parseJSON(await callGemini(PRIMARY_MODELS, fix, messages));
          if (checkOutput(retry.reply ?? "").length === 0) {
            out = retry; flags = ["1回目に検知→再生成で解消"];
          }
        } catch { /* 再生成に失敗したら1回目を使い、フラグを残す */ }
      }

      // ---- 記憶フィルタ:許可した項目だけ残す ----
      const ALLOWED = ["主訴の候補","言葉にならない言葉","これまでの解決努力",
        "例外・うまくいっている時","本人のリソース","触れない領域","サポート資源"];
      const notes = { ...(sess.notes as Record<string, string>) };
      for (const k of ALLOWED) if (out.notes?.[k]) notes[k] = String(out.notes[k]);

      const weight = ["rapport","main","goal","plan"].includes(out.weight) ? out.weight : sess.weight;
      const relation = ["visitor","complainant","customer"].includes(out.relation) ? out.relation : sess.relation;
      const since = out.did_summarize === true ? 0 : sess.turns_since_summary + 1;

      const { data: aiMsg } = await db.from("messages").insert({
        session_id: sessionId, role: "ai", body: out.reply,
        weight, relation, question_level: out.question_level, role_kind: out.role,
        summarized: out.did_summarize === true,
        hypothesis: out.hypothesis ?? null, why: out.why ?? null,
        used: out.used ?? chunks.map((c) => c.id), flags,
      }).select("seq").single();

      await db.from("sessions").update({
        weight, relation, turns_since_summary: since, notes,
        last_at: new Date().toISOString(),
      }).eq("id", sessionId);

      // 参照したナレッジは本文も返す(管理画面で見せるため)
      const usedIds: string[] = out.used ?? chunks.map((c) => c.id);
      const usedRows = rows.filter((k) => usedIds.includes(k.id))
        .map((k) => ({ id: k.id, src: k.src, cat: k.cat, body: k.body }));

      return json({
        reply: out.reply,
        weight, relation,
        question_level: out.question_level, role: out.role,
        summarized: out.did_summarize === true, turns_since_summary: since,
        hypothesis: out.hypothesis ?? "", why: out.why ?? "",
        notes, used: usedRows, flags,
        safety: { risk: safety.risk, keywords: safety.keywords.length, model: safety.model.risk },
        user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
      });
    }

    return json({ error: "不明な action です" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "サーバ側で問題が起きました", detail: String(e).slice(0, 300) }, 500);
  }
}
