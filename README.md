# NUKETOWN — Vercel build

A browser first-person shooter (5v5 Team Deathmatch and one-life Round Control on a 1962
Nevada test site) that used to only run from a Windows folder via `PLAY.bat`. This repo now
also carries a **static web build that deploys to Vercel as-is** — no server, no install for
the player, no runtime, nothing to log into.

```
public/                 ← what Vercel serves. A complete, self-contained static site.
src/                    ← the game's web source (index.html + js/ + the assets it uses)
scripts/                ← the build: bundler, asset optimiser, local server, verifier
Call of Duty Build/     ← the original offline Windows build, untouched (PLAY.bat still works)
vercel.json             ← deploy config: static output + cache headers
```

## Deploy it

**From GitHub (the usual path)**

1. Push this branch to GitHub, then in Vercel: **Add New → Project → Import** the repo.
2. Vercel reads `vercel.json` and there is nothing to configure — framework *Other*, no
   install, no bundling, output directory `public`. Hit **Deploy**.
3. ~20 seconds later you have a `https://…vercel.app` URL that anyone can open and play.

**From the CLI**

```bash
npm i -g vercel
vercel --prod          # from the repo root
```

**Want Vercel to rebuild from `src/` on every push instead?** Set the env var
`BUILD_ON_VERCEL=1` and change `installCommand` in `vercel.json` to
`npm install --include=dev`. Deployments then take a minute instead of seconds, and a
broken dependency chain becomes a broken deploy — which is exactly why the default here is
"commit the built site, deploy it untouched".

If you set `PUBLIC_URL=https://your-app.vercel.app` before running `npm run build`, the
`og:` tags point at absolute URLs and link previews work in Discord/X/Slack.

## Or send someone a folder instead of a repo

```bash
npm run zip        # → nuketown-vercel-deploy.zip (~6.5 MB)
```

That package is self-sufficient: `public/` (the built game), `vercel.json`, the scripts,
`src/js`, and a plain-text `DEPLOY.txt` walkthrough. `START.bat` in it plays the build on
localhost with no `npm install` at all, because `serve.mjs` is pure Node and the site is already
built. It deliberately excludes `src/assets` — the 13 MB of asset masters are only needed to
*re* optimise, and `public/` already carries the compressed result.

## Play it locally

```bash
npm install        # dev tooling only — the shipped site needs no dependencies
npm run build      # src/ → public/
npm start          # http://localhost:8420 with Vercel's headers and brotli
npm run check      # run the exact build step Vercel runs, locally
```

`npm start` is the drop-in replacement for `server.ps1`: same job, but it applies the same
`Cache-Control` rules and compression that Vercel will, so what you measure locally is what a
player gets.

## What was done for the web, and what it bought

Measured with `npm run verify` (a real Chromium driving the built page — see below).

| | before | after |
|---|---|---|
| files a player must fetch | 21 ES modules + 12 GLBs + 13 textures + a cold CDN hop for three.js | **64 requests, one of which is the whole engine** |
| bytes for the model set | 8.2 MB | **4.2 MB** (quantised vertices, Meshopt-compressed buffers, re-encoded textures) |
| bytes for the photo textures | 3.8 MB (13 plates) | **1.9 MB** |
| asset bytes the player never needed | 10.3 MB (uncompressed reference sheets for the weapon/character art) | not deployed |
| build | PowerShell script serving a folder over loopback | static files on Vercel's edge CDN |
| first visit | — | 4.8 MB over the network |
| every visit after | — | **0 bytes over the network** (service worker) |

The things that actually stop it lagging:

- **three.js is bundled, not CDN-fetched.** The import map pointed at jsdelivr, so every cold
  load paid DNS + TLS + a cold edge for the engine. It now arrives from the same edge node as
  the rest of the site, minified, in one immutable, content-hashed file.
- **One request instead of 21.** Twenty-one ES modules meant twenty-one round trips before the
  first pixel. `esbuild` flattens the module graph to a single file, and the HTML `preload`s it.
- **Model downloads overlap the map build.** Boot used to `await` the GLBs *after* ~300 ms of
  synchronous map generation, shadow setup and an environment probe. The fetch now starts first,
  so the two run at once.
- **Fonts are self-hosted** (9 subset `.woff2`, 140 KB, preconnected to nothing). Two Google
  Fonts preconnects and a render-blocking stylesheet are gone from the critical path.
- **Shaders are compiled while the loading bar is up.** `renderer.compileAsync` warms the program
  cache during boot and again during the opening round freeze, which removes the "freeze for a
  second, then carry on" hitch on the first frames of a match.
- **Caching that does not go stale.** JS/CSS/fonts are content-hashed and served
  `max-age=31536000, immutable`; models and textures are 7 days with `stale-while-revalidate`;
  `index.html` and `sw.js` always revalidate, so a new deploy is live on the next reload.
- **The service worker precaches with `cache: 'default'`.** It primes the cache from the responses
  the page already downloaded instead of re-downloading 6 MB during install — the naive version of
  this file made the *first* visit twice as heavy, which is the opposite of the point.
- **Quality still adapts at runtime.** The game keeps its own frame-time loop (adaptive resolution
  scale, then shadow-filter and post-processing steps) and starts on Low, raising itself on
  machines with headroom. Nothing here overrides that.

Also fixed: **spectating a teammate in Round Control was not a spectator view.** The camera was
placed on the teammate's *eye line* — inside their own head mesh — so the "glitch" was the inside of
a helmet filling the screen. It is a real third-person shot now: behind and above their right
shoulder, aimed where they are aimed, pulled in when a wall or doorframe is in the way, and it waits
for your own death animation to finish before cutting over instead of fighting it for the camera.

And one bug found along the way: **the F-key performance readout was lying.** The post composer
renders several passes per frame, and three resets `renderer.info` on every `render()`, so the
overlay always reported `1 draws`. It now shows the true whole-frame totals — on this build,
~650-880 draw calls with 9 soldiers on a map batched down from 2112 meshes to 112.

## On a phone

The game plays on a phone in landscape. `src/js/touch.js` installs thumb controls when the device
reports no hover and a coarse pointer — a touchscreen laptop keeps the mouse. Left thumb drags a
floating move stick that appears wherever it lands; the whole right half of the screen is the look
pad; FIRE is bottom-right with ADS / RLD / JUMP / CRH / SPR above it and the weapon slots above
that; PAUSE is the labelled pill in the top-right corner, and the streak icons are tappable.

Everything the buttons do is written into the same state the keyboard and mouse drive
(`player.axis`, `player.mouseDown`, `player.addLookDelta()`), so there is no second implementation of
movement or shooting to drift out of sync. Phones also get:

- the HUD scaled about its corners — minimap to a quarter, ammo and health blocks to 40% — and
  moved to the top edge, so no readout sits under a thumb;
- a wider default field of view (88°), because a 78° viewmodel covers the target on a 6" screen;
  the Settings slider still wins once you touch it;
- portrait blocked: it pauses the match and shows a rotate prompt rather than letting you play a
  400-pixel-tall letterbox;
- every quality preset's pixel-ratio ceiling pulled down. A phone at `devicePixelRatio` 3 is filling
  three screen pixels per CSS pixel, and the adaptive frame-time loop on top of that is what keeps
  a mid-range Android at 60.

`npm run verify:touch` boots the site inside emulated-phone metrics and asserts all of it — the
stick accelerates the player, FIRE shoots and lets go when the finger lifts, pause releases every
held control, portrait pauses and raises the rotate gate, the readouts are at the sizes above, and
spectating a teammate is a third-person shot with the teammate inside the frame.

## Checking a build

```bash
npm run build && npm start &        # serve it
npm run verify                      # drive it in a real browser
```

`scripts/verify.mjs` boots the page, then asserts: no console errors, no failed requests, no 404s,
the GLB soldiers and viewmodels really loaded (rather than silently falling back to procedural
meshes), a 5v5 match starts, frame times complete, and a repeat visit costs nothing on the wire.
It needs a browser — `npm i -D puppeteer`, or `CHROME_PATH=/usr/bin/chromium` with
`puppeteer-core` in containers where Chrome's download is blocked. Point it at a deployment with
`VERIFY_URL=https://your-app.vercel.app npm run verify`.

`scripts/verify-touch.mjs` (`npm run verify:touch`) runs the same page under phone emulation and
checks the thumb layer, the mobile HUD scaling, the portrait gate and the third-person spectator
camera. Both accept `VERIFY_PORT` / `VERIFY_URL` and fall back to `puppeteer-core` + `CHROME_PATH`.

`npm run og` screenshots the live menu into `public/og.png` (1200×630) for link previews.

## Changing the game

Edit `src/js/*.js` or `src/index.html`, then `npm run build`. `npm run dev` rebuilds on save.

- `src/index.html` — the shell. Inline `<style>`, import map and `js/main.js` are all replaced by
  the build; they stay in source so the folder still works over a plain static server.
- `src/js/glb.js` — the shared, Meshopt-capable `GLTFLoader`. Every `.glb` goes through it.
- `src/assets/models/*.glb` — drop in a new file and the optimiser compresses it on the next
  build (`.cache/` holds the compressed copies; `npm run build -- --force` throws them away).
- `src/assets/textures/*.jpg` — 1024² photo plates, re-encoded for the web, same file names.

To push changes back to the offline Windows build, copy `src/js/` and `src/index.html` over
`Call of Duty Build/game/` — but note the web `src/` asks for `.jpg` textures and Meshopt GLBs,
and the desktop folder keeps its originals, so re-point `materials.js`' `PHOTO_SET` and drop the
`glbLoader()` indirection if you want an identical offline bundle. Or simply keep the desktop
folder as the archived single-file build it was.

## Notes and limits

- **Pointer lock on a computer, thumb controls on a phone, WebGL2 everywhere.** A phone needs to be
  held landscape (the game will ask) and a browser that can do WebGL2 — recent Safari on iOS, Chrome
  on Android. Old or software-only WebGL2 fallbacks degrade to a lower resolution rather than
  refusing to run, but a phone without hardware acceleration will be slow: that is the GPU, not the
  page.
- Chrome or Edge are best. The game degrades rather than breaks: a missing or unreadable asset
  falls back to the procedural soldier/weapon/texture it was authored against.
- The whole game is client-side — bots only. Vercel serves files; there is no backend to run, no
  database, no cost beyond the static CDN, and nothing to leak.
- `vercel.json` sets no `X-Frame-Options`, deliberately: people embed games. If you would rather
  not, add `{ "key": "X-Frame-Options", "value": "DENY" }` to the `/(index.html)?` header block.
