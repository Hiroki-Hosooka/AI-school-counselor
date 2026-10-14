// ============================================================================
//  変更の記録(docs/changelog.md)を src/version.mjs の VERSION_HISTORY から作り直す(2026年10月14日)
//  使い方: node scripts/export-changelog.mjs      (手で docs/changelog.md を直さない)
//         node scripts/export-changelog.mjs --check  (作り直しが要るかだけを確かめる。要るなら終了コード 1)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION, VERSION_HISTORY } from "../src/version.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "docs/changelog.md");

const body = `# 変更の記録(版ごと)

このファイルは \`node scripts/export-changelog.mjs\` で \`src/version.mjs\` から作ります。手で直さないでください。

- いまの版: **${APP_VERSION}**
- 版の形: 日付+その日の何回目か(a, b, c…)。修正するたびに \`src/version.mjs\` の先頭に1件足して版を上げる(CLAUDE.md 6節)
- AIの返事ごとに、その版を記録しています(\`messages.prompt_version\` = 版#プロンプトのハッシュ、\`messages.settings\` の \`app_version\`・\`commit\`)。
  管理画面(admin.html)の返事ごとの「版」の印で、どの版で出た返事かを見られます
- 「さかのぼって付けた版」は、版を付ける仕組みができる前の変更です。その頃の返事の記録には版がありません

| 版 | 日付 | 触れたところ | 変えたこと |
|---|---|---|---|
${VERSION_HISTORY.map((h) => `| ${h.version}${h.retro ? "(さかのぼって付けた版)" : ""} | ${h.date} | ${(h.areas ?? []).join("・")} | ${h.summary} |`).join("\n")}
`;

if (process.argv.includes("--check")) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (now !== body) { console.error("docs/changelog.md が src/version.mjs と合っていません。node scripts/export-changelog.mjs で作り直してください"); process.exit(1); }
  console.log("docs/changelog.md は最新です");
} else {
  fs.writeFileSync(out, body);
  console.log(`書き出しました: docs/changelog.md(いまの版 ${APP_VERSION})`);
}
