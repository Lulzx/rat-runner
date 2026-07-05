# Rat Runner

Third-person rat sandbox built on three.js, using the CC-BY ["Black Rat (Free download)"](https://sketchfab.com/3d-models/black-rat-free-download-3db3acb4140d4de8bd62a171212bad9c) model by [NestaEric](https://sketchfab.com/Nestaeric).

Run any static server in this directory (e.g. `python3 -m http.server`) and open the page. WASD/arrows to move, Shift to run, mouse to look, scroll to zoom, V for wireframe.

## Mobile

Touch devices get their own control scheme: the left half of the screen is a floating **virtual joystick** (push to the rim to run), the right half is **drag to look**, and a second finger **pinches to zoom**. The **Gyro** button (top right) enables gyroscope camera control — tilting/turning the phone aims the camera, calibrated to the phone's pose when enabled so the view never snaps; drag still works on top of it. On iOS the tap-to-play gesture triggers the required motion-permission prompt.

## Performance

- **Quality tiers**: mobile defaults to `low` (2× MSAA, no SSAO, 1024px shadows, 4× anisotropy, DPR cap 1.5); desktop to `high`. Override with `?quality=low|high`.
- **Adaptive resolution**: frame times are tracked with a ~1 s moving average; below ~40 fps the render scale steps down (to a 0.55 floor), and it steps back up when there's headroom. Disable with `?fixedres` for A/B comparisons.
- `?dpr=1` still force-caps the pixel ratio directly.

## Making the Sketchfab model look right in three.js

Getting the rat to match Sketchfab's render took several non-obvious fixes. Documented here so the debugging doesn't have to be repeated.

### 1. The fur uses two UV sets, and the glTF export lies about which does what

The fur mesh has four UV channels. Checking the accessor ranges in `scene.gltf` revealed the actual layout:

- **TEXCOORD_0** maps the fur shell cards onto the **pelt region** of the atlas — correct *color*, but alpha = 1 everywhere.
- **TEXCOORD_1/2/3** (identical) map the same cards onto the **strand-strip block** (bottom-right of the atlas) — that's where the real fur *alpha* lives, along with a root-to-tip shading gradient.

The exported material samples `baseColorTexture` with UV0 only, so out of the box every fur card renders as a **solid slab** (alpha 1 passes any cutoff) and the rat looks like chunky black plates. The fix (see `peltColorPatch` in `main.js`) re-samples the base color map at `vNormalMapUv` (UV1 — the channel the normal/specular maps already use) and takes **alpha from there**, keeping **color from UV0**, tinted by the strip's root-to-tip gradient.

### 2. The "metallicRoughness" texture is not a metalness map

The model was authored in Sketchfab's **specular-PBR workflow** — that's why the export carries `KHR_materials_specular` and `*_specularf0.png` textures. The `metallicRoughness` texture Sketchfab generates on conversion has ~0.7 in its blue (metalness) channel across the fur. three.js takes that literally, and a 70%-metallic surface under a modest environment renders almost **black**. Sketchfab itself never applies metalness in this workflow. Fix: `metalness = 0`, `metalnessMap = null` on all rat materials; the specular extension still provides reflectance.

### 3. Screen-space AO murders shell fur

Layered fur shells occlude each other constantly, so N8AO at "architectural" strength (intensity 3) crushed the whole rat to black. Intensity 1.0 keeps ground-contact shading without eating the fur. (Sketchfab's SSAO is similarly subtle on this model.)

### 4. Shadow bias at rodent scale

A 50-unit shadow frustum on a 0.6-unit rat means huge texels relative to the body — without `shadow.bias`/`normalBias`, self-shadow acne shows up as black splotches in the fur.

### 5. Anti-aliased alpha test for the strands

Plain `alphaTest` with the exported 0.68 cutoff erodes strand tips into stubble. The default fur path uses MSAA **alpha-to-coverage** with screen-space alpha sharpening (Ben Golus technique), midpoint lowered to 0.45 so the wispy guard hairs survive — that's what gives the spiky silhouette. Alternate modes for comparison: `?fur=blend|hash|mask&cutoff=0.3`.

### 6. Sketchfab's "Final Render" is mostly post-processing

The difference between Sketchfab's *No Post-Processing* and *Final Render* views is a post stack, reproduced here with `postprocessing`:

- HDR pipeline (`HalfFloatType` buffers, 4× MSAA — required for alpha-to-coverage fur; 2× on the low tier), tone mapping deferred to the end in float precision (`renderer.toneMapping = NoToneMapping`).
- Bloom (subtle, threshold 0.8) → **ACES filmic** tone mapping (no SMAA — MSAA already covers geometric edges, and it can't help alpha-to-coverage fur).
- Then a grade pass: **unsharp-mask sharpen** (this is what makes fur strands read crisp), brightness/contrast lift, saturation boost, soft vignette.

### Credit

This work is based on "Black Rat ( Free download )" (https://sketchfab.com/3d-models/black-rat-free-download-3db3acb4140d4de8bd62a171212bad9c) by NestaEric (https://sketchfab.com/Nestaeric) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
