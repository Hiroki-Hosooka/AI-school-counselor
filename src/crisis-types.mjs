// ============================================================================
//  危機の種類(2026年11月1日・危機の作り直し 1-3。人の確認ずみ。【仮】心理士の確認待ち)
//
//  1つの発言に、いくつかの種類が同時にありうる(相談ログ 1d0a0511 15:18: 父からの暴力 + 母の過量服薬)。
//  以前は種類を1つだけ選び(希死念慮が最優先)、母の「自殺未遂」を本人の希死念慮として数えて、
//  「いなくなりたいと思うくらい、つらい気持ちがあること」と、一般の窓口を出していた。
//
//  種類(優先の順。受け止めの一言と窓口のカードの並びもこの順)
//    abuse     本人が受けている暴力・虐待・性被害(家で暴力を見ていること=面前DV を含む)
//    suicidal  本人の希死念慮
//    selfharm  本人の自傷・過量服薬
//    bullying  重大ないじめ
//    other     第三者(家族・友達など)の危機
//
//  ここで決めるのは「種類」だけ。段階(危機かどうか)・通知・固定応答を出すかどうかは変えない(第2部で扱う)。
//  窓口の番号は画面(src/app/page.tsx)の固定データに置き、サーバは種類の並びだけを返す。
// ============================================================================
import { crisisRulesV3 } from "./crisis-keywords-v3.mjs";

export const CRISIS_TYPE_PRIORITY = ["abuse", "suicidal", "selfharm", "bullying", "other"];
const TYPE_OF_CATEGORY = { suicidal: "suicidal", selfharm: "selfharm", violence: "abuse", sexual: "abuse", bullying: "bullying" };

// 第三者を主語にする語(家族・友達など)。「〜は」「〜が」「〜も」「〜って」が続くときだけ主語とみなす
const OTHER_PERSON = "(お母さん|お父さん|おかあさん|おとうさん|母親|父親|母|父|ママ|パパ|姉|兄|妹|弟|お姉ちゃん|お兄ちゃん|" +
  "おばあちゃん|おじいちゃん|祖母|祖父|家族|親友|友達|友だち|ともだち|友人|彼氏|彼女|先輩|後輩|クラスの子|あの子|同級生)";
const OTHER_SUBJECT_RE = new RegExp(`${OTHER_PERSON}(は|が|も|って)`);
// 本人を主語にする語(これがある節は本人のこと)
const SELF_SUBJECT_RE = /(私|わたし|あたし|自分|僕|ぼく|俺|おれ|うち)(は|が|も|って|、)/;
// 人から聞いた危機(「死にたいって言ってた」)。主語が無くても第三者
const REPORTED_RE = /(って|と)(言って|いって|言われ|書いて|聞い|ゆって)/;

// 家で暴力を見ていること(面前DV)。暴力の語(「暴力」「殴られ」等)はキーワードで abuse になるので、ここではそれ以外の言い方
const WITNESS_RE = [
  new RegExp(`${OTHER_PERSON}[^。！？!?\\n]{0,10}${OTHER_PERSON}[^。！？!?\\n]{0,4}(を|に)[^。！？!?\\n]{0,6}(殴|叩|たた|なぐ|蹴っ|ける|けっ|首を絞|物を投げ|ものを投げ)`),
  /(両親|親|夫婦)の?(喧嘩|けんか|ケンカ)[^。！？!?\n]{0,12}(物|もの)を投げ/,
];

// 種類を見分けるためだけの言い方(段階は変えない。キーワードに無いが、分類器が危機と判定しうるもの)。
// 相談ログ 1d0a0511 の「死んでやる」、86130eef の「切るのがやめられない」は、種類不明の文になっていた
const TYPE_HINTS = [
  { type: "suicidal", re: /死んで(やる|やろう)|しんで(やる|やろう)|死の(う|か)/ },
  { type: "selfharm", re: /(切る|切って|切っちゃ|切り|きる)の?(が|を)?(やめられ|止められ|やめれ|とめられ)|(腕|手首|足)を?(切|きっ)|自傷|リスカ|アムカ/ },
];

// 文を節に分け、主語を節から節へ引き継ぐ(「母は自殺未遂を繰り返し、ODをしています」の後半も母のこと)
function clausesWithSubject(text) {
  const out = [];
  for (const sentence of String(text ?? "").split(/[。！？!?\n]+/)) {
    let subject = null; // "other" | "self" | null(わからない=本人として扱う)
    for (const clause of sentence.split(/[、,，]/)) {
      if (!clause.trim()) continue;
      const self = SELF_SUBJECT_RE.test(clause), other = OTHER_SUBJECT_RE.test(clause);
      if (self && !other) subject = "self";
      else if (other && !self) subject = "other";
      else if (other && self) subject = clause.search(SELF_SUBJECT_RE) < clause.search(OTHER_SUBJECT_RE) ? "self" : "other";
      const reported = REPORTED_RE.test(clause);
      out.push({ clause, subject: reported && subject !== "self" ? "other" : subject });
    }
  }
  return out;
}

// 発言と判定の結果から、種類の並び(優先の順・重複なし)を返す。どれにも当たらなければ []
// safety: classifyStaged / classifyLocal / classify の戻り値(subject を見る)。省略可
export function crisisTypesOf(text, safety) {
  const found = new Set();
  for (const { clause, subject } of clausesWithSubject(text)) {
    for (const h of crisisRulesV3(clause).hits) {
      if (h.stage !== 2) continue;
      const t = TYPE_OF_CATEGORY[h.category];
      if (!t) continue;
      // 暴力・性被害・いじめは、誰が主語でも本人の被害として扱う(家族が家族に暴力をふるうのを見ていることも本人の被害)。
      // 希死念慮・自傷だけ、主語が第三者なら第三者の危機
      if ((t === "suicidal" || t === "selfharm") && subject === "other") found.add("other");
      else found.add(t);
    }
    for (const { type, re } of TYPE_HINTS) {
      if (type === "selfharm" && /爪|つめ|髪|かみ|前髪|ネイル/.test(clause)) continue;
      if (re.test(clause)) found.add(subject === "other" ? "other" : type);
    }
  }
  if (WITNESS_RE.some((re) => re.test(String(text ?? "")))) found.add("abuse");
  if (safety?.subject === "other" && safety?.risk === "crisis") found.add("other");
  return CRISIS_TYPE_PRIORITY.filter((t) => found.has(t));
}

// 記録用(messages.flags と safety_events の理由)。画面に返すときは、この印から種類を読み直す(列を足さない)
export const CRISIS_TYPES_FLAG = "危機の種類";
export const crisisTypesFlag = (types) => (types?.length ? `${CRISIS_TYPES_FLAG}: ${types.join(",")}` : null);
export function crisisTypesFromFlags(flags) {
  const f = (Array.isArray(flags) ? flags : []).map(String).find((x) => x.startsWith(`${CRISIS_TYPES_FLAG}: `));
  if (!f) return null;
  const types = f.slice(CRISIS_TYPES_FLAG.length + 2).split(",").filter((t) => CRISIS_TYPE_PRIORITY.includes(t));
  return types.length ? types : null;
}
