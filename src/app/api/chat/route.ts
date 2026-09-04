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
//   RATE_LIMIT_PER_HOUR      任意  既定 60
//   ADMIN_TOKEN              任意  管理画面(public/admin.html)用の合言葉。
//                                  admin_sessions/admin_session_detail はこれと
//                                  一致しないと401を返す(docs/backlog.md 1-2)
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LITE_MODELS, callGemini, classify, CRISIS_REPLY } from "@/classify.mjs";
import {
  loadKnowledge, knowledgeVersion, retrieve, buildSystem, generateReply, applyTurnUpdate,
} from "@/generate.mjs";

// 安全判定(classify)・人単位の記憶の要約用のモデル一覧、危機判定ロジック本体は src/classify.mjs、
// ナレッジ検索・システムプロンプト構築・本生成ロジックは src/generate.mjs にある
// (scripts/test-*.mjs と共有するため。docs/backlog.md 1-3)。

const WEBHOOK = process.env.CRISIS_WEBHOOK_URL ?? "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR ?? "60");
// 人単位の記憶(person_memory)の上限。DB側の check 制約(person_memory_len_check)とも一致させること。
const MEMORY_MAX_CHARS = 600;
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

// 管理画面(admin.html)用の合言葉チェック。ログイン画面は作らず、
// admin.html が自分のURLのクエリ文字列(?token=...)から読んで
// リクエストボディに admin_token として載せてくる想定(docs/backlog.md 1-2)。
function checkAdminToken(payload: Record<string, unknown>): boolean {
  const token = String(payload.admin_token ?? "");
  return token.length > 0 && token === process.env.ADMIN_TOKEN;
}

// ============================================================================
//  安全層(クライアントには置かない。CRISIS_WORDS/OUTPUT_NG は src/safety.mjs、
//  CRISIS_REPLY/classify は src/classify.mjs)
// ============================================================================
//  人単位の記憶(永続・要約のみ)
//
//  設計原則(CLAUDE.md 5.8と同じ考え方をここにも書く。安全層と同格で守ること):
//   ・生ログは絶対に summary に入れない。要約AIには「短く」を強制する。
//   ・氏名・学校名などの識別情報を書かせない(session notes と同じ制約)。
//   ・「枠組み」を壊さないため、この記憶をAIに詳しく語らせない。
//     buildSystem 側で「聞かれたら答える程度に留め、自分から詳細を持ち出さない」
//     という指示を必ず添える。
// ============================================================================

const SUMMARY_PROMPT =
`あなたは、ある相談者についての「引き継ぎメモ」を更新する係です。
学校のカウンセリングAIが、次にこの人が来たときに参照します。

以下を渡します。
1. これまでの引き継ぎメモ(無ければ空)
2. 今回のセッションで積み上がった見立て(notes)

これらを踏まえて、新しい引き継ぎメモを日本語で書いてください。

厳守事項:
・${MEMORY_MAX_CHARS}字を絶対に超えない。超えるくらいなら削る。
・氏名・学校名・住所など、個人を特定できる情報は書かない。
・具体的な出来事の羅列ではなく、継続して意味を持ちそうな要点だけを残す。
　(例:抱えている大きなテーマ、繰り返し出てくるパターン、これまで試して
　　効かなかった対処、本人のリソース、触れると閉じてしまう話題)
・一度きりの雑談や、その場限りの感情の起伏は残さない。
・前回のメモと今回の内容が矛盾するなら、より新しい方を採用してよい。
・出力はメモ本文のみ。前置きや見出しを付けない。`;

async function updatePersonMemory(clientId: string, sessionNotes: Record<string, unknown>) {
  const hasContent = Object.values(sessionNotes ?? {}).some((v) => v && String(v).trim());
  if (!hasContent) return; // 何も積み上がっていないセッションは要約を更新しない

  const db = getDb();
  const { data: existing } = await db.from("person_memory")
    .select("summary,session_count").eq("client_id", clientId).maybeSingle();

  const prompt = `# 前回までの引き継ぎメモ\n${existing?.summary || "(まだ無い)"}\n\n` +
    `# 今回のセッションの見立て\n${JSON.stringify(sessionNotes)}`;

  let newSummary = existing?.summary ?? "";
  try {
    newSummary = (await callGemini(LITE_MODELS, SUMMARY_PROMPT, [{ role: "user", parts: [{ text: prompt }] }], 400)).trim();
  } catch (e) {
    console.error("人単位の記憶の要約に失敗しました(本体の会話には影響なし):", e);
    return; // 要約生成に失敗しても本体の会話は止めない。次回の更新に任せる。
  }
  if (newSummary.length > MEMORY_MAX_CHARS) newSummary = newSummary.slice(0, MEMORY_MAX_CHARS);

  await db.from("person_memory").upsert({
    client_id: clientId,
    summary: newSummary,
    session_count: (existing?.session_count ?? 0) + 1,
    last_seen: new Date().toISOString(),
  });
}

// 危機通知。本文は送らない。
// 未成年の相談内容を Slack 等のチャンネルに流すのは避け、
// 「確認が必要なセッションがある」ことだけを伝えて、詳細は管理画面で見る運用にする。
async function notifyCrisis(sessionId: string) {
  if (!WEBHOOK) return false;
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `【要確認】相談AIで危機判定が出ました\nセッション: ${sessionId}\n時刻: ${new Date().toISOString()}\n内容は管理画面(pending_safety)で確認してください。`,
      }),
    });
    return true;
  } catch {
    return false;
  }
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
      await db.from("messages").update({ rating, rating_comment: comment ?? null }).eq("seq", seq);
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
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,turn_count,unrated_count,has_crisis")
        .order("started_at", { ascending: false });
      if (error) throw new Error(error.message);
      const sessions = (data ?? []).map((s) => ({
        id: s.id,
        client_id_short: String(s.client_id).slice(0, 8),
        started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
        relation: s.relation, weight: s.weight,
        turn_count: s.turn_count, unrated_count: s.unrated_count, has_crisis: s.has_crisis,
      }));
      return json({ sessions });
    }

    if (action === "admin_session_detail") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const sessionId = String(payload.session_id ?? "").trim();
      if (!sessionId) return json({ error: "session_id が必要です" }, 400);
      const { data: s } = await db.from("sessions")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,notes")
        .eq("id", sessionId).maybeSingle();
      if (!s) return json({ error: "セッションが見つかりません" }, 404);
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at")
        .eq("session_id", sessionId).order("seq");
      const allUsedIds = Array.from(new Set((msgs ?? []).flatMap((m) => m.used ?? [])));
      const knowledgeMap: Record<string, { id: string; src: string; cat: string; body: string }> = {};
      if (allUsedIds.length) {
        const { data: kn } = await db.from("knowledge").select("id,src,cat,body").in("id", allUsedIds);
        for (const k of kn ?? []) knowledgeMap[k.id] = k;
      }
      const messages = (msgs ?? []).map((m) => ({
        ...m,
        used: (m.used ?? []).map((id: string) => knowledgeMap[id] ?? { id, src: "", cat: "", body: "(削除済み)" }),
      }));
      return json({
        session: {
          id: s.id, client_id_short: String(s.client_id).slice(0, 8),
          started_at: s.started_at, last_at: s.last_at, closed_at: s.closed_at,
          relation: s.relation, weight: s.weight, notes: s.notes,
        },
        messages,
      });
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
        await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", open.id);
        await updatePersonMemory(clientId, (open.notes ?? {}) as Record<string, unknown>);
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
        await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", s.id);
        await updatePersonMemory(clientId, (s.notes ?? {}) as Record<string, unknown>);
        return json({ session: null, messages: [] }); // クライアント側が start を呼び直す
      }
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,used,flags,crisis,rating")
        .eq("session_id", s.id).order("seq");
      return json({ session: s, messages: msgs ?? [] });
    }

    // ------------------------------------------------------------------
    // 会話本体
    // ------------------------------------------------------------------
    if (action === "chat") {
      const clientId = String(payload.client_id ?? "").trim();
      const sessionId = String(payload.session_id ?? "").trim();
      const text = String(payload.text ?? "").trim();
      if (!clientId || !sessionId || !text) return json({ error: "パラメータが不足しています" }, 400);
      if (text.length > 2000) return json({ error: "長すぎます" }, 400);

      // レート制限
      const { data: used } = await db.rpc("recent_turn_count", { p_client_id: clientId });
      if ((used ?? 0) >= RATE_LIMIT) {
        return json({ error: "しばらく時間をおいてから、またどうぞ。", rate_limited: true }, 429);
      }

      const { data: sess } = await db.from("sessions")
        .select("id,weight,relation,turns_since_summary,notes")
        .eq("id", sessionId).single();
      if (!sess) return json({ error: "セッションが見つかりません" }, 404);

      // 発言を保存
      const { data: userMsg } = await db.from("messages")
        .insert({ session_id: sessionId, role: "user", body: text }).select("seq").single();

      // ---- 入力フィルタ ----
      const safety = await classify(text);
      if (safety.risk !== "none") {
        const notified = safety.risk === "crisis" ? await notifyCrisis(sessionId) : false;
        await db.from("safety_events").insert({
          session_id: sessionId, risk: safety.risk, keywords: safety.keywords,
          model_risk: safety.model.risk, model_reason: safety.model.reason, notified,
        });
      }

      // 危機なら生成をスキップして固定応答
      if (safety.risk === "crisis") {
        const { data: aiMsg } = await db.from("messages").insert({
          session_id: sessionId, role: "ai", body: CRISIS_REPLY, crisis: true,
        }).select("seq").single();
        await db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId);
        return json({
          reply: CRISIS_REPLY, crisis: true,
          safety: { risk: safety.risk, keywords: safety.keywords.length, model: safety.model.risk },
          user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
        });
      }

      // ---- 生成 ----
      // ナレッジ検索・システムプロンプト構築・本生成+NG検知時の再生成は src/generate.mjs
      // (docs/backlog.md 1-3 のテスト2〜4と同じロジックを使うため)。
      // Geminiの安全フィルタ等で応答が得られない/JSONとして読めないことがあるが、
      // その場合も技術的なエラーを生徒にそのまま見せず、受け止めだけの返答で会話を続ける
      // (generateReply内で処理)。見逃さないよう flags に記録し、心理士のレビュー画面で
      // 頻度を確認できるようにしておく。
      const rows = await loadKnowledge(db);
      const chunks = retrieve(rows, text, sess.weight, sess.relation);

      const { data: hist } = await db.from("messages")
        .select("role,body,crisis").eq("session_id", sessionId).order("seq");
      const messages = (hist ?? [])
        .filter((h) => !h.crisis)
        .map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.body }] }));

      const { data: memory } = await db.from("person_memory")
        .select("summary").eq("client_id", clientId).maybeSingle();
      const system = buildSystem(
        rows, chunks, sess.weight, sess.notes, sess.turns_since_summary, memory?.summary,
      );

      const { out, flags } = await generateReply(system, messages);

      // ---- セッション状態の更新(記憶フィルタ含む。src/generate.mjs で共通化) ----
      const { weight, relation, turns_since_summary: since, notes } = applyTurnUpdate(sess, out);

      const { data: aiMsg } = await db.from("messages").insert({
        session_id: sessionId, role: "ai", body: out.reply,
        weight, relation, question_level: out.question_level, role_kind: out.role,
        summarized: out.did_summarize === true,
        hypothesis: out.hypothesis ?? null, why: out.why ?? null,
        used: out.used ?? chunks.map((c: { id: string }) => c.id), flags,
      }).select("seq").single();

      await db.from("sessions").update({
        weight, relation, turns_since_summary: since, notes,
        last_at: new Date().toISOString(),
      }).eq("id", sessionId);

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
        safety: { risk: safety.risk, keywords: safety.keywords.length, model: safety.model.risk },
        user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
      });
    }

    return json({ error: "不明な action です" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "サーバ側で問題が起きました", detail: String(e).slice(0, 300) }, 500);
  }
}
