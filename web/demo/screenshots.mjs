// Takes the README screenshots from a running demo server (scripts/demo.sh). Read-only: sheets are
// opened and ticked, never saved. Needs a Chromium binary in $CHROME.
//
//   CHROME=/path/to/chromium node demo/screenshots.mjs [url] [out dir] [names,...]
import puppeteer from "puppeteer-core";

const [,, base = "http://127.0.0.1:18080", out = new URL("../../docs/screenshots", import.meta.url).pathname, only = ""] = process.argv;
if (!process.env.CHROME) throw new Error("Set CHROME to a Chromium binary, e.g. $(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium");
const want = (n) => !only || only.split(",").includes(n);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--font-render-hinting=none"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function open(path, { scheme = "light", width = 1440, height = 900, dpr = 2 } = {}) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(base + path, { waitUntil: "networkidle0" });
  await sleep(500);
  return page;
}
async function shot(page, name) {
  await sleep(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
  console.log(`${out}/${name}.png`);
}
async function clickRow(page, selector, text) {
  for (const el of await page.$$(selector)) {
    if ((await el.evaluate((e) => e.textContent)).includes(text)) return el.click();
  }
  throw new Error(`no ${selector} containing ${text}`);
}

try {
  for (const scheme of ["light", "dark"]) {
    if (!want(`overview-${scheme}`)) continue;
    const page = await open("/?month=2026-11", { scheme });
    await page.waitForSelector(".ytable");
    await shot(page, `overview-${scheme}`);
  }
  if (want("drill")) {
    const page = await open("/?month=2026-11");
    await page.waitForSelector(".shares");
    await clickRow(page, ".shares button", "Food");
    await page.waitForSelector(".category-breakdown-sub");
    await page.$eval(".main", (el) => { el.scrollTop = 0; });
    await shot(page, "drill");
  }
  if (want("month")) await shot(await open("/?mode=month&month=2026-10"), "month");
  if (want("transactions")) {
    const page = await open("/transactions?month=2026-09");
    await page.waitForSelector(".tx");
    await clickRow(page, ".tx .tx-main", "RESTAURANT DE VIJF");
    await page.waitForSelector(".insp-head");
    await shot(page, "transactions");
  }
  if (want("link")) {
    const page = await open("/transactions?month=2026-11");
    await page.waitForSelector(".tx");
    await clickRow(page, ".tx .tx-main", "Sushi Sora");
    await page.waitForSelector(".insp-head");
    await page.locator("::-p-text(Link Payments Back)").click();
    await page.waitForSelector(".cands");
    await sleep(800);
    for (const c of await page.$$(".cand")) if ((await c.evaluate((e) => e.textContent)).includes("Tikkie")) await c.click();
    await shot(page, "link");
  }
  if (want("inbox")) {
    const page = await open("/inbox");
    await page.waitForSelector(".stage-inner .card");
    await shot(page, "inbox");
  }
  if (want("rules")) {
    const page = await open("/transactions?month=2026-11");
    await page.click(".sb nav .rules-link");
    await page.waitForSelector(".rules-list");
    await sleep(300);
    await clickRow(page, ".rule-summary", "versmarkt");
    await sleep(500);
    await shot(page, "rules");
  }
  if (want("phone")) await shot(await open("/?mode=month&month=2026-10", { scheme: "dark", width: 390, height: 844, dpr: 3 }), "phone");
} finally {
  await browser.close();
}
if (errors.length) {
  console.error("Page errors:", errors);
  process.exit(1);
}
