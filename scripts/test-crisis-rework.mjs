// 危機の作り直し 第1部のオフラインテスト(2026年11月1日。docs/design-crisis-rework.md)
//   1-2 モデルの切り替えの記録・管理画面の状態の行
//   1-3 危機の種類(複数可)・受け止めの一言・家の人を挙げない
// 秘密の約束(1-1)は scripts/test-output-check.mjs で確かめる。
// 使い方: node scripts/test-crisis-rework.mjs
import { crisisTypesOf, crisisTypesFlag, crisisTypesFromFlags } from "../src/crisis-types.mjs";
import { buildCrisisReply, concernText } from "../src/crisis-texts.mjs";
import { modelTrailFlag, modelHealth, PRIMARY_MODELS } from "../src/generate.mjs";
import { failureTag } from "../src/classify.mjs";
import { OUTPUT_NG } from "../src/safety.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  OK   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `  -- ${detail}` : ""}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("[1-2] モデルの一覧・切り替えの記録・状態の行");
check("本番の一覧にプレビュー版が無い", !PRIMARY_MODELS.some((m) => m.includes("preview")), PRIMARY_MODELS.join(","));
check("失敗の種類: 429", failureTag("[RATE_LIMIT] Gemini(x) 429") === "429");
check("失敗の種類: 時間切れ", failureTag("[TIMEOUT] Gemini(x) 8000ms") === "時間切れ");
check("失敗の種類: 503", failureTag("[HTTP_503] Gemini(x) 503") === "503");
check("切り替えが無ければ記録しない", modelTrailFlag([{ model: "a", ok: true, tag: "" }]) === null);
const trail = modelTrailFlag([{ model: "a", ok: false, tag: "時間切れ" }, { model: "b", ok: false, tag: "429" }, { model: "c", ok: true, tag: "" }]);
check("切り替えの記録の形", trail === "モデルの切り替え: a 時間切れ → b 429 → 応答 c", trail);
const now = Date.parse("2026-11-01T12:00:00Z");
const at = (min) => new Date(now - min * 60000).toISOString();
const rows = [
  { created_at: at(5), flags: ["モデルの切り替え: a 429 → 応答 b"], timings: { total: 4000 } },
  { created_at: at(10), flags: ["生成失敗→固定応答で継続(レート制限(429))", "モデルの切り替え: a 429 → b 429 → 応答なし"], timings: { total: 9000 } },
  { created_at: at(20), flags: [], timings: { total: 2000 } },
  { created_at: at(30), flags: ["モデルの切り替え: a 429 → 応答 b"] },
  { created_at: at(40), flags: ["モデルの切り替え: a 429 → 応答 b"] },
  { created_at: at(300), flags: ["モデルの切り替え: a 時間切れ → 応答 b"], timings: { total: 12000 } },
];
const h = modelHealth(rows, now);
check("直近1時間の数", h.h1.replies === 5 && h.h1.rate_limited === 4 && h.h1.fallback === 4 && h.h1.failed === 1, JSON.stringify(h.h1));
check("直近1時間の時間の中央値", h.h1.median_ms === 4000, String(h.h1.median_ms));
check("24時間の数", h.h24.replies === 6 && h.h24.fallback === 5, JSON.stringify(h.h24));
check("429 が3回を超えたら警告", h.warn === true);
check("429 が3回までなら警告しない", modelHealth(rows.slice(2), now).warn === false);

console.log("\n[1-3] 危機の種類");
const cases = [
  // 相談ログ 1d0a0511 15:18 T2(父からの暴力・母の自殺未遂と OD)
  ["父が暴力を振るっています。母と私に対してです。母はそれに耐えかねて自殺未遂行為を繰り返し、ODをしています。わたしは高三で受験勉強もしたいのですが、家にも帰りたくありません。", ["abuse", "other"]],
  ["このまま親に全て決められる人生を歩むくらいなら、死んでやる", ["suicidal"]],
  ["切るのがやめられない\n跡が痒い笑笑", ["selfharm"]],
  ["死にたい", ["suicidal"]],
  ["自分のことクズすぎて死にたい", ["suicidal"]],
  ["母に殴られてる", ["abuse"]],
  ["父が母を殴るのを毎晩見てる", ["abuse"]],
  ["両親のケンカで物を投げ合ってて怖い", ["abuse"]],
  ["友達が死にたいって言ってて、どうしたらいいかわからない", ["other"]],
  ["友達が死にたいって言ってて、私も死にたい", ["suicidal", "other"]],
  ["お母さんが「死にたい」ってLINEしてきた", ["other"]],
  ["爪を切るのがやめられない", []],
  ["クラスでお金を取られてる", ["bullying"]],
];
for (const [text, want] of cases) {
  const got = crisisTypesOf(text, { risk: "crisis", subject: "self" });
  check(`${text.slice(0, 26).replace(/\n/g, " ")} → ${want.join(",") || "なし"}`, same(got, want), got.join(","));
}
check("分類器が第三者と判定したら other を足す", same(crisisTypesOf("どうしよう", { risk: "crisis", subject: "other" }), ["other"]));
check("記録の印から読み直せる", same(crisisTypesFromFlags(["x", crisisTypesFlag(["abuse", "other"])]), ["abuse", "other"]));
check("種類が無ければ印を付けない", crisisTypesFlag([]) === null);

console.log("\n[1-3] 受け止めの一言");
const multi = buildCrisisReply(["abuse", "other"]);
check("複数の種類を2つまでつなぐ", multi.includes("それから、身近な人のことを"), multi.split("\n\n")[1]);
check("暴力・虐待では家の人を挙げない", !buildCrisisReply(["abuse"]).includes("家の人"));
check("希死念慮では今までどおり家の人を挙げる", buildCrisisReply(["suicidal"]).includes("家の人"));
check("以前の種類の名前でも同じ文", buildCrisisReply("suicidal") === buildCrisisReply(["suicidal"]));
check("種類が無ければ種類不明の文", concernText([]) === "書いてくれたつらさ");
for (const types of [["abuse"], ["other"], ["abuse", "other"], ["selfharm"], []]) {
  const t = buildCrisisReply(types);
  const ng = OUTPUT_NG.filter((re) => re.test(t));
  check(`固定応答(${types.join(",") || "なし"})が出力チェックに当たらない`, !ng.length, ng.map(String).join(" "));
}

console.log(failures ? `\n${failures}件失敗` : "\n全件通過");
process.exit(failures ? 1 : 0);
