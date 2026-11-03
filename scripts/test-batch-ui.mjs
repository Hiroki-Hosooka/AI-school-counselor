// ============================================================================
//  連投の画面の時機のテスト(2026年11月3日。docs/design-batch-messages.md 2章・9章)
//
//    npx next dev -p 3123 &   (別に起動しておく。DB・Gemini は使わない)
//    NODE_PATH=$(npm root -g) node scripts/test-batch-ui.mjs [--url=http://localhost:3123]
//
//  ブラウザの /api/chat への呼び出しを Playwright で横取りして、決まった答えを返す(サーバの中身は scripts/test-batch.mjs で確かめる)。
//  ここでは画面の決まりだけを確かめる: 返事をする時機(1.5秒・入力が止まってから3秒・最長20秒・危機は1秒/最長5秒)、
//  返事を待つあいだも書ける、連投で返事が1回、作っている途中の追加、チップはすぐ、入力中の文字を送らない
// ============================================================================
// playwright はこの環境に入っている(依存パッケージには足さない)。プロジェクトの外にあるので NODE_PATH=$(npm root -g) を付けて流す
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL = arg("url", "http://localhost:3123");
const CFG = { idle_ms: 1500, typing_ms: 3000, max_ms: 20000, crisis_idle_ms: 1000, crisis_max_ms: 5000 };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

const browser = await chromium.launch();

// 1つの台本ごとに新しいページ。log に呼び出しの時刻を残す
async function open({ replyDelayMs = 50, superseded = false } = {}) {
  const page = await browser.newPage();
  const log = [];
  let seq = 0;
  let replyStartedAt = null;
  let postsSinceReplyStart = 0;
  let supersededOnce = false;
  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const at = Date.now();
    log.push({ action: body.action, at, body });
    const json = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (body.action === "resume") return json({ session: null, messages: [] });
    if (body.action === "start") return json({ session: { id: "s1" }, batch: CFG, dev: false, app_version: "test" });
    if (body.action === "post") {
      if (replyStartedAt) postsSinceReplyStart++;
      return json({ seq: ++seq, urgent: /死にたい/.test(body.text) });
    }
    if (body.action === "chat") {
      replyStartedAt = Date.now();
      postsSinceReplyStart = 0;
      await new Promise((r) => setTimeout(r, replyDelayMs));
      replyStartedAt = null;
      if (superseded && !supersededOnce && postsSinceReplyStart > 0) { supersededOnce = true; return json({ superseded: true }); }
      return json({ reply: `返事(〜${body.to_seq})`, ai_seq: 1000 + body.to_seq, safety: { risk: "none" } });
    }
    return json({});
  });
  await page.goto(URL);
  await page.waitForSelector("textarea");
  // 画面が動き出す(start が届く)まで待ってから書く(HTML が出ただけで書くと、入力が画面に届かないことがある)
  for (let i = 0; i < 100 && !log.some((x) => x.action === "start"); i++) await sleep(100);
  await sleep(500);
  return { page, log };
}
const send = async (page, text) => { await page.fill("textarea", text); await page.keyboard.press("Enter"); };
const posts = (log) => log.filter((x) => x.action === "post");
const replies = (log) => log.filter((x) => x.action === "chat");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 1通だけ送って待つ → 約1.5秒で返事を求める
{
  console.log("■ 1通だけ送って待つ");
  const { page, log } = await open();
  await send(page, "こんにちは");
  const sentAt = Date.now();
  await sleep(3000);
  const r = replies(log);
  const dt = r.length ? r[0].at - sentAt : null;
  ok(r.length === 1, `返事を1回求める(${r.length})`);
  ok(dt != null && dt >= 1300 && dt <= 2300, `約1.5秒で(${dt}ms)`);
  ok(await page.locator(".msg.ai .bubble").count() === 1, "返事が出る");
  await page.close();
}

// 2. 短い文を5通続けて送る → 返事は1回・5通目まで
{
  console.log("■ 短い文を5通続けて送る");
  const { page, log } = await open();
  for (const t of ["きょう", "学校で", "ちょっと", "嫌なことが", "あった"]) { await send(page, t); await sleep(400); }
  await sleep(3000);
  const r = replies(log);
  ok(posts(log).length === 5, `5通とも1通ずつ送る(${posts(log).length})`);
  ok(r.length === 1 && r[0].body.to_seq === 5, `返事は1回・5通目までのまとまり(${r.map((x) => x.body.to_seq).join(",")})`);
  ok(await page.locator(".msg.user .bubble").count() === 5, "送った発言は、その場で1通ずつ吹き出しになる");
  const seqs = posts(log).map((p) => p.body.text).join("/");
  ok(seqs === "きょう/学校で/ちょっと/嫌なことが/あった", "送る順番が保たれる");
  await page.close();
}

// 3. 送ったあと続けて入力している → 入力が止まってから約3秒
{
  console.log("■ 送ったあと続けて入力する");
  const { page, log } = await open();
  await send(page, "あのね");
  await sleep(500);
  for (const ch of "まだ書いてる") { await page.type("textarea", ch); await sleep(300); }
  const stoppedAt = Date.now();
  await sleep(4500);
  const r = replies(log);
  const dt = r.length ? r[0].at - stoppedAt : null;
  ok(r.length === 1 && dt >= 2700 && dt <= 3700, `入力が止まってから約3秒(${dt}ms)`);
  ok(!log.some((x) => JSON.stringify(x.body).includes("まだ書いてる")), "書きかけの文字はサーバに送らない");
  await page.close();
}

// 4. 入力を続けて20秒を超える → 最長20秒で返事
{
  console.log("■ 入力を続けて20秒を超える");
  const { page, log } = await open();
  await send(page, "ながく書く");
  const sentAt = Date.now();
  while (Date.now() - sentAt < 23000 && !replies(log).length) { await page.type("textarea", "あ"); await sleep(400); }
  const r = replies(log);
  const dt = r.length ? r[0].at - sentAt : null;
  ok(r.length === 1 && dt >= 19500 && dt <= 21500, `最長の約20秒で返事を求める(${dt}ms)`);
  await page.close();
}

// 5. 段階2の危機を検知した → 入力が止まってから約1秒・最長約5秒
{
  console.log("■ 段階2の危機(入力が止まってから1秒)");
  const { page, log } = await open();
  await send(page, "死にたい");
  const sentAt = Date.now();
  await sleep(2500);
  const r = replies(log);
  const dt = r.length ? r[0].at - sentAt : null;
  ok(r.length === 1 && dt >= 800 && dt <= 1700, `約1秒で(${dt}ms)`);
  await page.close();
}
{
  console.log("■ 段階2の危機(入力を続けても最長5秒)");
  const { page, log } = await open();
  await send(page, "死にたい");
  const sentAt = Date.now();
  while (Date.now() - sentAt < 8000 && !replies(log).length) { await page.type("textarea", "あ"); await sleep(300); }
  const r = replies(log);
  const dt = r.length ? r[0].at - sentAt : null;
  ok(r.length === 1 && dt >= 4500 && dt <= 5800, `最長の約5秒で(${dt}ms)`);
  await page.close();
}

// 6. 返事を待つあいだも書ける・作っている途中に追加で送る → 作り直して、広げたまとまりで返事
{
  console.log("■ 返事を作っている途中に追加で送る");
  const { page, log } = await open({ replyDelayMs: 2500, superseded: true });
  await send(page, "部活のことで");
  await sleep(2000);   // 返事を求めはじめる(1.5秒)
  ok(replies(log).length === 1, "返事を求めはじめた");
  ok(!(await page.locator("button.send").isDisabled()), "返事を待つあいだも「送る」が使える");
  ok(await page.locator(".thinking").count() === 1, "返事を待つあいだは入力中の表示(…)が出る");
  await send(page, "先輩と気まずい");
  await sleep(6000);
  const r = replies(log);
  ok(r.length === 2 && r[1].body.to_seq === 2 && r[1].body.rebuilt === 1, `捨てられたら、広げたまとまりで求め直す(${r.map((x) => `${x.body.to_seq}/${x.body.rebuilt}`).join(",")})`);
  const texts = await page.locator(".msg .bubble").allInnerTexts();
  ok(texts.join("|") === "部活のことで|先輩と気まずい|返事(〜2)", `発言は失われず、順番が保たれる(${texts.join("|")})`);
  await page.close();
}

// 7. 入力中の表示(…)は、返事を求める前には出さない
{
  console.log("■ 入力中の表示の時機");
  const { page } = await open({ replyDelayMs: 1500 });
  await send(page, "あのね");
  const sentAt = Date.now();
  await sleep(600);
  ok(await page.locator(".thinking").count() === 0, "送ってすぐは出さない(まだ書いている人をせかさない)");
  await page.locator(".thinking").waitFor({ timeout: 4000 }).catch(() => {});
  const dt = Date.now() - sentAt;
  ok(await page.locator(".thinking").count() === 1 && dt >= 1200 && dt <= 2500, `返事を求めたら出す(${dt}ms)`);
  await page.close();
}

// 8. チップ(トップ画面のボタン)は待たずにすぐ
{
  console.log("■ チップはすぐ");
  const { page, log } = await open();
  const clickedAt = Date.now();
  await page.locator("button.top-choice").first().click();
  await sleep(1200);
  const r = replies(log);
  const dt = r.length ? r[0].at - clickedAt : null;
  ok(r.length === 1 && dt < 800, `待たずにすぐ返事を求める(${dt}ms)`);
  ok(posts(log)[0]?.body.choice_id === "K1", "チップの番号を送る");
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail}件 失敗(${pass + fail}件中)` : `\n全件通過(${pass}件中)`);
process.exit(fail ? 1 : 0);
