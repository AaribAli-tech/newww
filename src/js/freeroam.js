// ============================================================================
// freeroam.js — the camera you fly when you are dead.
//
// Round Control (and any mode that keeps you down) used to hand your view to a
// surviving teammate's eyes. That is a hard thing to get right: the shot has to
// be threaded behind someone standing in a doorway, and the moment it is
// obstructed the player is watching geometry instead of the round.
//
// So this is the Counter-Strike answer instead — you leave your corpse and fly.
// No collision, no follow cam, no owner: the whole map is a review reel, and you
// point the camera at whatever fight you want to see.
//
// The maths is deliberately free of three.js and of the DOM, so scripts/test-rules.mjs
// can run it in Node: the direction keys travel, the clamps that keep you off the
// floor and out of the sky, and the way a focus jump frames an operator are all
// assertable here without a browser. `apply()` writes into whatever camera object
// you hand it, which is the only place the renderer is touched.
// ============================================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export const ROAM = {
    // A walking pace reads as "the camera is broken" when you are 40 m away
    // looking for a firefight; a flight through the map wants a car, not a jog.
    speed: 11.5,          // m/s at the default pace
    sprint: 2.35,         // Shift
    creep: 0.34,          // Ctrl — for lining up a shot on a rooftop without flying past it
    vert: 8.5,            // m/s on Space / C
    accel: 16,            // how fast the damped velocity reaches the wanted one
    pitchLimit: 1.52,     // rad — 1.52 keeps the horizon out of a gimbal flip
    turnSens: 0.0016,     // rad per mouse pixel at sensitivity 1.00 (same feel as the player)
    keyTurn: 1.5,         // rad/s on the arrow keys, for anyone with a broken mouse
    floor: 0.35,          // never sink under the ground
    ceil: 62,             // above this the map is a toy and the far plane starts clipping
    fov: 96,              // wider than the player's: you are watching people, not sights
    focusBack: 5.4,       // where a focus jump parks you…
    focusUp: 2.4,         // …and how high
    // The map plus a margin, so you can orbit the outside of the houses. Going
    // through a wall is fine; falling off the world is not.
    bounds: { minX: -62, maxX: 62, minZ: -60, maxZ: 58 }
};

/**
 * @param {object} [opts] - overrides for the constants above (tests, future maps).
 */
export function createFreeRoam(opts = {}) {
    const R = { ...ROAM, ...opts, bounds: { ...ROAM.bounds, ...(opts.bounds || {}) } };
    const pos = { x: 0, y: 1.6, z: 0 };
    const vel = { x: 0, y: 0, z: 0 };
    const want = { x: 0, y: 0, z: 0 };
    const api = {
        active: false,
        pos, vel,
        yaw: 0,
        pitch: 0,
        keys: Object.create(null),
        // who the last focus jump framed, if anyone (the HUD labels it)
        watching: null,
        prevFov: 0,
        prevPos: null,
        prevRot: null,

        /** Take the camera over from wherever it is (the end of a death fall). */
        enter(camera, look = null) {
            if (camera) {
                this.prevFov = camera.fov;
                this.prevPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
                this.prevRot = { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z, order: camera.rotation.order };
                pos.x = camera.position.x;
                pos.y = Math.max(R.floor + 0.6, camera.position.y + 1.35);
                pos.z = camera.position.z;
                // Face the way the corpse was facing, unless we were told otherwise:
                // the first frame of free roam should not spin the world around.
                this.yaw = look ? look.yaw : (camera.rotation.order === 'YXZ' ? camera.rotation.y : this.yaw);
                this.pitch = look ? look.pitch : (camera.rotation.order === 'YXZ' ? camera.rotation.x : 0);
            }
            vel.x = vel.y = vel.z = 0;
            this.keys = Object.create(null);
            this.active = true;
            this.watching = null;
        },

        /** Hand the camera back, orientation and FOV included. */
        exit(camera) {
            this.active = false;
            this.watching = null;
            if (!camera) return;
            if (this.prevPos) { camera.position.set(this.prevPos.x, this.prevPos.y, this.prevPos.z); }
            if (this.prevRot) {
                camera.rotation.order = this.prevRot.order || 'XYZ';
                camera.rotation.set(this.prevRot.x, this.prevRot.y, this.prevRot.z);
            }
            if (this.prevFov && camera.fov !== this.prevFov) { camera.fov = this.prevFov; camera.updateProjectionMatrix(); }
        },

        key(code, down) { this.keys[code] = down; },

        /** Mouse deltas, in pixels, from pointer lock. */
        look(dx, dy, sens = 1) {
            const s = R.turnSens * sens;
            this.yaw = wrap(this.yaw - dx * s);
            this.pitch = clamp(this.pitch - dy * s, -R.pitchLimit, R.pitchLimit);
        },

        /** The same look() maths from another source — a gamepad stick, a test. */
        turn(dx, dy, sens = 1) { this.look(dx, dy, sens); },

        /** Unit forward/right vectors for the current yaw. yaw 0 looks down -Z. */
        forward(out = { x: 0, y: 0, z: 0 }) {
            const cp = Math.cos(this.pitch);
            out.x = -Math.sin(this.yaw) * cp;
            out.y = Math.sin(this.pitch);
            out.z = -Math.cos(this.yaw) * cp;
            return out;
        },
        right(out = { x: 0, y: 0, z: 0 }) {
            out.x = Math.cos(this.yaw);
            out.y = 0;
            out.z = -Math.sin(this.yaw);
            return out;
        },

        /**
         * One step of flight. `dt` in seconds. Returns the distance moved, which
         * is what the HUD uses to decide whether to show a speed line, and what
         * the tests assert on.
         */
        update(dt, camera = null) {
            if (!this.active || !(dt > 0)) return 0;
            const k = this.keys;
            let fwd = 0, strafe = 0, up = 0;
            if (k.KeyW) fwd += 1;
            if (k.KeyS) fwd -= 1;
            if (k.KeyD) strafe += 1;
            if (k.KeyA) strafe -= 1;
            if (k.Space || k.KeyE) up += 1;
            if (k.KeyC || k.ControlLeft || k.KeyQ) up -= 1;
            // Arrow keys look as well, so the camera is drivable with no mouse.
            if (k.ArrowLeft) this.yaw = wrap(this.yaw + R.keyTurn * dt);
            if (k.ArrowRight) this.yaw = wrap(this.yaw - R.keyTurn * dt);
            if (k.ArrowUp) this.pitch = clamp(this.pitch + R.keyTurn * dt, -R.pitchLimit, R.pitchLimit);
            if (k.ArrowDown) this.pitch = clamp(this.pitch - R.keyTurn * dt, -R.pitchLimit, R.pitchLimit);

            const pace = k.ShiftLeft || k.ShiftRight ? R.speed * R.sprint : (k.ControlRight ? R.speed * R.creep : R.speed);
            const f = this.forward(), r = this.right();
            const fl = Math.hypot(f.x, f.z) || 1;
            want.x = ((f.x / fl) * fwd + r.x * strafe) * pace;
            want.z = ((f.z / fl) * fwd + r.z * strafe) * pace;
            want.y = up * R.vert * (pace / R.speed);      // a creep should creep vertically too
            // Idle drift toward zero, so releasing the keys settles instead of sliding.
            if (!fwd && !strafe) { want.x = 0; want.z = 0; }
            if (!up) want.y = 0;

            // Exponential approach: frame-rate independent, so a 30 fps machine and
            // a 240 fps one both reach the wanted velocity in the same wall-clock
            // time rather than the fast one snapping and the slow one crawling.
            const a = 1 - Math.exp(-R.accel * dt);
            vel.x += (want.x - vel.x) * a;
            vel.y += (want.y - vel.y) * a;
            vel.z += (want.z - vel.z) * a;
            pos.x += vel.x * dt;
            pos.y += vel.y * dt;
            pos.z += vel.z * dt;

            const b = R.bounds;
            pos.x = clamp(pos.x, b.minX, b.maxX);
            pos.z = clamp(pos.z, b.minZ, b.maxZ);
            pos.y = clamp(pos.y, R.floor, R.ceil);

            this.apply(camera);
            return Math.hypot(vel.x, vel.y, vel.z) * dt;
        },

        /** Write the pose into the render camera. Safe to call with no camera. */
        apply(camera) {
            if (!camera) return;
            camera.position.set(pos.x, pos.y, pos.z);
            camera.rotation.order = 'YXZ';
            camera.rotation.set(this.pitch, this.yaw, 0);
            if (camera.fov !== R.fov) { camera.fov = R.fov; camera.updateProjectionMatrix(); }
        },

        /**
         * Park behind an operator and look at them. This is not a follow cam —
         * the camera stays exactly where this leaves it and the player flies on
         * from there; it only answers "where is the action".
         */
        focusOn(target, camera = null) {
            if (!target || !target.position) return false;
            this.watching = target;
            const yaw = Number.isFinite(target.yaw) ? target.yaw : 0;
            const back = R.focusBack, up = R.focusUp;
            pos.x = clamp(target.position.x + Math.sin(yaw) * back, R.bounds.minX, R.bounds.maxX);
            pos.z = clamp(target.position.z + Math.cos(yaw) * back, R.bounds.minZ, R.bounds.maxZ);
            pos.y = clamp(target.position.y + up, R.floor, R.ceil);
            // Aim at their chest rather than the horizon they are looking at, so
            // the jump always frames a person even if they are aiming at the sky.
            const dx = target.position.x - pos.x, dy = (target.position.y + 1.15) - pos.y, dz = target.position.z - pos.z;
            this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -R.pitchLimit, R.pitchLimit);
            this.yaw = Math.atan2(-dx, -dz);
            vel.x = vel.y = vel.z = 0;
            this.apply(camera);
            return true;
        },

        /** How fast we are going, for the HUD. */
        get speedNow() { return Math.hypot(vel.x, vel.y, vel.z); },
        get bounds() { return R.bounds; },
        constants: R
    };
    return api;
}
