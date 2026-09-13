// ============================================================================
// shaders.js — post-processing stack.
//   RenderPass → Viewmodel → Bloom → Grade(+FXAA) → Output
//
// The viewmodel is composited before grading so the gun sits in the same colour
// space as the world.  Antialiasing is folded into the grade pass: a separate
// FXAA pass costs an extra full-screen read/write for no visual gain.
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

class ViewmodelPass extends Pass {
    constructor(vm) {
        super();
        this.vm = vm;
        this.needsSwap = false;
    }
    render(renderer, writeBuffer, readBuffer) {
        if (!this.vm || !this.enabled) return;
        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        const prev = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.vm.scene, this.vm.camera);
        renderer.autoClear = prev;
    }
}

const GradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        time: { value: 0 },
        saturation: { value: 1.02 },
        contrast: { value: 1.09 },
        lift: { value: 0.004 },
        vignette: { value: 0.34 },
        grain: { value: 0.030 },
        aberration: { value: 0.0009 },
        sharpen: { value: 0.22 },
        damage: { value: 0.0 },       // red push when hurt
        death: { value: 0.0 },        // desaturate + crush when killed
        whiteout: { value: 0.0 },     // nuke
        aa: { value: 1.0 }            // 0 disables the edge pass
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float time, saturation, contrast, lift, vignette, grain,
                      aberration, sharpen, damage, death, whiteout, aa;
        varying vec2 vUv;

        const vec3 LUMA = vec3(0.299, 0.587, 0.114);
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }

        void main(){
            vec2 uv = vUv;
            vec2 texel = 1.0 / resolution;
            vec2 cen = uv - 0.5;
            float r2 = dot(cen, cen);

            // ── one shared 5-tap neighbourhood feeds the edge resolve AND the
            //    unsharp mask, instead of each fetching its own ──
            vec3 M  = texture2D(tDiffuse, uv).rgb;
            vec3 NW = texture2D(tDiffuse, uv + vec2(-1.0,-1.0)*texel).rgb;
            vec3 NE = texture2D(tDiffuse, uv + vec2( 1.0,-1.0)*texel).rgb;
            vec3 SW = texture2D(tDiffuse, uv + vec2(-1.0, 1.0)*texel).rgb;
            vec3 SE = texture2D(tDiffuse, uv + vec2( 1.0, 1.0)*texel).rgb;

            vec3 c = M;
            float lM=dot(M,LUMA), lNW=dot(NW,LUMA), lNE=dot(NE,LUMA), lSW=dot(SW,LUMA), lSE=dot(SE,LUMA);
            float mn = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
            float mx = max(lM, max(max(lNW,lNE), max(lSW,lSE)));

            if (aa > 0.5 && mx - mn >= max(0.0312, mx * 0.115)) {
                vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));
                float rcp = 1.0 / (min(abs(dir.x),abs(dir.y)) + max((lNW+lNE+lSW+lSE)*0.03125, 0.0078125));
                dir = clamp(dir*rcp, vec2(-8.0), vec2(8.0)) * texel;
                vec3 A = 0.5*(texture2D(tDiffuse, uv+dir*(1.0/3.0-0.5)).rgb +
                              texture2D(tDiffuse, uv+dir*(2.0/3.0-0.5)).rgb);
                vec3 B = A*0.5 + 0.25*(texture2D(tDiffuse, uv-dir*0.5).rgb +
                                       texture2D(tDiffuse, uv+dir*0.5).rgb);
                float lB = dot(B, LUMA);
                c = (lB < mn || lB > mx) ? A : B;
            }

            // unsharp mask from the taps already in hand
            if (sharpen > 0.001) {
                vec3 blur = (NW + NE + SW + SE) * 0.25;
                c += (c - blur) * sharpen * 0.75;
            }

            // Chromatic aberration as a per-channel delta against the centre
            // tap. Re-running the edge resolve per channel triples the texture
            // reads for an effect nobody can see.
            float ab = aberration * (0.25 + r2 * 3.0);
            if (ab > 0.00001) {
                float rShift = texture2D(tDiffuse, uv - cen * ab).r - M.r;
                float bShift = texture2D(tDiffuse, uv + cen * ab).b - M.b;
                c.r += rShift;
                c.b += bShift;
            }

            float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

            // filmic split tone: warm highlights, faintly cool shadows
            c += vec3(0.028, 0.014, -0.010) * lum;
            c += vec3(-0.004, 0.001, 0.011) * (1.0 - lum) * 0.8;

            c = mix(vec3(lum), c, saturation);
            c = (c - 0.5) * contrast + 0.5 + lift;

            // damage tint
            c = mix(c, vec3(min(1.0, c.r * 1.5 + 0.18), c.g * 0.55, c.b * 0.55), damage);

            // death: drain colour toward a cold grey, but stay readable —
            // you should still be able to see what killed you
            if (death > 0.001) {
                vec3 grey = vec3(lum);
                vec3 dead = mix(grey, grey * vec3(1.22, 0.78, 0.74), 0.65) * 0.80;
                c = mix(c, dead, death);
            }

            // vignette (tightens as you die)
            c *= 1.0 - r2 * (vignette + death * 0.55) * 1.6;

            // grain, animated
            float g = hash(uv * resolution * 0.5 + fract(time) * 91.7) - 0.5;
            c += g * grain * (1.25 - lum * 0.6);

            c = mix(c, vec3(1.0), whiteout);
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`
};

export function createPostFX(renderer, scene, camera, viewmodel) {
    // drawing-buffer pixels, not CSS pixels — the edge resolve and grain need
    // the real texel size or they sample at the wrong scale on HiDPI displays
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const vmPass = new ViewmodelPass(viewmodel);
    composer.addPass(vmPass);

    // Bloom runs at half resolution: it is by far the most expensive pass and
    // at this strength the difference is not visible.
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * 0.5, size.y * 0.5), 0.34, 0.62, 0.92);
    composer.addPass(bloom);

    const grade = new ShaderPass(GradeShader);
    grade.uniforms.resolution.value.set(size.x, size.y);
    composer.addPass(grade);

    composer.addPass(new OutputPass());

    return {
        composer, grade, bloom, vmPass,
        setSize(w, h) {
            composer.setSize(w, h);
            grade.uniforms.resolution.value.set(w, h);
            bloom.setSize(w * 0.5, h * 0.5);
        },
        /** 0 = low, 1 = medium, 2 = high */
        setQuality(q) {
            bloom.enabled = q >= 1;
            const u = grade.uniforms;
            u.aa.value = q >= 1 ? 1 : 0;
            u.sharpen.value = q >= 1 ? 0.22 : 0.0;
            u.aberration.value = q >= 2 ? 0.0009 : 0.0;
            u.grain.value = q >= 1 ? 0.030 : 0.012;
        }
    };
}
