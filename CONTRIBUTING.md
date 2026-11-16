# Contributing

Thanks for wanting to improve the PokéBonk Discord Rich Presence! This is a small hobby project, so the process is deliberately simple. Bug reports, fixes after a game update, new screens and ideas are all welcome.

> This is an unofficial fan project. Please keep it that way: it only *reads* what is already on screen and never modifies the game, automates actions or touches accounts.

## Ways to help

- **Report a bug.** Something doesn't show up, shows the wrong text, or stopped working after a game update.
- **Fix a broken selector.** The most common change by far: the game renames a CSS class and the parser stops reading something. The fix is usually one line in `extension/parser.js`.
- **Add a screen or a field.** For example a new menu screen, or another value in the in-run presence. See [Customizing](README.md#customizing) in the README for the three places to touch.
- **Share markup for something not covered yet.** The Co-op in-run HUD is the main gap (it needs two or more players to capture).
- **Improve the docs**, translations of the README included.

If you're unsure whether an idea fits, open an issue first and describe it in a couple of sentences.

## Reporting a bug

A good report saves a lot of back and forth. Please include:

1. What you expected and what you saw (a screenshot of the Discord card helps).
2. Which screen or mode you were in (Classic, Survival, event, menu, pause…).
3. The helper's console output (the `Presence: …` lines) and any error from the extension's service worker (`chrome://extensions` → *Inspect views*).
4. If a screen isn't recognised: the `outerHTML` of that screen, copied from DevTools (see the privacy note below before you paste it).

## Setup

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Dahaka3122/pokebonk-discord-presence.git
cd pokebonk-discord-presence
npm install
npx playwright install chromium     # or set CHROME_PATH to a Chromium / Chrome for Testing binary
npm test
```

To try your changes in the real game, follow the [installation steps](README.md#installation) in the README. After editing the extension, click the reload icon on `chrome://extensions` and refresh the game tab; after editing `helper/server.js`, restart the helper.

## Project layout

| Path | What it does |
|---|---|
| `extension/parser.js` | Reads the game's DOM and returns a plain state object. All selectors live here. |
| `extension/content.js`, `background.js` | Watch the page and forward the state to the helper. Rarely need changes. |
| `helper/server.js` | Receives the state, validates it (`sanitize`) and builds the Discord activity (`buildActivity`). |
| `test/fixtures/` | Trimmed copies of the game's real markup used by the tests. |
| `test/parser.test.js` | Runs the parser against the fixtures in a real browser. |
| `test/e2e.test.js` | Runs the extension and helper against a fake Discord and checks the exact payloads. |

## Making a change

1. **Fork** the repo and create a branch (`git checkout -b fix-zone-label`).
2. **Make the change.** Keep it focused: one fix or feature per pull request.
3. **Add or update a test.** A parser change needs a fixture and a check in `test/parser.test.js`; a change to what is shown in Discord needs a check in `test/e2e.test.js`.
4. **Run `npm test`** and make sure both suites pass.
5. **Update the README** if you changed what is shown or how to configure it (the table under [What it shows](README.md#what-it-shows) is the one to keep current).
6. **Open a pull request** and say what changed and why. A screenshot of the new presence is welcome.

Code style is simple: plain JavaScript, no build step, no runtime dependencies (the helper must stay dependency-free), comments in English, and selectors matched by CSS class rather than visible text so it works in every UI language.

## Building the .exe and releasing

The Windows executable is the helper packaged with Node.js into a single file ([Node single executable applications](https://nodejs.org/api/single-executable-applications.html)). It is built by `scripts/build-exe.js`:

```bash
npm install
node scripts/build-exe.js              # -> dist/pokebonk-presence-helper(.exe), for the OS you run it on
```

Set `DISCORD_CLIENT_ID` first if you want a default Application ID embedded, so end users need no `config.json`. `--blob-only` stops before the final step, which is useful for debugging. You need Node.js 20.12 or newer to build.

**Custom icon:** put a multi-size Windows icon at `assets/icon.ico` (include at least 16, 32, 48 and 256 px) and the build applies it to the `.exe` instead of the default Node.js hexagon. This works only when building on Windows (the GitHub workflow does), and the icon must be something you have the right to use. Without the file the default icon stays.

**Maintainers** publish a release by pushing a tag; `.github/workflows/release.yml` then builds on Windows, smoke-tests the `.exe` (it must answer on `/health`), and attaches the `.exe`, a zip of the extension and `SHA256SUMS.txt` to a GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

To embed a default Application ID, add a repository **variable** named `DISCORD_CLIENT_ID` (*Settings → Secrets and variables → Actions → Variables*). The ID is public, so a variable (not a secret) is fine. You can also run the workflow by hand from the *Actions* tab; that only uploads the files as a workflow artifact and creates no release.

## Privacy rules (please read)

The presence is shown on people's public Discord profiles, and the fixtures live in a public repo, so a few rules matter more than usual:

- **Fixtures must be anonymised.** Copy only the elements the parser reads, and replace nicknames, clan tags, room codes, friends and other players' names with obviously fake ones (`FakePlayerOne`). Never commit a full page dump.
- **Don't read private screens.** Friends, Mailbox, Trainer card, Clan, leaderboards and the Co-op room code are intentionally not parsed. Don't add them to the presence.
- **Send only what you show.** If a new field isn't displayed in Discord, it doesn't belong in the state either. Anything new must also be listed in `sanitize()` in `helper/server.js`, which drops unknown fields.
- **Keep the helper local.** It listens on `127.0.0.1` only and rejects requests from websites; please don't loosen that.

## Questions and behaviour

Be kind and constructive: we're all here because we like the game. Questions are welcome in issues.

## License

By contributing you agree that your contribution is licensed under the project's [MIT license](LICENSE).
