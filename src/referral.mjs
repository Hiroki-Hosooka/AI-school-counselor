// ============================================================================
//  「人につなぐ必要がある」印(2026年11月9日。人の案。設計 docs/design-referral-flag.md。数値・文面はすべて仮・心理士の確認待ち)
//
//  危機(段階2)とは別の印。緊急性ではなく「人の支援につないだ方がよい状態か」を表す。診断ではない(病名を出さない)。
//  設定 REFERRAL_FLAG=on のときだけ動く(既定は無効。人が決めた)。
//
//  仕組み:
//  1. 判定(judgeReferralCues): 本人が書いたターンごとに、軽いモデルで「手がかり」と「段階の合図」を抜き出す。
//     手がかりごとに、今の発言から一字一句そのまま抜き出した根拠の引用を求め、引用が今の発言に無い手がかりは捨てる。
//  2. 点数(referralState): 会話の中の全部のターンの手がかりを合わせて数える(同じ領域は何度出ても1点)。
//     印は、合計4点以上かつ領域1つ以上かつ程度1つ以上、または「それだけで付く手がかり」。一度付いたら会話のあいだ残る。
//  3. 段階(4-2): 気づく → 思い浮かぶ → 決まる → 話す。本人の言葉の引用があるときだけ進める(AI の思い込みで進めない)。
//  4. 指示(referralBlock): 印が付いた会話で、そのターンの生成に足す。危機の流れ(本人の危機・危機のあと)のときは足さない(危機が先)。
//  ここは DB にも画面にも触れない(テストで確かめられる部分)。route.ts が判定を呼び、記録し、指示を渡す。
// ============================================================================
import { callGemini, parseJSON, LITE_MODELS } from "./classify.mjs";
import { normalizeV3 } from "./crisis-keywords-v3.mjs";

export const referralEnabled = (env = process.env) => env.REFERRAL_FLAG === "on";

// ---- 手がかりの種類(案の1章・2-2章) ----
// 領域(1-1): 同じ領域は何度出ても1点
export const REFERRAL_DOMAINS = Object.freeze({
  A: "気分・意欲", B: "眠り・食事", C: "不安・緊張", D: "現実感・ぼんやり", E: "自分への見方", F: "体の不調",
});
// 程度(1-2)
export const REFERRAL_DEGREE_POINTS = Object.freeze({ impact: 2, duration: 1, distress: 1, worsening: 1 });
// 支え(1-3)。denial(打ち消し・強がり)は2つ以上のターンでくり返されたときだけ1点
export const REFERRAL_SUPPORT_POINTS = Object.freeze({ no_support: 1, denial: 1 });
// それだけで付く手がかり(2-2)
export const REFERRAL_STANDALONE = Object.freeze({
  eating: "食べることへの強いこだわり・食べたあとに吐く・何日も食べていない",
  med_overuse: "市販薬などの使いすぎ(危機の打ち明けに当たらないもの)",
  school_absence: "学校に行けない状態が続いている",
});
export const REFERRAL_THRESHOLD = 4;
const CUE_KINDS = [...Object.keys(REFERRAL_DOMAINS), ...Object.keys(REFERRAL_DEGREE_POINTS), ...Object.keys(REFERRAL_SUPPORT_POINTS),
  ...Object.keys(REFERRAL_STANDALONE), "short_term"];
// 段階の合図(4-2)。declined = 今は相談したくない(人に話すことを断った)
export const REFERRAL_STAGES = Object.freeze({ 0: "まだ", 1: "気づく", 2: "思い浮かぶ", 3: "決まる", 4: "話す" });
const STAGE_SIGNALS = { aware: 1, person: 2, plan: 3, talked: 4 };

// ---- 判定(軽いモデル。思考の上限つき: 危機の判定ではないため。案の頻度は「本人が書いたターンだけ毎回」) ----
const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    cues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: CUE_KINDS },
          evidence: { type: "STRING" },
          about: { type: "STRING", enum: ["self", "other"] },
          temporary: { type: "BOOLEAN" },
        },
        required: ["kind", "evidence", "about", "temporary"],
      },
    },
    stage_signal: { type: "STRING", enum: ["none", "aware", "person", "plan", "talked", "declined"] },
    stage_evidence: { type: "STRING" },
  },
  required: ["cues", "stage_signal", "stage_evidence"],
};

export const REFERRAL_JUDGE_PROMPT = `あなたは、学校の相談AIの記録係です。中高生の【今回の発言】から、決まった「手がかり」だけを抜き出します。
診断はしません。病名は書きません。迷ったら抜き出しません(書いていないことを推測で足さない)。

手がかり(kind):
- A 気分・意欲: 気分が沈む、楽しめない、興味がわかない、疲れが取れない、気力が出ない
- B 眠り・食事: 眠れない、何度も目が覚める、寝すぎる、食欲がない、食べすぎる
- C 不安・緊張: 不安が止まらない、落ち着かない、急に息が苦しくなる、こわさが続く
- D 現実感・ぼんやり: 現実感がない、自分を外から見ている感じ、時間が抜け落ちる、ずっとぼーっとする
- E 自分への見方: 自分はだめだ、迷惑をかけている、価値がない
- F 体の不調: 頭痛・腹痛・吐き気が続く、朝起きられない
- impact 生活への影響: 学校に行けない日が続く、食事・水分・入浴ができない、勉強や部活が手につかない
- duration 2週間くらい以上続いている: 「ここ2週間」「先月から」「ずっと」
- distress つらさがとても強い: 「限界に近い」「もう耐えられない」
- worsening 悪くなってきている: 「前より」「どんどん」
- no_support 相談できる人がいない、いても話せていない
- denial 打ち消し・強がり: 「大丈夫」「平気」「なんでもない」(つらさを書いたあとで打ち消す)
- eating 食べることへの強いこだわり、食べたあとに吐く、何日も食べていない
- med_overuse 眠るためなどに市販薬・薬を多めに飲んでいる
- school_absence 学校に行けない状態が長く続いている(「1か月行けてない」)
- short_term 一時的で短いと本人が言っている(「テスト前だから」「終われば戻る」)

決まり:
- evidence には、【今回の発言】から一字一句そのまま抜き出した短い部分を書く。【今回の発言】に無い言葉は書かない(文脈から抜き出さない)
- 友達・家族など、本人以外のことは about=other にする
- 誇張や冗談(「テストやばすぎて死ぬ」「眠すぎて無理笑」)は抜き出さない
- 一時的で短いと本人が言っている手がかりは temporary=true にし、short_term も出す
- 同じ手がかりは1つだけ。ただし、1つの言葉が複数の手がかりに当たるときは、当たるものを全部出す
  (例:「もう1か月学校に行けてない」→ school_absence と impact と duration。「2週間眠れない」→ B と duration)

段階の合図(stage_signal。人に相談することについて、本人の【今回の発言】に表れたもの。無ければ none):
- aware: 「大丈夫じゃないかも」のように、自分の状態がよくないと本人が言葉にした
- person: 話せそうな人を本人が挙げた(「母になら」「保健室の先生なら話せるかも」)
- plan: 誰に・いつ・どう切り出すかを本人が決めた(「明日の放課後、保健室に行ってみる」)
- talked: 実際に人に話したと本人が言った
- declined: 今は人に相談したくないと本人が言った
stage_evidence には、その根拠を【今回の発言】から一字一句そのまま抜き出す(none なら空文字)。

【直前のやりとり】は、指示語や省略を読むためだけに使う。手がかりは【今回の発言】からだけ抜き出す。
JSONだけを返す。`;

// 引用が今の発言にあるか(記号・空白・表記ゆれをそろえて比べる。危機の引用の確かめと同じそろえ方)
export function evidenceInText(evidence, text) {
  const ev = normalizeV3(String(evidence ?? ""));
  const body = normalizeV3(String(text ?? ""));
  return ev.length >= 2 && body.includes(ev);
}

// 判定の出力を確かめて、記録する形にそろえる(引用が無い・本人以外・知らない種類は捨てる)
export function cleanReferralJudgment(parsed, text) {
  const seen = new Set();
  const cues = [];
  const dropped = [];
  for (const c of Array.isArray(parsed?.cues) ? parsed.cues : []) {
    const kind = String(c?.kind ?? "");
    if (!CUE_KINDS.includes(kind)) { dropped.push({ kind, why: "unknown" }); continue; }
    if (c?.about === "other") { dropped.push({ kind, why: "other" }); continue; }
    if (!evidenceInText(c?.evidence, text)) { dropped.push({ kind, why: "no_evidence" }); continue; }
    if (seen.has(kind)) continue;
    seen.add(kind);
    cues.push({ kind, evidence: String(c.evidence).slice(0, 80), temporary: c?.temporary === true });
  }
  let stage = String(parsed?.stage_signal ?? "none");
  if (!["aware", "person", "plan", "talked", "declined"].includes(stage) || !evidenceInText(parsed?.stage_evidence, text)) stage = "none";
  return { cues, stage, stage_evidence: stage === "none" ? "" : String(parsed.stage_evidence).slice(0, 80), dropped };
}

export async function judgeReferralCues(text, recentMessages = [], { thinkingBudget = 128 } = {}) {
  const context = (recentMessages ?? []).slice(-4)
    .map((m) => `${m.role === "ai" ? "AI" : "相談者"}: ${String(m.text ?? m.body ?? "").slice(0, 300)}`).join("\n");
  const input = `${context ? `【直前のやりとり】\n${context}\n\n` : ""}【今回の発言】\n${text}`;
  const started = Date.now();
  try {
    const r = await callGemini(LITE_MODELS, REFERRAL_JUDGE_PROMPT, [{ role: "user", parts: [{ text: input }] }], 1024, thinkingBudget,
      { responseSchema: JUDGE_SCHEMA, timeoutMs: 5000 });
    return { ok: true, ...cleanReferralJudgment(parseJSON(r.text), text), model: r.model, ms: Date.now() - started };
  } catch (e) {
    // 失敗しても会話は止めない(印の判定はそのターンだけ無し)
    return { ok: false, cues: [], stage: "none", stage_evidence: "", dropped: [], error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - started };
  }
}

// ---- 点数と段階(会話全体) ----
// records: その会話の本人の発言ごとの判定の記録(古い順)。{ cues, stage, watch }
// opts.distressLevel: インテークで本人が選んだつらさ(4・5 なら程度の「つらさ」を1点)
/** @param {any[]} records @param {{ distressLevel?: number | null }} [opts] */
export function referralState(records, { distressLevel = null } = {}) {
  const list = (records ?? []).filter(Boolean);
  const domains = new Set();
  const degree = new Set();
  let noSupport = false;
  let denialTurns = 0;
  const standalone = new Set();
  let watchSeen = false;
  let flaggedAt = -1;
  let startStage = 0;
  let reached = 0;
  let declined = false;
  const evaluate = () => {
    const degreeScore = [...degree].reduce((s, k) => s + (REFERRAL_DEGREE_POINTS[k] ?? 0), 0);
    const supportScore = (noSupport ? 1 : 0) + (denialTurns >= 2 ? 1 : 0);
    const total = domains.size + degreeScore + supportScore;
    const stand = [...standalone, ...(watchSeen && noSupport ? ["watch_no_support"] : [])];
    const flagged = stand.length > 0 || (total >= REFERRAL_THRESHOLD && domains.size >= 1 && degreeScore >= 1);
    return { total, domains: [...domains].sort(), degree: [...degree], degreeScore, supportScore, noSupport, denialTurns, standalone: stand, flagged };
  };
  if (distressLevel != null && Number(distressLevel) >= 4) degree.add("distress");
  for (const [i, r] of list.entries()) {
    const cues = Array.isArray(r.cues) ? r.cues : [];
    // 一時的で短いと本人が言ったターンは、そのターンの領域と期間の手がかりを数えない(2-3)
    const shortTerm = cues.some((c) => c.kind === "short_term");
    for (const c of cues) {
      if (c.temporary) continue;
      if (REFERRAL_DOMAINS[c.kind]) { if (!shortTerm) domains.add(c.kind); }
      else if (REFERRAL_DEGREE_POINTS[c.kind]) { if (!(shortTerm && c.kind === "duration")) degree.add(c.kind); }
      else if (c.kind === "no_support") noSupport = true;
      else if (REFERRAL_STANDALONE[c.kind]) standalone.add(c.kind);
    }
    if (cues.some((c) => c.kind === "denial")) denialTurns++;
    if (r.watch) watchSeen = true;
    if (r.stage === "declined") declined = true;
    else if (STAGE_SIGNALS[r.stage]) reached = Math.max(reached, STAGE_SIGNALS[r.stage]);
    if (flaggedAt < 0 && evaluate().flagged) { flaggedAt = i; startStage = reached; }
  }
  const now = evaluate();
  return {
    ...now,
    flaggedAt,                         // 印が付いたのは何ターン目の発言か(0から。付いていなければ -1)
    turnsSinceFlag: flaggedAt < 0 ? -1 : list.length - 1 - flaggedAt,
    startStage: flaggedAt < 0 ? null : startStage,
    stage: reached,
    declined,
  };
}

// 管理画面・記録に残す形(AI の返事の行の messages.referral)
export const referralSummary = (st) => ({
  flagged: st.flagged, total: st.total, domains: st.domains, degree: st.degree, support: st.supportScore,
  standalone: st.standalone, start_stage: st.startStage, stage: st.stage, declined: st.declined, turns_since_flag: st.turnsSinceFlag,
});
export const referralFlagText = (st) => `記録のみ:人につなぐ印(${st.total}点・領域 ${st.domains.join("") || "なし"}・`
  + `程度 ${st.degree.join(",") || "なし"}${st.standalone.length ? `・それだけで付く ${st.standalone.join(",")}` : ""}・段階 ${st.startStage}→${st.stage}${st.declined ? "・断った" : ""})`;

// ---- 印が付いた会話の指示(仮。4章) ----
export const REFERRAL_BLOCK_PROVISIONAL = {
  common: `# 人につなぐことを、心にとめておく(この会話のゴール。相談者には言葉で示さない)
この相談者は、人の支援につないだ方がよい様子がある。この会話では「身近な人やスクールカウンセラーなどに相談できるようになること」を、
AIが心の中で向かう先として持つ。ただし:
・相談者がはじめに話してくれたゴール(吐き出したい・整理したい など)を優先する。話を十分に聞いてから、人につなぐ方へ進む(早すぎると突き放された感じになる)
・1つの返事で、人につなぐ話を2歩以上進めない(気づいた直後に「じゃあ誰に話す?」と畳みかけない)。毎回この話をしない
・病名を出さない。診断しない。「心の病気かも」のように言わない
・危機のときの言い方や、窓口の名前・電話番号は書かない(画面の下にいつも出ている)
・人に話すことを押しつけない。決めるのは相談者`,
  listen: "・いまは、まず聞くとき。人につなぐ話はまだしない。",
  declined: "・相談者は、今は人に相談したくないと言った。「今は相談したくないんだね」と受け止め、この会話では人に相談することを勧めない。扉は開けたままにする。",
  stage: {
    1: "・次の一歩(気づく): 強がりの奥に、そっと触れる。相談者が書いた具体的なことを挙げて、心配していることを伝える(例:「〜って書いてくれたの、少し心配してる」)。",
    2: "・次の一歩(思い浮かぶ): 話せそうな人がいるかを、一度だけ確かめる。いなければ、保健室の先生やスクールカウンセラーを候補として示してよい。",
    3: "・次の一歩(決まる): 誰に・いつ・どう切り出すかを、一緒に考える。「この画面を見せるだけでも伝わるよ」と伝えてよい。",
    4: "・相談者はもう人に話せている。そのことを支える。新しく勧めない。",
  },
};

// stage: これまでに進んだ段階(0〜4)。declinedPeople: 本人が断った相手(src/declined.mjs。勧めない)
/** @param {any} st @param {{ declinedPeople?: string[], listenTurns?: number }} [opts] */
export function referralBlock(st, { declinedPeople = [], listenTurns = 1 } = {}) {
  if (!st?.flagged) return "";
  const lines = [REFERRAL_BLOCK_PROVISIONAL.common];
  if (st.declined) lines.push(REFERRAL_BLOCK_PROVISIONAL.declined);
  else if (st.turnsSinceFlag < listenTurns) lines.push(REFERRAL_BLOCK_PROVISIONAL.listen);
  else lines.push(REFERRAL_BLOCK_PROVISIONAL.stage[Math.min(st.stage + 1, 4)]);
  if (declinedPeople.length) lines.push(`・相談者が断った相手(${declinedPeople.join("・")})は、候補に挙げない。`);
  return "\n\n" + lines.join("\n");
}

// 研究の指標(4-5): 印が付いた会話のうち、段階を1つ以上進めた割合・段階2/3まで進んだ割合
export function referralMetrics(summaries) {
  const flagged = (summaries ?? []).filter((s) => s?.flagged);
  const n = flagged.length;
  const adv = flagged.filter((s) => (s.stage ?? 0) > (s.start_stage ?? 0)).length;
  const s2 = flagged.filter((s) => (s.stage ?? 0) >= 2).length;
  const s3 = flagged.filter((s) => (s.stage ?? 0) >= 3).length;
  const rate = (k) => (n ? Math.round((k / n) * 100) / 100 : null);
  return { flagged: n, advanced: adv, reached2: s2, reached3: s3, advanced_rate: rate(adv), reached2_rate: rate(s2), reached3_rate: rate(s3) };
}
