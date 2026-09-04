# スクールカウンセリングAI — Next.js(Vercel)版 セットアップ

フロントエンド(React)とバックエンド(API Route)を Next.js 1つにまとめ、Vercel にデプロイする構成です。
ナレッジと会話記録は DB(Supabase Postgres)にあり、クライアントに知識も API キーも入っていません。

**2026年9月に単一HTML + Supabase Edge Function構成から移行しました。** DBはSupabaseのまま、
実行環境だけVercelに変わっています。

```
ブラウザ(page.tsx・表示のみ)
   │  fetch("/api/chat")  ※同一オリジンなのでCORS設定は不要
   ▼
Next.js Route Handler(Vercel)
   │  ・APIキーを保持して Claude を呼ぶ
   │  ・DB からナレッジを読んでプロンプトを組む
   │  ・入力フィルタ → 生成 → 出力チェック
   │  ・会話 / 見立て / 安全判定を保存
   │  ・危機判定なら人へ通知
   ▼
Postgres(Supabase。データベースとしてのみ利用)
   knowledge / sessions / messages / safety_events
```

---

## ファイル

| ファイル | 役割 |
|---|---|
| `db/schema.sql` | Supabase の SQL Editor に貼って実行 |
| `db/seed_knowledge.sql` | 同上(schema.sql の後) |
| `db/knowledge.json` | バックアップ用。DB を作り直すとき用 |
| `src/safety.mjs` | 安全層(CRISIS_WORDS/OUTPUT_NG)の共通モジュール |
| `src/app/api/chat/route.ts` | バックエンド本体。Vercelにデプロイされる |
| `src/app/page.tsx` / `layout.tsx` / `globals.css` | フロントエンド(表示のみ) |

---

## 手順

### 1. Supabase プロジェクトを作る(DBとして)

<https://supabase.com> で新規プロジェクトを作成。リージョンは Tokyo を選んでください。
Edge Function は使わないので、作るのはプロジェクトとテーブルだけです。

### 2. テーブルを作る

SQL Editor で `db/schema.sql` を実行 → 続けて `db/seed_knowledge.sql` を実行。

確認:

```sql
select src, count(*) from knowledge group by src order by 2 desc;
```

`理 54 / 石 42 / 嶋 37 / 嶋石 5 / 設 2` の計 140 件になっていれば成功です。

### 3. Vercelにデプロイする

GitHubにpushしたこのリポジトリを、Vercelのダッシュボードから「Add New... → Project」で
Importしてください。Next.jsプロジェクトなので自動検出され、ビルド設定は変更不要です。

CLIを使う場合:

```bash
npm install -g vercel
vercel login
vercel link
vercel deploy --prod
```

### 4. 環境変数を設定する

Vercelダッシュボード → Project → Settings → Environment Variables

| 名前 | 必須 | 内容 |
|---|---|---|
| `GEMINI_API_KEY` | ○ | [Google AI Studio](https://aistudio.google.com/apikey) で発行したキー(`AIza...`) |
| `SUPABASE_URL` | ○ | Supabaseダッシュボード → Project Settings → API に表示されるURL |
| `SUPABASE_SERVICE_ROLE_KEY` | ○ | 同上。`service_role` の方(anon keyではない) |
| `CRISIS_WEBHOOK_URL` | | Slack や Discord の Incoming Webhook |
| `RATE_LIMIT_PER_HOUR` | | 既定 60 |
| `ADMIN_TOKEN` | | 管理画面(`/admin.html`)の合言葉。未設定だと管理画面は常に401になり閲覧できない |
| `TEST_GEMINI_API_KEY` | | `npm run test:crisis`(docs/backlog.md 1-3)専用のGeminiキー。**Vercelには設定しない** (本番の`GEMINI_API_KEY`と分離するため。CLAUDE.md 5.10) |

使用するGeminiモデルは環境変数ではなく、`src/app/api/chat/route.ts` の `PRIMARY_MODELS`/`LITE_MODELS`
にコードで書かれています(下記参照)。

> これらの値を絶対に `NEXT_PUBLIC_` で始まる名前にしないでください。付けた瞬間ブラウザに埋め込まれ、
> 誰でも見られる状態になります(`GEMINI_API_KEY` と `SUPABASE_SERVICE_ROLE_KEY` は特に注意)。

生成モデルは2026年9月に Anthropic Claude から Google Gemini に切り替えました。プロンプトの内容や
出力JSONスキーマ、安全層(`OUTPUT_NG`/`CRISIS_WORDS`)は変更していませんが、モデルが変わると
応答の質やトーンが変わることがあります。**切り替え後は必ず実際に会話して、同調していないか・
まどろっこしくないかなどを確認してください。**

### Geminiの無料枠のレート制限に注意

Google AI Studioで発行したキーをそのまま使う場合、**無料枠は `gemini-2.5-flash` で10 RPM(1分に10回)**
しかありません。1ターンの会話で安全判定+本生成の最低2回はGemini APIを呼ぶため、実証実験で複数人が
同時に使うと簡単に上限に達し、「うまく応答できませんでした」が頻発します。

**Google Cloud のプロジェクトに請求先アカウントを紐付けてください。** 申請不要で自動的にTier 1
(`gemini-2.5-flash` で1,000 RPM)に上がります。実証実験を始める前に必ず設定してください。

レート制限による失敗と、Geminiの安全フィルタによる失敗は、`messages.flags` に
`生成失敗→固定応答で継続(レート制限(429))` / `(安全フィルタ等で応答が空)` として区別して記録されるので、
発生時はそちらで原因を確認できます。

環境変数を追加・変更したら、Vercelのデプロイを1回やり直す(Redeploy)まで反映されません。

### モデルのフォールバックと、Googleのモデル退役への対応(重要・期限あり)

`route.ts` は単一モデルではなく、モデルのリストを上から順に試すようになっています(2026年9月〜)。

- `PRIMARY_MODELS`(本生成用・品質優先): `gemini-3.5-flash` → `gemini-2.5-flash`
- `LITE_MODELS`(安全判定・人単位の記憶の要約用・軽量タスク向け): `gemini-3.5-flash-lite` → `gemini-2.5-flash-lite`

レート制限だけでなく、Googleのモデル退役(Gemini 2.0系は2026年6月1日に退役済み)にも対応するためです。

**`gemini-2.5-flash` は2026年10月16日(Vertex AI表記では10月20日)に退役予定です。** それまでに
`PRIMARY_MODELS`/`LITE_MODELS` の該当行を削除し、後継モデルに置き換えてください。全滅すると
「うまく応答できませんでした」しか返らなくなります。どのモデルが実在するかは
<https://ai.google.dev/gemini-api/docs/models> で確認してください。

---

## 端末をまたいで使う

ログインは作っていません。敷居を下げることが目的なので、名前もメールも要求しません。

代わりに、端末ごとに匿名の**引き継ぎコード**(UUID)を発行しています。
設定パネルに表示されるコードを別の端末に入力すると、同じ続きから話せます。

- 何も入力しなければ、その端末だけの匿名利用になります
- コードは名前と紐づいていないので、コードを知らない限り誰の会話かはわかりません

### 人単位の記憶(person_memory)

同じ引き継ぎコードで再訪すると、前回までの要点が短い要約(最大600字)として引き継がれます。
生の会話ログではなく、セッションが閉じるたび(または30分以上間があいたとき)に**上書きで再生成**
される要約だけです。AIは自分からこれを詳しく語らないよう指示されています(CLAUDE.md 5.8)。
「もっと詳しく覚えさせる」方向の変更は、依存を強める懸念があるため確認が必要です。

---

## 管理画面(admin.html) — 心理士向け会話ログレビュー

生徒が使う画面(`page.tsx`)とは別に、`/admin.html` という心理士専用の静的ページがあります(`public/admin.html`)。
ビルド不要・外部パッケージ不要の単一HTMLファイルで、`/api/chat` の管理者用アクション
(`admin_sessions` / `admin_session_detail`)だけを呼び出します。

**ログイン画面は作っていません(プロトタイプのため)。** 代わりに、URLのクエリ文字列に
合言葉を付けてアクセスします。

```
https://(デプロイ先のドメイン)/admin.html?token=(ADMIN_TOKEN に設定した値)
```

- `token` が空、または `ADMIN_TOKEN` と一致しない場合、サーバ側(`route.ts`)が401を返し、
  一覧・詳細のどちらも表示されません
- `ADMIN_TOKEN` を設定していない場合、この画面は誰の合言葉でも開けません(常に401)
- `noindex,nofollow` と `robots.txt` で検索エンジンからは隠していますが、**URLに合言葉が
  そのまま含まれるため、リンクやスクリーンショットを共有しないでください**

画面でできること:

- セッション一覧(新しい順 / 未評価が多い順に並べ替え、危機セッションは赤く強調表示)
- セッション詳細で会話を再生し、各AI応答について `relation`(関わりの型) / `weight`(重心) /
  `question_level`(問いの層) / `role`(役割) / `hypothesis`(仮説) / `why`(理由) /
  参照したナレッジの本文を表示
- 1〜5の評価とコメントを入力(`messages.rating` / `rating_comment`。生徒側の評価UIと同じ
  `rate` アクションを使うため、この保存自体には合言葉は不要です)
- 危機対応のターンは評価UIを表示しません(評価になじまないため)

---

## 自動テスト一式(docs/backlog.md 1-3)

ナレッジやプロンプトを変えたときに悪化していないかを、人手を介さず機械的に確認するための
テスト群。詳細仕様は `docs/prompts/automated-testing-harness.md`。4本とも実装済み。

**共通の前提**

- `TEST_GEMINI_API_KEY` は本番の `GEMINI_API_KEY` と別のキーにすること。**Vercelには設定しない。**
  無料枠のデータはGoogleの製品改善に使われるため、生徒の会話に使っている本番キーと
  混ぜてはいけない(CLAUDE.md 5.10)。`.env.local` に書くか、環境変数として渡す
- テスト2〜4はナレッジ・会話ログを読み書きするため `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  も必要(本番と同じものでよい。ナレッジは要配慮個人情報ではないため)
- レート制限(429)に当たった場合は、どのテストも間隔を空けて自動再試行する

### テスト1: 危機検知の精度測定

```bash
npm run test:crisis
```

- テストセット: `docs/test-sets/crisis-detection.json`(none/watch/crisisを各20件以上、
  計60件以上。現時点では `docs/interview-guide.md` 等の実データがリポジトリに無いため、
  CLAUDE.mdの記述を参考にした `source: "synthetic"` の合成データ。実データが手に入ったら
  差し替え・追加すること)
- 判定ロジックは `src/classify.mjs` の `classify()`。本番の `src/app/api/chat/route.ts` と
  完全に同じ関数を使うので、ここで測った数字がそのまま本番の実力になる
- 出力は `docs/test-results/crisis-detection-<実行日時>.json`。クラスごとの適合率・再現率・F1、
  **Geminiの安全フィルターにブロックされた件数(精度とは別枠)**、誤判定した発話の一覧が入る
- 安全フィルターにブロックされた場合(`[BLOCKED]`)は再試行せず、そのまま「ブロックされた」件
  として記録する(レート制限とは区別する)

このテストの結果(特にブロック率)は、`callGeminiOnce` の `safetySettings` を緩めた判断の
裏付けとして使う(CLAUDE.md 5.11)。結果を見ずに閾値だけ変更しないこと。

### テスト2: 禁止表現の漏れ率

```bash
npm run test:ng-leak
```

- 入力セット: `docs/test-sets/ng-leak-rate-inputs.json`(同調・励まし待ちの場面10種)を、
  本番と同じ `src/generate.mjs` の `generateReply()`(本生成+NG検知時の1回だけの再生成)に
  各10回通す
- 出力は `docs/test-results/ng-leak-rate-<実行日時>.json`。入力ごとの検知率、
  「1回目に検知→再生成で解消」と「再生成でも直らなかった」の内訳、直らなかった具体例が入る
- 単発生成のみでDBには書き込まない

### テスト3: 関わりの型判定の安定性

```bash
npm run test:relation-stability
```

- ペルソナセット: `docs/test-sets/relation-stability-personas.json`(6種)の初回発言を、
  同じく `generateReply()` に各10回通し、`relation` の多数決との一致率を算出する
- 出力は `docs/test-results/relation-stability-<実行日時>.json`。一致率が低い(揺れが大きい)
  ペルソナは実際に出た `relation` の並びごと記録される
- こちらもDBには書き込まない

### テスト4: ペルソナ多ターン回帰テスト

```bash
npm run test:persona-regression
# 動作確認だけなら1ペルソナ・1ターンにできる:
npm run test:persona-regression -- --persona=visitor --turns=1
```

- ペルソナ設定: `docs/test-sets/persona-regression-personas.json`(6種)
- 生徒役AI(`LITE_MODELS`。無料枠)と相談AI本体(`PRIMARY_MODELS`)を10ターン会話させ、
  本番と全く同じ形で `sessions`/`messages` に保存する。**`admin.html` から通常の会話ログと
  同様に閲覧できる**(セッション一覧から探すか、出力されたJSONの `session_id` で特定する)
- 実行時のナレッジ世代(`sessions.knowledge_version`)を記録する
- **合成データであることが分かるように、`client_id` を `TEST-PERSONA-<ペルソナ>-<実行時刻>`
  にしている。** `admin.html` のセッション一覧では先頭8文字(`client_id_short`)が
  `TEST-PER` と表示されるため、実際の生徒の匿名IDと見た目で区別できる
- **危機分岐(`classify()` が crisis を返した場合)は固定応答を会話には残すが、
  `notifyCrisis()` の呼び出しと `safety_events` への記録は行わない。** 合成ペルソナの
  発言で実在しない生徒の危機が学校スタッフに誤通知される事態を避けるための、このテスト
  スクリプト側だけの判断で、`route.ts` 本体やDBスキーマは変更していない
- `person_memory` は更新しない(一回きりの合成会話のため)

出力は `docs/test-results/persona-regression-<実行日時>.json`。各ペルソナのターン数・
危機分岐回数・フラグ発生回数・最終的な `relation` の要約が入る(詳細な発言内容は
`admin.html` 側で確認する)。

---

## 運用で毎日見るところ

### 未対応の危機イベント

```sql
select * from pending_safety;
```

**ここを見る人と時間帯を、公開前に決めてください。** AI が受け止めたのに誰にも届かない、が最悪の結果です。

確認したら:

```sql
update safety_events set handled = true, handled_by = '担当者名', handled_at = now()
where seq = 123;
```

### 通知の中身について

Webhook にはセッションIDと時刻だけを送り、**相談の本文は送っていません。**
未成年の相談内容を Slack のチャンネルに流すのは避けるべきなので、詳細は DB を見る運用にしています。

---

## ナレッジの編集

Supabase の Table Editor で `knowledge` テーブルを直接編集できます。
Route Handler は60秒キャッシュなので、**だいたい1分待てば反映されます。**
(Vercelはサーバーレスのため複数インスタンスが同時に動くことがあり、旧Edge Function構成より
反映タイミングにばらつきが出ることがあります。急ぎのときは1〜2分見ておくと安心です)

- 消したいときは削除せず `active` を `false` に
- 変更はすべて `knowledge_history` に自動で残ります

心理士の方に直接編集してもらう場合は、Supabase に閲覧者として招待するか、
専用の管理画面を別途作ってください(Table Editor は英語UIなので、後者のほうが現実的です)。

### どのナレッジが効いているか

```sql
select * from knowledge_score where used_count > 0 order by avg_rating desc nulls last;
```

### 禁止リストの効き具合

```sql
select * from flag_summary;
```

---

## 決めておく必要があること(技術ではない部分)

公開前に、これらを学校と確定させてください。**DB に書き始めてから決めると、書いたものが全部問題になります。**

- 相談内容の保存期間と、削除の手順
- `messages` を閲覧できる人の範囲
- 危機判定が出たとき、誰が、いつ見て、何をするか
- 生徒への説明(記録が残ること、危機のときは人に伝わること)

未成年の心身の状態に関する情報は要配慮個人情報にあたります。

---

## 今後の拡張

いまはタグ照合で検索しています。**ナレッジが 1000 件を超えるまで、ベクトル検索は不要です。**

必要になったら:

1. `create extension vector;`
2. `knowledge` に `embedding vector(1024)` を追加
3. `knowledge_body_idx`(全文検索)と組み合わせたハイブリッド検索に

原則(`cat = 'principle'`)と禁止(`cat = 'ng'`)は検索対象にせず、**常に全件をプロンプトに載せ続けてください。**
検索に回すと、大事な原則がその回だけ引かれない、という事故が起きます。
