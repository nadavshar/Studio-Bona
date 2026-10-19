import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = "https://rmzsovuz.web.arboxapp.com/group?whitelabel=Arbox&lang=he&location=21821&referrer=SITE&utm_source=ig&utm_medium=social&utm_content=link_in_bio&allLocations=false";
const API_URL = "https://apiappv2.arboxapp.com/api/v2/site/schedule/betweenDates";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });

  let scheduleReqHeaders = null;
  page.on("request", (req) => {
    const u = req.url();
    if (u.startsWith(API_URL)) {
      try { scheduleReqHeaders = req.headers(); } catch {}
    }
  });

  console.log("Navigating to", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => {
    console.log("goto networkidle timed out/failed:", e.message, "- continuing anyway");
  });
  await page.waitForTimeout(4000);

  console.log("=== BROWSER'S REQUEST HEADERS FOR betweenDates ===");
  console.log(JSON.stringify(scheduleReqHeaders, null, 2));

  await browser.close();

  console.log("\n=== NOW TESTING A PLAIN NODE fetch() WITH NO BROWSER, NO COOKIES ===");
  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const toDate = new Date(today.getTime() + 6 * 86400000);
  const to = toDate.toISOString().slice(0, 10);

  // Attempt 1: minimal headers, just what a server-to-server call would send.
  try {
    const res1 = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ to, from, locations_box_id: 21821 }),
    });
    const text1 = await res1.text();
    console.log("ATTEMPT 1 (minimal headers) status:", res1.status);
    console.log("ATTEMPT 1 body (first 1500 chars):", text1.slice(0, 1500));
  } catch (e) {
    console.log("ATTEMPT 1 failed:", e.message);
  }

  // Attempt 2: mimic browser more closely - Origin/Referer + any auth-ish
  // header seen from the captured browser request (if present).
  try {
    const mimicHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": "https://rmzsovuz.web.arboxapp.com",
      "Referer": URL,
    };
    if (scheduleReqHeaders) {
      for (const k of Object.keys(scheduleReqHeaders)) {
        if (/auth|token|key|x-/i.test(k) && !["x-forwarded-for"].includes(k.toLowerCase())) {
          mimicHeaders[k] = scheduleReqHeaders[k];
        }
      }
    }
    console.log("ATTEMPT 2 headers used:", JSON.stringify(mimicHeaders, null, 2));
    const res2 = await fetch(API_URL, {
      method: "POST",
      headers: mimicHeaders,
      body: JSON.stringify({ to, from, locations_box_id: 21821 }),
    });
    const text2 = await res2.text();
    console.log("ATTEMPT 2 (mimic browser headers) status:", res2.status);
    console.log("ATTEMPT 2 body (first 1500 chars):", text2.slice(0, 1500));
  } catch (e) {
    console.log("ATTEMPT 2 failed:", e.message);
  }
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
