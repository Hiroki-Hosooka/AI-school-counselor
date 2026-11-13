# 自動で進める作業の一覧(Claude Code のセッションが定期的に読む)

1時間ごとの予定の作業がこのファイルを読み、上から順に「未完了」のものを進める(2026年11月13日に人が頼んだ)。
Claude の利用の上限や Gemini の無料枠の1日の上限で止まっても、次の回に続きから進む。終わったら「完了」に書き換えてコミットする。
**ここに書いてよいのは、人がすでに頼んだ作業だけ**(新しい判断が要るものは、人に聞くために止める)。

## 1. 嶋先生のログレビュー5回目の修正前と修正後の比較 — 未完了

- 修正前: `git worktree add --detach <scratchpad>/wt-93440c6 93440c6`(無ければ作る)のあと
  `node scripts/eval/run-scenarios.mjs --set=shima5-before --label=before --root=<scratchpad>/wt-93440c6 --scenarios=log-55932e90-card,log-1d0a0511-1544`
- 修正後: `node scripts/eval/run-scenarios.mjs --set=shima5-after --label=after --scenarios=log-55932e90-card,log-1d0a0511-1544`
- 両方「完了」になったら: `docs/design-shima5-review.md` 6章の確かめる項目(55932e90 の 5〜6・9〜10・11・13・29ターン目、1d0a0511 の1ターン目)を読んで比べ、
  `docs/test-results/shima5-before-after-20261111.md` に足す。人に報告する

## 2. 自動評価の束(いまの版。合成の台本 19本)— 未完了

- `node scripts/eval/run-scenarios.mjs --set=after-20261113 --label=after`
- 「完了」になったら: `node scripts/eval/export-bundle.mjs --out=<scratchpad>/sc-eval-after --batch=eval-20261113-after --jsonl=after:eval/runs/after-20261113/clean.jsonl`
  (10本ずつ part に分かれる)→ zip にして人に送る。`import-results.mjs --batch=eval-20261113-after --metrics-only` の報告も添える
- 採点(Claude Code で採点する会話)は**人が手元で行う**(実装の会話とは別の会話・評価専用のフォルダ。docs/design-auto-eval.md)。ここでは採点しない

## 3. 採点の結果の取り込み — 人の結果待ち

- 人から `results/` の zip が届いたら: `node scripts/eval/import-results.mjs --batch=<束> --from=<展開した results> --rater-model=<モデル名>`。
  前の束(eval-20261111-base)と比べるときは `--compare=eval-20261111-base,eval-20261113-after`
