// Runs the full Bona pipeline in one shot, meant for GitHub Actions:
//   1. sync: copy qualifying events from the internal "חללים" calendar
//      (read via Bona's own OAuth identity) into the public "Bona ציבורי"
//      calendar (written via a service account), sanitizing titles/times
//      and tagging open/public classes.
//   2. export: read the public calendar back and build availability.json
//      (180 days ahead, grouped by local Asia/Jerusalem date).
//   3. publish: inject that JSON straight into index.html's
//      <script id="availability-data"> block, in place.
//
// All credentials come from environment variables (GitHub Actions secrets) -
// this script never reads or writes local credential files, and never prints
// secret values. The workflow that calls this script is responsible for
// git-committing index.html if it changed.

const INTERNAL_CAL = "lgqnv0ffeqpvjuv85abtq5dlb4@group.calendar.google.com"; // חללים
const PUBLIC_CAL = "df5ac0af9337666c6757cc60984239a2aa9187c6f1c3b74b149e222818214df6@group.calendar.google.com"; // Bona ציבורי
const SYNC_DAYS_AHEAD = 180;
const DAYS_AHEAD = 180;
const STUDIO_COLOR = { "7": 1, "9": 2 }; // Peacock -> Studio 1, Blueberry -> Studio 2
const NOISE_EMOJI = "🔊";
const OPEN_CLASS_EMOJI = "💧"; // event title format: "<מורה> - <שם הפעילות> 💧"

const FAYA_SIGNUP_URL =
  "https://rmzsovuz.web.arboxapp.com/group?whitelabel=Arbox&lang=he&location=21821&referrer=SITE&utm_source=ig&utm_medium=social&utm_content=link_in_bio&allLocations=false";
function isFaya(label) {
  const compact = label.toLowerCase().replace(/[.\s]/g, "");
  return compact.includes("fayafam") || compact.includes("faya") || label.includes("פאיה");
}

function extractUrl(text) {
  const hrefMatch = text.match(/href="(https?:\/\/[^"]+)"/i);
  if (hrefMatch) return hrefMatch[1];
  if (/^https?:\/\//.test(text)) return text;
  return null;
}
function extractPhone(text) {
  const m = text.match(/0\d{1,2}-?\d{6,8}/);
  return m ? m[0].replace(/[^\d]/g, "") : null;
}

// ---- credential loaders (env-based) ----
function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function getOAuthToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("BONA_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("BONA_OAUTH_CLIENT_SECRET"),
      refresh_token: requireEnv("BONA_OAUTH_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("oauth refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

async function getServiceAccountToken(scope) {
  const { createSign } = await import("node:crypto");
  const key = JSON.parse(requireEnv("BONA_SERVICE_ACCOUNT_JSON"));
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(key.private_key).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("service account token failed: " + JSON.stringify(data));
  return data.access_token;
}

// ---- calendar helpers ----
async function listAllEvents(token, calendarId, params) {
  const items = [];
  let pageToken;
  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(`list events failed (${calendarId}): ${JSON.stringify(data)}`);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

async function runSync(oauthToken, saToken) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + SYNC_DAYS_AHEAD * 24 * 3600 * 1000).toISOString();

  const sourceEvents = await listAllEvents(oauthToken, INTERNAL_CAL, {
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });

  const qualifying = sourceEvents.filter(
    (e) => e.status === "confirmed" && STUDIO_COLOR[e.colorId] && e.start?.dateTime && e.end?.dateTime
  );

  const desired = new Map();
  for (const e of qualifying) {
    const studio = STUDIO_COLOR[e.colorId];
    const title = e.summary || "";
    const isOpenClass = title.includes(OPEN_CLASS_EMOJI);
    let summary;
    let description;
    if (isOpenClass) {
      let label = title.split(OPEN_CLASS_EMOJI)[0].trim();
      if (isFaya(label)) {
        label = "Faya.Fam";
        description = FAYA_SIGNUP_URL;
      } else {
        const desc = (e.description || "").trim();
        const url = extractUrl(desc);
        const phone = url ? null : extractPhone(desc);
        if (url) description = url;
        else if (phone) description = `tel:${phone}`;
      }
      summary = `סטודיו ${studio} · שיעור פתוח · ${label}`;
    } else {
      const noisy = title.includes(NOISE_EMOJI);
      summary = `סטודיו ${studio} · תפוס · ${noisy ? "רועש" : "שקט"}`;
    }
    desired.set(e.id, {
      summary,
      ...(description ? { description } : {}),
      start: { dateTime: e.start.dateTime, timeZone: e.start.timeZone || "Asia/Jerusalem" },
      end: { dateTime: e.end.dateTime, timeZone: e.end.timeZone || "Asia/Jerusalem" },
      colorId: e.colorId,
      extendedProperties: { private: { bonaSourceId: e.id } },
    });
  }

  const existing = await listAllEvents(saToken, PUBLIC_CAL, {
    timeMin, timeMax, singleEvents: "true", maxResults: "250",
    privateExtendedProperty: "bonaSourceId=*",
  }).catch(() => []);
  const existingAll = existing.length
    ? existing
    : await listAllEvents(saToken, PUBLIC_CAL, { timeMin, timeMax, singleEvents: "true", maxResults: "250" });

  const existingBySource = new Map();
  for (const e of existingAll) {
    const sid = e.extendedProperties?.private?.bonaSourceId;
    if (sid) existingBySource.set(sid, e);
  }

  let created = 0, updated = 0, deleted = 0, unchanged = 0;

  for (const [sourceId, body] of desired) {
    const existingEvent = existingBySource.get(sourceId);
    if (!existingEvent) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(PUBLIC_CAL)}/events`,
        { method: "POST", headers: { Authorization: `Bearer ${saToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!res.ok) console.error("CREATE FAILED", sourceId, await res.text());
      else created++;
    } else {
      const changed =
        existingEvent.summary !== body.summary ||
        existingEvent.start?.dateTime !== body.start.dateTime ||
        existingEvent.end?.dateTime !== body.end.dateTime ||
        (existingEvent.description || "") !== (body.description || "");
      if (changed) {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(PUBLIC_CAL)}/events/${existingEvent.id}`,
          { method: "PATCH", headers: { Authorization: `Bearer ${saToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        if (!res.ok) console.error("UPDATE FAILED", sourceId, await res.text());
        else updated++;
      } else {
        unchanged++;
      }
    }
  }

  for (const [sourceId, ev] of existingBySource) {
    if (!desired.has(sourceId)) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(PUBLIC_CAL)}/events/${ev.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${saToken}` } }
      );
      if (res.ok || res.status === 410) deleted++;
      else console.error("DELETE FAILED", sourceId, await res.text());
    }
  }

  const stats = { sourceEventsSeen: sourceEvents.length, qualifying: qualifying.length, created, updated, deleted, unchanged };
  console.log("=== sync ===");
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

async function runExport(saToken) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + DAYS_AHEAD * 24 * 3600 * 1000).toISOString();

  const items = await listAllEvents(saToken, PUBLIC_CAL, {
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });

  const byDate = new Map();
  const fmtDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const fmtTime = (d) => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

  for (const e of items) {
    if (!e.start?.dateTime) continue;
    const start = new Date(e.start.dateTime);
    const end = new Date(e.end.dateTime);
    const date = fmtDate(start);
    const studioNum = e.summary.includes("סטודיו 1") ? 1 : e.summary.includes("סטודיו 2") ? 2 : null;
    if (!studioNum) continue;
    if (!byDate.has(date)) byDate.set(date, { studio1: [], studio2: [] });

    if (e.summary.includes("שיעור פתוח")) {
      const label = e.summary.split("·").slice(2).join("·").trim();
      const dash = label.indexOf("-");
      const teacher = dash >= 0 ? label.slice(0, dash).trim() : "";
      const title = dash >= 0 ? label.slice(dash + 1).trim() : label;
      const signup = (e.description || "").trim();
      const entry = { start: fmtTime(start), end: fmtTime(end), public: true, title };
      if (teacher) entry.teacher = teacher;
      if (/^(https?:|tel:)/.test(signup)) entry.signup = signup;
      byDate.get(date)[`studio${studioNum}`].push(entry);
    } else {
      const noisy = e.summary.includes("רועש");
      byDate.get(date)[`studio${studioNum}`].push({
        start: fmtTime(start), end: fmtTime(end), noise: noisy ? "loud" : "quiet",
      });
    }
  }

  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(Date.now() + i * 24 * 3600 * 1000);
    const date = fmtDate(d);
    const entry = byDate.get(date) || { studio1: [], studio2: [] };
    days.push({ date, studio1: entry.studio1, studio2: entry.studio2 });
  }

  console.log("=== export ===");
  console.log(`built availability data: ${days.length} days, ${items.length} events`);
  return { generatedAt: new Date().toISOString(), days };
}

async function publishToIndexHtml(availability) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = new URL("../index.html", import.meta.url);
  const html = readFileSync(path, "utf8");

  const marker = '<script id="availability-data" type="application/json">';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('could not find <script id="availability-data"> in index.html');
  const jsonStart = startIdx + marker.length;
  const endIdx = html.indexOf("</script>", jsonStart);
  if (endIdx === -1) throw new Error("could not find closing </script> for availability-data");

  const newJson = JSON.stringify(availability);
  const newHtml = html.slice(0, jsonStart) + newJson + html.slice(endIdx);

  if (newHtml === html) {
    console.log("=== publish ===");
    console.log("index.html unchanged (availability data identical)");
    return false;
  }

  writeFileSync(path, newHtml);
  console.log("=== publish ===");
  console.log("index.html updated with fresh availability data");
  return true;
}

async function main() {
  const [oauthToken, saToken] = await Promise.all([
    getOAuthToken(),
    getServiceAccountToken("https://www.googleapis.com/auth/calendar"),
  ]);

  await runSync(oauthToken, saToken);

  // re-derive a read-only service-account token for the export step (same
  // token works fine, the calendar scope above already covers read access)
  const availability = await runExport(saToken);
  const changed = await publishToIndexHtml(availability);

  // Signal to the workflow (via GITHUB_OUTPUT) whether a commit is needed.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

main().catch((e) => {
  console.error("PIPELINE ERROR:", e.message);
  process.exit(1);
});
