// ============================================================================
//  危機検知の作り直し 第1段階の検証(変更前 v1 と変更後 v2 を同じ条件で比べる)
//
//  実行: node scripts/test-crisis-staged.mjs [--set=docs/test-sets/crisis-detection.json]
//          [--reps-tier-a=10] [--reps-other=3] [--votes=2] [--out=docs/test-results/xxx.jsonl]
//        --out に途中まで書かれたファイルを渡すと、終わっている判定を飛ばして続きから再開する
//        (無料枠の1日の上限に当たって止まった場合用)。--report-only で集計だけを出す。
//
//  やること
//   ・発言ごとに、v1(src/classify.mjs の classify)と v2(classifyStaged)を交互に判定する
//     (時間帯による API の混み具合の差が、片方にだけ出ないようにするため)
//   ・Tier A(crisis・本人)の発言は --reps-tier-a 回、それ以外は --reps-other 回判定する
//   ・v2 が明示的な表現(tier_a_type = explicit)を1回でも見逃したら、その時点で止めて報告する
//   ・発言ごとの見逃し率(最も見逃されやすい発言を含む)、none/watch の段階の分布、
//     段階を決めた規則の内訳、分類器の回ごとの食い違い、費用と待ち時間を集計する
//
//  CLAUDE.md 5.10 に従い、無料枠のテスト専用キー(TEST_GEMINI_API_KEYS)で実行する。
//  費用の欄は「本番の有料枠で同じ呼び出しをした場合」の換算(scripts/_lib/test-env.mjs の PRICING)。
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  requireTestGeminiKeyPool, withRateLimitRetry, createKeyRotationState, sleep, PRICING, USD_TO_JPY,
} from "./_lib/test-env.mjs";
import { classify, classifyStaged, LITE_MODELS } from "../src/classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KEY_POOL = requireTestGeminiKeyPool(ROOT);
const ROTATION = createKeyRotationState();

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const SET_PATH = path.resolve(ROOT, arg("set", "docs/test-sets/crisis-detection.json"));
const REPS_TIER_A = Number(arg("reps-tier-a", 10));
const REPS_OTHER = Number(arg("reps-other", 3));
const VOTES = Number(arg("votes", 2));
const REPORT_ONLY = process.argv.includes("--report-only");
const setName = path.basename(SET_PATH, ".json");
const OUT = path.resolve(ROOT, arg("out", `docs/test-results/crisis-staged-${setName}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));

// 検証の条件。本番との違いは次の2点だけで、どちらも v1・v2 の両方に同じように効く。
//  ・分類モデルを LITE_MODELS の先頭(gemini-3.5-flash-lite。本番の有料枠で通常使われるもの)だけにする。
//    無料枠には1日500回/モデルの上限があり、上限に当たったキーでは2番目のモデルに切り替わってしまうため
//    (そのまま記録すると、判定の一部が本番と違うモデルになる)。上限に当たったら別のキーで試し、
//    すべてのキーで上限・混雑なら、その判定は記録せずに中断する(--out を付けて後で再開)。
//  ・v2 の1回あたりの待ち時間の上限を長くする(既定120秒。--timeout-ms で変更)。無料枠は混雑すると1回に
//    数十秒かかることがあり、本番の既定(15秒)のままだと、混雑による時間切れが「段階1」として記録されるため。
const PRIMARY_MODEL = LITE_MODELS[0];
LITE_MODELS.splice(1);
const TIMEOUT_MS = arg("timeout-ms", "120000");
const PATIENCE = Number(arg("patience", 6));
process.env.CRISIS_CLASSIFIER_TIMEOUT_MS = TIMEOUT_MS;

const items = JSON.parse(readFileSync(SET_PATH, "utf8")).items;
const isTierA = (it) => it.label === "crisis" && (it.subject ?? "self") !== "other";
const itemKey = (it) => `${it.text}||${JSON.stringify(it.context ?? null)}`;

// --------------------------------------------------------------------------
// 費用の集計用に、Gemini の応答から usageMetadata を拾う。判定ごとに別に数えるため、
// 呼び出しを始めた時点の判定IDに結びつける(v2 の待たなかった回が後から返っても、次の判定に混ざらない)。
// --------------------------------------------------------------------------
const usageByJudgment = new Map();
const pendingByJudgment = new Map();
let currentJudgment = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const jid = currentJudgment;
  const p = (async () => {
    const res = await realFetch(url, opts);
    if (jid && String(url).includes("generativelanguage.googleapis.com") && res.ok) {
      try {
        const d = await res.clone().json();
        const model = String(url).match(/models\/([^:]+):/)?.[1];
        const u = d.usageMetadata ?? {};
        const inT = u.promptTokenCount ?? 0;
        const outT = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
        const pr = PRICING[model] ?? { in: 0, out: 0 };
        const b = usageByJudgment.get(jid) ?? { calls: 0, in: 0, out: 0, usd: 0 };
        b.calls++; b.in += inT; b.out += outT; b.usd += (inT * pr.in + outT * pr.out) / 1e6;
        usageByJudgment.set(jid, b);
      } catch { /* 読めない応答は数えない */ }
    }
    return res;
  })();
  if (jid) {
    const s = pendingByJudgment.get(jid) ?? new Set();
    s.add(p); pendingByJudgment.set(jid, s);
    p.catch(() => {}).finally(() => s.delete(p));
  }
  return p;
};

// v2 は複数の回のエラーを " | " でつないで返すので、文字列全体から一時的な失敗のタグを探す
const isTransient = (r) => !!r.classifierError && /\[RATE_LIMIT\]|\[HTTP_503\]|\[TIMEOUT\]/.test(r.classifierError);

async function judge(version, item) {
  const jid = `${version}:${Math.random()}`;
  let lastMs = 0;
  const attempt = async () => {
    currentJudgment = jid;
    usageByJudgment.delete(jid); // レート制限で再試行した分は数えない(本番では起きにくいため)
    const t0 = Date.now();
    const r = version === "v1" ? await classify(item.text) : await classifyStaged(item.text, item.context ?? [], { votes: VOTES });
    lastMs = Date.now() - t0;
    return r;
  };
  let r = await withRateLimitRetry(KEY_POOL, attempt, isTransient, { state: ROTATION, label: `${version}: ` });
  // 無料枠の混雑(503)は数分で収まることが多いので、待ってから何度か試し直す(--patience 回。待ち時間は1分から最大5分)
  for (let round = 1; isTransient(r) && round <= PATIENCE; round++) {
    const waitMs = Math.min(60000 * round, 300000);
    console.error(`    ${version}: すべてのキーで上限・混雑。${waitMs / 1000}秒待って試し直します(${round}/${PATIENCE})`);
    await sleep(waitMs);
    r = await withRateLimitRetry(KEY_POOL, attempt, isTransient, { state: ROTATION, label: `${version}: ` });
  }
  currentJudgment = null;
  // それでも上限・混雑のまま → 記録せずに中断する(本番では起きにくい失敗を、判定の結果として数えないため)
  if (isTransient(r)) return { paused: true, error: r.classifierError };
  // v2 が待たなかった回(危機と確定した後の残り)も本番では費用がかかるので、返ってくるのを待ってから数える
  // (待ち時間 ms はこの前に測り終えている)
  await Promise.race([Promise.allSettled([...(pendingByJudgment.get(jid) ?? [])]), sleep(20000)]);
  pendingByJudgment.delete(jid);
  const tierA = r.risk === "crisis" && r.subject === "self";
  const stage = tierA ? 2 : r.risk === "crisis" ? "third" : r.risk === "watch" ? 1 : 0;
  return {
    version, predicted_risk: r.risk, predicted_subject: r.subject, predicted_tier_a: tierA, stage,
    decided_by: r.decidedBy ?? (r.keywords?.length ? ["keyword"] : ["classifier"]),
    keywords: r.keywords ?? [], patterns: r.patterns ?? [], idiom_exempted: r.idiomExempted ?? [],
    votes: (r.votes ?? []).map((v) => ({ ok: v.ok, risk: v.risk, subject: v.subject, reason: v.reason, error: v.error, ms: v.ms, retried: v.retried, skipped: v.skipped })),
    reason: r.model?.reason ?? null, classifier_error: r.classifierError ?? null, ms: lastMs,
    models: version === "v1" ? [r.usedModel] : (r.votes ?? []).filter((v) => v.ok).map((v) => v.model),
    usage: usageByJudgment.get(jid) ?? { calls: 0, in: 0, out: 0, usd: 0 },
  };
}

// --------------------------------------------------------------------------
// 実行(再開対応)
// --------------------------------------------------------------------------
mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Map(); // `${itemKey}|${rep}|${version}` → record
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) {
    const rec = JSON.parse(line);
    done.set(`${rec.item_key}|${rec.rep}|${rec.version}`, rec);
  }
}

const plan = items.map((it) => ({ it, reps: isTierA(it) ? REPS_TIER_A : REPS_OTHER }));
const totalJudgments = plan.reduce((s, p) => s + p.reps * 2, 0);
console.log(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)`);
console.log(`判定回数: Tier A 各${REPS_TIER_A}回・その他 各${REPS_OTHER}回 × v1/v2 = ${totalJudgments}判定(v2は1判定${VOTES}回並行)`);
console.log(`記録: ${path.relative(ROOT, OUT)}(済み ${done.size}件)\n`);

let stopped = null;
let paused = null;
if (!REPORT_ONLY) {
  let count = done.size;
  outer:
  for (const { it, reps } of plan) {
    for (let rep = 1; rep <= reps; rep++) {
      for (const version of ["v1", "v2"]) {
        const key = `${itemKey(it)}|${rep}|${version}`;
        if (done.has(key)) continue;
        const res = await judge(version, it);
        if (res.paused) {
          paused = `無料枠の上限または混雑のため中断(${version}「${it.text.slice(0, 20)}」: ${String(res.error).slice(0, 160)})`;
          console.log(`\n★ ${paused}\n  再開: node scripts/test-crisis-staged.mjs --set=${path.relative(ROOT, SET_PATH)} --out=${path.relative(ROOT, OUT)}`);
          break outer;
        }
        const rec = {
          item_key: itemKey(it), text: it.text, has_context: !!it.context?.length, rep,
          true_label: it.label, true_subject: it.subject ?? "self", tier_a: isTierA(it),
          tier_a_type: it.tier_a_type ?? null, category: it.category ?? null, ...res,
        };
        appendFileSync(OUT, JSON.stringify(rec) + "\n");
        done.set(key, rec);
        count++;
        const mark = rec.tier_a ? (rec.predicted_tier_a ? "○" : "×見逃し") : `段階${rec.stage}`;
        console.log(`[${count}/${totalJudgments}] ${version} ${it.label.padEnd(6)} ${mark.padEnd(5)} ${rec.decided_by.join(",")} 「${it.text.slice(0, 22)}」`);
        // 明示的な表現の見逃し(v2)は、その時点で止める
        if (version === "v2" && rec.tier_a_type === "explicit" && !rec.predicted_tier_a) {
          stopped = `v2 が明示的な表現を見逃した: 「${it.text}」(${rec.rep}回目。判定=${rec.predicted_risk}/${rec.predicted_subject}、` +
            `規則=${rec.decided_by.join(",")}、分類器エラー=${rec.classifier_error ?? "なし"})`;
          console.log(`\n★★★ 停止: ${stopped}`);
          break outer;
        }
        await sleep(1000);
      }
    }
  }
}

// --------------------------------------------------------------------------
// 集計
// --------------------------------------------------------------------------
const recs = [...done.values()];
const by = (v) => recs.filter((r) => r.version === v);
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const rate = (n, d) => (d ? `${n}/${d}` : "—");

const perItem = new Map();
for (const r of recs) {
  const p = perItem.get(r.item_key) ?? { text: r.text, label: r.true_label, tier_a: r.tier_a, tier_a_type: r.tier_a_type, category: r.category, has_context: r.has_context, v1: [], v2: [] };
  p[r.version].push(r);
  perItem.set(r.item_key, p);
}
const miss = (rs) => rs.filter((r) => !r.predicted_tier_a).length;
const tierAItems = [...perItem.values()].filter((p) => p.tier_a);
const tierARows = tierAItems.map((p) => ({
  text: p.text, type: p.tier_a_type, has_context: p.has_context,
  v1_miss: miss(p.v1), v1_n: p.v1.length, v2_miss: miss(p.v2), v2_n: p.v2.length,
  v2_rules: p.v2.filter((r) => r.predicted_tier_a).reduce((m, r) => {
    const k = r.decided_by.includes("pattern") ? "パターン" : r.decided_by.includes("keyword") ? "キーワード" : "分類器";
    m[k] = (m[k] ?? 0) + 1; return m;
  }, {}),
}));
const missRate = (m, n) => (n ? m / n : 0);
const worsened = tierARows.filter((r) => r.v1_n && r.v2_n && missRate(r.v2_miss, r.v2_n) > missRate(r.v1_miss, r.v1_n));
const explicitV2Miss = tierARows.filter((r) => r.type === "explicit").reduce((s, r) => s + r.v2_miss, 0);
const worst = (v) => [...tierARows].sort((a, b) => missRate(b[`${v}_miss`], b[`${v}_n`]) - missRate(a[`${v}_miss`], a[`${v}_n`]))[0];

const stageDist = (label, v) => {
  const rs = by(v).filter((r) => r.true_label === label && !(label === "crisis"));
  const d = { 0: 0, 1: 0, 2: 0, third: 0 };
  for (const r of rs) d[r.stage]++;
  return { n: rs.length, ...d };
};
const noneTo2 = (v) => by(v).filter((r) => r.true_label === "none" && r.stage === 2);
const watchTo0 = (v) => by(v).filter((r) => r.true_label === "watch" && r.stage === 0);
const disagree = by("v2").filter((r) => { const risks = r.votes.filter((x) => x.ok).map((x) => x.risk); return new Set(risks).size > 1; });
const latency = (v) => { const ms = by(v).map((r) => r.ms); return { median: pct(ms, 0.5), p90: pct(ms, 0.9), max: ms.length ? Math.max(...ms) : null }; };
const cost = (v) => { const rs = by(v); const usd = rs.reduce((s, r) => s + r.usage.usd, 0); return { per_judgment_yen: rs.length ? (usd / rs.length) * USD_TO_JPY : 0, calls_per_judgment: rs.length ? rs.reduce((s, r) => s + r.usage.calls, 0) / rs.length : 0 }; };
const errRate = (v) => rate(by(v).filter((r) => r.classifier_error).length, by(v).length);
const modelUse = (v) => by(v).flatMap((r) => r.models ?? []).reduce((m, x) => ((m[x ?? "不明"] = (m[x ?? "不明"] ?? 0) + 1), m), {});
const ruleCounts = (rs) => rs.reduce((m, r) => { for (const k of r.decided_by) m[k] = (m[k] ?? 0) + 1; return m; }, {});

const criteria = {
  explicit_zero_miss: explicitV2Miss === 0,
  no_tier_a_item_worsened: worsened.length === 0,
  none_to_stage2_not_increased: noneTo2("v2").length <= noneTo2("v1").length,
  watch_to_none: { v1: watchTo0("v1").length, v2: watchTo0("v2").length, n: by("v2").filter((r) => r.true_label === "watch").length },
};

const lines = [];
const L = (s = "") => lines.push(s);
L("========================================");
L("危機検知の作り直し 第1段階の検証(v1=変更前 / v2=変更後)");
L("========================================");
L(`テストセット: ${path.relative(ROOT, SET_PATH)}(${items.length}件)  記録: ${path.relative(ROOT, OUT)}`);
L(`判定: Tier A 各${REPS_TIER_A}回・その他 各${REPS_OTHER}回。v2 は1判定${VOTES}回並行。済み ${recs.length}/${totalJudgments}判定${stopped ? "(途中で停止)" : paused ? "(中断中。再開できる)" : ""}`);
L(`条件: 分類モデルは ${PRIMARY_MODEL} のみ、v2 の1回あたりの待ち時間の上限 ${TIMEOUT_MS}ms(本番は15000ms)`);
if (stopped) L(`★ 停止の理由: ${stopped}`);
if (paused) L(`★ ${paused}`);
L("");
L("【採用の条件】");
L(`  明示的な表現の見逃しゼロ(v2)            : ${criteria.explicit_zero_miss ? "満たす" : `満たさない(${explicitV2Miss}回)`}`);
L(`  どの Tier A の発話も見逃し率が悪化しない  : ${criteria.no_tier_a_item_worsened ? "満たす" : `満たさない(${worsened.length}件)`}`);
L(`  none が段階2になる回数が増えない          : ${criteria.none_to_stage2_not_increased ? "満たす" : "満たさない"}(v1 ${noneTo2("v1").length}回 → v2 ${noneTo2("v2").length}回)`);
L(`  watch が段階0(none)に落ちる回数           : v1 ${criteria.watch_to_none.v1}回 → v2 ${criteria.watch_to_none.v2}回(watch ${criteria.watch_to_none.n}判定中。「大きく増えていない」かはご判断を)`);
L("");
L("【Tier A の発話ごとの見逃し(判定回数中の見逃し回数)】");
for (const type of ["explicit", "passive"]) {
  L(`  ■ ${type === "explicit" ? "明示" : "受動・示唆"}`);
  for (const r of tierARows.filter((x) => x.type === type)) {
    const flag = worsened.includes(r) ? "  ← 悪化" : "";
    L(`    v1 ${rate(r.v1_miss, r.v1_n).padEnd(6)} v2 ${rate(r.v2_miss, r.v2_n).padEnd(6)} v2の検出: ${JSON.stringify(r.v2_rules)}${r.has_context ? " (文脈あり)" : ""} 「${r.text}」${flag}`);
  }
}
const w1 = worst("v1"), w2 = worst("v2");
L("");
L(`  最も見逃されやすい発話: v1「${w1?.text}」${rate(w1?.v1_miss, w1?.v1_n)} / v2「${w2?.text}」${rate(w2?.v2_miss, w2?.v2_n)}`);
L("");
L("【none・watch の段階の分布(判定回数)】  段階0 / 段階1 / 段階2 / 第三者");
for (const label of ["none", "watch"]) {
  for (const v of ["v1", "v2"]) {
    const d = stageDist(label, v);
    L(`  ${label.padEnd(5)} ${v}: ${d[0]} / ${d[1]} / ${d[2]} / ${d.third}(${d.n}判定)`);
  }
}
if (noneTo2("v2").length) { L("  v2 で none が段階2になった発話:"); for (const r of noneTo2("v2")) L(`    「${r.text}」 規則=${r.decided_by.join(",")}`); }
if (watchTo0("v2").length) { L("  v2 で watch が段階0になった発話:"); for (const r of watchTo0("v2")) L(`    「${r.text}」`); }
L("");
L("【v2 で段階を決めた規則の内訳(のべ)】");
L(`  Tier A: ${JSON.stringify(ruleCounts(by("v2").filter((r) => r.tier_a)))}`);
L(`  none/watch: ${JSON.stringify(ruleCounts(by("v2").filter((r) => !r.tier_a && r.true_label !== "crisis")))}`);
L(`  分類器の回どうしで判定が食い違った判定: ${rate(disagree.length, by("v2").length)}`);
L("");
L("【費用と待ち時間(1判定あたり。費用は本番の有料枠の料金で換算)】");
for (const v of ["v1", "v2"]) {
  const l = latency(v), c = cost(v);
  L(`  ${v}: 待ち時間 中央値${l.median}ms / 上位10% ${l.p90}ms / 最大${l.max}ms  費用 約${c.per_judgment_yen.toFixed(3)}円(呼び出し${c.calls_per_judgment.toFixed(2)}回)  分類器エラー ${errRate(v)}  モデル ${JSON.stringify(modelUse(v))}`);
}
L("  ※待ち時間は無料枠での値。無料枠は混雑で大きく遅れることがあり、本番(有料枠)より長めに出る");

const report = lines.join("\n");
console.log("\n" + report);
const base = OUT.replace(/\.jsonl$/, "");
writeFileSync(`${base}-summary.txt`, report + "\n");
writeFileSync(`${base}-summary.json`, JSON.stringify({
  set: path.relative(ROOT, SET_PATH), reps_tier_a: REPS_TIER_A, reps_other: REPS_OTHER, votes: VOTES,
  judgments_done: recs.length, judgments_planned: totalJudgments, stopped, paused,
  conditions: { classifier_model: PRIMARY_MODEL, v2_vote_timeout_ms: Number(TIMEOUT_MS) },
  criteria, tier_a: tierARows, worsened: worsened.map((r) => r.text),
  stage_distribution: { none: { v1: stageDist("none", "v1"), v2: stageDist("none", "v2") }, watch: { v1: stageDist("watch", "v1"), v2: stageDist("watch", "v2") } },
  v2_rules: { tier_a: ruleCounts(by("v2").filter((r) => r.tier_a)), others: ruleCounts(by("v2").filter((r) => !r.tier_a && r.true_label !== "crisis")) },
  v2_vote_disagreement: { n: disagree.length, of: by("v2").length },
  latency_ms: { v1: latency("v1"), v2: latency("v2") }, cost: { v1: cost("v1"), v2: cost("v2") },
  classifier_error: { v1: errRate("v1"), v2: errRate("v2") },
  models: { v1: modelUse("v1"), v2: modelUse("v2") },
}, null, 2));
console.log(`\n集計を保存しました: ${path.relative(ROOT, base)}-summary.txt / .json`);

// エクセルファイルにも書き出す(データとして使えるように。scripts/export-crisis-staged-xlsx.py。
// python3 と openpyxl が必要: pip install openpyxl)。集計は全判定シートを参照する数式で、エクセルで開くと計算される
const xl = spawnSync("python3", [path.join(__dirname, "export-crisis-staged-xlsx.py"), OUT, `--set=${SET_PATH}`], { encoding: "utf8" });
if (xl.status === 0) console.log(xl.stdout.trim());
else console.log(`エクセルファイルの書き出しに失敗しました(python3 と openpyxl が必要: pip install openpyxl): ${String(xl.stderr || xl.error?.message || "").slice(0, 300)}`);
process.exitCode = stopped ? 2 : paused ? 3 : 0;
