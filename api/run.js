// GET /api/run  → check Apple, save to the history log, send ntfy alerts on changes.
// Called hourly by the GitHub Action. Needs no secret: without CRON_SECRET it only
// runs if the last saved check is at least MIN_GAP_MIN minutes old (so it can't be spammed).
import { runCheck, readLog, recordAndAlert, authorized, HAS_STORAGE } from "../lib/core.js";

const MIN_GAP_MIN = 10;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const isOwner = Boolean(process.env.CRON_SECRET) && authorized(req);

  if (!isOwner) {
    if (!HAS_STORAGE) {
      res.status(401).json({ ok: false, error: "Connect storage (Upstash Redis) or pass ?key=<CRON_SECRET>" });
      return;
    }
    const last = (await readLog(1).catch(() => []))[0];
    const minsAgo = last ? (Date.now() - new Date(last.t).getTime()) / 60000 : Infinity;
    if (minsAgo < MIN_GAP_MIN) {
      res.status(200).json({ ok: true, skipped: true, reason: `last check ${Math.round(minsAgo)} min ago (limit: one per ${MIN_GAP_MIN} min)` });
      return;
    }
  }

  const entry = await runCheck();
  const result = await recordAndAlert(entry);
  res.status(entry.ok ? 200 : 502).json(result);
}
