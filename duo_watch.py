#!/usr/bin/env python3
"""
iPhone Duo stock watcher - Apple Store (USA)

Watches:  iPhone Duo 256GB, Star White OR Night Sky
          "Connect to any carrier later" (unlocked), full price,
          no trade-in, no AppleCare
Where:    in-store pickup at Apple Stores near ZIP 37215 (Nashville, TN)
          + Apple's online delivery estimate to that ZIP
Alerts:   push notification to your phone via the free "ntfy" app

Only Python 3 standard library - nothing to pip install.

Usage
  python3 duo_watch.py --test          # send a test notification
  python3 duo_watch.py --once          # one check, then exit (for cron / Task Scheduler)
  python3 duo_watch.py                 # keep running, check every 60 min
  python3 duo_watch.py --every 120     # keep running, check every 2 h

It never adds anything to a bag and never buys anything.
"""

import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ----------------------------------------------------------------- settings
PARTS = {
    "MK1E4LL/A": "iPhone Duo 256GB Star White",
    "MK1F4LL/A": "iPhone Duo 256GB Night Sky",
}
BUY_URLS = {
    "MK1E4LL/A": "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked",
    "MK1F4LL/A": "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky-unlocked",
}
ZIP_CODE = "37215"          # Nashville, TN
MAX_MILES = 50              # ignore stores farther than this
NTFY_TOPIC = "iphoneduo_alerts"   # your ntfy topic
CHECK_EVERY_MIN = 60
# ---------------------------------------------------------------------------

ENDPOINT = "https://www.apple.com/shop/fulfillment-messages"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, ".duo_watch_state.json")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def log(msg):
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def clean(text):
    """Strip HTML tags and squeeze whitespace from Apple's quote strings."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(text))
    return re.sub(r"\s+", " ", text).strip()


# ------------------------------------------------------------------ network
def fetch_availability(zip_code):
    params = [("pl", "true"), ("mts.0", "regular"), ("mts.1", "compact"),
              ("location", zip_code)]
    for i, part in enumerate(PARTS):
        params.append((f"parts.{i}", part))
    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": next(iter(BUY_URLS.values())),
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError("Apple returned a non-JSON page (likely rate-limited or blocked)")


def notify(topic, title, message, click_url=None, priority="high"):
    if not topic:
        log("(no NTFY_TOPIC set - notification only printed)\n" + title + "\n" + message)
        return
    headers = {"Title": title.encode("ascii", "ignore").decode(),
               "Priority": priority, "Tags": "iphone"}
    if click_url:
        headers["Click"] = click_url
    req = urllib.request.Request(f"https://ntfy.sh/{urllib.parse.quote(topic)}",
                                 data=message.encode("utf-8"), headers=headers,
                                 method="POST")
    try:
        urllib.request.urlopen(req, timeout=20).read()
        log(f"Notification sent: {title}")
    except Exception as e:  # noqa: BLE001
        log(f"Could not send notification: {e}")


# ------------------------------------------------------------------ parsing
def _content(data):
    return ((data or {}).get("body") or {}).get("content") or {}


def parse_pickup(data, max_miles):
    """Return {part: [store lines where pickup is available]} and store count."""
    found = {p: [] for p in PARTS}
    stores = (_content(data).get("pickupMessage") or {}).get("stores") or []
    for s in stores:
        try:
            dist = float(s.get("storedistance"))
        except (TypeError, ValueError):
            dist = None
        if dist is not None and dist > max_miles:
            continue
        avail = s.get("partsAvailability") or {}
        for part in PARTS:
            info = avail.get(part) or {}
            shown = str(info.get("pickupDisplay") or "").lower()
            quote = (info.get("pickupSearchQuote")
                     or ((info.get("messageTypes") or {}).get("regular") or {}).get("storePickupQuote")
                     or "")
            if shown == "available":
                where = f"{s.get('storeName', '?')} ({s.get('city', '')}, {s.get('state', '')})"
                miles = s.get("storeDistanceWithUnit") or (f"{dist:.0f} mi" if dist is not None else "")
                found[part].append(f"{where} {miles} - {clean(quote) or 'available'}".strip())
    return found, len(stores)


def parse_delivery(data):
    """Return {part: {'buyable': bool, 'quote': str}} for online delivery."""
    out = {}
    dm = _content(data).get("deliveryMessage") or {}
    for part in PARTS:
        node = dm.get(part) or {}
        reg = node.get("regular") or node.get("compact") or {}
        msgs = []
        for key in ("deliveryOptionMessages", "deliveryOptions"):
            for opt in reg.get(key) or []:
                if isinstance(opt, dict):
                    msgs.append(clean(opt.get("displayName") or opt.get("date")))
        for key in ("deliveryOptionsShortMessage", "shippingQuote", "quote"):
            if reg.get(key):
                msgs.append(clean(reg[key]))
        msgs = [m for i, m in enumerate(msgs) if m and m not in msgs[:i]]
        buyable = reg.get("isBuyable")
        if buyable is None:
            buyable = (reg.get("buyability") or {}).get("isBuyable")
        out[part] = {"buyable": bool(buyable), "quote": " | ".join(msgs)}
    return out


# -------------------------------------------------------------------- state
def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except OSError as e:
        log(f"Could not save state: {e}")


# -------------------------------------------------------------------- check
def check_once(args, state):
    data = fetch_availability(args.zip)
    pickup, n_stores = parse_pickup(data, args.max_miles)
    delivery = parse_delivery(data)

    alerts = []
    for part, name in PARTS.items():
        stores_now = sorted(pickup[part])
        stores_before = set(state.get("pickup", {}).get(part, []))
        new_stores = [s for s in stores_now if s not in stores_before]
        ship = delivery.get(part, {})
        ship_before = state.get("delivery", {}).get(part)

        status = f"{name}: pickup at {len(stores_now)} store(s)"
        if ship.get("quote"):
            status += f"; delivery: {ship['quote']}"
        log(status)

        if new_stores:
            alerts.append((part, f"{name} - PICKUP AVAILABLE near {args.zip}",
                           "\n".join(stores_now) +
                           (f"\nDelivery: {ship['quote']}" if ship.get("quote") else "")))
        elif ship.get("quote") and ship_before is not None and ship["quote"] != ship_before:
            alerts.append((part, f"{name} - delivery estimate changed",
                           f"Was: {ship_before}\nNow: {ship['quote']}"))

        state.setdefault("pickup", {})[part] = stores_now
        if ship.get("quote"):
            state.setdefault("delivery", {})[part] = ship["quote"]

    if n_stores == 0:
        log("Warning: Apple returned no stores for this ZIP - response format may have changed.")

    for part, title, msg in alerts:
        notify(args.topic, title, msg + f"\n\nBuy: {BUY_URLS[part]}", BUY_URLS[part])
    if not alerts:
        log("No change - nothing to alert.")


def main():
    ap = argparse.ArgumentParser(description="Watch Apple US stock for iPhone Duo 256GB (unlocked).")
    ap.add_argument("--zip", default=ZIP_CODE)
    ap.add_argument("--max-miles", type=float, default=MAX_MILES)
    ap.add_argument("--topic", default=os.environ.get("NTFY_TOPIC", NTFY_TOPIC),
                    help="ntfy.sh topic to push to (or set NTFY_TOPIC env var)")
    ap.add_argument("--every", type=float, default=CHECK_EVERY_MIN, help="minutes between checks")
    ap.add_argument("--once", action="store_true", help="check once and exit")
    ap.add_argument("--test", action="store_true", help="send a test notification and exit")
    args = ap.parse_args()

    if args.test:
        notify(args.topic, "iPhone Duo watcher is set up",
               f"You'll get alerts for 256GB Star White / Night Sky near {args.zip}.",
               BUY_URLS["MK1E4LL/A"], priority="default")
        return

    state = load_state()
    fails = 0
    while True:
        try:
            check_once(args, state)
            save_state(state)
            fails = 0
        except (urllib.error.URLError, RuntimeError, TimeoutError) as e:
            fails += 1
            log(f"Check failed ({fails} in a row): {e}")
            if fails == 3:
                notify(args.topic, "iPhone Duo watcher: checks failing",
                       f"Last error: {e}. Apple may be rate-limiting; the watcher keeps trying.",
                       priority="default")
        if args.once:
            break
        wait = args.every * 60 * random.uniform(0.9, 1.1)   # small jitter
        log(f"Next check in {wait / 60:.0f} min.")
        time.sleep(wait)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
