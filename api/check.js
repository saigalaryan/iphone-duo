// GET /api/check
//   ?dry=1   live check from Vercel (Apple currently blocks Vercel, so this usually fails)
//   ?summary=1 with CRON_SECRET → push a daily status built from the latest saved check
//            (no request to Apple) - used by the Vercel daily cron
import { runCheck, readLog, authorized, notify, summaryText, BUY_URLS, HAS_STORAGE } from "../lib/core.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  res.setHeader("Cache-Control", "no-store");

  if (url.searchParams.get("summary") === "1") {
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const latest = HAS_STORAGE ? (await readLog(1).catch(() => []))[0] : null;
    const text = latest
      ? `Last check ${new Date(latest.t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })} IST\n${summaryText(latest)}`
      : "No saved checks yet - is the iPhone Shortcut automation running?";
    const sent = await notify("iPhone Duo daily status", text, { priority: "low", tags: "calendar", click: BUY_URLS["MK1E4LL/A"] });
    res.status(200).json({ ok: true, sent, latest: latest || null });
    return;
  }

  // Live check from Vercel (not saved, no alerts)
  const entry = await runCheck();
  res.status(entry.ok ? 200 : 502).json(entry);
}
