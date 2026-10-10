# 指示書ごとの残りの確認(2026年10月10日時点)

> - 対象: ブランチ `claude/doc-review-n5v5eq`(GitHub の既定ブランチ。`main` ブランチは GitHub 上に無い)の HEAD `6632033`。
> - ローカルの clone は浅い履歴(`c1e97cb` 以降の74コミット)なので、それより前のコミットは GitHub API の一覧で確かめた。
> - 保留セット(`docs/test-sets/*holdout*`)は開いていない。保留セットの結果は CLAUDE.md・集計ファイルに書かれた集計値だけを使った。
> - コードで確かめたもの: `node scripts/test-output-check.mjs`(全件通過)、`node scripts/test-staged-response.mjs`(389件全件通過)をこの確認のときに実行した。
>   有料・無料枠の API を使うテストは実行していない(コミットされた結果ファイルとコミットメッセージで確かめた)。
> - 状態の書き方: **済** / **途中** / **未着手** / **方針が変わって不要**(人の判断で「今回はやらない」と決めたものも含む)/ **不明**。

---

## 1. docs/prompts/automated-testing-harness.md(機械だけで測る自動テスト一式。4本柱)

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| automated-testing-harness | 全体構成「設計→確認→実装を1本ずつ」 | 方針が変わって不要 | 実施メモ「とりあえず全て実装してみて下さい」の指示で4本まとめて実装(コミット `9b33c37`・`5b59299`) | なし |
| automated-testing-harness | テスト1-1 ラベル付き発話セット60件以上(crisis/watch/none 各20件以上) | 済 | `docs/test-sets/crisis-detection.json`(60→71→79→84件)。コミット `5b59299`・`693210d` | 文面は合成(`source: "synthetic"`)。指示書が参照する `docs/interview-guide.md`・検討会ログはリポジトリに無い。「実データが手に入り次第、差し替え・追加」は未着手 |
| automated-testing-harness | テスト1-2 適合率・再現率・F1/ブロック件数を別枠/誤判定の一覧 | 済 | `scripts/test-crisis-detection.mjs`、`docs/test-results/crisis-detection-summary.txt`(ブロック 0/79) | なし |
| automated-testing-harness | テスト1-3 結果を CSV/JSON で出力 | 済 | `docs/test-results/crisis-detection-*.json` | なし |
| automated-testing-harness | テスト2 禁止表現の漏れ率(10入力×10回、再生成で解消/解消せずを分ける) | 済 | `scripts/test-ng-leak-rate.mjs`、`docs/test-results/ng-leak-rate-2026-09-24T17-45-52-279Z.json`(130/130成功、NG 2/130) | ng6 の「いくらでも」誤検知(無制限の約束を断る文に当たった)を正規表現で直すかは人の判断のまま(CLAUDE.md 5.1 により変えていない) |
| automated-testing-harness | テスト3 関わりの型判定の安定性(5〜6ペルソナ×10回、多数決との一致率) | 済 | `scripts/test-relation-stability.mjs`、`docs/test-results/relation-stability-2026-09-24T17-32-11-971Z.json`(一致率 1.00) | なし |
| automated-testing-harness | テスト4 ペルソナ多ターン回帰(DB保存・admin.html で閲覧・ナレッジ世代の記録) | 済 | `scripts/test-persona-regression.mjs`(新仕様 `546948e` で15→18ペルソナに)、`docs/test-results/persona-regression-*.json`(`knowledge_version` あり) | 後述(テスト5・persona-test-followup)のとおり、テスト側の修正後に全ペルソナでの再実行(full)はしていない |
| automated-testing-harness | 横断: 無料枠は合成テストだけ・本番キーと分離 | 済 | `TEST_GEMINI_API_KEY(S)` / `TEST_GEMINI_API_KEY_PAID` / 本番 `GEMINI_API_KEY`(`scripts/_lib/test-env.mjs`、CLAUDE.md 5.10) | 本番で有料枠の請求先を設定することは利用者側の作業(docs/project-history.md 7-7) |
| automated-testing-harness | 横断: レート制限で落ちずに再試行 | 済 | コミット `3ddad4b`・`0caee38`・`dafa192`(503 で待って最大6回) | なし |
| automated-testing-harness | 横断: 実行日時と概算コストを残す | 済(一部は概算) | 予算台帳 `docs/test-results/budget-ledger.json`(コミット `2ca3908`)。テスト1は文字数からの概算(`scripts/test-crisis-detection.mjs` の `CHARS_PER_TOKEN = 1.5`) | テスト1は実際の usageMetadata を使っていない(無料枠のため ¥0 扱い) |
| automated-testing-harness | 横断: 安全フィルターの閾値を変えたらブロック率とセットで記録 | 済 | CLAUDE.md 5.11(2026年10月7日に実測値を記録。`55e4cd0`) | Tier B・第三者・危機のあとの会話を本生成で返すときのブロック率は未測定(CLAUDE.md 5.11 に明記) |

## 2. docs/prompts/structured-unstructured-merge.md(構造化面接AIとの統合)

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| merge | 確定① Tier B の二択質問をやめ、「人に言えない障壁」を探る形に | 済 | ナレッジ `D3`(`db/seed_knowledge_safety.sql`)、`src/generate.mjs` の Tier B ブロック(T27 の参照)。コミット `ff37fcc` | なし |
| merge | 確定①「一つのメッセージに詰め込まず複数ターンに分ける」 | 途中 | 段階ごとの応答(`CRISIS_RESPONSE=staged`)では1〜3通目を分け、2通目は吹き出しを間をおいて出す(CLAUDE.md 5.16・5.18) | **本番の既定(段階ごとの応答は無効)では、本人の危機は今も1通の固定応答**。分けた流れは心理士の確認待ち |
| merge | 確定② 「もう無理」「限界」を CRISIS_WORDS から外し Tier B に | 済 | コミット `ff37fcc`、`scripts/test-output-check.mjs` の Tier B ケース、その後 v2・v3 で置き換え(CLAUDE.md 5.12) | なし |
| merge | 確定②「Tier B が複数ターン積み重なったら改めて Tier A に近いかを見る」 | 途中 | 段階ごとの応答の見守り(3ターン)と `watch_repeat`(`src/crisis-response.mjs` 731行付近)、オフラインテスト(`scripts/test-staged-response.mjs` の積み重なりのケース) | **本番の既定では無効**(`stagedResponseEnabled()` が `CRISIS_RESPONSE=staged` のときだけ真)。本番では毎ターン単発で判定している |
| merge | 確定③ 7モードすべて実装 | 済 | `buildModeBlock`・`MODE_STAGE_BLOCKS`(`src/generate.mjs`)。コミット `d12a8fc` | 技法カタログ(出典 技)26件は取材で検証していない(CLAUDE.md 8節6) |
| merge | 確定④ クロージング(11章・18章) | 済 | `buildClosingBlock`・`applyClosingUpdate`。コミット `21578fc`(CLAUDE.md 5.15) | なし |
| merge | 新規: 第三者の安全への懸念(7-5) | 済 | ナレッジ `D5`・`D6`、`subject` による分岐(CLAUDE.md 5.12)。コミット `ff37fcc` | なし |
| merge | 新規: いじめ等の継続的な被害(7-6。拒否されたら一度引く) | 済 | ナレッジ `D4` | なし |
| merge | データ: 新しい出典タグ `技`・出典URLを `note` に | 済 | `db/seed_knowledge_structured.sql`(コミット `e9bb644`) | なし |
| merge | データ: モード(mode)の軸の設計 | 済 | `knowledge.mode`・`sessions.recommended_mode`(コミット `7d40864`、CLAUDE.md 5.14) | なし |
| merge | データ: インテークの保持(sessions の列) | 済 | `db/schema.sql` 9節(コミット `7d40864`) | なし |
| merge | 手順1 設計案の提示 | 済(推定) | 手順2以降が実装済み。設計案そのものは会話の中で、リポジトリには残っていない | なし |
| merge | 手順2 マイグレーション | 済 | コミット `7d40864` | なし |
| merge | 手順3 ナレッジ投入(8技法) | 済 | コミット `e9bb644`(29件) | なし |
| merge | 手順4 フェーズ0の修正+安全層テスト | 済 | コミット `ff37fcc`、`node scripts/test-output-check.mjs` 全件通過(今回も確認) | なし |
| merge | 手順5 インテークとモード判定 | 済 | コミット `f04f896`、`applyIntakeUpdate` が4項目+mode をサーバ側で確かめる | インテークで数字を答えたくない場合の扱いが無い(persona-test-followup 2-7 を参照) |
| merge | 手順6 フェーズ2(既存逐語の優先と出力例の提示) | 済(出力例の提示は不明) | コミット `d12a8fc`。retrieve の mode ブーストは +2 に抑えた(CLAUDE.md 5.14) | 「実際の出力例とともに示す」ことはリポジトリでは確かめられない |
| merge | 手順7 クロージング | 済 | コミット `21578fc` | なし |
| merge | 守ること: 技法名を出さない/箇条書きの長文をしない/内部判定を応答に含めない | 済 | `OUTPUT_NG` の技法名(SFBT・心理教育を `74f1808` で追加)、`buildSystem` の指示 | なし |

## 3. docs/prompts/structured-verification-suite.md(統合後の検証一式。5本立て)

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| verification | 前提: 実行は Gemini、評価は Claude | 済 | コミット `a01e0ae` | なし |
| verification | テスト1-1 60件以上(Tier A/B/none 各20件以上) | 済 | `docs/test-sets/crisis-detection.json`(79件→84件) | 合成データのみ |
| verification | テスト1-2 Tier A 再現率・Tier B 過剰検知・Tier A 見逃し・ブロック率 | 済 | `docs/test-results/crisis-detection-summary.txt`(見逃し 0/23・過剰 0/28・ブロック 0/79)。ただし反復で v1 に見逃しが見つかり(`crisis-detection-2-3-summary.txt`)、v2・v3 に作り直した(CLAUDE.md 5.12) | なし(v3 で Tier A の見逃し 0/220・保留セット) |
| verification | テスト1-3 Tier B の積み重なりの会話ログ5パターンでのテスト | 途中 | 当時は該当ロジックが無く「該当なし」で合意(実施メモ)。その後、段階ごとの応答で積み重なりを実装し、オフラインテスト(`test-staged-response.mjs`)とペルソナ B2 の再生(`staged-replay-20260929-r2`)で確かめた | 指示書どおりの「3ターン連続 Tier B の会話5パターン」のセットは作っていない。本番の既定では積み重なりの判定が無い |
| verification | テスト2 禁止表現(統合で足した禁止事項=技法名・「いつでも」も) | 済 | ng11〜13 を追加(`74f1808`)、130/130 完走(`fbc0c15`) | ng6 の誤検知の扱い(人の判断) |
| verification | テスト3-1 関わりの型の一致率 | 済 | 一致率 1.00(`822a7b6`) | なし |
| verification | テスト3-2 モード判定の一致率 | 済 | 0.97(`ed09f5c`・`822a7b6`)。NARRATIVE のパターンは見送り(実施メモ) | NARRATIVE を狙ったインテーク例が無い |
| verification | テスト4 インテークの完了率(4ターン以内の割合・原因の分類・4〜5のときの分岐) | 途中 | ペルソナテストに統合(`546948e`)。`intakeReport` で完了ターン・不足スロットを出す | 原因の分類(曖昧な回答か、同じ質問のくり返しか)は自動では出していない。最後の full 実行(`persona-regression-20260924190059.json`)は Turn1 固定文の不具合の前のもので「参考程度」(docs/project-history.md)。修正後の全ペルソナでの完了率は未測定 |
| verification | テスト5 ペルソナ多ターン(手詰まりの子・Tier B を続ける子を追加。15ターン・DB保存) | 途中 | 18ペルソナ(`docs/test-sets/personas.json`。A5=手詰まり、B2=Tier B の積み重なり)、`no_close_offer_after_stuck` の判定(`0a2fd55`) | テスト側の修正(1-2〜1-5、2-1、2-2)と危機の流れの見直しのあとに、全ペルソナでの実行はしていない。有料のペルソナテストは文面が決まってから1回だけ(CLAUDE.md 5.16) |
| verification | 横断: 実行日時・概算コスト/Tier A 見逃しが出たら止めて報告 | 済 | 予算台帳、2-3 の不採用(`a502e75`) | なし |
| verification | 横断(追記): 使ったモデルを各ログに記録 | 済 | コミット `8f1f39b` | なし |

## 4. docs/prompts/crisis-keywords-v3.md(危機キーワード v3)

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| keywords-v3 | 1. 今のリストとの差分を出し、消す語を一つずつ確認 | 済 | `docs/crisis-keywords-v3-diff.md`(コミット `ae111aa`)。「怒鳴られ」を外すことは人が確認(CLAUDE.md 5.12) | なし |
| keywords-v3 | 2-1 正規化(NFKC・カタカナ→ひらがな・記号/長音/小書き/促音を無視・英字略語の境界) | 済 | `src/crisis-keywords-v3.mjs`(コミット `e22ea7b`) | なし |
| keywords-v3 | 2-2 段階の床(段階1の語) | 済 | `keyword_floor`(`src/classify.mjs` の `combineStaged`) | なし |
| keywords-v3 | 2-3 根拠の記録・【要確認】を見分ける | 済 | `route.ts` の `keywordLog`(`v3:<id> …【要確認】` を safety_events に残す) | 【要確認】の語(伏せ字・俗語。アムカ・レグカ 等)は心理士の確認待ち |
| keywords-v3 | 3. 開発用の例文(表記ゆれ・誤検知・他人への暴言) | 済 | `scripts/test-crisis-keywords-v3.mjs`(コミット `72b2138`) | なし |
| keywords-v3 | 4. v2 と v3 の比較(採用の条件すべて) | 済 | `docs/test-results/crisis-keywords-v3-20261009-summary.txt`(見逃し 0、誤検知の段階2 30→12) | なし |
| keywords-v3 | 5. 保留セット v3 を別エージェントで作り、集計だけで判定 | 済 | コミット `bfefa36`・`1ab38a3`(Tier A 見逃し 0/220、none→段階2 15→9) | なし |
| keywords-v3 | 6. CLAUDE.md 5.12 に変更内容と根拠を追記 | 済 | コミット `dca23b2` | なし |
| keywords-v3 | 6.「本番(main)への反映は、検証の結果を私が確認してから」 | 不明 | 既定は v3 になった(`dca23b2`)。ただし GitHub に `main` ブランチは無く、既定ブランチは `claude/doc-review-n5v5eq`。Vercel の本番がどのコミットか、リポジトリからは確かめられない。`docs/changes-since-shima3-interview.md` 7章は「本番(main)への反映: 検証の結果を確認してから」と未済のまま | 本番に出したかを利用者が確認する |

## 5. docs/prompts/crisis-flow-shima3.md(危機の流れの見直し。嶋先生 10/7)

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| crisis-flow | 0. 前提(打ち消し・引き下がりを置き換える/「ふつうの会話に戻る」ボタンを作らない/文面は `_PROVISIONAL`/設計→確認→実装) | 済 | `docs/design-crisis-flow-shima3.md`(`bd12bec`)→ 実装 `067aaec`。CLAUDE.md 5.18 | なし |
| crisis-flow | 1-1 段階を下げる条件(A・B×1〜2 / C×1 だけ、1段階だけ、通知・記録は取り消さない、再サインで段階2に戻す) | 済(仮・既定オフ) | `src/crisis-response.mjs`、`scripts/test-staged-response.mjs`(389件通過) | 段階ごとの応答を本番で有効にするかは心理士の確認のあと |
| crisis-flow | 1-2 否定の種類 A・B・C(念押し・絶望感は数えない、記録に種類と語) | 済 | 否定のキーワード(`src/crisis-keywords-v3.mjs`)、`judgeWithdrawal`、`safety_events.negation_type/negation_words`(schema 14節)。`test:negation` 156/168(`a6ca8e6`) | 外れた12回(「死にたくない」を見守り中の分類器が新しい危機と判定)は「下げない方向の失敗なので直さない」と人が決めた |
| crisis-flow | 1-3 同じ発言に危機の語と否定(「死にたいとか冗談だよ」) | 済 | 人が決めた(通知する。比喩・強調は通知しない)。CLAUDE.md 5.18、`safety_events.figurative` | なし |
| crisis-flow | 1-4 下げたあとの応答(段階1・気づかいのカード) | 済(仮) | CLAUDE.md 5.18、オフラインテスト | 文面は心理士の確認待ち |
| crisis-flow | 2-1 スケーリングを出すとき・回数(続けて出さない) | 済(仮) | 1会話2回まで・直前がチップなら出さない(CLAUDE.md 5.18) | なし |
| crisis-flow | 2-2 AIの返事(仮) | 済(仮) | `SCALING_PROMPT_PROVISIONAL`・`SCALING_PROMPT_A_PROVISIONAL` | 心理士の確認 |
| crisis-flow | 2-3 選択肢(インテークと同じ向き・ラベル) | 済(仮) | `CHOICES_SCALING_PROVISIONAL`。向きはそろえ、ラベルは指示書のまま(2026年10月9日に人が確認。ソースのコメント) | 心理士の確認 |
| crisis-flow | 2-4 選んだあと(受け止めの一言・記録・管理画面) | 済(仮) | `SCALING_ACK_PROVISIONAL`、`safety_events.scale`、admin.html の表示(`docs/changes-since-shima3-interview.md` 2-4) | なし |
| crisis-flow | 3-1 全体の流れ(1通目→2通目→3通目→分岐→生成。AIから終わらせない) | 済(仮・既定オフ) | CLAUDE.md 5.16・5.18 | 心理士の確認 |
| crisis-flow | 3-2 2通目から「重い」を外し「心配」を使う/出力チェックに追加 | 済 | `src/crisis-texts.mjs` の `buildCrisisReply`・`CONCERN_TEXT_PROVISIONAL`、`OUTPUT_NG`(`src/safety.mjs` 243〜246行) | 「{心配なこと}」の文面は仮。本番の固定応答も同じ文面を使うので**本番の文面の確認が要る** |
| crisis-flow | 3-2 生成でのパーソナライズは実装せず、安全の担保の方法だけ提案 | 済 | `docs/proposal-concern-personalization.md` | 入れるかの判断(人) |
| crisis-flow | 3-3 3通目の候補 A・B・C(設定で切り替え) | 済(仮) | `CRISIS_STEP3_VARIANTS_PROVISIONAL`、`CRISIS_STEP3_VARIANT`(既定 A) | どれにするか心理士が決める |
| crisis-flow | 3-4 3通目の答えで分岐(前向き/どちらでもない/後ろ向き→組B→組C、共感/解決で返し方を変える) | 済(仮) | `CHOICES_B_PROVISIONAL`・`CHOICES_C_PROVISIONAL`・`CHOICE_C_ACK_PROVISIONAL`、共感/解決は `recommended_mode` に LISTEN_ONLY を含むかで判定(人が確認。`src/crisis-response.mjs` 217行) | 心理士の確認 |
| crisis-flow | 3-5 チップの共通の決まり(choices・choice_set・自由に書ける・同じ組は1回まで・記録) | 済 | schema 14節、`page.tsx` のチップ | なし |
| crisis-flow | 4-1 AIから終わらせない・AIの限界で区切らない | 済 | `AFTER_CRISIS_BLOCK_PROVISIONAL`(本番の既定でも効く。CLAUDE.md 5.17)、`OUTPUT_NG` | 指示の文面は仮のまま本番で使う(人が決めた) |
| crisis-flow | 4-2 段階ごとの終わり方(危機のあとは3案を回す) | 済(仮) | `CRISIS_ENDINGS_PROVISIONAL`、`STAGE1_CLOSING_LINE_PROVISIONAL`、`messages.ending_variant` | 心理士の確認 |
| crisis-flow | 5.「大丈夫」を文字どおりに受け取らない(指示+記録のみ) | 済 | `DAIJOUBU_RULE_PROVISIONAL`、`daijoubuYokattaNote`(route.ts) | 指示の文面は仮 |
| crisis-flow | 6. 知識ベースへの追加(提案→確認→DB) | 途中 | `db/seed_knowledge_shima3.sql`(V19〜V26・T33〜T35、T30 の書き直し。コミット `8cc4750`) | **Supabase での実行が必要**(`docs/changes-since-shima3-interview.md` 5章・7章) |
| crisis-flow | 7-1 オフラインの検証 | 済 | `scripts/test-staged-response.mjs` 389件通過(今回も確認) | なし |
| crisis-flow | 7-2 無料枠の検証(否定の検出、A の語が危機キーワードに当たらない) | 済 | `docs/test-results/crisis-negation-20261010-summary.txt`(156/168) | なし |
| crisis-flow | 7-3 有料のペルソナテスト(B6・B7・B8・B1・B5) | 未着手(予定どおり待ち) | ペルソナ B6〜B8 は `docs/test-sets/personas.json` に定義済み、判定は `test-persona-regression.mjs` 774行〜 | 心理士の確認で文面が決まってから1回だけ |
| crisis-flow | 8. 守ること/CLAUDE.md への書き足し | 済 | CLAUDE.md 5.2・5.6・5.16〜5.18(コミット `8cc4750`) | なし |

---

## 6. persona-test-followup.md(**原本はリポジトリに無い**)

> **注意**: この指示書はリポジトリにも git の履歴にも無い。項目はコミットメッセージ・コードのコメント・docs/project-history.md から組み立てたもので、**抜けている項目があるかもしれない**。
> また、コード中の出典の書き方は `persona-tests-4-5.md 2-1`・`persona-tests-4-5.md 2-2`(`db/seed_knowledge_boundaries.sql`・`src/generate.mjs`)となっており、1-x・2-x の番号がこの名前の文書のものか、`persona-tests-4-5.md` のものかは確かめられない。
> 2-4 にあたる記録は見つからなかった。

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| persona-test-followup | 第1部 1-1(推定) Turn1 を固定文にする・生成失敗を禁止表現に数えない | 済 | コミット `76e69c0`(`first_message` を `scriptedByTurn[1]` に入れる。`test-persona-regression.mjs` 290〜293行/ `generation_failed` のターンを禁止表現の判定から除外。526行)、`40600c8` のスモークで確認 | なし |
| persona-test-followup | 第1部 1-2 生成失敗率の集計 | 済 | コミット `c748bc0`(`generation_failure_stats`) | なし |
| persona-test-followup | 第1部 1-3 成立しなかった会話を「無効」にする・生徒役の失敗も再試行 | 済 | コミット `93a1975`(`invalidRun`。1006〜1021行) | なし |
| persona-test-followup | 第1部 1-4 合格条件の見直し(要約の間隔・手詰まり後の終わりの提案・秘密の約束・定型文の重複・「いつでも」の記録) | 済 | コミット `0a2fd55`(`summary_paced`、`no_close_offer_after_stuck`、`no_secret_promise`、`no_duplicate_failure_template`、`itsudemo_outside_closing`) | なし |
| persona-test-followup | 第1部 1-5 インテーク集計の矛盾 | 済 | コミット `82c69de` | なし |
| persona-test-followup | 第1部 全体: 修正後の再実行 | 未着手 | 修正後の実行は crisis2(B1・B2・B5)だけ(`persona-regression-20260926*.json`) | 全ペルソナの再実行は、心理士の確認で文面が決まってから(CLAUDE.md 5.16) |
| persona-test-followup | 2-1 秘密の約束を止める(出力チェック) | 済 | `src/safety.mjs` 234〜239行(`/誰にも言わない/`・`/絶対に(言わ\|話さ)ない/`・`/二人だけの(秘密\|話)/`・`/口外しない/`・`/秘密にする/`・`/(伝え\|連絡し\|報告し)て?お[くい]ね?/`)、`scripts/test-output-check.mjs` のケース(全件通過を今回も確認)。コミット `ed38c28` | なし |
| persona-test-followup | 2-1 できない行動を約束しない決まり(ナレッジ D7) | 途中 | `db/seed_knowledge_boundaries.sql`(D7。cat=ng・lv=3で毎回プロンプトに載る) | **本番の DB に D7 が入っているかは未確認**(2026年9月のペルソナテストの DB は169件で D3〜D7 が欠けていた可能性。`npm run check:knowledge` で確かめる)。「言わないで」と言われたときに何と返すかの文面は**心理士確認待ちで未実装**(`ed38c28`、`docs/psychologist-review-checklist.md` C-9) |
| persona-test-followup | 2-2 生成失敗: 1回の再試行・原因の記録・同じ文を続けない | 途中 | コミット `a7d8ef2`。`GENERATION_FAILURE_REPLIES`(2文)、`route.ts` 578行で `priorFailureCount` を数えて渡す | (1) **定型文は2つしかなく、`pickFailureReply` は2つ目で止まる**(`Math.min(...)`)ので、**同じ会話で3回目以降の失敗では2つ目の文がくり返される**。(2) 本番で DB に残るのは分類(`flags` の「生成失敗→固定応答で継続(不明なエラー)」等)だけで、**実際のエラー文(`failureDetail`)は route.ts で保存していない**(サーバのログだけ)。テストでは `failure_detail` を記録している。(3) 文面は「まだ案」(心理士確認待ち) |
| persona-test-followup | 2-3 分類器に文脈を渡す・恥ずかしさの慣用表現 | 方針が変わって不要 | `60c02ed` の変更は Tier A 見逃し1件で不採用(`a502e75`)。危機検知の作り直し(v2・見守り中の判定・v3)に置き換わった(CLAUDE.md 5.12・5.16) | なし |
| persona-test-followup | 2-4 | 不明 | コミット・コード・文書に「2-4」の記録が見つからない | 原本で確認が要る |
| persona-test-followup | 2-5 「いつでも」の使いすぎ | 途中 | テストで記録だけ(`itsudemo_outside_closing`。不合格にはしない)。危機のあとの指示・危機の状態の生成ではすべての「いつでも」を止める(`CRISIS_GENERATION_EXTRA_NG`、`AFTER_CRISIS_BLOCK_PROVISIONAL`) | **ふだんの会話では、`OUTPUT_NG` は `いつでも(電話\|連絡\|来て\|話しかけ\|話して)` だけ**なので、「いつでもここにいるよ」「いつでも聞くよ」「いつでも頼ってね」は今も通る(今回 `OUTPUT_NG` に直接当てて確認)。正規表現を広げるかは CLAUDE.md 5.6 により人の確認が要る |
| persona-test-followup | 2-6 2回目の来訪で前回に触れない(person_memory) | 方針が変わって不要(人の判断で今回は対応しない) | コミット `82c69de`「2回目に前回へ触れない問題自体は2-6の対象、ユーザー判断により今回は対応しない」。`buildSystem` は「自分からこのメモを詳しく話し出さない」(CLAUDE.md 5.8) | backlog 0-1 の「次の会話にそれとなく反映される」ことの確認は未済 |
| persona-test-followup | 2-7 インテークの柔軟さ(数字の質問を断られたら飛ばす) | 未着手 | `buildIntakeBlock` に「答えたくない場合」の指示が無い。`applyIntakeUpdate` は `distress_level` がそろわないと phase2 に進まない | **数字を答えない生徒は、インテークから抜けられず、同じ質問がくり返されうる**。ペルソナの full 実行でも未完了が多い(`persona-regression-20260924190059.json`。ただし Turn1 の不具合の前の結果)。直し方は CLAUDE.md 5.13(フェーズ移行のゲート)に関わるので人の確認が要る |

## 7. test1-followup.md(**原本はリポジトリに無い**)

> **注意**: この指示書はリポジトリにも git の履歴にも無い。「修正1」は `src/classify.mjs` 220行のコメントと `docs/test-sets/personas.json` の `b_group_prerequisite`、コミット `2ca3908` にだけ出てくる。修正2・修正3 にあたる記録は見つからなかった。**項目の一覧は不完全な可能性が高い。**

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| test1-followup | 修正1 分類器が失敗したら安全側(none ではなく watch)に倒す | 済 | v1: `src/classify.mjs` 217〜255行(失敗時は watch。コミット `2ca3908`)。既定の v2: `combineStaged` で分類器のエラーがあれば少なくとも段階1(`classifier_error`)。キーワード・受動パターンが当たれば段階2のまま | 実際の失敗時の動きは実測していない(テスト1では分類器エラー 0。v3 の検証でも 0/506・0/340) |
| test1-followup | 修正2・修正3 | 不明 | 記録が見つからない | 原本で確認が要る |
| test1-followup | 修正4 Tier B が複数ターン積み重なったとき | 途中 | 段階ごとの応答の見守り(3ターン)・`watch_repeat`(`src/crisis-response.mjs`)、オフラインテスト・B2 の再生 | **本番の既定(段階ごとの応答が無効)では積み重なりを見ていない**。有効にするには心理士の確認(CLAUDE.md 5.16) |
| test1-followup | 修正5 トークン数と費用の見込み | 済(一部は概算) | 予算台帳(`scripts/_lib/test-env.mjs` の `PRICING`・`budget-ledger.json`)。`test-crisis-staged.mjs` は usageMetadata から1判定あたりの円を出す(v1 約0.21円 → v2 約0.45円) | `test-crisis-detection.mjs` は文字数からの概算のまま(無料枠なので ¥0 扱い)。本番の月あたりの費用見込みの文書は見当たらない |
| test1-followup | 修正6 危機の種類ごとの窓口(設計案だけ) | 未着手 | 窓口は `src/app/page.tsx` の `HOTLINES`(5件)を種類によらず同じに出す。種類ごとの窓口の設計案はリポジトリに見当たらない(種類ごとに変えたのは「〜が心配」の文だけ。`CONCERN_TEXT_PROVISIONAL`) | 設計案を書く。番号の確認と、どの窓口を出すかは心理士・学校の確認が要る。設計案が会話の中だけで出された可能性はある(不明) |

## 8. crisis-counselor-handoff.md(**原本はリポジトリに無い**)

> **注意**: この指示書はリポジトリにも git の履歴にも無い。以下は CLAUDE.md・docs/project-history.md・コードのコメントから組み立てたもの。**項目の一覧は不完全な可能性が高い。**

| 指示書 | 項目 | 状態 | 根拠 | 残っていること |
|---|---|---|---|---|
| crisis-counselor-handoff | スクールカウンセラー(先生)に本当につなぐ仕組み | 未着手(保留のまま) | CLAUDE.md 5.16「本当に先生につなぐ機能は、学校との取り決め(10節)ができてから別に考える」。docs/project-history.md 7-4。コードに引き継ぎの機能は無い | **学校との取り決めができるまで保留**。取り決めができた記録はリポジトリに無い |
| crisis-counselor-handoff | 3通目で先生に伝える同意を取るか | 方針が変わって不要(今の形では) | 匿名で AI から先生に伝える手段が無く、「先生に伝えておくね」は D7 に反するため、同意は取らず「話してみたいか」をたずねる形にした(CLAUDE.md 5.16、`CRISIS_STEP3_VARIANTS_PROVISIONAL`)。代わりに「この画面を見せるだけでも伝わる」と伝える(`CRISIS_STEP4_PROVISIONAL`) | 引き継ぎの仕組みができたら見直す |
| crisis-counselor-handoff | 危機の通知(職員へ)の宛先と運用 | 途中 | 通知の仕組みはある(`CRISIS_WEBHOOK_URL`、本文を含めない。CLAUDE.md 5.3) | 宛先・`pending_safety` を見る人と時間帯は**学校との取り決め待ち**(backlog 0-3) |

---

## 9. 実証実験の前に必ず済ませるべきなのに、未着手(または途中)のもの

1. **危機の通知を誰が見て何をするか(学校との取り決め)** — backlog 0-3、CLAUDE.md 10節。「AIが受け止めたのに誰にも届かない、が最悪の結果」。通知の宛先・`pending_safety` を見る人と時間帯・生徒向けの説明文が無い。
2. **相談内容の保存期間・見られる人・削除の手順** — CLAUDE.md 10節「DBに書き始める前に確定させる」。リポジトリに決まった記録が無い。
3. **本番の固定応答(`CRISIS_REPLY`)の「〜が、とても心配です」の文面の確認** — 「重い」を外した新しい文は本番の既定でも使う(CLAUDE.md 5.2)のに、まだ仮(`docs/psychologist-review-checklist.md` A-1)。あわせて危機のあとの指示・「大丈夫」の指示(A-1b・A-2・A-3)も仮のまま本番で使う。
4. **本番への反映と DB の確認** — v3・新しい固定応答・出力チェックの追加が本番に出ているか不明(`main` ブランチが無い)。`db/seed_knowledge_shima3.sql` は Supabase で未実行。D3〜D7 が本番 DB にあるかも未確認(`npm run check:knowledge`)。backlog 0-1 の完了条件(1往復・キーがブラウザから見えない・person_memory の反映)の確認記録も無い。
5. **インテークで数字を答えない生徒が抜けられない**(persona-test-followup 2-7)— 敷居を下げる目的と正面からぶつかる。
6. **生成失敗の定型文が3回目以降くり返される/本番で失敗の詳しい原因が残らない**(2-2)— 嶋先生「同じメッセージが2回来ると傷つく」への対処が途中。
7. **ふだんの会話での「いつでも」の使いすぎ**(2-5)— 「いつでもここにいるよ」等が出力チェックを通る。依存を作らない(CLAUDE.md 1節)に関わる。
8. **「言わないで」と言われたときの返し方**(2-1 の残り)— 秘密の約束は止めているが、何と返すかが決まっていない。いじめの相談で起きやすい。
9. **本番の既定では Tier B の積み重なりを見ていない**(test1-followup 修正4)— 段階ごとの応答を有効にしないまま実証実験をするなら、この穴を受け入れるかを決める必要がある。
10. **修正後の全ペルソナでのテスト(テスト4/5)を回していない** — 最後の full 実行は Turn1 の不具合の前。文面が決まったら1回回す予定。
11. backlog 0-4(上限・エラー時の文面。`src/notices.mjs`)— 心理士確認待ち。
12. (指示書の外だが P0 に近いもの)backlog 1-1 ナレッジ管理画面は未着手。心理士がナレッジを直す手段が無い。

## 10. 残っているものの分け方

### 10-1. 文面の確認が要らず、すぐに直せるもの

- **2-2 の原因の記録**: `route.ts` で `generated.failureDetail` を `messages.flags`(または別の列)に残す。文面は変わらない。※エラー文に相談本文が入らないことを確かめてから。
- **2-2 のくり返し(仕組みのほう)**: 3回目以降に同じ文を出さない仕組み(例: 2つを交互に出す、3回目以降は別の扱いにする)。ただし**新しい文を足すなら**心理士の確認が要る。
- **docs の古い記述**: backlog 1-3 の「⬜ 実際のキー・DBでの実行と結果の確認」(実際には実行済み)、`docs/project-history.md` 7-5 の「引き下がりの判定(無料枠)はまだ」(`test:negation` に置き換えて実行済み)、同 7-8 の「CLAUDE.md 5.11 は暫定措置のまま」(2026年10月7日に実測値を記録済み)など。
- **本番 DB の確認**: `npm run check:knowledge` で D3〜D7・嶋先生3回目の11件の欠けを確かめ、`db/seed_knowledge_shima3.sql` を Supabase で実行する(人の作業)。
- **テスト1の費用を usageMetadata で出す**(修正5 の残り。`test-crisis-detection.mjs`)。
- 次のものは、文面の確認は要らないが **CLAUDE.md の「変えてはいけない設計判断」に関わるので人の確認が先**:
  - 2-5「いつでも」の正規表現を広げる(CLAUDE.md 5.6。広げるとクロージングの「いつでもどうぞ」を潰さないように)
  - 2-7 インテークで数字を断られたときに進める(CLAUDE.md 5.13 のフェーズ移行のゲート。`distress_level` 無しで phase2 に進めてよいか)

### 10-2. 心理士さんの確認が要るもの

- 本番の固定応答の「〜が、とても心配です」(種類ごとの文)と、危機のあとの指示・クロージングの一言・「大丈夫」の指示(checklist A-1〜A-3)
- 生成失敗の定型文(2-2。3つ目以降の文を足す場合も)と、上限・エラーの文面(`src/notices.mjs`。backlog 0-4)
- 「言わないで」と言われたときの返し方(2-1 の残り)
- 段階ごとの応答の文面すべて(1〜3通目・3通目の候補 A/B/C・組B・組C・スケーリング・終わり方)と、本番で有効にするか(→ 有効にすれば Tier B の積み重なり=修正4 も本番で効く)
- 危機キーワード v3 の【要確認】の語(伏せ字・俗語)
- 2-7 インテークで断られたときの言い方(仕組みを直すときに文面も要る)
- 危機の種類ごとの窓口(修正6)をどう出し分けるか
- 技法カタログ(出典 技)26件の言い回し、評価AIのスコアの較正(心理士の採点20件)
- 有料のペルソナテスト(B1・B5・B6〜B8)は、文面が決まってから1回だけ

### 10-3. 学校との取り決めが要るもの

- 危機の通知の宛先・見る人・時間帯・何をするか(backlog 0-3)
- 相談内容の保存期間・見られる人・削除の手順・生徒への説明(CLAUDE.md 10節)
- いじめの疑いを認知したときの対応(いじめ防止対策推進法)
- 先生(スクールカウンセラー)に本当につなぐ仕組み(crisis-counselor-handoff。取り決めができるまで保留のまま)
- 危機の種類ごとの窓口(修正6)のうち、学校の窓口を載せるかどうか
