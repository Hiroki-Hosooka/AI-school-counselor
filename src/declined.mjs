// ============================================================================
//  本人が断った相手を覚える(2026年10月14日。docs/prompts/fix-after-shima4.md 1-3・docs/design-shima4-part1-topscreen.md 1-3)
//
//  相談ログ 86130eef で、12ターン目に「先生とは話したくない」と書いたのに、16ターン目の固定の文に「学校の先生にも」が入っていた。
//  断った相手(先生・親・カウンセラー・保健室)は、その会話のあいだ、固定の文でも生成でも勧めない。
//
//  見つけ方はコードの照合が主(同じ節に「相手の語」と「断りの語」があるとき)。照合で拾えなかったものは、3通目への答えの判定
//  (src/crisis-response.mjs の judgeTeacherAnswer)が返す「断った相手」を推定として足す(記録の印で区別する)。
//  DB の列は足さない。会話の記録(相談者の発言と、AI の行の flags の印)から毎ターン数え直す。
//  本人が自分から「先生なら話せるかも」のように書いたら、その相手は外す。
//  このファイルは何も読み込まない(crisis-texts.mjs から読み込むため)。
// ============================================================================

export const PEOPLE = ["teacher", "parent", "counselor", "nurse"];
export const PEOPLE_LABELS = { teacher: "先生", parent: "親・おうちの人", counselor: "カウンセラー", nurse: "保健室" };

// 相手の語。順番に意味がある(「カウンセラーの先生」「保健室の先生」を先生として数えないよう、先に外す)
const PERSON_RE = {
  counselor: /スクールカウンセラー|カウンセラー|かうんせらー|ＳＣ|\bSC\b/i,
  nurse: /保健室|ほけんしつ|養護/,
  parent: /親|おや|お?母さん|お?かあさん|お?父さん|お?とうさん|母|父|ママ|パパ|家族|家の人|おうちの人|うちの人|家の大人/,
  teacher: /先生|せんせい|せんせ|担任|たんにん|教師/,
};
const COUNSELOR_TEACHER_RE = /(カウンセラー|かうんせらー|保健室|ほけんしつ|養護)の?(先生|せんせい|せんせ)/g;

// 断りの語(話すこと・頼ることを断る言い方に限る。「先生に怒られるのが嫌」のような、話すこと以外の「嫌」は数えない)
const DECLINE_RE = new RegExp([
  "話したくな", "はなしたくな", "言いたくな", "いいたくな", "話せな", "はなせな", "言えな", "いえな",
  "相談したくな", "相談できな", "相談しにく", "知られたくな", "しられたくな", "バレたくな", "ばれたくな",
  "信用できな", "信用してな", "信頼できな", "頼りたくな", "頼れな", "たよれな", "話す気(に)?ならな", "話しにく", "言いにく",
  "(話す|言う|相談する)の(は|が)?(無理|むり|いや|嫌|やだ|こわ|怖)",
].join("|"));
// 「先生は無理」「親とか絶対いや」のような、相手そのものを断る短い言い方
const PERSON_NO_RE = /(は|には|とは|とか|も|なんて|なんか)(絶対|ぜったい|ちょっと)?(無理|むり|いや|嫌|やだ|ない)/;
// 本人が自分から前向きに書いた(その相手は断りから外す)
const POSITIVE_RE = /(話してみ|はなしてみ|話せるかも|話せそう|話そうかな|相談してみ|言ってみ|話してもいい|頼ってみ|なら話せ|なら言え)/;

// 節に分ける(「親には話せないけど先生なら話せるかも」を、2つの節として見る)
const clausesOf = (t) => String(t ?? "").split(/[。！？!?\n]|けど|けれど|でも|だけど|が、/).map((x) => x.trim()).filter(Boolean);

export function peopleIn(clause) {
  const c = String(clause ?? "");
  const withoutTeacherCompounds = c.replace(COUNSELOR_TEACHER_RE, (m) => m.replace(/(先生|せんせい|せんせ)$/, ""));
  return PEOPLE.filter((p) => PERSON_RE[p].test(p === "teacher" ? withoutTeacherCompounds : c));
}

// 1つの発言から、断った相手・前向きになった相手を読む
export function declineChangesIn(text) {
  const add = new Set();
  const remove = new Set();
  for (const clause of clausesOf(text)) {
    const people = peopleIn(clause);
    if (!people.length) continue;
    if (POSITIVE_RE.test(clause) && !DECLINE_RE.test(clause)) people.forEach((p) => { remove.add(p); add.delete(p); });
    else if (DECLINE_RE.test(clause) || PERSON_NO_RE.test(clause)) people.forEach((p) => { add.add(p); remove.delete(p); });
  }
  return { add: [...add], remove: [...remove] };
}

// AI の行の flags に残す推定の印(judgeTeacherAnswer の結果)
export const DECLINED_ESTIMATE_FLAG = "記録のみ:断った相手(推定)";
export const declinedEstimateFlag = (people) => `${DECLINED_ESTIMATE_FLAG}: ${people.join(",")}`;

// 会話の記録(古い順)から、いま断っている相手を求める。hist の行: role・body・flags
export function declinedPeopleFrom(hist) {
  const declined = new Set();
  for (const m of hist ?? []) {
    if (m?.role === "user") {
      // チップのラベル(本人の言葉ではない)は数えない
      if (m.choice_id) continue;
      const { add, remove } = declineChangesIn(m.body);
      add.forEach((p) => declined.add(p));
      remove.forEach((p) => declined.delete(p));
    } else if (Array.isArray(m?.flags)) {
      for (const f of m.flags) {
        if (typeof f !== "string" || !f.startsWith(DECLINED_ESTIMATE_FLAG)) continue;
        f.slice(DECLINED_ESTIMATE_FLAG.length).replace(/^[:：]\s*/, "").split(",")
          .filter((p) => PEOPLE.includes(p)).forEach((p) => declined.add(p));
      }
    }
  }
  return PEOPLE.filter((p) => declined.has(p));
}

// 生成に足す指示
export function declinedBlock(declined) {
  if (!declined?.length) return "";
  const names = declined.map((p) => PEOPLE_LABELS[p]).join("・");
  return `

# 相談者が断った相手(重要)
相談者は、${names}には話したくない(頼れない)と言っています。
・${names}に話すこと・相談することを勧めない。「${names}に〜してみたら」のような言い方をしない
・断ったこと自体は否定しない・説得しない。ほかの相手(画面の下の窓口など)は、相談者が嫌がらない範囲で一言添えてよい`;
}

// 生成の出力チェック(断った相手を勧める言い方)。当たったら作り直す
const RECOMMEND_TAIL = "[^。！？\\n]{0,10}(話して|話してみ|相談|伝えて|伝えてみ|言って|言ってみ|頼って|頼ってみ|見せて)";
const PERSON_NG_SOURCE = {
  teacher: "(?<!カウンセラーの|保健室の)(先生|担任)(に|と|へ|には|とも|にも)",
  parent: "(親|おうちの人|家の人|お母さん|お父さん|家族)(に|と|へ|には|とも|にも)",
  counselor: "(カウンセラー)(の先生)?(に|と|へ|には|とも|にも)",
  nurse: "(保健室)(の先生)?(に|で|へ|には|にも)",
};
export function declinedNg(declined) {
  return (declined ?? []).filter((p) => PERSON_NG_SOURCE[p]).map((p) => new RegExp(PERSON_NG_SOURCE[p] + RECOMMEND_TAIL));
}
