// ============================================================================
// viewmodel.js — first-person weapon rendering + animation
//
// The viewmodel lives in its own scene with its own camera and is drawn AFTER
// the world with a cleared depth buffer, so the gun and hands can never clip
// through walls — the classic FPS setup.
// ============================================================================
import * as THREE from 'three';
import { createViewModel, WEAPON_DEFS } from './weapons.js';
import { mergeRig } from './optimize.js';
import { applyPhotoreal } from './vmassets.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));

/**
 * Photoreal GLB weapons.
 *
 * The generated meshes look good in isolation but fail as gameplay weapons:
 * the auto-orientation guessed the muzzle end wrong on the MP5, SPAS and R700
 * (measured: their sight anchors landed BEHIND the receiver, i.e. the gun was
 * held backwards), and none of them carry a usable sight picture — no reticle,
 * no aperture, no scope glass — so aiming down them shows nothing to aim with.
 * They also cost ~21k triangles in the viewmodel against ~3k procedural.
 *
 * The procedural weapons are correct by construction: muzzle down -Z always, a
 * real holographic reticle on the rifle, an open aperture on the SMG, a scope
 * with an overlay on the sniper, ghost rings on the shotgun, and moving
 * magazines and charging handles during reloads.
 *
 * The GLB path is kept intact behind this flag. To use it, the per-weapon
 * orientation needs pinning explicitly rather than inferred, and each model
 * needs a reticle added.
 */
const USE_PHOTOREAL_WEAPONS = true;

export class ViewModel {
    constructor(team = 0) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(58, 1, 0.004, 6);
        this.scene.add(this.camera);

        // Dedicated three-point lighting. Kept deliberately low: the weapon
        // materials are metallic and also pick up the sky environment, so a
        // bright key blows the whole gun out to white.
        const key = new THREE.DirectionalLight(0xfff2dd, 1.9);
        key.position.set(-0.75, 1.0, 0.55);
        const fill = new THREE.DirectionalLight(0x9fc2e8, 0.45);
        fill.position.set(1.0, -0.15, 0.6);
        // Cool rim separates the weapon from the warm desert behind it, and
        // keeps the top rail reading as metal rather than wood.
        const rim = new THREE.DirectionalLight(0xcfdcea, 0.85);
        rim.position.set(0.55, 0.45, -1.0);
        // low bounce so the underside of the receiver does not go solid black
        const bounce = new THREE.DirectionalLight(0xb9a892, 0.30);
        bounce.position.set(-0.3, -1.0, 0.2);
        this.scene.add(key, fill, rim, bounce, new THREE.AmbientLight(0xa8bccd, 0.22));
        this.scene.environmentIntensity = 0.45;

        this.holder = new THREE.Group();
        this.scene.add(this.holder);

        // Viewmodels are built on first use. Eagerly constructing all fifteen
        // cost 2.7 s of startup, and in Gun Game you only ever hold one at a
        // time — most of that work was for weapons the player never sees.
        this.team = team;
        this.models = new Array(WEAPON_DEFS.length).fill(null);

        this.current = 0;
        this._ensure(0).group.visible = true;

        // animation state
        this.ads = 0;              // 0..1 aim blend
        this.sprint = 0;           // 0..1 sprint pose blend
        this.bobT = 0;
        this.swayX = 0; this.swayY = 0;
        this.swayVX = 0; this.swayVY = 0;
        this.recoilPos = new THREE.Vector3();
        this.recoilRot = new THREE.Vector3();
        this.recoilVelPos = new THREE.Vector3();
        this.recoilVelRot = new THREE.Vector3();
        this.breath = 0;
        this.landDip = 0;
        this.switchT = 0;          // >0 while swapping weapons
        this.pendingSwitch = -1;
        this.reload = null;        // {t, dur, type}
        this.flashT = 0;
        this.jumpOffset = 0;

        this._pos = new THREE.Vector3();
        this._rot = new THREE.Euler();
        this._v = new THREE.Vector3();
    }

    /** Build a viewmodel the first time it is asked for. */
    _ensure(i) {
        let vm = this.models[i];
        if (!vm) {
            vm = createViewModel(i, this.team);
            const swapped = USE_PHOTOREAL_WEAPONS && applyPhotoreal(vm);
            if (!swapped) mergeRig(vm.group);
            vm.group.visible = false;
            this.holder.add(vm.group);
            this.models[i] = vm;
        }
        return vm;
    }

    get parts() { return this._ensure(this.current).parts; }
    get def() { return WEAPON_DEFS[this.current]; }

    setEnvironment(env) { this.scene.environment = env; }

    // ── events ──────────────────────────────────────────────────────────────
    requestSwitch(index) {
        if (index === this.current || this.switchT > 0) return false;
        // build it now, during the lower animation, so the raise does not stall
        this._ensure(index);
        this.pendingSwitch = index;
        this.switchT = 0.001;
        return true;
    }

    startReload(def) {
        if (this.reload) return;
        this.reload = { t: 0, dur: def.reloadTime, type: def.type };
    }

    cancelReload() { this.reload = null; }

    onFire(def) {
        const r = def.recoil;
        // impulse into the spring
        this.recoilVelPos.z += r.kick * 9;
        this.recoilVelPos.y += r.kick * 2.4;
        this.recoilVelRot.x -= r.kick * 26;
        this.recoilVelRot.y += (Math.random() - 0.5) * r.kick * 16;
        this.recoilVelRot.z += (Math.random() - 0.5) * r.kick * 12;
        this.flashT = 0.045;

        const p = this.parts;
        if (def.type === 'sniper') this.boltT = 0.55;
        if (def.type === 'shotgun') this.pumpT = 0.42;
        void p;
    }

    addLook(dx, dy) {
        // mouse movement pushes the gun; springs pull it back
        this.swayVX += -dx * 0.00055;
        this.swayVY += -dy * 0.00045;
    }

    onLand(force) { this.landDip = clamp(force, 0, 1) * 0.06; }

    /** World-space muzzle position mapped into the main camera's space. */
    muzzleWorld(camera, out) {
        const p = this.parts;
        p.muzzle.updateWorldMatrix(true, false);
        out.setFromMatrixPosition(p.muzzle.matrixWorld);
        // viewmodel space is camera-local space
        out.applyMatrix4(camera.matrixWorld);
        return out;
    }

    ejectPointWorld(camera, out) {
        const p = this.parts;
        out.copy(p.ejectPort).applyMatrix4(p.gun.matrixWorld).applyMatrix4(camera.matrixWorld);
        return out;
    }

    // ── per-frame ───────────────────────────────────────────────────────────
    /**
     * state: { aiming, sprinting, speed, grounded, dt, firing }
     */
    update(dt, state) {
        const def = this.def;
        // NOTE: `model` is resolved AFTER the switch block below, not here.
        // Capturing it up front meant that when a swap completed mid-frame the
        // later `model.visible = ...` line re-showed the weapon we had just put
        // away, leaving two guns in your hands.

        // ── blends ──
        const adsTarget = (state.aiming && !state.sprinting && !this.reload && this.switchT === 0) ? 1 : 0;
        const adsSpeed = 1 / Math.max(0.06, def.adsTime);
        this.ads = damp(this.ads, adsTarget, adsSpeed * 4.2, dt);
        this.sprint = damp(this.sprint, state.sprinting && state.speed > 3 ? 1 : 0, 11, dt);
        this.breath += dt;

        // ── weapon switch: lower, swap, raise ──
        if (this.switchT > 0) {
            this.switchT += dt;
            const half = 0.22;
            if (this.pendingSwitch >= 0 && this.switchT >= half) {
                this._ensure(this.current).group.visible = false;
                this.current = this.pendingSwitch;
                this._ensure(this.current).group.visible = true;
                this.pendingSwitch = -1;
                this.reload = null;
                // Drop aim state across a swap. Carrying it over left the
                // sniper's scopeAmount high enough to hide its own model, so
                // switching to it produced empty hands.
                this.ads = 0;
                this.scopeAmount = 0;
            }
            if (this.switchT >= half * 2) { this.switchT = 0; }
        }
        const swPhase = this.switchT > 0 ? Math.sin(clamp(this.switchT / 0.44, 0, 1) * Math.PI) : 0;

        // resolved here so it always refers to the weapon actually in hand
        const p = this.parts;
        const model = this._ensure(this.current).group;
        // belt and braces: whatever happens above, exactly one weapon is shown
        for (let i = 0; i < this.models.length; i++) {
            const m = this.models[i];
            if (m && i !== this.current && m.group.visible) m.group.visible = false;
        }

        // ── sway springs ──
        this.swayVX -= this.swayX * 42 * dt; this.swayVX *= Math.pow(0.0009, dt);
        this.swayVY -= this.swayY * 42 * dt; this.swayVY *= Math.pow(0.0009, dt);
        this.swayX = clamp(this.swayX + this.swayVX * dt, -0.05, 0.05);
        this.swayY = clamp(this.swayY + this.swayVY * dt, -0.05, 0.05);

        // ── movement bob ──
        const moveAmt = clamp(state.speed / 5.2, 0, 1.4);
        if (state.grounded && state.speed > 0.4) this.bobT += dt * (6.5 + state.speed * 1.25);
        else this.bobT += dt * 0.9;
        const bobScale = (1 - this.ads * 0.78) * moveAmt;
        const bobX = Math.sin(this.bobT) * 0.0125 * bobScale;
        const bobY = (Math.abs(Math.cos(this.bobT)) - 0.5) * 0.014 * bobScale;
        const bobRZ = Math.sin(this.bobT) * 0.020 * bobScale;

        // ── idle breathing ──
        const brX = Math.sin(this.breath * 1.15) * 0.0022 * (1 - this.ads * 0.55);
        const brY = Math.sin(this.breath * 1.65 + 1) * 0.0028 * (1 - this.ads * 0.55);

        // ── recoil spring ──
        const rec = def.recoil;
        for (const [cur, vel, stiff] of [[this.recoilPos, this.recoilVelPos, 120], [this.recoilRot, this.recoilVelRot, 150]]) {
            vel.x -= cur.x * stiff * dt; vel.y -= cur.y * stiff * dt; vel.z -= cur.z * stiff * dt;
            const d = Math.pow(0.00025, dt * (rec.recover / 9));
            vel.multiplyScalar(d);
            cur.addScaledVector(vel, dt);
        }
        this.landDip = damp(this.landDip, 0, 9, dt);

        // ── reload animation ──
        let rlPos = this._v.set(0, 0, 0), rlRotX = 0, rlRotZ = 0;
        if (this.reload) {
            this.reload.t += dt;
            const k = clamp(this.reload.t / this.reload.dur, 0, 1);
            this._applyReload(p, def, k);
            // whole-gun motion during the reload
            const dip = Math.sin(k * Math.PI);
            rlPos.set(0.02 * dip, -0.075 * dip, 0.04 * dip);
            rlRotX = 0.34 * dip;
            rlRotZ = -0.28 * dip;
            if (k >= 1) { this.reload = null; this._resetParts(p); }
        } else {
            this._idleParts(p, def, dt);
        }

        // ── pose blend: hip → ads, plus sprint ──
        const hip = p.hipPos, adsP = p.adsPos;
        const a = this.ads;
        this._pos.set(
            hip.x + (adsP.x - hip.x) * a,
            hip.y + (adsP.y - hip.y) * a,
            hip.z + (adsP.z - hip.z) * a
        );
        const hr = p.hipRot;
        this._rot.set(hr.x * (1 - a), hr.y * (1 - a), hr.z * (1 - a));

        // sprint pose — gun canted across the body, muzzle down-left
        const s = this.sprint * (1 - a);
        this._pos.x += s * -0.055;
        this._pos.y += s * -0.075;
        this._pos.z += s * 0.075;
        this._rot.x += s * 0.30;
        this._rot.y += s * 0.62;
        this._rot.z += s * -0.55;

        // switch dip
        this._pos.y -= swPhase * 0.30;
        this._rot.x += swPhase * 0.85;

        // additive layers
        this._pos.x += bobX + this.swayX + brX + rlPos.x + this.recoilPos.x;
        this._pos.y += bobY + this.swayY + brY + rlPos.y + this.recoilPos.y - this.landDip;
        this._pos.z += rlPos.z + this.recoilPos.z * 0.35;

        this._rot.x += this.recoilRot.x * 0.02 + rlRotX + (-this.swayY * 2.2) + brY * 2;
        this._rot.y += this.recoilRot.y * 0.02 + (this.swayX * 2.6);
        this._rot.z += this.recoilRot.z * 0.02 + bobRZ + rlRotZ;

        model.position.copy(this._pos);
        model.rotation.copy(this._rot);

        // Reticle only once you are most of the way into the aim — at the hip a
        // floating dot over the gun reads as a bug, not a sight.
        //
        // Scoped weapons never show the mesh reticle at all: their sight IS the
        // full-screen scope overlay, and showing both meant that on the way into
        // a snipe you briefly saw a red-dot optic before the scope took over.
        if (p.reticleGroup) p.reticleGroup.visible = !def.scope && this.ads > 0.55;

        // ── sniper: hide the model and go to scope overlay when fully aimed ──
        this.scopeAmount = def.scope ? clamp((this.ads - 0.72) / 0.28, 0, 1) : 0;
        model.visible = this.scopeAmount < 0.98;

        // ── muzzle flash ──
        if (this.flashT > 0) {
            this.flashT -= dt;
            const o = clamp(this.flashT / 0.045, 0, 1);
            const scale = 0.75 + Math.random() * 0.8;
            for (const f of p.flash) {
                f.material.opacity = o * (0.55 + Math.random() * 0.45);
                f.scale.setScalar(scale);
            }
            p.flash[2].rotation.z = Math.random() * Math.PI;
            p.flashLight.intensity = o * 6.5;
            p.muzzle.visible = true;
        } else if (p.muzzle.visible) {
            for (const f of p.flash) f.material.opacity = 0;
            p.flashLight.intensity = 0;
            p.muzzle.visible = false;
        }

        // trigger finger
        if (p.trigger) p.trigger.rotation.x = state.firing ? -0.22 : 0;

        // fov: tighten a touch when aiming so sights feel closer
        const targetFov = 58 - this.ads * 8;
        if (Math.abs(this.camera.fov - targetFov) > 0.01) {
            this.camera.fov = damp(this.camera.fov, targetFov, 10, dt);
            this.camera.updateProjectionMatrix();
        }
    }

    _idleParts(p, def, dt) {
        // cycling actions return home when not reloading
        if (p.bolt && p.boltHome) {
            if (this.boltT > 0) {
                this.boltT -= dt;
                const k = 1 - clamp(this.boltT / 0.55, 0, 1);
                const s = Math.sin(k * Math.PI);
                p.bolt.position.z = p.boltHome.z + s * 0.10;
                p.bolt.rotation.z = -s * 1.0;
            } else {
                p.bolt.position.copy(p.boltHome);
                p.bolt.rotation.z = 0;
            }
        }
        if (p.pump && p.pumpHome) {
            if (this.pumpT > 0) {
                this.pumpT -= dt;
                const k = 1 - clamp(this.pumpT / 0.42, 0, 1);
                p.pump.position.z = p.pumpHome.z + Math.sin(k * Math.PI) * 0.085;
            } else {
                p.pump.position.copy(p.pumpHome);
            }
        }
        if (p.charge && p.chargeHome) p.charge.position.copy(p.chargeHome);
        if (p.mag && p.magHome) { p.mag.position.copy(p.magHome); p.mag.rotation.set(0, 0, 0); p.mag.visible = true; }
        if (p.handL) p.handL.visible = true;
        void def;
    }

    _applyReload(p, def, k) {
        if (def.type === 'sniper') {
            // bolt back, strip rounds, bolt forward
            const s = Math.sin(clamp(k * 1.6, 0, 1) * Math.PI);
            if (p.bolt && p.boltHome) {
                p.bolt.position.z = p.boltHome.z + s * 0.11;
                p.bolt.rotation.z = -s * 1.1;
            }
            if (p.handL) p.handL.visible = k < 0.15 || k > 0.85;
            return;
        }
        if (def.type === 'shotgun') {
            // shell-by-shell: hand leaves the pump, feeds, pump cycles at the end
            if (p.pump && p.pumpHome) {
                const c = k > 0.72 ? Math.sin(((k - 0.72) / 0.28) * Math.PI) : 0;
                p.pump.position.z = p.pumpHome.z + c * 0.085;
            }
            if (p.handL) p.handL.visible = k < 0.12 || k > 0.70;
            return;
        }
        // rifle / smg: mag out → mag in → charging handle
        if (p.mag && p.magHome) {
            if (k < 0.30) {
                const t = k / 0.30;
                p.mag.position.set(p.magHome.x, p.magHome.y - t * 0.42, p.magHome.z + t * 0.06);
                p.mag.rotation.x = t * 0.9;
                p.mag.visible = t < 0.92;
            } else if (k < 0.42) {
                p.mag.visible = false;
            } else if (k < 0.74) {
                const t = (k - 0.42) / 0.32;
                p.mag.visible = true;
                p.mag.position.set(p.magHome.x, p.magHome.y - (1 - t) * 0.34, p.magHome.z + (1 - t) * 0.05);
                p.mag.rotation.x = (1 - t) * 0.7;
            } else {
                p.mag.position.copy(p.magHome);
                p.mag.rotation.set(0, 0, 0);
                p.mag.visible = true;
            }
        }
        if (p.charge && p.chargeHome) {
            const c = k > 0.78 ? Math.sin(((k - 0.78) / 0.22) * Math.PI) : 0;
            p.charge.position.z = p.chargeHome.z + c * 0.075;
        }
        if (p.handL) p.handL.visible = k < 0.08 || k > 0.80;
    }

    _resetParts(p) {
        if (p.mag && p.magHome) { p.mag.position.copy(p.magHome); p.mag.rotation.set(0, 0, 0); p.mag.visible = true; }
        if (p.charge && p.chargeHome) p.charge.position.copy(p.chargeHome);
        if (p.bolt && p.boltHome) { p.bolt.position.copy(p.boltHome); p.bolt.rotation.z = 0; }
        if (p.pump && p.pumpHome) p.pump.position.copy(p.pumpHome);
        if (p.handL) p.handL.visible = true;
    }

    resize(aspect) {
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
    }

    render(renderer) {
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClear = true;
    }
}
