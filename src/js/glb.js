// ============================================================================
// glb.js — one shared, configured GLTFLoader for every .glb in the game.
//
// Two things live here that every loader in the project needs:
//   • the meshopt decoder, because the web build ships .glb files compressed
//     with EXT_meshopt_compression (a ~4x download saving on the model set),
//   • a single loader instance, so the decoder wasm is only ever spun up once
//     and the parser's internal caches are shared between the character layer
//     and the viewmodel layer.
//
// Everything keeps working if a .glb is uncompressed or missing: GLTFLoader
// only consults the decoder for bufferViews that carry the extension, and the
// callers already fall back to their procedural meshes on any rejection.
// ============================================================================
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let shared = null;

/** The shared GLTFLoader, created on first use. Never throws. */
export function glbLoader() {
    if (!shared) {
        shared = new GLTFLoader();
        try {
            shared.setMeshoptDecoder(MeshoptDecoder);
        } catch (err) {
            // An uncompressed asset set still loads; only the decoder is lost.
            console.warn('[glb] meshopt decoder unavailable —', err.message);
        }
    }
    return shared;
}

/**
 * Load a .glb and resolve to the parsed gltf, or null on any failure.
 * `silent` keeps the console clean for the optional asset layers, which log
 * their own single warning per problem.
 */
export function loadGLB(url, silent = false) {
    return glbLoader().loadAsync(url).catch(err => {
        if (!silent) console.warn('[glb] could not load ' + url + ' —', (err && err.message) || err);
        return null;
    });
}
