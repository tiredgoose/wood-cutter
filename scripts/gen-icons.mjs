// Rasterises icons/favicon.svg into the PNG icons the web manifest needs. Run: npm run icons
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../icons/favicon.svg", import.meta.url), "utf8");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
async function render(size, file, { maskable = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const pad = maskable ? size * 0.12 : 0;
  const inner = maskable ? svg.replace(/<rect width="64" height="64" rx="14"[^>]*\/>/, "") : svg;
  await page.setContent(
    `<html><body style="margin:0;background:${maskable ? "#1a1a2e" : "transparent"}">` +
      `<div style="width:${size - pad * 2}px;height:${size - pad * 2}px;margin:${pad}px">${inner.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body></html>`,
  );
  await page.screenshot({ path: new URL(`../icons/${file}`, import.meta.url).pathname, omitBackground: !maskable });
}
await render(192, "icon-192.png");
await render(512, "icon-512.png");
await render(512, "icon-maskable-512.png", { maskable: true });
await browser.close();
console.log("icons written");
