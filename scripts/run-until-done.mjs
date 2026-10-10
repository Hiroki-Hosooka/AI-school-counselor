// ============================================================================
//  無料枠の上限で止まったテストを、上限が戻ったら自動で続きから再開する(2026年10月11日。人の依頼)
//
//  実行:
//   node scripts/run-until-done.mjs [--max-hours=30] -- node scripts/test-safety-filter.mjs --out=docs/test-results/xxx.jsonl ...
//
//  ・「--」のあとのコマンドをそのまま実行する。終了コード 3(無料枠の上限・混雑で中断。各テストの約束)なら、
//    待ってから同じコマンドをもう一度実行する。各テストは同じ --out を渡すと続きから再開するので、
//    **必ず --out を付けて** 呼ぶこと(付けないと、毎回新しい記録から始めてしまう)
//  ・待つ時間: 1回目と2回目の中断は15分(1分あたりの上限や一時的な混雑なら、これで戻ることが多い)。
//    3回続けて中断したら、1日の上限とみなし、次のリセット(太平洋時間の0時。日本時間の16時か17時)の5分後まで待つ
//  ・終了コード 0(終わった)・2(明示的な表現の見逃し等で止めた)・それ以外のエラーは、そのまま終える(待たない)
//  ・--max-hours(既定30時間)を過ぎたら、再開をあきらめて終える
//  ・ログは標準出力にそのまま流す。長く待つので、nohup や setsid で切り離して動かすとよい
// ============================================================================

import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("使い方: node scripts/run-until-done.mjs [--max-hours=30] -- <コマンド> ...(テストには必ず --out を付ける)");
  process.exit(1);
}
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const maxHours = Number((opts.find((a) => a.startsWith("--max-hours=")) ?? "--max-hours=30").split("=")[1]);
if (!cmd.some((a) => a.startsWith("--out="))) {
  console.error("テストのコマンドに --out=<記録.jsonl> を付けてください(再開のために同じ記録を使う)");
  process.exit(1);
}

// 次の無料枠のリセット(太平洋時間の0時)。夏時間の切り替えも Intl で扱う
function nextPacificMidnight(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const sinceMidnightMs = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
  return new Date(now.getTime() - sinceMidnightMs + 24 * 3600 * 1000);
}
const jst = (d) => d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const started = Date.now();
let pausesInARow = 0;
for (let round = 1; ; round++) {
  console.log(`\n[run-until-done] ${round}回目の実行(${jst(new Date())}): ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const code = r.status ?? 1;
  if (code !== 3) {
    console.log(`[run-until-done] 終了コード ${code} で終えます(${jst(new Date())})`);
    process.exit(code);
  }
  pausesInARow++;
  const waitUntil = pausesInARow >= 3
    ? new Date(nextPacificMidnight().getTime() + 5 * 60 * 1000)
    : new Date(Date.now() + 15 * 60 * 1000);
  if (waitUntil.getTime() - started > maxHours * 3600 * 1000) {
    console.log(`[run-until-done] ${maxHours}時間を超えるので、再開をあきらめます。あとで同じコマンドを実行すると続きから再開できます`);
    process.exit(3);
  }
  console.log(`[run-until-done] 無料枠の上限・混雑で中断(${pausesInARow}回続けて)。${jst(waitUntil)} まで待って再開します`);
  while (Date.now() < waitUntil.getTime()) await sleepMs(Math.min(60_000, waitUntil.getTime() - Date.now()));
  if (pausesInARow >= 3) pausesInARow = 0; // リセットのあとは数え直す
}
