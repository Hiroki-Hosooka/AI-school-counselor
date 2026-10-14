// ============================================================================
//  画面と同じ API の経路のテスト(2026年10月14日。docs/prompts/fix-after-shima4.md 1-7・docs/design-shima4-part1-topscreen.md 1-7)
//
//  「オフラインの389件のテストを通った状態で、相談ログ 86130eef の不具合が起きた」(指示書)。実際の操作の流れ
//  (チップを押す・同じ文字を打つ)と、DB の書き込み(状態の保存)を通る経路がテストに入っていなかったため。
//  route.ts の POST をそのまま呼び(画面と同じ JSON。チップは choice_id つき)、DB はメモリ上の偽物にする。
//
//  実行:
//    node scripts/test-api-path.mjs [--root=<作業ツリー>] [--constraints=v13|v14] [--model=mock|free] [--reps=1]
//                                   [--scenarios=a,b] [--label=after] [--out=docs/test-results/xxx.jsonl]
//    --root        テストする作業ツリー(既定はこのリポジトリ)。修正前は git worktree で作った別の作業ツリーを渡す
//    --constraints 偽の DB の制約。v13 = 13節の版のまま(本番の DB の制約が古い場合の再現)/ v14 = 14節の版
//    --model       mock = モデルを呼ばない(決まった返事。流れだけを確かめる)/ free = 無料枠のテスト用キー(合成の台本だけ。CLAUDE.md 5.10)
//  台本は合成。相談ログ 16f362dd(docs/review-logs/)の生徒の発言はそのまま使う。86130eef はログが届いたら台本に足す
//  (それまでは、指示書 1-1〜1-3 に書かれた操作の並びを合成した台本で代える)。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeDb } from "./_lib/fake-supabase.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const target = path.resolve(arg("root", ROOT));
const constraints = arg("constraints", "v14");
const modelMode = arg("model", "mock");
const reps = Number(arg("reps", "1"));
const label = arg("label", target === ROOT ? "after" : "before");
const only = arg("scenarios", "") ? arg("scenarios", "").split(",") : null;
const outPath = arg("out", "");

process.env.API_PATH_ROOT = target;
process.env.SUPABASE_URL = "http://fake.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.CRISIS_WEBHOOK_URL = "";
// 判定の内訳(safety・flags)を応答から読むため、開発用の表示を有効にして流す(--dev-panel=off で本番の設定の応答も確かめられる)
if (arg("dev-panel", "on") === "on") process.env.DEV_PANEL = "on"; else delete process.env.DEV_PANEL;
register(pathToFileURL(path.join(ROOT, "scripts/_lib/api-path-hooks.mjs")).href);

// ---- モデル ----
if (modelMode === "free") {
  const { requireTestGeminiKey } = await import("./_lib/test-env.mjs");
  requireTestGeminiKey(ROOT);   // GEMINI_API_KEY にテスト用キーを入れる(戻り値は使わない)
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "undefined") throw new Error("テスト用キーがありません");
} else {
  process.env.GEMINI_API_KEY = "mock";
  installMockGemini();
}

// 判定する発言(分類器・補助判定の入力の【判定する発言】)
const judgedText = (body) => {
  const t = body.contents?.[0]?.parts?.[0]?.text ?? "";
  const m = t.match(/【判定する発言】\s*([\s\S]*)$/);
  return (m ? m[1] : t).trim();
};
function installMockGemini() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const schema = body.generationConfig?.responseSchema?.properties ?? {};
    const system = body.systemInstruction?.parts?.[0]?.text ?? "";
    let out;
    if (schema.risk) {
      // 分類器: 合成の規則(ログ 86130eef のように、仲間外れ・一人の怖さの話はほとんど気がかりにする)
      const t = judgedText(body);
      out = /死にたい|消えたい|死にてえ/.test(t) ? { risk: "crisis", subject: "self", reason: "模擬" }
        : /つらい|一人|ひとり|怖い|しんどい|ハブ|無視|いなくなりたい/.test(t) ? { risk: "watch", subject: "self", reason: "模擬" }
          : { risk: "none", subject: "self", reason: "模擬" };
    } else if (schema.reply_type) {
      const t = judgedText(body);
      out = { reply_type: /なんでもない|忘れて|気にしないで/.test(t) ? "withdrawal" : "other", figurative: false, reason: "模擬" };
    } else if (schema.answer) {
      const t = judgedText(body);
      out = {
        answer: /話してみ|話せそう|いいかも/.test(t) ? "yes" : /話したくない|言いたくない|話せない|いや|無理|うっとうしい|おっくう/.test(t) ? "no" : "unclear",
        declined: [], reason: "模擬",
      };
    } else if (/人単位の記憶|引き継ぎメモ|要約/.test(system) && !/出力形式/.test(system)) {
      out = { summary: "模擬の要約" };
    } else {
      // 本生成: 最後の相談者の発言に合わせた決まった返事。「うん」だけには、わざと区切りの挨拶だけを返す(AI から終える事故の模擬)。
      // 断った相手がいるときは、わざと先生を勧める(出力チェックの模擬)。作り直しの指示が来たら、ふつうの返事にする
      const lastUser = [...(body.contents ?? [])].reverse().find((c) => c.role === "user")?.parts?.[0]?.text ?? "";
      const fixing = /修正指示/.test(system);
      let reply = `そっか、「${lastUser.slice(0, 12)}」なんだね。もう少し聞かせてくれる？`;
      // インテークで、このあとにシステムが決まった問いを続けるターン(指示どおりなら問いを書かない)
      if (/問いは書かない/.test(system)) reply = `そっか、「${lastUser.slice(0, 12)}」なんだね。`;
      if (!fixing && /相談者が断った相手/.test(system)) reply = "そっか。担任の先生に話してみるのはどうかな？";
      if (!fixing && lastUser.trim() === "うん") reply = "話してくれてありがとう。今日はゆっくり休んでね。";
      out = {
        reply, weight: "rapport", relation: "complainant", question_level: "data", role: "listen", did_summarize: false,
        hypothesis: "", why: "模擬", used: [], notes: {},
        intake: { chief_complaint_category: 1, onset_context: null, distress_level: null, user_goal: null, intake_complete: false },
      };
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      modelVersion: "mock",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

// ---- 台本 ----
// 発言: 文字列 = 書いて送る / { chip: "B2" } = 直前の返事のチップを押す / { type: "B2" } = 同じラベルを手で打つ
const CHIP = (id) => ({ chip: id });
const TYPE = (id) => ({ type: id });
function read16f() {
  const md = fs.readFileSync(path.join(ROOT, "docs/review-logs/2026-10-11-16f362dd.md"), "utf8");
  return [...md.matchAll(/^\| (\d+) \| 生徒 \| (.*?) \|/gm)].map((m) => m[2].replace(/<br>/g, "\n"));
}
const SCENARIOS = {
  // 指示書 1-1〜1-3 の操作の並び(仲間外れと一人になる怖さの相談)。ログ 86130eef が届いたら、そのままの台本に置き換える
  "chips-b2": {
    staged: true,
    turns: [
      "友達のことで", "グループでハブられてて、一人になるのが怖い", "3", "毎日一人でいるのがつらい",
      "昨日もお昼ひとりで食べてた。誰も話しかけてこない", "もう消えたい", "先生とは話したくない",
      CHIP("B2"), CHIP("C4"), "うん", "やっぱり消えたい", "冗談だよ", CHIP("S4"), "もう消えたい", "うん",
    ],
  },
  "chips-b1": {
    staged: true,
    turns: ["友達のことで", "グループでハブられてて、一人になるのが怖い", "もう消えたい", CHIP("W5"), "話したくない", CHIP("B1"), "うん", "わかんない"],
  },
  // 押さずに同じラベルを手で打つ(チップを押したときと同じ扱いになるか)
  "typed-b2": {
    staged: true,
    turns: ["友達のことで", "もう消えたい", TYPE("W1"), "先生には話したくない", TYPE("B2"), TYPE("C7"), "冗談だよ", TYPE("S2"), "うん"],
  },
  // 本番の既定(段階ごとの応答が無効): 同じ固定応答を2回出さない・断った相手を挙げない
  "default-repeat": {
    staged: false,
    turns: ["死にたい", "うん", "先生には言いたくない", "やっぱり死にたい", "うん", "死にたい", "うん"],
  },
  // 相談ログ 16f362dd の生徒の発言(チップなし。本番の既定)
  "log-16f362dd": { staged: false, turns: read16f() },
  // トップ画面のボタン(K1〜K6)→ 背景 → つらさのチップ → (4・5 のときは受け止めのターン)→ どうなれたらいいかのチップ。
  // 6 つのボタン × 何回目か(--reps=5)で、つらさ D1〜D5・ゴール H1〜H4 を回す(2026年10月14日。トップ画面)
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [`intake-K${k}`, {
    staged: false, intake: { category: k, source: "button" },
    turns: (rep) => {
      const d = ((k + rep - 2) % 5) + 1, h = ((k + rep - 2) % 4) + 1;
      return [CHIP(`K${k}`), "先週くらいから、ずっと気になってることがあって", CHIP(`D${d}`),
        ...(d >= 4 ? ["そうなんだよね"] : []), CHIP(`H${h}`), "うん、続き話してもいい?"];
    },
    expect: (rep) => ({ distress: ((k + rep - 2) % 5) + 1, goal: ((k + rep - 2) % 4) + 1 }),
  }])),
  // ボタンを押さずに、同じラベルを手で打つ(ボタンと同じに扱う)
  "intake-typed-label": { staged: false, intake: { category: 2, source: "button" }, turns: [TYPE("K2"), "テストのことで", TYPE("D2"), TYPE("H1"), "うん"] },
  // ボタンを押さずに自由に書く(主訴は AI の推定。数字で答えた場合も分類器にかけない)
  "intake-free": { staged: false, intake: { source: "estimated" }, turns: ["部活の先輩がこわくて、行きたくない", "2", "うん", CHIP("H2"), "うん"] },
};

// ---- 実行 ----
const { POST } = await import(pathToFileURL(path.join(target, "src/app/api/chat/route.ts")).href);
const { classifyLocal } = await import(pathToFileURL(path.join(ROOT, "src/classify.mjs")).href);
const { endsConversation, userSignalsEnd } = await import(pathToFileURL(path.join(ROOT, "src/flow.mjs")).href);
const { CATEGORY_CHOICES_PROVISIONAL, GOAL_CHOICES_PROVISIONAL } = await import(pathToFileURL(path.join(ROOT, "src/intake.mjs")).href);
const { declineChangesIn, declinedNg, PEOPLE_LABELS } = await import(pathToFileURL(path.join(ROOT, "src/declined.mjs")).href);

async function call(payload) {
  const res = await POST(new Request("http://local/api/chat", { method: "POST", body: JSON.stringify(payload) }));
  return { status: res.status, body: await res.json() };
}

// 固定の文の中で、断った相手を挙げているか(「カウンセラーの先生」「保健室の先生」は先生に数えない)
const PERSON_WORD = {
  teacher: /(?<!カウンセラーの|保健室の)(先生|担任)/, parent: /おうちの人|家の人|親/, counselor: /カウンセラー/, nurse: /保健室/,
};

async function runScenario(name, sc, rep) {
  const knowledge = JSON.parse(fs.readFileSync(path.join(ROOT, "db/knowledge.json"), "utf8")).map((k) => ({
    id: k.id, src: k.src, school: k.school ?? null, cat: k.cat, lv: k.lv ?? null, weight: k.w ?? "any", tags: k.tags ?? [],
    body: k.text, updated_at: "2026-10-01T00:00:00", mode: k.mode ?? null, active: true,
  }));
  // --missing16: 16節の SQL をまだ実行していない DB(主訴の出どころ・インテークの段階・1ターンごとの記録の列が無い)
  const missingColumns = arg("missing16", "") === "on" ? {
    sessions: ["chief_complaint_source", "intake_step"],
    messages: ["timings", "model", "prompt_version", "knowledge_version", "settings", "intake_step"],
  } : {};
  const db = createFakeDb({ constraints, knowledge, missingColumns });
  globalThis.__FAKE_DB__ = db;
  if (sc.staged) process.env.CRISIS_RESPONSE = "staged"; else delete process.env.CRISIS_RESPONSE;
  const clientId = `test-${name}-${rep}-${Date.now()}`;
  const start = await call({ action: "start", client_id: clientId });
  const sessionId = start.body.session?.id;
  const turns = [];
  // 最初の発言だけはトップ画面のボタン(主訴のカテゴリ)が押せる
  let lastChoices = CATEGORY_CHOICES_PROVISIONAL;
  const script = typeof sc.turns === "function" ? sc.turns(rep) : sc.turns;
  for (const [i, t] of script.entries()) {
    let text, choiceId = null, kind = "text";
    if (typeof t === "string") text = t;
    else {
      const id = t.chip ?? t.type;
      const item = (lastChoices ?? []).find((c) => c.id === id);
      if (!item) { turns.push({ turn: i + 1, error: `チップ ${id} が直前の返事にありません`, offered: (lastChoices ?? []).map((c) => c.id) }); text = id; }
      else text = item.label;
      if (!item) kind = "chip-not-offered";      // 出ていないチップのラベルを送った(自由記述として扱われるのが正しい)
      else if (t.chip) { choiceId = id; kind = "chip"; } else kind = "typed";
    }
    const r = await call({ action: "chat", client_id: clientId, session_id: sessionId, text, ...(choiceId ? { choice_id: choiceId } : {}) });
    const b = r.body;
    const replies = Array.isArray(b.replies) && b.replies.length ? b.replies.map((x) => x.body) : [b.reply];
    // チップは最後の吹き出しの下に出る(インテークの次の問いは after に続く)
    const afterWithChoices = (Array.isArray(b.after) ? b.after : []).filter((a) => Array.isArray(a.choices) && a.choices.length);
    lastChoices = afterWithChoices.length ? afterWithChoices.at(-1).choices : (b.choices ?? null);
    turns.push({
      turn: i + 1, kind, text, choice_id: choiceId, status: r.status, crisis: b.crisis === true,
      replies: [...replies, ...(Array.isArray(b.after) ? b.after.map((a) => a.body) : [])],
      card: b.card ?? null,
      choices: (lastChoices ?? []).map((c) => c.id), dev_keys: ["safety", "flags", "used", "weight", "timings"].filter((k) => k in b), classifier: b.safety?.model ?? null, stage: b.safety?.stage ?? null,
      flags: b.flags ?? [], local_stage: classifyLocal(text, "check").stage,
    });
  }
  // DB に残った記録(状態の保存の失敗など)
  const msgs = db.tables.messages.filter((m) => m.session_id === sessionId);
  const failedWrites = db.writes.filter((w) => w.error).map((w) => `${w.table}.${w.op}: ${w.error}`);
  const sess = db.tables.sessions.find((x) => x.id === sessionId) ?? null;
  const startDev = start.body.dev ?? null;
  return { name, rep, label, constraints, model: modelMode, turns, failedWrites, startDev,
    session: sess && { phase: sess.phase, intake_step: sess.intake_step, chief_complaint_category: sess.chief_complaint_category,
      chief_complaint_source: sess.chief_complaint_source, distress_level: sess.distress_level, user_goal: sess.user_goal,
      recommended_mode: sess.recommended_mode, onset_context: sess.onset_context },
    stored: msgs.map((m) => ({ role: m.role, body: m.body, crisis: m.crisis, flags: m.flags, timings: m.timings ?? null, model: m.model ?? null })) };
}

function measure(run) {
  const seen = new Set();
  let dupFixed = 0, empty = 0, aiEnded = 0, chipClassified = 0, intakeClassified = 0, fixedNoSign = 0, recommendDeclined = 0;
  const declined = new Set();
  const details = [];
  let chipMissing = 0, cardOnlyCount = 0;
  for (const t of run.turns) {
    // 台本で押すはずのチップが、直前の返事に出ていなかった(流れが台本どおりに進まなかった)
    if (t.error) { chipMissing++; details.push(`T${t.turn} ${t.error}(直前の返事のチップ: ${t.offered.join(",") || "なし"})`); continue; }
    // 生成の失敗が同じ会話で3回目以降のときは、決まりとして一言を出さずカードだけを出す(CLAUDE.md 5.11)。空の返事とは分けて数える
    const cardOnly = t.status === 200 && t.card && t.replies.length === 1 && !String(t.replies[0] ?? "").trim();
    if (cardOnly) { cardOnlyCount++; details.push(`T${t.turn} カードだけ(生成の失敗の3回目以降。${t.card})`); }
    else if (t.status !== 200 || !t.replies.length || t.replies.some((x) => !String(x ?? "").trim())) { empty++; details.push(`T${t.turn} 返事なし(${t.status})`); }
    for (const body of t.replies) {
      const k = String(body ?? "").trim();
      if (t.crisis && seen.has(k)) { dupFixed++; details.push(`T${t.turn} 同じ固定の文: ${k.slice(0, 30)}`); }
      seen.add(k);
      if (!t.crisis && endsConversation(k) && !userSignalsEnd(t.text)) { aiEnded++; details.push(`T${t.turn} AIから終える形: ${k.slice(0, 30)}`); }
      for (const p of declined) {
        const hit = declinedNg([p]).some((re) => re.test(k)) || (t.crisis && PERSON_WORD[p].test(k));
        if (hit) { recommendDeclined++; details.push(`T${t.turn} 断った相手(${PEOPLE_LABELS[p]})を勧めた: ${k.slice(0, 40)}`); }
      }
    }
    if ((t.kind === "chip" || t.kind === "typed") && t.classifier !== "チップ" && arg("dev-panel", "on") === "on") { chipClassified++; details.push(`T${t.turn} チップを分類器にかけた(${t.kind})`); }
    if (t.kind === "text" && /^[1-5]$/.test(t.text) && t.classifier !== "チップ" && arg("dev-panel", "on") === "on") { intakeClassified++; details.push(`T${t.turn} インテークの数字を分類器にかけた`); }
    if (t.crisis && t.kind === "text" && t.local_stage < 2 && t.classifier !== "crisis") fixedNoSign++;
    if (t.kind === "text") declineChangesIn(t.text).add.forEach((p) => declined.add(p));
  }
  // インテーク(トップ画面のボタン)の確かめ
  const intake = [];
  const sc = SCENARIOS[run.name];
  if (sc?.intake) {
    const s = run.session ?? {};
    const want = sc.expect ? sc.expect(run.rep) : null;
    const goalLabel = want && GOAL_CHOICES_PROVISIONAL[want.goal - 1].label;
    if (sc.intake.category && s.chief_complaint_category !== sc.intake.category) intake.push(`主訴 ${s.chief_complaint_category}(期待 ${sc.intake.category})`);
    if (s.chief_complaint_source !== sc.intake.source) intake.push(`主訴の出どころ ${s.chief_complaint_source}(期待 ${sc.intake.source})`);
    if (want && s.distress_level !== want.distress) intake.push(`つらさ ${s.distress_level}(期待 ${want.distress})`);
    if (want && s.user_goal !== goalLabel) intake.push(`ゴール ${s.user_goal}(期待 ${goalLabel})`);
    if (s.phase !== "phase2" || s.intake_step !== "done") intake.push(`インテークが終わっていない(${s.phase}/${s.intake_step})`);
    if (!Array.isArray(s.recommended_mode) || !s.recommended_mode.length) intake.push("進め方が決まっていない");
    // 同じ問いをくり返さない(主訴のボタン・つらさの問い・ゴールの問いは、それぞれ1回まで)
    const asked = (re) => run.turns.flatMap((t) => t.replies ?? []).filter((x) => re.test(String(x ?? ""))).length;
    if (asked(/どんなことで来てくれた/) > 0) intake.push("主訴をたずね直した");
    if (asked(/つらさに近いのはどれ/) > 1) intake.push("つらさの問いをくり返した");
    if (asked(/どうなれたらいいかな/) > 1) intake.push("ゴールの問いをくり返した");
    if (run.turns.slice(1).some((t) => (t.choices ?? []).some((c) => /^K\d$/.test(c)))) intake.push("主訴のボタンをもう一度出した");
    // 決まった問いが続くターンで、AI の返事にも問いがある(1回の返事に問いが2つ)
    for (const t of run.turns) {
      const n = t.replies?.length ?? 0;
      if (n >= 2 && /つらさに近いのはどれ|どうなれたらいいかな/.test(t.replies[n - 1]) && /[？?]/.test(String(t.replies[n - 2] ?? ""))) {
        intake.push(`T${t.turn} 決まった問いの前の返事にも問い: ${String(t.replies[n - 2]).slice(0, 30)}`);
      }
    }
  }
  // 本番の設定(DEV_PANEL 無し)で、開発用の値が応答に出ていないか
  const devLeak = arg("dev-panel", "on") === "off"
    ? run.turns.filter((t) => (t.dev_keys ?? []).length).map((t) => `T${t.turn} ${t.dev_keys.join(",")}`).concat(run.startDev ? ["start が dev: true"] : [])
    : [];
  details.push(...intake.map((x) => `インテーク: ${x}`), ...devLeak.map((x) => `開発用の値: ${x}`));
  return {
    intake_errors: intake.length, dev_leak: devLeak.length, card_only: cardOnlyCount,
    dup_fixed: dupFixed, empty_replies: empty, ai_ended: aiEnded, recommend_declined: recommendDeclined,
    chip_classified: chipClassified, intake_classified: intakeClassified, fixed_without_explicit_sign: fixedNoSign,
    chip_missing: chipMissing, failed_writes: run.failedWrites.length, details,
  };
}

const results = [];
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  for (let rep = 1; rep <= reps; rep++) {
    const run = await runScenario(name, sc, rep);
    const m = measure(run);
    results.push({ ...run, metrics: m });
    console.log(`\n[${label}・制約 ${constraints}・${modelMode}] ${name} #${rep}`);
    console.log(`  同じ固定の文 ${m.dup_fixed} / 返事なし ${m.empty_replies} / AIから終える ${m.ai_ended} / 断った相手を勧めた ${m.recommend_declined}` +
      ` / チップを分類器に ${m.chip_classified} / インテークの数字を分類器に ${m.intake_classified}` +
      ` / インテークの誤り ${m.intake_errors} / 開発用の値の漏れ ${m.dev_leak}` +
      ` / 押すはずのチップが無い ${m.chip_missing} / はっきりした打ち明けの無い固定の文 ${m.fixed_without_explicit_sign}(第2部で扱う) / 失敗した書き込み ${m.failed_writes}`);
    for (const d of m.details) console.log(`    ${d}`);
    if (run.failedWrites.length) console.log(`    書き込みの失敗: ${[...new Set(run.failedWrites)].slice(0, 3).join(" | ")}`);
  }
}
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.appendFileSync(path.resolve(outPath), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n記録: ${outPath}`);
}
