# Assistant Coach

A sideline sub timer for youth soccer that keeps playing time fair. Purple and gold, after our namesake club, with every text color checked for WCAG AA contrast. It's an offline-first PWA: no build step, no server, and everything is stored on the phone. Finished games sync to a Google Sheet when you're back online.

## What it does

- **Roster once, attendance per game.** Add the team once (or paste a list). Each game day everyone starts absent, and you tap kids in as they arrive. The check-in order is recorded, and the Q1 lineup suggests the first to arrive as starters. You pick the Q1 goalie; later quarters suggest the kids most owed minutes. Names stay on your phone (and your own Google Sheet), never in this repo. If the sheet is linked, the team list is backed up to its **Roster** tab, so a cleared phone or a new home-screen install gets the team back automatically. Try it with **Load demo team** on the roster screen.
- **Halves or quarters.** Pick 2 halves (with an optional water break at halfway) or 4 quarters. The clock keeps running through the water break, and the break is always one of the sub windows, and by default it's a goalie change too (4 goalies a game). The suggested swaps put a new keeper in from the bench (fewest goalie minutes first) and sit the outgoing one. A goalie who finishes a half starts the next one on the bench. Turn it off in setup, or pick a different goalie at the break.
- **Change players per side mid-game.** Menu → Players per side. Going up, it asks who comes on (most owed first); going down, who comes off (most played first).
- **Auto sub plan.** From the players present, field size, and period length, it picks how many to swap and how often. It aims for ~5-minute runs, keeps bench stints under ~4 minutes when the roster allows, and never asks for subs more often than every 2:30. Sub windows divide each period (or each side of the water break) evenly.
- **Sub cues.** A "get ready" chime 20 s before a window, then the scoreboard turns gold with "Sub now" and suggested swaps, each shown as a white **▼ OFF** card next to a green **▲ ON** card, with matching "Off next" / "On next" tags on the player rows: most-played off, least-played on. It never suggests pulling a kid who went on in the last 90 s. They're only suggestions: tap a swap to keep a kid who's on a roll, skip the window, or make any sub by hand. You're the coach.
- **Fair share, not team average.** While a kid is available, they earn an equal slice of field time. Time they weren't there (late arrival, injury, bathroom) earns nothing. So nobody is penalized for missing time, and the app doesn't over-play them to catch up. Every player row shows minutes played and a meter for how far above or below their own fair share they are. Subs and lineups go to whoever is most owed.
- **Goalies.** Exactly one goalie at a time, always. Pick one per quarter. Goalie time counts as playing time. The lineup suggests whoever has kept goal the fewest quarters.
- **Sideline.** Injury, bathroom, or other. On the field, you pick a replacement or play short. With nobody on the bench, you play short, and if it was the goalie, it asks who takes the gloves. While short, the field header says so, and tapping a bench or returning kid offers "fill the empty spot". Fair share follows the actual number on the field, so playing short doesn't leave everyone looking owed.
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
> - Turn the volume up for the chimes. They play even with the silent switch on. Check with **Settings → Test sound** (or Test sound in the in-game menu).

## Google Sheet sync

One command sets it up. It's managed with [clasp](https://github.com/google/clasp) (`npm i -g @google/clasp && clasp login`).

```sh
./scripts/setup-sheet.sh
```

The first run creates a sync key (`apps-script/Secret.gs`, not committed) and a new **Assistant Coach Season Log** sheet in your Drive, then deploys the receiving script. It finishes by printing a **connect link**. Text or AirDrop it to your phone and open it: the app links itself and shows "Connected to …". Re-running the script is safe: it pushes script changes to the same web-app address and prints the link again.

First time only, Google needs you to authorize the script. If the script says so, run `clasp open-script`, choose `setup`, click **Run**, and approve.

Each finished game appends one row per player (date, opponent, minutes, goalie minutes, shifts, fair-share minutes). Re-sends are de-duplicated by game ID. The **Season Totals** tab rolls up minutes per player. In the app, **Settings → Test connection** checks the link at any time.

## Files

| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app (vanilla JS, no build) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline + installable PWA |
| `apps-script/` | Google Sheet receiver (clasp project) |
| `scripts/setup-sheet.sh` | One-command sheet setup + phone connect link |

## Ideas for v2

- Native iOS / watchOS companion for locked-screen and Apple Watch sub alerts
- Position tags (DEF/MID/FWD) for like-for-like swaps
- Jersey numbers; multiple teams
