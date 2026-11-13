// ============================================================================
//  自動評価の材料(合成の台本の会話・会話ログ・採点用の束)を、できたそばからコミットしてプッシュする(2026年11月13日。人が頼んだ)
//
//  手元(このセッションの入れ物)にだけ残すと、入れ物が片付けられたときに消える。GitHub に置けば、いつでもダウンロードできる。
//  - 渡したパスだけをコミットする(git commit -- <パス>。作業中のほかの変更は入れない)
//  - プッシュは今いるブランチへ。ネットワークの失敗は 2・4・8・16秒あけて4回までやり直す
//  - 置いてよいのは合成の台本と開発メンバーのテストだけ(実際の生徒の会話は置かない。CLAUDE.md 8節 4)
//  - 本番のデプロイは vercel.json の ignoreCommand で、eval/ と docs/ だけの変更なら作り直さない
//  - 環境変数 EVAL_AUTOCOMMIT=off で止める(テストのとき)
// ============================================================================
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (root, args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();

export async function autoCommit(root, paths, message) {
  if (process.env.EVAL_AUTOCOMMIT === "off") return { committed: false, pushed: false, reason: "off" };
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  // ほかの git の操作と重なったら(index.lock)、少し待ってやり直す
  for (let i = 0; i < 5; i++) {
    try {
      git(root, ["add", "--", ...list]);
      const staged = git(root, ["diff", "--cached", "--name-only", "--", ...list]).trim();
      if (!staged) return { committed: false, pushed: false, reason: "変更なし" };
      git(root, ["commit", "-q", "-m", `${message}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01DHMyK7NpDqquH4NR5PtSuF`, "--", ...list]);
      break;
    } catch (e) {
      if (!/index\.lock/.test(String(e.stderr ?? e.message)) || i === 4) return { committed: false, pushed: false, reason: String(e.stderr ?? e.message).slice(0, 200) };
      await sleep(1000 * (i + 1));
    }
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  for (const wait of [0, 2000, 4000, 8000, 16000]) {
    if (wait) await sleep(wait);
    try { git(root, ["push", "-q", "-u", "origin", branch]); return { committed: true, pushed: true }; } catch { /* やり直す */ }
  }
  return { committed: true, pushed: false, reason: "プッシュに失敗(次のコミットで一緒に送る)" };
}
