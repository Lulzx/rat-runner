import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import {
  EffectComposer, RenderPass, EffectPass,
  SMAAEffect, BloomEffect, ToneMappingEffect, ToneMappingMode,
  BrightnessContrastEffect, HueSaturationEffect, VignetteEffect,
  Effect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

// ---------- Scene basics ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6c7d95);
scene.fog = new THREE.Fog(0x6c7d95, 30, 90);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Tone mapping happens in the post stack's final pass, in full float precision
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

// Post-processing: HDR pipeline with 8x MSAA (keeps fur alpha-to-coverage alive),
// N8AO ground-truth ambient occlusion, subtle bloom, SMAA, ACES tone mapping.
const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
  multisampling: 8,
});
composer.addPass(new RenderPass(scene, camera));
const aoPass = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
aoPass.configuration.aoRadius = 0.12;       // scene is rat-scale (~0.6 units)
aoPass.configuration.distanceFalloff = 0.4;
// Keep AO gentle: layered fur shells occlude each other, so strong AO
// crushes the whole rat to black (Sketchfab applies no SSAO to the model).
aoPass.configuration.intensity = 1.0;
aoPass.setQualityMode('Ultra');
composer.addPass(aoPass);
composer.addPass(new EffectPass(
  camera,
  new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.8, mipmapBlur: true }),
  new SMAAEffect(),
  new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
));

// Sketchfab "Final Render" grade: unsharp mask (crisps up the fur strands),
// contrast + saturation lift, and a soft vignette.
class SharpenEffect extends Effect {
  constructor(strength = 0.6) {
    super('SharpenEffect', /* glsl */`
      uniform float strength;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 blur =
          texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb +
          texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb +
          texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb +
          texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb;
        vec3 sharp = inputColor.rgb + (inputColor.rgb - blur * 0.25) * strength;
        outputColor = vec4(max(sharp, 0.0), inputColor.a);
      }`,
      { uniforms: new Map([['strength', new THREE.Uniform(strength)]]) });
  }
}
composer.addPass(new EffectPass(
  camera,
  new SharpenEffect(0.6),
  new BrightnessContrastEffect({ brightness: 0.02, contrast: 0.15 }),
  new HueSaturationEffect({ saturation: 0.2 }),
  new VignetteEffect({ offset: 0.25, darkness: 0.55 }),
));

// Image-based environment lighting (what makes PBR materials pop on Sketchfab).
// Synthetic room env as instant fallback, replaced by the outdoor HDRI once loaded.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;

// Sketchfab-style soft studio lighting by default; ?env=meadow for outdoor
const envFile = new URLSearchParams(location.search).get('env') === 'meadow' ? './env.hdr' : './studio.hdr';
new RGBELoader().load(envFile, (hdr) => {
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose();
  scene.environment = envMap;
  scene.environmentIntensity = 1.2;
});

// Surface any runtime error on screen instead of failing silently
addEventListener('error', (e) => {
  statusEl.textContent = `Error: ${e.message}`;
  statusEl.style.color = '#ff7b7b';
});

// Lights
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a2f28, 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -25; sun.shadow.camera.right = 25;
sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
// 50-unit shadow frustum vs a 0.6-unit rat: without bias the fur
// self-shadows into black splotches
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.05;
scene.add(sun);

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: 0x4a5240, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(300, 150, 0x666666, 0x333a33);
grid.position.y = 0.01;
scene.add(grid);

// A few scattered boxes for spatial reference
const boxMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.9 });
for (let i = 0; i < 24; i++) {
  const s = 0.5 + Math.random() * 2.5;
  const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), boxMat);
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 60;
  box.position.set(Math.cos(a) * r, s / 2, Math.sin(a) * r);
  box.rotation.y = Math.random() * Math.PI;
  box.castShadow = box.receiveShadow = true;
  scene.add(box);
}

// ---------- Player ----------
const player = new THREE.Group();
scene.add(player);

let mixer = null;
let currentAction = null;
let locoState = 'idle';
let pendingNext = null;   // what to play when a one-shot transition clip finishes
const clipSets = { idle: [], walk: [], run: [] };
const startClips = {};    // walk -> walk_start_A, run -> run_start_A
const endClips = {};      // walk -> walk_end_A,  run -> run_end_A

const statusEl = document.getElementById('status');
const loader = new GLTFLoader();

loader.load(
  './model/scene.gltf',
  (gltf) => {
    const model = gltf.scene;

    // Normalize scale so the rat is ~0.6 units long regardless of source units
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    model.scale.setScalar(0.6 / maxDim);

    // Sit it on the ground
    box.setFromObject(model);
    model.position.y -= box.min.y;

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const mat = o.material;
        if (mat?.map) mat.map.anisotropy = maxAniso;
        // The model was authored in Sketchfab's specular-PBR workflow (see the
        // KHR_materials_specular + specularf0 textures). The exported
        // "metallicRoughness" blue channel is ~0.7 in the fur region, which
        // three.js takes literally — a 70%-metallic rat renders black under
        // the environment. Sketchfab ignores metalness in this workflow.
        if (mat) {
          mat.metalness = 0;
          mat.metalnessMap = null;
        }
        // The fur uses alpha-MASK with a harsh 0.68 cutoff, which chops the
        // strand textures into solid clumps. Try ?fur=blend|hash|mask&cutoff=0.3
        if (mat && mat.alphaTest > 0) {
          const params = new URLSearchParams(location.search);
          const mode = params.get('fur') || 'a2c';
          const cutoff = parseFloat(params.get('cutoff') || '0.3');
          if (params.has('nomip') && mat.map) {
            mat.map.generateMipmaps = false;
            mat.map.minFilter = THREE.LinearFilter;
            mat.map.needsUpdate = true;
          }
          // The Sketchfab->glTF conversion loses the original two-UV fur setup.
          // UV0 maps the fur cards onto the PELT region of the atlas (correct
          // color, but alpha=1 — that's why cards rendered as solid slabs),
          // while UV1 (the channel the normal/specular maps use) maps them onto
          // the strand-strip block that carries the real fur ALPHA. Take color
          // from UV0 and re-sample the strip at UV1 for alpha + tip shading.
          const peltColorPatch = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <map_fragment>',
              `#include <map_fragment>
              #ifdef USE_NORMALMAP
                vec4 strandStrip = texture2D( map, vNormalMapUv );
                diffuseColor.a = strandStrip.a;
                // root-to-tip gradient: darken roots, let tips catch light
                diffuseColor.rgb *= (0.6 + 0.8 * strandStrip.rgb);
              #endif
              ${mode === 'a2c' ? `
              diffuseColor.a = clamp((diffuseColor.a - 0.45) / max(fwidth(diffuseColor.a), 0.0001) + 0.5, 0.0, 1.0);
              if (diffuseColor.a < 0.01) discard;` : ''}`
            );
          };
          mat.onBeforeCompile = peltColorPatch;
          mat.customProgramCacheKey = () => 'fur-' + mode;
          if (mode === 'a2c') {
            // Anti-aliased alpha test (Ben Golus technique): MSAA alpha-to-coverage
            // with screen-space alpha sharpening so thin fur strands survive
            // mipmapping instead of eroding into solid cards.
            mat.alphaTest = 0;
            mat.alphaToCoverage = true;
            mat.transparent = false;
            mat.depthWrite = true;
          } else if (mode === 'blend') {
            // Sorted alpha blending — closest to Sketchfab's fur rendering
            mat.transparent = true;
            mat.alphaTest = 0.05;   // discard near-invisible pixels to avoid halos
            mat.depthWrite = false;
            o.renderOrder = 1;
          } else if (mode === 'hash') {
            mat.alphaTest = 0;
            mat.alphaHash = true;
            mat.depthWrite = true;
          } else {
            mat.alphaTest = cutoff;
          }
          mat.needsUpdate = true;
        }
      }
    });
    player.add(model);

    // Animations: pick idle/walk/run by name, with fallbacks
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) {
        const n = clip.name.split('|').pop().toLowerCase();
        if (n.startsWith('idle')) clipSets.idle.push(clip);
        else if (n === 'walk_start_a') startClips.walk = clip;
        else if (n === 'walk_end_a') endClips.walk = clip;
        else if (n === 'run_start_a') startClips.run = clip;
        else if (n === 'run_end_a') endClips.run = clip;
        else if (n.startsWith('walk')) clipSets.walk.push(clip);
        else if (n.startsWith('run')) clipSets.run.push(clip);
      }
      mixer.addEventListener('finished', (e) => {
        if (e.action !== currentAction || !pendingNext) return;
        const next = pendingNext;
        pendingNext = null;
        next();
      });
      playLoop('idle');
      statusEl.textContent =
        `Animations: ${clipSets.idle.length} idle, ${clipSets.walk.length} walk, ` +
        `${clipSets.run.length} run, ${Object.keys(startClips).length + Object.keys(endClips).length} transitions`;
    } else {
      statusEl.textContent = 'Model loaded (no animations found)';
    }
  },
  (xhr) => {
    if (xhr.total) statusEl.textContent = `Loading rat… ${Math.round((xhr.loaded / xhr.total) * 100)}%`;
  },
  (err) => {
    console.warn('rat.glb not found, using placeholder', err);
    statusEl.textContent = 'rat.glb not found — using placeholder. Put rat.glb next to index.html';
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.35, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x555560, roughness: 0.6 })
    );
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.18;
    body.castShadow = true;
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.18, 10),
      new THREE.MeshStandardMaterial({ color: 0xcc8899 })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.18, 0.38);
    nose.castShadow = true;
    player.add(body, nose);
  }
);

function fadeTo(clip, { once = false, fade = 0.2 } = {}) {
  const next = mixer.clipAction(clip);
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.reset().fadeIn(fade).play();
  if (currentAction && currentAction !== next) currentAction.fadeOut(fade);
  currentAction = next;
}

const pickClip = (arr) => arr[Math.floor(Math.random() * arr.length)];

function playLoop(state) {
  if (state === 'idle') {
    // each idle variation plays once, then chains to a random next idle
    fadeTo(pickClip(clipSets.idle), { once: true, fade: 0.3 });
    pendingNext = () => playLoop('idle');
  } else {
    fadeTo(pickClip(clipSets[state]));
    pendingNext = null;
  }
}

function setLoco(to) {
  if (to === locoState || !mixer || !clipSets.idle.length) return;
  const from = locoState;
  locoState = to;
  pendingNext = null;
  if (to === 'idle' && endClips[from]) {
    // play the stop transition (walk_end_A / run_end_A), then idle
    fadeTo(endClips[from], { once: true });
    pendingNext = () => playLoop('idle');
  } else if (from === 'idle' && startClips[to]) {
    // play the start transition (walk_start_A / run_start_A), then loop
    fadeTo(startClips[to], { once: true });
    pendingNext = () => playLoop(to);
  } else {
    // walk <-> run switch mid-motion: crossfade loops directly
    playLoop(to);
  }
}

// ---------- Input ----------
const keys = new Set();
// Sketchfab-style wireframe: plain dark lines, no textures/lighting
let wireframe = false;
const wireMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, wireframe: true });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && !e.repeat) {
    wireframe = !wireframe;
    player.traverse((o) => {
      if (!o.isMesh) return;
      if (wireframe) {
        o.userData.origMat = o.material;
        o.material = wireMat;
      } else if (o.userData.origMat) {
        o.material = o.userData.origMat;
      }
    });
    scene.background.set(wireframe ? 0xb5aab5 : 0x6c7d95);
    if (scene.fog) scene.fog.color.copy(scene.background);
  }
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const pressed = (...codes) => codes.some((c) => keys.has(c));

// Mouse look via pointer lock
let yaw = 0;      // horizontal orbit angle
let pitch = 0.22; // vertical angle
const overlay = document.getElementById('overlay');
overlay.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0025;
  pitch += e.movementY * 0.0025;
  pitch = Math.max(0.05, Math.min(1.2, pitch));
});

// ---------- Movement ----------
const WALK_SPEED = 2.2;
const RUN_SPEED = 6.0;
const TURN_LERP = 12;
const velocity = new THREE.Vector3();
let playerHeading = 0;

let camDist = 0.9;
const CAM_MIN = 0.12, CAM_MAX = 30;
addEventListener('wheel', (e) => {
  camDist = THREE.MathUtils.clamp(camDist * (1 + e.deltaY * 0.001), CAM_MIN, CAM_MAX);
}, { passive: true });
const camTarget = new THREE.Vector3();

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Input direction (camera-relative)
  let ix = 0, iz = 0;
  if (pressed('KeyW', 'ArrowUp')) iz += 1;
  if (pressed('KeyS', 'ArrowDown')) iz -= 1;
  if (pressed('KeyA', 'ArrowLeft')) ix += 1;
  if (pressed('KeyD', 'ArrowRight')) ix -= 1;

  const moving = ix !== 0 || iz !== 0;
  const running = moving && pressed('ShiftLeft', 'ShiftRight');
  const speed = running ? RUN_SPEED : WALK_SPEED;

  if (moving) {
    // Build world-space direction from camera yaw
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const dir = new THREE.Vector3()
      .addScaledVector(forward, iz)
      .addScaledVector(right, -ix)
      .normalize();

    velocity.lerp(dir.clone().multiplyScalar(speed), 1 - Math.exp(-10 * dt));

    // Smoothly face movement direction
    const targetHeading = Math.atan2(dir.x, dir.z);
    let diff = targetHeading - playerHeading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    playerHeading += diff * Math.min(1, TURN_LERP * dt);
    player.rotation.y = playerHeading;
  } else {
    velocity.lerp(new THREE.Vector3(), 1 - Math.exp(-12 * dt));
  }

  player.position.addScaledVector(velocity, dt);
  // keep inside the ground plane
  player.position.x = THREE.MathUtils.clamp(player.position.x, -145, 145);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -145, 145);

  // Animation state
  if (mixer) {
    setLoco(!moving || velocity.length() < 0.1 ? 'idle' : running ? 'run' : 'walk');
    mixer.update(dt);
  }

  // Third-person camera orbit
  camTarget.copy(player.position).add(new THREE.Vector3(0, 0.15, 0));
  const camOffset = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  ).multiplyScalar(camDist);
  camera.position.copy(camTarget).add(camOffset);
  if (camera.position.y < 0.15) camera.position.y = 0.15;
  camera.lookAt(camTarget);

  composer.render();
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
