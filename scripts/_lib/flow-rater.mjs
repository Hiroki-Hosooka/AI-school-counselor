// ============================================================================
//  検証用: AI の返事を軽いモデル(無料枠)で採点する(「他人事感」の修正 10-1。2026年10月11日)
//
//  具体への言及・つなぎ・仮の見立て・気になったこと・どの話にも言える返事か、を返事ごとに採点する。
//  本番では使わない(本番はプロンプトの指示だけ。人が決めた)。合成データだけに使う(CLAUDE.md 5.10)。
//  採点の妥当性は、最初に人が採点した10〜20件と比べて確かめる(人が決めた。scripts/test-conversation-flow.mjs の
//  --calibrate で、人が採点する表を作り、--agreement で一致率を出す)。それまでは採点の数字を信用しすぎないこと。
// ============================================================================

import { callGemini, parseJSON, LITE_MODELS } from "../../src/classify.mjs";
import { withRateLimitRetry } from "./test-env.mjs";

export const RATER_PROMPT = `あなたは、学校の相談AIの返事を読んで採点する係です。相談者は中高生です。
直前までのやりとりと、採点する「AIの返事」を読み、次の5つをそれぞれ判定してください。

1. concrete(具体への言及): 相談者が直前までに書いた具体的なこと(場面・人・出来事・本人の言葉)に、AIの返事が少なくとも1つ触れているか。
   気持ちの言葉(しんどい・つらい・頑張ってきた など)だけで返していたら no。
   相談者の直前の発言に具体的な中身が無い(「うん」「わかんない」「そう」など)ときは na。
2. link(つなぎ): 相談者が前に言ったことと今の言葉を結びつけて、本人に確かめているか(yes / no)。
3. hypothesis(仮の見立て): 「もしかして〜?」のように、言い切らずに仮の見立てを確かめているか(yes / no)。
4. noticed(気になったこと): 聞き手として相談者の具体的な言葉が気になった、と正直に言っているか(yes / no)。
5. generic(他人事に聞こえるか): その返事が、誰のどんな話にも言えるような言葉だけでできているか(yes = 他人事に聞こえる / no)。
6. cbt_move(考えを分けて聞く): 出来事・そのときの考え・気持ちを分けて聞いているか(例:「その瞬間、頭の中ではどんなことが浮かんでる?」)(yes / no)。

出力は次のJSONのみ。前後に説明を付けない。
{"concrete": "yes|no|na", "link": "yes|no", "hypothesis": "yes|no", "noticed": "yes|no", "generic": "yes|no", "cbt_move": "yes|no", "reason": "20字程度"}`;

// context: [{ role: "user"|"ai", text }](直前のやりとり。古い順)/ reply: 採点する AI の返事
export function raterInput(context, reply) {
  const lines = (context ?? []).slice(-6).map((m) => `${m.role === "ai" ? "AI" : "相談者"}: ${m.text}`);
  return `# 直前までのやりとり\n${lines.join("\n") || "(なし)"}\n\n# 採点する AIの返事\n${reply}`;
}

const yn = (v, allowNa = false) => (v === "yes" || v === "no" || (allowNa && v === "na") ? v : null);

export async function rateReply(context, reply, keyPool, rotation) {
  const r = await withRateLimitRetry(keyPool, async () => {
    try {
      const res = await callGemini(LITE_MODELS, RATER_PROMPT, [{ role: "user", parts: [{ text: raterInput(context, reply) }] }], 600, -1);
      const j = parseJSON(res.text);
      return {
        ok: true, model: res.model,
        concrete: yn(j.concrete, true), link: yn(j.link), hypothesis: yn(j.hypothesis), noticed: yn(j.noticed), generic: yn(j.generic), cbt_move: yn(j.cbt_move),
        reason: String(j.reason ?? "").slice(0, 80),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, transient: /\[RATE_LIMIT\]|\[HTTP_503\]|JSON/.test(msg) };
    }
  }, (x) => !x.ok && x.transient, { state: rotation, label: "採点: " });
  return r;
}
