# Assistant Coach

A sideline sub timer for youth soccer that keeps playing time fair. It's an offline-first PWA: no build step, no server, and everything is stored on the phone. Finished games sync to a Google Sheet when you're back online.

## What it does

- **Roster once, attendance per game.** Add the team once (or paste a list), then tap who showed up. Names stay on your phone (and your own Google Sheet), never in this repo. Try it with **Load demo team** on the roster screen.
- **Auto sub plan.** From the players present, field size, and quarter length, it picks how many to swap and how often. It aims for ~5-minute runs, keeps bench stints under ~4 minutes when the roster allows, and never asks for subs more often than every 2:30. Sub windows divide each quarter evenly.
- **Sub cues.** A "get ready" chime 20 s before a window, then the scoreboard turns orange with "Sub now" and the exact swaps: most-played off, least-played on. It never pulls a kid who went on in the last 90 s.
- **Fair share, not team average.** While a kid is available, they earn an equal slice of field time. Time they weren't there (late arrival, injury, bathroom) earns nothing. So nobody is penalized for missing time, and the app doesn't over-play them to catch up. Every player row shows minutes played and a meter for how far above or below their own fair share they are. Subs and lineups go to whoever is most owed.
- **Goalies.** Pick a goalie per quarter. Goalie time counts as playing time. The lineup suggests whoever has kept goal the fewest quarters.
- **Sideline.** Injury, bathroom, or other. On the field, you pick a replacement (or play short). "Back on the bench" returns them.
- **Late arrivals, undo, quarter-break lineups** (fewest minutes start), and a post-game summary.
- **Keeps the screen awake** during a game ([NoSleep.js](https://github.com/richtr/NoSleep.js): Wake Lock, with a silent-video fallback for older iOS). A chip under the clock shows "Screen stays on" or "Screen may sleep · tap to keep on". The clock is timestamp-based, so it stays correct even if the phone does sleep.

## Run locally

```sh
python3 -m http.server 5173
# open http://localhost:5173
```

## Install on iPhone

Host it anywhere with HTTPS (GitHub Pages, Vercel, Netlify). Open it in Safari, tap Share, then **Add to Home Screen**. After the first load it works fully offline.

> **Game-day iPhone tips.** Web apps can't alert you while the phone is locked, so keep the app on screen.
> - **Turn off Low Power Mode.** It forces Auto-Lock to 30 seconds.
> - **Guided Access** (Settings → Accessibility → Guided Access, set *Display Auto-Lock: Never*) pins the phone to the app. Triple-click the side button to start or stop it. It also blocks pocket taps and kids swiping away.
> - Turn the volume up for the chimes. They play even with the silent switch on (iOS 17+).

## Google Sheet sync

The receiver is in `apps-script/` and is managed with [clasp](https://github.com/google/clasp).

1. `apps-script/Secret.gs` holds `SYNC_KEY` (not committed; copy `Secret.gs.example` to make one).
2. `clasp push && clasp create-deployment` deploys it as a web app.
3. **First time only:** open the script (`clasp open-script`), choose `setup`, click **Run**, and approve access. This creates the `Minutes` and `Season Totals` tabs.
4. In the app, open **Settings** and paste `https://script.google.com/macros/s/<deployment-id>/exec?key=<SYNC_KEY>`.

Each finished game appends one row per player (date, opponent, minutes, goalie minutes, shifts). Re-sends are de-duplicated by game ID. `Season Totals` rolls up minutes per player across the season.

## Files

| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app (vanilla JS, no build) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline + installable PWA |
| `apps-script/` | Google Sheet receiver (clasp project) |

## Ideas for v2

- Native iOS / watchOS companion for locked-screen and Apple Watch sub alerts
- Position tags (DEF/MID/FWD) for like-for-like swaps
- Jersey numbers; multiple teams
