// ============================================================================
//  人につなぐ印の判定を、実際のモデルで確かめる(2026年11月9日。無料枠のテスト用キー・合成の文だけ。CLAUDE.md 5.10)
//
//    node scripts/test-referral-judge.mjs [--reps=2] [--set=docs/test-sets/referral-dev.json] [--out=docs/test-results/referral-judge-dev-YYYYMMDD]
//
//  1. 1文ごと: 出てほしい手がかり(expect)が出たか・出てほしくない手がかり(forbid。誇張・第三者・一時的)が出なかったか・段階の合図
//  2. 会話: 1ターンずつ判定して、会話全体の点数で印が付くか(src/referral.mjs の referralState)
//  判定の指示(REFERRAL_JUDGE_PROMPT)は本番と同じ。失敗(429 など)は数えずに記録する。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireTestGeminiKeyPool, sleep } from "./_lib/test-env.mjs";
import { judgeReferralCues, referralState } from "../src/referral.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const REPS = Number(arg("reps", 2));
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, arg("set", "docs/test-sets/referral-dev.json")), "utf8"));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const OUT = path.join(ROOT, arg("out", `docs/test-results/referral-judge-dev-${stamp}`));
const POOL = requireTestGeminiKeyPool(ROOT);
let keyIdx = 0;

// 1回の判定(キーを順に替える。失敗したら次のキーで2回まで)
async function judge(text, ctx) {
  let last = null;
  for (let i = 0; i < Math.max(3, POOL.length); i++) {
    process.env.GEMINI_API_KEY = POOL[keyIdx++ % POOL.length];
    const r = await judgeReferralCues(text, ctx);
    if (r.ok) return r;
    last = r;
    await sleep(/RATE_LIMIT|429/.test(r.error ?? "") ? 4000 : 1500);
  }
  return last;
}

const lines = [];
const records = [];
const p = (s = "") => { lines.push(s); console.log(s); };
p(`人につなぐ印の判定(実際のモデル・無料枠)  ${new Date().toISOString()}  各 ${REPS}回`);

// ---- 1文ごと ----
let uTotal = 0, uErr = 0, missExpect = 0, hitForbid = 0, stageOk = 0, stageN = 0, tempOk = 0, tempN = 0;
const missDetail = [], forbidDetail = [], stageDetail = [];
for (const u of SET.utterances) {
  for (let rep = 0; rep < REPS; rep++) {
    const r = await judge(u.text, []);
    records.push({ type: "utterance", id: u.id, rep, text: u.text, result: r });
    if (!r?.ok) { uErr++; continue; }
    uTotal++;
    const kinds = r.cues.map((c) => c.kind);
    const nonTemp = r.cues.filter((c) => !c.temporary).map((c) => c.kind);
    for (const k of u.expect ?? []) if (!kinds.includes(k)) { missExpect++; missDetail.push(`${u.id} ${k} が出ない「${u.text}」→ ${kinds.join(",") || "なし"}`); }
    for (const k of u.forbid ?? []) if (nonTemp.includes(k)) { hitForbid++; forbidDetail.push(`${u.id} ${k} が出た「${u.text}」`); }
    for (const k of u.temporary ?? []) { tempN++; if (!nonTemp.includes(k)) tempOk++; }
    if (u.stage) { stageN++; if (r.stage === u.stage) stageOk++; else stageDetail.push(`${u.id} 段階 ${u.stage} のはずが ${r.stage}「${u.text}」`); }
    await sleep(800);
  }
}
const expectN = SET.utterances.reduce((s, u) => s + (u.expect?.length ?? 0), 0) * REPS;
p("");
p("■ 1文ごと");
p(`  判定できた ${uTotal} / 失敗 ${uErr}`);
p(`  出てほしい手がかりの取りこぼし ${missExpect} / ${expectN}(判定できた分のうち)`);
p(`  出てほしくない手がかり(誇張・第三者・ふつうの文)が出た ${hitForbid}`);
p(`  一時的と言った手がかりを数えなかった ${tempOk} / ${tempN}`);
p(`  段階の合図が合った ${stageOk} / ${stageN}`);
for (const d of [...missDetail, ...forbidDetail, ...stageDetail]) p(`    ${d}`);

// ---- 会話 ----
let cOk = 0, cN = 0;
const convDetail = [];
p("");
p("■ 会話(1ターンずつ判定して、会話全体の点数)");
for (const c of SET.conversations) {
  for (let rep = 0; rep < REPS; rep++) {
    const recs = [];
    const ctx = [];
    let err = false;
    for (const t of c.turns) {
      const r = await judge(t, ctx);
      if (!r?.ok) { err = true; break; }
      recs.push({ cues: r.cues, stage: r.stage, watch: false });
      ctx.push({ role: "user", text: t }, { role: "ai", text: "そっか。もう少し聞かせて。" });
      await sleep(800);
    }
    records.push({ type: "conversation", id: c.id, rep, recs, err });
    if (err) { convDetail.push(`${c.id}#${rep + 1} 判定に失敗して数えない`); continue; }
    const st = referralState(recs);
    cN++;
    const good = st.flagged === c.flagged;
    if (good) cOk++;
    p(`  ${good ? "○" : "×"} ${c.id}#${rep + 1} ${c.label}: ${st.total}点(領域 ${st.domains.join("") || "なし"}・程度 ${st.degree.join(",") || "なし"}・支え ${st.supportScore}${st.standalone.length ? `・それだけで付く ${st.standalone.join(",")}` : ""})→ 印${st.flagged ? "付く" : "付かない"}(期待: ${c.flagged ? "付く" : "付かない"})`);
  }
}
p(`  期待どおり ${cOk} / ${cN}`);
for (const d of convDetail) p(`    ${d}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(`${OUT}.jsonl`, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(`${OUT}-summary.txt`, lines.join("\n") + "\n");
console.log(`\n記録: ${path.relative(ROOT, OUT)}.jsonl / -summary.txt`);
