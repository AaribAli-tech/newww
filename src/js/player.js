// ============================================================================
// player.js — first person controller, shooting and damage.
// ============================================================================
import * as THREE from 'three';
import { WEAPON_DEFS } from './weapons.js';
import { clamp, TEAM_A } from './utils.js';
import {
    playGunshot, playDryFire, playReload, playFootstep, playJump, playLand,
    playHurt, playLowHealth, playWeaponSwap
} from './audio.js';

const EYE_STAND = 1.62, EYE_CROUCH = 1.02;
const MAX_DELTA = 180;                       // px per event — spike guard
const PITCH_LIMIT = Math.PI * 0.49;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export class Player {
    constructor(camera, cw, viewmodel, ctx) {
        this.camera = camera;
        this.cw = cw;
        this.vm = viewmodel;
        this.ctx = ctx;
        this.team = TEAM_A;
        this.name = 'You';

        this.position = new THREE.Vector3(0, 0, 0);
        this.velocity = new THREE.Vector3();
        this.yaw = -Math.PI / 2;
        this.pitch = 0;
        this.radius = 0.32;
        this.eyeHeight = EYE_STAND;
        this.currentEye = EYE_STAND;

        this.walkSpeed = 4.9;
        this.sprintSpeed = 7.6;
        this.crouchSpeed = 2.4;
        this.accel = 55;
        this.airAccel = 9;
        this.friction = 11;
        this.jumpVel = 6.3;
        this.gravity = 22;

        this.onGround = true;
        this.isCrouching = false;
        this.isSprinting = false;
        this.isADS = false;
        this.baseFov = 78;
        this.sensitivity = 0.0016;       // rad per mouse pixel at 1.00 slider
        this.adsSensScale = 0.75;        // how much of the zoom ratio to cancel

        this.health = 100; this.maxHealth = 100;
        this.alive = true;
        this.lastDamage = -9999;
        this.regenDelay = 4.2;
        this.regenRate = 26;
        this.spawnProtect = 0;

        this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
        this.killStreak = 0; this.matchKills = 0;
        this.headshots = 0; this.longestStreak = 0;

        this.weapons = WEAPON_DEFS.map(d => ({
            ammo: d.magSize, reserve: d.reserve, reloading: false, reloadEnd: 0
        }));
        this.current = 0;

        this.lastFire = -9999;
        this.spread = 0;
        this.viewKickX = 0; this.viewKickY = 0;
        this.viewKickVX = 0; this.viewKickVY = 0;
        this.shake = 0; this.shakeDecay = 8;
        this.bobPhase = 0;
        this.footAccum = 0;
        this.lowHealthCue = 0;

        this.keys = Object.create(null);
        this.mouseDown = false;
        this.mouseRight = false;
        this.locked = false;
        this.paused = false;

        this._bind();
    }

    // ── input ───────────────────────────────────────────────────────────────
    _bind() {
        window.addEventListener('keydown', e => {
            if (this.paused) return;
            this.keys[e.code] = true;
            if (e.code === 'Tab') e.preventDefault();
            if (!this.alive) return;
            if (e.code === 'KeyC') this.isCrouching = !this.isCrouching;
            if (e.code === 'KeyR') this.startReload();
            if (e.code === 'Digit1') this.switchTo(0);
            if (e.code === 'Digit2') this.switchTo(1);
            if (e.code === 'Digit3') this.switchTo(2);
            if (e.code === 'Digit4') this.switchTo(3);
            if (e.code === 'KeyQ') this.switchTo((this.current + 1) % WEAPON_DEFS.length);
            if (e.code === 'KeyZ') this.ctx.useStreak('uav');
            if (e.code === 'KeyX') this.ctx.useStreak('air');
            if (e.code === 'KeyV') this.ctx.useStreak('nuke');
        });
        window.addEventListener('keyup', e => { this.keys[e.code] = false; });
        window.addEventListener('mousemove', e => {
            if (!this.locked || !this.alive || this.paused) return;
            // Pointer lock occasionally emits a single enormous delta (window
            // focus changes, driver hiccups). Unclamped, that snaps the view
            // right round and feels like the mouse "slipped".
            const mx = clamp(e.movementX, -MAX_DELTA, MAX_DELTA);
            const my = clamp(e.movementY, -MAX_DELTA, MAX_DELTA);
            // ADS scaling follows the zoom ratio so the same hand movement
            // covers the same on-screen distance whether hipfiring or aiming.
            const zoom = this.isADS ? this.baseFov / Math.max(10, this.camera.fov) : 1;
            const scale = this.sensitivity / (1 + (zoom - 1) * this.adsSensScale);
            this.yaw -= mx * scale;
            this.pitch -= my * scale;
            this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
            this.vm.addLook(mx, my);
        });
        window.addEventListener('mousedown', e => {
            if (!this.locked) return;
            if (e.button === 0) this.mouseDown = true;
            if (e.button === 2) this.mouseRight = true;
        });
        window.addEventListener('mouseup', e => {
            if (e.button === 0) this.mouseDown = false;
            if (e.button === 2) this.mouseRight = false;
        });
        window.addEventListener('contextmenu', e => e.preventDefault());
        window.addEventListener('wheel', e => {
            if (!this.locked || !this.alive) return;
            const n = WEAPON_DEFS.length;
            this.switchTo((this.current + (e.deltaY > 0 ? 1 : n - 1)) % n);
        }, { passive: true });
    }

    get def() { return WEAPON_DEFS[this.current]; }
    get mag() { return this.weapons[this.current]; }

    switchTo(i) {
        if (i === this.current || i < 0 || i >= WEAPON_DEFS.length) return;
        if (!this.vm.requestSwitch(i)) return;
        this.mag.reloading = false;
        this.current = i;
        playWeaponSwap();
    }

    startReload() {
        const m = this.mag, d = this.def;
        if (m.reloading || m.ammo >= d.magSize || m.reserve <= 0) return;
        m.reloading = true;
        m.reloadEnd = performance.now() / 1000 + (d.shellReload ? d.reloadTime * Math.min(4, d.magSize - m.ammo) : d.reloadTime);
        this.vm.startReload({ ...d, reloadTime: m.reloadEnd - performance.now() / 1000 });
        playReload(d.type);
    }

    // ── firing ──────────────────────────────────────────────────────────────
    tryFire(now) {
        if (!this.alive || !this.mouseDown || this.paused) return;
        const d = this.def, m = this.mag;
        if (m.reloading || this.vm.switchT > 0) return;
        if (this.isSprinting && this.vm.sprint > 0.55) return;
        if (m.ammo <= 0) {
            if (now - this.lastFire > 0.35) { playDryFire(); this.lastFire = now; this.startReload(); }
            return;
        }
        const interval = 60 / d.rpm;
        if (now - this.lastFire < interval) return;
        if (d.fireMode !== 'AUTO' && this._semiLatch) return;
        this._semiLatch = d.fireMode !== 'AUTO';

        this.lastFire = now;
        m.ammo--;

        playGunshot(d.audioType);
        this.vm.onFire(d);
        this.ctx.effects.muzzleSmoke(
            this.vm.muzzleWorld(this.camera, _v3),
            _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
        );

        // brass
        const right = _v.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = _v2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const fwd = _v3.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const ejectPos = this.camera.position.clone()
            .addScaledVector(right, 0.22).addScaledVector(up, -0.07).addScaledVector(fwd, 0.28);
        if (!d.shellDelay) this.ctx.effects.shell(ejectPos, right, up, fwd);
        else setTimeout(() => this.alive && this.ctx.effects.shell(
            this.camera.position.clone().addScaledVector(right, 0.2).addScaledVector(up, -0.05), right, up, fwd), d.shellDelay * 1000);

        // recoil: view punch + spread bloom
        const r = d.recoil;
        const adsMul = this.isADS ? 0.62 : 1;
        this.viewKickVY += (r.v * 60) * adsMul;
        this.viewKickVX += (Math.random() - 0.5) * r.h * 110 * adsMul;
        this.spread = Math.min(1, this.spread + (this.isADS ? 0.10 : 0.20));
        this.shake = Math.max(this.shake, r.kick * 0.55);

        // ── the actual bullets ──
        const origin = this.camera.position.clone();
        const muzzle = this.vm.muzzleWorld(this.camera, new THREE.Vector3());
        const pellets = d.pellets || 1;
        const baseSpread = (this.isADS ? d.adsSpread : d.spread)
            * (1 + this.spread * 1.4)
            * (this._movingFast() ? d.moveSpread : 1);

        for (let p = 0; p < pellets; p++) {
            const dir = new THREE.Vector3(0, 0, -1);
            if (baseSpread > 0) {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.sqrt(Math.random()) * baseSpread;
                dir.x += Math.cos(a) * rr;
                dir.y += Math.sin(a) * rr;
            }
            dir.applyQuaternion(this.camera.quaternion).normalize();
            this._trace(origin, dir, d, muzzle);
        }
    }

    _trace(origin, dir, d, muzzleWorld) {
        const world = this.cw.raycast(origin, dir, d.range);
        let wallDist = world ? world.distance : d.range;

        // bots: ray vs. three body spheres, nearest wins
        let best = null, bestT = wallDist, bestHead = false;
        for (const bot of this.ctx.getBots()) {
            if (!bot.alive || bot.team === this.team || bot.spawnProtect > 0) continue;
            const cr = bot.isCrouching;
            const spots = cr
                ? [[0.55, 0.30, false], [0.85, 0.30, false], [1.05, 0.15, true]]
                : [[0.60, 0.30, false], [1.05, 0.32, false], [1.52, 0.155, true]];
            for (const [yOff, rad, head] of spots) {
                const cxx = bot.position.x - origin.x;
                const cyy = bot.position.y + yOff - origin.y;
                const czz = bot.position.z - origin.z;
                const t = cxx * dir.x + cyy * dir.y + czz * dir.z;
                if (t <= 0 || t >= bestT) continue;
                const qx = cxx - dir.x * t, qy = cyy - dir.y * t, qz = czz - dir.z * t;
                if (qx * qx + qy * qy + qz * qz < rad * rad) {
                    best = bot; bestT = t; bestHead = head;
                    break;
                }
            }
        }

        if (best) {
            const hitPoint = origin.clone().addScaledVector(dir, bestT);
            let dmg = d.damage;
            if (bestT > d.falloffStart) {
                dmg *= Math.max(d.falloffMin, 1 - (bestT - d.falloffStart) / (d.range - d.falloffStart));
            }
            if (bestHead) { dmg *= d.headMult; }
            this.ctx.effects.tracer(muzzleWorld, hitPoint, 300);
            this.ctx.effects.blood(hitPoint, dir);
            const killed = best.takeDamage(dmg, this.name);
            this.ctx.onHit(best, killed, bestHead, d);
            if (bestHead) this.headshots += killed ? 1 : 0;
        } else if (world) {
            this.ctx.effects.tracer(muzzleWorld, world.point, 300);
            this.ctx.effects.impact(world.point, world.normal, world.tag, d.type === 'sniper' || d.type === 'shotgun');
        } else {
            this.ctx.effects.tracer(muzzleWorld, origin.clone().addScaledVector(dir, d.range), 300);
        }
    }

    _movingFast() {
        return this.onGround && Math.hypot(this.velocity.x, this.velocity.z) > 2.2;
    }

    // ── damage ──────────────────────────────────────────────────────────────
    takeDamage(amount, fromName, fromPos) {
        if (!this.alive || this.spawnProtect > 0) return;
        this.health -= amount;
        this.lastDamage = performance.now() / 1000;
        this.shake = Math.max(this.shake, 0.16);
        playHurt();

        if (fromPos) {
            const dx = fromPos.x - this.position.x, dz = fromPos.z - this.position.z;
            const worldAngle = Math.atan2(dx, dz);
            const rel = worldAngle - (this.yaw + Math.PI);
            this.ctx.hud.damageDirection(rel);
        }
        this.ctx.hud.hurt(amount);

        if (this.health <= 0) {
            this.health = 0;
            this.alive = false;
            this.deaths++;
            this.longestStreak = Math.max(this.longestStreak, this.killStreak);
            this.killStreak = 0;
            this._startDeathFall(fromPos);
            this.ctx.onPlayerDeath(fromName);
        }
    }

    /** Collapse the view to the ground, tipping away from whoever shot us. */
    _startDeathFall(fromPos) {
        this.deathT = 0;
        this.deathEye = this.currentEye;
        this.deathYaw = this.yaw;
        this.deathPitch = this.pitch;
        let dx, dz;
        if (fromPos) { dx = this.position.x - fromPos.x; dz = this.position.z - fromPos.z; }
        else { dx = Math.random() - 0.5; dz = Math.random() - 0.5; }
        const n = Math.hypot(dx, dz) || 1;
        this.deathDir = { x: dx / n, z: dz / n };
        this.deathRoll = (Math.random() < 0.5 ? -1 : 1) * (0.85 + Math.random() * 0.5);
        this.mouseDown = false;
        this.mouseRight = false;
        this.isADS = false;
    }

    /** 0..1 — how far through the collapse we are (used to grade the screen). */
    get deathProgress() {
        if (this.alive || this.deathT === undefined) return 0;
        return clamp(this.deathT / 1.05, 0, 1);
    }

    _deathCam(dt) {
        this.deathT += dt;
        const t = clamp(this.deathT / 1.05, 0, 1);
        const e = t * t * (3 - 2 * t);
        const c = this.camera;

        const groundEye = 0.32;
        const slide = e * 0.6;
        c.position.set(
            this.position.x + this.deathDir.x * slide,
            this.position.y + this.deathEye + (groundEye - this.deathEye) * e,
            this.position.z + this.deathDir.z * slide
        );
        // one soft bounce as the body settles
        c.position.y += Math.max(0, Math.sin(t * Math.PI * 2.4)) * 0.07 * (1 - e);

        c.rotation.order = 'YXZ';
        c.rotation.y = this.deathYaw + this.deathRoll * 0.22 * e;
        c.rotation.x = this.deathPitch + (-0.62 - this.deathPitch) * e;
        c.rotation.z = this.deathRoll * e;

        const targetFov = this.baseFov + 8;
        c.fov += (targetFov - c.fov) * (1 - Math.exp(-3.5 * dt));
        c.updateProjectionMatrix();
    }

    respawn(spawn) {
        this.position.set(spawn.x, 0, spawn.z);
        this.velocity.set(0, 0, 0);
        this.health = this.maxHealth;
        this.alive = true;
        this.spawnProtect = 2.0;
        this.isCrouching = false;
        this.yaw = spawn.x < 0 ? -Math.PI / 2 : Math.PI / 2;
        this.pitch = 0;
        this.viewKickX = this.viewKickY = 0;
        for (let i = 0; i < this.weapons.length; i++) {
            this.weapons[i].ammo = WEAPON_DEFS[i].magSize;
            this.weapons[i].reserve = WEAPON_DEFS[i].reserve;
            this.weapons[i].reloading = false;
        }
        this.vm.cancelReload();
    }

    resetMatch() {
        this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
        this.killStreak = 0; this.matchKills = 0; this.headshots = 0; this.longestStreak = 0;
    }

    // ── frame ───────────────────────────────────────────────────────────────
    update(dt, nowSec) {
        if (this.paused) return;
        if (!this.mouseDown) this._semiLatch = false;

        if (this.alive) {
            this._move(dt);
            this._reloadTick(nowSec);
            // regen
            if (nowSec - this.lastDamage > this.regenDelay && this.health < this.maxHealth) {
                this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
            }
            if (this.health < 35) {
                this.lowHealthCue -= dt;
                if (this.lowHealthCue <= 0) { playLowHealth(); this.lowHealthCue = 1.4; }
            }
            if (this.spawnProtect > 0) this.spawnProtect -= dt;
        } else {
            this.velocity.multiplyScalar(Math.pow(0.02, dt));
            this._deathCam(dt);
            this.vm.update(dt, { aiming: false, sprinting: false, speed: 0, grounded: true, firing: false });
            return;
        }

        // spread recovery
        this.spread = Math.max(0, this.spread - dt * (this.isADS ? 2.6 : 1.8));

        // view kick spring
        const rec = this.def.recoil.recover;
        this.viewKickVY -= this.viewKickY * 150 * dt;
        this.viewKickVX -= this.viewKickX * 150 * dt;
        const dmp = Math.pow(0.0006, dt * (rec / 9));
        this.viewKickVY *= dmp; this.viewKickVX *= dmp;
        this.viewKickY += this.viewKickVY * dt;
        this.viewKickX += this.viewKickVX * dt;

        this._applyCamera(dt);

        // viewmodel
        this.vm.update(dt, {
            aiming: this.isADS,
            sprinting: this.isSprinting,
            speed: Math.hypot(this.velocity.x, this.velocity.z),
            grounded: this.onGround,
            firing: this.mouseDown && this.mag.ammo > 0 && !this.mag.reloading
        });
    }

    _move(dt) {
        this.isADS = this.mouseRight && !this.mag.reloading && this.vm.switchT === 0;
        const wantSprint = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) &&
            !this.isADS && !this.isCrouching && (this.keys['KeyW'] || this.keys['KeyA'] || this.keys['KeyD']);
        this.isSprinting = wantSprint && this.onGround;

        if (this.keys['ControlLeft']) this.isCrouching = true;

        const maxSpeed = this.isCrouching ? this.crouchSpeed
            : this.isSprinting ? this.sprintSpeed
            : this.isADS ? this.walkSpeed * 0.55 : this.walkSpeed;

        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        let wx = 0, wz = 0;
        if (this.keys['KeyW']) { wx += fx; wz += fz; }
        if (this.keys['KeyS']) { wx -= fx; wz -= fz; }
        if (this.keys['KeyD']) { wx += rx; wz += rz; }
        if (this.keys['KeyA']) { wx -= rx; wz -= rz; }
        const wl = Math.hypot(wx, wz);
        if (wl > 0) { wx /= wl; wz /= wl; }

        const a = (this.onGround ? this.accel : this.airAccel) * dt;
        this.velocity.x += (wx * maxSpeed - this.velocity.x) * Math.min(1, a / 4);
        this.velocity.z += (wz * maxSpeed - this.velocity.z) * Math.min(1, a / 4);
        if (wl === 0 && this.onGround) {
            const f = Math.pow(0.0009, dt * (this.friction / 11));
            this.velocity.x *= f; this.velocity.z *= f;
        }

        if (this.keys['Space'] && this.onGround) {
            this.velocity.y = this.jumpVel;
            this.onGround = false;
            this._airborne = true;
            playJump();
        }

        // integrate + resolve
        this.position.x += this.velocity.x * dt;
        this.cw.resolveAxis(this.position, this.radius, this.currentEye, 'x');
        this.position.z += this.velocity.z * dt;
        this.cw.resolveAxis(this.position, this.radius, this.currentEye, 'z');

        this.velocity.y -= this.gravity * dt;
        this.position.y += this.velocity.y * dt;

        const gy = this.cw.groundHeight(this.position.x, this.position.z, this.position.y, this.radius);
        if (this.position.y <= gy) {
            if (this._airborne && this.velocity.y < -5) {
                this.vm.onLand(Math.min(1, -this.velocity.y / 12));
                this.shake = Math.max(this.shake, Math.min(0.2, -this.velocity.y / 60));
                playLand();
            }
            this._airborne = false;
            this.position.y = gy;
            this.velocity.y = 0;
            this.onGround = true;
        } else {
            this.onGround = false;
            if (this.velocity.y > 0) {
                const ceil = this.cw.ceilingHeight(this.position.x, this.position.z, this.position.y + this.currentEye * 0.5, this.radius);
                if (ceil < this.position.y + this.currentEye + 0.1) {
                    this.position.y = ceil - this.currentEye - 0.1;
                    this.velocity.y = 0;
                }
            }
        }

        // crouch blend, with a headroom check before standing back up
        let targetEye = this.isCrouching ? EYE_CROUCH : EYE_STAND;
        if (!this.isCrouching) {
            const ceil = this.cw.ceilingHeight(this.position.x, this.position.z, this.position.y + 0.4, this.radius);
            if (ceil < this.position.y + EYE_STAND + 0.15) { targetEye = EYE_CROUCH; this.isCrouching = true; }
        }
        this.eyeHeight = targetEye;
        this.currentEye += (targetEye - this.currentEye) * Math.min(1, dt * 12);

        // footsteps
        const spd = Math.hypot(this.velocity.x, this.velocity.z);
        if (this.onGround && spd > 1.0) {
            this.footAccum += spd * dt;
            const stride = this.isSprinting ? 2.05 : this.isCrouching ? 2.6 : 1.75;
            if (this.footAccum > stride) {
                this.footAccum = 0;
                playFootstep(this._surface(), this.isCrouching ? 0.4 : this.isSprinting ? 1.1 : 0.8);
            }
        } else this.footAccum = Math.min(this.footAccum, 1.2);
    }

    _surface() {
        const p = this.position;
        if (p.y > 0.4) return 'wood';
        if (Math.abs(p.z) < 6.2) return 'asphalt';
        if (Math.abs(p.z) < 7.8) return 'concrete';
        return 'dirt';
    }

    _reloadTick(nowSec) {
        const m = this.mag, d = this.def;
        if (!m.reloading) return;
        if (nowSec >= m.reloadEnd) {
            if (d.shellReload) {
                const want = Math.min(4, d.magSize - m.ammo, m.reserve);
                m.ammo += want; m.reserve -= want;
            } else {
                const want = Math.min(d.magSize - m.ammo, m.reserve);
                m.ammo += want; m.reserve -= want;
            }
            m.reloading = false;
        }
    }

    _applyCamera(dt) {
        const c = this.camera;
        c.position.set(this.position.x, this.position.y + this.currentEye, this.position.z);

        // Walk bob. Deliberately tiny — the viewmodel carries the motion, and
        // bobbing the camera itself is what makes aiming feel slippery.
        const spd = Math.hypot(this.velocity.x, this.velocity.z);
        if (this.onGround && spd > 0.5) this.bobPhase += dt * (5.5 + spd * 1.1);
        const bobAmt = Math.min(1, spd / 5) * (this.isADS ? 0.12 : 1);
        c.position.y += Math.abs(Math.sin(this.bobPhase)) * 0.008 * bobAmt;
        c.position.x += Math.cos(this.bobPhase) * 0.004 * bobAmt * Math.cos(this.yaw);
        c.position.z -= Math.cos(this.bobPhase) * 0.004 * bobAmt * Math.sin(this.yaw);

        if (this.shake > 0.001) {
            c.position.x += (Math.random() - 0.5) * this.shake * 0.5;
            c.position.y += (Math.random() - 0.5) * this.shake * 0.5;
            c.position.z += (Math.random() - 0.5) * this.shake * 0.5;
            this.shake *= Math.pow(0.02, dt * (this.shakeDecay / 8));
        }

        c.rotation.order = 'YXZ';
        c.rotation.y = this.yaw + this.viewKickX;
        c.rotation.x = this.pitch + this.viewKickY;
        // Very slight strafe lean. Anything more and the crosshair visibly
        // slides sideways while you are trying to track a target.
        const strafe = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
        const rollTarget = -strafe * 0.0022 * (this.isADS ? 0.15 : 1);
        this._roll = (this._roll || 0) + (rollTarget - (this._roll || 0)) * Math.min(1, dt * 6);
        c.rotation.z = this._roll;

        // Frame-rate independent, and fast enough that the FOV lands with the
        // weapon instead of trailing half a second behind it.
        const targetFov = this.isADS ? this.def.adsFov : (this.isSprinting ? this.baseFov + 4 : this.baseFov);
        const lambda = this.isADS ? 3.2 / this.def.adsTime : 12;
        c.fov += (targetFov - c.fov) * (1 - Math.exp(-lambda * dt));
        if (Math.abs(targetFov - c.fov) < 0.02) c.fov = targetFov;
        c.updateProjectionMatrix();
    }

    addShake(v) { this.shake = Math.max(this.shake, v); }
}
