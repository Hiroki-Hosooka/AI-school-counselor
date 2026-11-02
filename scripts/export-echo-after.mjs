// ============================================================================
//  冒頭の言い直しの検証で、修正後の返事を、相談した本人が読める形に書き出す(2026年11月1日)
//
//    node scripts/export-echo-after.mjs --in=<test-api-path.mjs の --out>,... --out=<.md>
//
//  生成に失敗して固定の一言になった返事は「(生成失敗)」と印を付ける(言い直しの割合には数えていない)。
//  言い直しと判定した最初の一文には「◆言い直し」を付ける(src/flow.mjs の echoOf)。
// ============================================================================
import fs from "node:fs";
import { echoOf } from "../src/flow.mjs";

const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const files = arg("in").split(",").filter(Boolean);
const out = arg("out");
const L = ["# 冒頭の言い直しの検証: 修正後の返事(2026年11月1日)", "",
  "10/28 の5件の相談ログの生徒の発言を、修正後の版で、画面と同じ API の経路に流した返事(無料枠のテスト用キー・合成の再生。本番の生徒の会話ではない)。",
  "各ログ2回。**最終の判断は、相談した本人が読んで行う。**", "",
  "- 「◆言い直し」: 最初の一文が、相談者の直前の発言の言い直しと判定したもの(`src/flow.mjs` の `echoOf`)",
  "- 「(生成失敗)」: 無料枠の上限(429)などで生成できず、固定の一言・固定の文になった返事(危機のターンを含む)。言い直しの割合には数えていない", ""];
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (!r.name.startsWith("log-")) continue;
    L.push(`## ${r.name.replace(/^log-/, "")} (${r.rep}回目)`, "", "| # | 生徒 | AI |", "|---|---|---|");
    const users = [];
    for (const t of r.turns) {
      const chip = t.kind === "chip";
      if (!chip) users.push(t.text);
      const failed = (t.flags ?? []).some((x) => /^(生成失敗|危機の状態の生成→固定の返事で継続)/.test(String(x)));
      const replies = (t.replies ?? []).map((x, i) => {
        let s = String(x);
        if (i === 0 && !chip && !failed && echoOf(s, users).echo) s = `◆言い直し ${s}`;
        if (i === 0 && failed) s = `(生成失敗) ${s}`;
        return s;
      });
      const esc = (s) => String(s ?? "").replace(/\|/g, "｜").replace(/\n/g, "<br>");
      L.push(`| ${t.turn} | ${chip ? "〔選択肢〕" : ""}${esc(t.text)} | ${esc(replies.join("\n\n"))} |`);
    }
    L.push("");
  }
}
fs.writeFileSync(out, L.join("\n") + "\n");
console.log(`書き出し: ${out}`);
