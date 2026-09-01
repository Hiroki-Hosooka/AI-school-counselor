# スクールカウンセリングAI — サーバ構成版 セットアップ

複数の端末から、それぞれの人が使える構成です。
ナレッジと会話記録は DB にあり、HTML には知識も API キーも入っていません。

```
ブラウザ（表示のみ）
   │  fetch
   ▼
Edge Function（Supabase）
   │  ・APIキーを保持して Claude を呼ぶ
   │  ・DB からナレッジを読んでプロンプトを組む
   │  ・入力フィルタ → 生成 → 出力チェック
   │  ・会話 / 見立て / 安全判定を保存
   │  ・危機判定なら人へ通知
   ▼
Postgres（Supabase）
   knowledge / sessions / messages / safety_events
```

---

## ファイル

| ファイル | 置き場所 |
|---|---|
| `db/schema.sql` | Supabase の SQL Editor に貼って実行 |
| `db/seed_knowledge.sql` | 同上（schema.sql の後） |
| `db/knowledge.json` | バックアップ用。DB を作り直すとき用 |
| `supabase/functions/chat/index.ts` | Edge Function としてデプロイ |
| `index.html` | GitHub Pages などに配置 |

---

## 手順

### 1. Supabase プロジェクトを作る

<https://supabase.com> で新規プロジェクトを作成。リージョンは Tokyo を選んでください。

### 2. テーブルを作る

SQL Editor で `db/schema.sql` を実行 → 続けて `db/seed_knowledge.sql` を実行。

確認:

```sql
select src, count(*) from knowledge group by src order by 2 desc;
```

`理 54 / 石 42 / 嶋 37 / 嶋石 5 / 設 2` の計 140 件になっていれば成功です。

### 3. Edge Function を置く

```bash
npm install -g supabase
supabase login
supabase link --project-ref <あなたのプロジェクトID>
supabase functions deploy chat --no-verify-jwt
```

`--no-verify-jwt` は、生徒にログインを求めない設計のために必要です。
代わりに Edge Function の中でレート制限をかけています。

### 4. 環境変数を設定する

ダッシュボード → Edge Functions → chat → Secrets

| 名前 | 必須 | 内容 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ○ | `sk-ant-...` |
| `ALLOWED_ORIGIN` | ○ | 例 `https://ayayume0206.github.io` |
| `MODEL` | | 既定 `claude-sonnet-4-6` |
| `CRISIS_WEBHOOK_URL` | | Slack や Discord の Incoming Webhook |
| `RATE_LIMIT_PER_HOUR` | | 既定 60 |

`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は自動で入るので設定不要です。

> **`ALLOWED_ORIGIN` を `*` のままにしないでください。** 誰でも自分のサイトから呼べてしまい、API 課金が他人に使われます。

### 5. index.html をつなぐ

`index.html` の先頭にある

```js
const DEFAULT_ENDPOINT = "https://YOUR-PROJECT.supabase.co/functions/v1/chat";
```

を自分の URL に書き換えて配置します。書き換えなくても、設定パネルから入力できます。

---

## 端末をまたいで使う

ログインは作っていません。敷居を下げることが目的なので、名前もメールも要求しません。

代わりに、端末ごとに匿名の**引き継ぎコード**(UUID)を発行しています。
設定パネルに表示されるコードを別の端末に入力すると、同じ続きから話せます。

- 何も入力しなければ、その端末だけの匿名利用になります
- コードは名前と紐づいていないので、コードを知らない限り誰の会話かはわかりません

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
Edge Function は 60 秒キャッシュなので、**1分待てば反映されます。**

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
