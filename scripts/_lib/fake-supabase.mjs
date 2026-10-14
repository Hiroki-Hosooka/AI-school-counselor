// ============================================================================
//  メモリ上の偽の Supabase(画面と同じ API の経路のテスト用。2026年10月14日。scripts/test-api-path.mjs)
//
//  route.ts と src/generate.mjs が使う呼び方だけをまねる(from / select / insert / update / upsert / eq / lt / is / not / in /
//  order / limit / single / maybeSingle / rpc)。本物の DB にはつながない(生徒の会話は使わない。台本は合成)。
//
//  本番の DB の状態をまねるための設定
//   constraints: "v14"(db/schema.sql 14節の制約)/ "v13"(13節の版のまま。状態の値・危機の文面の番号が狭い)
//   missingColumns: { messages: [...], sessions: [...] }  まだ無い列(SQL を実行していない節の列)。書くとエラー
//   failWrites: (table, op, row) => エラー文 | null     任意の書き込みを失敗させる
// ============================================================================

import { randomUUID } from "node:crypto";

const CRISIS_STATES = {
  v13: ["none", "step1", "step2", "step3", "done", "paused1", "paused2", "paused3", "again1", "again2", "again3", "wrap1", "wrap2", "wrap3"],
  v14: ["none", "step1", "step2", "step3", "done", "paused1", "paused2", "paused3", "again1", "again2", "again3",
    "wrap1", "wrap2", "wrap3", "choice_b", "choice_c", "scaling", "lowered"],
};
const CRISIS_STEP_MAX = { v13: 9, v14: 14 };

const SESSION_DEFAULTS = () => ({
  weight: "rapport", relation: "visitor", turns_since_summary: 0, notes: {}, knowledge_version: null,
  started_at: new Date().toISOString(), last_at: new Date().toISOString(), closed_at: null,
  phase: "intake", chief_complaint_category: null, onset_context: null, distress_level: null, physical_mental_symptoms: null,
  user_goal: null, ambivalence_detected: null, recommended_mode: [], closing_state: "none",
  watch_turns_left: 0, crisis_state: "none", crisis_trigger: null, care_shown: false, reentry_used: false, repeat_used: false,
  withdrawal_count: 0, crisis_resume: null, crisis_negation: null, pending_choice_set: null, scaling_count: 0,
  choice_sets_shown: [], crisis_category: null, crisis_choice_c: null, chief_complaint_source: null, intake_step: null,
});
const MESSAGE_DEFAULTS = () => ({
  flags: [], crisis: false, rating: null, created_at: new Date().toISOString(), crisis_step: null, safety_card: null,
  choices: null, choice_set: null, choice_id: null, choice_input: null, closing: false, summarized: false,
});

export function createFakeDb(opts = {}) {
  const constraints = opts.constraints ?? "v14";
  const missing = opts.missingColumns ?? {};
  const tables = { sessions: [], messages: [], safety_events: [], person_memory: [], knowledge: opts.knowledge ?? [] };
  let seq = { messages: 0, safety_events: 0 };
  const writes = [];   // 書き込みの記録(テストで確かめる)

  function checkRow(table, row) {
    for (const col of Object.keys(row)) {
      if ((missing[table] ?? []).includes(col)) return `column "${col}" of relation "${table}" does not exist`;
    }
    if (table === "sessions") {
      if (row.crisis_state != null && !CRISIS_STATES[constraints].includes(row.crisis_state)) {
        return `new row for relation "sessions" violates check constraint "sessions_crisis_state_check"`;
      }
      if (row.pending_choice_set != null && !["scaling", "B", "C"].includes(row.pending_choice_set)) {
        return `new row for relation "sessions" violates check constraint "sessions_pending_choice_set_check"`;
      }
    }
    if (table === "messages" && row.crisis_step != null && !(row.crisis_step >= 1 && row.crisis_step <= CRISIS_STEP_MAX[constraints])) {
      return `new row for relation "messages" violates check constraint "messages_crisis_step_check"`;
    }
    return null;
  }

  function matches(row, filters) {
    return filters.every((f) => f(row));
  }

  function project(table, row, cols) {
    if (!cols || cols === "*") return { ...row };
    const out = {};
    for (const c of cols.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (c.includes("!inner")) continue;
      out[c] = row[c] ?? null;
    }
    return out;
  }

  function selectError(table, cols) {
    if (!cols || cols === "*") return null;
    for (const c of cols.split(",").map((x) => x.trim())) {
      if ((missing[table] ?? []).includes(c)) return `column ${table}.${c} does not exist`;
    }
    return null;
  }

  function builder(table) {
    const q = { table, op: "select", cols: "*", filters: [], order: null, limit: null, mode: "many", payload: null, returning: false };
    const api = {
      select(cols = "*") { if (q.op === "select") q.cols = cols; else { q.returning = true; q.cols = cols; } return api; },
      insert(payload) { q.op = "insert"; q.payload = payload; return api; },
      update(payload) { q.op = "update"; q.payload = payload; return api; },
      upsert(payload) { q.op = "upsert"; q.payload = payload; return api; },
      eq(col, v) {
        if (col.includes(".")) {
          const [t, c] = col.split(".");
          q.filters.push((r) => tables[t].find((x) => x.id === r.session_id)?.[c] === v);
        } else q.filters.push((r) => r[col] === v);
        return api;
      },
      lt(col, v) { q.filters.push((r) => r[col] < v); return api; },
      is(col, v) { q.filters.push((r) => (r[col] ?? null) === v); return api; },
      not(col, op, v) { q.filters.push((r) => (op === "is" ? (r[col] ?? null) !== v : true)); return api; },
      in(col, arr) { q.filters.push((r) => arr.includes(r[col])); return api; },
      order(col, o = {}) { q.order = { col, asc: o.ascending !== false }; return api; },
      limit(n) { q.limit = n; return api; },
      single() { q.mode = "single"; return api; },
      maybeSingle() { q.mode = "maybe"; return api; },
      then(resolve, reject) { try { resolve(run(q)); } catch (e) { reject(e); } },
    };
    return api;
  }

  function finish(q, rows) {
    if (q.mode === "single") {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})` } };
      return { data: rows[0], error: null };
    }
    if (q.mode === "maybe") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  function run(q) {
    const t = tables[q.table];
    if (!t) return { data: null, error: { message: `relation "${q.table}" does not exist` } };
    if (q.op === "select") {
      const err = selectError(q.table, q.cols);
      if (err) return { data: null, error: { message: err } };
      let rows = t.filter((r) => matches(r, q.filters));
      if (q.order) rows = [...rows].sort((a, b) => (a[q.order.col] > b[q.order.col] ? 1 : -1) * (q.order.asc ? 1 : -1));
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return finish(q, rows.map((r) => project(q.table, r, q.cols)));
    }
    if (q.op === "insert" || q.op === "upsert") {
      const items = Array.isArray(q.payload) ? q.payload : [q.payload];
      const made = [];
      for (const item of items) {
        const forced = opts.failWrites?.(q.table, q.op, item);
        const err = forced ?? checkRow(q.table, item);
        writes.push({ table: q.table, op: q.op, row: item, error: err });
        if (err) return { data: null, error: { message: err } };
        if (q.op === "upsert" && q.table === "person_memory") {
          const i = t.findIndex((r) => r.client_id === item.client_id);
          if (i >= 0) { t[i] = { ...t[i], ...item }; made.push(t[i]); continue; }
        }
        let row = { ...item };
        // まだ無い列は、既定の値にも含めない(含めると、あとの update がその列を書いたように見える)
        const present = (defaults) => Object.fromEntries(Object.entries(defaults).filter(([k]) => !(missing[q.table] ?? []).includes(k)));
        if (q.table === "sessions") row = { id: randomUUID(), ...present(SESSION_DEFAULTS()), ...item };
        if (q.table === "messages") row = { seq: ++seq.messages, ...present(MESSAGE_DEFAULTS()), ...item };
        if (q.table === "safety_events") row = { seq: ++seq.safety_events, created_at: new Date().toISOString(), ...item };
        t.push(row);
        made.push(row);
      }
      if (!q.returning) return { data: null, error: null };
      return finish(q, made.map((r) => project(q.table, r, q.cols)));
    }
    if (q.op === "update") {
      const targets = t.filter((r) => matches(r, q.filters));
      for (const r of targets) {
        const merged = { ...r, ...q.payload };
        const forced = opts.failWrites?.(q.table, "update", q.payload, r);
        const err = forced ?? checkRow(q.table, q.payload) ?? checkRow(q.table, merged);
        writes.push({ table: q.table, op: "update", row: q.payload, error: err });
        if (err) return { data: null, error: { message: err } };
      }
      for (const r of targets) Object.assign(r, q.payload);
      return { data: q.returning ? targets.map((r) => project(q.table, r, q.cols)) : null, error: null };
    }
    return { data: null, error: { message: `unsupported op ${q.op}` } };
  }

  return {
    tables, writes,
    from: (table) => builder(table),
    async rpc(name, args) {
      if (name === "recent_turn_count") {
        const since = Date.now() - 3600_000;
        const ids = new Set(tables.sessions.filter((s) => s.client_id === args.p_client_id).map((s) => s.id));
        const n = tables.messages.filter((m) => ids.has(m.session_id) && m.role === "user" && Date.parse(m.created_at) > since).length;
        return { data: n, error: null };
      }
      return { data: null, error: { message: `function ${name} does not exist` } };
    },
  };
}
