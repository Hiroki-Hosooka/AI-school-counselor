// ============================================================================
//  スクールカウンセリングAI  API Route(旧 supabase/functions/chat/index.ts)
//  src/app/api/chat/route.ts
//
//  役割
//   1. Gemini の API キーをサーバ側に隠す(ブラウザには絶対に置かない)
//   2. ナレッジを DB(Supabase Postgres)から読む(クライアントには知識を持たせない)
//   3. 入力フィルタ → 生成 → 出力チェック の安全層をすべてここで通す
//   4. 会話・見立て・安全判定を DB に保存する
//   5. 危機判定時に人へ通知する
//
//  Next.js + Vercel 移行に伴う変更点(ロジック自体は変更していない)
//   ・Supabase Edge Function(Deno)ではなく Next.js の Route Handler(Node.js)として動く
//   ・フロントエンドと同一オリジンになったため、CORS(ALLOWED_ORIGIN)の仕組みは廃止した。
//     ブラウザの Origin チェックはそもそも別サイトの埋め込みJSからの無断利用を防ぐためのもので、
//     同一オリジン構成ではその脅威自体が成立しないため
//   ・Supabase は Postgres(データ)としてのみ利用する
//
//  生成モデルを Anthropic Claude から Google Gemini に変更(2026年9月)。
//  安全層(CRISIS_WORDS/OUTPUT_NG)はモデルの出力テキストに対する後段チェックなので、
//  どちらのモデルでも同じように効く。プロンプトの内容・出力JSONスキーマは変更していないが、
//  モデルが変わったことで実際の応答の質・トーンが変わっていないか、必ず会話して確認すること。
//
//  モデルは単一指定ではなく、PRIMARY_MODELS/LITE_MODELS(下記)を上から順に試す
//  フォールバック方式にしている(2026年9月)。理由は2つ:
//   ・レート制限対策 ― 無料枠は1モデルあたりRPMが低く、1ターンで複数回Geminiを呼ぶ
//     この実装だと単一モデルではすぐ詰まる。モデルIDが違えば別の割当枠になる。
//   ・Googleのモデル退役対策 ― Gemini 2.0系は2026年6月に退役済み、
//     2.5-flashも2026年10月16日に退役予定など、モデルの入れ替わりが速い。
//  MODEL環境変数は廃止した。一覧は環境変数ではなくコード(下記)で管理する。
//  古いモデルが退役して1件も繋がらなくなった場合はリストの見直しが必要。
//
//  必要な環境変数(Vercelダッシュボード > Project Settings > Environment Variables)
//   GEMINI_API_KEY           必須  Google AI Studio で発行したキー
//   SUPABASE_URL             必須
//   SUPABASE_SERVICE_ROLE_KEY 必須(RLSを迂回してDBを読み書きするため。絶対にNEXT_PUBLIC_を付けない)
//   CRISIS_WEBHOOK_URL       任意  Slack / Discord などの Incoming Webhook
//   RATE_LIMIT_PER_HOUR      任意  既定 60(超えた発言でも、本人のはっきりした危機のサインがあれば固定応答を返す)
//   ADMIN_TOKEN              任意  管理画面(public/admin.html)用の合言葉。
//                                  admin_sessions/admin_session_detail はこれと
//                                  一致しないと401を返す(docs/backlog.md 1-2)
//   CRISIS_DETECTION         任意  v1 にすると危機検知を以前の判定に戻す(既定は v2)
//   CRISIS_RESPONSE          任意  staged にすると段階ごとの応答(第2段階・仮の文面。心理士の確認待ち)。
//                                  本番では設定しない。有効にする前に db/schema.sql 11節〜14節を実行すること
//   CRISIS_STEP3_VARIANT     任意  段階ごとの応答の3通目(相談先や大人に話したいか)の候補 A / B / C(既定 A。仮)
//   CRISIS_KEYWORDS          任意  v2 にすると以前の危機キーワード。既定は v3(2026年10月10日に採用。CLAUDE.md 5.12)
//   CRISIS_AFTERCARE         任意  off にすると、固定応答を出したあとの生成に危機のあとの指示を付けない
//                                  (2026年10月5日より前の動き)。既定は付ける(CLAUDE.md 5.17)
// ============================================================================

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  classify, classifyStaged, classifyLocal, crisisDetectionVersion, CLASSIFIER_CONTEXT_MESSAGES,
} from "@/classify.mjs";
import { categoryOfSafety } from "@/crisis-keywords-v3.mjs";
import { MAX_TEXT_LENGTH, TOO_LONG_NOTICE, RATE_LIMIT_NOTICE } from "@/notices.mjs";
import {
  loadKnowledge, clearKnowledgeCache, knowledgeVersion, retrieve, buildSystem, generateReply, updatePersonMemory,
  applyTurnUpdate, applyIntakeUpdate, applyModeUpdate, applyClosingUpdate, flowPhaseFor,
  DISTRESS_DECLINED_FLAG, distressDeclinedNote, PROMPT_VERSION,
} from "@/generate.mjs";
import { validateKnowledgeInput } from "@/knowledge-admin.mjs";
import {
  stagedResponseEnabled, assessSafetyTurn, CARE_LINE_PROVISIONAL,
  CRISIS_GENERATION_EXTRA_NG, CRISIS_GENERATION_FIX_HINT, CRISIS_FALLBACK_FLAG, finalizeCrisisGeneration,
  aftercareEnabled, hadCrisisReply, defaultSafetyContexts, SAFETY_STATE_COLUMNS,
  CRISIS_ENDINGS_PROVISIONAL, nextEndingVariant, daijoubuYokattaNote, CHOICE_NOTE_PROVISIONAL,
  contextFailureReply, CONTEXT_FAILURE_FLAG, assessFlowChoiceTurn,
  resolveChoice, stateUnreliable, toGenerationPlan, dedupeFixedPlan, defaultCrisisReplyFor,
  STATE_SAVE_FAILED_FLAG, STATE_MISMATCH_FLAG, EMPTY_REPLY_FLAG, EMPTY_REPLY_FALLBACK_PROVISIONAL, typedScale,
  declinedPeopleFrom, declinedNg, declinedEstimateFlag,
} from "@/crisis-response.mjs";
import {
  flowStats, flowCheck, flowFixHint, finalizeFlow, LOST_MEANING_RE,
  CHOICES_G_PROVISIONAL, FLOW_CHOICE_SET, annotateForAdmin, DISCOMFORT_REASONS, aiEndingCheck,
} from "@/flow.mjs";

// 安全判定(classify)・人単位の記憶の要約用のモデル一覧、危機判定ロジック本体は src/classify.mjs、
// ナレッジ検索・システムプロンプト構築・本生成ロジックは src/generate.mjs にある
// (scripts/test-*.mjs と共有するため。docs/backlog.md 1-3)。

const WEBHOOK = process.env.CRISIS_WEBHOOK_URL ?? "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR ?? "60");
// これだけ会話が途切れたら「今回は一区切り」とみなし、要約を更新する。
const SESSION_GAP_MINUTES = 30;

// DBクライアントは初回呼び出し時に作る(モジュール読み込み時に環境変数が
// 無くても next build が壊れないように遅延初期化にしている)
let _db: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (!_db) {
    _db = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return _db;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// DB の書き込みの結果を確かめる(2026年10月14日。相談ログ 86130eef で、状態の保存がだまって失敗し、
// 押したチップが受け付けられず、同じ固定の文がくり返された)。失敗したら1回だけやり直し、それでも駄目ならサーバのログに残して
// ok = false を返す(呼び出し側が、会話の記録に印を残す・固定の文を出さない、などを決める)
type WriteResult = { data?: unknown; error: { message: string } | null };
async function checkedWrite<T extends WriteResult>(label: string, op: () => PromiseLike<T>): Promise<T & { ok: boolean }> {
  let r = await op();
  if (r.error) {
    console.error(`DB の書き込みに失敗しました(${label})。やり直します:`, r.error.message);
    r = await op();
    if (r.error) console.error(`DB の書き込みに再び失敗しました(${label}):`, r.error.message);
  }
  return { ...r, ok: !r.error };
}

// 1ターンの所要時間の内訳(2026年10月14日。fix-after-shima4.md 1-6)。段階ごとの時刻を残し、messages.timings(16節)に書く
function makeTimer() {
  const started = Date.now();
  let last = started;
  const marks: Record<string, number> = {};
  return {
    mark(name: string) { const now = Date.now(); marks[name] = (marks[name] ?? 0) + (now - last); last = now; },
    done() { return { ...marks, total: Date.now() - started }; },
  };
}

// その返事を作ったときの設定(研究のため1ターンごとに記録する。2026年10月14日。top-screen-intake.md 3-3)
function settingsSnapshot() {
  return {
    crisis_response: process.env.CRISIS_RESPONSE ?? null, crisis_detection: process.env.CRISIS_DETECTION ?? "v2",
    crisis_keywords: process.env.CRISIS_KEYWORDS ?? "v3", crisis_aftercare: process.env.CRISIS_AFTERCARE ?? "on",
    crisis_step3_variant: process.env.CRISIS_STEP3_VARIANT ?? "A", dev_panel: process.env.DEV_PANEL === "on",
  };
}
// プロンプトの版(コードの定数)+組み立てたシステムプロンプトの短いハッシュ
const promptVersionOf = (system: string) => `${PROMPT_VERSION}#${createHash("sha1").update(system).digest("hex").slice(0, 10)}`;
// 16節の列(timings など)。まだ無い DB では外して書き直す
const SECTION16_MESSAGE_COLUMNS = ["timings", "model", "prompt_version", "knowledge_version", "settings", "intake_step"];
const withoutKeys = (row: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

// 開発用の表示(2026年10月14日に人が決めた)。サーバの環境変数 DEV_PANEL=on のときだけ。Vercel の Preview・Development にだけ
// 設定し、Production には設定しない。環境変数が無いときは必ず出さない(画面で隠すだけにせず、サーバが応答に入れない)
const devPanel = () => process.env.DEV_PANEL === "on";

// 相談者の発言の行に印を残す(返事そのものを保存できなかったとき。その会話では固定の文を出さないため。2026年10月14日)
async function markUserRow(db: SupabaseClient, seq: number | undefined, flag: string) {
  if (seq == null) { console.error("印を残す行がありません:", flag); return; }
  await checkedWrite("相談者の発言の印", () => db.from("messages").update({ flags: [flag] }).eq("seq", seq));
}

// 段階ごとの応答(第2段階。src/crisis-response.mjs)で足した列(db/schema.sql 11節〜13節)も読む。
// 書き込むのは設定 CRISIS_RESPONSE=staged のときだけ。読むときは、列がまだ無い(SQL未実行の)DBでも
// 動くよう、失敗したら列の少ない読み方で順に読み直す(新しい節の列から外していく)。select の列の一覧は
// supabase-js が型として解析するので、呼び出し側でそのまま文字列で書き、結果の型はここで緩める
// (使う側で必要な分だけ型を付ける)。
type Row = Record<string, unknown>;
type SelectAttempt = () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
async function selectRowsWithFallback(...attempts: SelectAttempt[]): Promise<Row[]> {
  let lastError = "";
  for (const attempt of attempts) {
    const r = await attempt();
    if (!r.error) return (r.data ?? []) as Row[];
    lastError = r.error.message;
  }
  throw new Error(lastError);
}
// 画面に返すとき、気づかいのカード(safety_card = care)には仮の一言を添える
// (文面はサーバ側の src/crisis-response.mjs にだけ置く。クライアントは表示だけ)
function withCareLine(m: Row) {
  return {
    ...m, care_line: m.safety_card === "care" ? CARE_LINE_PROVISIONAL : null,
    choice_note: Array.isArray(m.choices) && m.choices.length ? CHOICE_NOTE_PROVISIONAL : null,
  };
}

// 管理画面(admin.html)用の合言葉チェック。ログイン画面は作らず、
// admin.html が自分のURLのクエリ文字列(?token=...)から読んで
// リクエストボディに admin_token として載せてくる想定(docs/backlog.md 1-2)。
function checkAdminToken(payload: Record<string, unknown>): boolean {
  const token = String(payload.admin_token ?? "");
  return token.length > 0 && token === process.env.ADMIN_TOKEN;
}

// ============================================================================
//  安全層(クライアントには置かない。CRISIS_WORDS/OUTPUT_NG は src/safety.mjs、
//  CRISIS_REPLY/classify は src/classify.mjs、人単位の記憶(updatePersonMemory)は
//  src/generate.mjs。2026年9月、テストスクリプトからも同じ更新処理を呼べるよう
//  generate.mjs側に切り出した。挙動は変えていない)
// ============================================================================

// 危機通知。本文は送らない。
// 未成年の相談内容を Slack 等のチャンネルに流すのは避け、
// 「確認が必要なセッションがある」ことだけを伝えて、詳細は管理画面で見る運用にする。
// subject: "self"(本人の危機)| "other"(友人等、第三者の安全への懸念。構造化面接AI統合 手順4)。
// どちらも通知は鳴らすが、スタッフが優先順位をつけられるよう文言だけ分ける。
// classify.mjs(JS、型チェック対象外)から来る値なので string で受け、ここで判定する
// (sess.weight/out.relation 等、他の値も同様にリテラル型では受けていない)。
async function notifyCrisis(sessionId: string, subject: string = "self") {
  if (!WEBHOOK) return false;
  const label = subject === "other" ? "危機判定が出ました(友人等の安全への心配)" : "危機判定が出ました(本人)";
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `【要確認】相談AIで${label}\nセッション: ${sessionId}\n時刻: ${new Date().toISOString()}\n内容は管理画面(pending_safety)で確認してください。`,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

// 字数・回数の上限を超えた発言に、本人のはっきりした危機のサイン(キーワード・受動パターン)があったときの応答
// (2026年10月7日)。AI は使わず、いつもの固定応答(CRISIS_REPLY・危機カード)を返し、職員に通知し、記録する
// (CLAUDE.md 5.2・5.3)。回数の上限に当たった生徒は続けて送れないので、段階ごとの応答(仮)が有効なときも、
// 分けた文面ではなく全部入りの固定応答にし、状態を「危機の応答を出し終えた(done)」にして、以後の生成に
// 危機のあとの指示が付くようにする。段階ごとの応答の列(db/schema.sql 11節〜)が無い DB では、今までの列だけ書く。
// safety_events.keywords に残す「どの規則に当たったか」。v2 はキーワードの代表表記とパターンの ID、
// v3 は語の ID・代表表記・段階・根拠の種類(【要確認】の語は心理士の確認待ちだと見分けられるように)
type Hit = { id: string; label: string; stage: number; kind: string[]; provisional: boolean };
function keywordLog(r: { keywords: string[]; patterns: string[]; idiomExempted: string[]; hits?: Hit[]; keywordVersion?: string }): string[] {
  const idioms = (r.idiomExempted ?? []).map((p) => `(慣用表現→段階1)${p}`);
  if (r.keywordVersion === "v3") {
    return [
      ...(r.hits ?? []).map((h) => `v3:${h.id} ${h.label}(段階${h.stage}・${h.kind.join("/")})${h.provisional ? "【要確認】" : ""}`),
      ...idioms,
    ];
  }
  return [...r.keywords, ...r.patterns.map((p) => `パターン:${p}`), ...idioms];
}

// 上限を超えた発言の、これまでの会話(同じ固定の文を2回出さないため・断った相手のため。2026年10月14日)
async function loadHistForLimit(db: SupabaseClient, sessionId: string) {
  return selectRowsWithFallback(
    () => db.from("messages").select("role,body,crisis,flags,choice_id").eq("session_id", sessionId).order("seq"),
    () => db.from("messages").select("role,body,crisis,flags").eq("session_id", sessionId).order("seq"),
  );
}

async function overLimitCrisisReply(
  db: SupabaseClient, sessionId: string, text: string, local: ReturnType<typeof classifyLocal>, reply: string,
) {
  const { data: sess } = await db.from("sessions").select("id").eq("id", sessionId).single();
  if (!sess) return json({ error: "セッションが見つかりません" }, 404);
  const { data: userMsg } = await checkedWrite("相談者の発言(上限)", () => db.from("messages")
    .insert({ session_id: sessionId, role: "user", body: text }).select("seq").single());
  const notified = await notifyCrisis(sessionId, "self");
  const event = {
    session_id: sessionId, risk: "crisis", subject: "self",
    keywords: keywordLog(local),
    model_risk: local.model.risk, model_reason: `${local.model.reason}(段階2: ${local.decidedBy.join(",")})`, notified,
  };
  const staged = stagedResponseEnabled();
  const stagedEvent = staged ? await db.from("safety_events").insert({ ...event, stage: 2, decided_by: local.decidedBy }) : null;
  const eventSaved = staged && !stagedEvent?.error
    ? true : (await checkedWrite("安全の記録(上限)", () => db.from("safety_events").insert(event))).ok;
  // 「〜が、とても心配です」は、当たった語の種類で組む(src/crisis-texts.mjs。2026年10月9日)
  const category = categoryOfSafety(local);
  const touched = { last_at: new Date().toISOString() };
  const stagedUpdate = staged
    ? await db.from("sessions").update({
      ...touched, crisis_state: "done", crisis_trigger: "direct", watch_turns_left: 0, crisis_category: category,
    }).eq("id", sessionId)
    : null;
  // 段階ごとの応答の状態を書けなかったら(最後の時刻だけ書き直しても)状態の保存の失敗として扱う
  let stateSaved = staged && !stagedUpdate?.error;
  if (!stateSaved) {
    const touchedOk = (await checkedWrite("セッションの状態(上限)", () => db.from("sessions").update(touched).eq("id", sessionId))).ok;
    stateSaved = !staged && touchedOk;
  }
  const flags = [
    ...(stateSaved ? [] : [`${STATE_SAVE_FAILED_FLAG}(上限を超えた発言の危機の応答)`]),
    ...(eventSaved ? [] : ["記録のみ:安全の記録の保存に失敗"]),
  ];
  const { data: aiMsg } = await checkedWrite("危機の固定応答(上限)", () => db.from("messages").insert({
    session_id: sessionId, role: "ai", body: reply, crisis: true, ...(flags.length ? { flags } : {}),
  }).select("seq").single());
  return json({
    reply, crisis: true,
    safety: { risk: "crisis", subject: "self", keywords: local.keywords.length, model: local.model.risk },
    user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
  });
}

// ============================================================================
//  ハンドラ
// ============================================================================
export async function POST(req: Request) {
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "JSONが不正です" }, 400); }
  const action = String(payload.action ?? "chat");

  try {
    const db = getDb();
    // ------------------------------------------------------------------
    // 評価の記録
    // ------------------------------------------------------------------
    if (action === "rate") {
      const { seq, rating, comment } = payload as { seq: number; rating: number; comment?: string };
      if (!seq || !(rating >= 1 && rating <= 5)) return json({ error: "パラメータが不正です" }, 400);
      // 自分の会話の AI の返事だけを評価できるようにする(2026年10月13日)。以前は seq さえわかれば、
      // ほかの人の会話の返事の評価を書き換えられた。引き継ぎコード(client_id)がその会話の持ち主かを確かめる。
      const clientId = String(payload.client_id ?? "");
      const { data: target } = await db.from("messages").select("session_id,role").eq("seq", seq).maybeSingle();
      if (!clientId || !target || target.role !== "ai") return json({ error: "評価できない返答です" }, 403);
      const { data: owner } = await db.from("sessions").select("client_id").eq("id", target.session_id).maybeSingle();
      if (!owner || owner.client_id !== clientId) return json({ error: "評価できない返答です" }, 403);
      const saved = await checkedWrite("評価", () => db.from("messages").update({ rating, rating_comment: comment ?? null }).eq("seq", seq));
      if (!saved.ok) return json({ error: "評価を保存できませんでした" }, 500);
      return json({ ok: true });
    }

    // ------------------------------------------------------------------
    // 管理画面(admin.html)
    // ログイン画面は作らず、admin.html が自分のURLのクエリ文字列から
    // token を読んで毎回のリクエストに含める(docs/backlog.md 1-2)。
    // ------------------------------------------------------------------
    if (action === "admin_sessions") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const { data, error } = await db.from("session_overview")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,turn_count,unrated_count,has_crisis,phase,is_synthetic,persona_id,run_id")
        .order("started_at", { ascending: false });
      if (error) throw new Error(error.message);
      const sessions = (data ?? []).map((s) => ({
        id: s.id,
        client_id_short: String(s.client_id).slice(0, 8),
        started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
        relation: s.relation, weight: s.weight,
        turn_count: s.turn_count, unrated_count: s.unrated_count, has_crisis: s.has_crisis,
        phase: s.phase,
        // 合成データ(ペルソナテスト)の識別。admin.htmlの表示切替に使う(2026年9月)。
        is_synthetic: s.is_synthetic, persona_id: s.persona_id, run_id: s.run_id,
      }));
      return json({ sessions });
    }

    // ------------------------------------------------------------------
    // ナレッジ管理画面(public/knowledge.html。docs/backlog.md 1-1。2026年10月11日)
    // 合言葉は会話ログの画面と同じ(ADMIN_TOKEN)。削除はさせない(active を外すだけ)。確かめは src/knowledge-admin.mjs
    // ------------------------------------------------------------------
    if (action === "admin_knowledge_list") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const { data, error } = await db.from("knowledge")
        .select("id,src,school,cat,lv,weight,tags,body,note,mode,active,updated_by,updated_at,created_at")
        .order("id");
      if (error) throw new Error(error.message);
      return json({ knowledge: data ?? [] });
    }

    if (action === "admin_knowledge_save") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const isNew = payload.is_new === true;
      const { data: existing, error: listErr } = await db.from("knowledge").select("id,cat,active,tags");
      if (listErr) throw new Error(listErr.message);
      const checked = validateKnowledgeInput(payload.row, existing ?? [], isNew);
      if (!checked.ok || !checked.row) return json({ error: checked.error ?? "入力を確かめられませんでした" }, 400);
      const row = checked.row;
      const { id, ...fields } = row;
      const { error } = isNew
        ? await db.from("knowledge").insert(row)
        : await db.from("knowledge").update(fields).eq("id", id);
      if (error) return json({ error: `保存できませんでした: ${error.message}` }, 400);
      clearKnowledgeCache();
      return json({ ok: true, id });
    }

    if (action === "admin_knowledge_history") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const id = String(payload.id ?? "").trim();
      let q = db.from("knowledge_history").select("seq,id,op,before,after,changed_at").order("seq", { ascending: false }).limit(id ? 50 : 100);
      if (id) q = q.eq("id", id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json({ history: data ?? [] });
    }

    if (action === "admin_session_detail") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const sessionId = String(payload.session_id ?? "").trim();
      if (!sessionId) return json({ error: "session_id が必要です" }, 400);
      const { data: s } = await db.from("sessions")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state")
        .eq("id", sessionId).maybeSingle();
      if (!s) return json({ error: "セッションが見つかりません" }, 404);
      const msgs = await selectRowsWithFallback(
        // 15節(違和感の印)の列
        () => db.from("messages")
          .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing,safety_stage,crisis_step,safety_card,crisis_generated,choices,choice_set,choice_id,choice_input,ending_variant,discomfort,discomfort_reason")
          .eq("session_id", sessionId).order("seq"),
        // 14節(危機の流れの見直し)の列: 出したチップ・押したチップ・締めの文面の何案目か
        () => db.from("messages")
          .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing,safety_stage,crisis_step,safety_card,crisis_generated,choices,choice_set,choice_id,choice_input,ending_variant")
          .eq("session_id", sessionId).order("seq"),
        () => db.from("messages")
          .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing,safety_stage,crisis_step,safety_card,crisis_generated")
          .eq("session_id", sessionId).order("seq"),
        () => db.from("messages")
          .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing,safety_stage,crisis_step,safety_card")
          .eq("session_id", sessionId).order("seq"),
        () => db.from("messages")
          .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing")
          .eq("session_id", sessionId).order("seq"),
      );
      // 安全判定の記録(段階・根拠・見守り・引き下がり・先生についての答え。列が無ければあるものだけ)
      const { data: events } = await db.from("safety_events").select("*").eq("session_id", sessionId).order("seq");
      const usedOf = (m: Row) => (Array.isArray(m.used) ? (m.used as string[]) : []);
      const allUsedIds = Array.from(new Set(msgs.flatMap(usedOf)));
      const knowledgeMap: Record<string, { id: string; src: string; cat: string; body: string }> = {};
      if (allUsedIds.length) {
        const { data: kn } = await db.from("knowledge").select("id,src,cat,body").in("id", allUsedIds);
        for (const k of kn ?? []) knowledgeMap[k.id] = k;
      }
      // 会話の流れ(段階と根拠・受け止めのみの連続・前回のまとめから・文の数・終わり方・返し方。src/flow.mjs。2026年10月11日)
      const annotated = annotateForAdmin(msgs, events ?? []);
      const messages = annotated.messages.map((m: Row) => ({
        ...withCareLine(m),
        used: usedOf(m).map((id) => knowledgeMap[id] ?? { id, src: "", cat: "", body: "(削除済み)" }),
      }));
      return json({
        session: {
          id: s.id, client_id_short: String(s.client_id).slice(0, 8),
          started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
          relation: s.relation, weight: s.weight, notes: s.notes,
          phase: s.phase, chief_complaint_category: s.chief_complaint_category,
          onset_context: s.onset_context, distress_level: s.distress_level,
          physical_mental_symptoms: s.physical_mental_symptoms, user_goal: s.user_goal,
          ambivalence_detected: s.ambivalence_detected, recommended_mode: s.recommended_mode,
          closing_state: s.closing_state,
        },
        messages,
        safety_events: events ?? [],
        flow_summary: annotated.flow_summary,
        discomfort_reasons: DISCOMFORT_REASONS,
      });
    }

    // 返事ごとの「違和感があった」の印(2026年10月11日。「他人事感」の修正 10-3。db/schema.sql 15節)。
    // 開発メンバー・心理士がログレビュー画面で付ける。生徒の画面には出さない。合言葉で守る(CLAUDE.md 5.9)
    if (action === "admin_mark_discomfort") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const seq = Number(payload.seq);
      if (!Number.isInteger(seq) || seq <= 0) return json({ error: "seq が不正です" }, 400);
      const on = payload.on !== false;
      const reason = on ? String(payload.reason ?? "").trim().slice(0, 200) : "";
      const { data: target } = await db.from("messages").select("seq,role").eq("seq", seq).maybeSingle();
      if (!target || target.role !== "ai") return json({ error: "AI の返事が見つかりません" }, 404);
      const { error } = await db.from("messages").update({
        discomfort: on, discomfort_reason: on ? reason || null : null, discomfort_at: on ? new Date().toISOString() : null,
      }).eq("seq", seq);
      if (error) return json({ error: "保存できませんでした(db/schema.sql 15節が未実行かもしれません)", detail: error.message }, 400);
      return json({ ok: true });
    }

    // ------------------------------------------------------------------
    // セッション開始 / 再開
    // ------------------------------------------------------------------
    if (action === "start") {
      const clientId = String(payload.client_id ?? "").trim();
      if (!clientId) return json({ error: "client_id が必要です" }, 400);

      // 前回、開いたままのセッションが残っていれば閉じて、
      // その内容を人単位の記憶(要約)に畳み込む。
      // ここでしか要約は更新しない = トークンが際限なく増える経路がそもそも無い。
      const { data: open } = await db.from("sessions")
        .select("id,notes").eq("client_id", clientId).is("closed_at", null)
        .order("last_at", { ascending: false }).limit(1).maybeSingle();
      if (open) {
        await checkedWrite("前のセッションを閉じる", () => db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", open.id));
        await updatePersonMemory(db, clientId, (open.notes ?? {}) as Record<string, unknown>);
      }

      const rows = await loadKnowledge(db);
      const { data, error } = await db.from("sessions")
        .insert({ client_id: clientId, knowledge_version: knowledgeVersion(rows) })
        .select("id,weight,relation,turns_since_summary,notes").single();
      if (error) throw new Error(error.message);
      return json({ session: data, knowledge_count: rows.length });
    }

    // ------------------------------------------------------------------
    // 直前のセッションを取り出す(端末をまたいだ引き継ぎにも使う)
    // ------------------------------------------------------------------
    if (action === "resume") {
      const clientId = String(payload.client_id ?? "").trim();
      const { data: s } = await db.from("sessions")
        .select("id,weight,relation,turns_since_summary,notes,last_at")
        .eq("client_id", clientId).is("closed_at", null)
        .order("last_at", { ascending: false }).limit(1).maybeSingle();
      if (!s) return json({ session: null, messages: [] });

      // 前回のやり取りから十分に間があいていたら、続きではなく新しい来訪として扱う。
      // 「待つ時間」を経て戻ってきた、という区切りを技術的にも尊重する。
      const idleMinutes = (Date.now() - new Date(s.last_at).getTime()) / 60000;
      if (idleMinutes > SESSION_GAP_MINUTES) {
        await checkedWrite("前のセッションを閉じる", () => db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", s.id));
        await updatePersonMemory(db, clientId, (s.notes ?? {}) as Record<string, unknown>);
        return json({ session: null, messages: [] }); // クライアント側が start を呼び直す
      }
      const msgs = await selectRowsWithFallback(
        // 14節(危機の流れの見直し)の列: 返事に付けたチップ・押したチップ
        () => db.from("messages").select("seq,role,body,used,flags,crisis,rating,closing,crisis_step,safety_card,choices,choice_set,choice_id")
          .eq("session_id", s.id).order("seq"),
        () => db.from("messages").select("seq,role,body,used,flags,crisis,rating,closing,crisis_step,safety_card")
          .eq("session_id", s.id).order("seq"),
        () => db.from("messages").select("seq,role,body,used,flags,crisis,rating,closing")
          .eq("session_id", s.id).order("seq"),
      );
      return json({ session: s, messages: msgs.map(withCareLine) });
    }

    // ------------------------------------------------------------------
    // 会話本体
    // ------------------------------------------------------------------
    if (action === "chat") {
      const clientId = String(payload.client_id ?? "").trim();
      const sessionId = String(payload.session_id ?? "").trim();
      const text = String(payload.text ?? "").trim();
      // 押したチップ(段階ごとの応答のときだけ意味を持つ。直前の返事に付けた組のものかは assessSafetyTurn が確かめる)
      const choiceId = typeof payload.choice_id === "string" ? payload.choice_id.slice(0, 8) : null;
      const timer = makeTimer();
      if (!clientId || !sessionId || !text) return json({ error: "パラメータが不足しています" }, 400);

      // 字数・回数の上限(2026年10月7日)。上限を超えた発言でも、止める前に AI を使わない照合
      // (キーワード・受動パターン。src/classify.mjs の classifyLocal)だけは通し、本人のはっきりした危機のサインが
      // あれば、いつもの固定応答・通知・記録を出す(CLAUDE.md 5.2)。以前は上限の判定が危機の判定より前にあり、
      // 長い打ち明けほど判定も通知もされなかった。サインが無ければ、今までどおり止めて、生徒向けの文面
      // (src/notices.mjs。notice)を返す(error は記録・開発用)。
      let overLimit: "too_long" | "rate_limited" | null = text.length > MAX_TEXT_LENGTH ? "too_long" : null;
      if (!overLimit) {
        const { data: used } = await db.rpc("recent_turn_count", { p_client_id: clientId });
        if ((used ?? 0) >= RATE_LIMIT) overLimit = "rate_limited";
      }
      let overLimitCrisis = false;
      if (overLimit) {
        const local = classifyLocal(text, overLimit);
        if (local.stage === 2) {
          // 同じ固定の文を1回の会話で2回出さない(2026年10月14日)。1回目は固定応答・2回目は短い別の1通。
          // 3回目からは、上限を超えていても、ふだんの流れ(危機の状態の指示つきの生成)で受ける(危機の返事を止めないため)
          const limitHist = await loadHistForLimit(db, sessionId);
          const decided = defaultCrisisReplyFor(limitHist, categoryOfSafety(local), declinedPeopleFrom(limitHist));
          if (decided.kind !== "generate" && decided.text) return await overLimitCrisisReply(db, sessionId, text, local, decided.text);
          overLimitCrisis = true;
        }
      }
      if (overLimit && !overLimitCrisis) {
        return overLimit === "too_long"
          ? json({ error: "長すぎます", notice: TOO_LONG_NOTICE }, 400)
          : json({ error: "しばらく時間をおいてから、またどうぞ。", notice: RATE_LIMIT_NOTICE, rate_limited: true }, 429);
      }

      // phase以下はフェーズ1(インテーク)用(構造化面接AI統合 手順5)。
      // phase2に進んだセッションでは、applyIntakeUpdate()がこれ以上変更しない。
      // 段階ごとの応答(危機検知の作り直し 第2段階・仮。設定 CRISIS_RESPONSE=staged)のときは、
      // 見守り・危機の応答の状態(db/schema.sql 11節〜13節)も読む。状態の列がまだ無い(SQL未実行の)DBなら、
      // このリクエストは第1段階の動きにする(設定を誤っても会話そのものは止めない)。
      let stagedOn = stagedResponseEnabled();
      const sessWithState = stagedOn
        ? await db.from("sessions")
          .select(`id,weight,relation,turns_since_summary,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state,${SAFETY_STATE_COLUMNS}`)
          .eq("id", sessionId).single()
        : null;
      if (sessWithState?.error) {
        console.error("段階ごとの応答の状態を読めませんでした(db/schema.sql 11節〜14節が未実行?)。第1段階の動きにします:", sessWithState.error.message);
        stagedOn = false;
      }
      const sess = sessWithState && !sessWithState.error
        ? sessWithState.data
        : (await db.from("sessions")
          .select("id,weight,relation,turns_since_summary,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state")
          .eq("id", sessionId).single()).data;
      if (!sess) return json({ error: "セッションが見つかりません" }, 404);

      timer.mark("session_read");
      // このターンで記録に残す印(AI の返事の行の flags に足す。2026年10月14日)
      const turnFlags: string[] = [];

      // 発言を保存(失敗しても会話は続ける。下で記録の印を残し、その会話では固定の文を出さない)
      const userSave = await checkedWrite("相談者の発言", () => db.from("messages")
        .insert({ session_id: sessionId, role: "user", body: text }).select("seq").single());
      const userMsg = userSave.data as { seq: number } | null;
      if (!userSave.ok) turnFlags.push(`${STATE_SAVE_FAILED_FLAG}(相談者の発言を保存できなかった)`);

      // これまでの会話(今回の発言を含む)。会話の流れ(src/flow.mjs)を数えるため、判定より前に読む(2026年10月11日)。
      // 14節の列(choices・choice_set・choice_id)が無い DB では、無いまま読む
      type HistRow = {
        role: string; body: string; crisis?: boolean; flags?: unknown; crisis_step?: number | null;
        question_level?: string | null; summarized?: boolean | null; mode?: string[] | null;
        choices?: unknown; choice_set?: string | null; choice_id?: string | null;
      };
      const hist = (await selectRowsWithFallback(
        () => db.from("messages").select("role,body,crisis,flags,crisis_step,question_level,summarized,mode,choices,choice_set,choice_id").eq("session_id", sessionId).order("seq"),
        () => db.from("messages").select("role,body,crisis,flags,crisis_step,question_level,summarized,mode").eq("session_id", sessionId).order("seq"),
        () => db.from("messages").select("role,body,crisis,flags,question_level,summarized,mode").eq("session_id", sessionId).order("seq"),
      )) as unknown as HistRow[];
      // 発言の保存に失敗したときは、記録に無い今回の発言を足して続ける
      if (!userSave.ok) hist.push({ role: "user", body: text, flags: [...turnFlags] });
      timer.mark("history_read");
      const prior = hist.slice(0, -1);
      // 状態の保存に失敗したことがある会話か(その会話では固定の文を出さず、指示つきの生成で返す。人が決めた)
      const unreliable = stateUnreliable(hist);
      // 本人が断った相手(src/declined.mjs。会話の記録から毎ターン数え直す)
      const declined = declinedPeopleFrom(hist);

      // チップ(2026年10月14日)。状態ではなく、直前の AI の返事に保存したチップから受け取る。押した(choice_id)ときも、
      // 同じラベル・数字を手で打ったときも同じ扱い。どの組でも、チップのターンは分類器にかけない(ラベルは本人の言葉ではないため)
      const picked = resolveChoice(prior, choiceId, text);
      const flowChoice = picked?.set === FLOW_CHOICE_SET ? picked : null;
      if (picked) {
        const cur = hist[hist.length - 1];
        if (cur) { cur.choice_set = picked.set; cur.choice_id = picked.id; }
        if (userMsg?.seq != null) {
          await checkedWrite("チップの記録", () => db.from("messages")
            .update({ choice_set: picked.set, choice_id: picked.id, choice_input: picked.input }).eq("seq", userMsg.seq));
        }
      }
      // インテークの答え(数字だけ)も分類器にかけない(fix-after-shima4.md 1-2。3ターン目の「3」で段階2になった)。
      // 文章で答えたときは本人の言葉なので、今までどおり判定にかける
      const intakeAnswer = !picked && sess.phase === "intake" && typedScale(text) != null;

      // ---- 入力フィルタ ----
      // 構造化面接AI統合 手順4より、危機分岐は risk に加えて subject(self/other)でも振り分ける。
      // 「本人の危機(self)」だけが生成スキップ+固定応答(CLAUDE.md 5.2)の対象。
      // 「友人等、第三者の安全への懸念(other)」と、曖昧な危機サイン(watch=Tier B)は、
      // どちらも生成は続けつつ、この1ターンだけ safetyContext で AI の応答の仕方を絞り込む
      // (src/generate.mjs の buildSystem 参照)。
      //
      // 危機検知は v2(段階つき。src/classify.mjs の classifyStaged)が既定(2026年9月26日、
      // 危機検知の作り直し 第1段階を採用)。設定 CRISIS_DETECTION=v1 のときだけ、今までの classify() を使う。
      // 段階2 = crisis(固定応答)、段階1 = watch(Tier B)として、下の既存の分岐をそのまま通る。
      // v2 では、今回の発言より前の直近のやりとりも文脈として分類器に渡す(直前のAIの問いかけが
      // 見えないと、「早く終わってほしい」=この面談を早く終えたい、を危機と取り違えるため)。
      // Tier Aの固定応答も、生徒に実際に見えた言葉として含める。
      //
      // 設定 CRISIS_RESPONSE=staged(第2段階・仮)のときは、src/crisis-response.mjs の assessSafetyTurn が
      // 見守り・危機の応答の状態をふまえて、このターンの扱い(plan)を決める(固定の文面を分けて出す・
      // 気づかいのカード・引き下がりへのまとめの1通・見守り中の再サインで段階2 など。CLAUDE.md 5.16)。
      let safety: Awaited<ReturnType<typeof classify>>;
      let eventKeywords: string[];
      let eventReason: string;
      type Plan = Awaited<ReturnType<typeof assessSafetyTurn>>["plan"] & { suppressed?: string };
      let plan: Plan | null = null;
      // 分類器にかけないターン(チップ・インテークの数字。2026年10月14日)
      const skipReason = picked ? (picked.set === FLOW_CHOICE_SET ? "flow_choice" : "choice") : intakeAnswer ? "intake_answer" : null;
      // このターンで使う「断った相手」(3通目への答えの判定が返した相手も、このターンから足す)
      let declinedNow: string[] = declined;
      // 本番の既定(段階ごとの応答が無効)で、本人の危機を指示つきの生成で受けるターン(2回目の短い1通も出し終えた・
      // 状態の保存に失敗した会話。CLAUDE.md 5.2。2026年10月14日)
      let defaultCrisisGen = false;
      if (crisisDetectionVersion() === "v2") {
        // 直近のやりとり(分類器の文脈)。以前は DB から読み直していたが、上で読んだ会話の記録から取る(往復を1回減らす)
        const classifierContext = prior.slice(-CLASSIFIER_CONTEXT_MESSAGES)
          .map((m) => ({ role: m.role === "ai" ? "ai" : "user", text: String(m.body ?? "") }));
        let v2: Awaited<ReturnType<typeof classifyStaged>>;
        if (stagedOn && picked && picked.set !== FLOW_CHOICE_SET) {
          // 危機の流れのチップ。状態が記録とずれていたら、記録(直前の返事のチップ)に合わせる
          const assessed = await assessSafetyTurn(text, classifierContext, sess, picked, { declined });
          v2 = assessed.staged;
          plan = assessed.plan;
          if (assessed.stateMismatch) turnFlags.push(STATE_MISMATCH_FLAG);
        } else if (skipReason) {
          const assessed = assessFlowChoiceTurn(sess, skipReason, declined);
          v2 = assessed.staged as Awaited<ReturnType<typeof classifyStaged>>;
          if (stagedOn) plan = assessed.plan;
        } else if (stagedOn) {
          const assessed = await assessSafetyTurn(text, classifierContext, sess, null, { declined });
          v2 = assessed.staged;
          plan = assessed.plan;
          declinedNow = assessed.declined ?? declined;
          const estimated = (assessed.teacher?.declined ?? []).filter((p: string) => !declined.includes(p));
          if (estimated.length) turnFlags.push(declinedEstimateFlag(estimated));
        } else {
          // 本番の既定でも、このセッションで本人の危機の固定応答をすでに出していれば、「その発言そのものに新しい危機のサインが
          // あるか」を見る判定(CLASSIFIER_PROMPT_V2_FOLLOWUP。段階ごとの応答で使っているもの)にする(2026年10月11日。人が確認)。
          // 通常の判定は直前の「死にたい」を引きずり、固定応答のあとの「うん」「学校のこと」「どうすればいいの」まで危機と判定して、
          // 同じ固定応答と職員への通知がくり返し出ていたため。キーワード・受動パターンによる強制判定は、どちらの判定でも同じ。
          // 設定 CRISIS_AFTERCARE=off のときは以前の動き
          const afterFixedReply = aftercareEnabled() && hadCrisisReply(prior);
          v2 = await classifyStaged(text, classifierContext, afterFixedReply ? { mode: "followup" } : undefined);
        }
        safety = v2;
        // どの規則で段階が決まったかを、既存の列(keywords・model_reason)にも残す
        // (第2段階の専用の列 stage・decided_by は、設定 CRISIS_RESPONSE=staged のときだけ書く)
        eventKeywords = keywordLog(v2);
        const stageForLog = plan ? plan.stage : v2.stage;
        const rulesForLog: string[] = plan ? plan.decidedBy : v2.decidedBy;
        eventReason = `${v2.model.reason}(段階${stageForLog}: ${rulesForLog.join(",") || "なし"})`;
      } else if (skipReason) {
        safety = assessFlowChoiceTurn(sess, skipReason).staged as Awaited<ReturnType<typeof classify>>;
        eventKeywords = [];
        eventReason = safety.model.reason;
      } else {
        safety = await classify(text);
        eventKeywords = safety.keywords;
        eventReason = safety.model.reason;
      }
      timer.mark("classify");

      if (plan) {
        // ---- 段階ごとの応答(第2段階・仮)----
        // 状態の保存に失敗したことがある会話では、固定の文を出さず、指示つきの生成で返す(誤った状態のまま進めない。人が決めた)。
        // 同じ固定の文は、1回の会話で2回出さない(出そうとしたら止めて、生成に切り替える。2026年10月14日)
        if (unreliable && plan.action === "fixed") plan = toGenerationPlan(plan, "state_unreliable") as Plan;
        plan = dedupeFixedPlan(plan, prior) as Plan;
        // 通知は段階2を検知するたび(今と同じ)。記録は、段階1以上・見守りの開始/終了・引き下がり
        // (safety_events.retraction 列。db/schema.sql 13節)・危機の応答の続きのターン(plan.event がある場合)に書く。
        const notified = plan.notify ? await notifyCrisis(sessionId, plan.notifySubject) : false;
        // 相談者が押したチップ・書いた数字(スケーリング)を、相談者の発言の行に記録する(研究のデータとしても使う)
        const uc = plan.userChoice;
        if (uc && userMsg?.seq != null) {
          await checkedWrite("チップの記録", () => db.from("messages").update({
            choice_set: uc.set, choice_id: uc.id, choice_input: uc.input,
          }).eq("seq", userMsg.seq));
        }
        if (plan.event) {
          const ev = plan.event;
          const saved = await checkedWrite("安全の記録", () => db.from("safety_events").insert({
            session_id: sessionId, risk: ev.risk, subject: ev.subject, keywords: eventKeywords,
            model_risk: safety.model.risk, model_reason: eventReason, notified,
            stage: ev.stage, decided_by: ev.decided_by, watch_event: ev.watch_event,
            retraction: ev.retraction, teacher_answer: ev.teacher_answer, crisis_step: ev.crisis_step,
            negation_type: ev.negation_type, negation_words: ev.negation_words, scale: ev.scale,
            lowered: ev.lowered, figurative: ev.figurative, crisis_category: ev.crisis_category,
          }));
          if (!saved.ok) turnFlags.push("記録のみ:安全の記録の保存に失敗");
        }
        // 段階2(本人): 生成をスキップして、固定の文面を返す(CLAUDE.md 5.2 の分岐を保つ)。
        // 吹き出しが複数(2通目の「心配」+3通目)のときは1行ずつ保存し、画面は1〜2秒おいて1つずつ出す。
        // チップは最後の吹き出しの行に記録する。
        // 状態を先に保存し、保存できなければ固定の文は出さず、指示つきの生成に切り替える(2026年10月14日。相談ログ 86130eef では、
        // 状態の保存がだまって失敗し、押したチップが受け付けられず、同じ固定の文がくり返された)
        if (plan.action === "fixed" && plan.bubbles) {
          const fixedPlan = plan;
          const stateSave = await checkedWrite("セッションの状態", () => db.from("sessions")
            .update({ ...fixedPlan.nextState, last_at: new Date().toISOString() }).eq("id", sessionId));
          if (!stateSave.ok) {
            turnFlags.push(`${STATE_SAVE_FAILED_FLAG}(${String(stateSave.error?.message ?? "").slice(0, 120)})`);
            plan = toGenerationPlan(plan, "state_save_failed") as Plan;
          } else {
            const replies: { body: string; card: string | null; crisis_step: number; seq?: number }[] = [];
            let bubbleSaveFailed = false;
            for (const [i, b] of fixedPlan.bubbles.entries()) {
              const last = i === fixedPlan.bubbles.length - 1;
              const row: Record<string, unknown> = {
                session_id: sessionId, role: "ai", body: b.text, crisis: true,
                safety_stage: fixedPlan.stage, crisis_step: b.crisisStep, safety_card: b.card,
                ...(i === 0 && turnFlags.length ? { flags: turnFlags } : {}),
                ...(last && fixedPlan.choices ? { choices: fixedPlan.choices.items, choice_set: fixedPlan.choices.set } : {}),
                ...(last ? { timings: timer.done(), settings: settingsSnapshot() } : {}),
              };
              let saved = await checkedWrite("危機の固定の文面", () => db.from("messages").insert(row).select("seq").single());
              if (!saved.ok) {
                saved = await checkedWrite("危機の固定の文面(16節の列なし)", () => db.from("messages")
                  .insert(withoutKeys(row, SECTION16_MESSAGE_COLUMNS)).select("seq").single());
              }
              if (!saved.ok) bubbleSaveFailed = true;
              replies.push({ body: b.text, card: b.card, crisis_step: b.crisisStep, seq: (saved.data as { seq?: number } | null)?.seq });
            }
            // 返事を記録に残せなかったら、その会話では固定の文を出さない(同じ文のくり返しを記録から見つけられないため)
            if (bubbleSaveFailed) await markUserRow(db, userMsg?.seq, `${STATE_SAVE_FAILED_FLAG}(危機の固定の文面を保存できなかった)`);
            return json({
              reply: fixedPlan.text, crisis: true, crisis_step: fixedPlan.crisisStep, card: fixedPlan.card, care_line: null,
              replies, choices: fixedPlan.choices?.items ?? null, choice_set: fixedPlan.choices?.set ?? null,
              choice_note: fixedPlan.choices ? CHOICE_NOTE_PROVISIONAL : null,
              safety: { risk: fixedPlan.risk, subject: fixedPlan.subject, keywords: safety.keywords.length, model: safety.model.risk, stage: fixedPlan.stage },
              user_seq: userMsg?.seq, ai_seq: replies[replies.length - 1]?.seq,
              ...(devPanel() ? { timings: timer.done() } : {}),
            });
          }
        }
        if (plan.suppressed) turnFlags.push(`記録のみ:固定の文を出さず指示つきの生成にした(${plan.suppressed})`);
      } else {
        const isSelfCrisis = safety.risk === "crisis" && safety.subject === "self";
        if (safety.risk !== "none") {
          const notified = safety.risk === "crisis" ? await notifyCrisis(sessionId, safety.subject) : false;
          const saved = await checkedWrite("安全の記録", () => db.from("safety_events").insert({
            session_id: sessionId, risk: safety.risk, subject: safety.subject, keywords: eventKeywords,
            model_risk: safety.model.risk, model_reason: eventReason, notified,
          }));
          if (!saved.ok) turnFlags.push("記録のみ:安全の記録の保存に失敗");
        }

        // 本人の危機(Tier A・self)なら生成をスキップして固定応答(CLAUDE.md 5.2)。
        // 同じ固定応答を1回の会話で2回出さない(2026年10月14日に人が決めた): 2回目は短い別の固定の1通(危機カードつき)、
        // 3回目からは危機の状態の指示つきの生成。状態の保存に失敗した会話も生成。どれも断った相手は挙げない
        if (isSelfCrisis) {
          // 「〜が、とても心配です」は、当たった語の種類で組む(src/crisis-texts.mjs。2026年10月9日。「重い」は使わない)
          const decided = defaultCrisisReplyFor(prior, categoryOfSafety(safety), declinedNow);
          if (decided.kind !== "generate" && decided.text) {
            const reply = decided.text;
            const row: Record<string, unknown> = {
              session_id: sessionId, role: "ai", body: reply, crisis: true,
              ...(turnFlags.length ? { flags: turnFlags } : {}), timings: timer.done(), settings: settingsSnapshot(),
            };
            let saved = await checkedWrite("危機の固定応答", () => db.from("messages").insert(row).select("seq").single());
            if (!saved.ok) {
              saved = await checkedWrite("危機の固定応答(16節の列なし)", () => db.from("messages")
                .insert(withoutKeys(row, SECTION16_MESSAGE_COLUMNS)).select("seq").single());
            }
            if (!saved.ok) await markUserRow(db, userMsg?.seq, `${STATE_SAVE_FAILED_FLAG}(危機の固定応答を保存できなかった)`);
            await checkedWrite("最後の時刻", () => db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId));
            return json({
              reply, crisis: true,
              safety: { risk: safety.risk, subject: safety.subject, keywords: safety.keywords.length, model: safety.model.risk },
              user_seq: userMsg?.seq, ai_seq: (saved.data as { seq?: number } | null)?.seq,
              ...(devPanel() ? { timings: timer.done() } : {}),
            });
          }
          defaultCrisisGen = true;
          turnFlags.push(`記録のみ:本人の危機を指示つきの生成で受けた(${"reason" in decided ? decided.reason : "fixed_repeat_suppressed"})`);
        }
      }

      // ---- 生成 ----
      // ナレッジ検索・システムプロンプト構築・本生成+NG検知時の再生成は src/generate.mjs
      // (docs/backlog.md 1-3 のテスト2〜4と同じロジックを使うため)。
      // Geminiの安全フィルタ等で応答が得られない/JSONとして読めないことがあるが、
      // その場合も技術的なエラーを生徒にそのまま見せず、受け止めだけの返答で会話を続ける
      // (generateReply内で処理)。見逃さないよう flags に記録し、心理士のレビュー画面で
      // 頻度を確認できるようにしておく。
      // 段階ごとの応答が無効(本番の既定)のときも、このセッションで本人の危機の固定応答を出していれば、
      // 以後の生成に危機のあとの指示を付ける(2026年10月5日。CLAUDE.md 5.17)。固定応答の次のターンで
      // 「なんでもない」と書くと、ふつうの会話に戻ってしまっていたため。判定と固定応答の分岐は変えていない
      const afterCrisis = !plan && aftercareEnabled() && hadCrisisReply(hist);
      // 段階ごとの応答のときは、終わり方(本人が終わりの合図を出したとき)も段階で変える(嶋先生 10/7。仮):
      // 危機のあと = 決まった締めの文面を足す(下)/ 段階1 = 労い+「またここに来てね」+窓口の場所
      const planContexts: string[] = plan ? [...plan.safetyContexts] : [];
      if (plan) {
        if (planContexts.includes("afterCrisis")) planContexts.push("crisisEnding");
        else if (planContexts.includes("tierB")) planContexts.push("stage1Ending");
      }
      // 本番の既定で本人の危機を生成で受けるターンは、段階ごとの応答と同じ「危機の状態の指示」を付ける(2026年10月14日)
      const safetyContext = plan ? planContexts
        : defaultCrisisGen ? ["crisisGeneration", "afterCrisis"]
          : defaultSafetyContexts({ risk: safety.risk, subject: safety.subject, afterCrisis });
      // 会話の流れ(フェーズ2のときだけ使う。src/flow.mjs)。このターンの段階は、見立て・気になったことを出してよいかの判定に使う
      const flowPhase = flowPhaseFor(sess, safetyContext);
      const turnStage = plan ? plan.stage
        : Math.max(safety.risk === "crisis" ? 2 : safety.risk === "watch" ? 1 : 0, afterCrisis ? 1 : 0);
      const stats = flowStats(hist, sess, { choiceId: flowChoice?.id ?? null, stage: turnStage, contexts: safetyContext });
      // まとめが要るとき(区切り・意味を見失った言葉・整理を選んだ・前のターンでまとめた)は、IS8・T16 を必ず参照させる
      const summaryKnowledge = flowPhase === "phase2" && !stats.crisis
        && ((sess.turns_since_summary ?? 0) >= 6 || LOST_MEANING_RE.test(text) || flowChoice?.id === "G2" || stats.lastWasSummary)
        ? ["IS8", "T16"] : undefined;
      const rows = await loadKnowledge(db);
      timer.mark("knowledge");
      // recommended_modeは手順6でretrieve()に渡し、フェーズ2ではモード一致のナレッジも
      // 引き出しやすくする(intake中は空配列なので、これまで通り影響しない)。
      const chunks = retrieve(
        rows, text, sess.weight, sess.relation, undefined, safetyContext, sess.recommended_mode, summaryKnowledge,
      );

      const messages = hist
        // 危機の固定応答(CRISIS_REPLY)は、今まで通り生成の会話履歴に含めない。段階ごとの応答で分けた文面
        // (crisis_step あり)は、短い受け止めや案内なので、外すと会話がつながらなくなるため含める(第2段階)
        .filter((h) => !h.crisis || h.crisis_step != null)
        .map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: String(h.body ?? "") }] }));
      // このセッションで既に何回、生成失敗の固定応答を返しているか(2026年9月・2-2)。
      // 同じ文言を繰り返さないよう generateReply() に渡す(嶋先生「同じメッセージが
      // 2回来ると傷つく」の指摘への対処)。
      const priorFailureCount = hist.filter((h) => Array.isArray(h.flags)
        && (h.flags as string[]).some((f) => f.startsWith("生成失敗→固定応答で継続"))).length;

      // つらさスケールを数字で答えないと、前のターンで本人が示したか(2026年10月11日・やり残し 2-7。sessions の列ではなく印で持つ)
      (sess as Record<string, unknown>).distress_declined = hist.some((h) => Array.isArray(h.flags)
        && (h.flags as string[]).includes(DISTRESS_DECLINED_FLAG));

      const { data: memory } = await db.from("person_memory")
        .select("summary").eq("client_id", clientId).maybeSingle();
      // sessをそのままintake引数として渡す(phase/chief_complaint_category等の列名が
      // buildSystem/applyIntakeUpdateが期待する形と一致するように選択している)。
      const system = buildSystem(
        rows, chunks, sess.weight, sess.notes, sess.turns_since_summary, memory?.summary,
        safetyContext, sess, { stats, text, declined: declinedNow },
      );

      // 危機の状態で、固定の文面を出さずに生成で受けるターン(段階ごとの応答・仮。CLAUDE.md 5.2)は、出力チェックを
      // 強め(「いつでも」・数字・秘密の約束・このAIだけを頼らせる言い方も通さない)、再生成しても通らなければ、
      // 固定の返事(仮)に置き換える。職員への通知は上で出している
      const crisisGenerated = plan?.crisisGenerated === true || defaultCrisisGen;
      // 会話の流れのチェック(受け止めのみの3回目・汎用の言葉の2回目など。作り直し1回)は、フェーズ2の生成だけ。
      // 危機の状態で生成するターンでは使わない(そちらの出力チェックと固定の返事を優先する)
      const useFlow = flowPhase === "phase2" && !crisisGenerated;
      // 本人が断った相手を勧める言い方(src/declined.mjs)と、AI から会話を終える形(src/flow.mjs)は、どの生成でも確かめる(2026年10月14日)
      const declinedChecks = declinedNg(declinedNow);
      const declinedHint = declinedChecks.length ? "相談者が断った相手に話すこと・相談することを勧めない。" : "";
      const endCheck = (o: Record<string, unknown>) => aiEndingCheck(o, { text, closingState: sess.closing_state });
      const generated = await generateReply(
        system, messages, undefined, undefined, undefined, priorFailureCount,
        crisisGenerated
          ? { extraNg: [...CRISIS_GENERATION_EXTRA_NG, ...declinedChecks], fixHint: CRISIS_GENERATION_FIX_HINT + declinedHint, endCheck }
          : useFlow
            ? { flowCheck: (o: Record<string, unknown>) => flowCheck(o, stats), flowFixHint, extraNg: declinedChecks, fixHint: declinedHint, endCheck }
            : { extraNg: declinedChecks, fixHint: declinedHint, endCheck },
      );
      timer.mark("generate");
      const priorCrisisFallbacks = hist.filter((h) => Array.isArray(h.flags)
        && (h.flags as string[]).some((f) => f.startsWith(CRISIS_FALLBACK_FLAG))).length;
      const finalized = crisisGenerated
        ? finalizeCrisisGeneration(generated, priorCrisisFallbacks)
        : { out: generated.out, flags: generated.flags };
      // 生成に失敗した(安全フィルターのブロック・すべてのモデルの失敗)とき、危機のあと・気がかり・第三者の場面なら、
      // ふつうの固定の返事(「もう少し聞かせて」)ではなく、場面ごとの一言とカードで受ける(2026年10月11日。仮。
      // docs/proposal-safety-filter-fallback.md)。危機の状態で生成したターン(段階ごとの応答)は上の固定の返事のまま
      const priorContextFallbacks = hist.filter((h) => Array.isArray(h.flags)
        && (h.flags as string[]).some((f) => f.startsWith(CONTEXT_FAILURE_FLAG))).length;
      const fallback = !crisisGenerated && generated.generationFailed
        ? contextFailureReply(safetyContext, priorContextFallbacks) : null;
      if (fallback) {
        finalized.out = { ...finalized.out, reply: fallback.reply };
        finalized.flags = [`${CONTEXT_FAILURE_FLAG}(${fallback.scene}・${generated.failureCause})`];
      }
      // 実際のエラー文も短く残す(以前は原因の分類だけで、中身が DB に残らなかった。やり残しの一覧 2-2)
      if (generated.generationFailed && generated.failureDetail) {
        finalized.flags = [...finalized.flags, `失敗の詳細: ${String(generated.failureDetail).slice(0, 160)}`];
      }
      // 危機のあと・第三者の場面で失敗したときは、管理画面の「確認待ち」に並べる(職員への通知は出さない。人が決めた)
      if (fallback?.review) {
        await checkedWrite("生成失敗の確認待ち", () => db.from("safety_events").insert({
          session_id: sessionId, risk: safety.risk !== "none" ? safety.risk : "watch", subject: safety.subject,
          keywords: [], model_risk: safety.model.risk, notified: false,
          model_reason: `【生成失敗・確認待ち】${fallback.scene === "afterCrisis" ? "危機のあと" : "第三者の心配"}の返事を生成できず、場面の一言で受けた(${generated.failureCause})`,
        }));
      }
      const fallbackCard: string | null = fallback ? fallback.card : null;
      // 会話の流れ: まとめの形の確かめ(満たさなければ区切りとして数えない)・返し方と強い言葉の記録・組G のチップ
      const flowDone = useFlow && !generated.generationFailed ? finalizeFlow(finalized.out, stats) : null;
      let out = flowDone ? flowDone.out : finalized.out;
      // 返事が空にならないようにする(どの経路でも、必ず1つ以上の返事を返す。2026年10月14日。相談ログ 86130eef の10ターン目)
      const emptyReply = !String(out?.reply ?? "").trim();
      if (emptyReply) out = { ...out, reply: fallback?.reply ?? EMPTY_REPLY_FALLBACK_PROVISIONAL };
      const flowChoices = flowDone?.offerChoices ? CHOICES_G_PROVISIONAL : null;
      // 段階1以上で「大丈夫」の直後の返事に「よかった/安心した」があれば記録だけする(作り直さない。嶋先生 10/7。本番の既定でも)
      const stageForNote = plan ? plan.stage
        : Math.max(safety.risk === "crisis" ? 2 : safety.risk === "watch" ? 1 : 0, afterCrisis ? 1 : 0);
      const note = daijoubuYokattaNote(text, out.reply, stageForNote);
      const declinedNote = distressDeclinedNote(sess, out);
      const flags: string[] = [
        ...turnFlags, ...finalized.flags, ...(note ? [note] : []), ...(declinedNote ? [declinedNote] : []), ...(flowDone?.notes ?? []),
        ...(emptyReply ? [EMPTY_REPLY_FLAG] : []),
      ];

      // ---- セッション状態の更新(記憶フィルタ含む。src/generate.mjs で共通化) ----
      const { weight, relation, turns_since_summary: since, notes } = applyTurnUpdate(sess, out);
      // フェーズ1(インテーク)のスロット更新。sess.phase!=="intake"なら空オブジェクト
      // (構造化面接AI統合 手順5)。sessionsへは差分(intakePatch)だけを書き込み、
      // messagesへはこのターン時点の現在値(mergedIntake)をスナップショットとして残す
      // (weight/relationと同じ、db/schema.sql 9.3の意図)。
      // applyModeUpdate/applyClosingUpdateはsess.phase==="phase2"の時だけ働く
      // (手順6・7)。それぞれ別のキー(recommended_mode/closing_state)しか
      // 返さないので、そのままマージしてよい。ただしクロージングは、危機の応答のあとでインテーク中でも
      // 自由な進め方(クロージングのルールつき)で生成したターンなら記録する(flowPhaseFor。2026年10月6日)。
      const intakePatch = {
        ...applyIntakeUpdate(sess, out), ...applyModeUpdate(sess, out),
        ...applyClosingUpdate(sess, out, flowPhaseFor(sess, safetyContext)),
      };
      const mergedIntake = { ...sess, ...intakePatch };
      // このターンでクロージングの要約に入った(closing_stateがclosedになった)かどうか。
      // 画面側で「話せる窓口」の案内カードを出すために使う(手順7。CLAUDE.md 5.15)。
      const justClosed = intakePatch.closing_state === "closed";
      // 危機のあと(段階ごとの応答のとき)の区切りでは、決まった締めの文面を別の行で足し、区切りのカードはそちらに出す
      const endingAppend = !!plan && justClosed && planContexts.includes("crisisEnding");

      const aiRow = {
        session_id: sessionId, role: "ai", body: out.reply,
        weight, relation, question_level: out.question_level, role_kind: out.role,
        summarized: out.did_summarize === true,
        hypothesis: out.hypothesis ?? null, why: out.why ?? null,
        used: out.used ?? chunks.map((c: { id: string }) => c.id), flags,
        distress_level: mergedIntake.distress_level ?? null,
        mode: mergedIntake.recommended_mode ?? [],
        ambivalence_detected: mergedIntake.ambivalence_detected ?? null,
        closing: justClosed && !endingAppend,
        // 段階ごとの応答(第2段階)のときだけ: このターンの段階と、返事の下に出すカードと、
        // 危機の状態で生成した返事か(管理画面で見分けるため。db/schema.sql 12節)
        ...(plan ? { safety_stage: plan.stage, safety_card: plan.card, crisis_generated: crisisGenerated } : {}),
        // 生成失敗の場面の一言に添えるカード(本番の既定でも。safety_card は db/schema.sql 11節の列)
        ...(fallbackCard ? { safety_card: fallbackCard } : {}),
        // 整理・作業の提案のチップ(組G。仮。14節の列)
        ...(flowChoices ? { choices: flowChoices, choice_set: FLOW_CHOICE_SET } : {}),
        // 研究のための記録(16節。2026年10月14日): 実際に返事をしたモデル・プロンプトの版・ナレッジの版・設定・所要時間
        model: generated.usedModel ?? null,
        prompt_version: promptVersionOf(system), knowledge_version: knowledgeVersion(rows),
        settings: settingsSnapshot(), timings: timer.done(),
      };
      let aiSave = await checkedWrite("AIの返事", () => db.from("messages").insert(aiRow).select("seq").single());
      // 16節が未実行の DB では、その列を外して書き直す
      if (!aiSave.ok) {
        aiSave = await checkedWrite("AIの返事(16節の列なし)", () => db.from("messages")
          .insert(withoutKeys(aiRow, SECTION16_MESSAGE_COLUMNS)).select("seq").single());
      }
      // 11節・14節が未実行の DB で safety_card・choices が無いときも、返事そのものは必ず保存する(カード・チップは画面にだけ出す)
      if (!aiSave.ok && (fallbackCard || flowChoices) && !plan) {
        aiSave = await checkedWrite("AIの返事(カード・チップの列なし)", () => db.from("messages")
          .insert(withoutKeys(aiRow, [...SECTION16_MESSAGE_COLUMNS, "safety_card", "choices", "choice_set"])).select("seq").single());
      }
      const aiMsg = aiSave.data as { seq?: number } | null;
      // 返事を記録に残せなかったら、その会話では固定の文を出さない(同じ文のくり返しを記録から見つけられないため)
      if (!aiSave.ok) await markUserRow(db, userMsg?.seq, `${STATE_SAVE_FAILED_FLAG}(AIの返事を保存できなかった)`);

      // 危機のあと(段階ごとの応答のとき)に本人が終わりの合図を出したら、決まった締めの文面を1つ足す(3案を人ごとに順に。嶋先生 10/7。仮)。
      // 「応援し続ける」は何度伝えてもよいが、言い回しは毎回変える
      const after: { body: string; seq?: number; crisis_step: number }[] = [];
      if (plan && endingAppend) {
        const { data: lastEnding } = await db.from("messages")
          .select("ending_variant, sessions!inner(client_id)")
          .eq("sessions.client_id", clientId).not("ending_variant", "is", null)
          .order("seq", { ascending: false }).limit(1).maybeSingle();
        const variant = nextEndingVariant((lastEnding as { ending_variant?: number } | null)?.ending_variant ?? null);
        const body = CRISIS_ENDINGS_PROVISIONAL[variant - 1];
        const endSave = await checkedWrite("締めの文面", () => db.from("messages").insert({
          session_id: sessionId, role: "ai", body, crisis: true, crisis_step: 14, ending_variant: variant,
          safety_stage: plan.stage, closing: true,
        }).select("seq").single());
        after.push({ body, seq: (endSave.data as { seq?: number } | null)?.seq, crisis_step: 14 });
      }

      // セッションの状態の保存。失敗したら、この返事の行に印を残し、その会話では以後、固定の文を出さない(人が決めた)
      const stateSave = await checkedWrite("セッションの状態", () => db.from("sessions").update({
        weight, relation, turns_since_summary: since, notes,
        last_at: new Date().toISOString(),
        ...intakePatch,
        ...(plan ? plan.nextState : {}),
      }).eq("id", sessionId));
      if (!stateSave.ok) {
        const failFlag = `${STATE_SAVE_FAILED_FLAG}(${String(stateSave.error?.message ?? "").slice(0, 120)})`;
        if (aiMsg?.seq != null) {
          await checkedWrite("状態の保存の失敗の印", () => db.from("messages").update({ flags: [...flags, failFlag] }).eq("seq", aiMsg.seq));
        } else {
          await markUserRow(db, userMsg?.seq, failFlag);
        }
      }

      // 参照したナレッジは本文も返す(管理画面で見せるため)
      const usedIds: string[] = out.used ?? chunks.map((c: { id: string }) => c.id);
      const usedRows = rows.filter((k: { id: string }) => usedIds.includes(k.id))
        .map((k: { id: string; src: string; cat: string; body: string }) =>
          ({ id: k.id, src: k.src, cat: k.cat, body: k.body }));

      return json({
        reply: out.reply,
        weight, relation,
        question_level: out.question_level, role: out.role,
        summarized: out.did_summarize === true, turns_since_summary: since,
        hypothesis: out.hypothesis ?? "", why: out.why ?? "",
        notes, used: usedRows, flags,
        safety: plan
          ? { risk: plan.risk, keywords: safety.keywords.length, model: safety.model.risk, stage: plan.stage }
          : { risk: safety.risk, keywords: safety.keywords.length, model: safety.model.risk },
        closing: justClosed && !endingAppend,
        after,
        card: fallbackCard ?? plan?.card ?? null,
        care_line: plan?.card === "care" ? CARE_LINE_PROVISIONAL : null,
        choices: flowChoices, choice_set: flowChoices ? FLOW_CHOICE_SET : null,
        choice_note: flowChoices ? CHOICE_NOTE_PROVISIONAL : null,
        user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
        ...(devPanel() ? { timings: timer.done() } : {}),
      });
    }

    return json({ error: "不明な action です" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "サーバ側で問題が起きました", detail: String(e).slice(0, 300) }, 500);
  }
}
