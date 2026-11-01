// ============================================================================
//  冒頭の言い直しの検証(2026年11月1日。相談ログのレビュー「返事の冒頭の繰り返しが、そのまますぎて不快」)
//
//    node scripts/analyze-echo.mjs [--after=<test-api-path.mjs の --out>,...] [--rate] [--out=<まとめ.txt>]
//
//  修正前: docs/review-logs/2026-10-28-*.md(本番で実際に出た返事。開発メンバーが試した相談)
//  修正後: 同じ5件の生徒の発言を、画面と同じ API の経路で流した結果(scripts/test-api-path.mjs の log-*)
//  数えるもの:
//    冒頭の言い直しの割合(src/flow.mjs の echoOf。相談者の自由に書いた発言のすぐあとの生成した返事の、最初の一文)。目安 25%以下
//    具体への言及の割合(--rate のとき。scripts/_lib/flow-rater.mjs の軽いモデルで採点。無料枠・合成データだけ)
//  最終の判断は、相談した本人が返事を読んで行う。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { echoOf, echoHistory } from "../src/flow.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const afterFiles = arg("after").split(",").filter(Boolean);
const RATE = process.argv.includes("--rate");
const outPath = arg("out");

// ---- 修正前: 相談ログ(Markdown の表)を会話の行に直す ----
const LOGS = ["1d0a0511-1518", "1d0a0511-1541", "1d0a0511-1547", "86130eef", "55932e90"];
function readReviewLog(name) {
  const lines = fs.readFileSync(path.join(ROOT, `docs/review-logs/2026-10-28-${name}.md`), "utf8").split("\n").filter((l) => /^\| \d+ \|/.test(l));
  return lines.map((l) => {
    const c = l.split(" | ");
    const who = c[1], body = String(c[2] ?? "").replace(/<br>〔.*$/s, "").replace(/<br>/g, "\n"), meta = c[3] ?? "";
    if (who.startsWith("生徒")) return { role: "user", body, ...(who.includes("選択肢") ? { choice_id: "chip" } : {}) };
    const fixed = /固定応答/.test(meta);
    const flags = /インテークの決まった問い/.test(meta) ? ["記録のみ:インテークの決まった問い"] : [];
    return { role: "ai", body, crisis: fixed, flags };
  });
}

// ---- 修正後: test-api-path.mjs の結果を会話の行に直す ----
function readAfter(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.name.startsWith("log-"))
    .map((r) => {
      const msgs = [];
      for (const t of r.turns) {
        msgs.push({ role: "user", body: t.text, ...(t.kind === "chip" ? { choice_id: t.choice_id } : {}) });
        (t.replies ?? []).forEach((x, i) => msgs.push({ role: "ai", body: x, crisis: false, flags: i === 0 ? (t.flags ?? []) : ["記録のみ:インテークの決まった問い"] }));
      }
      return { name: r.name.replace(/^log-/, "").replace(/-1028$/, ""), rep: r.rep, msgs };
    });
}

// 言い直しの数と、言い直しになった最初の一文
function echoDetail(msgs) {
  const users = [];
  let fresh = false;
  const items = [];
  for (const m of msgs) {
    if (m.role === "user") { fresh = !m.choice_id; if (fresh) users.push(m.body); continue; }
    if (!fresh) continue;
    fresh = false;
    items.push({ ...echoOf(m.body, users), user: users.at(-1) });
  }
  return items;
}

// ---- 具体への言及(軽いモデル。--rate のとき)----
async function concreteRate(convs) {
  const { rateConversation } = await import("./_lib/flow-rater.mjs");
  const { requireTestGeminiKeyPool, createKeyRotationState } = await import("./_lib/test-env.mjs");
  const pool = requireTestGeminiKeyPool(ROOT);
  const rot = createKeyRotationState();
  let yes = 0, no = 0;
  for (const c of convs) {
    const turns = [];
    let t = 0, pending = null;
    for (const m of c.msgs) {
      if (m.role === "user") { if (pending) turns.push(pending); t++; pending = { turn: t, student: m.body, counselor: null }; continue; }
      if (pending && pending.counselor == null && !m.crisis && !(m.flags ?? []).some((f) => /^(生成失敗|記録のみ:インテークの決まった問い)/.test(f))) pending.counselor = m.body;
    }
    if (pending) turns.push(pending);
    const res = await rateConversation(turns, pool, rot);
    if (!res.ok) { console.error(`採点できませんでした: ${c.name}`); continue; }
    for (const it of Object.values(res.items)) { if (it.concrete === "yes") yes++; else if (it.concrete === "no") no++; }
  }
  return { yes, no, rate: yes + no ? yes / (yes + no) : null };
}

const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };
say("冒頭の言い直しの検証(2026年11月1日)。最初の一文が、相談者の直前の発言の言い直しになっている返事の割合(目安 25%以下)");
say("判定: src/flow.mjs の echoOf(重なり7以上、または重なり5以上かつ割合40%以上、または「」で丸ごと引用)");

const groups = [["修正前(本番で実際に出た返事。docs/review-logs/2026-10-28-*)", LOGS.map((n) => ({ name: n, rep: 1, msgs: readReviewLog(n) }))]];
if (afterFiles.length) groups.push(["修正後(同じ発言を画面と同じ経路で流した。無料枠・合成)", afterFiles.flatMap(readAfter)]);
for (const [label, convs] of groups) {
  say(`\n■ ${label}`);
  let echoes = 0, total = 0, failed = 0;
  for (const c of convs) {
    const items = echoDetail(c.msgs);
    const h = echoHistory(c.msgs);
    failed += c.msgs.filter((m) => m.role === "ai" && (m.flags ?? []).some((f) => String(f).startsWith("生成失敗"))).length;
    echoes += h.filter(Boolean).length; total += h.length;
    say(`  ${c.name}#${c.rep}: ${h.filter(Boolean).length} / ${h.length}`);
    for (const it of items.filter((x) => x.echo)) say(`     - 「${it.first.slice(0, 50)}」 ← 「${String(it.user).replace(/\n/g, " ").slice(0, 40)}」(重なり ${it.shared}・${Math.round(it.ratio * 100)}%${it.quoted ? "・引用" : ""})`);
  }
  say(`  合計: ${echoes} / ${total}(${total ? Math.round((echoes / total) * 100) : "-"}%)${failed ? ` ※生成に失敗して固定の一言になった返事 ${failed}(数えていない)` : ""}`);
  if (RATE) {
    const r = await concreteRate(convs);
    say(`  具体への言及(軽いモデルの採点): ${r.yes} / ${r.yes + r.no}(${r.rate == null ? "-" : Math.round(r.rate * 100)}%)`);
  }
}
if (outPath) fs.writeFileSync(outPath, lines.join("\n") + "\n");
