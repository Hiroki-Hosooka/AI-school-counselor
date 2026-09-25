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
import { classify, CRISIS_REPLY } from "@/classify.mjs";
import {
  loadKnowledge, knowledgeVersion, retrieve, buildSystem, generateReply, updatePersonMemory,
  applyTurnUpdate, applyIntakeUpdate, applyModeUpdate, applyClosingUpdate,
} from "@/generate.mjs";

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

    if (action === "admin_session_detail") {
      if (!checkAdminToken(payload)) return json({ error: "認証に失敗しました" }, 401);
      const sessionId = String(payload.session_id ?? "").trim();
      if (!sessionId) return json({ error: "session_id が必要です" }, 400);
      const { data: s } = await db.from("sessions")
        .select("id,client_id,started_at,last_at,closed_at,relation,weight,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state")
        .eq("id", sessionId).maybeSingle();
      if (!s) return json({ error: "セッションが見つかりません" }, 404);
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,weight,relation,question_level,role_kind,summarized,hypothesis,why,used,flags,crisis,rating,rating_comment,created_at,distress_level,mode,ambivalence_detected,closing")
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
          phase: s.phase, chief_complaint_category: s.chief_complaint_category,
          onset_context: s.onset_context, distress_level: s.distress_level,
          physical_mental_symptoms: s.physical_mental_symptoms, user_goal: s.user_goal,
          ambivalence_detected: s.ambivalence_detected, recommended_mode: s.recommended_mode,
          closing_state: s.closing_state,
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
        await db.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", s.id);
        await updatePersonMemory(db, clientId, (s.notes ?? {}) as Record<string, unknown>);
        return json({ session: null, messages: [] }); // クライアント側が start を呼び直す
      }
      const { data: msgs } = await db.from("messages")
        .select("seq,role,body,used,flags,crisis,rating,closing")
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

      // phase以下はフェーズ1(インテーク)用(構造化面接AI統合 手順5)。
      // phase2に進んだセッションでは、applyIntakeUpdate()がこれ以上変更しない。
      const { data: sess } = await db.from("sessions")
        .select("id,weight,relation,turns_since_summary,notes,phase,chief_complaint_category,onset_context,distress_level,physical_mental_symptoms,user_goal,ambivalence_detected,recommended_mode,closing_state")
        .eq("id", sessionId).single();
      if (!sess) return json({ error: "セッションが見つかりません" }, 404);

      // 発言を保存
      const { data: userMsg } = await db.from("messages")
        .insert({ session_id: sessionId, role: "user", body: text }).select("seq").single();

      // ---- 入力フィルタ ----
      // 構造化面接AI統合 手順4より、危機分岐は risk に加えて subject(self/other)でも振り分ける。
      // 「本人の危機(self)」だけが生成スキップ+固定応答(CLAUDE.md 5.2)の対象。
      // 「友人等、第三者の安全への懸念(other)」と、曖昧な危機サイン(watch=Tier B)は、
      // どちらも生成は続けつつ、この1ターンだけ safetyContext で AI の応答の仕方を絞り込む
      // (src/generate.mjs の buildSystem 参照)。
      const safety = await classify(text);
      const isSelfCrisis = safety.risk === "crisis" && safety.subject === "self";
      if (safety.risk !== "none") {
        const notified = safety.risk === "crisis" ? await notifyCrisis(sessionId, safety.subject) : false;
        await db.from("safety_events").insert({
          session_id: sessionId, risk: safety.risk, subject: safety.subject, keywords: safety.keywords,
          model_risk: safety.model.risk, model_reason: safety.model.reason, notified,
        });
      }

      // 本人の危機(Tier A・self)なら生成をスキップして固定応答。この分岐だけは変更しない。
      if (isSelfCrisis) {
        const { data: aiMsg } = await db.from("messages").insert({
          session_id: sessionId, role: "ai", body: CRISIS_REPLY, crisis: true,
        }).select("seq").single();
        await db.from("sessions").update({ last_at: new Date().toISOString() }).eq("id", sessionId);
        return json({
          reply: CRISIS_REPLY, crisis: true,
          safety: { risk: safety.risk, subject: safety.subject, keywords: safety.keywords.length, model: safety.model.risk },
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
      const safetyContext = safety.risk === "watch" ? "tierB"
        : (safety.risk === "crisis" && safety.subject === "other") ? "thirdParty"
        : null;
      const rows = await loadKnowledge(db);
      // recommended_modeは手順6でretrieve()に渡し、フェーズ2ではモード一致のナレッジも
      // 引き出しやすくする(intake中は空配列なので、これまで通り影響しない)。
      const chunks = retrieve(
        rows, text, sess.weight, sess.relation, undefined, safetyContext, sess.recommended_mode,
      );

      const { data: hist } = await db.from("messages")
        .select("role,body,crisis,flags").eq("session_id", sessionId).order("seq");
      const messages = (hist ?? [])
        .filter((h) => !h.crisis)
        .map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.body }] }));
      // このセッションで既に何回、生成失敗の固定応答を返しているか(2026年9月・2-2)。
      // 同じ文言を繰り返さないよう generateReply() に渡す(嶋先生「同じメッセージが
      // 2回来ると傷つく」の指摘への対処)。
      const priorFailureCount = (hist ?? []).filter((h: { flags?: string[] | null }) =>
        h.flags?.some((f) => f.startsWith("生成失敗→固定応答で継続"))).length;

      const { data: memory } = await db.from("person_memory")
        .select("summary").eq("client_id", clientId).maybeSingle();
      // sessをそのままintake引数として渡す(phase/chief_complaint_category等の列名が
      // buildSystem/applyIntakeUpdateが期待する形と一致するように選択している)。
      const system = buildSystem(
        rows, chunks, sess.weight, sess.notes, sess.turns_since_summary, memory?.summary,
        safetyContext, sess,
      );

      const { out, flags } = await generateReply(system, messages, undefined, undefined, undefined, priorFailureCount);

      // ---- セッション状態の更新(記憶フィルタ含む。src/generate.mjs で共通化) ----
      const { weight, relation, turns_since_summary: since, notes } = applyTurnUpdate(sess, out);
      // フェーズ1(インテーク)のスロット更新。sess.phase!=="intake"なら空オブジェクト
      // (構造化面接AI統合 手順5)。sessionsへは差分(intakePatch)だけを書き込み、
      // messagesへはこのターン時点の現在値(mergedIntake)をスナップショットとして残す
      // (weight/relationと同じ、db/schema.sql 9.3の意図)。
      // applyModeUpdate/applyClosingUpdateはsess.phase==="phase2"の時だけ働く
      // (手順6・7)。それぞれ別のキー(recommended_mode/closing_state)しか
      // 返さないので、そのままマージしてよい。
      const intakePatch = {
        ...applyIntakeUpdate(sess, out), ...applyModeUpdate(sess, out), ...applyClosingUpdate(sess, out),
      };
      const mergedIntake = { ...sess, ...intakePatch };
      // このターンでクロージングの要約に入った(closing_stateがclosedになった)かどうか。
      // 画面側で「話せる窓口」の案内カードを出すために使う(手順7。CLAUDE.md 5.15)。
      const justClosed = intakePatch.closing_state === "closed";

      const { data: aiMsg } = await db.from("messages").insert({
        session_id: sessionId, role: "ai", body: out.reply,
        weight, relation, question_level: out.question_level, role_kind: out.role,
        summarized: out.did_summarize === true,
        hypothesis: out.hypothesis ?? null, why: out.why ?? null,
        used: out.used ?? chunks.map((c: { id: string }) => c.id), flags,
        distress_level: mergedIntake.distress_level ?? null,
        mode: mergedIntake.recommended_mode ?? [],
        ambivalence_detected: mergedIntake.ambivalence_detected ?? null,
        closing: justClosed,
      }).select("seq").single();

      await db.from("sessions").update({
        weight, relation, turns_since_summary: since, notes,
        last_at: new Date().toISOString(),
        ...intakePatch,
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
        closing: justClosed,
        user_seq: userMsg?.seq, ai_seq: aiMsg?.seq,
      });
    }

    return json({ error: "不明な action です" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "サーバ側で問題が起きました", detail: String(e).slice(0, 300) }, 500);
  }
}
