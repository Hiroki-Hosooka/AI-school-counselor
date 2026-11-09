# docs の目次(2026年11月6日に整理)

いまも使っている文書だけを直下に置いている。役目を終えた文書(実装が済んだ提案・作業の指示書・やり残しの一覧)は `archive/` にある。
文書の中の日付は、その文書を書いた日。決まりそのものは `CLAUDE.md` が正で、ここの設計書はその理由と経緯。

## 予定と記録

| 文書 | 中身 |
|---|---|
| `backlog.md` | 優先順位つきのタスク |
| `changelog.md` | 版ごとの変更の記録(`src/version.mjs` から作る。手で直さない) |
| `project-history.md` | 経緯のまとめ(中間発表用の素材。出典つき) |
| `claude-md-history.md` | CLAUDE.md の2026年11月6日までの全文(日付つきの経緯・実測の数字)。CLAUDE.md から同じ節の番号で参照する |

## 心理士さんに見ていただくもの

| 文書 | 中身 |
|---|---|
| `psychologist-review-texts.md` | 確認していただく文面の全部(`scripts/export-review-texts.mjs` で作る) |
| `crisis-stage2-provisional-texts.md` | 危機の応答(段階ごとの応答)の仮の文面(`scripts/export-provisional-texts.mjs` で作る) |
| `psychologist-review-checklist.md` | 確認をお願いしたいことの一覧 |

## 設計(いまの動きの理由)

| 文書 | 中身 |
|---|---|
| `design-crisis-rework.md` | 危機の入り方と、危機のあとの対応の作り直し(2026年11月。いまの危機の流れ) |
| `design-crisis-flow-shima3.md` | 危機の流れの見直し(嶋先生 10/7。段階ごとの応答・否定の見分け) |
| `design-shima4-part1-topscreen.md` | チップの受け取り・状態の保存・トップ画面とインテーク(嶋先生 10/14) |
| `design-conversation-flow.md` | 会話が展開しない問題・他人事感の修正 |
| `design-echo-opening.md` | 返事の冒頭の言い直しを減らす(閾値の決め方) |
| `design-batch-messages.md` | 連投と、まとめての返事(試行中。`BATCH_MODE=on` のときだけ) |
| `crisis-keywords-v3.md` / `crisis-keywords-v3-diff.md` | 危機キーワード v3(根拠つきの表)と v2 との差分 |
| `design/` | トップ画面のデザインの元 |

## 調査と提案

| 文書 | 中身 |
|---|---|
| `generation-format-error-20261104.md` | 生成の失敗(応答形式エラー)の調査と対策 |
| `token-usage-20261103.md` | トークンの測定・減らす案・費用の上限の案(8章に案①②を試した結果) |
| `proposal-concern-personalization.md` | 「〜が心配」を生成で一人ひとりに合わせる案(まだ入れていない) |

## そのほかのフォルダ

| フォルダ | 中身 |
|---|---|
| `review-logs/` | 開発メンバーが試した相談のログ(個人を特定できる情報が無いことを確かめたものだけ) |
| `interviews/` | インタビューのまとめ(マスキング済みのものだけ) |
| `structured-source/` | 構造化面接AIの元資料 |
| `test-sets/` | テストの入力(**保留セット `*holdout*` は調整に使わない・中身を見ない**) |
| `test-results/` | テストの結果。2026年9月の古いものは `test-results/archive/2026-09/` |
| `archive/` | 役目を終えた文書。`archive/prompts/` は作業の指示書(何をどう頼まれたかの記録)、ほかに実装済みの提案・やり残しの一覧・嶋先生3回目からの変更のまとめ |
