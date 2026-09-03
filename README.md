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
