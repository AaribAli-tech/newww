// ============================================================================
// killstreaks.js — the Airstrike and the Tactical Nuke.
//
//   UAV       — 4 kill streak   — every enemy on the radar for 20 s
//   AIRSTRIKE — 7 kill streak   — bomb run down the street
//   NUKE      — 15 kills (match total) — wipes the enemy team, ends the round
//
//   The UAV was pulled once, for being a reward that did not change a fight: it
//   flew a circle and the radar showed the same dots the player could already
//   see. It is back with the radar doing the work instead of the aircraft — the
//   map only ever shows an enemy while he is shooting, so twenty seconds of
//   seeing all of them is the difference between pushing a street and guessing
//   at it. That is the whole test a reward has to pass here.
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';
import { MAP_SCALE, MAP_RECT, clamp } from './utils.js';
import { playJetPass, playExplosion, playNukeSiren, playNukeBlast, duckAudio } from './audio.js';

export const STREAKS = [
    { id: 'uav', label: 'UAV', need: 4, mode: 'streak', key: 'KeyZ', icon: '◉' },
    { id: 'air', label: 'AIRSTRIKE', need: 7, mode: 'streak', key: 'KeyX', icon: '✈' },
    { id: 'nuke', label: 'TACTICAL NUKE', need: 15, mode: 'total', key: 'KeyV', icon: '☢' }
];

// ── simple aircraft silhouettes ─────────────────────────────────────────────
/** The quadcopter: four arms, four rotors, and a body you can read from below. */
function makeDroneModel() {
    const g = new THREE.Group();
    const shell = M.plain(0x2b3034, 0.5, 0.7);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.5), shell);
    g.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), shell);
    dome.position.y = 0.34; g.add(dome);
    const arm = new THREE.BoxGeometry(2.9, 0.14, 0.24);
    const rotor = new THREE.CylinderGeometry(0.62, 0.62, 0.06, 12);
    const blade = M.plain(0x9fb2c0, 0.35, 0.5);
    for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2;
        const dx = Math.cos(a) * 1.3, dz = Math.sin(a) * 1.3;
        const ar = new THREE.Mesh(arm, shell);
        ar.position.set(dx * 0.5, 0, dz * 0.5);
        ar.rotation.y = -a; g.add(ar);
        const ro = new THREE.Mesh(rotor, blade);
        ro.position.set(dx, 0.16, dz);
        ro.userData.spin = i % 2 ? 1 : -1;         // counter-rotating, like the real thing
        g.add(ro);
    }
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return g;
}

function makeJetModel() {
    const g = new THREE.Group();
    const body = M.plain(0x2f3438, 0.5, 0.6);
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 7.5, 10), body);
    f.rotation.x = Math.PI / 2; g.add(f);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.8, 10), body);
    nose.rotation.x = -Math.PI / 2; nose.position.z = -4.2; g.add(nose);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(8.0, 0.16, 2.2), body);
    wing.position.z = 0.8; g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.14, 1.2), body);
    tail.position.z = 3.2; g.add(tail);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 1.6), body);
    fin.position.set(0, 0.85, 3.2); g.add(fin);
    const burn = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.6, 10),
        new THREE.MeshBasicMaterial({ color: 0x8fd4ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    burn.rotation.x = Math.PI / 2; burn.position.z = 4.4; g.add(burn);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return g;
}

export class Killstreaks {
    constructor(ctx) {
        this.ctx = ctx;                 // {scene, effects, hud, getBots, player, gamemode}
        this.active = [];
        this.used = { uav: false, air: false, nuke: false };
        this.nukeActive = false;
        this.nukeFired = false;
        this.uavTime = 0;               // seconds of radar left
        this.uavModel = null;
    }

    reset() {
        this.used = { uav: false, air: false, nuke: false };
        this.nukeActive = false;
        this.nukeFired = false;
        this.uavTime = 0;
        if (this.uavModel) { this.ctx.scene.remove(this.uavModel); this.uavModel = null; }
        for (const a of this.active) if (a.obj) this.ctx.scene.remove(a.obj);
        this.active.length = 0;
    }

    /** Player death re-arms the rewards this life spent. Not the nuke: that one
        counts the whole match, so it is not a thing you get back by dying. */
    onPlayerDeath() {
        this.used.uav = false;
        this.used.air = false;
    }

    /** True while the radar is showing every enemy — read by the minimap. */
    get revealing() { return this.uavTime > 0; }

    /** A mode may switch individual rewards off — Round Control drops the nuke. */
    isEnabled(id) {
        const mode = this.ctx.getMode && this.ctx.getMode();
        return !(mode && mode.disabledStreaks && mode.disabledStreaks.has(id));
    }

    progress(id) {
        const p = this.ctx.player;
        const s = STREAKS.find(x => x.id === id);
        const have = s.mode === 'total' ? p.matchKills : p.killStreak;
        return {
            have: Math.min(have, s.need), need: s.need,
            ready: have >= s.need && !this.used[id] && this.isEnabled(id),
            enabled: this.isEnabled(id)
        };
    }

    /**
     * Ready, and allowed by the mode. `progress().ready` already folds the mode
     * restriction in, but the gate belongs here as well: whatever calls this next
     * (a button, a new keybind) must not be able to hand out a reward the ruleset
     * switched off — a nuke in a mode that hides it would be a free match win.
     */
    canUse(id) {
        if (this.nukeActive) return false;
        if (id === 'uav' && this.revealing) return false;    // one sweep at a time
        return this.isEnabled(id) && this.progress(id).ready;
    }

    use(id) {
        if (!this.canUse(id)) return false;
        this.used[id] = true;
        if (id === 'uav') this._uav();
        else if (id === 'air') this._airstrike();
        else if (id === 'nuke') this._nuke();
        return true;
    }

    // ── UAV ─────────────────────────────────────────────────────────────────
    /**
     * A quadcopter that circles the caller for twenty seconds, and a radar that
     * stops being a rumour for the same twenty seconds. The aircraft is the part
     * you can see; `revealing` is the part you can use.
     */
    _uav() {
        const p = this.ctx.player;
        this.uavTime = 20;
        this.ctx.hud.banner('UAV ONLINE', '#7ee08a', 'Every enemy on the radar for 20 s');
        playJetPass();
        const drone = makeDroneModel();
        const sx = clamp(p.position.x, MAP_RECT.minX + 6, MAP_RECT.maxX - 6);
        const sz = clamp(p.position.z, MAP_RECT.minZ + 6, MAP_RECT.maxZ - 6);
        drone.position.set(sx, 24, sz);
        this.ctx.scene.add(drone);
        this.uavModel = drone;
    }

    // ── AIRSTRIKE ───────────────────────────────────────────────────────────
    _airstrike() {
        const p = this.ctx.player;
        // The strike falls where the fight is. It used to be a fixed band from
        // x -26 to 26 around the middle of the street, which was the whole map
        // when the map was 84 m wide and is now a patch on a town the two teams
        // are deployed 100 m across — call one in anywhere else and nothing
        // happened near you, which is exactly what "the airstrike is not coming"
        // describes. So the run is centred on the caller, and clamped back inside
        // the fences so it cannot spend the whole stick on the empty lots.
        const half = 26 * MAP_SCALE;
        const px = clamp(p.position.x, MAP_RECT.minX + half * 0.55, MAP_RECT.maxX - half * 0.55);
        const pz = clamp(p.position.z, MAP_RECT.minZ + 8, MAP_RECT.maxZ - 8);
        this.ctx.hud.banner('AIRSTRIKE INBOUND', '#ffb02e', 'Danger close — keep moving');
        playJetPass();
        // two jets running down the street, bombs walking along X
        for (let j = 0; j < 2; j++) {
            const jet = makeJetModel();
            const dirSign = px < 0 ? 1 : -1;
            const lane = pz + (j === 0 ? -4 : 5);
            jet.position.set(px - dirSign * (half + 70), 46 + j * 6, lane);
            jet.rotation.y = dirSign > 0 ? Math.PI / 2 : -Math.PI / 2;
            this.ctx.scene.add(jet);
            this.active.push({
                kind: 'jet', obj: jet, t: -j * 0.55, dur: 5.0, speed: dirSign * 150,
                dropFrom: px - half, dropTo: px + half, dropped: 0, lane
            });
        }
    }

    // ── NUKE ────────────────────────────────────────────────────────────────
    _nuke() {
        this.nukeActive = true;
        this.nukeT = 0;
        this.ctx.hud.nukeSequence();
        playNukeSiren();
        duckAudio(0.25, 9.5);
    }

    // ── frame ───────────────────────────────────────────────────────────────
    update(dt) {
        // The drone orbits the player and its time runs out whether or not anyone
        // is looking at it. Angle from the remaining seconds, not from a wall
        // clock, so a paused match resumes exactly where it stopped.
        if (this.uavTime > 0) {
            this.uavTime -= dt;
            const m = this.uavModel;
            if (m) {
                const ang = (20 - Math.max(0, this.uavTime)) * 0.5;
                const px = this.ctx.player.position.x, pz = this.ctx.player.position.z;
                m.position.set(px + Math.cos(ang) * 17, 24 + Math.sin(ang * 2) * 0.7, pz + Math.sin(ang) * 17);
                m.rotation.y = -ang - Math.PI / 2;
                for (const c of m.children) if (c.userData && c.userData.spin) c.rotation.y += c.userData.spin * dt * 26;
            }
            if (this.uavTime <= 0) {
                if (this.uavModel) { this.ctx.scene.remove(this.uavModel); this.uavModel = null; }
                this.ctx.hud.banner('UAV OFFLINE', '#9FB2C0', 'The radar is back to gunfire only');
            }
        }

        for (let i = this.active.length - 1; i >= 0; i--) {
            const a = this.active[i];
            a.t += dt;

            if (a.kind === 'jet') {
                if (a.t < 0) continue;
                a.obj.position.x += a.speed * dt;
                a.obj.position.y -= dt * 1.5;
                // walk bombs down the street
                // A band, not a symmetric pair: the run is centred wherever the
                // caller was standing, so both ends have to be read as they are.
                const x = a.obj.position.x;
                const lo = Math.min(a.dropFrom, a.dropTo), hi = Math.max(a.dropFrom, a.dropTo);
                const inZone = x > lo && x < hi;
                if (inZone && a.dropped < 7 && Math.random() < dt * 12) {
                    a.dropped++;
                    this._dropBomb(x + (Math.random() - 0.5) * 4, a.lane + (Math.random() - 0.5) * 5);
                }
                const far = Math.max(Math.abs(MAP_RECT.minX), Math.abs(MAP_RECT.maxX)) + 100;
                if (Math.abs(a.obj.position.x) > far) { this.ctx.scene.remove(a.obj); this.active.splice(i, 1); }
                continue;
            }

            if (a.kind === 'bomb') {
                if (a.t >= a.delay) {
                    this._detonate(a.x, a.z);
                    this.active.splice(i, 1);
                }
                continue;
            }
        }

        if (this.nukeActive) this._updateNuke(dt);
    }

    _dropBomb(x, z) {
        this.active.push({ kind: 'bomb', t: 0, delay: 0.35 + Math.random() * 0.5, x, z });
    }

    _detonate(x, z) {
        const pos = new THREE.Vector3(x, 0.6, z);
        this.ctx.effects.explosion(pos, 2.4);
        playExplosion();
        const R = 8.5;
        for (const bot of this.ctx.getBots()) {
            if (!bot.alive || bot.team === this.ctx.player.team) continue;
            const d = Math.hypot(bot.position.x - x, bot.position.z - z);
            if (d > R) continue;
            const dmg = 200 * (1 - d / R);
            if (bot.takeDamage(dmg, 'Airstrike')) {
                this.ctx.onStreakKill(bot, 'AIRSTRIKE');
            }
        }
        // player takes splash too — danger close
        const p = this.ctx.player;
        if (p.alive) {
            const d = Math.hypot(p.position.x - x, p.position.z - z);
            if (d < R * 0.7) p.takeDamage(90 * (1 - d / (R * 0.7)), 'Airstrike', pos);
        }
    }

    // ── nuke timeline ───────────────────────────────────────────────────────
    _updateNuke(dt) {
        this.nukeT += dt;
        const t = this.nukeT;

        if (!this.nukeFired) this.ctx.hud.nukeCountdown(5.0 - t);

        if (!this.nukeFired && t >= 5.0) {
            this.nukeFired = true;
            playNukeBlast();
            const center = new THREE.Vector3(0, 1, 0);
            this.ctx.effects.nuke(center, () => {});
            this.ctx.hud.nukeFlash();
            this.ctx.shake(2.4, 4.0);

            for (const bot of this.ctx.getBots()) {
                if (bot.alive && bot.team !== this.ctx.player.team) {
                    if (bot.takeDamage(9999, 'Tactical Nuke')) this.ctx.onStreakKill(bot, 'NUKE');
                }
            }
        }

        if (this.nukeFired && t >= 9.5) {
            this.nukeActive = false;
            this.ctx.onNukeComplete();
        }
    }
}
