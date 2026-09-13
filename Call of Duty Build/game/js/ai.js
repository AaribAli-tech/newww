// ============================================================================
// ai.js — bot soldiers
//
// Heading convention matches the player camera: forward = (-sin yaw, -cos yaw).
// The soldier mesh is authored facing -Z, so root.rotation.y = yaw puts the
// model, its weapon and its muzzle all pointing where the bot is actually
// going.  (The previous build set this from atan2(dx,dz), which pointed every
// soldier exactly backwards.)
// ============================================================================
import * as THREE from 'three';
import { SoldierRig } from './soldier.js';
import { AnimatedSoldier, charactersReady } from './character.js';
// Bots draw from the four-weapon TDM pool, NOT the whole 15-gun Gun Game
// ladder — that ladder contains a 165-damage Barrett that would one-shot the
// player from across the map. Gun Game overrides this per bot via weaponPool.
import { WEAPON_DEFS, BOT_WEAPON_POOL } from './weapons.js';
import { WAYPOINTS, SPAWN_A, SPAWN_B, PERCHES } from './map.js';
import { TEAM_A, rand, randElement, dist2D, clamp } from './utils.js';

const ST = { PATROL: 0, HUNT: 1, ENGAGE: 2, RELOAD: 3, FALLBACK: 4, HOLD: 5, DEAD: 6 };
const EYE = 1.52, EYE_CROUCH = 1.02;
const SHADOW_RANGE_SQ = 22 * 22;       // past this a soldier's own shadow does not read
const VIEW_RANGE = 46;
const FOV_DOT = Math.cos(1.15);        // ~132° total awareness cone

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class Bot {
    constructor(name, team, scene, skill = 0.5) {
        this.name = name;
        this.team = team;
        this.scene = scene;
        this.skill = skill;

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.yaw = 0;
        this.targetYaw = 0;
        this.aimPitch = 0;

        this.health = 100; this.maxHealth = 100;
        this.alive = true;
        this.isCrouching = false;
        this.onGround = true;

        this.state = ST.PATROL;
        this.path = null;
        this.goal = null;
        this.goalTimer = 0;
        this.enemy = null;
        this.lastSeen = null;
        this.lastSeenTime = -99;
        this.reaction = 0;
        this.burst = 0;
        this.burstPause = 0;
        this.nextShot = 0;
        this.stuck = 0;
        this.stuckCount = 0;
        this.unstickTimer = 0;
        this.lastPos = new THREE.Vector3();
        this.respawnTimer = 0;
        this.spawnProtect = 0;
        this.suppressed = 0;
        this.strafeDir = Math.random() < 0.5 ? 1 : -1;
        this.strafeTimer = 0;
        this.holdTimer = 0;

        this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
        this.killStreak = 0;
        this.damageFrom = {};

        this.weaponIndex = 0;
        this.setWeapon(randElement(this.weaponPool || BOT_WEAPON_POOL));
        this.ammo = this.weapon.magSize;

        // Skinned GLB soldier when the assets loaded, procedural rig otherwise.
        // Both expose the same interface, so nothing below this line cares
        // which one it got — and a missing asset costs looks, not a crash.
        this.rig = charactersReady()
            ? new AnimatedSoldier(team, this.weapon.type)
            : new SoldierRig(team, this.weapon.type, (Math.random() * 5) | 0);
        scene.add(this.rig.root);
        this.mesh = this.rig.root;

        this.events = [];
    }

    setWeapon(i) {
        this.weaponIndex = i;
        this.weapon = WEAPON_DEFS[i];
        this.ammo = this.weapon.magSize;
        if (this.rig) this.rig.setWeapon(this.weapon.type);
    }

    get eyeY() { return this.isCrouching ? EYE_CROUCH : EYE; }
    eyePos(out) { return out.set(this.position.x, this.position.y + this.eyeY, this.position.z); }

    // ── lifecycle ───────────────────────────────────────────────────────────
    spawn(pos) {
        const sp = pos || randElement(this.team === TEAM_A ? SPAWN_A : SPAWN_B);
        this.position.set(sp.x + rand(-1.2, 1.2), 0, sp.z + rand(-1.2, 1.2));
        this.velocity.set(0, 0, 0);
        this.health = this.maxHealth;
        this.alive = true;
        this.isCrouching = false;
        this.state = ST.PATROL;
        this.enemy = null;
        this.lastSeen = null;
        this.spawnProtect = 1.5;
        this.suppressed = 0;
        this.damageFrom = {};
        this.setWeapon(randElement(this.weaponPool || BOT_WEAPON_POOL));
        this.rig.resetPose();
        this.rig.root.visible = true;
        this.rig.root.traverse(o => {
            if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 1) o.material.opacity = 1;
        });
        this.yaw = this.team === TEAM_A ? -Math.PI / 2 : Math.PI / 2;
        this.pickGoal();
    }

    die(killerName) {
        if (!this.alive) return false;
        this.alive = false;
        this.state = ST.DEAD;
        this.deaths++;
        this.killStreak = 0;
        this.respawnTimer = 5.5;
        this.rig.startDeath();
        void killerName;
        return true;
    }

    takeDamage(amount, attackerId) {
        if (!this.alive || this.spawnProtect > 0) return false;
        this.health -= amount;
        this.suppressed = 1.4;
        this.damageFrom[attackerId] = (this.damageFrom[attackerId] || 0) + amount;
        if (this.health <= 0) { this.health = 0; return this.die(attackerId); }
        if (this.state === ST.PATROL || this.state === ST.HOLD) {
            this.state = ST.HUNT;
            this.reaction = rand(0.08, 0.22);
        }
        return false;
    }

    // ── navigation ──────────────────────────────────────────────────────────
    pickGoal() {
        // push toward the far half of the map, occasionally hold a perch
        const forward = this.team === TEAM_A ? 1 : -1;
        if (Math.random() < 0.18) {
            const p = randElement(PERCHES.filter(q => Math.sign(q.x) === forward || Math.random() < 0.5));
            this.goal = { x: p.x, z: p.z, perch: true };
        } else {
            let best = null, bestScore = -1e9;
            for (let i = 0; i < 6; i++) {
                const w = randElement(WAYPOINTS);
                const towardEnemy = w.x * forward;
                const d = dist2D(this.position, w);
                const score = towardEnemy * 0.9 - Math.abs(d - 16) * 0.4 + Math.random() * 8;
                if (score > bestScore) { bestScore = score; best = w; }
            }
            this.goal = best;
        }
        this.goalTimer = rand(6, 12);
    }

    /**
     * Steer toward a point, sliding around obstacles.
     *
     * `faceTarget` decouples where the soldier WALKS from where he LOOKS. In
     * combat a soldier backing off or repositioning keeps his weapon on you and
     * moves with his body turned — without this the bot turns to face wherever
     * it is walking, which meant a bot backing away from you was firing over
     * its shoulder while facing 180 degrees in the wrong direction.
     */
    steerTo(target, speed, dt, cw, faceTarget) {
        // While reversing out of a snag, ignore steering entirely — otherwise
        // the pathing immediately turns the bot back into whatever it was stuck
        // on and it never gets clear.
        if (this.unstickTimer > 0) return 99;

        const dx = target.x - this.position.x, dz = target.z - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.001) return 0;
        let dirX = dx / d, dirZ = dz / d;

        // whisker probes: if blocked ahead, veer
        _a.set(this.position.x, this.position.y + 0.9, this.position.z);
        _b.set(dirX, 0, dirZ);
        const ahead = cw.raycast(_a, _b, 2.2);
        if (ahead) {
            const perpX = -dirZ, perpZ = dirX;
            _b.set(perpX, 0, perpZ);
            const right = cw.raycast(_a, _b, 1.8);
            const sign = right ? -1 : 1;
            dirX = dirX * 0.35 + perpX * sign * 0.95;
            dirZ = dirZ * 0.35 + perpZ * sign * 0.95;
            const n = Math.hypot(dirX, dirZ) || 1;
            dirX /= n; dirZ /= n;
        }

        this.velocity.x += (dirX * speed - this.velocity.x) * Math.min(1, dt * 9);
        this.velocity.z += (dirZ * speed - this.velocity.z) * Math.min(1, dt * 9);
        if (faceTarget) {
            const fx = faceTarget.x - this.position.x, fz = faceTarget.z - this.position.z;
            if (fx || fz) this.targetYaw = Math.atan2(-fx, -fz);
        } else {
            this.targetYaw = Math.atan2(-dirX, -dirZ);
        }
        return d;
    }

    // ── perception ──────────────────────────────────────────────────────────
    findEnemy(entities, cw) {
        let best = null, bestScore = -1e9;
        this.eyePos(_a);
        const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
        for (const e of entities) {
            if (!e.alive || e.team === this.team) continue;
            const dx = e.position.x - this.position.x, dz = e.position.z - this.position.z;
            const d = Math.hypot(dx, dz);
            if (d > VIEW_RANGE) continue;
            const dot = (dx * fwdX + dz * fwdZ) / (d || 1);
            const alerted = this.suppressed > 0 || (this.enemy === e && this.lastSeenTime > -1);
            if (dot < FOV_DOT && !alerted && d > 5) continue;
            _b.set(e.position.x, e.position.y + (e.isCrouching ? 0.95 : 1.35), e.position.z);
            if (!cw.isLineOfSight(_a, _b)) continue;
            const score = 60 - d + (this.enemy === e ? 14 : 0) + dot * 12;
            if (score > bestScore) { bestScore = score; best = e; }
        }
        return best;
    }

    // ── update ──────────────────────────────────────────────────────────────
    update(dt, now, entities, cw, viewer) {
        this.events.length = 0;

        if (!this.alive) {
            this.rig.update(dt, {});
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 4.2) this.rig.root.visible = this.rig.deadT < 5.0;
            // Round-based modes own the respawn cycle and revive everyone
            // themselves when the round flips, so a bot must not come back on
            // its own timer or a one-life round would never end.
            if (this.respawnTimer <= 0 && !this.respawnBlocked) this.spawn();
            return this.events;
        }
        if (this.frozen) {
            // frozen setup at the head of a round: hold position, no shooting
            this.velocity.set(0, 0, 0);
            this.rig.root.position.copy(this.position);
            this.rig.root.rotation.y = this.yaw;
            this.rig.update(dt, { speed: 0, aiming: false, crouching: false, aimPitch: 0, lookYaw: 0 });
            return this.events;
        }

        if (this.spawnProtect > 0) this.spawnProtect -= dt;
        this.suppressed = Math.max(0, this.suppressed - dt);
        this.goalTimer -= dt;
        this.strafeTimer -= dt;

        const seen = this.findEnemy(entities, cw);
        if (seen) {
            this.enemy = seen;
            this.lastSeen = _c.copy(seen.position).clone();
            this.lastSeenTime = now;
            if (this.state === ST.PATROL || this.state === ST.HOLD || this.state === ST.HUNT) {
                if (this.state !== ST.ENGAGE) this.reaction = rand(0.14, 0.42) * (1.4 - this.skill);
                this.state = ST.ENGAGE;
            }
        } else if (this.state === ST.ENGAGE && now - this.lastSeenTime > 1400) {
            this.state = this.lastSeen ? ST.HUNT : ST.PATROL;
        }

        if (this.ammo <= 0 && this.state !== ST.RELOAD) {
            this.state = ST.RELOAD;
            this.reloadTimer = this.weapon.reloadTime * (this.weapon.shellReload ? 4 : 1);
        }
        if (this.health < 26 && this.state === ST.ENGAGE && Math.random() < dt * 1.6) {
            this.state = ST.FALLBACK;
            this.holdTimer = rand(2.5, 4.0);
        }

        let speed = 0;
        const RUN = 5.6 + this.skill * 0.8, WALK = 3.4, CREEP = 1.9;

        switch (this.state) {
            case ST.PATROL: {
                if (!this.goal || this.goalTimer <= 0) this.pickGoal();
                const d = this.steerTo(this.goal, WALK + 1.0, dt, cw);
                speed = WALK + 1.0;
                if (d < 2.0) {
                    if (this.goal.perch && Math.random() < 0.6) { this.state = ST.HOLD; this.holdTimer = rand(3, 7); }
                    else this.pickGoal();
                }
                this.isCrouching = false;
                break;
            }
            case ST.HOLD: {
                this.holdTimer -= dt;
                this.velocity.multiplyScalar(Math.pow(0.02, dt));
                speed = 0;
                this.isCrouching = Math.random() < 0.5 ? this.isCrouching : this.isCrouching;
                // sweep the muzzle across the likely approach
                this.targetYaw = (this.team === TEAM_A ? -Math.PI / 2 : Math.PI / 2) + Math.sin(now * 0.0007 + this.name.length) * 0.7;
                if (this.holdTimer <= 0) { this.state = ST.PATROL; this.pickGoal(); }
                break;
            }
            case ST.HUNT: {
                const tgt = this.lastSeen || this.goal;
                if (!tgt) { this.state = ST.PATROL; break; }
                const d = this.steerTo(tgt, RUN, dt, cw);
                speed = RUN;
                this.isCrouching = false;
                if (d < 2.2) { this.lastSeen = null; this.state = ST.PATROL; this.pickGoal(); }
                break;
            }
            case ST.ENGAGE: {
                const e = this.enemy;
                if (!e || !e.alive) { this.state = ST.PATROL; break; }
                const dx = e.position.x - this.position.x, dz = e.position.z - this.position.z;
                const d = Math.hypot(dx, dz);
                this.targetYaw = Math.atan2(-dx, -dz);

                const idealRange = this.weapon.type === 'shotgun' ? 5 :
                                   this.weapon.type === 'sniper' ? 24 : 12;
                if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = rand(0.9, 2.2); }

                // Every movement branch below keeps the body — and therefore the
                // weapon — pointed at the target. A soldier repositions with his
                // muzzle on you, he does not turn his back and fire blind.
                if (d > idealRange + 5) {
                    this.steerTo(e.position, RUN, dt, cw, e.position);
                    speed = RUN;
                    this.isCrouching = false;
                } else if (d < idealRange - 4 && this.weapon.type !== 'shotgun') {
                    _a.set(this.position.x - dx / d * 3, 0, this.position.z - dz / d * 3);
                    this.steerTo(_a, WALK, dt, cw, e.position);
                    speed = WALK;
                } else {
                    // strafe across the target
                    const px = -dz / (d || 1) * this.strafeDir, pz = dx / (d || 1) * this.strafeDir;
                    this.velocity.x += (px * CREEP * 1.4 - this.velocity.x) * Math.min(1, dt * 7);
                    this.velocity.z += (pz * CREEP * 1.4 - this.velocity.z) * Math.min(1, dt * 7);
                    speed = CREEP * 1.4;
                    this.isCrouching = d < 14 && (this.weapon.type === 'sniper' || this.suppressed > 0.4);
                }

                // aim pitch toward the target's chest
                const ey = e.position.y + (e.isCrouching ? 0.95 : 1.35);
                this.aimPitch = Math.atan2(ey - (this.position.y + this.eyeY), Math.max(0.4, d));

                if (this.reaction > 0) { this.reaction -= dt; break; }
                this._tryFire(dt, now, e, d, cw);
                break;
            }
            case ST.RELOAD: {
                this.reloadTimer -= dt;
                this.velocity.multiplyScalar(Math.pow(0.35, dt));
                speed = 0.4;
                if (this.enemy && this.enemy.alive) {
                    // back off while reloading
                    const dx = this.position.x - this.enemy.position.x, dz = this.position.z - this.enemy.position.z;
                    const n = Math.hypot(dx, dz) || 1;
                    _a.set(this.position.x + dx / n * 4, 0, this.position.z + dz / n * 4);
                    this.steerTo(_a, WALK, dt, cw, this.enemy.position);
                    speed = WALK;
                }
                if (this.reloadTimer <= 0) {
                    this.ammo = this.weapon.magSize;
                    this.state = this.enemy && this.enemy.alive ? ST.ENGAGE : ST.PATROL;
                }
                break;
            }
            case ST.FALLBACK: {
                this.holdTimer -= dt;
                const src = this.enemy ? this.enemy.position : { x: 0, z: 0 };
                const dx = this.position.x - src.x, dz = this.position.z - src.z;
                const n = Math.hypot(dx, dz) || 1;
                _a.set(this.position.x + dx / n * 8, 0, this.position.z + dz / n * 8);
                this.steerTo(_a, RUN, dt, cw);
                speed = RUN;
                this.isCrouching = false;
                if (this.holdTimer <= 0) {
                    this.health = Math.max(this.health, 55);
                    this.state = ST.PATROL;
                    this.pickGoal();
                }
                break;
            }
        }

        // ── integrate + collide ────────────────────────────────────────────
        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;
        cw.resolveAxis(this.position, 0.34, 1.75, 'x');
        cw.resolveAxis(this.position, 0.34, 1.75, 'z');

        this.velocity.y -= 22 * dt;
        this.position.y += this.velocity.y * dt;
        const gy = cw.groundHeight(this.position.x, this.position.z, this.position.y, 0.34);
        if (this.position.y <= gy) { this.position.y = gy; this.velocity.y = 0; this.onGround = true; }
        else this.onGround = false;

        // ── unstick ────────────────────────────────────────────────────────
        // A soldier wedged on a doorframe used to jitter against it with a
        // random nudge, which mostly kept him wedged. Now he turns around,
        // walks out the way he came, and only then picks a new destination —
        // and if that still does not free him, he takes a bigger step back.
        const moved = dist2D(this.position, this.lastPos);
        if (moved < 0.02 && speed > 1) {
            this.stuck += dt;
            if (this.stuck > 0.7) {
                this.stuck = 0;
                this.stuckCount = (this.stuckCount || 0) + 1;

                // face back the way we came and commit to reversing for a beat
                this.targetYaw = this.yaw + Math.PI + rand(-0.5, 0.5);
                this.yaw = this.targetYaw;                     // snap, do not ease
                const backX = -Math.sin(this.yaw), backZ = -Math.cos(this.yaw);
                const shove = 3.5 + this.stuckCount * 1.5;
                this.velocity.set(backX * shove, 0, backZ * shove);
                this.unstickTimer = 0.55;

                // repeatedly stuck means this goal is unreachable from here
                this.goal = null;
                this.pickGoal();
                if (this.stuckCount >= 3) {
                    // last resort: teleport clear of whatever is holding us
                    this.position.x += backX * 1.2;
                    this.position.z += backZ * 1.2;
                    this.stuckCount = 0;
                }
            }
        } else {
            this.stuck = 0;
            if (moved > 0.15) this.stuckCount = 0;
        }
        // while reversing, ignore steering so the bot actually clears the snag
        if (this.unstickTimer > 0) this.unstickTimer -= dt;
        this.lastPos.copy(this.position);

        // ── orientation + rig ──────────────────────────────────────────────
        let dyaw = this.targetYaw - this.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const turnRate = this.state === ST.ENGAGE ? 9.5 : 5.5;
        this.yaw += dyaw * Math.min(1, dt * turnRate);

        this.rig.root.position.copy(this.position);
        this.rig.root.rotation.y = this.yaw;
        if (this.rig.setShadows && viewer) {
            const dx = this.position.x - viewer.x, dz = this.position.z - viewer.z;
            this.rig.setShadows(dx * dx + dz * dz < SHADOW_RANGE_SQ);
        }
        this.rig.update(dt, {
            speed: Math.hypot(this.velocity.x, this.velocity.z),
            aiming: this.state === ST.ENGAGE && this.reaction <= 0,
            crouching: this.isCrouching,
            aimPitch: this.aimPitch,
            lookYaw: clamp(dyaw, -0.6, 0.6)
        });

        return this.events;
    }

    _tryFire(dt, now, enemy, dist, cw) {
        const w = this.weapon;
        if (this.burstPause > 0) { this.burstPause -= dt; return; }
        const interval = 60000 / w.rpm;
        if (now - this.nextShot < interval) return;
        this.nextShot = now;

        // line of fire must actually be clear from the muzzle
        this.eyePos(_a);
        _b.set(enemy.position.x, enemy.position.y + (enemy.isCrouching ? 0.95 : 1.3), enemy.position.z);
        if (!cw.isLineOfSight(_a, _b)) return;

        this.ammo--;
        this.rig.fireFlash();
        this.burst++;

        // burst discipline
        const burstLen = w.type === 'sniper' ? 1 : w.type === 'shotgun' ? 1 : (3 + ((Math.random() * 4) | 0));
        if (this.burst >= burstLen) {
            this.burst = 0;
            this.burstPause = w.type === 'sniper' ? rand(0.9, 1.8) :
                              w.type === 'shotgun' ? rand(0.6, 1.1) : rand(0.22, 0.55);
        }

        // hit chance: skill, range, target motion, own motion, suppression
        const rangeFactor = clamp(1 - (dist - w.falloffStart * 0.5) / w.range, 0.18, 1);
        const moving = Math.hypot(this.velocity.x, this.velocity.z) > 2 ? 0.72 : 1;
        const crouchBonus = this.isCrouching ? 1.15 : 1;
        let chance = (0.16 + this.skill * 0.42) * rangeFactor * moving * crouchBonus;
        if (this.suppressed > 0) chance *= 0.8;
        chance = clamp(chance, 0.03, 0.72);

        const hit = Math.random() < chance;
        const muzzle = new THREE.Vector3();
        this.rig.muzzle.updateWorldMatrix(true, false);
        muzzle.setFromMatrixPosition(this.rig.muzzle.matrixWorld);

        if (hit) {
            const head = Math.random() < 0.08;
            let dmg = w.damage * (w.pellets ? w.pellets * 0.34 : 1) * rand(0.85, 1.05);
            if (dist > w.falloffStart) dmg *= Math.max(w.falloffMin, 1 - (dist - w.falloffStart) / w.range);
            if (head) dmg *= w.headMult;
            this.events.push({ type: 'hit', target: enemy, damage: dmg, from: muzzle, to: _b.clone(), head, shooter: this });
        } else {
            // spray a near miss so the player hears/sees rounds going past
            const miss = _b.clone();
            miss.x += rand(-1.6, 1.6); miss.y += rand(-0.7, 1.1); miss.z += rand(-1.6, 1.6);
            const dir = miss.clone().sub(muzzle).normalize();
            const h = cw.raycast(muzzle, dir, w.range);
            this.events.push({
                type: 'miss', from: muzzle, to: h ? h.point : muzzle.clone().addScaledVector(dir, w.range),
                normal: h ? h.normal : null, shooter: this, near: enemy
            });
        }
        this.events.push({ type: 'shot', audio: w.audioType, position: muzzle.clone() });
    }

    dispose() {
        this.scene.remove(this.rig.root);
        this.rig.dispose();
    }
}
