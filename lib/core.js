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
// Apple retired /shop/fulfillment-messages (HTTP 541). The buy page now uses
// /shop/retail/pickup-message, which returns nearby stores + per-part pickup status.
export const PICKUP_URL = (zip = ZIP) => {
  const params = new URLSearchParams({ pl: "true", location: zip });
  Object.keys(PARTS).forEach((p, i) => params.append(`parts.${i}`, p));
  return `https://www.apple.com/shop/retail/pickup-message?${params}`;
};

export const DELIVERY_URL = (zip = ZIP) => {
  const params = new URLSearchParams({ "mts.0": "regular", postalCode: zip });
  Object.keys(PARTS).forEach((p, i) => params.append(`parts.${i}`, p));
  return `https://www.apple.com/shop/delivery-message?${params}`;
};

async function getJson(url) {
  const res = await fetch(url, {
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
    throw new Error("Apple returned a non-JSON page");
  }
}

// Pickup (stores near ZIP) + online delivery dates (to ZIP), fetched together
export async function fetchAvailability(zip = ZIP) {
  const [pickup, delivery] = await Promise.allSettled([getJson(PICKUP_URL(zip)), getJson(DELIVERY_URL(zip))]);
  if (pickup.status === "rejected") throw pickup.reason;
  return { pickup: pickup.value, delivery: delivery.status === "fulfilled" ? delivery.value : null };
}

const content = (data) => data?.body?.content || {};

export function parsePickup(data, maxMiles = MAX_MILES) {
  const found = Object.fromEntries(Object.keys(PARTS).map((p) => [p, []]));
  const stores = data?.body?.stores || content(data).pickupMessage?.stores || [];
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
    const msgs = (reg.deliveryOptionMessages || []).map((o) => clean(o?.displayName)).filter(Boolean);
    if (!msgs.length) for (const o of reg.deliveryOptions || []) if (o?.date) msgs.push(clean(`${o.date}${o.shippingCost ? ` — ${o.shippingCost}` : ""}`));
    const upper = (reg.deliveryOptionMessages || []).map((o) => o?.encodedUpperDateString).filter(Boolean).sort()[0] || null;
    out[part] = {
      buyable: Boolean(reg.isBuyable ?? reg.buyability?.isBuyable ?? false),
      quote: [...new Set(msgs)].join(" | ") || null,
      latestBy: upper, // YYYYMMDD - latest date in Apple's delivery window
    };
  }
  return out;
}

// Apple's JSON → one log entry. Accepts { pickup, delivery } or a single response.
export function entryFromData(input, source = "vercel") {
  const t = new Date().toISOString();
  const pickupData = input?.pickup !== undefined ? input.pickup : input;
  const deliveryData = input?.pickup !== undefined ? input.delivery : input;
  if (!pickupData?.body?.stores && !pickupData?.body?.content) {
    return { t, source, ok: false, error: "Not Apple availability data (blocked or wrong URL?)" };
  }
  const { found, storeCount } = parsePickup(pickupData);
  const delivery = parseDelivery(deliveryData);
  const items = {};
  for (const part of Object.keys(PARTS)) {
    items[part] = {
      pickup: [...found[part]].sort(),
      delivery: delivery[part].quote,
      deliveryBy: delivery[part].latestBy,
      buyable: delivery[part].buyable,
    };
  }
  return { t, source, ok: true, stores: storeCount, items };
}

// One check from Vercel itself → one log entry
export async function runCheck() {
  try {
    return entryFromData(await fetchAvailability(), "vercel");
  } catch (err) {
    return { t: new Date().toISOString(), source: "vercel", ok: false, error: String(err?.message || err) };
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
      const dir = it.deliveryBy && before.deliveryBy ? (it.deliveryBy < before.deliveryBy ? "EARLIER" : it.deliveryBy > before.deliveryBy ? "later" : "changed") : "changed";
      alerts.push({
        part,
        title: `iPhone Duo ${name} - delivery ${dir === "changed" ? "changed" : `now ${dir}`}`,
        body: `Now: ${it.delivery}\nWas: ${before.delivery}`,
        priority: dir === "later" ? "default" : "high",
      });
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
    .map(([p, name]) => {
      const it = entry.items[p];
      return `${name}: ${it.pickup.length ? `PICKUP at ${it.pickup.map((s) => s.split(" (")[0]).join(", ")}` : "no pickup"}${it.delivery ? `; delivery: ${it.delivery}` : ""}`;
    })
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

// ------------------------------------------------------------------ scheduler (Upstash QStash)
// If QStash is connected in Vercel (QSTASH_TOKEN env var), make sure a schedule exists
// that calls /api/run every 10 minutes. Runs once, then remembers it in Redis.
const SCHEDULE_FLAG = "duo-watch:qstash-schedule";
export const RUN_URL = process.env.RUN_URL || "https://iphone-duo-virid.vercel.app/api/run";

export async function ensureSchedule() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return "not connected (add Upstash QStash in Vercel)";
  if (HAS_STORAGE) {
    const flag = await redis(["GET", SCHEDULE_FLAG]).catch(() => null);
    if (flag) return `active (${flag})`;
  }
  const base = (process.env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const list = await (await fetch(`${base}/v2/schedules`, { headers: auth })).json();
    const existing = Array.isArray(list) && list.find((x) => x.destination === RUN_URL);
    let id = existing?.scheduleId;
    if (!id) {
      const res = await fetch(`${base}/v2/schedules/${RUN_URL}`, {
        method: "POST",
        headers: { ...auth, "Upstash-Cron": "*/10 * * * *", "Upstash-Method": "GET", "Upstash-Retries": "0" },
      });
      if (!res.ok) return `error creating schedule: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`;
      id = (await res.json()).scheduleId;
    }
    if (HAS_STORAGE) await redis(["SET", SCHEDULE_FLAG, `every 10 min, ${id}`]);
    return `active (every 10 min, ${id})`;
  } catch (err) {
    return `error: ${String(err.message || err)}`;
  }
}

export function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true;
  const url = new URL(req.url, "http://x");
  return req.headers?.authorization === `Bearer ${secret}` || url.searchParams.get("key") === secret;
}
