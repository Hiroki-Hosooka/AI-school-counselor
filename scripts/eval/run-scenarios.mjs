// ============================================================================
//  会話ログの自動評価の材料を、無料枠の実際のモデルで流してためる(2026年11月13日)
//
//    node scripts/eval/run-scenarios.mjs --set=base --label=base [--scenarios=a,b] [--root=<修正前の作業コピー>]
//
//  - 台本は scripts/test-api-path.mjs のもの(合成。CLAUDE.md 5.10 の無料枠だけ)。キー TEST_GEMINI_API_KEY1..N ごとに並べて流す
//  - 結果は eval/runs/<set>/clean.jsonl(採点に回せる会話)と raw.jsonl(すべて)。**途中で止まっても、次に流すと続きから**
//    (clean.jsonl にある台本は流さない)
//  - 採点に回せる = 返事なし 0・生成に失敗したときの文が無い。外れたら、そのキーは1日の上限とみなして止め、台本は次回に回す
//  - すべてそろったら「完了」と表示する。書き出しは scripts/eval/export-bundle.mjs --jsonl=<set>:eval/runs/<set>/clean.jsonl
//  - --root: 修正前の版と比べるとき、その版の作業コピー(git worktree)で流す(台本はこのリポジトリの test-api-path.mjs を写して使う)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hasFailureText } from "./export-bundle.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

// 自動評価の台本の既定の組(合成の台本と、開発メンバーのログの生徒の発言をそのまま流すもの)
export const DEFAULT_SCENARIOS = [
  "chips-b2", "chips-b1", "typed-b2", "default-repeat", "log-16f362dd", "log-83fe3472", "log-86130eef-default",
  "log-1d0a0511-1518", "log-1d0a0511-1541", "log-1d0a0511-1547", "log-86130eef-1028", "log-55932e90",
  "intake-free", "intake-typed-label", "check-watch", "intake-K1", "intake-K3", "log-55932e90-card", "log-1d0a0511-1544",
];

export function isClean(run) {
  return (run?.metrics?.empty_replies ?? 1) === 0 && !hasFailureText(run?.stored ?? []);
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function runOne(root, key, scenario, label, out, model = "free") {
  return new Promise((resolve) => {
    const tmp = `${out}.${process.pid}.${scenario}.tmp`;
    const child = spawn(process.execPath, [path.join(root, "scripts/test-api-path.mjs"), `--model=${model}`, `--label=${label}`, `--scenarios=${scenario}`, `--out=${tmp}`],
      { cwd: root, env: { ...process.env, TEST_GEMINI_API_KEY: key }, stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", () => {
      const runs = readJsonl(tmp);
      try { fs.unlinkSync(tmp); } catch { /* 無ければよい */ }
      resolve(runs[0] ?? null);
    });
  });
}

async function main() {
  const set = arg("set");
  if (!set || !/^[\w.-]+$/.test(set)) { console.error("--set=<名前(英数字・._-)> を指定してください"); process.exit(1); }
  const label = arg("label", set);
  const scenarios = (arg("scenarios", "") || DEFAULT_SCENARIOS.join(",")).split(",").filter(Boolean);
  const root = path.resolve(arg("root", ROOT));
  if (root !== ROOT) {
    // 修正前の作業コピーにも、いまの台本と、台本が読むログを写す
    fs.copyFileSync(path.join(ROOT, "scripts/test-api-path.mjs"), path.join(root, "scripts/test-api-path.mjs"));
    for (const f of fs.readdirSync(path.join(ROOT, "docs/review-logs"))) {
      const to = path.join(root, "docs/review-logs", f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(ROOT, "docs/review-logs", f), to);
    }
    if (!fs.existsSync(path.join(root, "node_modules"))) fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"));
  }
  const dir = path.join(ROOT, "eval/runs", set);
  fs.mkdirSync(dir, { recursive: true });
  const cleanFile = path.join(dir, "clean.jsonl"), rawFile = path.join(dir, "raw.jsonl");
  const done = new Set(readJsonl(cleanFile).map((r) => r.name));
  const queue = scenarios.filter((s) => !done.has(s));
  // --model=mock は確かめ用(模擬のモデル。キーを使わない)
  const model = arg("model", "free") === "mock" ? "mock" : "free";
  const keys = model === "mock" ? ["(模擬)"] : Object.keys(process.env).filter((k) => /^TEST_GEMINI_API_KEY\d+$/.test(k)).sort().map((k) => process.env[k]).filter(Boolean);
  if (!keys.length) { console.error("TEST_GEMINI_API_KEY1.. がありません(無料枠のテスト用のキーだけを使う。CLAUDE.md 5.10)"); process.exit(1); }
  console.log(`[${set}] 済み ${done.size} / 残り ${queue.length}(キー ${keys.length}本)`);
  const worker = async (key, i) => {
    while (queue.length) {
      const sc = queue.shift();
      const run = await runOne(root, key, sc, label, rawFile, model);
      if (run) fs.appendFileSync(rawFile, JSON.stringify(run) + "\n");
      if (run && isClean(run)) {
        fs.appendFileSync(cleanFile, JSON.stringify(run) + "\n");
        console.log(`  キー${i + 1}: ${sc} … 採点に回せる`);
      } else {
        queue.push(sc);
        console.log(`  キー${i + 1}: ${sc} … 返事が届かないターンがあった(上限とみなしてこのキーを止める)`);
        return;
      }
    }
  };
  await Promise.all(keys.map((k, i) => worker(k, i)));
  const nowDone = new Set(readJsonl(cleanFile).map((r) => r.name));
  const left = scenarios.filter((s) => !nowDone.has(s));
  console.log(left.length ? `[${set}] 未完了: 残り ${left.length}(${left.join(", ")})。上限が戻ったらもう一度流す` : `[${set}] 完了: ${nowDone.size}本`);
  process.exit(left.length ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
