import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = "https://rmzsovuz.web.arboxapp.com/group?whitelabel=Arbox&lang=he&location=21821&referrer=SITE&utm_source=ig&utm_medium=social&utm_content=link_in_bio&allLocations=false";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });

  const requests = [];
  page.on("request", (req) => {
    const u = req.url();
    // only log XHR/fetch calls to something that looks like an API, not
    // every static asset - this is what we actually want to find
    if (/\/(api|graphql|v\d)\//i.test(u) || req.resourceType() === "xhr" || req.resourceType() === "fetch") {
      requests.push({ method: req.method(), url: u, type: req.resourceType() });
    }
  });
  const responses = [];
  page.on("response", async (res) => {
    const u = res.url();
    if (/\/(api|graphql|v\d)\//i.test(u)) {
      let bodySnippet = "";
      try {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const txt = await res.text();
          bodySnippet = txt.slice(0, 3000);
        }
      } catch (e) {
        bodySnippet = "(could not read body: " + e.message + ")";
      }
      responses.push({ status: res.status(), url: u, bodySnippet });
    }
  });

  console.log("Navigating to", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => {
    console.log("goto networkidle timed out/failed:", e.message, "- continuing anyway");
  });
  await page.waitForTimeout(4000);

  const title = await page.title();
  console.log("PAGE TITLE:", title);

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log("=== VISIBLE BODY TEXT (first 4000 chars) ===");
  console.log(bodyText.slice(0, 4000));

  writeFileSync("arbox-debug-html.html", await page.content());
  writeFileSync("arbox-debug-text.txt", bodyText);
  writeFileSync("arbox-debug-requests.json", JSON.stringify(requests, null, 2));
  writeFileSync("arbox-debug-responses.json", JSON.stringify(responses, null, 2));
  await page.screenshot({ path: "arbox-debug-screenshot.png", fullPage: true });

  console.log("=== XHR/FETCH REQUESTS SEEN (" + requests.length + ") ===");
  requests.forEach((r) => console.log(r.method, r.url));
  console.log("=== API-LOOKING RESPONSES (" + responses.length + ") ===");
  responses.forEach((r) => console.log(r.status, r.url, "\n  body snippet:", r.bodySnippet.slice(0, 500)));

  await browser.close();
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
