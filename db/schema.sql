-- ============================================================================
--  スクールカウンセリングAI  データベーススキーマ
--  Supabase の SQL Editor にそのまま貼って実行してください
--
--  設計方針
--   ・ブラウザは DB に直接触らない。すべて Edge Function 経由。
--     したがって全テーブルで RLS を有効化し、anon 向けポリシーは作らない。
--     （service_role は RLS を迂回するので Edge Function からは読み書きできる）
--   ・未成年の相談内容は要配慮個人情報。保存期間と削除手順を決めてから運用すること。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ナレッジ
--    これまで index.html の JS 配列に持っていた知識をここに移す
-- ----------------------------------------------------------------------------
create table if not exists knowledge (
  id          text primary key,                 -- X1, IS3, V12 など
  src         text not null,                    -- 嶋 / 石 / 嶋石 / 理 / 設
  school      text,                             -- 流派（来談者中心寄り 等）
  cat         text not null,                    -- principle/ng/stance/ask/resp/read/role/verbatim/limit/ctx
  lv          int,                              -- ng のみ 3=絶対にしない 2=避ける 1=好ましくない
  weight      text not null default 'any',      -- rapport/main/goal/plan/any
  tags        text[] not null default '{}',
  body        text not null,                    -- 本文（逐語はできるだけそのまま）
  note        text,                             -- 補足・採用理由など
  active      boolean not null default true,    -- false にすると使われなくなる（削除しない）
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint knowledge_cat_check   check (cat in
    ('principle','ng','stance','ask','resp','read','role','verbatim','limit','ctx')),
  constraint knowledge_weight_check check (weight in ('rapport','main','goal','plan','any')),
  constraint knowledge_lv_check     check (lv is null or lv between 1 and 3)
);

create index if not exists knowledge_active_idx on knowledge (active);
create index if not exists knowledge_cat_idx    on knowledge (cat);
create index if not exists knowledge_tags_idx   on knowledge using gin (tags);
-- 将来ハイブリッド検索にする時のための全文検索インデックス
create index if not exists knowledge_body_idx   on knowledge using gin (to_tsvector('simple', body));

-- ----------------------------------------------------------------------------
-- 2. ナレッジ更新履歴
--    「この日から石田先生版のNGを有効にしたら評価がどう変わったか」を追うために必須
-- ----------------------------------------------------------------------------
create table if not exists knowledge_history (
  seq         bigserial primary key,
  id          text not null,
  op          text not null,          -- insert / update / delete
  before      jsonb,
  after       jsonb,
  changed_at  timestamptz not null default now()
);

create or replace function log_knowledge_change() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    insert into knowledge_history (id, op, before) values (old.id, 'delete', to_jsonb(old));
    return old;
  elsif (tg_op = 'UPDATE') then
    insert into knowledge_history (id, op, before, after) values (new.id, 'update', to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into knowledge_history (id, op, after) values (new.id, 'insert', to_jsonb(new));
    return new;
  end if;
end $$;

drop trigger if exists knowledge_history_trg on knowledge;
create trigger knowledge_history_trg
  after insert or update or delete on knowledge
  for each row execute function log_knowledge_change();

-- 更新時に updated_at を自動で進める
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists knowledge_touch_trg on knowledge;
create trigger knowledge_touch_trg
  before update on knowledge
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. セッション
--    client_id = 端末ごとに発行する匿名ID。ログインは作らない。
--    （敷居を下げることが目的なので、名前を要求しない）
-- ----------------------------------------------------------------------------
create table if not exists sessions (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text not null,
  weight                text not null default 'rapport',
  relation              text not null default 'visitor',
  turns_since_summary   int  not null default 0,
  notes                 jsonb not null default '{}'::jsonb,  -- 見立てメモ（識別情報を入れない）
  knowledge_version     text,                                 -- その時点のナレッジの世代
  started_at            timestamptz not null default now(),
  last_at               timestamptz not null default now(),
  closed_at             timestamptz
);

create index if not exists sessions_client_idx on sessions (client_id, last_at desc);

-- ----------------------------------------------------------------------------
-- 4. メッセージ
-- ----------------------------------------------------------------------------
create table if not exists messages (
  seq             bigserial primary key,
  session_id      uuid not null references sessions(id) on delete cascade,
  role            text not null,                -- user / ai
  body            text not null,
  weight          text,
  relation        text,
  question_level  text,                         -- none/data/diagnostic/confrontational
  role_kind       text,                         -- listen/assess/inform
  summarized      boolean not null default false,
  hypothesis      text,
  why             text,
  used            text[] not null default '{}', -- 参照したナレッジID
  flags           text[] not null default '{}', -- 出力チェックの検知
  crisis          boolean not null default false,
  rating          int,                          -- 1..5（心理士による評価）
  rating_comment  text,
  created_at      timestamptz not null default now(),
  constraint messages_role_check check (role in ('user','ai')),
  constraint messages_rating_check check (rating is null or rating between 1 and 5)
);

create index if not exists messages_session_idx on messages (session_id, seq);
create index if not exists messages_rating_idx  on messages (rating) where rating is not null;

-- ----------------------------------------------------------------------------
-- 5. 安全イベント
--    生成ログとは別テーブルに保全する。危機の見落としを後から監査できるように。
-- ----------------------------------------------------------------------------
create table if not exists safety_events (
  seq          bigserial primary key,
  session_id   uuid references sessions(id) on delete set null,
  risk         text not null,               -- none/watch/crisis
  keywords     text[] not null default '{}',-- 事前検知で当たった語
  model_risk   text,                        -- 判定器の見立て
  model_reason text,
  notified     boolean not null default false,
  handled      boolean not null default false,  -- 人が確認したか
  handled_by   text,
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists safety_unhandled_idx
  on safety_events (created_at desc) where risk <> 'none' and handled = false;

-- ----------------------------------------------------------------------------
-- 6. レート制限用（1端末あたりの利用量）
-- ----------------------------------------------------------------------------
create or replace function recent_turn_count(p_client_id text, p_minutes int default 60)
returns int language sql stable as $$
  select count(*)::int
  from messages m
  join sessions s on s.id = m.session_id
  where s.client_id = p_client_id
    and m.role = 'user'
    and m.created_at > now() - make_interval(mins => p_minutes);
$$;

-- ----------------------------------------------------------------------------
-- 7. RLS
--    ポリシーを一つも作らない = anon からは一切見えない。
--    Edge Function は service_role で接続するので RLS を迂回する。
-- ----------------------------------------------------------------------------
alter table knowledge          enable row level security;
alter table knowledge_history  enable row level security;
alter table sessions           enable row level security;
alter table messages           enable row level security;
alter table safety_events      enable row level security;

-- ----------------------------------------------------------------------------
-- 8. 運用に使うビュー
-- ----------------------------------------------------------------------------

-- 未対応の危機イベント（毎日ここを見る運用にする）
create or replace view pending_safety as
select e.seq, e.created_at, e.risk, e.model_reason, e.session_id, s.client_id
from safety_events e
left join sessions s on s.id = e.session_id
where e.risk <> 'none' and e.handled = false
order by e.created_at desc;

-- ナレッジIDごとの平均評価（どの知識が効いているか）
create or replace view knowledge_score as
select k.id, k.src, k.cat, k.body,
       count(m.seq)          as used_count,
       round(avg(m.rating),2) as avg_rating
from knowledge k
left join messages m on k.id = any(m.used) and m.rating is not null
group by k.id, k.src, k.cat, k.body
order by used_count desc;

-- 出力チェックに引っかかった回数（禁止リストの効き具合）
create or replace view flag_summary as
select unnest(flags) as flag, count(*) as n
from messages where array_length(flags,1) > 0
group by 1 order by n desc;
