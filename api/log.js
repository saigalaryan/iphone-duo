// GET /api/log  → saved checks, newest first (read-only, public)
import { readLog, PARTS, BUY_URLS, ZIP, MAX_MILES, HAS_STORAGE } from "../lib/core.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const meta = { parts: PARTS, buyUrls: BUY_URLS, zip: ZIP, maxMiles: MAX_MILES, storage: HAS_STORAGE };
  try {
    // Hide the failed iPhone-Shortcut test runs from setup (before the endpoint fix)
    const entries = (HAS_STORAGE ? await readLog() : []).filter(
      (e) => !(e.source === "iphone" && !e.ok && e.t < "2026-11-24T19:30:00Z")
    );
    res.status(200).json({ ok: true, ...meta, entries });
  } catch (err) {
    res.status(500).json({ ok: false, ...meta, entries: [], error: String(err.message) });
  }
}
