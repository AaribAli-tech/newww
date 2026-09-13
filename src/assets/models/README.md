# assets/models — optional GLB layer

Drop generated `.glb` files in this folder and `js/assets.js` will load them
after the match is already running and swap them in.

**Nothing here is required.** The procedural soldiers and weapons are the
guaranteed baseline. A missing, corrupt or Draco-compressed file produces a
single `console.warn` and the game keeps the procedural model. Loading never
blocks startup and never throws.

---

## manifest.json

`assets/models/manifest.json` is the index. Three sections, all optional:

```json
{
  "characters": { "blue": "soldier_blue.glb", "red": "soldier_red.glb" },
  "animations": { "idle": "anim_idle.glb", "walk": "anim_walk.glb" },
  "weapons":    { "rifle": "m4a1.glb" }
}
```

- **characters** — keys must be `blue` (team A, the player's team) and `red`
  (team B). Each file needs a skinned mesh; a file without one is skipped.
- **animations** — keys are the logical clip names the game asks for. They end
  up as `getCharacter(team).clips.<key>`, so the key is what matters, not the
  clip name inside the file. The game looks for `idle`, `walk`, `run`,
  `crouch`, `death`; any other key is loaded too and simply ignored by callers
  that do not know it.
- **weapons** — keys are `WEAPON_DEFS[].type`: `rifle`, `smg`, `sniper`,
  `shotgun`, `pistol`.

An **empty** section (`"weapons": {}`) means "no assets of this kind" and is
honoured as written. If `manifest.json` cannot be read at all, the loader falls
back to the default file names listed above, so dropping in standard-named
files without a manifest still works.

### Long form

Any entry may be an object instead of a bare file name:

```json
{ "file": "m4a1.glb", "scale": 1.0, "rotation": [0, 90, 0], "position": [0, 0, 0], "length": 0.86 }
```

| field      | applies to | meaning                                                    |
|------------|------------|------------------------------------------------------------|
| `file`     | all        | file name, relative to this folder. Required.               |
| `yaw`      | characters | degrees. Overrides the automatic facing fix (see below).    |
| `rotation` | weapons    | `[x, y, z]` degrees, applied first.                         |
| `scale`    | weapons    | number, or `[x, y, z]`.                                     |
| `length`   | weapons    | metres. Scales so the longest axis matches, after rotation. |
| `position` | weapons    | `[x, y, z]` metres, applied last.                           |

---

## Characters

One skinned mesh per file. The loader normalises every character so it can be
dropped in wherever a procedural soldier goes:

- scaled to **1.8 m** tall (crown of head, measured through the bones, not the
  bind pose),
- **feet on y = 0**,
- **hips over the origin** in x/z,
- **facing -Z**, the convention the rest of the game uses.

Facing is worked out from the rig, not guessed: `Head` → `headfront` if those
bones exist, otherwise ankle → toe, then snapped to the nearest quarter turn.
Set `"yaw"` on the manifest entry to override it.

The returned `scene` is a plain `Group` at identity — the normalising transform
sits on an inner group, so setting position, rotation and scale on it behaves
exactly like it does for a procedural soldier.

Current files: `soldier_blue.glb`, `soldier_red.glb` — 24-bone rigs
(`Hips`, `Spine`/`Spine01`/`Spine02`, `neck`, `Head`, `headfront`,
`Left`/`Right` `Shoulder`/`Arm`/`ForeArm`/`Hand` and `UpLeg`/`Leg`/`Foot`/`ToeBase`).

## Animations

The generator returns **one clip per file**, animation-only, with no mesh.
`js/assets.js` merges them onto the character's skeleton **by bone name**, so
the animation rig and the character rig must use the same bone names.

While merging it:

- keeps rotation tracks, and the **root (hips) position** track only — bone
  lengths come from the character rig, not from the clip,
- rescales that root track if the animation rig was authored at a different
  size than the character rig,
- drops scale tracks, which humanoid rigs never use,
- drops tracks for bones the character does not have,
- names the resulting clip after its **manifest key**.

A clip baked into the character file itself is kept too, under a slugged
version of its own name (`Armature|clip0|baselayer` → `armature_clip0_baselayer`).

Current files: `anim_idle.glb`, `anim_walk.glb`, `anim_run.glb`,
`anim_crouch.glb`, `anim_death.glb`.

## Weapons

No orientation is inferred for weapons — a gun has no bone that says which way
the barrel points. Author the GLB with the barrel down **-Z** and the grip at
the origin, or state the correction with `rotation` / `position` / `length` in
the manifest. `getWeapon(type)` returns a fresh copy each call; geometry and
materials are shared between copies.

## Notes

- DRACO is **not** wired up. Export uncompressed, or the file is skipped.
- Textures should be embedded in the `.glb`; external `.bin`/image side files
  work too as long as they sit next to it.
- Serve over http — `file://` blocks `fetch`, so the layer degrades to
  procedural models. `play.bat` / `tools/serve.py` handle this.
- `node tools/inspect-glb.js <file>` dumps bone names, clips and triangle
  counts for any file here without needing a browser.
