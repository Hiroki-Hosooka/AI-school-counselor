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
| `db/schema.sql` | Supabase の SQL Editor に貼って実行(**スキーマ変更のたびに再実行が必要。下記参照**) |
| `db/seed_knowledge.sql` | 同上(schema.sql の後) |
| `db/seed_knowledge_structured.sql` | 同上(seed_knowledge.sql の後。構造化面接AI統合 手順3で追加した技法カタログ) |
| `db/seed_knowledge_safety.sql` | 同上(seed_knowledge_structured.sql の後。構造化面接AI統合 手順4で追加した安全層のナレッジ) |
| `db/seed_knowledge_boundaries.sql` | 同上(seed_knowledge_safety.sql の後。テスト4/5 2-1で追加した「秘密の約束をしない」ナレッジ) |
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

SQL Editor で `db/schema.sql` を実行 → 続けて `db/seed_knowledge.sql` を実行 →
続けて `db/seed_knowledge_structured.sql` を実行(構造化面接AI統合 手順3。技法カタログ) →
続けて `db/seed_knowledge_safety.sql` を実行(構造化面接AI統合 手順4。安全層のナレッジ) →
続けて `db/seed_knowledge_boundaries.sql` を実行(テスト4/5 2-1。秘密の約束をしないナレッジ)。

**既にSupabaseプロジェクトを作成済みの場合も、`db/schema.sql` は毎回必ず再実行してください。**
このファイルは `create table if not exists` / `add column if not exists` / (ビューは
`drop view if exists` + `create view`)だけで書かれているため、既存のテーブルやデータには
影響しません。逆に言うと、コード側だけ更新してSupabase側で `db/schema.sql` を再実行し忘れると、
アプリが前提にしている列やビューがまだ無い状態になり、
`column "mode" of relation "knowledge" does not exist` や
`column session_overview.phase does not exist` のような「column ... does not exist」エラーに
なります。**この種のエラーを見たら、原因を個別に調べる前に、まず最新の `db/schema.sql` の
全文をSupabaseのSQL Editorに貼って再実行してください。** それで直らない場合だけ、
他の原因を疑ってください。

確認:

```sql
select src, count(*) from knowledge group by src order by 2 desc;
```

`理 54 / 石 42 / 嶋 40 / 嶋石 5 / 設 6 / 技 26` の計 173 件になっていれば成功です。

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

#### `main` 以外のブランチ(作業ブランチ)を確認したいとき

Vercelダッシュボードでこのリポジトリを接続していれば、**`main`(Production Branch)以外の
ブランチにpushしても、Vercel側で自動的に「Preview Deployment」が作られます。** `public/admin.html`
はビルド成果物に含まれる静的ファイルの一つなので、admin.htmlだけを個別にデプロイする手順は
存在しません。アプリ全体のデプロイ(本番・プレビューのどちらでも)に自動で含まれます。

作業ブランチ用のURLは、次のいずれかで見つかります。

- Vercelダッシュボード → 対象プロジェクト → **Deployments** タブ → ブランチ名で絞り込み、
  最新のデプロイの「Visit」を開く
- GitHubのコミット一覧・PRに、Vercel Bot(GitHub連携が有効な場合)が
  「✅ Preview: `https://...`」のようなステータス・コメントを自動で付ける
- Git Branch URL(ブランチが変わってもURLが固定される。コミットのたびに変わる個別URLより
  こちらが便利):
  `https://<プロジェクト名>-git-<ブランチ名を小文字化し/と_を-に置換したもの>-<Vercelのチーム/個人アカウント名>.vercel.app`
  例: ブランチ `claude/doc-review-n5v5eq` → `...-git-claude-doc-review-n5v5eq-....vercel.app`
  (正確な値はDeploymentsの詳細画面に表示されるものを使ってください)

admin.htmlは、そのプレビューURLに `/admin.html?token=(ADMIN_TOKENの値)` を付けてアクセスします
(本番URLと同じ要領)。

**プレビューデプロイでAPIが動かない場合、まず環境変数の適用範囲を疑ってください。** Vercelの
環境変数はProduction/Preview/Developmentを別々に有効・無効にできるため、下記4.の変数を
「Production」にしか適用していないと、作業ブランチのプレビューでは `GEMINI_API_KEY` 等が
読めずAPIが失敗します(admin.html自体は開けても、会話やログ取得のAPI呼び出しがすべて
失敗する、という形で症状が出ます)。各変数の追加時に、対象環境として **Production・Preview
の両方**(できればDevelopmentも)にチェックを入れてください。

### 4. 環境変数を設定する

Vercelダッシュボード → Project → Settings → Environment Variables

| 名前 | 必須 | 内容 |
|---|---|---|
| `GEMINI_API_KEY` | ○ | [Google AI Studio](https://aistudio.google.com/apikey) で発行したキー(`AIza...`) |
| `SUPABASE_URL` | ○ | Supabaseダッシュボード → Project Settings → API に表示されるURL |
| `SUPABASE_SERVICE_ROLE_KEY` | ○ | 同上。`service_role` の方(anon keyではない) |
| `CRISIS_WEBHOOK_URL` | | Slack や Discord の Incoming Webhook |
| `RATE_LIMIT_PER_HOUR` | | 既定 60 |
| `ADMIN_TOKEN` | | 管理画面(`/admin.html`)の合言葉。未設定だと管理画面は常に401になり閲覧できない。**長く推測不能な値にすること**(例: `openssl rand -hex 16` 等で生成)。"admin"のような推測されやすい値は、生徒の危機対応記録・相談内容が漏れる直接の原因になる |
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
発生時はそちらで原因を確認できます。「不明なエラー」の場合は下記の思考トークンの問題を疑ってください。

### 「応答をJSONとして読み取れませんでした」が多発する場合(2026年9月に修正済み)

gemini-2.5/3.5系のモデルは既定で「思考(thinking)」が有効で、`thinkingConfig` を指定しないと
この思考トークンが `maxOutputTokens` の枠を消費します。分類器(200トークン)は特に影響を受けやすく、
本生成(既定1500トークン)でも思考に大半を使われて可視の応答(JSON本体)が尻切れになり、
`parseJSON()` が失敗する・応答が空になる、という不具合が起きます。

`src/classify.mjs` の `callGeminiOnce` で `generationConfig.thinkingConfig.thinkingBudget` を
`0` にして対処済みです。もし別のモデルに切り替えて同じ症状が再発したら、まずこの設定が
そのモデルでも有効か([Gemini公式ドキュメント](https://ai.google.dev/gemini-api/docs/thinking)を参照)
確認してください。

環境変数を追加・変更したら、Vercelのデプロイを1回やり直す(Redeploy)まで反映されません。

### モデルのフォールバックと、Googleのモデル退役への対応(重要・期限あり)

`route.ts` は単一モデルではなく、モデルのリストを上から順に試すようになっています(2026年9月〜)。

- `PRIMARY_MODELS`(本生成用・品質優先): `gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-2.5-flash`
- `LITE_MODELS`(安全判定・人単位の記憶の要約用・軽量タスク向け):
  `gemini-3.5-flash-lite` → `gemini-2.5-flash-lite`

レート制限だけでなく、Googleのモデル退役(Gemini 2.0系は2026年6月1日に退役済み)にも対応するためです。
一覧は、Google AI Studioの「レート制限」画面(<https://aistudio.google.com/rate-limit>)の
「テキスト出力モデル」に無料枠の割り当てがある(RPM等が `0/0` ではない)ものを、
`PRIMARY_MODELS` は通常モデル、`LITE_MODELS` は `-lite` モデルとして振り分けたものです。

**`gemini-2.5-flash` は2026年10月16日(Vertex AI表記では10月20日)に退役予定です。** それまでに
`PRIMARY_MODELS`/`LITE_MODELS` の該当行を削除し、後継モデルに置き換えてください。全滅すると
「うまく応答できませんでした」しか返らなくなります。どのモデルが実在するかは
<https://ai.google.dev/gemini-api/docs/models> で確認してください。

**`gemini-2.5-flash-lite` は、APIキー/プロジェクトによって挙動が割れています。** 2026年9月、
本番のAPIキーでは「no longer available to new users」という404を実際に受け取った一方、
Google AI Studioのレート制限画面(別プロジェクト)では無料枠の割り当てが残っていることも
確認できました。新規プロジェクトかどうかで使えるかが分かれている可能性があるため、
`LITE_MODELS` の先頭には置かず、`gemini-3.5-flash-lite` が失敗した時だけ試す2番目に
置いています(失敗しても次に自動でフォールバックするだけなので、載せておいて害はありません)。
姉妹モデルの `gemini-2.5-flash`(`PRIMARY_MODELS` 側)も同じ理由で新規ユーザー向けには
使えなくなっている可能性があります。本生成で `[HTTP_404]` のエラーが頻発する場合は、
同様に該当行の並び順や要否を見直してください(退役日を待つ必要はありません)。

`gemini-3-flash-preview` はプレビュー版ですが、無料枠での提供が確認できたため
`PRIMARY_MODELS` に追加しています(<https://ai.google.dev/gemini-api/docs/gemini-3> 参照)。
プレビュー版は仕様変更や提供終了が急に起こり得るので、動作がおかしくなったら真っ先に疑ってください。

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

**認証はログインフォームです(URLにトークンは付けません)。** `/admin.html` を開くと
合言葉の入力欄が表示されるので、`ADMIN_TOKEN` に設定した値を入力してください。

```
https://(デプロイ先のドメイン)/admin.html
```

- 入力した合言葉は `sessionStorage` に保存され、同じタブを開いている間は再入力を
  求めません(タブを閉じる、または合言葉が間違っていると判明した時点で消えます)。
  URLの履歴・共有スクリーンショットに合言葉が残ることはありません
- 合言葉が空、または `ADMIN_TOKEN` と一致しない場合、サーバ側(`route.ts`)が401を返し、
  一覧・詳細のどちらも表示されません(ログインフォームに戻ります)
- `ADMIN_TOKEN` を設定していない場合、この画面は誰の合言葉でも開けません(常に401)
- `noindex,nofollow` と `robots.txt` で検索エンジンからは隠していますが、**画面には
  生徒の相談内容がそのまま表示されるため、スクリーンショットや画面の共有をしないでください**
- 生徒側画面(`page.tsx`)の「設定と記録」パネル最下部に、`/admin.html`への小さなリンク
  「スタッフ用ページ」がある(すぐ辿り着けるようにするための暫定対応。将来は別URLへ
  切り出す想定)。合言葉は埋め込んでいないが、URLの存在は生徒からも見える状態になるため、
  `ADMIN_TOKEN` を推測されやすい値にしないことが一層重要

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
テスト群。もともとの4本の詳細仕様は `docs/prompts/automated-testing-harness.md`、
構造化面接AI統合後に更新した5本の仕様(Tier A/B分離の妥当性、インテーク完了率等を追加)は
`docs/prompts/structured-verification-suite.md`。**このテスト一式は基本的に人(あなた)が
自分のAPIキーで実行するためのものです。** Claude(AI)自身は本番相当のGeminiキーを
持たないサンドボックスで作業しているため、これらのテストを実際には実行できません
(コードのロジック検証は、モックデータを使ったオフライン確認にとどまります)。

**実行環境の準備(初回だけ)**

```bash
cp .env.example .env.local
# .env.local を開いて、TEST_GEMINI_API_KEY(と、テスト2以降で使うSUPABASE_URL/
# SUPABASE_SERVICE_ROLE_KEY)を埋める。GEMINI_API_KEY(本番用)は無くてもテストは動く
```

あとは下記の `npm run test:xxx` を打つだけです。一度キーを埋めれば、以降は
コマンド一つで最後まで自動で進みます(人がキーを入力する以外、途中で操作は要りません)。
5本まとめて順に流したい場合は `npm run test:all`(危機検知→禁止表現→型判定→
ペルソナ回帰の順。一番時間のかかるペルソナ回帰は最後に実行される)。

**共通の前提**

- `TEST_GEMINI_API_KEY` は本番の `GEMINI_API_KEY` と別のキーにすること。**Vercelには設定しない。**
  無料枠のデータはGoogleの製品改善に使われるため、生徒の会話に使っている本番キーと
  混ぜてはいけない(CLAUDE.md 5.10)。`.env.local` に書くか、環境変数として渡す
- テスト2〜4はナレッジ・会話ログを読み書きするため `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  も必要(本番と同じものでよい。ナレッジは要配慮個人情報ではないため)
- レート制限(429)に当たった場合は、どのテストも間隔を空けて自動再試行する
- **どのテストも、結果のJSONに集計値だけでなく全試行の生の入出力を残す**
  (`all_results`/`attempts` 等のキー。「正しく判定できた分」も含めて、何を入れたら
  何が返ってきたかを後から全件読めるようにするため。2026年9月に対応)
- **どのテストも、実際に応答したモデルIDを記録する**(`used_model`と、テストごとの
  `model_usage`キー)。`PRIMARY_MODELS`/`LITE_MODELS`(CLAUDE.md 第2節)はあくまで
  「上から順に試す」設定であり、無料枠のレート制限やモデル退役で2番目以降のモデルに
  実際にフォールバックすることがある。集計値の`model_usage.counts`とコンソール出力の
  両方で、設定した1番目のモデル以外が0件でないか(=実行中にフォールバックが実際に
  発生したか)を確認できる。全モデルが失敗した場合は`used_model`が`null`になる
  (2026年9月に対応)

### テスト1: 危機検知の精度測定・Tier A/B分離の妥当性

```bash
npm run test:crisis
```

- テストセット: `docs/test-sets/crisis-detection.json`(none/watch/crisisを各20件以上、
  計84件。現時点では `docs/interview-guide.md` 等の実データがリポジトリに無いため、
  CLAUDE.mdの記述を参考にした `source: "synthetic"` の合成データが中心。実データが手に入ったら
  差し替え・追加すること)
- 保留セット: 危機判定の変更の**採否を判定するときだけ**使い、変更の設計・調整には使わない
  (調整に使った時点で、未知の発話への強さを測れなくなる)。
  - `docs/test-sets/crisis-detection-holdout-v2.json`(45件・2026年9月25日)が現在の保留セット。
    実装を見ない別のエージェントが作成し、実装する側は中身を見ずに保管している。危機検知の
    作り直し(第1段階・第2段階)の最終的な採否の判断にだけ使う
  - `docs/test-sets/crisis-detection-holdout.json`(30件)は、2-3の採否判定で結果を見たため、
    今は開発中の確認用。採否の判定には使わない
- 危機検知は v2 が既定(2026年9月26日に採用)。今までの判定(v1)を測るときは、同じコマンドを
  `CRISIS_DETECTION=v1 npm run test:crisis` で実行する。v1 と v2 を同じ条件で比べるときは
  `node scripts/test-crisis-staged.mjs`(発言ごとに v1・v2 を交互に判定し、Tier A は各10回・
  ほかは各3回。発言ごとの見逃し率・段階の分布・判定を決めた規則・費用と待ち時間を集計する。
  無料枠の1日の上限に当たったら中断し、`--out=` に同じ記録ファイルを渡すと続きから再開できる)。
  結果は記録(.jsonl)・集計(-summary.txt / .json)に加えて、**エクセルファイル(.xlsx)**にも書き出す
  (`scripts/export-crisis-staged-xlsx.py`。python3 と openpyxl が必要: `pip install openpyxl`)。
  シートは「概要」(採用の条件など)・「発話ごと」・「全判定」(1判定=1行)・「説明」で、集計は
  「全判定」を参照する数式になっている。記録ファイルから作り直すときは
  `python3 scripts/export-crisis-staged-xlsx.py <記録.jsonl> --set=<テストセット.json>`
- **段階ごとの応答(危機検知の作り直し 第2段階。仮の文面・心理士の確認待ち。CLAUDE.md 5.16)** は、
  設定 `CRISIS_RESPONSE=staged` のときだけ動く(**本番では設定しない**。Vercel ではプレビュー環境にだけ設定して試す)。
  有効にする前に `db/schema.sql` の11節を Supabase の SQL エディタで実行する。
  - 状態の移り変わり(見守り・分けて出す危機の応答・打ち消し など)のオフラインのテスト:
    `npm run test:staged-response`(API・DB は使わない)
  - 打ち消しの判定の検証(無料枠): `npm run test:retraction`(開発用の文
    `docs/test-sets/crisis-retraction-dev.json`)。最終判定は `node scripts/test-crisis-retraction.mjs --holdout`
    (保留セット v2 の打ち消し・念押しを、危機の応答の1通目のあとの状態で判定の流れ全体に通す)。
    打ち消しではない文を打ち消しとして扱ったら、その時点で止まる。結果はエクセルにも書き出す
  - ペルソナでの確認: `CRISIS_RESPONSE=staged node scripts/test-persona-regression.mjs --stage=crisis2`
    (B1・B2・B5。相談AI本体は課金キー)
  - 仮の文面を心理士さんに見てもらう文書: `docs/crisis-stage2-provisional-texts.md`
    (文面を変えたら `node scripts/export-provisional-texts.mjs` で作り直す)
- **分類器の判定は毎回ぶれる。** 1回の実行で見逃しが0件でも、見逃しが無いとは言えない
  (2026年9月25日、1回では0件だった項目が20回中8回見逃されていた。
  `docs/test-results/crisis-detection-2-3-summary.txt`)。変更の採否を判定するときは複数回実行する
- 判定ロジックは `src/classify.mjs` の `classify()`。本番の `src/app/api/chat/route.ts` と
  完全に同じ関数を使うので、ここで測った数字がそのまま本番の実力になる
- 出力は `docs/test-results/crisis-detection-<実行日時>.json`。クラスごとの適合率・再現率・F1、
  **Geminiの安全フィルターにブロックされた件数(精度とは別枠)**、誤判定した発話の一覧に加え、
  2026年9月から `risk`/`subject` を合成した「Tier A」(`risk==="crisis" && subject==="self"`。
  CLAUDE.md 5.12)軸での **Tier A再現率・Tier A見逃し件数(0件が目標)・Tier B→Tier A
  過剰検知率** が入る(`tier_ab` キー)。全件の生の判定結果は `all_results` キーに入る
  (各件に実際に判定したモデルID `used_model` も含む。`model_usage` キーでモデルごとの
  使用件数を集計できる)
- 安全フィルターにブロックされた場合(`[BLOCKED]`)は再試行せず、そのまま「ブロックされた」件
  として記録する(レート制限とは区別する)
- **Tier Aの見逃しが1件でもあれば、他のテストより優先して確認すること**
  (`docs/prompts/structured-verification-suite.md` 参照)

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
  (各試行 `attempts` に採用された返答を生成したモデルID `used_model` を含む。
  `model_usage` キーで全体の使用件数を集計できる)
- 単発生成のみでDBには書き込まない

### テスト3: 関わりの型・モード判定の安定性

```bash
npm run test:relation-stability
# 片方だけ実行したい場合:
npm run test:relation-stability -- --skip-mode      # 関わりの型のみ
npm run test:relation-stability -- --skip-relation  # モード判定のみ
```

2本立て(2026年9月、検証一式テスト3でモード判定を追加)。

1. **関わりの型**: `docs/test-sets/relation-stability-personas.json`(6種)の初回発言を、
   `generateReply()` に各10回通し、`relation` の多数決との一致率を算出する
2. **モード判定**: `docs/test-sets/mode-stability-intakes.json`(6種。CBT/SFBT/ASSERTION/
   LISTEN_ONLY/PROBLEM_SOLVING/PSYCHOEDUCATIONをそれぞれ狙ったインテーク4ターン分の会話)を、
   `phase: "intake"` のまま `generateReply()` に各10回通す。`recommended_mode`(複合可の配列)を
   ソート・結合した文字列に正規化してから、関わりの型と同じ多数決ロジックで一致率を算出する

出力は `docs/test-results/relation-stability-<実行日時>.json`。`relation_stability`/`mode_stability`
の2キーに分かれて入る。一致率が低い(揺れが大きい)ペルソナ・パターンは実際に出た値の並びごと
記録される(各試行 `attempts` に `used_model` を含む。`model_usage` キーで全体の使用件数を集計できる)。
モード判定側は、本来その場でインテークが完了するはずが完了しなかった件数(`intake_incomplete_count`)
も記録する。どちらもDBには書き込まない。

### テスト4/5: ペルソナ多ターン回帰テスト(インテーク完了率を統合)

2026年9月、アップロードされた新仕様(persona-tests-4-5.md)に基づき全面改修。
旧テスト4(インテーク完了率)は別実行せず、ペルソナ会話のログから同時に算出する
(会話を二重に回すと費用も二重にかかるため)。

```bash
npm run test:persona-regression                 # 既定 --stage=smoke(A3のみ1回。必ず最初に)
npm run test:persona-regression -- --stage=core  # 毎回回す組(A2/A3/A5/B1/B5/C1)を各1回
npm run test:persona-regression -- --stage=full  # 15例すべてを既定2回ずつ(--repeats=3で3回)
npm run test:persona-regression -- --persona=A3  # 1件だけに絞る(--stageと併用可)
```

- ペルソナ設定: `docs/test-sets/personas.json`(15例。A群=通常の相談7種・B群=安全に関わるもの
  5種・C群=関係性境界に関わるもの3種)。固定文(`scripted_turns`)は生徒役AIに生成させず
  そのまま差し込む(表現の揺れで再現性が失われるのを防ぐため)
- 生徒役AI(`LITE_MODELS`。無料枠)と相談AI本体(`PRIMARY_MODELS`。**課金キー**
  `TEST_GEMINI_API_KEY_PAID`)を、ペルソナごとに複数ターン会話させ、本番と全く同じ形で
  `sessions`/`messages` に保存する。`sessions.is_synthetic=true`・`persona_id`・`run_id`
  を立てるため、**`admin.html` の「合成データを表示」を有効にしないと一覧に出ない**
  (既定非表示。本物の生徒の会話と混同しないため)
- **予算管理**: `TEST_BUDGET_YEN`(既定1000円)を実行前に確認し、超える見込みなら実行しない。
  実行中に使い切ったらその場で打ち切り、そこまでの結果を保存する。実際の使用トークン数・
  費用は `docs/test-results/budget-ledger.json` に累計で記録される(他の課金キー使用テストの
  分も同じ台帳に記録される)
- 各ペルソナの `pass_criteria.automated`(personas.json内)を会話ログから機械的に判定する。
  `pass_criteria.visual` は自動判定せず、下記の会話ログを人間と別のGem(Geminiアプリ)で確認する
- B群(安全に関わるペルソナ)は、判定器が失敗した際のフェイルセーフ(`src/classify.mjs`。
  失敗時 `watch` へフォールバック。2026年9月対応済み)が前提
- 出力: `docs/test-results/persona-regression-<runId>.json`(自動判定・インテーク完了率・
  使用モデル・予算の集計)と、`docs/test-results/persona-logs-<runId>/<ペルソナID>.txt`
  (ペルソナ1件=1ファイルの読みやすい会話ログ。Gemに貼り付けて分析するため)

### モデル比較(コスト・パフォーマンス。上記4本とは別枠)

```bash
npm run test:model-comparison
# 対象モデルや件数を絞りたい場合:
npm run test:model-comparison -- --limit=2 --repeats=2
npm run test:model-comparison -- --models=gemini-3.6-flash,gemini-3.8-flash
```

`PRIMARY_MODELS` の候補モデルを、勘ではなく実測(コスト・レイテンシ・禁止表現の漏れ率)で
選ぶための比較。上記4本(`npm run test:all`)には**含めていない**(知識・プロンプトの
リグレッション検知が目的の4本と違い、これはモデル選定という別の目的の、都度実行するもの
ではないツールのため)。

- `TEST_GEMINI_API_KEY(S)`(無料枠プール)とは別に、課金設定済みの単一キー
  `TEST_GEMINI_API_KEY_PAID` が必要(未設定だとエラーで止まる)。理由はCLAUDE.md 5.10参照
  ( PRIMARY_MODELS の実力を測る検証は本番と同じ課金枠を使うべきで、無料枠は
  そもそもモデル選定の比較対象として実力を測れるだけのレート制限が無いため)
- 入力セットはテスト2と同じ `docs/test-sets/ng-leak-rate-inputs.json`。候補モデルそれぞれに
  単独で(フォールバック無効)既定10回ずつ通し、モデルごとに成功率・NG漏れ率・平均/最大
  レイテンシ・実際のトークン使用量(`usageMetadata`)・実コスト(ドル)を集計する
- 出力は `docs/test-results/model-comparison-<実行日時>.json`。価格表(`pricing_source`)は
  ai.google.dev/gemini-api/docs/pricingを実測した時点のもので、Google側の値上げ・
  値下げがあれば `scripts/test-model-comparison.mjs` の `PRICING` を更新すること
- Google側の一時的な過負荷(503 "currently experiencing high demand")も、429と同じく
  自動で再試行する(`isTransientGenerateFailure`。2026年9月・このテストの実行中に
  複数モデルにまたがって頻発することを確認し対応した)
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
