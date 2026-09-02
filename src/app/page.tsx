"use client";

/* ===========================================================================
   このファイルは表示だけを担当します。
   ナレッジ・プロンプト・安全層・APIキーはすべて src/app/api/chat/route.ts 側にあります。
   =========================================================================== */

import { Fragment, useEffect, useRef, useState } from "react";

type Weight = "rapport" | "main" | "goal" | "plan";
type Relation = "visitor" | "complainant" | "customer";

type UsedKnowledge = { id: string; src: string; cat: string; body: string };

type Msg = {
  role: "user" | "ai";
  body: string;
  seq?: number;
  crisis?: boolean;
  summary?: boolean;
  error?: boolean;
  rating?: number | null;
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
const CHIPS = ["新しいクラスで居場所がない気がする", "全部あの子のせいだと思う", "別に相談したいことがあるわけじゃない"];

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
    if (!res.ok) throw new Error(data.error || `通信に失敗しました (${res.status})`);
    return data;
  }

  async function boot() {
    try {
      const r = await api("resume");
      if (r.session && r.messages && r.messages.length) {
        sessionIdRef.current = r.session.id;
        setWeight(r.session.weight);
        setRelation(r.session.relation);
        setTrail([r.session.weight]);
        setNotes(r.session.notes || {});
        setMessages(
          r.messages.map((m: { role: string; body: string; seq: number; crisis?: boolean; rating?: number }) => ({
            role: m.role === "user" ? "user" : "ai",
            body: m.body,
            seq: m.seq,
            crisis: m.crisis,
            rating: m.rating,
          })),
        );
      } else {
        const s = await api("start");
        sessionIdRef.current = s.session.id;
      }
      setSub("接続済み");
      setBanner("");
    } catch (e) {
      setSub("接続できません");
      setBanner(e instanceof Error ? e.message : String(e));
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
    if (mainRef.current) mainRef.current.scrollTop = mainRef.current.scrollHeight;
  }, [messages, thinking]);

  async function turn(text: string) {
    setMessages((m) => [...m, { role: "user", body: text }]);
    setThinking(true);
    try {
      const r = await api("chat", { text });
      setThinking(false);
      if (r.crisis) {
        setMessages((m) => [...m, { role: "ai", body: r.reply, crisis: true, seq: r.ai_seq }]);
        setSafety(r.safety);
        setFlags(["危機応答に切り替え／生成をスキップ"]);
        return;
      }
      setWeight(r.weight);
      setRelation(r.relation);
      setTrail((t) => {
        const next = [...t, r.weight as Weight];
        return next.length > 28 ? next.slice(next.length - 28) : next;
      });
      setMessages((m) => [...m, { role: "ai", body: r.reply, seq: r.ai_seq, summary: r.summarized }]);
      setNotes(r.notes || {});
      setChoice({
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
      const message = e instanceof Error ? e.message : String(e);
      setMessages((m) => [...m, { role: "ai", body: "うまく応答できませんでした。\n" + message, error: true }]);
    }
  }

  async function submit(overrideText?: string) {
    const v = (overrideText ?? inputValue).trim();
    if (!v || busy) return;
    if (!sessionIdRef.current) {
      setBanner("まだ接続できていません。設定を確認してください。");
      return;
    }
    setInputValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setBusy(true);
    await turn(v);
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

  async function newSession() {
    try {
      resetView();
      const s = await api("start");
      sessionIdRef.current = s.session.id;
      setPanelOpen(false);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  const notesEntries = Object.entries(notes).filter(([, v]) => v);

  return (
    <>
      <header>
        <div className="head-row">
          <div className="mark">相談室</div>
          <div className="sub">{sub}</div>
          <div className="spacer" />
          <button className="icon-btn" onClick={() => setPanelOpen(true)}>設定と記録</button>
        </div>
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
        {banner && <div className="banner show">{banner}</div>}
      </header>

      <main ref={mainRef} id="main">
        <div className="thread">
          {messages.length === 0 && (
            <div className="empty">
              よくぞ来てくれました。<br />話したいことから、どこからでもどうぞ。
              <em>書き出しに迷ったら</em>
              <div>
                {CHIPS.map((c) => (
                  <button key={c} className="chip" onClick={() => submit(c)}>{c}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} msg={m} onRate={rate} />
          ))}
          {thinking && (
            <div className="msg ai"><div className="thinking"><i /><i /><i /></div></div>
          )}
        </div>
      </main>

      <footer>
        <div className="composer">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder="ここに書いてみてください"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="send" disabled={busy} onClick={() => submit()}>送る</button>
        </div>
        <div className="foot-note">
          研究用の試作です。専門家によるカウンセリングや、緊急時の対応の代わりにはなりません。
          いますぐ助けが必要なときは 119 番、または 24時間子供SOSダイヤル 0120-0-78310 へ。
        </div>
      </footer>

      <div className={"scrim" + (panelOpen ? " open" : "")} onClick={() => setPanelOpen(false)} />
      <aside className={"panel" + (panelOpen ? " open" : "")}>
        <button className="close" onClick={() => setPanelOpen(false)}>×</button>
        <h3>設定と記録</h3>
        <p>ナレッジと会話の記録はサーバ側にあります。この画面にAPIキーはありません。</p>

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
        <button className="btn ghost" onClick={newSession}>新しく話しはじめる</button>
      </aside>
    </>
  );
}

function MessageBubble({ msg, onRate }: { msg: Msg; onRate: (seq: number, n: number) => void }) {
  const cls = "msg " + (msg.role === "user" ? "user" : "ai") + (msg.crisis ? " crisis" : "") + (msg.summary ? " summary" : "");
  return (
    <div className={cls}>
      <div className="bubble">{msg.body}</div>
      {msg.crisis && (
        <div className="crisis-card">
          <h4>話せる窓口</h4>
          <dl>
            {HOTLINES.map(([name, num]) => (
              <Fragment key={name}>
                <dt>{name}</dt><dd>{num}</dd>
              </Fragment>
            ))}
          </dl>
          <p>どれも無料で、名前を言わなくても話せます。学校の先生や保健室の先生に、この画面を見せるだけでも伝わります。</p>
        </div>
      )}
      {msg.role === "ai" && !msg.error && msg.seq != null && (
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
