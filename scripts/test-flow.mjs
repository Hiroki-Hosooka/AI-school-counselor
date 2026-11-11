// ============================================================================
//  会話の流れ(src/flow.mjs)のオフラインテスト(会話が展開しない問題・他人事感の修正。2026年10月11日)
//
//  実行: node scripts/test-flow.mjs(npm run test:flow でも同じ)。API・DB は使わない。
//  相談ログ 16f362dd(docs/review-logs/2026-10-11-16f362dd.md)を読み、作り直しの対象が人の確認した 8・11・12 ターンに
//  なること、インテークの 1〜6 ターンが当たらないこと、記録のみの印を確かめる。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { echoOf, echoRate,
  flowStats, flowCheck, finalizeFlow, buildFlowBlock, genericGroupsIn, endingClass, isValidSummary, addedWords,
  flowChoiceOf, canOfferOrganize, flowSummaryOfSession, FLOW_RULES_BLOCK, moveFlag, FIRST_MOVE_FLAG, annotateForAdmin,
  leadBlock, questionNotes, DECIDED_FLAG, THANKS_FOR_CONFIRM_FLAG,
} from "../src/flow.mjs";
import { isLongStructuredMessage, planIntakeTurn, finishIntakeTurn, INTAKE_LONG_MESSAGE_FLAG } from "../src/intake.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  OK   ${label}`); } else { failed++; console.log(`  NG   ${label}${detail ? ` … ${detail}` : ""}`); }
}

// ---- ログを読む ----
export function readLog16f() {
  const md = fs.readFileSync(path.join(ROOT, "docs/review-logs/2026-10-11-16f362dd.md"), "utf8");
  const rows = [...md.matchAll(/^\| (\d+) \| (生徒|AI) \| (.*?) \| (.*?) \|/gm)].map((m) => {
    const ai = m[2] === "AI";
    const judge = m[4];
    return {
      turn: +m[1], role: ai ? "ai" : "user", body: m[3].replace(/<br>/g, "\n"),
      question_level: ai ? (/問わず/.test(judge) ? "none" : "data") : null,
      mode: ai && /モード/.test(judge) ? ["LISTEN_ONLY", "CBT"] : [],
      summarized: false, flags: [], crisis: false,
    };
  });
  return rows;
}

const rows = readLog16f();
const sessAt = (turn) => ({
  phase: turn >= 7 ? "phase2" : "intake", user_goal: turn >= 7 ? "吐き出すことと整理することの両方" : "",
  recommended_mode: turn >= 7 ? ["LISTEN_ONLY", "CBT"] : [], relation: "complainant",
});

console.log("ログ 16f362dd の作り直しの対象");
const hits = {};
const echoHits16f = {};
for (const r of rows.filter((x) => x.role === "ai" && x.turn >= 7)) {
  const idx = rows.indexOf(r);
  const hist = rows.slice(0, idx - 1); // 今回の生徒の発言より前
  const stats = flowStats([...hist, rows[idx - 1]], sessAt(r.turn), { stage: r.turn >= 11 ? 1 : 0, contexts: [] });
  const out = { reply: r.body, question_level: r.question_level, did_summarize: false, move: "none" };
  // 冒頭の言い直し(J。2026年11月1日)は、下の別の節で確かめる(この節は 2026年10月11日の決まりの範囲)
  const all = flowCheck(out, stats);
  hits[r.turn] = all.filter((x) => x[0] !== "J");
  echoHits16f[r.turn] = all.filter((x) => x[0] === "J");
}
console.log("   ", Object.entries(hits).map(([t, h]) => `T${t}:${h.join("/") || "-"}`).join("  "));
check("作り直しは 8・11・12 ターンだけ", Object.entries(hits).filter(([, h]) => h.length).map(([t]) => +t).join(",") === "8,11,12");
check("8ターンは汎用の言葉の2回目と「整理してみたい」でまとめていない", hits[8].some((h) => h.startsWith("B")) && hits[8].some((h) => h.startsWith("D")));
check("11ターンは受け止めのみの3回目と汎用の言葉", hits[11].some((h) => h.startsWith("A")) && hits[11].some((h) => h.startsWith("B")));
check("12ターンは受け止めのみと汎用の言葉(頑張ってきた・しんどい)", hits[12].some((h) => h.startsWith("A")) && hits[12].some((h) => h.includes("頑張ってきた") && h.includes("しんどい")));
check("9・10ターンは作り直しにしない(受け止めのみの1・2回目)", hits[9].length === 0 && hits[10].length === 0);

console.log("汎用の受け止めの組(意味でまとめる)");
for (const t of ["頑張ってきたんだね", "踏ん張ってきたんだね", "耐えて頑張ってきたんだね", "ずっと一人で耐えてきたんだね", "背負ってきたんだね", "よく頑張ってるね", "踏ん張ってるんだね"]) {
  check(`「${t}」は「頑張ってきた」の組`, genericGroupsIn(t).includes("頑張ってきた"));
}
check("「一人でやってるように思える」(相談者の言葉のなぞり)は労いに入れない", !genericGroupsIn("結局自分一人でやってるように思えるの").includes("頑張ってきた"));
check("かぎかっこの中の引用(「なんのために頑張っているのかわからない」)は数えない", genericGroupsIn("「なんのために頑張っているのかわからない」という気持ちがあること").length === 0 && genericGroupsIn("ずっと一人で耐えて頑張ってきたんだね").includes("頑張ってきた"));
check("「しんどいよね」「しんどかったね」は同じ組", genericGroupsIn("しんどいよね")[0] === "しんどい" && genericGroupsIn("しんどかったね")[0] === "しんどい");

console.log("記録のみ");
{
  const stats = flowStats(rows.slice(0, rows.findIndex((r) => r.turn === 12 && r.role === "ai")), sessAt(12), { stage: 1 });
  const f = finalizeFlow({ reply: rows.find((r) => r.turn === 12 && r.role === "ai").body, did_summarize: false }, stats);
  check("12ターン:「すり減」は強い言葉として記録", f.notes.some((n) => n.includes("強い言葉") && n.includes("すり減る")));
  const w9 = addedWords(rows.find((r) => r.turn === 9 && r.role === "ai").body, rows.filter((r) => r.role === "user" && r.turn <= 9).map((r) => r.body));
  check("9ターン:「取り残され」は強い言葉、「苦しい」は重さを足す言葉", w9.strong.includes("取り残され") && w9.heavy.includes("苦しい"));
  const w7 = addedWords(rows.find((r) => r.turn === 7 && r.role === "ai").body, rows.filter((r) => r.role === "user" && r.turn <= 7).map((r) => r.body));
  check("7ターン:「重い」「背負」は重さを足す言葉", w7.heavy.includes("重い") && w7.heavy.includes("背負"));
  check("相談者が使った言葉は数えない", addedWords("限界なんだね", ["もう限界"]).strong.length === 0);
  check("インテークのつらさスケールの選択肢は数えない", addedWords("4:限界に近い 5:もう耐えられない", []).strong.length === 0);
  const three = finalizeFlow({ reply: "そうなんだね。" }, { ...stats, lastEndings: ["んだね", "んだね"] });
  check("同じ終わり方が3回続いたら記録だけする", three.notes.some((n) => n.startsWith("記録のみ:同じ終わり方")));
  const sum = flowSummaryOfSession(rows);
  check("ログの受け止めのみの最大連続は4", sum.maxReceiveOnly === 4, String(sum.maxReceiveOnly));
  check("ログの汎用の言葉の2回目以降は4回", sum.genericRepeats === 4, JSON.stringify(sum.genericCounts));
}

console.log("まとめの形");
check("並べて確かめる形は満たす", isValidSummary("一回まとめてみるね。「会長だから一人で頑張ってる」「みんなは談笑してる」「なんのためかわからない」。合ってるかな?"));
check("確かめが無いと満たさない", !isValidSummary("一回まとめてみるね。「会長だから」「談笑」「わからない」。"));
check("「整理してみたい」と言っただけでは満たさない", !isValidSummary("一回整理してみたいんだけど、どんな場面が多い?"));
{
  const stats = flowStats([], { phase: "phase2" }, {});
  const f = finalizeFlow({ reply: "一回整理してみたいな。どんな場面?", did_summarize: true, move: "summary" }, stats);
  check("形を満たさない did_summarize は false にして記録", f.out.did_summarize === false && f.notes.some((n) => n.includes("まとめの形")));
  check("まとめてよいかをたずねて終えるのは作り直さない", !flowCheck({ reply: "ここまでの話、一回まとめてみてもいい?" }, stats).some((r) => r.startsWith("D")));
  const asked = flowStats([{ role: "user", body: "x" }, { role: "ai", body: "ここまでの話、一回まとめてみてもいい?", question_level: "data" }, { role: "user", body: "y" }], { phase: "phase2" }, {});
  check("まとめてよいかを2回続けてたずねたら作り直す", asked.askedSummaryPermission && flowCheck({ reply: "そっか。一回整理してみてもいいかな?" }, asked).some((r) => r.startsWith("D")));
  // まとめは20往復を超えてから(2026年11月1日・危機の作り直し 第4部)。本人が望んだときはまとめてよい
  const askedWant = flowStats([{ role: "user", body: "x" }, { role: "ai", body: "ここまでの話、一回まとめてみてもいい?", question_level: "data" }, { role: "user", body: "一回まとめてほしい" }], { phase: "phase2" }, {});
  check("たずねたあとは、たずねずにまとめる指示(本人が望んだとき)", askedWant.summaryAllowed && buildFlowBlock(askedWant, {}, "一回まとめてほしい").includes("もうたずねない"));
  check("20往復前はまとめない指示", !asked.summaryAllowed && buildFlowBlock(asked, {}, "y").includes("まだしない"));
  check("20往復前のまとめは作り直す(I)", flowCheck({ reply: "一回まとめてみるね。進路を決められること、話を聞いてもらえないこと、このあたりかな。合ってるかな?", did_summarize: true }, asked).some((r) => r.startsWith("I")));
  const many = Array.from({ length: 20 }, (_, i) => [{ role: "user", body: `話${i}` }, { role: "ai", body: `うん、それで?${i}`, question_level: "data" }]).flat();
  check("20往復を超えたらまとめてよい", flowStats(many, { phase: "phase2" }, {}).summaryAllowed);
  check("話に行き詰まったらまとめてよい", flowStats([{ role: "user", body: "何を話せばいいかわからなくなってきた" }], { phase: "phase2" }, {}).summaryAllowed);
}

console.log("傾聴に切り替えてよいとき(この3つだけ)");
{
  const base = { phase: "phase2", user_goal: "吐き出すことと整理することの両方", recommended_mode: ["LISTEN_ONLY"] };
  const ro = [1, 2].flatMap(() => [{ role: "user", body: "うん" }, { role: "ai", body: "そうなんだね。", question_level: "none", mode: ["LISTEN_ONLY"] }]);
  check("モードが LISTEN_ONLY でも、3つの条件が無ければ緩めない", flowCheck({ reply: "そっか。" }, flowStats(ro, base)).some((r) => r.startsWith("A")));
  check("本人が「聞いてほしいだけ」と言ったら緩める", flowCheck({ reply: "そっか。" }, flowStats([{ role: "user", body: "アドバイスはいらない、聞いてほしいだけ" }, ...ro], base)).length === 0);
  check("ゴールが吐き出すことだけなら緩める", flowStats(ro, { ...base, user_goal: "吐き出したい" }).listenOnly);
  const g = [...ro.slice(0, 3), { role: "ai", body: "このまま話す?", choice_set: "G", choices: [{ id: "G1" }], mode: ["LISTEN_ONLY"] }];
  check("チップで「もう少しこのまま話したい」を選んだら緩める", flowStats(g, base, { choiceId: "G1" }).listenOnly);
  check("組G を付けた返事のあとだけ、組G のチップを受け付ける", flowChoiceOf(g, "G2")?.id === "G2" && flowChoiceOf(ro, "G2") === null);
}

console.log("受け止めのみ2回まで(採点の前の修正 1-6。相談ログ 86130eef で3回続いた)");
{
  const base = { phase: "phase2", user_goal: "整理したい" };
  // AI が question_level を data と申告していても、本文に問いが無ければ受け止めのみに数える
  const mislabeled = [1, 2].flatMap(() => [{ role: "user", body: "うん" }, { role: "ai", body: "そうなんだね。", question_level: "data" }]);
  check("申告ではなく本文の「?」で数える", flowStats(mislabeled, base).receiveOnlyStreak === 2);
  check("申告が data でも3回目は作り直し", flowCheck({ reply: "そっか。" }, flowStats(mislabeled, base)).some((r) => r.startsWith("A")));
  // 危機のあとでも、受け止めだけを3回続けない(問いは軽いもの1つ)
  const st = flowStats(mislabeled, base, { stage: 0, contexts: ["afterCrisis"] });
  check("危機のあとでも3回目は作り直し", st.crisis && flowCheck({ reply: "そっか。" }, st).some((r) => r.startsWith("A")));
  check("危機のあとの指示は軽い問い・危険度は聞かない", buildFlowBlock(st, {}, "うん").includes("危険度・方法・どのくらい本気かは聞かない"));
  const thanks = [1, 2].flatMap(() => [{ role: "user", body: "うん" }, { role: "ai", body: "話してくれてありがとう。どんなときにそう思う?" }]);
  check("ありがとうは2回まで(3回目は作り直し)", flowCheck({ reply: "教えてくれてありがとう。それはいつごろ?" }, flowStats(thanks, base)).some((r) => r.startsWith("H")));
  check("ありがとうが1回なら当てない", !flowCheck({ reply: "教えてくれてありがとう。それはいつごろ?" }, flowStats(thanks.slice(0, 2), base)).some((r) => r.startsWith("H")));
  check("危機のあとでも、問いがあれば当てない", !flowCheck({ reply: "そっか。今いちばん話したいことはある?" }, st).some((r) => r.startsWith("A")));
}

console.log("見立て・気になったこと・つなぎはサーバが判定する");
{
  const mk = (n, extra = {}) => {
    const h = [{ role: "ai", body: "x", mode: ["CBT"] }];
    for (let i = 0; i < n; i++) h.push({ role: "user", body: `話${i}` }, { role: "ai", body: `返事${i}?`, question_level: "data", mode: ["CBT"], ...extra });
    return h;
  };
  const s2 = flowStats(mk(2), { phase: "phase2", relation: "complainant", recommended_mode: ["CBT"] }, { stage: 0 });
  check("フェーズ2の3ターン目までは見立てを出さない", !s2.hypothesisAllowed && flowCheck({ reply: "もしかして、量より一人なのがしんどい?" }, s2).some((r) => r.startsWith("G")));
  const s4 = flowStats(mk(3), { phase: "phase2", relation: "complainant", recommended_mode: ["CBT"] }, { stage: 1 });
  check("4ターン目からは段階1でも出してよい", s4.hypothesisAllowed && s4.phase2Index === 4);
  check("ビジター型では出さない", !flowStats(mk(3), { phase: "phase2", relation: "visitor" }, { stage: 0 }).hypothesisAllowed);
  check("段階2では出さない", !flowStats(mk(3), { phase: "phase2", relation: "complainant" }, { stage: 2 }).hypothesisAllowed);
  check("危機のあとは出さない", !flowStats(mk(3), { phase: "phase2", relation: "complainant" }, { stage: 0, contexts: ["afterCrisis"] }).hypothesisAllowed);
  const h = mk(3); h[h.length - 1].flags = [moveFlag("hypothesis")];
  check("見立ては4ターンに1回まで", !flowStats(h, { phase: "phase2", relation: "complainant" }, { stage: 0 }).hypothesisAllowed);
  const n = mk(3); n[n.length - 3].flags = [moveFlag("noticed")];
  check("気になったことは5ターンに1回まで", !flowStats(n, { phase: "phase2" }, {}).noticedAllowed);
  check("人間のふりは作り直す", flowCheck({ reply: "わかるよ、わたしもそういうことあった。" }, s4).some((r) => r.startsWith("F")));
  check("「わたしもつらい」「胸が痛い」も作り直す", flowCheck({ reply: "聞いていて胸が痛いよ。" }, s4).some((r) => r.startsWith("F")));
  const block = buildFlowBlock(s2, { recommended_mode: ["LISTEN_ONLY", "CBT"] }, "なんで頑張ってるのかわからない");
  // 第4部: 「わからない」だけではまとめない(まとめは20往復を超えてから。行き詰まったときは別)
  check("「わからない」だけではまとめを促さない", !block.includes("意味を見失った") && block.includes("まだしない"));
  check("複合モードは傾聴のあとに CBT の一手", block.includes("傾聴で受け止めたあと") && block.includes("頭の中"));
  check("決まりに人の確認した言い回しが入っている", FLOW_RULES_BLOCK.includes("主役を奪わない") && FLOW_RULES_BLOCK.includes("一言の返事でもよい"));
}

console.log("整理・作業の提案(組G)");
{
  const base = { phase: "phase2", user_goal: "話を聞いてほしい", recommended_mode: ["CBT"] };
  check("モードが CBT ならゴールに整理が無くても出してよい", canOfferOrganize(flowStats([], base)));
  check("危機のあとは出さない", !canOfferOrganize(flowStats([], base, { contexts: ["afterCrisis"] })));
  const two = [1, 2].flatMap(() => [{ role: "user", body: "x" }, { role: "ai", body: "y", choice_set: "G", choices: [{ id: "G1" }] }, { role: "user", body: "z" }, { role: "ai", body: "w?" }]);
  check("1回の会話で2回まで", !canOfferOrganize(flowStats(two, base)));
  const st = flowStats([{ role: "ai", body: "y", choice_set: "G", choices: [{ id: "G2" }] }], base, { choiceId: "G2" });
  check("「一緒に整理してみたい」を選んだら、そのまま作業を始める指示", buildFlowBlock(st, base, "一緒に整理してみたい").includes("そのまま一緒に作業を始める"));
  const f = finalizeFlow({ reply: "場面を並べてみない?", offer_organize: true, move: "work", mode_first_move: true }, flowStats([], base));
  check("提案したらチップを付け、作業の提案・最初の一手を記録", f.offerChoices && f.notes.includes(moveFlag("work")) && f.notes.includes(FIRST_MOVE_FLAG));
}

console.log("終わり方の形");
check("「〜んだね」「〜よね」「問い」を分ける", endingClass("そうなんだね。") === "んだね" && endingClass("しんどいよね。") === "よね" && endingClass("どう?") === "Q");

console.log("管理画面の表示(annotateForAdmin)");
{
  const t0 = Date.parse("2026-10-11T05:00:00Z");
  const at = (i) => new Date(t0 + i * 1000).toISOString();
  const msgs = [
    { role: "user", body: "a", created_at: at(1) },
    { role: "ai", body: "そうなんだね。", question_level: "none", created_at: at(3), flags: [] },
    { role: "user", body: "なんで頑張ってるのかわからない", created_at: at(4) },
    { role: "ai", body: "そうか、ずっと頑張ってきたんだね。", question_level: "none", created_at: at(6), flags: [moveFlag("noticed")] },
    { role: "user", body: "死にたい", created_at: at(7) },
    { role: "ai", body: "固定応答", crisis: true, created_at: at(9) },
    { role: "user", body: "うん", created_at: at(10) },
    { role: "ai", body: "うん。", question_level: "none", created_at: at(12) },
  ];
  const events = [
    { risk: "watch", decided_by: ["classifier_watch"], created_at: at(5) },
    { risk: "crisis", keywords: ["死にたい"], model_risk: "crisis", created_at: at(8) },
  ];
  const a = annotateForAdmin(msgs, events);
  const v = a.messages.filter((m) => m.role === "ai").map((m) => m.flow_view);
  check("段階と根拠をそのターンの記録から出す", v[0].stage === 0 && v[1].stage === 1 && v[1].basis.includes("classifier_watch") && v[2].stage === 2);
  check("記録の段階の列が無くても risk から読み替える", v[2].basis.some((b) => b.startsWith("keywords:")));
  check("受け止めのみの連続と前回のまとめから", v[1].receiveOnlyStreak === 2 && v[1].sinceSummary === 2);
  check("固定応答のあとは「危機のあと」と出す", v[3].afterCrisis === true);
  check("返し方を出す", v[1].move === "noticed");
  check("セッションの文の数・終わり方の分布", a.flow_summary.sentenceDist[1] >= 1 && a.flow_summary.maxReceiveOnly === 3);
}

// ---- 冒頭の言い直し(2026年11月1日。相談ログのレビュー「返事の冒頭の繰り返しが、そのまますぎて不快」)----
console.log("\n■ 冒頭の言い直し");
{
  const e = (r, ...u) => echoOf(r, u);
  check("ほぼそのままの言い直しは強い言い直し", e("いじりすぎちゃったんだね。", "ちょっといじりすぎちゃった").strong);
  check("長い言い直しは言い直し", e("進路も塾も勝手に決められて、話を聞いてもらえないと感じているんだね。",
    "両親が勝手に私の進路を決める。勝手に塾に入れて、私の話なんて聞いてくれない。").echo);
  check("一句を拾うのは言い直しにしない", !e("打開したい、という強い思いがあるんだね。", "あなたから問いかけて欲しいんです。この状況を打開したいんです。").echo);
  check("一語を拾うのは言い直しにしない", !e("6点なんだね！", "うーん6点！！10点の時は麻辣担450gいける！！！").echo);
  check("中身を問いで使うのは言い直しにしない", !e("塾も、相談なしで決まったの?", "両親が勝手に私の進路を決める。勝手に塾に入れて、私の話なんて聞いてくれない。").echo);
  check("短い相槌は言い直しにしない", !e("うん、怖いよね。", "怖いの").echo && !e("そっか、わかんないよね。", "わかんない").echo);
  check("「」で丸ごと引用して始めるのは引用", e("「そこに相談しなきゃダメか」って感じたんだね。", "やはりそこに相談しなきゃダメですか？").quoted);
  check("短い返事のあとは、その前の発言との言い直しも拾う", e("否定されるのが嫌だなって感じるくらい、すごく怖いんだね。", "否定されるのが嫌なだけ", "怖いの").echo);
  // 作り直しの判定(フェーズ2の flowCheck)
  const sess = { phase: "phase2", recommended_mode: ["LISTEN_ONLY"], user_goal: "話を聞いてほしい" };
  const base = [{ role: "user", body: "親が勝手に進路を決めて、私の意見を全く聞かない" }];
  const stats1 = flowStats([...base], sess, {});
  const j = (reply, st) => flowCheck({ reply: reply + "どんなときにそう思う?", move: "none" }, st).filter((x) => x[0] === "J");
  check("強い言い直しは作り直す", j("親が勝手に進路を決めて、意見を聞いてくれないんだね。", stats1).length === 1);
  check("ふつうの返事は作り直さない", j("進路のこと、いつ頃から話してる?", stats1).length === 0);
  // 3回に1回: 直前の返事が言い直しなら、弱い言い直しでも作り直す
  const hist2 = [
    { role: "user", body: "部活の先輩がいつも私にだけ厳しくて、練習に行くのがつらい" },
    { role: "ai", body: "部活の先輩がいつも厳しくて、練習に行くのがつらいんだね。どんなときに?" },
    { role: "user", body: "親が勝手に進路を決めて、私の意見を全く聞かない" },
  ];
  const weak = "進路を決められて、意見を聞いてもらえないんだね。";
  check("弱い言い直しは、直前が言い直しでなければ作り直さない", j(weak, stats1).length === 0 && echoOf(weak, stats1.echoUsers).echo);
  check("弱い言い直しでも、直前2回に言い直しがあれば作り直す", j(weak, flowStats(hist2, sess, {})).length === 1);
  check("チップを押したターンは比べない", flowStats(base, sess, { choiceId: "G1" }).echoUsers.length === 0);
  // 割合(管理画面・検証)
  const r = echoRate(hist2.concat([{ role: "ai", body: "進路、どの学校の話?" }]));
  check("言い直しの割合", r.echoes === 1 && r.replies === 2 && r.rate === 0.5);
  check("インテークの決まった問いは数えない", echoRate([{ role: "user", body: "部活の先輩がいつも私にだけ厳しい" },
    { role: "ai", body: "そっか。", flags: [] }, { role: "ai", body: "つらさは?", flags: ["記録のみ:インテークの決まった問い(コード)"] }]).replies === 1);
  // 10/11 のログ(16f362dd)の返事の言い直し(記録のための確かめ。作り直しの当たり方は上の節の決まりとは別)
  check("16f362dd の再生で、言い直しの作り直しはいくつかのターンに当たる", Object.values(echoHits16f).some((x) => x.length));
}

// ---- 嶋先生のログレビュー5回目(2026年11月11日。docs/design-shima5-review.md)----
{
  console.log("\n■ 嶋先生のログレビュー5回目");
  const readLogUsers = (f) => [...fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(/^\| (\d+) \| 生徒[^|]* \| (.*?) \|/gm)].map((m) => m[2].replace(/<br>/g, "\n"));
  const g1 = readLogUsers("docs/review-logs/2026-11-04-1d0a0511-1544.md");
  // 長文
  check("1d0a0511 の1ターン目は長文の相談", isLongStructuredMessage(g1[0]));
  check("1d0a0511 の4ターン目(①②③を並べた)も長文の相談", isLongStructuredMessage(g1[3]));
  check("短い発言は長文の相談ではない", !isLongStructuredMessage("部活の先輩がこわくて、行きたくない。どうしたらいい?"));
  check("長いだけで聞きたいことが並んでいない発言は当たらない", !isLongStructuredMessage("最近ずっと眠れなくて、".repeat(30) + "疲れてる。"));
  const sessC = { phase: "intake", intake_step: "category" };
  const t1 = planIntakeTurn({ sess: sessC, picked: null, text: g1[0], lastOffered: null });
  check("インテークの最初に長文 → つらさ・なりたい姿を飛ばしてフェーズ2へ", t1?.prompt === "afterLongMessage" && t1.patch.intake_step === "done" && t1.patch.phase === "phase2" && t1.flags.includes(INTAKE_LONG_MESSAGE_FLAG), JSON.stringify(t1?.patch));
  const f1 = finishIntakeTurn(t1, { intake: { chief_complaint_category: 1, onset_context: "高2のクラス替え", recommended_mode: ["CBT"] } });
  check("主訴・背景・進め方は AI の推定で記録し、決まった問いを続けない", f1.patch.chief_complaint_category === 1 && f1.patch.chief_complaint_source === "estimated"
    && f1.patch.recommended_mode.includes("CBT") && f1.question === null, JSON.stringify(f1));
  const tBtn = planIntakeTurn({ sess: sessC, picked: { set: "K", id: "K1", label: "友達・人間関係" }, text: "友達・人間関係", lastOffered: null });
  check("ボタンを押したターンは長文の扱いにしない", tBtn?.prompt === "afterCategoryButton");
  const tBg = planIntakeTurn({ sess: { phase: "intake", intake_step: "background", chief_complaint_category: 1 }, picked: null, text: g1[0], lastOffered: null });
  const fBg = finishIntakeTurn(tBg, { intake: { chief_complaint_category: 3, onset_context: "x", recommended_mode: [] } });
  check("背景の段で長文 → 主訴はボタンの記録のまま・フェーズ2へ", tBg?.prompt === "afterLongMessage" && fBg.patch.chief_complaint_category === undefined && fBg.patch.recommended_mode.length >= 1);
  const tShort = planIntakeTurn({ sess: { phase: "intake", intake_step: "background", chief_complaint_category: 1 }, picked: null, text: "4月から", lastOffered: null });
  check("長文でなければ、これまでどおりつらさの問いへ", tShort?.prompt === "afterBackground" && tShort.after === "distress");
  // 答えにくい問いに謝らない(作り直し K)
  const hist = [
    { role: "user", body: "無理" },
    { role: "ai", body: "無理って思うくらい怖いんだね。その怖さに名前をつけるとしたら、どんな感じがする?", mode: ["NARRATIVE"], flags: [] },
    { role: "user", body: "そんなこと考えてる余裕なんてない" },
  ];
  const st = flowStats(hist, { phase: "phase2" }, {});
  check("問いのあとの「余裕なんてない」は答えにくさ", st.cantAnswer === true);
  check("答えにくさに「ごめんね」と返すと作り直す(K)", flowCheck({ reply: "余裕なんてないよね、ごめんね。今は頭の中がパニックな感じかな?" }, st).some((r) => r.startsWith("K")));
  check("謝らずに意図を伝えれば作り直さない", !flowCheck({ reply: "名前をつけるとしたらっていうのは、少し離れて見られたらと思ったんだけど、今はそれどころじゃない感じだよね。" }, st).some((r) => r.startsWith("K")));
  const stHow = flowStats([...hist.slice(0, 2), { role: "user", body: "どうしたらいいかわからない" }], { phase: "phase2" }, {});
  check("「どうしたらいいかわからない」は答えにくさではなく「どうすればいい?」", stHow.cantAnswer === false);
  const stCrisis = flowStats(hist, { phase: "phase2" }, { stage: 2 });
  check("危機の状態では K を当てない", !flowCheck({ reply: "ごめんね、話してくれてありがとう。" }, stCrisis).some((r) => r.startsWith("K")));
  const lbCant = leadBlock("そんなこと考えてる余裕なんてない");
  check("答えにくさの指示: 謝らず意図を伝える", /謝らない/.test(lbCant) && /意図/.test(lbCant));
  // 「どうすればいい?」と「あなたならどっち?」
  const lbHow = leadBlock("どうしたらいいかわからない");
  check("「どうすればいい?」: 方向性が先か具体的な一歩か、を場合で分ける指示", /方向性を一言/.test(lbHow) && /具体的な一歩を1つ/.test(lbHow) && !/謝らない/.test(lbHow));
  const lbOp = leadBlock("あなたはどっちから先に言うのがいいと思う？\nあなたならどう話す？");
  check("「あなたならどっち?」: 良いところと気になるところを一緒に整理", /良いところと気になるところ/.test(lbOp) && !/方向性を一言/.test(lbOp));
  check("長文の発言には、聞かれていることを言葉にする指示", /聞きたいことはこの3つなんだね/.test(leadBlock(g1[0])));
  // 記録のみ: 完了形・確かめてくれてありがとう
  check("「覚悟を決めているんだね」は記録のみの印", questionNotes("直接話すって覚悟を決めているんだね。どっちが話しやすそう?", []).includes(DECIDED_FLAG));
  check("「腹をくくったんだね」も印", questionNotes("今日言おうって思えるくらい、腹をくくったんだね。", []).includes(DECIDED_FLAG));
  check("相談者の言葉の引用の中は数えない", !questionNotes("「覚悟を決めた」って言ってたけど、いまはどう?", []).includes(DECIDED_FLAG));
  check("「確かめてくれてありがとう」は記録のみの印", questionNotes("確かめてくれてありがとう。何か感じたことってある?", []).includes(THANKS_FOR_CONFIRM_FLAG));
  // まとめの形と、まとめのあと
  check("まとめは誘いの形(「一回まとめてみようか」)", /一回まとめてみようか/.test(FLOW_RULES_BLOCK) && !/「一回まとめてみるね」と断る/.test(FLOW_RULES_BLOCK));
  check("まとめのあとは、この先の問いか気づきの問いのどちらか", /この先、どうなっていけたらいいかな/.test(FLOW_RULES_BLOCK));
  const sumHist = [
    { role: "user", body: "一緒に整理してみたい" },
    { role: "ai", body: "一回まとめてみようか。カードを使ったこと、早く言いたいこと、失望されるのが怖いこと、合ってるかな?", summarized: true, mode: ["NARRATIVE"], flags: [] },
    { role: "user", body: "うん" },
    { role: "ai", body: "ここまで言葉にしてみて、何か感じたことってある?", mode: ["NARRATIVE"], flags: [] },
    { role: "user", body: "どうしたらいいかわからない" },
  ];
  const stIns = flowStats(sumHist, { phase: "phase2" }, {});
  const fbIns = buildFlowBlock(stIns, { recommended_mode: ["NARRATIVE"] }, "どうしたらいいかわからない");
  check("気づきの問いに「わからない」→ 次は この先の問い", stIns.lastWasInsightQ && /この先、どうなっていけたらいいかな/.test(fbIns), fbIns.slice(0, 200));
}

console.log(`\n${failed === 0 ? "全件通過" : `失敗 ${failed}件`}(${passed + failed}件中)`);
process.exit(failed === 0 ? 0 : 1);
