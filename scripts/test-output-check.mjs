// ============================================================================
//  安全層の回帰テスト（backlog 0-2）
//
//  src/safety.mjs の CRISIS_WORDS / OUTPUT_NG を、実際の Edge Function
//  （supabase/functions/chat/index.ts）が使う判定ロジックと同じ形で検証する。
//  実行: node scripts/test-output-check.mjs
// ============================================================================

import { CRISIS_WORDS, OUTPUT_NG } from "../src/safety.mjs";

// index.ts の checkOutput() と同じロジック
const checkOutput = (text) => OUTPUT_NG.filter((re) => re.test(text));
// index.ts の classify() 内、キーワード事前検知と同じロジック
const checkCrisis = (text) => CRISIS_WORDS.filter((w) => text.includes(w));

// --------------------------------------------------------------------------
// 許容されるべき文（OUTPUT_NG に一件も引っかかってはいけない）
// --------------------------------------------------------------------------
const ALLOWED = [
  "あ、別に相談じゃなくてもいいですよ",
  "また何かあったら、いつでもどうぞ",
  "そっか、わかんないかー",
  "そう感じるエピソードがあったの？",
];

// --------------------------------------------------------------------------
// 検知されるべき文（OUTPUT_NG に最低一件は引っかからなければいけない）
// --------------------------------------------------------------------------
const MUST_DETECT = [
  "頑張ってね",
  "あの子ほんとにひどいね",
  "あなたは悪くないよ",
  "いつでも電話してね",
  "認知行動療法という方法があります",
  "一人でもいいじゃん",
];

// --------------------------------------------------------------------------
// 危機として検知されるべき文（CRISIS_WORDS に最低一件は当たらなければいけない）
// --------------------------------------------------------------------------
const MUST_DETECT_CRISIS = [
  "消えたいってずっと思ってて",
  "家で殴られてる",
];

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `  -- ${detail}` : ""}`);
  }
}

console.log("[許容されるべき文] 誤検知(false positive)が無いこと");
for (const text of ALLOWED) {
  const hit = checkOutput(text);
  check(`「${text}」`, hit.length === 0, hit.length ? `誤検知: ${hit.map(String).join(", ")}` : "");
}

console.log("\n[検知されるべき文] OUTPUT_NG の見逃し(false negative)が無いこと");
for (const text of MUST_DETECT) {
  const hit = checkOutput(text);
  check(`「${text}」`, hit.length > 0, hit.length === 0 ? "どの正規表現にも一致しなかった" : "");
}

console.log("\n[危機として検知されるべき文] CRISIS_WORDS の見逃しが無いこと");
for (const text of MUST_DETECT_CRISIS) {
  const hit = checkCrisis(text);
  check(`「${text}」`, hit.length > 0, hit.length === 0 ? "どの危機語にも一致しなかった" : "");
}

console.log(`\n${failures === 0 ? "全件通過" : `${failures} 件失敗`}`);
process.exitCode = failures === 0 ? 0 : 1;
