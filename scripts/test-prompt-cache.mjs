// ============================================================================
//  暗黙のキャッシュが効くかの確かめ(2026年11月4日。docs/token-usage-20261103.md 4章 案②)
//
//    node scripts/test-prompt-cache.mjs [--model=gemini-3.6-flash] [--n=4]
//
//  buildSystem(本番と同じ組み立て)で、フェーズ2のターンを、場面(ふつう・危機のあと)と相談者の発言を変えて n 回送り、
//  応答の usageMetadata.cachedContentTokenCount(入力のうちキャッシュから読んだ分)を数える。
//  無料枠のテスト用キー・合成の発言だけ(CLAUDE.md 5.10)。ナレッジは db/knowledge.json(140件)。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireTestGeminiKey } from "./_lib/test-env.mjs";
import { buildSystem } from "../src/generate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
requireTestGeminiKey(ROOT);
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MODEL = arg("model", "gemini-3.6-flash");
const N = Number(arg("n", 4));
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8"))
  .map((k) => ({ id: k.id, src: k.src, cat: k.cat, lv: k.lv ?? null, body: k.text }));
const turns = [
  { ctx: [], text: "部活の先輩と気まずくて、行くのがしんどい" },
  { ctx: ["afterCrisis"], text: "うん、まあそんな感じ" },
  { ctx: [], text: "テストの点が悪くて親に言えない" },
  { ctx: ["tierB"], text: "もう無理かも" },
  { ctx: [], text: "友達とけんかした" },
  { ctx: [], text: "なんか疲れた" },
];
let cachedCalls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < N; i++) {
  const t = turns[i % turns.length];
  const chunks = rows.filter((k) => !["principle", "ng"].includes(k.cat)).slice(i * 5, i * 5 + 5);
  const system = buildSystem(rows, chunks, "main", {}, 3, null, t.ctx,
    { phase: "phase2", recommended_mode: ["CBT"], closing_state: null, user_goal: "気持ちを整理したい" }, { stats: null, text: t.text });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: t.text }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const j = await res.json().catch(() => ({}));
  const u = j.usageMetadata ?? {};
  if (u.cachedContentTokenCount) cachedCalls++;
  console.log(`${i + 1}. ${res.status} ${t.ctx.join(",") || "ふつう"} 入力 ${u.promptTokenCount ?? "-"} / キャッシュ ${u.cachedContentTokenCount ?? 0} / 出力 ${u.candidatesTokenCount ?? "-"}${j.error ? " / " + String(j.error.message).slice(0, 80) : ""}`);
  await sleep(4000);
}
console.log(`\nキャッシュが効いた呼び出し ${cachedCalls}/${N}(${MODEL})`);
