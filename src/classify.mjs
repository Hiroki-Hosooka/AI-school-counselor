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
// gemini-2.5-flash-liteは一度削除したが、2026年9月に復活させた(2番目の
// フォールバックとして)。実運用のAPIキー/プロジェクトでは
// "This model models/gemini-2.5-flash-lite is no longer available to new users" という
// 404を受け取ったが、Google AI Studioのレート制限画面では(別プロジェクトで)
// 無料枠の割り当てが実際に残っていることを確認した。新規プロジェクトかどうかで
// 使えるかが分かれる可能性があるため、先頭には置かず、gemini-3.5-flash-liteが
// 失敗した時だけ試す2番目に置く(失敗してもそのまま次(無ければ判定エラー扱い)に
// フォールバックするだけなので、載せておいて害はない)。
export const LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

// 2026年9月(構造化面接AI統合 手順4)に、絶望感≠危機の原則とsubject(self/other)判定を追加。
// 「もう無理」「限界」等はここでは crisis から外し、watch(Tier B)側に明示的に含めている
// (src/safety.mjs の CRISIS_WORDS 変更と対をなす)。subject は、友人・家族等の第三者の
// 安全についての発言を、相談者自身の危機と取り違えないための判定(03_共通グランドルール
// _両条件共通.txt 7-5)。route.ts 側は risk==="crisis" && subject==="self" のときだけ
// 生成をスキップする(CLAUDE.md 5.2 の対象は self のみ)。
const CLASSIFIER_PROMPT =
`あなたは中高生向け相談AIの安全判定器です。相談者の発言を読み、次のJSONだけを返します。
{"risk":"none|watch|crisis","subject":"self|other","reason":"20字以内"}

risk の基準:
crisis: 自殺念慮・自傷(方法や実行への言及を含む)、生命に関わる暴力の被害・加害、虐待、性被害、
        いますぐの身の危険、深刻ないじめ被害。「死にたい」「消えたい」「もう終わりにしたい」等、
        自殺念慮を直接示す表現を含む。
watch : 「もう無理」「限界」「自分なんて」「どうしようもない」等、自殺念慮を明示しない
        無力感・自己否定の表現。孤立感が強い、眠れない、食べられない、学校に行けない等も含む。
none  : 通常の相談。「わからない」「決められない」等の判断の迷い、「どうにかしたい」等の
        前向きな焦りは、無力感を伴わない限り none。

重要な原則:絶望感・無力感の表現(「話しても無駄」「何をしても変わらない」等)は、それ単独では
crisis のサインではない。自殺念慮を明示していない限り、watch までにとどめること。

subject の基準(発言が誰の安全についてか):
self : 相談者自身についての発言。
other: 「友達が」「家族が」等、相談者以外の第三者の安全についての発言。
       相談者自身にも同時にサインがある場合は self とする。

迷ったら、risk は重いほうを選ぶこと(見逃しのほうが害が大きい)。
ただし self か other かで迷う場合は self を選ぶこと(第三者の話だと誤って軽く扱うことを避けるため)。`;

// ============================================================================
//  Gemini 呼び出し
//  contents は Gemini の形式 { role: "user"|"model", parts: [{ text }] }[] で渡す。
//  responseMimeType を application/json にして、後述の出力形式(JSONのみ)を守らせやすくしている
//  (それでも念のため parseJSON() で本文からJSON部分を取り出す形は残す)。
//
//  thinkingConfig.thinkingBudget: 0 (2026年9月・重要)
//  gemini-2.5/3.5系は既定で「思考(thinking)」が有効で、thinkingConfigを指定しないと
//  この思考トークンが maxOutputTokens の枠を食う。分類器(200トークン)はもちろん、
//  本生成(既定1000トークン)でも、思考に大半を使われて可視の応答(JSON本体)が
//  尻切れになり、parseJSON()が「応答をJSONとして読み取れませんでした」で落ちる、
//  または応答が空になり[BLOCKED]扱いになる、という不具合が多発する原因になっていた。
//  この応答は短い会話文+構造化JSONで、深い思考の連鎖を必要としないタスクのため、
//  thinkingBudgetを0にして無効化する(Google公式ドキュメントが低コスト・低レイテンシ
//  用途向けに明示している設定)。crisis判定のロジックや安全フィルタの閾値そのものは
//  変更していない。
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
        generationConfig: {
          maxOutputTokens, responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
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
// 既定の1500は本生成(generateReply)用。thinkingConfigで思考トークンは切っているが、
// reply本文+notes7項目+その他のJSONを余裕を持って収められるよう、多少の余白を持たせてある。
export async function callGemini(models, systemInstruction, contents, maxOutputTokens = 1500) {
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
  let model = { risk: "none", subject: "self", reason: "判定なし" };
  let classifierError = null;
  try {
    model = parseJSON(await callGemini(LITE_MODELS, CLASSIFIER_PROMPT, [{ role: "user", parts: [{ text }] }], 200));
  } catch (e) {
    classifierError = e instanceof Error ? e.message : String(e);
    model = { risk: keywords.length ? "crisis" : "none", subject: "self", reason: "判定器エラー" };
  }
  // キーワードが当たったら判定器の結果によらず crisis 扱い(見逃しを避ける)
  const risk = keywords.length ? "crisis" : model.risk;
  // subject が "other" と明示的に判定された場合のみ other。それ以外(不正値・判定器エラー含む)は
  // 安全側の self に倒す(第三者の話だと誤って軽く扱うことを避けるため。CLAUDE.md 5.2 の対象は self のみ)。
  const subject = model.subject === "other" ? "other" : "self";
  return { risk, keywords, subject, model, classifierError };
}
