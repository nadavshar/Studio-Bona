import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = "https://rmzsovuz.web.arboxapp.com/group?whitelabel=Arbox&lang=he&location=21821&referrer=SITE&utm_source=ig&utm_medium=social&utm_content=link_in_bio&allLocations=false";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });

  const requests = [];
  page.on("request", (req) => {
    const u = req.url();
    if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
      let headers = {};
      try { headers = req.headers(); } catch {}
      requests.push({ method: req.method(), url: u, type: req.resourceType(), headers, postData: req.postData() });
    }
  });

  const responses = [];
  let fullBodies = {};
  page.on("response", async (res) => {
    const u = res.url();
    const req = res.request();
    if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch") return;
    let body = "";
    try {
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("json") || ct.includes("text")) {
        body = await res.text();
      }
    } catch (e) {
      body = "(could not read body: " + e.message + ")";
    }
    responses.push({ status: res.status(), url: u, bodyLength: body.length });
    fullBodies[u + "#" + responses.length] = body;
  });

  console.log("Navigating to", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => {
    console.log("goto networkidle timed out/failed:", e.message, "- continuing anyway");
  });
  await page.waitForTimeout(5000);

  // Try clicking forward/next-week controls if present, to trigger any
  // additional lazy-loaded API calls (filters, categories, coaches list).
  try {
    const nextBtn = page.locator("button, [role=button]").filter({ hasText: /הבא|next|›|»/i }).first();
    if (await nextBtn.count()) {
      await nextBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  } catch {}

  // Try opening a single class/event card to see if a detail call fires.
  try {
    const card = page.locator("[class*='event'], [class*='class'], [class*='schedule'] li, [class*='schedule'] [class*='card']").first();
    if (await card.count()) {
      await card.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  } catch {}

  const title = await page.title();
  console.log("PAGE TITLE:", title);

  const bodyText = await page.evaluate(() => document.body.innerText);
  writeFileSync("arbox-debug-text.txt", bodyText);
  writeFileSync("arbox-debug-html.html", await page.content());
  writeFileSync("arbox-debug-requests.json", JSON.stringify(requests, null, 2));
  writeFileSync("arbox-debug-responses.json", JSON.stringify(responses, null, 2));
  writeFileSync("arbox-debug-bodies.json", JSON.stringify(fullBodies, null, 2));
  await page.screenshot({ path: "arbox-debug-screenshot.png", fullPage: true });

  console.log("=== XHR/FETCH REQUESTS SEEN (" + requests.length + ") ===");
  requests.forEach((r) => console.log(r.method, r.url, r.postData ? "  POSTDATA=" + r.postData.slice(0, 300) : ""));

  console.log("=== RESPONSES SEEN (" + responses.length + ") ===");
  responses.forEach((r) => console.log(r.status, r.url, "len=" + r.bodyLength));

  console.log("=== FULL BODY DUMPS FOR INTERESTING ENDPOINTS ===");
  for (const [key, body] of Object.entries(fullBodies)) {
    const url = key.split("#")[0];
    if (/betweenDates|categor|coach|instructor|teacher|filter/i.test(url) && body) {
      console.log("--- FULL BODY: " + key + " (length " + body.length + ") ---");
      console.log(body);
      console.log("--- END BODY ---");
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
