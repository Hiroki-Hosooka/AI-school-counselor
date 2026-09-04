// ============================================================================
//  危機判定(classify)の共通モジュール
//
//  src/app/api/chat/route.ts(本番)と scripts/test-crisis-detection.mjs(テスト1。
//  docs/backlog.md 1-3)の両方から、同じ判定ロジックを import するために切り出した。
//  テスト1は「実際に動いているのと同じロジック」の精度を測るためのものなので、
//  ここを本番用とテスト用で分岐させると測定の意味が無くなる。route.ts 側だけの
//  都合でこのファイルに手を入れないこと。
//
//  CRISIS_WORDS(キーワード事前検知)は出力チェックと共有するため src/safety.mjs のまま。
//  scripts/test-persona-regression.mjs(テスト4)が危機分岐を忠実に再現するために
//  CRISIS_REPLY もここに置く。
// ============================================================================

import { CRISIS_WORDS } from "./safety.mjs";

// 危機判定時の固定応答(生成は完全にスキップする。CLAUDE.md 5.2)。文言を変える場合は
// この分岐の意図(態度だけを示し、手順には踏み込まない)を壊していないか確認すること。
export const CRISIS_REPLY =
  "よく、ここで言えたね。誰にも言えないと思っていたことを書くのは、すごく力が要ったと思う。\n\n" +
  "どうしてここでなら言えると思ったのか、あとで聞かせてもらえたら嬉しい。\n\n" +
  "そのうえで正直に言うと、いま書いてくれたことは、わたしだけで受け止めるには重い内容です。あなたを軽く扱いたくないので、はっきり言います。心配だから、ここから先はあなたの声が届く人につながってほしい。\n\n" +
  "学校の先生でも、保健室でも、スクールカウンセラーでも、家の人でも、下の窓口でもかまいません。あなたが一番話せそうなところで大丈夫です。";

// 安全判定(classify)・人単位の記憶の要約用。軽いタスクなので lite モデルで十分。
// route.ts の本生成用モデル(PRIMARY_MODELS)とは別モデルにすることで、
// レート制限の枠も分散させている。
export const LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

const CLASSIFIER_PROMPT =
`あなたは中高生向け相談AIの安全判定器です。相談者の発言を読み、次のJSONだけを返します。
{"risk":"none|watch|crisis","reason":"20字以内"}
crisis: 自殺念慮・自傷、死にたい気持ち、虐待や暴力の被害、性被害、いますぐの身の危険、深刻ないじめ被害。
watch : つらさが強く、放置すると悪化しうる。孤立感が強い、眠れない、食べられない、学校に行けない等。
none  : 通常の相談。
迷ったら重いほうを選ぶこと。見逃しのほうが害が大きい。`;

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
//  この閾値はCLAUDE.md 5.11の対象。緩めた判断の裏付け(ブロック率の実測)が、
//  まさにこのファイルを使うテスト1(scripts/test-crisis-detection.mjs)の役目。
// ============================================================================
async function callGeminiOnce(model, systemInstruction, contents, maxOutputTokens) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
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
    // レート制限(無料枠は1モデルあたりのRPMが低い)と、それ以外のエラーを区別できるようにしておく。
    // 404はモデルが退役・存在しない場合もここに来るので、フォールバックの対象にする。
    const tag = res.status === 429 ? "[RATE_LIMIT]" : `[HTTP_${res.status}]`;
    throw new Error(`${tag} Gemini(${model}) ${res.status}: ${body}`);
  }
  const d = await res.json();
  const candidate = d.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "").join("");
  if (!text) {
    const reason = d.promptFeedback?.blockReason || candidate?.finishReason || "unknown";
    throw new Error(`[BLOCKED] Gemini(${model})の応答が空でした(理由: ${reason})`);
  }
  return text;
}

// models を上から順に試し、最初に成功したものを返す。
// レート制限・モデル退役・安全フィルタ等、理由を問わず失敗したら次のモデルに移る。
// 全滅したら最後のエラーを投げる(呼び出し側は [RATE_LIMIT]/[BLOCKED]/[HTTP_xxx]
// のタグで原因を判別できる)。
export async function callGemini(models, systemInstruction, contents, maxOutputTokens = 1000) {
  let lastError;
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

export function parseJSON(raw) {
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("応答をJSONとして読み取れませんでした");
  return JSON.parse(raw.slice(s, e + 1));
}

// キーワード事前検知 + Gemini分類器。
//
// 分類器の呼び出しが失敗した場合(レート制限・安全フィルタでブロック等)は、
// キーワードが当たっていれば crisis のまま、当たっていなければ none にフォールバックする。
// これは「わからないときは軽く見る」側に倒れる挙動であり、本来は避けたい形だが、
// 根拠のない変更をしないというCLAUDE.md 5.11の方針に従い、対処はせず、まず
// docs/backlog.md 1-3 テスト1で実際の発生率を計測してから判断する(2026年9月時点)。
//
// classifierError はその計測のために、分類器呼び出しの失敗の有無とタグ([BLOCKED]等)を
// 呼び出し側にそのまま伝える(route.ts 側はこの値を見なくても従来どおり動く)。
export async function classify(text) {
  const keywords = CRISIS_WORDS.filter((w) => text.includes(w));
  let model = { risk: "none", reason: "判定なし" };
  let classifierError = null;
  try {
    model = parseJSON(await callGemini(LITE_MODELS, CLASSIFIER_PROMPT, [{ role: "user", parts: [{ text }] }], 200));
  } catch (e) {
    classifierError = e instanceof Error ? e.message : String(e);
    model = { risk: keywords.length ? "crisis" : "none", reason: "判定器エラー" };
  }
  // キーワードが当たったら判定器の結果によらず crisis 扱い(見逃しを避ける)
  const risk = keywords.length ? "crisis" : model.risk;
  return { risk, keywords, model, classifierError };
}
