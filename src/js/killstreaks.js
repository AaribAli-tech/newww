// ============================================================================
// killstreaks.js — UAV, Airstrike and the Tactical Nuke.
//
//   UAV       — 4 kill streak   — enemies painted on the minimap for 30 s
//   AIRSTRIKE — 7 kill streak   — bomb run down the street
//   NUKE      — 15 kills (match total) — wipes the enemy team, ends the round
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';
import { playUAV, playJetPass, playExplosion, playNukeSiren, playNukeBlast, duckAudio } from './audio.js';

export const STREAKS = [
    { id: 'uav', label: 'UAV', need: 4, mode: 'streak', key: 'KeyZ', icon: '◈' },
    { id: 'air', label: 'AIRSTRIKE', need: 7, mode: 'streak', key: 'KeyX', icon: '✈' },
    { id: 'nuke', label: 'TACTICAL NUKE', need: 15, mode: 'total', key: 'KeyV', icon: '☢' }
];

// ── simple aircraft silhouettes ─────────────────────────────────────────────
function makeUAVModel() {
    const g = new THREE.Group();
    const body = M.plain(0x3d4348, 0.6, 0.4);
    const dark = M.plain(0x1c1f22, 0.5, 0.3);
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.16, 4.2, 10), body);
    fuselage.rotation.x = Math.PI / 2; g.add(fuselage);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), body);
    nose.position.z = -2.0; nose.scale.z = 1.6; g.add(nose);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.12, 0.85), body);
    wing.position.set(0, 0.1, 0.2); g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 0.5), body);
    tail.position.set(0, 0.3, 1.9); g.add(tail);
    for (const s of [-1, 1]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.6), body);
        fin.position.set(s * 1.2, 0.6, 1.9); g.add(fin);
    }
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), dark);
    pod.position.set(0, -0.26, -0.9); g.add(pod);
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
        this.uavTime = 0;
        this.active = [];
        this.used = { uav: false, air: false, nuke: false };
        this.nukeActive = false;
        this.nukeFired = false;
    }

    reset() {
        this.uavTime = 0;
        this.used = { uav: false, air: false, nuke: false };
        this.nukeActive = false;
        this.nukeFired = false;
        for (const a of this.active) if (a.obj) this.ctx.scene.remove(a.obj);
        this.active.length = 0;
    }

    /** Player death consumes streak-based rewards. */
    onPlayerDeath() {
        this.used.uav = false;
        this.used.air = false;
    }

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

    canUse(id) { return this.progress(id).ready && !this.nukeActive; }

    use(id) {
        if (!this.canUse(id)) return false;
        this.used[id] = true;
        if (id === 'uav') this._uav();
        else if (id === 'air') this._airstrike();
        else if (id === 'nuke') this._nuke();
        return true;
    }

    get uavOnline() { return this.uavTime > 0; }

    // ── UAV ─────────────────────────────────────────────────────────────────
    _uav() {
        this.uavTime = 30;
        this.ctx.hud.banner('UAV ONLINE', '#67c6ff', 'Enemy positions revealed');
        playUAV();
        const model = makeUAVModel();
        model.position.set(-70, 34, -30);
        this.ctx.scene.add(model);
        this.active.push({ kind: 'uav', obj: model, t: 0, dur: 34 });
    }

    // ── AIRSTRIKE ───────────────────────────────────────────────────────────
    _airstrike() {
        this.ctx.hud.banner('AIRSTRIKE INBOUND', '#ffb02e', 'Danger close — stay off the street');
        playJetPass();
        // two jets running down the street, bombs walking along X
        for (let j = 0; j < 2; j++) {
            const jet = makeJetModel();
            const dirSign = this.ctx.player.position.x < 0 ? 1 : -1;
            jet.position.set(-dirSign * 150, 46 + j * 6, (j === 0 ? -4 : 5));
            jet.rotation.y = dirSign > 0 ? Math.PI / 2 : -Math.PI / 2;
            this.ctx.scene.add(jet);
            this.active.push({
                kind: 'jet', obj: jet, t: -j * 0.55, dur: 5.0, speed: dirSign * 150,
                dropFrom: -26, dropTo: 26, dropped: 0, lane: (j === 0 ? -4 : 5)
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
        if (this.uavTime > 0) this.uavTime -= dt;

        for (let i = this.active.length - 1; i >= 0; i--) {
            const a = this.active[i];
            a.t += dt;

            if (a.kind === 'uav') {
                const k = a.t / a.dur;
                const ang = k * Math.PI * 2.2;
                a.obj.position.set(Math.cos(ang) * 62, 34 + Math.sin(ang * 2) * 3, Math.sin(ang) * 48);
                a.obj.rotation.y = -ang + Math.PI / 2;
                a.obj.rotation.z = Math.sin(ang) * 0.25;
                if (a.t >= a.dur) { this.ctx.scene.remove(a.obj); this.active.splice(i, 1); }
                continue;
            }

            if (a.kind === 'jet') {
                if (a.t < 0) continue;
                a.obj.position.x += a.speed * dt;
                a.obj.position.y -= dt * 1.5;
                // walk bombs down the street
                const x = a.obj.position.x;
                const inZone = (a.speed > 0) ? (x > a.dropFrom && x < a.dropTo) : (x < -a.dropFrom && x > -a.dropTo);
                if (inZone && a.dropped < 7 && Math.random() < dt * 12) {
                    a.dropped++;
                    this._dropBomb(x + (Math.random() - 0.5) * 4, a.lane + (Math.random() - 0.5) * 5);
                }
                if (Math.abs(a.obj.position.x) > 170) { this.ctx.scene.remove(a.obj); this.active.splice(i, 1); }
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
