// POST /api/ingest?key=<CRON_SECRET>
// Your iPhone Shortcut fetches Apple's availability JSON (from your own connection,
// like a normal shopper) and posts it here. Vercel parses it, saves it to the
// history log and sends ntfy alerts on changes.
//
// Body: the raw JSON from
//   https://www.apple.com/shop/fulfillment-messages?pl=true&mts.0=regular&mts.1=compact
//     &parts.0=MK1E4LL/A&parts.1=MK1F4LL/A&location=37215
// Optional: ?summary=1 also pushes a status notification.
import { entryFromData, recordAndAlert, authorized } from "../lib/core.js";

async function readJson(req) {
  const b = req.body;
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
  if (typeof b === "string" && b.trim()) return JSON.parse(b);
  if (Buffer.isBuffer(b) && b.length) return JSON.parse(b.toString("utf8"));
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST Apple's JSON to this endpoint" });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized - add ?key=<CRON_SECRET> to the URL" });
    return;
  }

  let data;
  try {
    data = await readJson(req);
  } catch {
    data = null;
  }

  const summary = new URL(req.url, "http://x").searchParams.get("summary") === "1";
  const entry = entryFromData(data, "iphone");
  const result = await recordAndAlert(entry, { summary });

  // Short, readable reply - shows up in the Shortcut when you run it by hand
  const lines = entry.ok
    ? Object.values(entry.items).map((it, i) => `${i ? "Night Sky" : "Star White"}: ${it.pickup.length ? "PICKUP AVAILABLE" : "no pickup"}; ${it.delivery || "no delivery estimate"}`)
    : [`Failed: ${entry.error}`];
  res.status(entry.ok ? 200 : 422).json({ ok: entry.ok, message: lines.join(" | "), saved: result.saved, alertsSent: result.alertsSent });
}
