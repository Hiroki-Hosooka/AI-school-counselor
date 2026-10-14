// ============================================================================
//  版(src/version.mjs)の書き方の確かめ(オフライン。2026年10月14日)
//  修正して版を上げたら流す: node scripts/test-version.mjs
// ============================================================================
import { execFileSync } from "node:child_process";
import { APP_VERSION, VERSION_HISTORY } from "../src/version.mjs";
import { PROMPT_VERSION } from "../src/generate.mjs";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "NG  "} ${label}${!ok && detail ? ` … ${detail}` : ""}`);
  if (!ok) failed++;
};

const versions = VERSION_HISTORY.map((h) => h.version);
check("いまの版は記録の先頭", APP_VERSION === versions[0]);
check("プロンプトの版はアプリの版と同じ", PROMPT_VERSION === APP_VERSION);
check("版は重ならない", new Set(versions).size === versions.length, versions.join(","));
check("版の形は 日付+a〜z", versions.every((v) => /^\d{4}-\d{2}-\d{2}[a-z]$/.test(v)), versions.join(","));
check("版の日付と date が同じ", VERSION_HISTORY.every((h) => h.version.slice(0, 10) === h.date));
check("新しい順に並んでいる", versions.every((v, i) => i === 0 || versions[i - 1] > v));
check("どの版にも変えたことが書いてある", VERSION_HISTORY.every((h) => String(h.summary ?? "").trim().length > 0));
let changelogOk = true;
try { execFileSync(process.execPath, ["scripts/export-changelog.mjs", "--check"], { stdio: "pipe" }); } catch { changelogOk = false; }
check("docs/changelog.md が最新(node scripts/export-changelog.mjs)", changelogOk);

console.log(`\n${failed ? `失敗 ${failed}件` : "全件通過"}(いまの版 ${APP_VERSION})`);
process.exit(failed ? 1 : 0);
