// Shared logic for the iPhone Duo watcher (Apple Store USA).
// Product: iPhone Duo 256GB, Star White or Night Sky, "Connect to any carrier later"
// (unlocked), full price, no trade-in, no AppleCare.
// Read-only: never adds anything to a bag, never buys anything.

export const PARTS = {
  "MK1E4LL/A": "Star White",
  "MK1F4LL/A": "Night Sky",
};

export const BUY_URLS = {
  "MK1E4LL/A": "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked",
  "MK1F4LL/A": "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky-unlocked",
};

export const ZIP = process.env.ZIP || "37215";
export const MAX_MILES = Number(process.env.MAX_MILES || 50);
export const MAX_LOG = Number(process.env.MAX_LOG || 3000); // ~4 months of hourly checks

const LOG_KEY = "duo-watch:log";
// Works with any prefix the Upstash/Vercel integration picks (KV_, STORAGE_, UPSTASH_REDIS_, ...)
function findRedisEnv() {
  const env = process.env;
  const urlKey =
    ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"].find((k) => env[k]) ||
    Object.keys(env).find((k) => /REST_API_URL$|REDIS_REST_URL$/.test(k) && env[k]);
  if (!urlKey) return ["", ""];
  const tokenKey = urlKey.replace(/URL$/, "TOKEN");
  return [env[urlKey] || "", env[tokenKey] || ""];
}
const [REDIS_URL, REDIS_TOKEN] = findRedisEnv();
export const HAS_STORAGE = Boolean(REDIS_URL && REDIS_TOKEN);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function clean(text) {
  if (!text) return "";
  return String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ Apple
export async function fetchAvailability(zip = ZIP) {
  const params = new URLSearchParams({ pl: "true", "mts.0": "regular", "mts.1": "compact", location: zip });
  Object.keys(PARTS).forEach((p, i) => params.append(`parts.${i}`, p));
  const res = await fetch(`https://www.apple.com/shop/fulfillment-messages?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: BUY_URLS["MK1E4LL/A"],
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Apple responded HTTP ${res.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Apple returned a non-JSON page (rate-limited or blocked)");
  }
}

const content = (data) => data?.body?.content || {};

export function parsePickup(data, maxMiles = MAX_MILES) {
  const found = Object.fromEntries(Object.keys(PARTS).map((p) => [p, []]));
  const stores = content(data).pickupMessage?.stores || [];
  for (const s of stores) {
    const dist = Number.parseFloat(s.storedistance);
    if (Number.isFinite(dist) && dist > maxMiles) continue;
    const avail = s.partsAvailability || {};
    for (const part of Object.keys(PARTS)) {
      const info = avail[part] || {};
      if (String(info.pickupDisplay || "").toLowerCase() !== "available") continue;
      const quote = clean(info.pickupSearchQuote || info.messageTypes?.regular?.storePickupQuote) || "available";
      const miles = s.storeDistanceWithUnit || (Number.isFinite(dist) ? `${Math.round(dist)} mi` : "");
      found[part].push(`${s.storeName || "?"} (${s.city || ""}, ${s.state || ""}) ${miles} – ${quote}`.trim());
    }
  }
  return { found, storeCount: stores.length };
}

export function parseDelivery(data) {
  const out = {};
  const dm = content(data).deliveryMessage || {};
  for (const part of Object.keys(PARTS)) {
    const reg = (dm[part] || {}).regular || (dm[part] || {}).compact || {};
    const msgs = [];
    for (const key of ["deliveryOptionMessages", "deliveryOptions"]) {
      for (const opt of reg[key] || []) {
        if (opt && typeof opt === "object") msgs.push(clean(opt.displayName || opt.date));
      }
    }
    for (const key of ["deliveryOptionsShortMessage", "shippingQuote", "quote"]) {
      if (reg[key]) msgs.push(clean(reg[key]));
    }
    out[part] = {
      buyable: Boolean(reg.isBuyable ?? reg.buyability?.isBuyable ?? false),
      quote: [...new Set(msgs.filter(Boolean))].join(" | ") || null,
    };
  }
  return out;
}

// Apple's JSON → one log entry
export function entryFromData(data, source = "vercel") {
  const t = new Date().toISOString();
  if (!data?.body?.content) {
    return { t, source, ok: false, error: "Not Apple availability data (blocked or wrong URL?)" };
  }
  const { found, storeCount } = parsePickup(data);
  const delivery = parseDelivery(data);
  const items = {};
  for (const part of Object.keys(PARTS)) {
    items[part] = { pickup: [...found[part]].sort(), delivery: delivery[part].quote, buyable: delivery[part].buyable };
  }
  return { t, source, ok: true, stores: storeCount, items };
}

// One check from Vercel itself → one log entry
export async function runCheck() {
  const t = new Date().toISOString();
  try {
    const data = await fetchAvailability();
    const { found, storeCount } = parsePickup(data);
    const delivery = parseDelivery(data);
    const items = {};
    for (const part of Object.keys(PARTS)) {
      items[part] = {
        pickup: [...found[part]].sort(),
        delivery: delivery[part].quote,
        buyable: delivery[part].buyable,
      };
    }
    return { t, ok: true, stores: storeCount, items };
  } catch (err) {
    return { t, ok: false, error: String(err?.message || err) };
  }
}

// ------------------------------------------------------------------ storage
async function redis(command) {
  if (!HAS_STORAGE) throw new Error("No storage configured (add Upstash Redis in Vercel)");
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  return (await res.json()).result;
}

export async function appendLog(entry) {
  await redis(["LPUSH", LOG_KEY, JSON.stringify(entry)]);
  await redis(["LTRIM", LOG_KEY, "0", String(MAX_LOG - 1)]);
}

export async function readLog(limit = MAX_LOG) {
  const rows = (await redis(["LRANGE", LOG_KEY, "0", String(limit - 1)])) || [];
  return rows
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean); // newest first
}

// ------------------------------------------------------------------ alerts (ntfy)
export const NTFY_TOPIC = process.env.NTFY_TOPIC || "iphoneduo_alerts";
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");

export async function notify(title, message, { click, priority = "high", tags = "iphone" } = {}) {
  if (!NTFY_TOPIC) return false;
  const headers = { Title: title.replace(/[^\x20-\x7E]/g, ""), Priority: priority, Tags: tags };
  if (click) headers.Click = click;
  try {
    const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      body: message,
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Decide which alerts a new check deserves, compared with the previous saved check.
export function alertsFor(entry, prev, recentFails) {
  const alerts = [];
  if (!entry.ok) {
    if (recentFails === 3) {
      alerts.push({ title: "iPhone Duo watcher: checks failing", body: `${entry.error}\nFailed 3 times in a row.`, priority: "default", tags: "warning" });
    }
    return alerts;
  }
  for (const [part, name] of Object.entries(PARTS)) {
    const it = entry.items[part];
    const before = prev?.ok ? prev.items?.[part] : null;
    const newStores = it.pickup.filter((s) => !(before?.pickup || []).includes(s));
    const stateless = !HAS_STORAGE;
    if (stateless ? it.pickup.length > 0 : newStores.length > 0) {
      alerts.push({
        part,
        title: `iPhone Duo ${name} - PICKUP AVAILABLE`,
        body: it.pickup.join("\n") + (it.delivery ? `\nDelivery: ${it.delivery}` : ""),
      });
    } else if (before?.delivery && it.delivery && it.delivery !== before.delivery) {
      alerts.push({ part, title: `iPhone Duo ${name} - delivery estimate changed`, body: `Was: ${before.delivery}\nNow: ${it.delivery}` });
    }
  }
  return alerts;
}

export async function sendAlerts(alerts) {
  const sent = [];
  for (const a of alerts) {
    const click = a.part ? BUY_URLS[a.part] : undefined;
    const ok = await notify(a.title, a.body + (click ? `\n\nBuy: ${click}` : ""), { click, priority: a.priority, tags: a.tags });
    if (ok) sent.push(a.title);
  }
  return sent;
}

export function summaryText(entry) {
  if (!entry.ok) return `Last check failed: ${entry.error}`;
  return Object.entries(PARTS)
    .map(([p, name]) => `${name}: pickup ${entry.items[p].pickup.length ? "YES" : "no"}; delivery: ${entry.items[p].delivery || "n/a"}`)
    .join("\n");
}

// Save an entry, send alerts on changes, optional daily summary. Used by /api/check and /api/ingest.
export async function recordAndAlert(entry, { summary = false } = {}) {
  let recent = [];
  let storageError;
  if (HAS_STORAGE) {
    try { recent = await readLog(5); } catch (err) { storageError = String(err.message); }
  }
  const prev = recent.find((e) => e.ok) || null;
  let fails = 0;
  if (!entry.ok) { fails = 1; for (const e of recent) { if (e.ok) break; fails++; } }

  const sent = await sendAlerts(alertsFor(entry, prev, fails));
  if (summary && sent.length === 0) {
    if (await notify("iPhone Duo daily status", summaryText(entry), { priority: "low", tags: "calendar", click: BUY_URLS["MK1E4LL/A"] })) sent.push("daily status");
  }

  // No storage → keep history in the ntfy app: every check posted silently with its time.
  if (!HAS_STORAGE && process.env.SILENT_LOG !== "0") {
    const stamp = new Date(entry.t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
    const anyPickup = entry.ok && Object.values(entry.items).some((it) => it.pickup.length > 0);
    await notify(`Check ${stamp} IST - ${!entry.ok ? "failed" : anyPickup ? "AVAILABLE" : "not available"}`, summaryText(entry), {
      priority: "min", tags: !entry.ok ? "warning" : anyPickup ? "green_circle" : "red_circle", click: BUY_URLS["MK1E4LL/A"],
    });
  }

  let saved = false;
  if (HAS_STORAGE) {
    try { await appendLog({ ...entry, alerts: sent.length ? sent : undefined }); saved = true; } catch (err) { storageError = String(err.message); }
  }
  return { ...entry, alertsSent: sent, saved, storage: HAS_STORAGE, storageError };
}

export function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true;
  const url = new URL(req.url, "http://x");
  return req.headers?.authorization === `Bearer ${secret}` || url.searchParams.get("key") === secret;
}
