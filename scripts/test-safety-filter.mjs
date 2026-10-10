// ============================================================================
//  Gemini の安全フィルターの測定(CLAUDE.md 5.11。2026年10月11日。指示書 next-steps-20261011 3章)
//
//  実行:
//   node scripts/test-safety-filter.mjs [--reps=3] [--scenes=A,B,C,D] [--out=<記録.jsonl>]
//      (同じ --out を渡すと続きから。ナレッジは --pg=<DB名> のローカル Postgres か、SUPABASE_URL 等から読む)
//
//  測るもの(すべて合成データ。無料枠のキー TEST_GEMINI_API_KEY(S) / TEST_GEMINI_API_KEY1〜 だけを使う):
//   A 危機の判定   テスト1の crisis と開発用の表記ゆれ → 本番と同じ分類器(classifyStaged。1判定につき分類器1回)
//   B 危機のあと   打ち明け3種 × 生徒の返事8種(docs/test-sets/safety-filter-scenes.json)→ 危機のあとの指示つきで本生成
//   C 気がかり     テスト1の watch → 気がかり(tierB)の指示つきで本生成
//   D 第三者       テスト1の subject=other と合成の8件 → 第三者(thirdParty)の指示つきで本生成
//
//  本番のコード(src/classify.mjs の callGeminiOnce・src/generate.mjs の generateReply)をそのまま呼び、
//  fetch を横から見て、Gemini の生の応答(finishReason・promptFeedback.blockReason・safetyRatings)を記録する。
//  リクエスト(safetySettings を含む)は本番とまったく同じ。本番のコードは変えていない。
//  レート制限(429)で測れなかった回は、キーを替えてやり直す(ブロックとは数えない)。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireTestGeminiKeyPool, sleep } from "./_lib/test-env.mjs";
import { classifyStaged, LITE_MODELS } from "../src/classify.mjs";
import { retrieve, buildSystem, generateReply, loadKnowledge, getDb, PRIMARY_MODELS, GENERATION_FAILURE_REPLIES } from "../src/generate.mjs";
import { buildCrisisReply } from "../src/crisis-texts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const REPS = Number(arg("reps", 3));
const SCENES = arg("scenes", "A,B,C,D").split(",");
const PG = arg("pg", null);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/safety-filter-${stamp}.jsonl`));
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
let keyIdx = 0;
const useKey = () => { process.env.GEMINI_API_KEY = KEY_POOL[keyIdx % KEY_POOL.length]; };
useKey();

// ---- 本番と同じ安全設定(記録用に src/classify.mjs の callGeminiOnce から読み取る) ----
const classifySrc = readFileSync(path.join(ROOT, "src/classify.mjs"), "utf8");
const SAFETY_SETTINGS = [...classifySrc.matchAll(/\{ category: "(HARM_CATEGORY_[A-Z_]+)", threshold: "([A-Z_]+)" \}/g)]
  .map((m) => ({ category: m[1], threshold: m[2] }));

// ---- fetch を横から見る(応答はそのまま返す) ----
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  const u = String(url);
  if (!u.includes("generativelanguage.googleapis.com")) return res;
  const model = (u.match(/models\/([^:]+):/) ?? [])[1] ?? "?";
  const rec = { model, status: res.status, finishReason: null, blockReason: null, empty: null, safetyRatings: null };
  try {
    if (res.ok) {
      const d = await res.clone().json();
      const c = d.candidates?.[0];
      rec.finishReason = c?.finishReason ?? null;
      rec.blockReason = d.promptFeedback?.blockReason ?? null;
      rec.empty = !(c?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      rec.safetyRatings = (c?.safetyRatings ?? d.promptFeedback?.safetyRatings ?? [])
        .filter((r) => r.probability && r.probability !== "NEGLIGIBLE")
        .map((r) => `${r.category.replace("HARM_CATEGORY_", "")}:${r.probability}`);
    }
  } catch { /* 読めない応答はそのまま */ }
  calls.push(rec);
  return res;
};
const isBlockedCall = (c) => c.status === 200 && (c.blockReason || (c.finishReason && !["STOP", "MAX_TOKENS"].includes(c.finishReason)) || c.empty);
const onlyRateLimited = (cs) => cs.length > 0 && cs.every((c) => c.status === 429 || c.status === 503);

// ---- 入力 ----
const t1 = JSON.parse(readFileSync(path.join(ROOT, "docs/test-sets/crisis-detection.json"), "utf8")).items;
const dev = JSON.parse(readFileSync(path.join(ROOT, "docs/test-sets/crisis-keywords-v3-dev.json"), "utf8")).items;
const scenes = JSON.parse(readFileSync(path.join(ROOT, "docs/test-sets/safety-filter-scenes.json"), "utf8"));
const items = [];
if (SCENES.includes("A")) {
  for (const x of t1.filter((x) => x.label === "crisis")) items.push({ scene: "A", kind: x.subject === "other" ? "第三者" : (x.tier_a_type ?? "crisis"), text: x.text, context: x.context ?? [] });
  for (const x of dev.filter((x) => x.group === "variant")) items.push({ scene: "A", kind: "表記ゆれ", text: x.text, context: [] });
}
if (SCENES.includes("B")) {
  for (const d of scenes.after_crisis.disclosures) for (const r of scenes.after_crisis.replies) {
    items.push({ scene: "B", kind: `${d.id}/${r.id}`, disclosure: d.text, text: r.text, contexts: r.contexts });
  }
}
if (SCENES.includes("C")) for (const x of t1.filter((x) => x.label === "watch")) items.push({ scene: "C", kind: "watch", text: x.text, contexts: ["tierB"] });
if (SCENES.includes("D")) {
  for (const x of t1.filter((x) => x.subject === "other")) items.push({ scene: "D", kind: "テスト1", text: x.text, contexts: ["thirdParty"] });
  for (const x of scenes.third_party.items) items.push({ scene: "D", kind: "合成", text: x.text, contexts: ["thirdParty"] });
}

// ---- ナレッジ(生成の場面だけ) ----
let rows = [];
if (items.some((x) => x.scene !== "A")) {
  if (PG) {
    const json = execFileSync("su", ["postgres", "-c", `psql -d ${PG} -tAc "select coalesce(json_agg(k),'[]') from (select id,src,school,cat,lv,weight,tags,body,updated_at,mode from knowledge where active) k"`], { encoding: "utf8" });
    rows = JSON.parse(json.trim());
  } else {
    rows = await loadKnowledge(getDb());
  }
  console.log(`ナレッジ: ${rows.length}件(${PG ? `ローカル Postgres ${PG}` : "Supabase"})`);
}
// 最初の来訪と同じ基準のセッション(インテーク中。危機のあとは本番と同じく台本を止める)
const SESS = { phase: "intake", weight: "rapport", relation: "visitor", notes: {}, turns_since_summary: 0, recommended_mode: null };

async function runOnce(it) {
  calls = [];
  if (it.scene === "A") {
    const r = await classifyStaged(it.text, it.context, { votes: 1, version: "v3" });
    const err = r.classifierError ?? r.votes?.find?.((v) => !v.ok)?.error ?? null;
    return { stage: r.stage, decided_by: r.decidedBy, error: err, shown: null };
  }
  const contents = [];
  if (it.disclosure) contents.push({ role: "user", parts: [{ text: it.disclosure }] }); // 固定応答は本番と同じく履歴に入れない
  contents.push({ role: "user", parts: [{ text: it.text }] });
  const chunks = retrieve(rows, it.text, SESS.weight, SESS.relation, undefined, it.contexts, null);
  const system = buildSystem(rows, chunks, SESS.weight, SESS.notes, 0, null, it.contexts, SESS);
  const g = await generateReply(system, contents, PRIMARY_MODELS, undefined, undefined, 0);
  return {
    generation_failed: g.generationFailed, failure_cause: g.failureCause || null, failure_detail: (g.failureDetail || "").slice(0, 200),
    used_model: g.usedModel, flags: g.flags, shown: g.generationFailed ? "生成失敗の固定の返事" : "生成した返事",
    reply_head: (g.out?.reply ?? "").slice(0, 60),
  };
}

// ---- 実行(再開対応) ----
mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set();
if (existsSync(OUT)) for (const l of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); done.add(`${r.scene}|${r.kind}|${r.text}|${r.rep}`); }
const total = items.length * REPS;
console.log(`場面 ${SCENES.join("・")}: ${items.length}件 × ${REPS}回 = ${total}回(キー${KEY_POOL.length}本)。記録: ${path.relative(ROOT, OUT)}(済み ${done.size})`);
console.log(`安全設定(本番のコードから): ${SAFETY_SETTINGS.map((s) => `${s.category.replace("HARM_CATEGORY_", "")}=${s.threshold}`).join(", ")}`);
let n = done.size, paused = null;
outer:
for (const it of items) {
  for (let rep = 1; rep <= REPS; rep++) {
    const key = `${it.scene}|${it.kind}|${it.text}|${rep}`;
    if (done.has(key)) continue;
    let res, tries = 0;
    for (;;) {
      res = await runOnce(it);
      const rateOnly = onlyRateLimited(calls) || /\[RATE_LIMIT\]|\[HTTP_503\]/.test(String(res.error ?? res.failure_detail ?? "")) && !calls.some(isBlockedCall);
      if (!rateOnly) break;
      if (++tries >= KEY_POOL.length * 3) { paused = "レート制限が続いたため中断(同じ --out で再開できる)"; break outer; }
      keyIdx++; useKey(); await sleep(tries % KEY_POOL.length === 0 ? 30000 : 1500);
    }
    const rec = {
      scene: it.scene, kind: it.kind, text: it.text, disclosure: it.disclosure ?? null, rep,
      calls: calls.map(({ model, status, finishReason, blockReason, empty, safetyRatings }) => ({ model, status, finishReason, blockReason, empty, safetyRatings })),
      blocked_calls: calls.filter(isBlockedCall).length,
      prompt_blocked: calls.some((c) => c.blockReason),
      output_blocked: calls.some((c) => c.status === 200 && !c.blockReason && c.finishReason && !["STOP", "MAX_TOKENS"].includes(c.finishReason)),
      empty: calls.some((c) => c.status === 200 && c.empty),
      first_model: calls[0]?.model ?? null,
      ...res,
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    n++;
    console.log(`[${n}/${total}] ${it.scene} ${it.kind.padEnd(14)} ${rec.blocked_calls ? `★ブロック ${rec.calls.filter(isBlockedCall).map((c) => c.blockReason || c.finishReason).join(",")}` : "通過"} ${it.scene === "A" ? `段階${res.stage}` : res.shown} 「${it.text.slice(0, 18)}」`);
    await sleep(500);
  }
}

// ---- 集計 ----
const recs = readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const L = [];
const sceneName = { A: "A 危機の判定(分類器)", B: "B 危機のあとの生成", C: "C 気がかりの生成", D: "D 第三者の生成" };
L.push("========================================");
L.push("Gemini の安全フィルターの測定(CLAUDE.md 5.11)");
L.push("========================================");
L.push(`記録: ${path.relative(ROOT, OUT)}  済み ${recs.length}/${total}${paused ? `(${paused})` : ""}`);
L.push(`キー: 無料枠(テスト用)のみ。入力はすべて合成。分類器 ${LITE_MODELS.join(" → ")} / 本生成 ${PRIMARY_MODELS.join(" → ")}(本番と同じフォールバック)`);
L.push(`安全設定(本番と同じ): ${SAFETY_SETTINGS.map((s) => `${s.category.replace("HARM_CATEGORY_", "")}=${s.threshold}`).join(", ")}`);
L.push("");
L.push("【場面ごと】  送った回数 / ブロックのあった回(入力のブロック・出力のブロック・空の応答)/ 生徒に固定の返事が出た回");
for (const s of ["A", "B", "C", "D"]) {
  const rs = recs.filter((r) => r.scene === s);
  if (!rs.length) continue;
  const c = (f) => rs.filter(f).length;
  const models = {};
  for (const r of rs) for (const x of r.calls) if (x.status === 200) models[x.model] = (models[x.model] ?? 0) + 1;
  L.push(`  ${sceneName[s]}: ${rs.length}回 / ブロック ${c((r) => r.blocked_calls > 0)}回(入力 ${c((r) => r.prompt_blocked)}・出力 ${c((r) => r.output_blocked)}・空 ${c((r) => r.empty)})`
    + (s === "A" ? ` / 分類器のエラー ${c((r) => r.error)}回` : ` / 生成失敗の固定の返事 ${c((r) => r.generation_failed)}回`)
    + `  応答したモデル: ${JSON.stringify(models)}`);
}
L.push("");
L.push("【ブロックのあった回の内訳】");
const blocked = recs.filter((r) => r.blocked_calls > 0);
if (!blocked.length) L.push("  なし");
for (const r of blocked) L.push(`  ${r.scene} ${r.kind} rep${r.rep}: ${r.calls.filter(isBlockedCall).map((c) => `${c.model} ${c.blockReason || c.finishReason}${c.empty ? "(空)" : ""}`).join(" / ")} → ${r.scene === "A" ? `段階${r.stage}` : r.shown} 「${r.text}」`);
L.push("");
L.push("【NEGLIGIBLE 以外の安全評価が付いた回(ブロックはされていない。参考)】");
const rated = recs.filter((r) => r.calls.some((c) => c.safetyRatings?.length));
const ratingCount = {};
for (const r of rated) for (const c of r.calls) for (const s of c.safetyRatings ?? []) ratingCount[s] = (ratingCount[s] ?? 0) + 1;
L.push(`  ${rated.length}回。${JSON.stringify(ratingCount)}`);
L.push("");
L.push("【ブロックされたときに生徒の画面に出るもの(今のコード)】");
L.push("  分類器(A): ブロックは分類器のエラーとして扱い、キーワードが当たっていれば段階2のまま、当たっていなければ段階1以上(安全側)。");
L.push("  本生成(B〜D): 次のモデルに切り替えて試し、すべて失敗すると3秒おいてもう1回試す。それでも失敗したら、生成失敗の固定の返事を出す:");
for (const t of GENERATION_FAILURE_REPLIES) L.push(`    「${t}」`);
L.push("  画面下の常設の窓口表示(119番・24時間子供SOSダイヤル)はいつも出ている。危機の固定応答(段階2)は生成しないのでブロックされない。");
const report = L.join("\n");
console.log("\n" + report);
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, report + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify({
  done: recs.length, planned: total, paused, safety_settings: SAFETY_SETTINGS,
  scenes: Object.fromEntries(["A", "B", "C", "D"].map((s) => { const rs = recs.filter((r) => r.scene === s); return [s, { sent: rs.length, blocked: rs.filter((r) => r.blocked_calls > 0).length, prompt_blocked: rs.filter((r) => r.prompt_blocked).length, output_blocked: rs.filter((r) => r.output_blocked).length, empty: rs.filter((r) => r.empty).length, fallback_reply: rs.filter((r) => r.generation_failed).length, classifier_error: rs.filter((r) => r.error).length }]; })),
}, null, 2));
const xl = spawnSync("python3", [path.join(__dirname, "export-safety-filter-xlsx.py"), OUT], { encoding: "utf8" });
console.log(xl.status === 0 ? xl.stdout.trim() : `エクセルの書き出しに失敗: ${String(xl.stderr).slice(0, 300)}`);
process.exitCode = paused ? 3 : 0;
