// GET /api/check
//   (with CRON_SECRET)  run a check, save it to the log, push alerts to your phone
//   ?summary=1          also push a daily status even if nothing changed
//   ?dry=1              live check only: not saved, no alerts (used by "Check now")
import {
  runCheck, appendLog, readLog, authorized, HAS_STORAGE,
  alertsFor, sendAlerts, notify, summaryText, BUY_URLS,
} from "../lib/core.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const dry = url.searchParams.get("dry") === "1";
  const summary = url.searchParams.get("summary") === "1";
  res.setHeader("Cache-Control", "no-store");

  if (!dry && !authorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const entry = await runCheck();
  if (dry) {
    res.status(entry.ok ? 200 : 502).json(entry);
    return;
  }

  // Previous checks, to only alert on changes
  let recent = [];
  let storageError;
  if (HAS_STORAGE) {
    try {
      recent = await readLog(5);
    } catch (err) {
      storageError = String(err.message);
    }
  }
  const prev = recent.find((e) => e.ok) || null;
  let fails = 0;
  if (!entry.ok) {
    fails = 1;
    for (const e of recent) {
      if (e.ok) break;
      fails++;
    }
  }

  const sent = await sendAlerts(alertsFor(entry, prev, fails));
  if (summary && sent.length === 0) {
    if (await notify("iPhone Duo daily status", summaryText(entry), { priority: "low", tags: "calendar", click: BUY_URLS["MK1E4LL/A"] })) {
      sent.push("daily status");
    }
  }

  let saved = false;
  if (HAS_STORAGE) {
    try {
      await appendLog({ ...entry, alerts: sent.length ? sent : undefined });
      saved = true;
    } catch (err) {
      storageError = String(err.message);
    }
  }

  res.status(entry.ok ? 200 : 502).json({ ...entry, alertsSent: sent, saved, storage: HAS_STORAGE, storageError });
}
