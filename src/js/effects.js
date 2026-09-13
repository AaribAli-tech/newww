// ============================================================================
// effects.js — pooled visual effects: tracers, impacts, bullet holes, blood,
// shell casings, smoke, explosions and the nuke's mushroom cloud.
// Everything is pooled; nothing allocates geometry during play.
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';

function holeTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(10,8,6,0.95)');
    grd.addColorStop(0.35, 'rgba(30,26,20,0.75)');
    grd.addColorStop(0.7, 'rgba(90,82,66,0.30)');
    grd.addColorStop(1, 'rgba(120,110,90,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 12; i++) {
        g.strokeStyle = 'rgba(40,34,26,' + (0.25 + Math.random() * 0.4) + ')';
        g.lineWidth = 0.8 + Math.random();
        const a = Math.random() * Math.PI * 2;
        g.beginPath(); g.moveTo(32, 32);
        g.lineTo(32 + Math.cos(a) * (12 + Math.random() * 16), 32 + Math.sin(a) * (12 + Math.random() * 16));
        g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function softTexture(inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, inner); grd.addColorStop(1, outer);
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

const IMPACT_PALETTE = {
    concrete: [0xd8d2c2, 0x9a9488], wood: [0xa2764a, 0x6d4c2c],
    brick: [0xa8735a, 0x7a4f3c], vehicle: [0xcfd4d8, 0x8f979c],
    fence: [0xc8ccd0, 0x8d9296], ground: [0xc9b18a, 0x9c8664],
    sand: [0xd6bd94, 0xa8916c], mannequin: [0xe0cbb0, 0xb09a80],
    default: [0xc9c0aa, 0x8f887a]
};

export class Effects {
    constructor(scene) {
        this.scene = scene;

        // ── shared geometry / materials ──
        this.sparkGeo = new THREE.BoxGeometry(0.03, 0.03, 0.03);
        this.tracerGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 5, 1, true);
        this.tracerGeo.rotateX(Math.PI / 2);
        this.shellGeo = new THREE.CylinderGeometry(0.0055, 0.0048, 0.022, 7);
        this.quad = new THREE.PlaneGeometry(1, 1);

        this.tracerMat = new THREE.MeshBasicMaterial({
            color: 0xffd98a, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false
        });
        this.shellMat = M.plain(0xc8a04a, 0.28, 0.9);
        this.holeMat = new THREE.MeshBasicMaterial({
            map: holeTexture(), transparent: true, depthWrite: false, opacity: 1, polygonOffset: true, polygonOffsetFactor: -4
        });
        this.smokeMat = new THREE.MeshBasicMaterial({
            map: softTexture('rgba(190,185,175,0.85)', 'rgba(160,155,145,0)'),
            transparent: true, depthWrite: false, opacity: 0.6
        });
        this.fireMat = new THREE.MeshBasicMaterial({
            map: softTexture('rgba(255,240,190,1)', 'rgba(255,110,20,0)'),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        this.bloodMat = new THREE.MeshBasicMaterial({
            map: softTexture('rgba(190,20,14,0.95)', 'rgba(120,10,8,0)'),
            transparent: true, depthWrite: false
        });

        // ── pools ──
        this.sparks = this._pool(180, () => new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true })));
        this.tracers = this._pool(48, () => new THREE.Mesh(this.tracerGeo, this.tracerMat.clone()));
        this.shells = this._pool(40, () => new THREE.Mesh(this.shellGeo, this.shellMat));
        this.puffs = this._pool(70, () => new THREE.Mesh(this.quad, this.smokeMat.clone()));
        this.flames = this._pool(40, () => new THREE.Mesh(this.quad, this.fireMat.clone()));
        this.bloods = this._pool(40, () => new THREE.Mesh(this.quad, this.bloodMat.clone()));
        this.holes = [];
        this.holeIdx = 0;
        for (let i = 0; i < 90; i++) {
            const m = new THREE.Mesh(this.quad, this.holeMat);
            m.visible = false; m.renderOrder = 2;
            scene.add(m);
            this.holes.push(m);
        }

        this.active = [];
        // Fixed-size light pool. The count must never change: adding or
        // removing a light forces every material in the scene to recompile,
        // which shows up as a hitch exactly when something explodes.
        this.lights = [];
        for (let i = 0; i < 2; i++) {
            const l = new THREE.PointLight(0xffaa55, 0, 14, 2);
            l.visible = true;
            // Even at zero intensity a light occupies a slot in every lit
            // material's per-pixel loop, so the Low preset removes them.
            l.userData.fxLight = true;
            scene.add(l);
            this.lights.push({ light: l, life: 0, max: 0, peak: 0 });
        }
        this._v = new THREE.Vector3();
    }

    _pool(n, factory) {
        const arr = [];
        for (let i = 0; i < n; i++) {
            const m = factory();
            m.visible = false;
            m.frustumCulled = false;
            this.scene.add(m);
            arr.push({ mesh: m, busy: false });
        }
        return { arr, next: 0 };
    }

    _take(pool) {
        const { arr } = pool;
        for (let i = 0; i < arr.length; i++) {
            const idx = (pool.next + i) % arr.length;
            if (!arr[idx].busy) { pool.next = (idx + 1) % arr.length; arr[idx].busy = true; return arr[idx]; }
        }
        // all busy: steal the oldest
        const idx = pool.next; pool.next = (idx + 1) % arr.length;
        return arr[idx];
    }

    _flash(pos, color, peak, dur, dist = 14) {
        // steal the weakest slot if all are busy
        let slot = this.lights.find(l => l.life <= 0);
        if (!slot) slot = this.lights.reduce((a, b) => (a.peak <= b.peak ? a : b));
        if (slot.life > 0 && slot.peak > peak) return;
        slot.light.position.copy(pos);
        slot.light.color.setHex(color);
        slot.light.distance = dist;
        slot.life = dur; slot.max = dur; slot.peak = peak;
    }

    /** Short warm pop from a bot's muzzle — shares the same pool. */
    gunFlash(pos) { this._flash(pos, 0xffb45a, 5.5, 0.06, 7); }

    // ── public effects ──────────────────────────────────────────────────────
    tracer(from, to, speed = 260) {
        const s = this._take(this.tracers);
        const m = s.mesh;
        const dir = this._v.copy(to).sub(from);
        const dist = dir.length();
        if (dist < 0.05) { s.busy = false; return; }
        dir.multiplyScalar(1 / dist);
        m.visible = true;
        m.position.copy(from);
        m.lookAt(to);
        m.scale.set(1, 1, 1.1);
        m.material.opacity = 0.85;
        this.active.push({
            kind: 'tracer', slot: s, from: from.clone(), dir: dir.clone(),
            dist, travelled: 0, speed, len: Math.min(2.6, dist * 0.5)
        });
    }

    impact(point, normal, tag = 'default', heavy = false) {
        const pal = IMPACT_PALETTE[tag] || IMPACT_PALETTE.default;
        const n = normal || new THREE.Vector3(0, 1, 0);

        // sparks / debris
        const count = heavy ? 12 : 7;
        for (let i = 0; i < count; i++) {
            const s = this._take(this.sparks);
            const m = s.mesh;
            m.visible = true;
            m.position.copy(point).addScaledVector(n, 0.02);
            m.scale.setScalar(0.4 + Math.random() * 0.9);
            const hot = i < (tag === 'vehicle' || tag === 'fence' ? 5 : 2);
            m.material.color.setHex(hot ? 0xffcf7a : pal[i % 2]);
            m.material.opacity = 1;
            const v = new THREE.Vector3(
                n.x * 2 + (Math.random() - 0.5) * 3.2,
                n.y * 2 + Math.random() * 2.6 + 0.6,
                n.z * 2 + (Math.random() - 0.5) * 3.2
            ).multiplyScalar(1 + Math.random());
            this.active.push({ kind: 'spark', slot: s, vel: v, life: 0.32 + Math.random() * 0.35, gravity: 16 });
        }

        // dust puff
        const p = this._take(this.puffs);
        p.mesh.visible = true;
        p.mesh.position.copy(point).addScaledVector(n, 0.05);
        p.mesh.scale.setScalar(0.22);
        p.mesh.material.opacity = 0.55;
        p.mesh.material.color.setHex(pal[1]);
        this.active.push({ kind: 'puff', slot: p, life: 0.55, max: 0.55, grow: 2.4, rise: 0.7, drift: new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5) });

        // persistent bullet hole
        if (tag !== 'ground' && tag !== 'sand') {
            const h = this.holes[this.holeIdx];
            this.holeIdx = (this.holeIdx + 1) % this.holes.length;
            h.visible = true;
            h.position.copy(point).addScaledVector(n, 0.012);
            h.lookAt(this._v.copy(point).add(n));
            h.rotation.z = Math.random() * Math.PI;
            const sc = 0.10 + Math.random() * 0.06;
            h.scale.set(sc, sc, 1);
        }
    }

    blood(point, dir) {
        for (let i = 0; i < 5; i++) {
            const b = this._take(this.bloods);
            b.mesh.visible = true;
            b.mesh.position.copy(point);
            b.mesh.scale.setScalar(0.10 + Math.random() * 0.12);
            b.mesh.material.opacity = 0.85;
            const v = (dir ? dir.clone().multiplyScalar(1.8) : new THREE.Vector3());
            v.x += (Math.random() - 0.5) * 2.4;
            v.y += Math.random() * 1.8 + 0.4;
            v.z += (Math.random() - 0.5) * 2.4;
            this.active.push({ kind: 'billboard', slot: b, vel: v, life: 0.42 + Math.random() * 0.2, gravity: 11, grow: 1.6 });
        }
    }

    shell(pos, right, up, forward) {
        const s = this._take(this.shells);
        s.mesh.visible = true;
        s.mesh.position.copy(pos);
        const v = right.clone().multiplyScalar(2.0 + Math.random() * 1.4)
            .addScaledVector(up, 1.6 + Math.random() * 1.0)
            .addScaledVector(forward, -0.6 - Math.random() * 0.6);
        this.active.push({
            kind: 'shell', slot: s, vel: v, life: 2.4, gravity: 18,
            spin: new THREE.Vector3(Math.random() * 22 - 11, Math.random() * 16 - 8, Math.random() * 22 - 11)
        });
    }

    muzzleSmoke(pos, dir) {
        const p = this._take(this.puffs);
        p.mesh.visible = true;
        p.mesh.position.copy(pos).addScaledVector(dir, 0.1);
        p.mesh.scale.setScalar(0.12);
        p.mesh.material.opacity = 0.30;
        p.mesh.material.color.setHex(0xb8b2a6);
        this.active.push({
            kind: 'puff', slot: p, life: 0.7, max: 0.7, grow: 2.0, rise: 0.9,
            drift: dir.clone().multiplyScalar(1.4)
        });
    }

    explosion(pos, scale = 1, colorFlash = 0xffb45a) {
        this._flash(pos, colorFlash, 45 * scale, 0.45, 26 * scale);
        for (let i = 0; i < 10; i++) {
            const f = this._take(this.flames);
            f.mesh.visible = true;
            f.mesh.position.copy(pos);
            f.mesh.position.x += (Math.random() - 0.5) * scale;
            f.mesh.position.y += Math.random() * scale * 0.8;
            f.mesh.position.z += (Math.random() - 0.5) * scale;
            f.mesh.scale.setScalar(scale * (0.7 + Math.random()));
            f.mesh.material.opacity = 1;
            this.active.push({
                kind: 'billboard', slot: f, vel: new THREE.Vector3((Math.random() - 0.5) * 5, 2 + Math.random() * 5, (Math.random() - 0.5) * 5),
                life: 0.42 + Math.random() * 0.3, gravity: -2, grow: 3.2
            });
        }
        for (let i = 0; i < 14; i++) {
            const p = this._take(this.puffs);
            p.mesh.visible = true;
            p.mesh.position.copy(pos);
            p.mesh.position.x += (Math.random() - 0.5) * scale * 2;
            p.mesh.position.z += (Math.random() - 0.5) * scale * 2;
            p.mesh.scale.setScalar(scale * 0.8);
            p.mesh.material.opacity = 0.75;
            p.mesh.material.color.setHex(0x4a443c);
            this.active.push({
                kind: 'puff', slot: p, life: 1.6 + Math.random(), max: 2.4, grow: 2.6, rise: 2.4,
                drift: new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)
            });
        }
        for (let i = 0; i < 16; i++) {
            const s = this._take(this.sparks);
            s.mesh.visible = true;
            s.mesh.position.copy(pos);
            s.mesh.scale.setScalar(1.4);
            s.mesh.material.color.setHex(0xffc061);
            s.mesh.material.opacity = 1;
            this.active.push({
                kind: 'spark', slot: s, life: 0.7 + Math.random() * 0.5, gravity: 14,
                vel: new THREE.Vector3((Math.random() - 0.5) * 16, Math.random() * 12 + 2, (Math.random() - 0.5) * 16)
            });
        }
    }

    /**
     * The nuke. Built from real geometry rather than the billboard pool: at
     * mushroom-cloud scale, camera-facing quads slice through the near plane
     * and fill the screen with flat colour bands.
     */
    nuke(pos, onTick) {
        this._flash(pos, 0xfff2c8, 1400, 2.6, 600);

        const group = new THREE.Group();
        group.position.set(pos.x, 0, pos.z);
        this.scene.add(group);

        // depthWrite stays on: transparent spheres that blend through each other
        // turn the cloud into a faceted crystal instead of solid smoke.
        const smokeMat = new THREE.MeshStandardMaterial({
            color: 0x8e8272, roughness: 1.0, metalness: 0, transparent: true, opacity: 0.0,
            depthWrite: true, emissive: 0x2a1a0c, emissiveIntensity: 0.6
        });
        const hotMat = new THREE.MeshBasicMaterial({
            color: 0xffb14a, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false
        });

        const blobs2 = [];
        const addBlob = (mat, r, x, y, z, rise, spread, delay) => {
            const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), mat.clone());
            const p2 = m.geometry.attributes.position;
            for (let i = 0; i < p2.count; i++) {
                const k = 0.88 + Math.random() * 0.24;
                p2.setXYZ(i, p2.getX(i) * k, p2.getY(i) * k, p2.getZ(i) * k);
            }
            m.geometry.computeVertexNormals();
            m.position.set(x, y, z);
            m.castShadow = false;
            group.add(m);
            blobs2.push({ mesh: m, rise, spread, delay, baseY: y, ang: Math.atan2(z, x), r });
            return m;
        };

        // ground fireball
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2;
            addBlob(hotMat, 6 + Math.random() * 4, Math.cos(a) * 4, 3 + Math.random() * 4, Math.sin(a) * 4, 2.5, 0.9, 0);
        }
        // rising stem
        for (let i = 0; i < 9; i++) {
            const t = i / 8;
            addBlob(smokeMat, 4.5 + t * 4.5, (Math.random() - 0.5) * 4, 4 + t * 46, (Math.random() - 0.5) * 4, 5.5 - t * 1.5, 0.5, t * 0.12);
        }
        // cap
        for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
            const rad = 9 + Math.random() * 17;
            addBlob(smokeMat, 10 + Math.random() * 8, Math.cos(a) * rad, 54 + Math.random() * 16, Math.sin(a) * rad, 2.6, 1.5, 0.5 + Math.random() * 0.3);
        }
        // base skirt. Kept tight on purpose: a fast-spreading skirt swallows the
        // camera and the player ends up staring at flat brown fog.
        for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            addBlob(smokeMat, 7 + Math.random() * 4, Math.cos(a) * 11, 4, Math.sin(a) * 11, 0.8, 1.6, 0.15);
        }

        this.active.push({ kind: 'nuke', group, blobs: blobs2, life: 12, max: 12 });

        // expanding shock ring on the ground
        const ringGeo = new THREE.RingGeometry(1, 1.6, 64);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffe0a8, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending, depthWrite: false
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(pos.x, 0.4, pos.z);
        this.scene.add(ring);
        this.active.push({ kind: 'ring', mesh: ring, life: 2.6, max: 2.6, onTick });
    }

    // ── frame ───────────────────────────────────────────────────────────────
    update(dt, camera) {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const e = this.active[i];
            let dead = false;

            switch (e.kind) {
                case 'tracer': {
                    e.travelled += e.speed * dt;
                    const m = e.slot.mesh;
                    const head = Math.min(e.travelled, e.dist);
                    const tail = Math.max(0, head - e.len);
                    const seg = head - tail;
                    if (seg <= 0.01 || e.travelled > e.dist + e.len) { dead = true; break; }
                    m.position.copy(e.from).addScaledVector(e.dir, (head + tail) / 2);
                    m.lookAt(this._v.copy(m.position).addScaledVector(e.dir, 1));
                    m.scale.set(1, 1, seg);
                    m.material.opacity = 0.9 * Math.min(1, seg / e.len);
                    break;
                }
                case 'spark': {
                    e.life -= dt;
                    if (e.life <= 0) { dead = true; break; }
                    e.vel.y -= e.gravity * dt;
                    e.slot.mesh.position.addScaledVector(e.vel, dt);
                    e.slot.mesh.material.opacity = Math.min(1, e.life * 4);
                    break;
                }
                case 'shell': {
                    e.life -= dt;
                    if (e.life <= 0) { dead = true; break; }
                    e.vel.y -= e.gravity * dt;
                    const m = e.slot.mesh;
                    m.position.addScaledVector(e.vel, dt);
                    m.rotation.x += e.spin.x * dt;
                    m.rotation.y += e.spin.y * dt;
                    m.rotation.z += e.spin.z * dt;
                    if (m.position.y < 0.012) {
                        m.position.y = 0.012;
                        e.vel.y *= -0.28; e.vel.x *= 0.55; e.vel.z *= 0.55;
                        e.spin.multiplyScalar(0.5);
                    }
                    break;
                }
                case 'puff':
                case 'billboard': {
                    e.life -= dt;
                    if (e.life <= 0) { dead = true; break; }
                    const m = e.slot.mesh;
                    if (e.kind === 'puff') {
                        m.position.y += (e.rise || 0) * dt;
                        if (e.drift) m.position.addScaledVector(e.drift, dt);
                        m.scale.multiplyScalar(1 + (e.grow || 1) * dt * 0.55);
                        m.material.opacity = Math.max(0, (e.life / (e.max || 1)) * 0.7);
                    } else {
                        e.vel.y -= e.gravity * dt;
                        m.position.addScaledVector(e.vel, dt);
                        m.scale.multiplyScalar(1 + (e.grow || 1) * dt * 0.6);
                        m.material.opacity = Math.max(0, e.life * 2.2);
                    }
                    if (camera) m.quaternion.copy(camera.quaternion);
                    break;
                }
                case 'nuke': {
                    e.life -= dt;
                    const age = e.max - e.life;
                    for (const b of e.blobs) {
                        const t = age - b.delay;
                        if (t < 0) { b.mesh.visible = false; continue; }
                        b.mesh.visible = true;
                        b.mesh.position.y = b.baseY + b.rise * t;
                        b.mesh.position.x += Math.cos(b.ang) * b.spread * dt;
                        b.mesh.position.z += Math.sin(b.ang) * b.spread * dt;
                        b.mesh.rotation.y += dt * 0.12;
                        b.mesh.rotation.x += dt * 0.05;
                        const grow = 1 + Math.min(t, 6) * 0.10;
                        b.mesh.scale.setScalar(grow);
                        // fade in fast, hold, then dissipate
                        const fadeIn = Math.min(1, t * 3.2);
                        const fadeOut = Math.min(1, e.life / 3.5);
                        b.mesh.material.opacity = 0.92 * fadeIn * fadeOut;
                    }
                    if (e.life <= 0) {
                        for (const b of e.blobs) { b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
                        this.scene.remove(e.group);
                        this.active.splice(i, 1);
                        continue;
                    }
                    break;
                }
                case 'ring': {
                    e.life -= dt;
                    const k = 1 - e.life / e.max;
                    e.mesh.scale.setScalar(1 + k * 78);
                    e.mesh.material.opacity = 0.85 * (1 - k) * (1 - k);
                    if (e.onTick) e.onTick(k);
                    if (e.life <= 0) {
                        this.scene.remove(e.mesh);
                        e.mesh.geometry.dispose(); e.mesh.material.dispose();
                        this.active.splice(i, 1);
                        continue;
                    }
                    break;
                }
            }

            if (dead) {
                if (e.slot) { e.slot.mesh.visible = false; e.slot.busy = false; }
                this.active.splice(i, 1);
            }
        }

        for (const l of this.lights) {
            if (l.life > 0) {
                l.life -= dt;
                const k = Math.max(0, l.life / l.max);
                l.light.intensity = l.peak * k * k;
                if (l.life <= 0) { l.light.intensity = 0; l.peak = 0; }
            }
        }
    }

    clearHoles() {
        for (const h of this.holes) h.visible = false;
    }
}
