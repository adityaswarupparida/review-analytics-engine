import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "../config.js";

// Cookies path derived from configured domain (e.g. amazon.in → amazon-amazon-in-cookies.json)
function getCookiesPath(): string {
  const slug = config.AMAZON_DOMAIN.replace(/\./g, "-");
  return `./data/amazon-${slug}-cookies.json`;
}

// Opens a visible browser for manual Amazon login and saves the session cookies
export async function loginToAmazon(): Promise<void> {
  console.log("\n🔐 Opening Amazon login...");
  console.log("   Log in manually, then press Enter here to save your session.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl = `https://www.${config.AMAZON_DOMAIN}/gp/sign-in.html`;
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  const cookiesPath = getCookiesPath();
  const cookies = await context.cookies();
  const dir = path.dirname(cookiesPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));

  console.log(`\n  ✓ Session saved to ${cookiesPath}`);
  await browser.close();
}
