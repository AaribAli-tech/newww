// ============================================================================
// rebel-pose.js — the numbers that make the imported FBX look like a soldier.
//
// Shared by src/js/rebel.js (bots in a match) and src/tester/tester.js (the
// stand-alone model page), because both drive the same file and a pose that is
// right in one and wrong in the other is a trap. Nothing in here touches the DOM
// or WebGL, so scripts/test-rules.mjs can assert on it.
//
// WHY THE FLIP EXISTS
// The file (Modern Rebel Soldier, call-of-duty-asset-for-person) is bound with
// every limb folded up along the body: with all bones at rotation 0 the
// hip→knee, knee→ankle, shoulder→elbow and elbow→hand offsets all measure
// (0, +1, 0) and 14 of its 15 meshes are rigid parts parented to bones rather
// than skinned. So a bone at zero is an arms-up ragdoll, and any walk cycle
// played on top of it looks like surrender. Half a turn about X on the four
// root limb bones puts the limbs where a human's are — and because it is the
// same axis the animation uses, the bone's local X axis still points the same
// way, so a positive angle still swings a limb forwards and a knee still bends
// backwards. Both of those were measured on the rig, not guessed.
// ============================================================================

/** Standing correction, in radians, applied underneath every animation angle. */
export const STAND_FLIP = {
    LeftUpLeg: Math.PI, RightUpLeg: Math.PI,
    LeftArm: Math.PI, RightArm: Math.PI
};

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
