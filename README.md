# NUKETOWN — Vercel build

A browser first-person shooter on a 1962 Nevada test site — Team Deathmatch, Round Control,
Free For All and Gun Game — that used to only run from a Windows folder via `PLAY.bat`. This repo now
also carries a **static web build that deploys to Vercel as-is** — no server, no install for
the player, no runtime, nothing to log into.

```
public/                 ← what Vercel serves. A complete, self-contained static site.
src/                    ← the game's web source (index.html + js/ + the assets it uses)
scripts/                ← the build: bundler, asset optimiser, local server, verifier
Call of Duty Build/     ← the original offline Windows build, untouched (PLAY.bat still works)
vercel.json             ← deploy config: static output + cache headers
```

## The four modes

| Mode | Teams | How it is won | Killstreaks |
|---|---|---|---|
| **Team Deathmatch** | 5v5 | first to 75 team kills, respawns on | UAV 4 · Airstrike 7 · Nuke 15 |
| **Round Control** | 3v3 | one life per round, first to 3 rounds | UAV 4 · Airstrike 7, no nuke |
| **Free For All** | none — 8 solos, all hostile | first to **200 kills**; the bots race each other too | off, on purpose |
| **Gun Game** | none — all hostile | 4 rungs — M4A1 → MP5 → SPAS-12 → R700 — one kill each, finish first | off, on purpose |

Rules live in `src/js/modes.js`, one class per playlist. `main.js` never hard-codes a mode: it
asks for `onKill`, `canRespawn`, `hudState()`, `standings()` and `result()`. A teamless mode
sets `noTeams` and the scoreboard gives it one sorted table instead of two invented squads.

`noTeams` also means there is no friendly side to hide behind: the roster is built entirely on the
enemy team, so every soldier wears red, the radar marks everyone as hostile, and nothing in the lobby
is shielded from your bullets by a team label. The player and the bots ask the same question before
shooting — `Player.canShoot()` mirrors `Bot.isHostile()` — because those two disagreeing is how
Free For All once ended up with three enemies you could look at but not hit.

## What a kill does

Every kill pays out twice, and the two counters are kept apart on purpose
(`src/js/medals.js`, no DOM, no engine imports — `npm run test:rules` checks the maths):

- a **medal stack** over the crosshair, revealed one at a time so a triple lands as a beat:
  `KILL`, then `HEADSHOT`, then `DOUBLE KILL` / `TRIPLE KILL` / `MULTI KILL ×4` for kills
  inside a 4.2-second window;
- the **kill-streak strip** at the bottom: how many since you last died, what that is called
  (`ON A ROLL` at 3 through to `RELENTLESS` at 25) and the fill toward the next name;
- the **killfeed** down the right edge, which says who did it to whom with what.

Death ends both, and losing a streak of three or more tells you so. The same kill also moves
the mode: one rung up in Gun Game, one step closer to 200 in Free For All, and nothing at all
in Round Control, where rounds are the score.

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
placed on the teammate's *eye line* — inside their own head mesh — so what you got was the inside of
a helmet and a dark blob. It is a third-person chase shot now: behind and above their right
shoulder, aimed where they aim, pulled in when a wall or doorframe is in the way, and it waits for
your own death animation to finish before cutting over instead of fighting it for the camera.
`npm run verify` measures it (metres behind the head + the head inside the frame), so it cannot
quietly become a first-person camera again.

Also found while wiring the new modes: **a player kill never reached the game mode, and no mode
was ever told the match had started.** `main.js` credited kills by calling `gamemode.addKill()`
for the player and `gamemode.onKill()` for bots, which double-counted every bot-vs-bot kill
(“first to 75” was really about 38), handed Round Control a round win every third player kill,
and meant nothing at all arrived for *your* kills — so Gun Game could never advance and Free For
All could never be won by the player. A kill now goes through `onKill()` exactly once and the mode
decides what it is worth. `startMatch()` also used to hard-code a “TEAM DEATHMATCH — First to
75” banner and never call `gamemode.onMatchStart()`, so three of the four modes announced the
wrong rules at kickoff and Round Control opened on `ROUND 0`.

And one bug found along the way: **the F-key performance readout was lying.** The post composer
renders several passes per frame, and three resets `renderer.info` on every `render()`, so the
overlay always reported `1 draws`. It now shows the true whole-frame totals — on this build,
~650-880 draw calls with 9 soldiers on a map batched down from 2112 meshes to 112.

## The imported character model (and how to switch it)

`src/assets/rebel/` holds the **Modern Rebel Soldier** FBX from
`call-of-duty-asset-for-person`, and `src/js/rebel.js` turns it into a bot rig with the same surface
as the other two — `root`, `muzzle`, `setWeapon`, `update(dt, state)`, `fireFlash`, `startDeath`,
`resetPose`, `setOpacity`, `setShadows`, `dispose` — so `ai.js` builds a soldier through `rigFor()`
and never has to know which one it got.

| URL | Who wears the model |
|---|---|
| *(default)* | nobody yet — the game keeps its own soldiers while the model is being judged |
| `?rebel=enemy` | the enemy team, so a match shows both rigs side by side |
| `?rebel=all` | every bot, on both teams |
| `?rebel=off` | the same as the default, spelled out |

The default is `off` on purpose: the model is signed off on `/tester/` first, and one line in
`src/js/rebel.js` (`DEFAULT_MODE`) makes it the shipped look afterwards. Free For All and Gun Game
put the whole lobby on the enemy side, so `?rebel=enemy` there already means everyone.

If the FBX is missing or fails to parse, `loadRebel()` resolves false and the game carries on with
the rigs it already had — an asset problem costs looks, not a match.

Two things about the file itself needed measuring rather than assuming, and both live in
`src/js/rebel-pose.js` so the game and the test page cannot drift apart:

* **It is bound upside-down inside its own rest pose.** With every bone at rotation 0 the hip→knee,
  knee→ankle and shoulder→elbow offsets all point at `+Y`: 14 of its 15 meshes are rigid parts
  parented to bones (only `body_Cube` is skinned), so a soldier at rest is an arms-up ragdoll and a
  walk cycle played on top of it looks like surrender. `STAND_FLIP` puts half a turn about X under
  the four root limb bones — same axis the animation uses, which is why a positive angle still swings
  a limb forward and a knee still bends backwards (both measured on the rig, not guessed).
* **Its height has to be taken from what gets drawn.** The loader's box says 154 units; the same rig
  rendered measures 292, because the file's pivot offsets only settle once the first matrices are
  composed. Scaling from the loader's number puts a 1.80 m soldier in the match at nearly 3.5 m. Both
  pages therefore size from the rendered box: `fitFactor()` is applied over a few frames and then
  stops, and the bot rig writes its correction to the shared template once so later soldiers are
  right on their first frame.

What the model cannot do yet, in one line each: it has **no animation clips** (the export has no
AnimationStack), so locomotion, crouch and the death fall are generated procedurally from the bot's
own speed and aim — readable, but a step below the GLB soldiers' canned clips until real clips are
authored or the existing `anim_*.glb` are retargeted onto its `mixamorig:` skeleton (a matching bone
set, so that is feasible); and its 15 skinned pieces are **not merged**, which costs about 120 extra
draw calls across a full lobby — merging skinned geometry has to agree with every piece's bind
matrix, and guessing wrong shows up as a twitching soldier, so that trade is deliberately deferred.

Its textures are rebound by material name (`Body_Material`, `Head_Material`, `BootAndSkin_Material`)
because the paths baked into the file are the author's own `C:\Users\...`, and a small team-coloured
shoulder patch is added, because a soldier nobody can assign to a side is how "enemies I can't hit"
got reported in the first place.

## Trying a model on its own (`/tester/`)

`public/tester/` is a separate page — an empty world with a firing range, built from
`src/tester/tester.js`, for judging a character rig before it goes anywhere near the game. Move,
sprint, crouch, jump, shoot dummies; flip to first person or an inspect orbit; toggle the skeleton,
wireframe, textures and the model's height. `npm run build` builds it, or run it alone with
`npm run tester`, then open `/tester/`.

The model is on you **and on all seven range dummies**: when the FBX and its textures are ready, the
page clones it (`SkeletonUtils.clone`, which is the only safe way to copy a skinned hierarchy) and
dresses the range, each copy on a slow patrol so the walk cycle can be judged from the front, the
back and both sides at once. `K` swaps the dummies back to the crude boxes — the boxes leave the
scene when the model arrives, because three's raycaster does not skip invisible objects, so a shot
that scores has to hit the actual mesh; head shots still count (the head is found by material name).
The readout in the corner reports what it loaded, which textures it attached, how tall it is drawing,
and whether the clones are on the range.

It is wired to the **Modern Rebel Soldier** from `call-of-duty-asset-for-person`, which is a useful
first patient: the file is a binary FBX with a `mixamorig:` skeleton and **no animation clips at
all**, so every pose in the page (walk cycle, crouch bend, recoil) is produced procedurally from the
movement state, and its texture paths are the author's own `C:\Users\...` — so the page rebinds
`body.png` / `head.png` / `boots.png` by material name (`Body_Material`, `Head_Material`,
`BootAndSkin_Material`) and shows you what it attached. Both facts are printed in the page's readout
rather than hidden, because they are the things that will need deciding before this model ships in
the game: it needs clips (or the game's procedural rig), and a GLB pass through the asset pipeline.

To test a different model: drop the `.fbx` and its textures in `src/assets/rebel/`, name them in
`ASSET` at the top of `src/tester/tester.js`, and rebuild.

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

Both the frame sampling and the optional probes are bounded, because a machine rendering through
SwiftShader (this sandbox does) can take seconds per frame: a screenshot, a key/mouse exercise or
the reload that measures the repeat visit will report "could not be measured" instead of hanging the
run, and budgets widen automatically on two-core boxes (or with `VERIFY_SLOW=1`).

`npm run test:rules` needs no browser at all: 67 assertions over the medal chain, the streak
names, who is hostile to whom, both teamless modes' win conditions and the "one kill, one
credit" rule. It runs in about a second, which is why the rules are worth testing there rather
than in the page.

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

- **Desktop only, on purpose.** It needs pointer lock, a mouse and WebGL2. A phone or tablet (no
  hover + coarse pointer) gets a plain "Not available on mobile" panel over the menu with Deploy
  disabled, rather than a match it cannot aim or shoot in — see `blockMobile()` in `src/js/main.js`.
  There is deliberately no touch input path anywhere in the build.
- Chrome or Edge are best. The game degrades rather than breaks: a missing or unreadable asset
  falls back to the procedural soldier/weapon/texture it was authored against.
- The whole game is client-side — bots only. Vercel serves files; there is no backend to run, no
  database, no cost beyond the static CDN, and nothing to leak.
- `vercel.json` sets no `X-Frame-Options`, deliberately: people embed games. If you would rather
  not, add `{ "key": "X-Frame-Options", "value": "DENY" }` to the `/(index.html)?` header block.
