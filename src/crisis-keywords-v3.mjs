// ============================================================================
//  危機キーワード v3(案)と、否定のキーワード(2026年10月9日)
//
//  表は docs/crisis-keywords-v3.md(すべての語に段階・根拠がある)。指示書は docs/prompts/crisis-keywords-v3.md、
//  v2 との差分と人の確認は docs/crisis-keywords-v3-diff.md。
//
//  ・設定 CRISIS_KEYWORDS=v3 のときだけ使う(既定は v2。検証の結果を人が確認してから既定にする)
//  ・段階 2 = 当たれば分類器の答えに関係なく段階2 / 段階 1 = 少なくとも段階1(分類器が crisis なら段階2)
//  ・v3 の表に無いが、今のリストにあって人が「残す」とした語(diff の K1〜K10)は、ref に "v2" と書いて区別する
//  ・照合用の正規化(normalizeV3)は照合のためだけに使う。保存する発言・分類器に渡す文は元のまま
//  ・かなにすると別の言葉にまぎれる語は、かなでは登録しない(v2 と同じ考え方。下の各行のコメント):
//      けられ(見つけられた)・じしょう(自称)・あむか(なあ、むかつく)・じぶんをき(自分を気に)・うでをき(腕を鍛える)・
//      りすか(ありすかわいい)・かつあげ(とんかつあげた)・いきたい(行きたい)・もった(持った)
//  ・否定のキーワード(11章の A・B)もここに置く。否定は段階を上げも下げもしない。段階を下げるかどうかは、
//    危機の応答の流れの側で、気持ちのスケーリングと組み合わせて決める(docs/prompts/crisis-flow-shima3.md 1章)
// ============================================================================

import { paraphraseShameIdioms, SHAME_IDIOM_PATTERN } from "./safety.mjs";

// 照合前の正規化(表の1章)。NFKC → カタカナをひらがなに → 英字を小文字に →
// 空白・記号・長音・小書きの母音・促音を除く
export function normalizeV3(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase()
    .replace(/[\s、。,.!?!?・…‥ー〜~～\-_「」『』()()\[\]【】"'“”‘’:;:;/*#@&%=+<>|^`♪☆★♡♥→←↑↓]/g, "")
    .replace(/[ぁぃぅぇぉっ]/g, "");
}

// カタカナで照合する語用の正規化(NFKC と空白・長音だけ。ひらがなにしない)
const normalizeKata = (text) => String(text ?? "").normalize("NFKC").replace(/[\sー〜~・…]/g, "");

// 根拠の種類
const LIT = "文献", PUB = "公的", OWN = "本研究", TBD = "要確認";

// 種類(危機の応答の「〜が心配」に使う。docs/design-crisis-flow-shima3.md 12-1)
export const CATEGORY_BY_CHAPTER = { 2: "suicidal", 3: "suicidal", 4: "suicidal", 5: "selfharm", 6: "violence", 7: "sexual", 8: "bullying", 9: null };

// 1行 = 1つの語。
//   id      記録に残す名前(章-番号)
//   label   記録・テストの表示用の代表表記
//   stage   2 / 1
//   ch      表の章
//   ref     根拠の番号(表の末尾の文献番号)。今のリストから人の確認で残した語は "v2"
//   kind    根拠の種類(文献 / 公的 / 本研究 / 要確認)。複数あれば並べる
//   forms   照合する書き方(この形のまま normalizeV3 してから部分一致)
//   re      forms で書けないもの(normalizeV3 したあとの文に対する正規表現)
//   kata    カタカナのままで照合する書き方
//   passive true なら、誇張の除外(恥ずかしすぎて消えたい 等)をする前の文全体で照合する(v2 の受動パターンと同じ)
//   negAfter true なら、直後が「わけじゃない」等の否定のときは数えない(v2 の活用形と同じ)
const SELF = "(自分|じぶん|私|わたし|あたし|俺|おれ|僕|ぼく|うち)";
const ENTRIES = [
  // ---- 2 明示的な希死念慮(段階2)--------------------------------------------
  { id: "2-1", label: "死にたい", stage: 2, ch: 2, ref: "1-4", kind: [LIT],
    forms: ["死にたい", "しにたい", "死にてえ", "しにてえ", "死にたみ", "しにたみ", "死にたさ", "しにたさ"],
    re: /(死|し)にて$/ }, // 「しにてぇ」は小書きを除くと「しにて」になるので、発言の終わりのときだけ
  { id: "2-1b", label: "氏にたい・タヒにたい", stage: 2, ch: 2, ref: "", kind: [TBD], forms: ["氏にたい", "たひにたい"] },
  { id: "2-1c", label: "死にたくなる(活用形)", stage: 2, ch: 2, ref: "v2", kind: [LIT],
    re: /(死|し)にたく(なる|なり|なて|なた|なちゃ)/, negAfter: true }, // K3(促音を除くので「なった」は「なた」。「ない」には当てない)
  { id: "2-2", label: "死んでしまいたい", stage: 2, ch: 2, ref: "1-4", kind: [LIT],
    forms: ["死んでしまいたい", "しんでしまいたい", "死んでしまいてえ", "死んじゃいたい", "しんじゃいたい", "死んじまいたい"] },
  { id: "2-3", label: "死のうかな・死のうと", stage: 2, ch: 2, ref: "1", kind: [LIT],
    forms: ["死のうかな", "しのうかな", "死のかな", "死のうと", "しのうと"] },
  { id: "2-4", label: "消えたい", stage: 2, ch: 2, ref: "1,10", kind: [LIT, PUB], forms: ["消えたい", "きえたい", "消えたみ", "きえたみ"] },
  { id: "2-4b", label: "消えたくなる(活用形)", stage: 2, ch: 2, ref: "v2", kind: [LIT],
    re: /(消|き)えたく(なる|なり|なて|なた|なちゃ)/, negAfter: true }, // K4
  { id: "2-5", label: "消えちゃいたい", stage: 2, ch: 2, ref: "13", kind: [PUB], forms: ["消えちゃいたい", "きえちゃいたい"] },
  { id: "2-6", label: "消えてしまいたい", stage: 2, ch: 2, ref: "1", kind: [LIT],
    forms: ["消えてしまいたい", "きえてしまいたい", "消えてなくなりたい", "きえてなくなりたい", "消え去りたい", "きえさりたい"] },
  { id: "2-7", label: "いなくなりたい", stage: 2, ch: 2, ref: "1", kind: [LIT], forms: ["いなくなりたい"] },
  { id: "2-7b", label: "いなくなっちゃいたい", stage: 2, ch: 2, ref: "v2", kind: [LIT],
    forms: ["いなくなっちゃいたい", "いなくなってしまいたい"] }, // K5
  { id: "2-8", label: "自殺・自死", stage: 2, ch: 2, ref: "1-4", kind: [LIT], forms: ["自殺", "じさつ", "自死"] },
  { id: "2-9", label: "命を絶ちたい", stage: 2, ch: 2, ref: "1", kind: [LIT],
    forms: ["命を絶ちたい", "いのちをたちたい", "命を絶とう", "いのちをたとう"] },
  { id: "2-10", label: "生きていたくない", stage: 2, ch: 2, ref: "1", kind: [LIT],
    re: /生き(てい|て)?たくない|いきて(い)?たくない/ }, // 「いきたくない」(行きたくない)は入れない

  // ---- 3 受動的な希死念慮(段階2)--------------------------------------------
  { id: "3-1", label: "朝が来なければ", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true,
    re: /(朝|あさ)(が|なんか|なんて)?(来|こ)な(ければ|きゃ|くていい)/ }, // 人の確認で、v2 の「ずっと・毎日」の条件を外した
  { id: "3-2", label: "目が覚めなければ", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true,
    re: /(目|め)が(覚|さ)めな(ければ|きゃ)|(目覚|めざ)めな(ければ|きゃ)/ },
  { id: "3-2b", label: "眠ったまま・目が覚めなかったらいい", stage: 2, ch: 3, ref: "v2", kind: [LIT], passive: true,
    re: /(目|め)が(覚|さ)めなかったら(いい|楽|らく)|(起|お)きなかったら(いい|楽|らく)|このまま(ずと)?(眠|ねむ)たまま/ }, // K6
  { id: "3-3", label: "このまま起きなければ", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true,
    re: /このまま(起|お)きなければ/ }, // 「起きなければ」単独は「起きなければならない」に当たるので登録しない
  { id: "3-4", label: "生まれてこなければ", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true,
    re: /(生|産|う)まれて(こ|来)な(ければ|きゃ|かたら)|(生|産|う)まれて(き|来)たくなかた|(生|産|う)まれなければよかた/ },
  { id: "3-5", label: "死んだほうがまし", stage: 2, ch: 3, ref: "3,4", kind: [LIT], passive: true,
    re: /(死|し)んだ(方|ほう)が(まし|楽|らく|いい)/ },
  { id: "3-5b", label: "自分が消えた方が", stage: 2, ch: 3, ref: "v2", kind: [LIT], passive: true,
    re: new RegExp(`${SELF}(が|は|なんか|なんて)?(消|き)えた(方|ほう)が(いい|まし|楽|らく)`) }, // K9
  { id: "3-6", label: "死ねたら楽", stage: 2, ch: 3, ref: "1,2", kind: [LIT], passive: true,
    re: /(死|し)ねたら(楽|らく|いい)/ },
  { id: "3-6b", label: "死んだら楽", stage: 2, ch: 3, ref: "v2", kind: [LIT], passive: true, re: /(死|し)んだら(楽|らく)/ }, // K10
  { id: "3-7", label: "全部終わりにしたい", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true,
    re: /(全部|ぜんぶ)(終|お)わりにしたい/ },
  { id: "3-7b", label: "人生を終わらせたい", stage: 2, ch: 3, ref: "v2", kind: [LIT], passive: true,
    re: /(人生|じんせい)を?(終|お)わら(せたい|せよう)|(人生|じんせい)を?(終|お)わりにし(たい|よう)/ }, // K7
  { id: "3-8", label: "自分が存在しなければ", stage: 2, ch: 3, ref: "1", kind: [LIT], passive: true, // 表は「変更なし」なので v2 と同じく主語つき
    re: new RegExp(`${SELF}(が|は|の|なんか|なんて)?(存在|そんざい)(しなければ|しなかたら|を(消|け)し|が(消|き)え)`) }, // K8 を含む

  // ---- 4 負担感(段階2/1)------------------------------------------------------
  { id: "4-1", label: "自分がいない方が", stage: 2, ch: 4, ref: "2,5", kind: [LIT], passive: true,
    re: new RegExp(`${SELF}(が|は|なんか|なんて)?(い|居)な(い|くなた)(方|ほう)が`) },
  { id: "4-2", label: "いない方が楽(主語なし)", stage: 1, ch: 4, ref: "2,5", kind: [LIT], passive: true,
    re: /(い|居)ない(方|ほう)が(楽|らく|いい|まし|幸せ|しあわせ)/ },
  { id: "4-3", label: "自分がいなくなれば", stage: 2, ch: 4, ref: "2,5", kind: [LIT], passive: true, // 表は「変更なし」なので v2 と同じく主語つき
    re: new RegExp(`${SELF}(が|は|なんか|なんて)?いなくな(れば|た(方|ほう)が)[^。!?]{0,10}(楽|らく|いい|まし|幸せ|しあわせ|平和|へいわ|喜ぶ|よろこぶ|みんな|家族|かぞく)`) },
  { id: "4-4", label: "生きてるだけで迷惑", stage: 1, ch: 4, ref: "5", kind: [LIT],
    forms: ["生きてるだけで迷惑", "いきてるだけでめいわく", "迷惑しかかけてない", "めいわくしかかけてない"] },

  // ---- 5 自傷・過量服薬(段階2/1)-------------------------------------------
  { id: "5-1", label: "自傷", stage: 2, ch: 5, ref: "7,8", kind: [LIT], forms: ["自傷"] }, // 「じしょう」は「自称」になるので入れない
  { id: "5-2", label: "自分を傷つけ", stage: 2, ch: 5, ref: "3,4", kind: [LIT], forms: ["自分を傷つけ", "じぶんをきずつけ", "自分をきずつけ"] },
  { id: "5-3", label: "リストカット・リスカ", stage: 2, ch: 5, ref: "7", kind: [LIT], forms: ["リストカット", "りすとかっと"], kata: ["リスカ"] },
  { id: "5-4", label: "手首を切・自分を切", stage: 2, ch: 5, ref: "7,8", kind: [LIT], forms: ["手首を切", "てくびをき", "自分を切"] }, // 「じぶんをき」は「自分を気に」になるので入れない
  { id: "5-5", label: "腕を切", stage: 1, ch: 5, ref: "8", kind: [LIT], forms: ["腕を切"] }, // 「うでをき」は「腕を鍛える」になるので入れない
  { id: "5-6", label: "アムカ・レグカ", stage: 2, ch: 5, ref: "", kind: [TBD], kata: ["アムカ", "レグカ"] },
  { id: "5-7", label: "自分を殴", stage: 1, ch: 5, ref: "8", kind: [LIT], forms: ["自分を殴", "じぶんをなぐ"] },
  { id: "5-8", label: "オーバードーズ・OD", stage: 2, ch: 5, ref: "9,11,12", kind: [PUB, LIT],
    forms: ["オーバードーズ", "おーばーどーず", "オーバードース"], re: /(^|[^a-z])od([^a-z]|$)/ },
  { id: "5-9", label: "過量服薬", stage: 2, ch: 5, ref: "11,12", kind: [PUB, LIT],
    forms: ["過量服薬", "かりょうふくやく", "薬を大量に", "くすりをたいりょうに", "薬いっぱい飲", "くすりいっぱいの"] },

  // ---- 6 身体的暴力・虐待(段階2)--------------------------------------------
  { id: "6-1", label: "殴られ・叩かれ・蹴られ", stage: 2, ch: 6, ref: "14,15", kind: [PUB],
    forms: ["殴られ", "なぐられ", "叩かれ", "たたかれ", "蹴られ"] }, // 「けられ」は「見つけられた」になるので入れない
  { id: "6-2", label: "首を絞められ", stage: 2, ch: 6, ref: "14", kind: [PUB], forms: ["首を絞められ", "首を締められ", "くびをしめられ"] },
  { id: "6-3", label: "暴力", stage: 2, ch: 6, ref: "14", kind: [PUB], forms: ["暴力", "ぼうりょく"] },
  { id: "6-4", label: "虐待", stage: 2, ch: 6, ref: "v2", kind: [PUB], forms: ["虐待", "ぎゃくたい"] }, // K2
  { id: "6-5", label: "ご飯をもらえない(ネグレクト)", stage: 2, ch: 6, ref: "14", kind: [PUB],
    forms: ["ご飯をもらえない", "ごはんをもらえない", "食べさせてもらえない", "たべさせてもらえない", "家に入れてもらえない", "いえにいれてもらえない"] },
  // 「怒鳴られ」は v3 でキーワードから外した(分類器だけ)

  // ---- 7 性被害(段階2/1)------------------------------------------------------
  { id: "7-1", label: "体を触られ", stage: 2, ch: 7, ref: "14", kind: [PUB],
    forms: ["体を触られ", "からだをさわられ", "無理やり触られ", "むりやりさわられ", "胸を触られ", "むねをさわられ"] },
  { id: "7-2", label: "触られ(単独)", stage: 1, ch: 7, ref: "14", kind: [PUB], forms: ["触られ", "さわられ"] },
  { id: "7-3", label: "裸の写真・脱がされ", stage: 2, ch: 7, ref: "14", kind: [PUB],
    forms: ["裸の写真", "はだかのしゃしん", "裸を撮られ", "はだかをとられ", "下着の写真", "したぎのしゃしん", "脱がさ", "ぬがされ"] },
  { id: "7-4", label: "性的(単独)", stage: 1, ch: 7, ref: "14", kind: [PUB], forms: ["性的"] },

  // ---- 8 重大ないじめ(段階2/1)---------------------------------------------
  { id: "8-1", label: "カツアゲ・お金を取られ", stage: 2, ch: 8, ref: "15,16", kind: [PUB],
    forms: ["お金を取られ", "おかねをとられ", "金を取られ", "お金をたかられ", "おかねをたかられ", "金をたかられ"], kata: ["カツアゲ"] },
  { id: "8-2", label: "脅され・恐喝", stage: 2, ch: 8, ref: "15", kind: [PUB], forms: ["脅され", "おどされ", "恐喝", "きょうかつ"] },
  { id: "8-3", label: "晒され", stage: 2, ch: 8, ref: "15", kind: [PUB], forms: ["晒され", "さらされ"] },
  { id: "8-4", label: "無視され続け", stage: 1, ch: 8, ref: "15", kind: [PUB], forms: ["無視され続け", "むしされつづけ"] },

  // ---- 9 絶望感・孤立(段階1)--------------------------------------------------
  { id: "9-1", label: "もう無理・限界", stage: 1, ch: 9, ref: "6", kind: [LIT], forms: ["もう無理", "もうむり", "限界", "げんかい"] },
  { id: "9-2", label: "生きてる意味がない", stage: 1, ch: 9, ref: "6", kind: [LIT],
    re: /(生|い)き(てる|ている|る)(意味|いみ)(が|も|なんて|なんか)?(ない|なく|無)/ }, // K11: 「生きてる意味」単独は登録しない
  { id: "9-3", label: "何のために生きて", stage: 1, ch: 9, ref: "6", kind: [LIT], forms: ["何のために生きて", "なんのためにいきて", "何のためにいきて"] },
  { id: "9-4", label: "楽になりたい", stage: 1, ch: 9, ref: "6", kind: [LIT], forms: ["楽になりたい", "らくになりたい"] },
  { id: "9-5", label: "終わりにしたい", stage: 1, ch: 9, ref: "", kind: [OWN], forms: ["終わりにしたい", "おわりにしたい"] },
  { id: "9-6", label: "助けて", stage: 1, ch: 9, ref: "9", kind: [PUB], forms: ["助けて", "たすけて"] },
  { id: "9-6b", label: "誰も助けて", stage: 2, ch: 9, ref: "v2", kind: [PUB], forms: ["誰も助けて", "だれもたすけて"] }, // K1(段階2のまま残す)
  { id: "9-7", label: "誰も必要としてない", stage: 1, ch: 9, ref: "5", kind: [LIT],
    forms: ["誰も必要としてない", "だれもひつようとしてない", "必要とされてない", "ひつようとされてない"] },
].map((e) => ({ ...e, normForms: (e.forms ?? []).map(normalizeV3), category: CATEGORY_BY_CHAPTER[e.ch] ?? null }));

export const KEYWORDS_V3 = ENTRIES;

// 直後がこの形なら数えない(「死にたくなるわけじゃない」。v2 の NEGATION_AFTER と同じ。正規化後の文に対して)
const NEGATION_AFTER = /^((わけ|訳)(じゃ|では|でも)|とかじゃ)/;

function entryHits(entry, norm, kata) {
  if (entry.kata?.some((w) => kata.includes(w))) return true;
  if (entry.normForms.some((f) => norm.includes(f))) return true;
  if (!entry.re) return false;
  const re = new RegExp(entry.re.source, entry.re.flags.includes("g") ? entry.re.flags : entry.re.flags + "g");
  for (const m of norm.matchAll(re)) {
    if (!entry.negAfter || !NEGATION_AFTER.test(norm.slice(m.index + m[0].length))) return true;
  }
  return false;
}

// v3 の照合をまとめて行う。戻り値は crisisRulesV2 と同じ形に、次を足したもの。
//   keywords / patterns  段階2の語(passive でないもの / passive のもの)の id。1件でもあれば段階2
//   floor                段階1の語の id(少なくとも段階1)
//   hits                 当たった語の詳しい情報(id・label・stage・ch・category・ref・kind・provisional)
export function crisisRulesV3(text) {
  const { text: classifierText, idioms } = paraphraseShameIdioms(text);
  // 誇張の除外: 慣用表現を除いた文で照合する(passive の語だけは、v2 と同じく元の文全体で照合する)
  const withoutIdioms = idioms.length ? String(text).replace(SHAME_IDIOM_PATTERN, "／") : String(text);
  const normCut = normalizeV3(withoutIdioms), kataCut = normalizeKata(withoutIdioms);
  const normAll = normalizeV3(text), kataAll = normalizeKata(text);
  const hits = ENTRIES.filter((e) => (e.passive ? entryHits(e, normAll, kataAll) : entryHits(e, normCut, kataCut)));
  // 「全部終わりにしたい」(段階2)に当たったら、同じ発言の「終わりにしたい」(段階1)は記録から外す
  const ids = new Set(hits.map((e) => e.id));
  const shown = hits.filter((e) => !(e.id === "9-5" && ids.has("3-7")) && !(e.id === "9-6" && ids.has("9-6b"))
    && !(e.id === "7-2" && ids.has("7-1")));
  return {
    keywords: shown.filter((e) => e.stage === 2 && !e.passive).map((e) => e.id),
    patterns: shown.filter((e) => e.stage === 2 && e.passive).map((e) => e.id),
    floor: shown.filter((e) => e.stage === 1).map((e) => e.id),
    hits: shown.map(({ id, label, stage, ch, category, ref, kind }) => ({ id, label, stage, ch, category, ref, kind, provisional: kind.includes(TBD) })),
    idiomExempted: idioms,
    classifierText,
  };
}

// 当たった語から、危機の種類を1つ選ぶ(docs/design-crisis-flow-shima3.md 12-1)。
// 段階2の語を優先し、2つ以上の種類に当たったら 希死念慮 > 自傷 > 性被害 > 暴力・虐待 > いじめ。どれにも当たらなければ null(種類不明)
export const CATEGORY_PRIORITY = ["suicidal", "selfharm", "sexual", "violence", "bullying"];
export function crisisCategoryOf(hits) {
  const list = hits ?? [];
  for (const stage of [2, 1]) {
    const cats = new Set(list.filter((h) => h.stage === stage && h.category).map((h) => h.category));
    const found = CATEGORY_PRIORITY.find((c) => cats.has(c));
    if (found) return found;
  }
  return null;
}

// ============================================================================
//  否定のキーワード(表の11章)
//   A 生きたい気持ちの表明(11-4)/ B 冗談・取り消し(11-5)。どちらも「明示的な否定」
//   C 最小化・引き下がり(11-6)は分類器(judgeWithdrawal)で見つけるので、ここには無い
//  念押し(否定の語の直後の「じゃない」「ではない」「じゃねえ」「抜きで」)は否定に数えない。
//  「本気」「本当に」「マジで」はそもそも否定の語ではないので数えない。
// ============================================================================
const NEGATION_ENTRIES = [
  { id: "A-1", type: "A", label: "死にたくない", forms: ["死にたくない", "しにたくない", "死にたくはない", "しにたくはない", "死にたくねえ", "しにたくねえ"] },
  { id: "A-2", type: "A", label: "消えたくない", forms: ["消えたくない", "きえたくない"] },
  // 「いきたい」(行きたい)はかなでは入れない
  { id: "A-3", type: "A", label: "生きたい", forms: ["生きたい", "生きていたい", "生きてたい", "いきていたい", "いきてたい"] },
  { id: "A-4", type: "A", label: "死ぬのはこわい", forms: ["死ぬのはこわい", "死ぬのは怖い", "死ぬの怖い", "死ぬのこわい", "しぬのはこわい", "しぬのこわい"], provisional: true },
  { id: "B-1", type: "B", label: "冗談", forms: ["冗談", "じょうだん", "じょーだん"] },
  // 「うそ」「ねた」はかなでは別の言葉(ほうそう・ねたい)にまぎれるので、語尾つき・単独のときだけ(下の re)
  { id: "B-2", type: "B", label: "嘘", forms: ["嘘"], kata: ["ウソ"], re: /(^|[^ぁ-ん])うそ(だよ|だ|です|だから|うそ|w|笑|$)/ },
  { id: "B-3", type: "B", label: "ネタ", kata: ["ネタ"], re: /(^|[^ぁ-ん])ねた(だよ|だ|です|だから|w|笑|$)/ },
  { id: "B-4", type: "B", label: "本気じゃない", forms: ["本気じゃない", "ほんきじゃない", "本心じゃない", "ほんしんじゃない"] },
  { id: "B-5", type: "B", label: "大げさに言っただけ・盛った", forms: ["大げさに言っただけ", "おおげさにいっただけ", "大袈裟に言っただけ", "盛った"] }, // 「もった」(持った)はかなでは入れない
  { id: "B-6", type: "B", label: "今のなし", forms: ["今のなし", "いまのなし", "なかったことに"] },
].map((e) => ({ ...e, normForms: (e.forms ?? []).map(normalizeV3) }));

export const NEGATION_KEYWORDS = NEGATION_ENTRIES;

// 念押しの後ろ(正規化後)。「冗談じゃない」「うそじゃねえ」「冗談とかじゃなくて」「冗談抜きで」「死にたくないわけじゃない」
const REAFFIRM_AFTER = /^((とか)?(じゃな|ではな|じゃね|でわな|ぬき|抜き)|な?(わけ|訳)(じゃ|では|でも))/;

// 発言の中の否定の語を探す。戻り値 { type: "A" | "B" | null, words: [代表表記…], ids: [...] }。
// A と B の両方があれば A(応答の形が違うため。docs/design-crisis-flow-shima3.md 2章)
export function matchNegation(text) {
  const norm = normalizeV3(text), kata = normalizeKata(text);
  const found = [];
  for (const e of NEGATION_ENTRIES) {
    let hit = false;
    for (const f of e.normForms) {
      let i = norm.indexOf(f);
      while (i >= 0 && !hit) {
        // 「本気じゃない」は語そのものに「じゃない」を含むので、念押しの判定は語の後ろだけで行う
        if (!REAFFIRM_AFTER.test(norm.slice(i + f.length))) hit = true;
        i = norm.indexOf(f, i + 1);
      }
      if (hit) break;
    }
    if (!hit && e.kata) {
      for (const w of e.kata) {
        let i = kata.indexOf(w);
        while (i >= 0 && !hit) {
          if (!REAFFIRM_AFTER.test(normalizeV3(kata.slice(i + w.length)))) hit = true;
          i = kata.indexOf(w, i + 1);
        }
      }
    }
    if (!hit && e.re) {
      const re = new RegExp(e.re.source, "g");
      for (const m of norm.matchAll(re)) {
        if (!REAFFIRM_AFTER.test(norm.slice(m.index + m[0].length))) { hit = true; break; }
      }
    }
    if (hit) found.push(e);
  }
  const type = found.some((e) => e.type === "A") ? "A" : found.length ? "B" : null;
  return { type, words: found.map((e) => e.label), ids: found.map((e) => e.id) };
}
