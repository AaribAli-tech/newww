// ============================================================================
// rebel-pose.js — the numbers that make the imported FBX look like a soldier.
//
// Shared by src/js/rebel.js (bots in a match) and src/tester/tester.js (the
// stand-alone model page), because both drive the same file and a pose that is
// right in one and wrong in the other is a trap. Nothing in here touches the DOM
// or WebGL, so scripts/test-rules.mjs can assert on it.
//
// WHY THE POSE IS ADDITIVE
// The file (Modern Rebel Soldier, call-of-duty-asset-for-person) ships STANDING:
// its half-turn is baked into the bones as LeftUpLeg.rotation.z = -3.082 and the
// toes sit on the floor at y = 0.4. An earlier version of this module assumed the
// bones were at zero and wrote `rotation.x = π` on the four limb roots to unfold
// them — which took a standing soldier, tore the legs and arms off their authored
// angles and left the contortion the model tester showed: boots at head height,
// hands behind the head, no visible hands. Writing an animation angle as an
// ASSIGNMENT is the same mistake in another form: it overwrites whatever the
// exporter put there.
//
// So every angle here is a DELTA on top of the pose the file shipped with, on the
// axis that actually flexes that joint, with the sign that direction needs. Both
// were measured on the rig (scripts/test-rules.mjs re-measures them from the FBX
// itself): on this file a positive angle about X swings a thigh forward, and about
// Z raises an arm — with left and right mirrored, so the sign is stored per side
// rather than reasoned about. See POSE_JOINTS.
// ============================================================================

/**
 * Standing correction for a rig that ships FOLDED, applied under every animated
 * angle on that joint's flexion axis (see poseBones). Nothing in this game decides
 * to use it by assumption any more — flipFromJoints measures the rig — but a rig
 * that genuinely ships with its limbs folded up along its body needs exactly this,
 * and the numbers are here so both pages agree on it.
 */
export const STAND_FLIP = {
    LeftUpLeg: Math.PI, RightUpLeg: Math.PI,
    LeftArm: Math.PI, RightArm: Math.PI
};

/** No correction: the pose the file arrived in is already standing. */
export const NO_FLIP = {};

/**
 * Is this limb hanging, or folded up against the body?
 *
 * A limb hangs when the joint at its end sits BELOW the joint it hangs from, so
 * `tipY > rootY + tol` means the knee is above the hip or the hand is above the
 * shoulder — folded. `tol` is a fraction of the torso, which keeps a T-pose (hand
 * level with the shoulder) from reading as folded. Anything unreadable is treated
 * as folded, because the pose this file was verified in is the flipped one.
 */
export function foldedLimb(rootY, tipY, tol = 0) {
    if (!Number.isFinite(rootY) || !Number.isFinite(tipY)) return true;
    return tipY > rootY + tol;
}

/**
 * Work out which limbs need STAND_FLIP by reading the rig, instead of assuming it
 * shipped folded.
 *
 * An FBX can carry its standing pose in the bone transforms or folded into the
 * geometry with the bones at zero, and which of the two it is cannot be told from
 * the file name. A half-turn applied to a rig that already stands folds it the
 * other way — the boots end up where the head is and the hands go behind it, which
 * is exactly how "you mixed the foot with the head and there are no hands" looks.
 *
 * The bounding box is no use for this: a SkinnedMesh's box is its BIND pose no
 * matter what the bones do (the loader never runs skinning), and on this file that
 * box dwarfs the rigid parts, so both candidate poses measured 299.1 units and the
 * decision came down to noise. Joint positions do move with the bones, so compare
 * those: an ankle above the hip is a folded leg, a hand above the chest is a folded
 * arm, whichever units the caller's scene graph happens to use.
 *
 * `pos(boneName)` returns anything with a `y` — a Vector3 is what both pages pass.
 * A joint that cannot be read falls back down the chain, and a limb with nothing
 * readable in it is left alone rather than turned half-way on a guess.
 */
export function flipFromJoints(pos, tol = 0.15) {
    const y = (n) => {
        const p = pos && pos(n);
        const v = p == null ? NaN : (typeof p === 'number' ? p : p.y);
        return Number.isFinite(v) ? v : NaN;
    };
    const hip = y('Hips'), chest = y('Spine2');
    const span = Math.abs(chest - hip);
    const slack = span > 0 ? span * tol : 0;
    const out = {};
    // Deepest joint first: an export that stops at the wrist still has a forearm to
    // compare with the chest, and a limb with nothing readable in it is left exactly
    // as it shipped. You cannot call something folded that you cannot see — inventing
    // a fold for a rig you could not read is how this file got its boots up by its
    // ears in the first place.
    const judge = (from, tips, limb) => {
        const rootY = y(from);
        let tipY = NaN;
        for (const t of tips) { const v = y(t); if (Number.isFinite(v)) { tipY = v; break; } }
        if (!Number.isFinite(rootY) || !Number.isFinite(tipY)) return;
        if (foldedLimb(rootY, tipY, slack)) out[limb] = Math.PI;
    };
    judge('Hips', ['LeftFoot', 'LeftToeBase', 'LeftLeg'], 'LeftUpLeg');
    judge('Hips', ['RightFoot', 'RightToeBase', 'RightLeg'], 'RightUpLeg');
    judge('Spine2', ['LeftHand', 'LeftForeArm'], 'LeftArm');
    judge('Spine2', ['RightHand', 'RightForeArm'], 'RightArm');
    return Object.keys(out).length ? out : NO_FLIP;
}

/**
 * Which axis flexes each joint, and which way is "the human direction" on it.
 *
 * `axis`/`sign` say: to bend this joint the way a person does, add `sign * angle`
 * to `axis`, on top of the rotation the file shipped with. `want` records what that
 * is supposed to do to the far end of the limb, in world terms, and
 * scripts/test-rules.mjs re-measures it from the FBX — so this table cannot silently
 * drift away from the rig it was fitted to. Forward is -Z, the way the model faces.
 *
 * The arms are NOT the same axis as the legs: on this file an arm's flexion lives on
 * its local Z (a shoulder's X lifts the whole arm sideways-overhead, which is what
 * the old code was doing to you in first person), and the two sides are mirrored.
 */
export const POSE_JOINTS = {
    LeftUpLeg: { axis: 'x', sign: 1, want: 'forward', then: 'LeftLeg' },
    RightUpLeg: { axis: 'x', sign: 1, want: 'forward', then: 'RightLeg' },
    LeftLeg: { axis: 'x', sign: 1, want: 'back', then: 'LeftFoot' },
    RightLeg: { axis: 'x', sign: 1, want: 'back', then: 'RightFoot' },
    LeftFoot: { axis: 'x', sign: 1, want: 'up', then: 'LeftToeBase' },
    RightFoot: { axis: 'x', sign: 1, want: 'up', then: 'RightToeBase' },
    LeftArm: { axis: 'z', sign: -1, want: 'forward', then: 'LeftForeArm' },
    RightArm: { axis: 'z', sign: 1, want: 'forward', then: 'RightForeArm' },
    LeftForeArm: { axis: 'z', sign: -1, want: 'forward', then: 'LeftHand' },
    RightForeArm: { axis: 'z', sign: 1, want: 'forward', then: 'RightHand' },
    Spine: { axis: 'x', sign: -1, want: 'forward', then: 'Head' },
    Spine1: { axis: 'x', sign: -1, want: 'forward', then: 'Head' },
    Spine2: { axis: 'x', sign: -1, want: 'forward', then: 'Head' },
    Neck: { axis: 'x', sign: -1 },
    Head: { axis: 'x', sign: -1 },
    LeftToeBase: { axis: 'x', sign: 1 },
    RightToeBase: { axis: 'x', sign: 1 },
    LeftShoulder: { axis: 'y', sign: 1 },
    RightShoulder: { axis: 'y', sign: -1 },
    Hips: { axis: 'y', sign: 1 }
};

/**
 * Capture the rotations the file came with, before anything animates them. The pose
 * is written against this, which is what makes the walk cycle survive a re-export.
 */
export function restPoseOf(bones) {
    const out = {};
    for (const [name, b] of Object.entries(bones)) {
        if (b && b.rotation) out[name] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
    }
    return out;
}

/**
 * Write joint angles onto a rig, additively.
 *
 * `angles` maps a bone to either a number — bend that joint the way POSE_JOINTS
 * says it bends, mirroring included — or to one object `{flex, x, y, z}`: the bend
 * plus any raw turns on top of it, for the cases that are not a flexion at all (a
 * head turning to look, hips tilting in a crouch), where the caller already knows
 * what it means and the numbers are used as given. The object form is what the game
 * passes, because it lives in a per-rig pool that is refilled in place every frame:
 * building a fresh map per bone per frame is how an animation ends up costing
 * garbage collections on top of everything else.
 *
 * Bones not in `angles` are eased back to their shipped rotation rather than zeroed,
 * so a joint that stops being animated returns to standing instead of snapping to
 * whatever a half-finished pose left behind.
 */
export function poseBones(bones, rest, angles, { k = 1, flip = null, easeOthers = true } = {}) {
    if (!bones || !angles) return 0;
    const touched = new Set();
    for (const name in angles) {
        const b = bones[name];
        if (!b || !b.rotation) continue;
        const spec = POSE_JOINTS[name];
        const base = (rest && rest[name]) || ZERO_REST;
        const fold = (flip && flip[name]) || 0;
        const val = angles[name];
        const flex = typeof val === 'number' ? val : val.flex;
        touched.add(name);
        for (const axis of 'xyz') {
            const turn = axis === 'x' ? (val.x || 0) : axis === 'y' ? (val.y || 0) : (val.z || 0);
            const bending = spec && axis === spec.axis ? fold + spec.sign * flex : 0;
            const delta = bending + (typeof val === 'number' ? 0 : turn);
            if (!delta && typeof val === 'number') continue;      // nothing to write on this axis
            if (!Number.isFinite(delta)) continue;
            const want = base[axis] + delta;
            b.rotation[axis] += (want - b.rotation[axis]) * k;
        }
    }
    if (easeOthers) {
        for (const [name, b] of Object.entries(bones)) {
            if (!b || !b.rotation || touched.has(name)) continue;
            const base = (rest && rest[name]) || ZERO_REST;
            for (const axis of 'xyz') {
                if (Math.abs(base[axis]) < 1e-6 && Math.abs(b.rotation[axis]) < 1e-6) continue;
                b.rotation[axis] += (base[axis] - b.rotation[axis]) * k;
            }
        }
    }
    return touched.size;
}
const ZERO_REST = { x: 0, y: 0, z: 0 };

/** How tall a soldier has to be, in metres, whatever the file says. */
export const TARGET_HEIGHT = 1.80;

/** Arms: the walk swing, the idle elbow bend, and the two-handed aim. */
export const ARMS = {
    swing: 0.12,            // both arms drift slightly forward while walking
    elbow: 0.34,            // elbows bend forward; +amp worth more when running
    elbowRun: 0.14,
    aim: { rightArm: 0.85, rightForeArm: 0.45, leftArm: 1.15, leftForeArm: 0.75 },
    recoil: { rightForeArm: 0.5, leftForeArm: 0.35 }
};

/**
 * How much to multiply a rig by so it draws TARGET_HEIGHT.
 *
 * The box measured straight out of an FBX loader is not the box the renderer ends
 * up drawing: pivot and offset transforms only settle once the first matrices are
 * composed, and this file is no exception (it measures 154 units when loaded and
 * 292 once it has actually been rendered). So the pages measure what they drew
 * and correct towards it. Returns 1 when close enough, 0 when the measurement is
 * junk, and the factor otherwise.
 */
export function fitFactor(measured, want = TARGET_HEIGHT, tol = 0.02) {
    if (!Number.isFinite(measured) || measured < 0.05) return 0;
    if (Math.abs(measured - want) / want <= tol) return 1;
    return want / measured;
}
