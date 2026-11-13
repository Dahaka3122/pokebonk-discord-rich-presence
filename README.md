# PokéBonk Discord Rich Presence

Show what you're doing in browser version of [PokéBonk](https://pokebonk.com) on your Discord profile: your current Pokémon, level, map, zone, difficulty, weather, KO count and run timer. It also shows when you're in the menu, picking a Pokémon, choosing a map, browsing the Pokédex, preparing for an event or setting up a Co-op run.

> **Unofficial fan project.** Not affiliated with or endorsed by the PokéBonk developer, Nintendo, Game Freak or The Pokémon Company. It only *reads* what is already on your screen, it does not modify the game, automate anything or touch your account.

```
Playing PokéBonk
Cyndaquil · Lv. 13 · K.Os 261
Viridian Forest · Zone 1/3 · Normal · Rain
⏱ 03:40 elapsed
```

## What it shows

| Where you are | Line 1 | Line 2 | Icon (hover text) |
|---|---|---|---|
| In a run (Classic, Survival, event) | `Pokémon · Lv. N · K.Os N` | `Map · Zone x/y · Difficulty · Weather` (`Phase x/y` in Survival and events) | Current Pokémon (`Name (Type)`), run timer |
| Run paused | same as above | `Paused · Map · Zone …` | same, **timer hidden** while paused |
| Run over | same as above | `Run ended · Map · Zone …` | same, timer hidden |
| Main menu | `In the main menu` | `Getting ready for a run` | Your partner Pokémon (`League 79/138 · Pokédex 234/251`) |
| Pokémon selection | `Choosing my Pokémon` | `Looking at Bulbasaur · Healer` | The Pokémon you're looking at |
| Map selection | `Choosing a map with Bulbasaur` | `Viridian Forest · Normal · Classic` | Your Pokémon (`Kanto · Viridian Forest`) |
| Pokédex / Research Notebook | `Browsing the Pokédex` | `250/251 seen` or `Research Notebook · 125/129 families` | Last Pokémon you used |
| Event (home or preparation) | `Preparing for The Great Expedition` | `Limited-time event` | Last Pokémon you used |
| Co-op (entry or lobby) | `Setting up a Co-op run` / `Waiting in a Co-op lobby` | `Playing with friends` | Last Pokémon you used |
| Any other menu screen | `Browsing the menus` | `Between runs` | Last Pokémon you used |

Map effects shown next to the weather (curses, Gengar, Rhydon's Roar…) are intentionally ignored, only the weather itself (Rain, Scorching Sun…) is shown.

"Any other menu screen" covers Lab, Builds, Achievements, Tasks, Shop, Treasures, Settings, Apps, News, leaderboards, Friends, Mailbox, Trainer card and Clan. **Nothing is read from these screens**, because several of them show private data (friends, mail, clan, rankings). The Co-op lobby shows neither the room code nor the player names.

The Co-op *in-run* HUD has not been implemented yet.

## How it works

```
pokebonk.com (UI is plain DOM)
   │  content script reads the HUD / current screen
   ▼
Browser extension ──HTTP──▶ Helper (Node.js, 127.0.0.1:8765) ──IPC──▶ Discord desktop app
```

A web page can't talk to Discord directly, so a tiny local helper does it. The helper has **no npm dependencies** and talks to Discord's local IPC socket itself.

## Requirements

- Discord **desktop app** running (the web version has no Rich Presence IPC)
- [Node.js](https://nodejs.org) 18 or newer
- A Chromium-based browser (Chrome, Edge, Brave…). Firefox is untested.

## Installation

### 1. Create a Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Name it **PokéBonk** (this is the "Playing …" text people see).
3. Copy the **Application ID** from *General Information*.

### 2. Start the helper

```bash
cd helper
cp config.example.json config.json     # Windows: copy config.example.json config.json
# edit config.json and paste your Application ID
node server.js
```

You should see `Discord: connected as <your name>`. Instead of `config.json` you can set an environment variable:

```bash
DISCORD_CLIENT_ID=123456789012345678 node server.js      # macOS / Linux
$env:DISCORD_CLIENT_ID="123456789012345678"; node server.js   # PowerShell
```

### 3. Load the extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Open PokéBonk. Your presence should appear within a few seconds.

Keep the helper running while you play. If you reload the extension, refresh the game tab too.

## Configuration

Set these as environment variables or (for the first two) in `helper/config.json`:

| Setting | Default | Meaning |
|---|---|---|
| `DISCORD_CLIENT_ID` / `clientId` | – (required) | Your Discord Application ID |
| `PORT` / `port` | `8765` | Helper port. If you change it, also change `HELPER_URL` in `extension/background.js` and `host_permissions` in `extension/manifest.json` |
| `MIN_UPDATE_MS` | `15000` | Minimum time between presence updates (Discord rate-limits at about one per 15 s) |
| `STALE_MS` | `20000` | Clear the presence after this long without data from the game |

Pokémon images are loaded from the [PokeAPI sprites](https://github.com/PokeAPI/sprites) repository. If you'd rather host your own, change `SPRITE_URL` in `helper/server.js`.

## Customizing

Everything the extension knows comes from `extension/parser.js`, and everything shown in Discord is built in `helper/server.js`. To show something new you touch three places. Example: showing the KO counter (already included):

1. **Read it** – in `parseHud()` (`extension/parser.js`), find the element in DevTools (right-click it → *Inspect*) and read it:
   ```js
   const koEl = doc.querySelector('#hud .counters .counter span');
   const kos = koEl ? txt(koEl) : null;
   ```
   then add `kos` to the returned object.
2. **Let it through** – in `sanitize()` (`helper/server.js`) add `kos: str(raw.kos, 10)`. Anything not listed there is dropped.
3. **Show it** – in `buildActivity()` (`helper/server.js`), e.g. ``detailsParts.push(`K.Os ${state.kos}`)``.

Restart the helper, click the reload icon on the extension in `chrome://extensions`, and refresh the game tab.

### Adding a screen

Screens are recognised by CSS classes (not by text, so it works in every UI language). Every screen the parser doesn't know falls into the generic `Browsing the menus` state, so a new screen only needs work if you want it to say something specific.

1. On that screen, copy the root element's `outerHTML` from DevTools and trim it to the parts you need, then save it as `test/fixtures/<name>.html` (**strip nicknames, clan tags and other players' names**).
2. Add `parseYourScreen(doc)` to `extension/parser.js` returning `{ screen: 'yourscreen', ... }`, call it from `parseState()` *before* the generic `parseOther` check, and export it.
3. Add the new `screen` value to the list in `sanitize()` (plus any new fields) and handle it in `buildActivity()` in `helper/server.js`.
4. Add checks to `test/parser.test.js` and `test/e2e.test.js`.

Pause and "run over" are not screens, they are modals on top of the run HUD, detected in `parseHud()` as `phase: 'paused' | 'ended'`.

If a game update breaks something, it is almost always a renamed CSS class in `parser.js`, the selectors are all in one place.

## Troubleshooting

- **Nothing shows up** – open the helper's `http://127.0.0.1:8765/health`, it should report `"discordReady": true`. If it's `false`, make sure the Discord desktop app is running (not just the browser version) and that activity sharing is enabled in Discord's *Activity Privacy* settings.
- **Helper is fine but no updates arrive** – reload the extension on `chrome://extensions`, then refresh the game tab. Check the service worker's console for errors.
- **No Pokémon image** – Discord loads it from GitHub so it can take a moment, and some Discord clients are slower to render external images.
- **Timer stops or restarts after a pause** – This is expected, the timer is hidden while paused or after the run ends, and restarts from the game clock when you resume.

## Tests

```bash
npm install
npx playwright install chromium     # or set CHROME_PATH to a Chromium / Chrome for Testing binary
npm test
```

- `test/parser.test.js` runs the parser in a real browser against trimmed copies of the game's markup.
- `test/e2e.test.js` loads the extension in Chromium, runs the helper and uses a **fake Discord IPC server** to check the exact activity payloads. It never touches the real game or your Discord.

The end-to-end test needs a Chromium that still supports `--load-extension` (Playwright's Chromium and Chrome for Testing will do, recent branded Chrome builds don't).

## Privacy and security

- The helper listens on `127.0.0.1` only and rejects requests whose `Origin` isn't a browser extension, so websites can't talk to it.
- The only data sent to Discord is what you see in the presence above. No account data, tokens or save files are read.
- The extension only runs on `pokebonk.com`.

## License

[MIT](LICENSE). Pokémon and character names are trademarks of their respective owners.
