// ============================================================================
//  会話ログの自動評価(段階A)の確かめ(2026年11月9日。docs/design-auto-eval.md)。AI も外の通信も使わない
//
//    node scripts/test-eval.mjs [--jsonl=<scripts/test-api-path.mjs --out=… の記録>]
//
//  1. コードの指標(src/eval-metrics.mjs): 手で作った会話で、指標ごとに数えられるか
//  2. 書き出し(scripts/eval/export-bundle.mjs): プロジェクトの中に書かない・版や番号が漏れない・10件ずつ part に分ける・期間の指定を断る
//  3. DB からの読み込み: 「開発メンバーのテスト」の印の無いセッションがあれば止める
//  4. 結果の確かめと集計(scripts/eval/_lib/results.mjs): 引用がログに無い・点数の形が違う・ラベルが違うものを外す。3回の真ん中の値と揺れ
//  5. 取り込みと報告(scripts/eval/import-results.mjs): 未較正の段・悪くなった印
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { conversationMetricsForEval, readFirstScore } from "../src/eval-metrics.mjs";
import { NG_FIRST_FLAG, GENERATION_FAILURE_FLAG } from "../src/generate.mjs";
import { AI_ENDING_FLAG } from "../src/flow.mjs";
import { insideProject, writeBundle, rubricText } from "./eval/export-bundle.mjs";
import { loadJsonl, loadDbSessions, renderConversation, turnsOfMarkdown } from "./eval/_lib/conversation.mjs";
import { validateResult, aggregateLog, quoteInTurn, ITEMS } from "./eval/_lib/results.mjs";
import { importBatch, buildReport } from "./eval/import-results.mjs";
import { createFakeDb } from "./_lib/fake-supabase.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log(`✗ ${name}${detail ? `  ${detail}` : ""}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));

// ---- 1. コードの指標 ----
const u = (body, extra = {}) => ({ role: "user", body, ...extra });
const a = (body, extra = {}) => ({ role: "ai", body, ...extra });
{
  const rows = [
    u("先生には言いたくない"),
    a("そっか、先生には話したくないんだね。"),
    u("うん"),
    a("無理もないよ。"),
    u("家でもしんどい"),
    a("家でもしんどいんだね。"),   // 受け止めのみ 3回目
    u("どうしたらいい"),
    a("先生に相談してみるのはどうかな?", { flags: [`${NG_FIRST_FLAG}: /(先生|親|家の人|おうちの人)(に|には)(言わ|話さ|伝え|ばら`, "1回目に検知→再生成で解消"] }), // 断った相手を勧めた・秘密の約束を止めた
    u("でも"),
    a("どんなとき?どこで?", { flags: [`${AI_ENDING_FLAG}(解消)`] }),   // 問いが2つ
    u("ねえ"),
    a("このことは二人だけの秘密にするね。", { flags: [`${NG_FIRST_FLAG}: /二人だけの(秘密|話)/`] }),   // 残った・候補
    u("もう一回"),
    a("この文は固定の文で、くり返しの確かめに使います。", { crisis: true }),
    u("また"),
    a("この文は固定の文で、くり返しの確かめに使います。", { crisis: true }),
    u("x", { flags: [`${GENERATION_FAILURE_FLAG}: 形式の崩れ(ふつう・作り直しを待つ)`] }),
    a("ok?", { flags: ["記録のみ:生成を作り直して通った(タイムアウト・形式の崩れ)"] }),
  ];
  const events = [
    { stage: 2, decided_by: ["classifier"], model_reason: "危機(根拠「死にたい」)" },           // 根拠が発言に無い
    { stage: 2, decided_by: ["keyword"], model_reason: "キーワード" },                          // キーワードは根拠ありとして数えない
    { stage: 2, decided_by: ["classifier"], model_reason: "危機" },                             // 根拠の記録なし
    { stage: 1, decided_by: ["classifier_watch"], model_reason: "気がかり" },
  ];
  const m = conversationMetricsForEval(rows, events);
  check("受け止めのみの最大連続が3", m.receive_only_max === 3, JSON.stringify(m.receive_only_max));
  check("問いが2つ以上が1", m.multi_question === 1, String(m.multi_question));
  check("同じ文の繰り返しが1", m.same_text_repeats === 1, String(m.same_text_repeats));
  check("断ったあとの再度の勧めが1", m.recommend_after_declined === 1, String(m.recommend_after_declined));
  check("秘密の約束を止めた2・残った1", m.secret_promise.stopped === 2 && m.secret_promise.remained === 1, JSON.stringify(m.secret_promise));
  check("秘密の約束の候補に、採用した返事が出る", m.secret_promise.candidates.length === 1);
  check("AIから終える形の作り直しが1", m.ai_ending_regens === 1);
  check("段階2: 3件・根拠なし1・記録なし1", m.stage2.total === 3 && m.stage2.no_evidence === 1 && m.stage2.no_record === 1, JSON.stringify(m.stage2));
  check("生成の失敗(最後)と作り直して通った", m.generation_failures.final["形式の崩れ"] === 1 && m.generation_failures.recovered["タイムアウト"] === 1, JSON.stringify(m.generation_failures));
  check("長さの比が出る", m.length_ratio.median != null && m.length_ratio.max >= m.length_ratio.median);
  check("人が先に読む目安が0より大きい", readFirstScore(m) > 0);
  const m2 = conversationMetricsForEval([u("死にたいと思うことがある"), a("話してくれてありがとう。")], [{ stage: 2, decided_by: ["classifier"], model_reason: "危機(根拠「死にたい」)" }]);
  check("根拠が発言にある段階2は数えない", m2.stage2.no_evidence === 0 && m2.stage2.total === 1);
  check("印の無い会話の人につなぐ段階は null", m2.referral === null);
  const m3 = conversationMetricsForEval([u("a"), a("b", { referral: { flagged: true, start_stage: 0, stage: 2, declined: false } })]);
  check("人につなぐ段階(始まりと終わり)", m3.referral?.start === 0 && m3.referral?.end === 2);
}

// ---- 2. 書き出し ----
check("プロジェクトの中を見分ける", insideProject(path.join(ROOT, "x/y")) && insideProject(ROOT) && !insideProject(tmp) && !insideProject(path.join(ROOT, "..")));
let convs;
const jsonl = arg("jsonl", "");
if (jsonl) {
  convs = loadJsonl(path.resolve(jsonl)).map((c, i) => ({ ...c, side: i % 2 ? "after" : "before" }));
} else {
  // 記録が無いときは手で作った会話を25件
  convs = Array.from({ length: 25 }, (_, i) => ({
    source: { kind: "jsonl", file: "test", line: i + 1 }, id: `c${i}`, side: i % 2 ? "after" : "before",
    rows: [u(`相談${i}`), a(`返事${i}です。どんなことがあったの?`, { settings: { app_version: "2026-11-09d" }, model: "m", knowledge_version: "k1" }), u("うん"), a("そっか。")],
    events: [],
  }));
}
check("書き出す会話が20件より多い(part が分かれる)", convs.length > 20, String(convs.length));
let threw = "";
try { writeBundle({ out: path.join(ROOT, "eval-out-should-fail"), batch: "t", convs, seed: 1 }); } catch (e) { threw = String(e.message); }
check("プロジェクトの中には書き出さない", /プロジェクトの外/.test(threw) && !fs.existsSync(path.join(ROOT, "eval-out-should-fail")), threw);
const out = path.join(tmp, "sc-eval");
const batchesDir = path.join(tmp, "batches");
const { items, bdir } = writeBundle({ out, batch: "test-batch", convs, seed: 7, batchesDir });
const parts = fs.readdirSync(path.join(out, "logs"));
check("10件ずつ part に分ける", parts.length === Math.ceil(convs.length / 10) && parts.every((p) => fs.readdirSync(path.join(out, "logs", p)).length <= 10), parts.join(","));
check("評価専用のフォルダの中身は rubric.md・HOW-TO-RUN.md・logs・results・.claude だけ",
  JSON.stringify(fs.readdirSync(out).sort()) === JSON.stringify([".claude", "HOW-TO-RUN.md", "logs", "results", "rubric.md"]), fs.readdirSync(out).join(","));
const settings = JSON.parse(fs.readFileSync(path.join(out, ".claude/settings.json"), "utf8"));
check("設定: 許可したもの以外は断る・コマンドと Web を止める", settings.permissions.defaultMode === "dontAsk"
  && ["Bash", "WebFetch", "WebSearch"].every((x) => settings.permissions.deny.includes(x)) && settings.permissions.allow.includes("Read(./logs/**)"));
const rub = fs.readFileSync(path.join(out, "rubric.md"), "utf8");
check("rubric.md に版・指示・9項目・ラベル", rub.startsWith("<!-- rubric-v1 -->") && ITEMS.every((it) => rub.includes(`| ${it} `)) && rub.includes("一字一句") && rub.includes("不要な危機対応"));
check("rubric.md が書き出し元と同じ", rub === rubricText());
const logsText = items.map((it) => fs.readFileSync(path.join(out, "logs", it.part, `${it.log_id}.md`), "utf8")).join("\n");
const leaks = [/20\d\d-\d\d-\d\d/, /app_version|prompt_version|knowledge_version/, /\bbefore\b|\bafter\b/, /[0-9a-f]{8}-[0-9a-f]{4}-/, /log-|chips-|intake-K/];
check("ログに版・日付・前後・セッションID・台本の名前が出ない", leaks.every((re) => !re.test(logsText)), leaks.filter((re) => re.test(logsText)).map(String).join(" "));
const mapping = JSON.parse(fs.readFileSync(path.join(bdir, "mapping.json"), "utf8"));
check("対応表はプロジェクト側にだけある", mapping.logs.length === convs.length && !fs.readdirSync(out).includes("mapping.json") && mapping.logs.every((l) => l.side));
check("順番を混ぜている(1件目が元の1件目と違う、または対応表の元の行がばらばら)", mapping.logs.some((l, i) => l.source.line !== i + 1));
const cm = JSON.parse(fs.readFileSync(path.join(bdir, "code-metrics.json"), "utf8"));
check("コードの指標をログごとに計算した", Object.keys(cm.logs).length === convs.length && Object.values(cm.logs).every((x) => typeof x.receive_only_max === "number"));
threw = "";
try { writeBundle({ out, batch: "test-batch-2", convs, seed: 1, batchesDir }); } catch (e) { threw = String(e.message); }
check("同じ評価専用のフォルダに別の束を混ぜない", /すでにログ/.test(threw), threw);
let cli = "";
try { execFileSync("node", [path.join(ROOT, "scripts/eval/export-bundle.mjs"), `--out=${path.join(tmp, "x")}`, "--since=2026-01-01"], { stdio: "pipe" }); } catch (e) { cli = String(e.stderr); }
check("期間の指定を断る", /期間での指定は受け付けません/.test(cli), cli.slice(0, 80));

// ---- 3. DB からの読み込み ----
{
  const db = createFakeDb({ knowledge: [] });
  db.tables.sessions.push({ id: "s-real", dev_test: false, is_synthetic: false }, { id: "s-dev", dev_test: true, is_synthetic: false }, { id: "s-syn", dev_test: false, is_synthetic: true });
  db.tables.messages.push({ seq: 1, session_id: "s-dev", role: "user", body: "テスト", flags: [] }, { seq: 2, session_id: "s-dev", role: "ai", body: "うん", flags: [] },
    { seq: 3, session_id: "s-real", role: "user", body: "本物", flags: [] });
  let e1 = "";
  try { await loadDbSessions(db, ["s-dev", "s-real"]); } catch (e) { e1 = String(e.message); }
  check("印の無いセッションがあれば何も読まずに止める", /印の無いセッション/.test(e1) && e1.includes("s-real"), e1);
  let e2 = "";
  try { await loadDbSessions(db, []); } catch (e) { e2 = String(e.message); }
  check("セッションIDの指定が無ければ止める", /1つずつ指定/.test(e2));
  const got = await loadDbSessions(db, ["s-dev", "s-syn"]);
  check("印のあるセッション・合成データは読める", got.length === 1 && got[0].rows.length === 2);
}

// ---- 4. 結果の確かめと集計 ----
const { markdown, turns } = renderConversation("L999", [u("最近、部活の先輩にきつく言われる"), a("先輩にきつく言われるの、どんな場面が多いかな?"), u("練習のあと"), a("練習のあとなんだね。")]);
check("書き出したログからターンを読み直せる", JSON.stringify(Object.keys(turnsOfMarkdown(markdown))) === JSON.stringify(Object.keys(turns)) && turnsOfMarkdown(markdown)[1].includes("どんな場面"));
check("引用の確かめ: 句読点のゆれ・省略を許す", quoteInTurn("先輩にきつく言われるの どんな場面", turns[1]) && quoteInTurn("先輩に…場面が多い", turns[1]) && !quoteInTurn("先生に怒られる", turns[1]));
const tl = turnsOfMarkdown(markdown);
const good = (run, over = {}) => ({
  log_id: "L999", rubric_version: "rubric-v1", run,
  scores: Object.fromEntries(ITEMS.map((it) => [it, it === "R6" ? { score: null, evidence: [], reason: "該当なし" } : { score: 3, evidence: [{ turn: 1, quote: "どんな場面が多いかな" }], reason: "" }])),
  flags: [{ turn: 2, label: "問いがない", note: "" }], ...over,
});
const v1 = validateResult(good(1), { logId: "L999", run: 1, rubricVersion: "rubric-v1", turns: tl });
check("正しい結果は通る(該当なしも)", v1.ok && v1.items.R6.na && v1.items.R1.score === 3, JSON.stringify(v1.problems));
const bad = good(1);
bad.scores.R1 = { score: 4, evidence: [{ turn: 1, quote: "言っていない言葉" }] };
bad.scores.R2 = { score: 6, evidence: [{ turn: 1, quote: "どんな場面" }] };
bad.scores.R3 = { score: 2, evidence: [] };
bad.scores.R4 = { score: 2, evidence: [{ turn: 9, quote: "x" }] };
bad.flags = [{ turn: 1, label: "冷たい" }];
const v2 = validateResult(bad, { logId: "L998", run: 2, rubricVersion: "rubric-v2", turns: tl });
check("引用がログに無い・点数の形・根拠なし・ターンが無い項目は外す", ["R1", "R2", "R3", "R4"].every((it) => !v2.items[it].valid && v2.items[it].score === null) && v2.items.R5.valid);
check("番号・版・回・ラベルの食い違いを記録する", v2.problems.length === 4 && !v2.ok, JSON.stringify(v2.problems));
const r = (run, s) => ({ run, result: validateResult(good(run, { scores: { ...good(run).scores, R1: { score: s, evidence: [{ turn: 1, quote: "どんな場面" }] } } }), { logId: "L999", run, rubricVersion: "rubric-v1", turns: tl }) });
const ag = aggregateLog([r(1, 2), r(2, 4), r(3, 3)]);
check("3回の真ん中の値と揺れ", ag.items.R1.median === 3 && ag.items.R1.unstable && ag.items.R2.median === 3 && !ag.items.R2.unstable);
check("該当なしが多数なら該当なし", ag.items.R6.median === null && ag.items.R6.na_majority);
check("2回以上付いた違和感の印", ag.flags.length === 1 && ag.flags[0].repeated && ag.flags[0].runs === 3);

// ---- 5. 取り込みと報告 ----
{
  const from = path.join(out, "results");
  const mp = JSON.parse(fs.readFileSync(path.join(bdir, "mapping.json"), "utf8"));
  for (const l of mp.logs.slice(0, 3)) {
    const tt = turnsOfMarkdown(fs.readFileSync(path.join(bdir, "logs", `${l.log_id}.md`), "utf8"));
    const t1 = Object.keys(tt).find((k) => tt[k].trim().length >= 4) ?? "1";
    const q = tt[t1].replace(/\s/g, "").slice(0, 4);
    for (let run = 1; run <= 3; run++) {
      const res = { log_id: l.log_id, rubric_version: "rubric-v1", run, scores: Object.fromEntries(ITEMS.map((it) => [it, { score: 2 + run % 3, evidence: [{ turn: Number(t1), quote: q }], reason: "" }])), flags: [] };
      fs.writeFileSync(path.join(from, `run${run}`, `${l.log_id}.json`), JSON.stringify(res));
    }
  }
  const imp = importBatch({ bdir, from, raterModel: "test-model" });
  const done = Object.values(imp.logs).filter((l) => l.ai);
  check("取り込み: 採点した3件だけに AI の点が付き、無い分を数える", done.length === 3 && imp.missing.length === (convs.length - 3) * 3, `${done.length} ${imp.missing.length}`);
  check("取り込み: 引用が通り、真ん中の値が出る", done.every((l) => l.ai.items.R1.median === 3 && !Object.keys(l.problems).length), JSON.stringify(done[0]?.problems));
  check("取り込み: 結果の控えをプロジェクト側に残す", fs.existsSync(path.join(bdir, "results-raw/run1")) && fs.readdirSync(path.join(bdir, "results-raw/run1")).length === 3);
  check("取り込み: 採点に使ったモデル・まだ使える項目が無い", imp.rater_model === "test-model" && Array.isArray(imp.validated_items) && imp.validated_items.length === 0);
  const groups = ["before", "after"].map((s) => ({ name: s, logs: Object.fromEntries(Object.entries(imp.logs).filter(([, l]) => l.side === s)) }));
  // 後の束のコードの指標をわざと悪くして、表の上に「悪くなった」が出るか
  for (const l of Object.values(groups[1].logs)) l.code_metrics = { ...l.code_metrics, receive_only_max: 9 };
  const md = buildReport("t", groups, { raterModel: "test-model", validated: [] });
  const firstRow = md.split("\n").find((x) => x.startsWith("| **悪くなった**") || x.startsWith("|  |"));
  check("報告: 悪くなった指標を表の先頭に出す", /悪くなった.*受け止めのみの最大連続/.test(firstRow ?? ""), firstRow);
  check("報告: AI の点は未較正の段に分ける", md.includes("### 未較正") && !md.includes("### 使える項目") && md.includes("すべて未較正"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail}件が通りませんでした(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
