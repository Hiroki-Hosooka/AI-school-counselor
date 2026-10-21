"use client";

/* ===========================================================================
   このファイルは表示だけを担当します。
   ナレッジ・プロンプト・安全層・APIキーはすべて src/app/api/chat/route.ts 側にあります。
   =========================================================================== */

import { Fragment, useEffect, useRef, useState } from "react";
// 上限・エラーのときに生徒に見せる文面(サーバと共通。src/notices.mjs)。技術的な中身は見せず、コンソールに残す
import {
  SEND_FAILED_NOTICE, NOT_CONNECTED_NOTICE, DETAILS_ITEMS_PROVISIONAL, FOOTER_DISCLOSURE, TOP_FREE_TEXT_HINT,
} from "@/notices.mjs";
// トップ画面のボタン(主訴のカテゴリ。仮。2026年10月14日。嶋先生インタビュー4。docs/design/top-screen/Main.dc.html)。
// 押すと choice_id(K1〜K6)を送り、サーバ(src/intake.mjs)がコードでインテークを進める
import { CATEGORY_CHOICES_PROVISIONAL } from "@/intake.mjs";

type Weight = "rapport" | "main" | "goal" | "plan";
type Relation = "visitor" | "complainant" | "customer";

type UsedKnowledge = { id: string; src: string; cat: string; body: string };

// card: 応答の下に出すもの(危機検知の作り直し 第2段階・仮。サーバの設定 CRISIS_RESPONSE=staged のときだけ来る)
//   care     = 気づかいの一言(careLine。文面はサーバから届く)+ 折りたたみの窓口
//   hotlines = 折りたたみの窓口だけ
//   crisis   = 危機カード(今までの crisis-card と同じ)
// crisisStep: 危機の応答を分けて出した文面の何通目か(src/crisis-response.mjs の CRISIS_STEP_LABELS と同じ番号)
// choices: AIの返事の下に出すチップ(危機の流れの見直し・仮。2026年10月9日)。押すとラベルを相談者の発言として表示し、
//   choice_id をサーバに送る。選ばずに自由に書いてもよい(入力欄はいつでも使える)。最後のメッセージのときだけ出す
type SafetyCard = "care" | "hotlines" | "crisis";
type Choice = { id: string; label: string };
const CRISIS_STEP_LABELS: Record<number, string> = {
  1: "1通目(受け止め・ここで話せた理由の問い)", 2: "2通目(心配)", 3: "3通目(相談先や大人)", 4: "答えへの一言",
  5: "2回目以降の短い1通", 6: "再受け止め", 7: "まとめの1通(以前)", 8: "短いまとめの1通(以前)", 9: "終わりを受け入れる1通(以前)",
  10: "スケーリングの問い", 11: "スケーリングの受け止め", 12: "組Cの前置き", 13: "組Cへの受け止め", 14: "危機のあとの終わり方",
};
// 分けた吹き出しを1つずつ出す間(1〜2秒。嶋先生 10/7「部分ずつ受け止められる」)
const BUBBLE_INTERVAL_MS = 1500;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = {
  role: "user" | "ai";
  body: string;
  seq?: number;
  crisis?: boolean;
  summary?: boolean;
  closing?: boolean;
  error?: boolean;
  rating?: number | null;
  card?: SafetyCard | null;
  careLine?: string | null;
  crisisStep?: number | null;
  choices?: Choice[] | null;
  choiceNote?: string | null;
};

type ChoiceInfo = {
  relation: Relation;
  weight: Weight;
  question_level?: string;
  role?: string;
  summarized?: boolean;
  turns_since_summary?: number;
  hypothesis?: string;
  why?: string;
};

type VersionInfo = {
  app_version: string; commit: string | null;
  history: { version: string; date: string; summary: string; areas?: string[] }[];
};

type SafetyInfo = { risk: string; keywords: number; model: string } | null;

const WEIGHT_FILL: Record<Weight, string> = { rapport: "#6E8B74", main: "#2F4858", goal: "#7A6480", plan: "#A8794A" };
const WEIGHT_JA: Record<Weight, string> = { rapport: "関係をつくる", main: "主訴を見極める", goal: "目標を立てる", plan: "作戦会議" };
const REL_JA: Record<Relation, string> = { visitor: "ビジター", complainant: "コンプレイナント", customer: "カスタマー" };
const QL: Record<string, string> = { none: "問わず受け止めのみ", data: "第1層・事実を聞く", diagnostic: "第2層・仮説を確かめる", confrontational: "第3層・見立てで介入" };
const RL: Record<string, string> = { listen: "相談を受ける", assess: "査定する", inform: "情報を提供する" };
const KNOW_CLS: Record<string, string> = { "嶋": "s", "石": "i", "理": "t", "設": "d", "嶋石": "s" };
const HOTLINES: [string, string][] = [
  ["24時間子供SOSダイヤル", "0120-0-78310"],
  ["チャイルドライン", "0120-99-7777"],
  ["よりそいホットライン", "0120-279-338"],
  ["こころの健康相談統一ダイヤル", "0570-064-556"],
  ["いますぐ危ないとき", "119"],
];
// クロージング(手順7)のカードでは、緊急連絡("いますぐ危ないとき")を除いた
// 相談窓口だけを見せる。今日の会話をふつうに終える場面であり、緊急時のcrisis-cardとは
// トーンを分けたいため(CLAUDE.md 5.15)。
const CLOSING_HOTLINES = HOTLINES.filter(([name]) => name !== "いますぐ危ないとき");
// 画面の下に常に出す窓口(119・24時間子供SOSダイヤル)。押すと電話がかかる(消したり減らしたりしない。2026年10月14日に人が確認)
const FOOTER_HOTLINES: { label: string; tel: string }[] = [
  { label: "119", tel: "119" },
  { label: "24時間子供SOSダイヤル 0120-0-78310", tel: "0120078310" },
];

const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* 端末側で保存できなくても致命的ではない */ }
  },
};

function makeClientId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

export default function Page() {
  const clientIdRef = useRef("");
  const sessionIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [clientId, setClientId] = useState("");
  const [clientInputValue, setClientInputValue] = useState("");
  const [weight, setWeight] = useState<Weight>("rapport");
  const [relation, setRelation] = useState<Relation>("visitor");
  const [trail, setTrail] = useState<Weight[]>([]);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<ChoiceInfo | null>(null);
  const [used, setUsed] = useState<UsedKnowledge[]>([]);
  const [safety, setSafety] = useState<SafetyInfo>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [sub, setSub] = useState("接続中…");
  const [banner, setBanner] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  // 開発用の表示(重心の図・設定と記録・返答の評価)。サーバが start / resume で dev: true を返したときだけ出す。
  // サーバは環境変数 DEV_PANEL=on のときだけ true を返す(本番には設定しない。無いときは必ず出さない)
  const [dev, setDev] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // アプリの版(src/version.mjs)。開発用の表示のときだけサーバが返す
  const [version, setVersion] = useState<VersionInfo | null>(null);

  async function api(action: string, body?: Record<string, unknown>) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        client_id: clientIdRef.current,
        session_id: sessionIdRef.current,
        ...(body || {}),
      }),
    });
    const data = await res.json().catch(() => ({ error: "応答を読み取れませんでした" }));
    if (!res.ok) {
      // notice: サーバが用意した生徒向けの文面(字数・回数の上限のとき)。error は開発用の中身
      const err: Error & { notice?: string } = new Error(data.error || `通信に失敗しました (${res.status})`);
      if (typeof data.notice === "string") err.notice = data.notice;
      throw err;
    }
    return data;
  }

  async function boot() {
    try {
      const r = await api("resume");
      setDev(r.dev === true);
      setVersion(r.version ?? null);
      if (r.session && r.messages && r.messages.length) {
        sessionIdRef.current = r.session.id;
        if (r.session.weight) setWeight(r.session.weight);
        if (r.session.relation) setRelation(r.session.relation);
        if (r.session.weight) setTrail([r.session.weight]);
        setNotes(r.session.notes || {});
        setMessages(
          r.messages.map((m: {
            role: string; body: string; seq: number; crisis?: boolean; closing?: boolean; rating?: number;
            safety_card?: SafetyCard | null; care_line?: string | null; crisis_step?: number | null;
            choices?: Choice[] | null; choice_note?: string | null;
          }) => ({
            role: m.role === "user" ? "user" : "ai",
            body: m.body,
            seq: m.seq,
            crisis: m.crisis,
            closing: m.closing,
            rating: m.rating,
            card: m.safety_card ?? null,
            careLine: m.care_line ?? null,
            crisisStep: m.crisis_step ?? null,
            choices: m.choices ?? null,
            choiceNote: m.choice_note ?? null,
          })),
        );
      } else {
        const s = await api("start");
        sessionIdRef.current = s.session.id;
        setDev(s.dev === true);
        setVersion(s.version ?? null);
      }
      setSub("接続済み");
      setBanner("");
    } catch (e) {
      console.error("接続できませんでした:", e);
      setSub("接続できません");
      setBanner(NOT_CONNECTED_NOTICE);
    }
  }

  useEffect(() => {
    let cid = store.get("sc_client") || "";
    if (!cid) {
      cid = makeClientId();
      store.set("sc_client", cid);
    }
    clientIdRef.current = cid;
    setClientId(cid);
    boot();
    // 初回マウント時のみ実行する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // トップ画面では見出しから見せる(下に送らない)
    if (messages.length === 0 && !thinking) return;
    if (mainRef.current) mainRef.current.scrollTop = mainRef.current.scrollHeight;
  }, [messages, thinking]);

  async function turn(text: string, choiceId?: string) {
    setMessages((m) => [...m, { role: "user", body: text }]);
    setThinking(true);
    try {
      const r = await api("chat", choiceId ? { text, choice_id: choiceId } : { text });
      setThinking(false);
      if (r.crisis) {
        // 吹き出しが複数(2通目の「心配」+3通目など)のときは、間をおいて1つずつ出す。チップは最後の吹き出しの下
        const replies: { body: string; card: SafetyCard | null; crisis_step: number | null; seq?: number }[] =
          Array.isArray(r.replies) && r.replies.length
            ? r.replies
            : [{ body: r.reply, card: r.card ?? null, crisis_step: r.crisis_step ?? null, seq: r.ai_seq }];
        for (const [i, b] of replies.entries()) {
          if (i > 0) {
            setThinking(true);
            await wait(BUBBLE_INTERVAL_MS);
            setThinking(false);
          }
          const last = i === replies.length - 1;
          setMessages((m) => [...m, {
            role: "ai", body: b.body, crisis: true, seq: b.seq,
            card: b.card ?? null, careLine: null, crisisStep: b.crisis_step ?? null,
            choices: last ? r.choices ?? null : null,
            choiceNote: last ? r.choice_note ?? null : null,
          }]);
        }
        setSafety(r.safety);
        setFlags([r.crisis_step
          ? `危機の応答 ${CRISIS_STEP_LABELS[r.crisis_step] ?? `${r.crisis_step}通目`}(仮の文面)／生成をスキップ`
          : "危機応答に切り替え／生成をスキップ"]);
        return;
      }
      if (r.weight) {
        setWeight(r.weight);
        setTrail((t) => {
          const next = [...t, r.weight as Weight];
          return next.length > 28 ? next.slice(next.length - 28) : next;
        });
      }
      if (r.relation) setRelation(r.relation);
      // 返事が空のまま表示しない(サーバでも防いでいるが、念のため。2026年10月14日。相談ログ 86130eef の10ターン目)
      const replyText = typeof r.reply === "string" && r.reply.trim() ? r.reply : SEND_FAILED_NOTICE;
      setMessages((m) => [...m, {
        role: "ai", body: replyText, seq: r.ai_seq, summary: r.summarized, closing: r.closing,
        card: r.card ?? null, careLine: r.care_line ?? null,
        // 整理・作業の提案のチップ(組G。会話の流れ。選ばずに書いてもよい)
        choices: r.choices ?? null, choiceNote: r.choice_note ?? null,
      }]);
      // 返事のあとに続く吹き出し。危機のあとの区切りの締め(crisis_step 14。区切りのカードはそちらに出す)と、
      // インテークの次の質問(つらさ・どうなれたらいいか。チップつき。src/intake.mjs)
      for (const a of (Array.isArray(r.after) ? r.after : []) as {
        body: string; seq?: number; crisis_step?: number; choices?: Choice[] | null; choice_note?: string | null;
      }[]) {
        setThinking(true);
        await wait(BUBBLE_INTERVAL_MS);
        setThinking(false);
        setMessages((m) => [...m, {
          role: "ai", body: a.body, seq: a.seq, crisisStep: a.crisis_step ?? null, closing: a.crisis_step === 14,
          choices: a.choices ?? null, choiceNote: a.choice_note ?? null,
        }]);
      }
      setNotes(r.notes || {});
      if (r.relation) setChoice({
        relation: r.relation,
        weight: r.weight,
        question_level: r.question_level,
        role: r.role,
        summarized: r.summarized,
        turns_since_summary: r.turns_since_summary,
        hypothesis: r.hypothesis,
        why: r.why,
      });
      setUsed(r.used || []);
      setSafety(r.safety);
      setFlags(r.flags || []);
    } catch (e) {
      setThinking(false);
      // 生徒には技術的な中身(ブラウザの英語のメッセージなど)を見せない(2026年10月7日)
      console.error("送れませんでした:", e);
      const notice = (e as { notice?: unknown })?.notice;
      setMessages((m) => [...m, { role: "ai", body: typeof notice === "string" ? notice : SEND_FAILED_NOTICE, error: true }]);
    }
  }

  async function submit(overrideText?: string, choiceId?: string) {
    const v = (overrideText ?? inputValue).trim();
    if (!v || busy) return;
    if (!sessionIdRef.current) {
      setBanner(NOT_CONNECTED_NOTICE);
      return;
    }
    setInputValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setBusy(true);
    await turn(v, choiceId);
    setBusy(false);
    textareaRef.current?.focus();
  }

  async function rate(seq: number, n: number) {
    setMessages((m) => m.map((msg) => (msg.seq === seq ? { ...msg, rating: n } : msg)));
    try {
      await api("rate", { seq, rating: n });
    } catch {
      setBanner("評価を保存できませんでした");
    }
  }

  function resetView() {
    setMessages([]);
    setWeight("rapport");
    setRelation("visitor");
    setTrail([]);
    setNotes({});
    sessionIdRef.current = null;
  }

  async function applyClient() {
    const v = clientInputValue.trim();
    if (!v) return;
    clientIdRef.current = v;
    store.set("sc_client", v);
    setClientId(v);
    resetView();
    setPanelOpen(false);
    await boot();
  }

  // 新しい会話を始める(2026年10月21日。生徒の画面のヘッダのボタンと、開発用の表示から)。
  // 今の会話はサーバ側で閉じて、人単位の記憶(要約)に畳み込まれる(route.ts の start)。押し間違いで会話が消えたように
  // 見えないよう、ヘッダのボタンからは一度たずねる
  async function newSession(ask = false) {
    if (busy) return;
    if (ask && !window.confirm("いまの会話を終えて、新しく話しはじめますか?")) return;
    try {
      resetView();
      setInputValue("");
      setBanner("");
      const s = await api("start");
      sessionIdRef.current = s.session.id;
      setPanelOpen(false);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  const notesEntries = Object.entries(notes).filter(([, v]) => v);
  // トップ画面(まだ何も話していないとき)。見出し・主訴のボタン・入力欄を画面の中ほどに出す。
  // 1回でも送ったら、ふつうの会話の画面(入力欄は下)に替わる
  const isTop = messages.length === 0 && !thinking;

  const composer = (
    <div className={"composer" + (isTop ? " top" : "")}>
      <textarea
        ref={textareaRef}
        rows={1}
        aria-label="相談したいことを書く欄"
        placeholder="ここに書いてみてください"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px";
        }}
        onKeyDown={(e) => {
          // Enterで送信、Shift+Enterで改行。isComposingは日本語入力の変換確定Enterを
          // 誤送信しないためのガード(これが無いと、変換確定のたびに送信されてしまう)。
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="send" disabled={busy} onClick={() => submit()}>送る</button>
    </div>
  );

  return (
    <>
      <header className={dev ? "" : "plain"}>
        <div className="head-row">
          <div className="mark">相談室</div>
          {dev && <div className="sub">{sub}</div>}
          {dev && version && (
            <div className="sub" title="アプリの版(src/version.mjs)とデプロイしたコミット">
              版 {version.app_version}{version.commit ? `・${version.commit}` : ""}
            </div>
          )}
          <div className="spacer" />
          {!isTop && (
            <button className="icon-btn" disabled={busy} onClick={() => newSession(true)}>新しく話す</button>
          )}
          {dev && <button className="icon-btn" onClick={() => setPanelOpen(true)}>開発用の表示</button>}
        </div>
        {dev && (
          <div className="state">
            <svg className="triad" width="158" height="52" viewBox="0 0 158 52" aria-hidden="true">
              <circle cx="34" cy="24" r="17" fill={weight === "rapport" ? WEIGHT_FILL.rapport + "22" : "none"} stroke={weight === "rapport" ? WEIGHT_FILL.rapport : "#D3CDBF"} strokeWidth={weight === "rapport" ? 1.6 : 1} />
              <circle cx="58" cy="24" r="17" fill={weight === "main" ? WEIGHT_FILL.main + "22" : "none"} stroke={weight === "main" ? WEIGHT_FILL.main : "#D3CDBF"} strokeWidth={weight === "main" ? 1.6 : 1} />
              <circle cx="82" cy="24" r="17" fill={weight === "goal" ? WEIGHT_FILL.goal + "22" : "none"} stroke={weight === "goal" ? WEIGHT_FILL.goal : "#D3CDBF"} strokeWidth={weight === "goal" ? 1.6 : 1} />
              <circle cx="106" cy="24" r="17" fill={weight === "plan" ? WEIGHT_FILL.plan + "22" : "none"} stroke={weight === "plan" ? WEIGHT_FILL.plan : "#D3CDBF"} strokeWidth={weight === "plan" ? 1.6 : 1} />
              <text x="34" y="50" textAnchor="middle" className={weight === "rapport" ? "on" : ""}>関係</text>
              <text x="58" y="8" textAnchor="middle" className={weight === "main" ? "on" : ""}>主訴</text>
              <text x="82" y="50" textAnchor="middle" className={weight === "goal" ? "on" : ""}>目標</text>
              <text x="112" y="8" textAnchor="middle" className={weight === "plan" ? "on" : ""}>作戦会議</text>
            </svg>
            <div className="state-text">
              いまの重心 <b>{WEIGHT_JA[weight] ?? "—"}</b> ／ 関わりの型 <b>{REL_JA[relation] ?? "—"}</b>
              <div className="trail">
                {trail.map((w, i) => <i key={i} className={w} />)}
              </div>
            </div>
          </div>
        )}
        {banner && <div className="banner show">{banner}</div>}
      </header>

      <main ref={mainRef} id="main" className={isTop ? "is-top" : ""}>
        {isTop ? (
          <div className="top-screen">
            <h1>
              <span>よくぞ来てくれました。</span>
              <span>今日は、どんなことで来てくれた?</span>
            </h1>
            <div className="top-choices" role="group" aria-label="相談したいことに近いもの">
              {CATEGORY_CHOICES_PROVISIONAL.map((c) => (
                <button key={c.id} type="button" className="top-choice" disabled={busy}
                  onClick={() => submit(c.label, c.id)}>{c.label}</button>
              ))}
            </div>
            <p className="top-hint">{TOP_FREE_TEXT_HINT}</p>
            {composer}
          </div>
        ) : (
          <div className="thread">
            {messages.map((m, i) => (
              <MessageBubble key={i} msg={m} dev={dev} onRate={rate}
                onChoose={i === messages.length - 1 && !busy ? (c) => submit(c.label, c.id) : undefined} />
            ))}
            {thinking && (
              <div className="msg ai"><div className="thinking"><i /><i /><i /></div></div>
            )}
          </div>
        )}
      </main>

      <footer>
        {!isTop && composer}
        {/* 画面の下に常に出す説明と窓口(119・24時間子供SOSダイヤル)。消したり減らしたりしない(押せば電話がかかる) */}
        <div className="foot-note">
          <div>
            {FOOTER_DISCLOSURE}
            <button type="button" className="foot-link" onClick={() => setDetailsOpen(true)}>くわしく</button>
          </div>
          <div className="foot-hotlines">
            <b>いますぐ助けが必要なとき</b>
            {FOOTER_HOTLINES.map((h) => <a key={h.tel} href={`tel:${h.tel}`}>{h.label}</a>)}
          </div>
        </div>
      </footer>

      {detailsOpen && (
        <>
          <div className="scrim open" onClick={() => setDetailsOpen(false)} />
          <div className="details" role="dialog" aria-modal="true" aria-labelledby="details-title">
            <h2 id="details-title">この相談室について</h2>
            <div className="details-items">
              {DETAILS_ITEMS_PROVISIONAL.map((d: { title: string; body: string }) => (
                <div key={d.title}>
                  <div className="details-title">{d.title}</div>
                  <div className="details-body">{d.body}</div>
                </div>
              ))}
              <div>
                <div className="details-title alert">いますぐ助けが必要なとき</div>
                <div className="foot-hotlines">
                  {FOOTER_HOTLINES.map((h) => <a key={h.tel} href={`tel:${h.tel}`}>{h.label}</a>)}
                </div>
              </div>
            </div>
            <button type="button" className="details-ok" autoFocus onClick={() => setDetailsOpen(false)}>わかった</button>
            {/* スタッフ向け。目立たない位置に小さく置く(生徒の目を引かないため。2026年10月14日に人が確認して、生徒の画面に残す)。
                合言葉(ADMIN_TOKEN)はここには埋め込まない。開いた先で別途入力が必要(CLAUDE.md 5.9) */}
            <a className="staff-link" href="/admin.html" target="_blank" rel="noopener noreferrer">スタッフ用ページ</a>
          </div>
        </>
      )}

      {dev && (
        <>
          <div className={"scrim" + (panelOpen ? " open" : "")} onClick={() => setPanelOpen(false)} />
          <aside className={"panel" + (panelOpen ? " open" : "")}>
            <button className="close" onClick={() => setPanelOpen(false)}>×</button>
            <h3>開発用の表示</h3>
            <p>プレビュー・開発の環境だけに出ます(DEV_PANEL=on)。本番の生徒の画面には出ません。</p>

            <h5>版(バージョン)</h5>
            {version ? (
              <>
                <div className="code">{version.app_version}{version.commit ? `(コミット ${version.commit})` : ""}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.8 }}>
                  {version.history.map((h) => (
                    <div key={h.version}><b>{h.version}</b> {h.summary}</div>
                  ))}
                </div>
              </>
            ) : <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>—</span>}

            <h5>引き継ぎコード</h5>
            <p style={{ fontSize: 11.5 }}>別の端末でも同じ続きから話したいときは、このコードを相手の端末に入力してください。名前は使いません。</p>
            <div className="code">{clientId || "—"}</div>
            <label className="f">別の端末のコードを使う</label>
            <input type="text" value={clientInputValue} onChange={(e) => setClientInputValue(e.target.value)} placeholder="コードを貼り付け" />
            <button className="btn ghost" onClick={applyClient}>このコードに切り替える</button>

            <h5>いまの見立て</h5>
            <div className="kv">
              {notesEntries.length
                ? notesEntries.map(([k, v]) => <div key={k}><b>{k}</b> ／ {v}</div>)
                : <span style={{ color: "var(--ink-faint)" }}>まだ見立てがありません。</span>}
            </div>

            <h5>直前のターンの選択</h5>
            <div>
              {choice ? (
                <>
                  <span className="tag">型 {REL_JA[choice.relation] ?? "—"}</span>
                  <span className="tag">重心 {WEIGHT_JA[choice.weight] ?? "—"}</span>
                  <span className="tag">{QL[choice.question_level ?? ""] ?? choice.question_level ?? "—"}</span>
                  <span className="tag">{RL[choice.role ?? ""] ?? choice.role ?? "—"}</span>
                  {choice.summarized && <span className="tag amber">区切り</span>}
                  <span className="tag">前回の区切りから {choice.turns_since_summary}</span>
                  {choice.hypothesis && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 5 }}><b>仮説</b> {choice.hypothesis}</div>}
                  {choice.why && <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{choice.why}</div>}
                </>
              ) : <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>—</span>}
            </div>

            <h5>参照したナレッジ</h5>
            <div>
              {used.length
                ? used.map((k) => (
                  <div className="know" key={k.id}>
                    <code className={KNOW_CLS[k.src] ?? "d"}>{k.id} · {k.src}{k.cat === "verbatim" ? " · 逐語" : ""}</code><br />{k.body}
                  </div>
                ))
                : <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>該当なし</span>}
            </div>

            <h5>安全層のログ</h5>
            <div>
              {safety ? (
                <>
                  <span className={"tag " + (safety.risk === "none" ? "ok" : "warn")}>入力 {safety.risk}</span>
                  {safety.keywords ? <span className="tag warn">語句検知 {safety.keywords}</span> : null}
                  <span className="tag">判定器 {safety.model}</span>
                  {flags.length
                    ? <div className="flag">出力チェック: {flags.join(" / ")}</div>
                    : <div style={{ fontSize: 11.5, color: "var(--moss)" }}>出力チェック: 問題なし</div>}
                </>
              ) : <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>—</span>}
            </div>

            <h5>評価ルーブリック</h5>
            <p style={{ fontSize: 11.5 }}>返答の 1〜5 はサーバに保存され、ナレッジIDごとの平均点として集計されます。</p>
            <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.95 }}>
              ① 受け止めが問いより先に来ているか<br />
              ② 受け止めと同調が混ざっていないか<br />
              ③ 表層の言葉を主訴と決めつけていないか<br />
              ④ 問いの層と関係のできぐあいが釣り合っているか<br />
              ⑤ アドバイスに流れていないか／逆にまどろっこしくないか<br />
              ⑥ 人につなぐ姿勢が保たれているか
            </div>

            <h5>この端末の会話</h5>
            <button className="btn ghost" onClick={() => newSession()}>新しく話しはじめる</button>
          </aside>
        </>
      )}
    </>
  );
}

// 折りたたみの窓口(段階1のカードと、危機の応答の1通目に添える。第2段階・仮)。
// 会話を遮らないよう、最初は閉じておく。緊急連絡(119)は画面下の常設の表示にあるので、ここには入れない。
function HotlineDetails() {
  return (
    <details className="care-hotlines">
      <summary>話せる窓口</summary>
      <dl>
        {CLOSING_HOTLINES.map(([name, num]) => (
          <Fragment key={name}>
            <dt>{name}</dt><dd><a href={`tel:${num.replace(/-/g, "")}`}>{num}</a></dd>
          </Fragment>
        ))}
      </dl>
      <p>どれも無料で、名前を言わなくても話せます。</p>
    </details>
  );
}

function MessageBubble({ msg, dev, onRate, onChoose }: {
  msg: Msg; dev: boolean; onRate: (seq: number, n: number) => void; onChoose?: (c: Choice) => void;
}) {
  // 段階ごとの応答(第2段階)の文面は card で出し分ける。それ以前の危機の固定応答
  // (crisis はあるが crisisStep が無いもの)は、今まで通り危機カードを出す。
  const card: SafetyCard | null = msg.card ?? (msg.crisis && msg.crisisStep == null ? "crisis" : null);
  const cls = "msg " + (msg.role === "user" ? "user" : "ai") + (card === "crisis" ? " crisis" : "") + (msg.summary ? " summary" : "");
  return (
    <div className={cls}>
      {msg.body ? <div className="bubble">{msg.body}</div> : null}
      {card === "crisis" && (
        <div className="crisis-card">
          <h4>話せる窓口</h4>
          <dl>
            {HOTLINES.map(([name, num]) => (
              <Fragment key={name}>
                <dt>{name}</dt><dd><a href={`tel:${num.replace(/-/g, "")}`}>{num}</a></dd>
              </Fragment>
            ))}
          </dl>
          <p>どれも無料で、名前を言わなくても話せます。学校の先生や保健室の先生に、この画面を見せるだけでも伝わります。</p>
        </div>
      )}
      {(card === "care" || card === "hotlines") && (
        <div className="care-card">
          {card === "care" && msg.careLine && <p className="care-line">{msg.careLine}</p>}
          <HotlineDetails />
        </div>
      )}
      {msg.choices && msg.choices.length > 0 && onChoose && (
        <div className="choice-chips" role="group" aria-label="選ぶだけでも大丈夫です">
          {msg.choices.map((c) => (
            <button key={c.id} type="button" className="choice-chip" onClick={() => onChoose(c)}>{c.label}</button>
          ))}
          {msg.choiceNote && <p className="choice-note">{msg.choiceNote}</p>}
        </div>
      )}
      {msg.closing && (
        <div className="closing-card">
          <h4>また話したくなったら</h4>
          <dl>
            {CLOSING_HOTLINES.map(([name, num]) => (
              <Fragment key={name}>
                <dt>{name}</dt><dd><a href={`tel:${num.replace(/-/g, "")}`}>{num}</a></dd>
              </Fragment>
            ))}
          </dl>
          <p>しんどくなったら、ここに書いたところにも頼っていいからね。もちろん、また続きをここで話しに来てくれてもいいよ。</p>
        </div>
      )}
      {/* 返答の評価は開発用の表示のときだけ(サーバも DEV_PANEL のときだけ受け付ける) */}
      {dev && msg.role === "ai" && !msg.error && msg.seq != null && (
        <div className={"rate" + (msg.rating ? " set" : "")}>
          <span>この返答の評価</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={msg.rating && n <= msg.rating ? "on" : ""} onClick={() => onRate(msg.seq!, n)}>{n}</button>
          ))}
        </div>
      )}
    </div>
  );
}
