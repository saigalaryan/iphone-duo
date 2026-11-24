# iPhone Duo Watch

Watches Apple Store USA (in-store pickup near the ZIP **and** online delivery dates to it) for **iPhone Duo 256GB, Star White or Night Sky, "Connect to any carrier later" (unlocked), full price, no trade-in, no AppleCare**, near **ZIP 37215** (Nashville, TN).

- **Phone alerts (ntfy topic `iphoneduo_alerts`):** sent when either colour becomes available for pickup within 50 miles, when Apple's delivery estimate changes, if checks fail 3 times in a row, plus a daily status at 8:00 PM IST.
- **Status page:** a timestamped history of every check (IST and Nashville time), the exact windows when each colour was available and for how long, and every delivery-estimate change.

It never adds anything to a bag and never buys anything.

```
GitHub Actions (hourly) ─┐                        ┌─▶ Upstash Redis (history log)
Vercel Cron (daily)    ──┴─▶  /api/check  ────────┼─▶ ntfy ─▶ your phone
                                   │              │
                         Apple availability lookup
Status page  ─▶ /api/log (history) + /api/check?dry=1 (live, not saved)
```

## Setup (about 10 minutes)

1. **Phone:** you're already subscribed to `iphoneduo_alerts` in ntfy. Anyone who guesses that name can read the alerts. To change it, set `NTFY_TOPIC` on Vercel and subscribe to the new name.
2. **Deploy:** push this folder to GitHub → import it in Vercel (Framework preset: **Other**, no build command).
3. **Env var:** Vercel → Settings → Environment Variables → add `CRON_SECRET` = any long random string.
4. **Storage (optional):** without it, every check is posted silently to your ntfy app with its timestamp, so the ntfy app is your history. With it, the status page also shows the full history.
   To add it: Vercel → **Storage** → add **Upstash Redis** (free) → connect it to this project. The env vars are picked up automatically. **Redeploy** afterwards.
5. **Hourly checks:** Vercel's free plan only allows a daily cron, so the included GitHub Action runs the check every hour. In the GitHub repo → Settings → Secrets and variables → Actions → add:
   - `APP_URL`: your Vercel URL, e.g. `https://duo-watch-xyz.vercel.app` (no trailing slash)
   - `CRON_SECRET`: the same value as on Vercel

## Test
- Open your Vercel URL → **Check now**. This shows the live result and doesn't save it or send an alert.
- Open `https://<your-app>.vercel.app/api/check?summary=1&key=<CRON_SECRET>`. This saves a check and pushes a status to your phone.
- GitHub → Actions → "Hourly iPhone Duo check" → **Run workflow** runs one check on demand.

## Optional env vars
`ZIP` (default 37215), `MAX_MILES` (default 50), `NTFY_TOPIC` (default iphoneduo_alerts), `MAX_LOG` (checks kept, default 3000 ≈ 4 months hourly).

## If Apple blocks Vercel
Apple sometimes blocks cloud servers. If "Check now" shows HTTP 403/541 or "non-JSON page", run `duo_watch.py` (Python, no installs) on your own laptop instead: `python3 duo_watch.py`. It uses the same ntfy topic.

## Endpoints
- `GET /api/check`: auth `Authorization: Bearer <CRON_SECRET>` or `?key=`. Saves a check and sends alerts. `?summary=1` also pushes a status. `?dry=1` is a live check with no auth, no save and no alert.
- `GET /api/log`: saved checks, newest first.

Part numbers: Star White `MK1E4LL/A`, Night Sky `MK1F4LL/A` (US, unlocked, 256GB).
