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
import {
  flowStats, flowCheck, finalizeFlow, buildFlowBlock, genericGroupsIn, endingClass, isValidSummary, addedWords,
  flowChoiceOf, canOfferOrganize, flowSummaryOfSession, FLOW_RULES_BLOCK, moveFlag, FIRST_MOVE_FLAG,
} from "../src/flow.mjs";

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
for (const r of rows.filter((x) => x.role === "ai" && x.turn >= 7)) {
  const idx = rows.indexOf(r);
  const hist = rows.slice(0, idx - 1); // 今回の生徒の発言より前
  const stats = flowStats([...hist, rows[idx - 1]], sessAt(r.turn), { stage: r.turn >= 11 ? 1 : 0, contexts: [] });
  const out = { reply: r.body, question_level: r.question_level, did_summarize: false, move: "none" };
  hits[r.turn] = flowCheck(out, stats);
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
  check("意味を見失った言葉ではまとめを促す", block.includes("意味を見失った"));
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

console.log(`\n${failed === 0 ? "全件通過" : `失敗 ${failed}件`}(${passed + failed}件中)`);
process.exit(failed === 0 ? 0 : 1);
