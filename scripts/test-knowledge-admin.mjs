// ============================================================================
//  ナレッジ管理画面の入力の確かめ(src/knowledge-admin.mjs)のオフラインテスト(docs/backlog.md 1-1)
//
//  実行: node scripts/test-knowledge-admin.mjs(npm run test:knowledge-admin でも同じ)
//  API・DB は使わない。
// ============================================================================

import { validateKnowledgeInput, parseTags } from "../src/knowledge-admin.mjs";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  OK   ${label}`); } else { failed++; console.log(`  NG   ${label}${detail ? ` … ${detail}` : ""}`); }
}

const existing = [
  { id: "P1", cat: "principle", active: true, tags: [] },
  { id: "P2", cat: "principle", active: false, tags: [] },
  { id: "N1", cat: "ng", active: true, tags: [] },
  { id: "N2", cat: "ng", active: true, tags: [] },
  { id: "V1", cat: "verbatim", active: true, tags: ["沈黙"] },
  { id: "T1", cat: "resp", active: true, tags: [] }, // 技法カタログのようにタグの無い行
];
const base = { src: "嶋", school: "来談者中心寄り", cat: "verbatim", weight: "rapport", tags: "沈黙、間", body: "そっか。", note: "" };

console.log("新しく足す");
{
  const r = validateKnowledgeInput({ ...base, id: "V99" }, existing, true);
  check("必須がそろっていれば通る(タグは読点区切りでも配列になる)", r.ok && r.row.tags.join("|") === "沈黙|間" && r.row.lv === null && r.row.active === true);
  check("既にある ID は使えない", !validateKnowledgeInput({ ...base, id: "V1" }, existing, true).ok);
  check("ID に日本語・空白は使えない", !validateKnowledgeInput({ ...base, id: "逐語 1" }, existing, true).ok);
  check("出典が無いと通らない", !validateKnowledgeInput({ ...base, id: "V98", src: "" }, existing, true).ok);
  check("出典の値が表に無いと通らない", !validateKnowledgeInput({ ...base, id: "V98", src: "山田" }, existing, true).ok);
  check("流派が無いと通らない", !validateKnowledgeInput({ ...base, id: "V98", school: " " }, existing, true).ok);
  check("種別が無いと通らない", !validateKnowledgeInput({ ...base, id: "V98", cat: "" }, existing, true).ok);
  check("本文が無いと通らない", !validateKnowledgeInput({ ...base, id: "V98", body: "" }, existing, true).ok);
  check("原則・禁止以外はタグが要る", !validateKnowledgeInput({ ...base, id: "V98", tags: "" }, existing, true).ok);
  check("原則はタグなしでよい", validateKnowledgeInput({ ...base, id: "P9", cat: "principle", tags: "" }, existing, true).ok);
  check("禁止は強さが要る", !validateKnowledgeInput({ ...base, id: "N9", cat: "ng", tags: "" }, existing, true).ok);
  const ng = validateKnowledgeInput({ ...base, id: "N9", cat: "ng", tags: "", lv: "3" }, existing, true);
  check("禁止に強さ3を付けて通る", ng.ok && ng.row.lv === 3);
  check("禁止以外の強さは捨てる", validateKnowledgeInput({ ...base, id: "V97", lv: 3 }, existing, true).row?.lv === null);
  check("モードの値が表に無いと通らない", !validateKnowledgeInput({ ...base, id: "V96", mode: "XYZ" }, existing, true).ok);
}

console.log("直す");
{
  check("無い ID は直せない", !validateKnowledgeInput({ ...base, id: "ZZ" }, existing, false).ok);
  check("逐語を直せる", validateKnowledgeInput({ ...base, id: "V1" }, existing, false).ok);
  check("もともとタグの無い行は、タグなしのまま直せる", validateKnowledgeInput({ ...base, id: "T1", cat: "resp", tags: "" }, existing, false).ok);
  check("タグのある行のタグを空にはできない", !validateKnowledgeInput({ ...base, id: "V1", tags: "" }, existing, false).ok);
  check("最後の原則は使わなくできない", !validateKnowledgeInput({ ...base, id: "P1", cat: "principle", tags: "", active: false }, existing, false).ok);
  check("最後の原則の種別は変えられない", !validateKnowledgeInput({ ...base, id: "P1", cat: "ctx", tags: "x" }, existing, false).ok);
  check("禁止がほかにも残るなら、1件を使わなくできる", validateKnowledgeInput({ ...base, id: "N1", cat: "ng", lv: 2, tags: "", active: false }, existing, false).ok);
  const withoutN2 = existing.map((r) => (r.id === "N2" ? { ...r, active: false } : r));
  check("ほかの禁止が使われていなければ、最後の禁止は使わなくできない",
    !validateKnowledgeInput({ ...base, id: "N1", cat: "ng", lv: 2, tags: "", active: false }, withoutN2, false).ok);
  check("使っていない原則をもう一度使う状態にできる", validateKnowledgeInput({ ...base, id: "P2", cat: "principle", tags: "", active: true }, existing, false).ok);
}

console.log("タグの読み取り");
check("カンマ・読点・空白で区切り、重複を除く", parseTags("a, b、c  a").join("|") === "a|b|c");
check("配列もそのまま受け取る", parseTags([" x ", "y", ""]).join("|") === "x|y");

console.log(`\n${failed === 0 ? "全件通過" : `失敗 ${failed}件`}(${passed + failed}件中)`);
process.exit(failed === 0 ? 0 : 1);
