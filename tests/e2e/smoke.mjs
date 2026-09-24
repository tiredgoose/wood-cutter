// Browser smoke test: serves the repo statically and drives the real game in Chromium.
// Run: npm run test:e2e   (set CHROMIUM_PATH to use a preinstalled browser)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
let failures = 0;
async function check(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  try {
    await fn(page);
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`✗ ${name}\n  ${e.message}`);
  } finally {
    await ctx.close();
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};

await check("new game starts and clicking trees chops them", async (page) => {
  await page.goto(url);
  await page.click("#btnPlay");
  await page.waitForFunction(() => window.game);
  const pos = await page.evaluate(() => {
    const t = game.cTrees.find((t) => t.alive);
    t.hp = 1;
    return { gx: t.gx, gy: t.gy };
  });
  await page.evaluate(() => game.chopTree(game.cTrees.find((t) => t.alive && t.hp === 1), true));
  assert(await page.evaluate(() => game.stats.treesChopped === 1 && game.logs > 0), "tree was not felled");
  // real pointer click somewhere on the forest should damage something
  const before = await page.evaluate(() => game.cTrees.reduce((s, t) => s + (t.alive ? t.hp : 0), 0));
  for (let i = 0; i < 6; i++) await page.mouse.click(480 + i * 8, 380);
  const after = await page.evaluate(() => game.cTrees.reduce((s, t) => s + (t.alive ? t.hp : 0), 0));
  assert(after < before, "pointer clicks did not chop");
});

await check("shop buttons work through event delegation", async (page) => {
  await page.goto(url);
  await page.click("#btnPlay");
  await page.evaluate(() => (game.gold = 1000));
  await page.waitForTimeout(600);
  await page.click('[data-action="buyUpgrade"][data-arg="axe"]');
  assert((await page.evaluate(() => game.upgrades.axe)) === 1, "axe upgrade not bought");
  await page.click('[data-action="group"][data-arg="goals"]');
  await page.waitForSelector(".quest-card");
});

await check("importing from the title screen loads the imported save", async (page) => {
  await page.goto(url);
  const code = await page.evaluate(() => btoa(JSON.stringify({ saveVersion: 7, gold: 424242, stats: {}, upgrades: { axe: 3 }, techs: {} })));
  page.once("dialog", (d) => d.accept(code));
  await page.click('[data-action="titleImport"]');
  await page.waitForFunction(() => window.game);
  const g = await page.evaluate(() => ({ gold: game.gold, axe: game.upgrades.axe }));
  assert(g.gold === 424242 && g.axe === 3, `import ignored: ${JSON.stringify(g)}`);
});

await check("saves on pagehide and continues with offline progress", async (page) => {
  await page.goto(url);
  await page.click("#btnPlay");
  await page.evaluate(() => {
    game.gold = 1e9;
    for (let i = 0; i < 8; i++) game.hireWorker();
    game.upgrades.autoChop = 5;
    window.dispatchEvent(new Event("pagehide"));
  });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("woodcutter_save")));
  assert(saved && saved.workers.length === 8, "pagehide did not save");
  // reloading fires pagehide again (fresh timestamp); age the save before the next page's scripts run
  await page.addInitScript(() => {
    const d = JSON.parse(localStorage.getItem("woodcutter_save"));
    d.savedAt = Date.now() - 2 * 3600 * 1000;
    localStorage.setItem("woodcutter_save", JSON.stringify(d));
  });
  await page.reload();
  await page.click("#btnContinue");
  await page.waitForSelector("#welcomeBack:not([hidden])");
  const txt = await page.textContent("#wbStats");
  assert(/Away for/.test(txt) && /trees/.test(txt), "welcome back summary missing: " + txt);
});

await check("service worker registers", async (page) => {
  await page.goto(url);
  const ok = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]));
  assert(ok, "service worker not ready");
});

await browser.close();
server.close();
if (errors.length) {
  console.log("Console/page errors:\n  " + errors.join("\n  "));
  failures++;
}
process.exit(failures ? 1 : 0);
