// ============================================================================
//  生成に失敗したときの画面の作り直しのテスト(2026年11月4日。Playwright。API は横取り)
//
//    npx next dev -p 3123 &   (別に起動しておく。DB・Gemini は使わない)
//    NODE_PATH=$(npm root -g) node scripts/test-generation-retry-ui.mjs [--url=http://localhost:3123]
//
//  ・作り直し待ちの一言は1つだけ出て、返事が届いたら消える(返事は自動で出る)
//  ・待つあいだも書ける。書き足したら作り直しをやめ、書き足した発言の返事にまとめる(古い作り直しを送らない)
//  ・何回か試してもだめなら「もう一度送る」。押すと同じ発言で作り直す(書き直させない)。発言を二重にしない
//  ・開き直したとき、最後が返事のない発言なら作り直す
// ============================================================================
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL = arg("url", "http://localhost:3123");
const WAIT = "ごめんね、返事を作るのに少し時間がかかってる。";
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

// failFor: 失敗させる chat の回数。resumeMessages: 開いたときの会話
async function open({ failFor = 0, resumeMessages = null } = {}) {
  const page = await browser.newPage();
  const log = [];
  let failed = 0, seq = 0;
  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    log.push({ action: body.action, body, at: Date.now() });
    const json = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (body.action === "resume") return json(resumeMessages ? { session: { id: "s1" }, messages: resumeMessages } : { session: null, messages: [] });
    if (body.action === "start") return json({ session: { id: "s1" }, dev: false, app_version: "test" });
    if (body.action === "chat") {
      const userSeq = body.retry_seq ?? ++seq;
      if (failed < failFor) {
        failed++;
        return json({ pending_retry: true, notice: WAIT + "書いてくれたことはそのまま残っているから、少し待っててね。", retry_after_ms: 150, user_seq: userSeq });
      }
      return json({ reply: `返事(${body.retry_seq != null ? "作り直し" : body.text})`, ai_seq: 100 + userSeq, safety: { risk: "none" } });
    }
    return json({});
  });
  await page.goto(URL);
  await page.waitForSelector("textarea");
  for (let i = 0; i < 100 && !log.some((x) => x.action === "start" || x.action === "resume"); i++) await sleep(100);
  await sleep(500);
  return { page, log };
}
const send = async (page, text) => { await page.fill("textarea", text); await page.keyboard.press("Enter"); };
const bubbles = (page) => page.locator(".msg .bubble").allInnerTexts();
const chats = (log) => log.filter((x) => x.action === "chat");

// 1. 2回失敗してから届く → 一言は1つ・返事が自動で出て一言は消える
{
  console.log("■ 2回失敗してから届く");
  const { page, log } = await open({ failFor: 2 });
  await send(page, "こんにちは");
  await sleep(400);
  let t = await bubbles(page);
  ok(t.filter((x) => x.startsWith(WAIT)).length === 1, `作り直し待ちの一言が1つ出る(${t.join("|")})`);
  ok(!t.some((x) => /ちゃんと受け取っているよ/.test(x)), "「ちゃんと受け取っているよ」の一言は出さない");
  await sleep(2500);
  t = await bubbles(page);
  ok(t.join("|") === "こんにちは|返事(作り直し)", `返事が自動で出て、一言は消える(${t.join("|")})`);
  ok(chats(log).length === 3 && chats(log).slice(1).every((x) => x.body.retry_seq === 1 && !x.body.text), "作り直しは発言を送り直さず retry_seq だけ(発言を二重にしない)");
  await page.close();
}

// 2. 待つあいだに書き足す → 作り直しをやめ、書き足した発言の返事にまとめる
{
  console.log("■ 待つあいだに書き足す");
  const { page, log } = await open({ failFor: 1 });
  await send(page, "部活のことで");
  await sleep(100);
  ok(!(await page.locator("textarea").isDisabled()), "待つあいだも書ける");
  await send(page, "先輩と気まずい");
  await sleep(1500);
  const t = await bubbles(page);
  ok(t.join("|") === "部活のことで|先輩と気まずい|返事(先輩と気まずい)", `返事は1つ・一言は消える(${t.join("|")})`);
  ok(!chats(log).some((x) => x.body.retry_seq != null), "古い発言の作り直しは送らない");
  await page.close();
}

// 3. ずっと失敗 → 「もう一度送る」→ 押すと届く
{
  console.log("■ 何回か試してもだめ → もう一度送る");
  const { page, log } = await open({ failFor: 6 });
  await send(page, "ねえ");
  const btn = page.locator("button.retry");
  await btn.waitFor({ timeout: 15000 }).catch(() => {});
  ok(await btn.count() === 1, "「もう一度送る」が出る");
  const n = chats(log).length;
  ok(n === 6, `出るまでに試した回数(最初+5回)(${n})`);
  let t = await bubbles(page);
  ok(t.filter((x) => x.startsWith(WAIT)).length === 1, "一言は1つのまま");
  await btn.click();
  await sleep(800);
  t = await bubbles(page);
  ok(t.join("|") === "ねえ|返事(作り直し)", `押すと同じ発言で作り直して届く(${t.join("|")})`);
  ok(chats(log).length === 7 && chats(log)[6].body.retry_seq === 1, "押したときも retry_seq だけ");
  await page.close();
}

// 4. 開き直したとき、最後が返事のない発言なら作り直す
{
  console.log("■ 開き直したとき");
  const { page, log } = await open({ resumeMessages: [{ role: "ai", body: "こんにちは", seq: 1 }, { role: "user", body: "続き", seq: 2 }] });
  await sleep(1500);
  const t = await bubbles(page);
  ok(chats(log).some((x) => x.body.retry_seq === 2), "最後の発言を作り直す");
  ok(t.join("|") === "こんにちは|続き|返事(作り直し)", `返事が出る(${t.join("|")})`);
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
