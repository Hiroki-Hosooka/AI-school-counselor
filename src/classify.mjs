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

import { CRISIS_WORDS, crisisRulesV2, paraphraseShameIdioms } from "./safety.mjs";

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
//
// gemini-2.5-flash-liteは一度削除→2026年9月に復活(別プロジェクトのGoogle AI Studio
// レート制限画面で無料枠の割り当てが残っていることを確認したため)→2026年9月・
// モデル比較検証で再度削除。ペルソナ回帰テスト(テスト4/5)実行中に、この課金
// プロジェクトで実際に404「no longer available to new users」を複数回受け取った
// (gemini-3.5-flash-liteが一時的な503で失敗した直後の2番目のフォールバックとして
// 呼ばれた際に発生。callGemini()の「一部モデルで一時的な失敗」検知が429のみ対応で
// 503を見ていなかったため、この組み合わせで生徒役の発言生成が再試行されずに
// 失敗する不具合も同時に発覚・修正した)。gemini-3.1-flash-liteに置き換える
// (モデル比較検証で実際に動作・低コストを確認済み)。
export const LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

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
async function callGeminiOnce(model, systemInstruction, contents, maxOutputTokens, thinkingBudget, responseSchema) {
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
          thinkingConfig: { thinkingBudget },
          // 危機検知 v2 の分類器だけが渡す(出力の形を強制する。2026年9月・第1段階 1-5)。
          // 渡さない呼び出し(v1の分類器・本生成・記憶の要約)は、これまでと同じリクエストになる。
          ...(responseSchema ? { responseSchema } : {}),
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
  // usageMetadata(実際のトークン消費量)も返す(2026年9月・モデル比較検証)。
  // 既存の戻り値(text)は変えず追加するだけなので、他の呼び出し元には影響しない。
  return { text, usage: d.usageMetadata ?? null };
}

// models を上から順に試し、最初に成功したものを返す。
// レート制限・モデル退役・安全フィルタ等、理由を問わず失敗したら次のモデルに移る。
// 全滅したら最後のエラーを投げる(呼び出し側は [RATE_LIMIT]/[BLOCKED]/[HTTP_xxx]
// のタグで原因を判別できる)。
// 既定の1500は本生成(generateReply)用。thinkingConfigで思考トークンは切っているが、
// reply本文+notes7項目+その他のJSONを余裕を持って収められるよう、多少の余白を持たせてある。
//
// 戻り値は { text, model }(2026年9月・検証一式のログ充実要望への対応)。
// 以前は文字列(text)だけを返しており、フォールバックが実際に発生したか・
// 最終的にどのモデルが応答したかが呼び出し元から分からなかった。classify()/
// generateReply()/人単位の記憶要約(route.ts)/テストスクリプトの生徒役生成が、
// 各ログに「使用したモデル」を残せるよう、成功したモデルIDも一緒に返す。
//
// thinkingBudget の既定値は0(2026年9月・重要)。ただし gemini-*-lite 系のモデルは
// thinkingBudget:0(思考を完全に無効化)を受け付けず、400 INVALID_ARGUMENT になる
// ことを2026年9月、TEST_GEMINI_API_KEYでの実機検証(curlでの直接呼び出し)で確認した
// (gemini-3.5-flash・gemini-3-flash-preview等、liteでない通常モデルでは0のまま有効)。
// -1("dynamic"。モデルに任せる)は検証した全モデルで有効だったため、LITE_MODELSを渡す
// 呼び出し側(classify()・人単位の記憶要約・テストの生徒役生成)は明示的に-1を渡すこと。
// 通常モデル(PRIMARY_MODELS)側は何も渡さなければ既定の0のままなので変更不要。
export async function callGemini(models, systemInstruction, contents, maxOutputTokens = 1500, thinkingBudget = 0, { responseSchema } = {}) {
  let lastError;
  let anyRateLimited = false;
  // Google側の一時的な過負荷(503)も429と同じく「別キー/待てば通る可能性が高い」
  // 一時的な失敗として扱う(2026年9月・モデル比較検証で頻発を確認)。
  let anyOverloaded = false;
  for (const model of models) {
    try {
      const { text, usage } = await callGeminiOnce(model, systemInstruction, contents, maxOutputTokens, thinkingBudget, responseSchema);
      return { text, model, usage };
    } catch (e) {
      lastError = e;
      if (e instanceof Error && e.message.includes("[RATE_LIMIT]")) anyRateLimited = true;
      if (e instanceof Error && e.message.includes("[HTTP_503]")) anyOverloaded = true;
      console.error(`モデル ${model} が失敗、次のモデルにフォールバックします:`, e);
    }
  }
  // 全モデル失敗時、最後に試したモデルのエラーだけを投げると、そのモデルがたまたま
  // 404(退役等)のような別種の失敗だった場合に、途中の別モデルで実際に起きていた
  // レート制限(429)や一時的な過負荷(503)の情報が消えてしまう。呼び出し側
  // (generateReply/classify内のxxxWithRetry)は失敗理由の文字列に"[RATE_LIMIT]"/
  // "[HTTP_503]"が含まれるかで再試行するかを判断しているため、これが消えると
  // 「本来なら待って再試行すれば通ったはずの失敗」が"不明なエラー"として再試行なしで
  // 確定してしまう(2026年9月、実機検証で発覚。当初は429のみ対応していたが、
  // gemini-2.5-flash(-lite)が両方とも404固定になったことで、「先頭モデルが503→
  // 次のモデルが404」という組み合わせが頻発し、503側も同じ理由でマスクされることが
  // わかったため対応を追加した)。誰か一人でも一時的な失敗に当たっていれば、
  // 最終的なエラーにもそのタグを引き継ぐ(両方起きていれば[RATE_LIMIT]を優先)。
  if ((anyRateLimited || anyOverloaded) && lastError instanceof Error
    && !lastError.message.includes("[RATE_LIMIT]") && !lastError.message.includes("[HTTP_503]")) {
    const tag = anyRateLimited ? "[RATE_LIMIT]" : "[HTTP_503]";
    lastError = new Error(
      `${tag} 一部モデルで一時的な失敗が発生(最後に試したモデルの失敗理由: ${lastError.message})`,
    );
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
// 分類器の呼び出しが失敗した場合(レート制限・安全フィルタでブロック等)、キーワードが
// 当たっていれば crisis のまま。当たっていない場合は watch にフォールバックする
// (2026年9月・修正1。ペルソナ多ターン回帰テスト新仕様のB群前提)。
// 以前は none に倒していたが、これは「わからないときは軽く見る」側に倒れる挙動で
// 危険だった。テスト1の79件では実際にはこの分岐が一度も発生せず未検証のまま
// 残っていたため、根拠のある実測ができていない状態だったが、「わからない時に
// 軽く見る」実装を残しておく理由もない。watch(Tier B)は生成を止めずに済み、
// 二択で程度を確認する質問をしない等の配慮だけを働かせる(CLAUDE.md 5.12)ため、
// APIの一時的な不調(503等)で毎回crisis固定応答になるほど過敏にもならない。
//
// classifierError は分類器呼び出しの失敗の有無とタグ([BLOCKED]等)を呼び出し側に
// そのまま伝える(route.ts 側はこの値を見なくても従来どおり動く)。
export async function classify(text) {
  const keywords = CRISIS_WORDS.filter((w) => text.includes(w));
  let model = { risk: "none", subject: "self", reason: "判定なし" };
  let classifierError = null;
  // 実際に判定に成功したモデルID(LITE_MODELSのどれか)。既存の"model"は判定器が返した
  // JSON本体(risk/subject/reason)の意味で使われているため名前を分けている。全モデルが
  // 失敗した場合はnull(2026年9月・検証一式のログ充実要望)。
  let usedModel = null;
  try {
    // maxOutputTokensは200→1024(2026年9月)。thinkingBudget:-1(dynamic)は実際の
    // 思考トークン消費量が読めず(実機検証でCLASSIFIER_PROMPTに対し191〜224トークン
    // 消費を確認)、200では思考だけで使い切りJSON本体がMAX_TOKENSで尻切れになっていた。
    // 出力自体は20〜30トークンの小さなJSONなので、1024は十分な余裕を持たせた値。
    const result = await callGemini(LITE_MODELS, CLASSIFIER_PROMPT, [{ role: "user", parts: [{ text }] }], 1024, -1);
    model = parseJSON(result.text);
    usedModel = result.model;
  } catch (e) {
    classifierError = e instanceof Error ? e.message : String(e);
    model = { risk: keywords.length ? "crisis" : "watch", subject: "self", reason: "判定器エラー" };
  }
  // キーワードが当たったら判定器の結果によらず crisis 扱い(見逃しを避ける)
  const risk = keywords.length ? "crisis" : model.risk;
  // subject が "other" と明示的に判定された場合のみ other。それ以外(不正値・判定器エラー含む)は
  // 安全側の self に倒す(第三者の話だと誤って軽く扱うことを避けるため。CLAUDE.md 5.2 の対象は self のみ)。
  const subject = model.subject === "other" ? "other" : "self";
  return { risk, keywords, subject, model, classifierError, usedModel };
}

// ============================================================================
//  危機検知 v2(2026年9月・危機検知の作り直し 第1段階)
//
//  2026年9月26日に採用し、既定にした(保留セット v2 での最終判定の結果を人が確認した。
//  docs/test-results/crisis-staged-holdout-v2-20260926-summary.txt)。設定 CRISIS_DETECTION=v1 のときだけ、
//  上の classify()(v1)に戻る。v1 は変更していない(検証で「変更前」として同じ条件で比べるため)。
//
//  判定は3段階(0 通常 / 1 気がかり / 2 危機)。規則ごとの結果のうち、いちばん高い段階を採る。
//  上から順に最初に当たった規則で決めるのではない(「名前噛んだ。恥ずかしすぎて死にたい…あと昨日
//  また手首切っちゃった」は、慣用表現の規則では段階1だが、分類器が危機と判定すれば段階2)。
//
//   受動パターンに一致 ........................................ 段階2
//   キーワード(活用形を含む)に一致し、慣用表現に包まれていない ....... 段階2
//   分類器(文脈つき・CLASSIFIER_VOTES 回並行)が1回でも crisis(本人) .... 段階2
//   キーワードが恥ずかしさ・気まずさの慣用表現に包まれている .......... 段階1(0には落とさない)
//   分類器が watch / エラー / 時間切れ ........................... 段階1
//   いずれにも当たらない ........................................ 段階0
//
//  第1段階では、段階2 = 今の crisis(固定応答)、段階1 = 今の watch(Tier B)と同じ扱いにする
//  (段階ごとの応答は第2段階で作る)。戻り値の risk/subject/keywords/model は classify() と同じ形にして、
//  route.ts・テストスクリプトの既存の分岐がそのまま使えるようにしている。
// ============================================================================

export function crisisDetectionVersion() {
  return process.env.CRISIS_DETECTION === "v1" ? "v1" : "v2";
}

// 同じ発言を並行して判定する回数(2026年9月の実測: 1回で待ち時間の中央値2.4秒、2回で3.6秒、3回で4.7秒。
// 1ターンあたりの費用は1回あたり約0.25円)。設定 CRISIS_CLASSIFIER_VOTES で1〜3に変えられる。
export function classifierVotes() {
  const n = Number(process.env.CRISIS_CLASSIFIER_VOTES);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 2;
}
// 1回の判定(再試行を含む)を待つ上限。これを超えたらエラーとして扱う(段階1)。
// 設定 CRISIS_CLASSIFIER_TIMEOUT_MS で変えられる(検証スクリプトは、無料枠の混雑による遅れを
// 「見逃し」と取り違えないよう長めにする。本番の有料枠では既定の15秒)。
function voteTimeoutMs() {
  const n = Number(process.env.CRISIS_CLASSIFIER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}
// 思考トークンが出力枠を使い切って JSON が途中で切れるのを防ぐため、v1(1024)より広く取る
// (2026年9月の実測で、思考は最大約2000トークンに達した)。
const V2_MAX_OUTPUT_TOKENS = 4096;

// 出力の形を強制する(2026年9月・第1段階 1-5。v1 で1〜2%あった「JSONとして読み取れない」応答への対策)
const CLASSIFIER_SCHEMA_V2 = {
  type: "OBJECT",
  properties: {
    risk: { type: "STRING", enum: ["none", "watch", "crisis"] },
    subject: { type: "STRING", enum: ["self", "other"] },
    reason: { type: "STRING" },
  },
  required: ["risk", "subject", "reason"],
  propertyOrdering: ["risk", "subject", "reason"],
};

// v1 の CLASSIFIER_PROMPT からの変更:
//  ・「自殺念慮を明示していない限り watch までにとどめる」の段落を削除した。受動的な希死念慮
//    (「もう朝が来なければいいのに」等)を約4割見逃していた原因(2026年9月25日の検証)
//  ・crisis と watch の境目を「自分の存在がなくなること・死ぬことに触れているか」で定義し直した
//  ・直前のやりとりを文脈として受け取る(入力の形式・文脈の使い方)
//  判定全体を軽い方へ寄せないよう、「〜は crisis ではない」という文は、文脈の使い方の1文だけにしている。
//  恥ずかしさの慣用表現は、プロンプトで説明する代わりに、渡す文の中で中立の言い方に置き換えている
//  (src/safety.mjs の paraphraseShameIdioms)。
const CLASSIFIER_PROMPT_V2 =
`あなたは中高生向け相談AIの安全判定器です。相談者の発言を読み、次のJSONだけを返します。
{"risk":"none|watch|crisis","subject":"self|other","reason":"20字以内"}

入力の形式:
【直前までの会話】相談者とAIの直前のやりとり(文脈。判定の対象ではない)
【判定する発言】相談者の最新の発言
判定するのは【判定する発言】だけです。

risk の基準:
crisis: 自分の存在がなくなること・死ぬことに触れている(明示的か受動的かは問わない)。
        例:「死にたい」「消えたい」「朝が来なければいい」「自分がいない方がいい」
        自傷(方法や実行への言及を含む)、生命に関わる暴力の被害・加害、虐待、性被害、
        いますぐの身の危険、深刻ないじめ被害も含む。
watch : 無力感や自己否定だが、存在の消失には触れていないもの。
        例:「もう無理」「限界」「自分なんてダメ」「頑張る意味ある?」
        孤立感が強い、眠れない、食べられない、学校に行けない等も含む。
none  : 通常の相談。「わからない」「決められない」等の判断の迷い、「どうにかしたい」等の
        前向きな焦りは、無力感を伴わない限り none。

文脈の使い方:
・【直前までの会話】は、【判定する発言】が何を指しているかを読み取るためにだけ使う。
  例えば「早く終わってほしい」「もう帰りたい」が、このやりとり(面談)を早く終えたいという意味なのか、
  自分の生活や人生についての意味なのかを、直前のAIの問いかけや流れから判断する。
  このやりとりを終えたい・この場を離れたいという意味だと文脈から明らかに読み取れるなら、それだけでは crisis ではない。
・文脈の中にある過去の発言の危険度を、そのまま【判定する発言】に引き継がない(過去の発言は、そのときに別に判定済み)。
  ただし【判定する発言】が、文脈の中の危機的な発言を肯定したり言い直したりしている場合
  (「本気だよ」「さっきのはほんとのこと」等)は、その内容で判定する。
・文脈を理由に risk を下げてよいのは、発言が相談者自身の命や安全についてのものではないと、文脈から明らかに読み取れる場合だけ。

subject の基準(発言が誰の安全についてか):
self : 相談者自身についての発言。
other: 「友達が」「家族が」等、相談者以外の第三者の安全についての発言。
       相談者自身にも同時にサインがある場合は self とする。

迷ったら、risk は重いほうを選ぶこと(見逃しのほうが害が大きい)。
ただし self か other かで迷う場合は self を選ぶこと(第三者の話だと誤って軽く扱うことを避けるため)。`;

// 判定する発言より前の直近のやりとり(古い順の { role: "user" | "ai", text })のうち、末尾の
// CLASSIFIER_CONTEXT_MESSAGES 件を文脈として渡す。長い発言は末尾(判定する発言に近い側)を残す。
export const CLASSIFIER_CONTEXT_MESSAGES = 4;
const CONTEXT_CHARS_PER_MESSAGE = 400;

function buildClassifierInput(text, recentMessages) {
  const lines = (recentMessages ?? [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .slice(-CLASSIFIER_CONTEXT_MESSAGES)
    .map((m) => {
      const flat = m.text.replace(/\s+/g, " ").trim();
      const clipped = flat.length > CONTEXT_CHARS_PER_MESSAGE ? `…${flat.slice(-CONTEXT_CHARS_PER_MESSAGE)}` : flat;
      return `${m.role === "ai" ? "AI" : "相談者"}: ${clipped}`;
    });
  return `【直前までの会話】\n${lines.length ? lines.join("\n") : "(なし。これが最初の発言)"}\n\n【判定する発言】\n${text}`;
}

// 1回分の判定。失敗(API エラー・解析できない応答・想定外の値)したら1回だけ再試行する。
async function oneVote(input) {
  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callGemini(
        LITE_MODELS, CLASSIFIER_PROMPT_V2, [{ role: "user", parts: [{ text: input }] }],
        V2_MAX_OUTPUT_TOKENS, -1, { responseSchema: CLASSIFIER_SCHEMA_V2 },
      );
      const parsed = parseJSON(result.text);
      if (!["none", "watch", "crisis"].includes(parsed.risk)) throw new Error(`想定外の risk: ${parsed.risk}`);
      return {
        ok: true, risk: parsed.risk, subject: parsed.subject === "other" ? "other" : "self",
        reason: parsed.reason ?? "", model: result.model, usage: result.usage, retried: attempt > 0, ms: Date.now() - started,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError, retried: true, ms: Date.now() - started };
}

function voteWithTimeout(input) {
  const limit = voteTimeoutMs();
  let timer;
  return Promise.race([
    oneVote(input).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `[TIMEOUT] ${limit}ms以内に判定が返らなかった`, ms: limit }), limit);
    }),
  ]);
}

// n 回並行して判定する。1回でも crisis(本人)が返ったら、残りを待たずに確定する(危機のときに待ち時間を伸ばさない)。
// 待たなかった回は skipped として返す(失敗としては数えない)。
function runVotes(input, n) {
  return new Promise((resolve) => {
    const results = new Array(n).fill(null);
    let pending = n;
    const finish = () => resolve(results.map((r) => r ?? { ok: false, skipped: true }));
    for (let i = 0; i < n; i++) {
      voteWithTimeout(input).then((r) => {
        results[i] = r;
        pending--;
        if ((r.ok && r.risk === "crisis" && r.subject === "self") || pending === 0) finish();
      });
    }
  });
}

// 戻り値(classify() と同じ形の risk/keywords/subject/model/classifierError/usedModel に加えて):
//   stage       0 | 1 | 2(相談者本人についての段階)
//   decidedBy   段階を決めた規則("pattern" | "keyword" | "classifier" | "idiom" | "classifier_watch" | "classifier_error")
//   patterns    一致した受動パターンのID / idiomExempted 慣用表現として段階1にとどめた箇所
//   votes       分類器の各回の結果(判定・理由・モデル・所要時間・トークン数)
export async function classifyStaged(text, recentMessages = [], { votes = classifierVotes() } = {}) {
  const rules = crisisRulesV2(text);
  // 文脈の中の相談者の発言も、慣用表現は中立の言い方に置き換える(過去の慣用表現に判定が引きずられないように)
  const context = (recentMessages ?? []).map((m) => (m?.role === "ai" ? m : { ...m, text: paraphraseShameIdioms(m?.text).text }));
  const results = await runVotes(buildClassifierInput(rules.classifierText, context), votes);
  const done = results.filter((r) => !r.skipped);
  const ok = done.filter((r) => r.ok);
  const errors = done.filter((r) => !r.ok);
  // 本人か第三者か: 判定できた回がすべて other のときだけ第三者(1回でも self なら本人。
  // 判定できた回が無ければ本人)。迷ったら本人の側に倒す(CLASSIFIER_PROMPT_V2 と同じ考え方)
  const allOther = ok.length > 0 && ok.every((r) => r.subject === "other");
  const anyCrisis = ok.some((r) => r.risk === "crisis");

  let stage = 0;
  const decidedBy = [];
  const raise = (s, why) => { stage = Math.max(stage, s); decidedBy.push(why); };
  if (rules.patterns.length) raise(2, "pattern");
  if (rules.keywords.length) raise(2, "keyword");
  if (anyCrisis && !allOther) raise(2, "classifier");
  if (rules.idiomExempted.length) raise(1, "idiom");
  if (ok.some((r) => r.risk === "watch")) raise(1, "classifier_watch");
  if (errors.length) raise(1, "classifier_error");

  const subject = allOther ? "other" : "self";
  // route.ts の既存の分岐に合わせた risk。段階2は crisis(subject が other なら、今と同じく第三者として生成を続ける)。
  // すべての回が第三者の危機と判定した場合も crisis/other(第三者の安全への懸念)
  let risk = stage === 2 ? "crisis" : stage === 1 ? "watch" : "none";
  if (anyCrisis && allOther) risk = "crisis";

  const decisive = ok.find((r) => r.risk === "crisis") ?? ok.find((r) => r.risk === "watch") ?? ok[0];
  return {
    risk, subject, stage, decidedBy,
    keywords: rules.keywords, patterns: rules.patterns, idiomExempted: rules.idiomExempted,
    model: { risk: ok.map((r) => r.risk).join("/") || "判定器エラー", subject, reason: decisive?.reason ?? "判定器エラー" },
    classifierError: errors.length ? errors.map((r) => r.error).join(" | ") : null,
    usedModel: decisive?.model ?? null,
    votes: results,
  };
}
