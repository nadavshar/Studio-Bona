// Fetches Faya.Fam's public class schedule directly from Arbox's REST API
// (no browser/Playwright needed - a plain POST with a fixed set of
// app-identification headers is enough; this was confirmed by capturing a
// real browser request to this same endpoint and replaying it headlessly).
//
// Faya's booking site is a separate Arbox "box" (id 24145, slug rmzsovuz)
// that studio-bona.com does not control - this script just reads their
// public group-schedule feed, the same one shown at
// https://rmzsovuz.web.arboxapp.com/group?location=21821
//
// Writes data/faya-schedule.json. The workflow that calls this script is
// responsible for git-committing it if it changed.

const API_URL = "https://apiappv2.arboxapp.com/api/v2/site/schedule/betweenDates";
const LOCATIONS_BOX_ID = 21821;
const DAYS_AHEAD = 21;
const CHUNK_DAYS = 7; // mirrors the real site's own request pattern

export const FAYA_SIGNUP_URL =
  "https://rmzsovuz.web.arboxapp.com/group?whitelabel=Arbox&lang=he&location=21821&referrer=SITE&utm_source=ig&utm_medium=social&utm_content=link_in_bio&allLocations=false";

// Static headers the Arbox web app sends on every request to this endpoint.
// accesstoken/refreshtoken are sent as the literal string "[object Object]"
// by Arbox's own frontend (an anonymous/public session) - that exact string
// is what the API expects for unauthenticated group-schedule reads.
function headers() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "whitelabel": "Arbox",
    "identifier": "RMzSOVuz",
    "boxfk": "24145",
    "newsite": "1",
    "referername": "site",
    "version": "10",
    "lang": "he",
    "kiosk": "false",
    "accesstoken": "[object Object]",
    "refreshtoken": "[object Object]",
    "Referer": "https://rmzsovuz.web.arboxapp.com/",
    "Origin": "https://rmzsovuz.web.arboxapp.com",
  };
}

function isoDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function fetchChunk(from, to) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ from, to, locations_box_id: LOCATIONS_BOX_ID }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Arbox betweenDates failed (${from}..${to}): ${JSON.stringify(data)}`);
  return data.data || [];
}

export async function fetchFayaSchedule() {
  const today = new Date();
  const classesById = new Map();

  for (let offset = 0; offset < DAYS_AHEAD; offset += CHUNK_DAYS) {
    const from = isoDate(new Date(today.getTime() + offset * 86400000));
    const to = isoDate(new Date(today.getTime() + (offset + CHUNK_DAYS - 1) * 86400000));
    const chunk = await fetchChunk(from, to);
    for (const ev of chunk) {
      if (ev.status !== "active" || ev.past) continue;
      const coachName = [ev.coach?.first_name, ev.coach?.last_name].filter(Boolean).join(" ");
      classesById.set(ev.id, {
        date: ev.date,
        time: ev.time,
        end_time: ev.end_time,
        title: ev.box_categories?.name || "",
        coach: coachName,
        free: ev.free,
        registered: ev.registered,
        max_users: ev.max_users,
      });
    }
  }

  const classes = [...classesById.values()].sort((a, b) =>
    a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)
  );

  return { generatedAt: new Date().toISOString(), signupUrl: FAYA_SIGNUP_URL, classes };
}

async function writeFayaScheduleFile() {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dataUrl = new URL("../data/", import.meta.url);
  mkdirSync(dataUrl, { recursive: true });
  const schedule = await fetchFayaSchedule();
  writeFileSync(new URL("faya-schedule.json", dataUrl), JSON.stringify(schedule, null, 2));
  console.log("=== faya schedule ===");
  console.log(`wrote ${schedule.classes.length} classes to data/faya-schedule.json`);
  return schedule;
}

// Allow running standalone (node scripts/fetch-faya-schedule.mjs) as well as
// being imported from sync-and-publish.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  writeFayaScheduleFile().catch((e) => {
    console.error("FAYA FETCH ERROR:", e.message);
    process.exit(1);
  });
}

export { writeFayaScheduleFile };
