// GET /api/log  → saved checks, newest first (read-only, public)
import { readLog, PARTS, BUY_URLS, ZIP, MAX_MILES, HAS_STORAGE } from "../lib/core.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const meta = { parts: PARTS, buyUrls: BUY_URLS, zip: ZIP, maxMiles: MAX_MILES, storage: HAS_STORAGE };
  try {
    const entries = HAS_STORAGE ? await readLog() : [];
    res.status(200).json({ ok: true, ...meta, entries });
  } catch (err) {
    res.status(500).json({ ok: false, ...meta, entries: [], error: String(err.message) });
  }
}
