import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, ToneMappingEffect, ToneMappingMode,
  BrightnessContrastEffect, HueSaturationEffect, VignetteEffect,
  Effect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

// Primary-coarse-pointer devices (phones/tablets) get touch controls, gyro
// look, and a lower DPR cap. Touchscreen laptops keep the desktop scheme,
// though the touch handlers below work there too.
const isTouch = matchMedia('(pointer: coarse)').matches;

// ?quality=low|high overrides; mobile defaults to low (2x MSAA, no SSAO,
// smaller shadow map) — the visual gap is small at phone screen sizes
const urlParams = new URLSearchParams(location.search);
const lowQ = (urlParams.get('quality') || (isTouch ? 'low' : 'high')) === 'low';

// ---------- Scene basics ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6c7d95);
scene.fog = new THREE.Fog(0x6c7d95, 30, 90);

// near plane must stay well inside the minimum zoom distance or extreme
// close-ups clip through the fur shells and expose the hollow body
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 200);

// antialias:false — all rendering goes through the composer's offscreen MSAA
// buffers, so canvas-level AA would only burn memory on the final blit
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
// render resolution is the single biggest GPU cost — ?dpr=1.5 (or 1) trades
// a little fur crispness for a large frame-time win on retina displays
const dprCap = parseFloat(urlParams.get('dpr') || (isTouch ? '1.5' : '2'));
renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = lowQ ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
// Tone mapping happens in the post stack's final pass, in full float precision
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

// Post-processing: HDR pipeline with 4x MSAA (keeps fur alpha-to-coverage alive;
// 8x costs roughly double the bandwidth for no visible gain), N8AO ambient
// occlusion at half resolution, subtle bloom, ACES tone mapping.
const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
  multisampling: lowQ ? 2 : 4,
});
composer.addPass(new RenderPass(scene, camera));
// AO is already subtle here — on the low tier it's the first thing to cut
if (!lowQ) {
  const aoPass = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  aoPass.configuration.aoRadius = 0.12;       // scene is rat-scale (~0.6 units)
  aoPass.configuration.distanceFalloff = 0.4;
  // Keep AO gentle: layered fur shells occlude each other, so strong AO
  // crushes the whole rat to black (Sketchfab applies no SSAO to the model).
  aoPass.configuration.intensity = 1.0;
  // AO is deliberately subtle here, so half-res + Medium is indistinguishable
  // from full-res Ultra but a fraction of the cost
  aoPass.configuration.halfRes = true;
  aoPass.setQualityMode('Medium');
  composer.addPass(aoPass);
}
composer.addPass(new EffectPass(
  camera,
  new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.8, mipmapBlur: true }),
  // no SMAA: 4x MSAA already handles geometric edges, and the fur uses
  // alpha-to-coverage which SMAA can't improve — it only added blur + cost
  new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
));

// Sketchfab "Final Render" grade: unsharp mask (crisps up the fur strands),
// contrast + saturation lift, and a soft vignette.
class SharpenEffect extends Effect {
  constructor(strength = 0.6) {
    super('SharpenEffect', /* glsl */`
      uniform float strength;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 n0 = texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
        vec3 n1 = texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb;
        vec3 n2 = texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb;
        vec3 n3 = texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb;
        vec3 sharp = inputColor.rgb + (inputColor.rgb - (n0 + n1 + n2 + n3) * 0.25) * strength;
        // anti-ringing: clamp to the local neighborhood so overshoot can't
        // create bright halos (reads as white flecks on dark fur strands)
        vec3 lo = min(inputColor.rgb, min(min(n0, n1), min(n2, n3)));
        vec3 hi = max(inputColor.rgb, max(max(n0, n1), max(n2, n3)));
        outputColor = vec4(clamp(sharp, lo, hi), inputColor.a);
      }`,
      { uniforms: new Map([['strength', new THREE.Uniform(strength)]]) });
  }
}
if (!new URLSearchParams(location.search).has('nopost')) {
  composer.addPass(new EffectPass(
    camera,
    new SharpenEffect(0.2),
    new BrightnessContrastEffect({ brightness: 0.02, contrast: 0.15 }),
    new HueSaturationEffect({ saturation: 0.2 }),
    new VignetteEffect({ offset: 0.25, darkness: 0.55 }),
  ));
}

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
sun.shadow.mapSize.set(lowQ ? 1024 : 2048, lowQ ? 1024 : 2048);
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

    // 16x anisotropy is a real bandwidth cost on mobile GPUs; 4x is plenty there
    const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), lowQ ? 4 : 16);
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
          // the specularf0 strip is near-white, which reads as silvery glints
          // on every strand — kill specular on the fur entirely
          if ('specularIntensity' in mat) mat.specularIntensity = 0;
          mat.roughness = 1;
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
                // the pelt texture has white guard hairs painted in — soften
                // them so they read as grizzled gray variation, not hot flecks
                float peltLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                diffuseColor.rgb *= mix(1.0, 0.6, smoothstep(0.1, 0.4, peltLum));
                // overall gain + root-to-tip gradient: the reference render is
                // a mid-gray grizzled coat, not black
                diffuseColor.rgb *= 1.7 * (0.55 + 0.45 * strandStrip.rgb);
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
        } else if (mat?.name === 'blackrat_body') {
          // the body skin under the fur shells has the same painted-in white
          // guard hairs; where it peeks through strand gaps they read as
          // bright flecks — compress them the same way as the fur
          mat.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <map_fragment>',
              `#include <map_fragment>
              float peltLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
              diffuseColor.rgb *= 1.4 * mix(1.0, 0.6, smoothstep(0.1, 0.4, peltLum));`
            );
          };
          mat.customProgramCacheKey = () => 'body-dim';
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
overlay.addEventListener('click', () => {
  if (isTouch) {
    overlay.classList.add('hidden');
    enableGyro(); // must run inside the tap gesture for the iOS permission prompt
  } else {
    renderer.domElement.requestPointerLock();
  }
});
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0025;
  pitch += e.movementY * 0.0025;
  pitch = Math.max(0.05, Math.min(1.2, pitch));
});

// ---------- Mobile: gyroscope look ----------
// Device orientation drives a yaw/pitch offset on top of the touch-drag
// angles, calibrated to the phone's pose when gyro is enabled — so enabling
// it never snaps the camera, and dragging still works to re-aim.
const gyroBtn = document.getElementById('gyroBtn');
let gyroEnabled = false;
let gyroListening = false;
let gyroYaw = 0, gyroPitch = 0;
let gyroYaw0 = null, gyroPitch0 = 0;

const _gEuler = new THREE.Euler();
const _gQuat = new THREE.Quaternion();
const _gScreen = new THREE.Quaternion();
const _gFwd = new THREE.Vector3();
// -90° about X: maps the device frame (screen faces up) to the camera frame
// (looking out the back of the phone) — same math as DeviceOrientationControls
const GYRO_Q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const GYRO_Z = new THREE.Vector3(0, 0, 1);

function onDeviceOrientation(e) {
  if (!gyroEnabled || e.alpha === null) return;
  const orient = THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);
  _gEuler.set(
    THREE.MathUtils.degToRad(e.beta),
    THREE.MathUtils.degToRad(e.alpha),
    -THREE.MathUtils.degToRad(e.gamma),
    'YXZ'
  );
  _gQuat.setFromEuler(_gEuler)
    .multiply(GYRO_Q1)
    .multiply(_gScreen.setFromAxisAngle(GYRO_Z, -orient));
  _gFwd.set(0, 0, -1).applyQuaternion(_gQuat);
  const devYaw = Math.atan2(-_gFwd.x, -_gFwd.z);
  const devPitch = -Math.asin(THREE.MathUtils.clamp(_gFwd.y, -1, 1));
  if (gyroYaw0 === null) { gyroYaw0 = devYaw; gyroPitch0 = devPitch; }
  gyroYaw = devYaw - gyroYaw0;
  gyroPitch = devPitch - gyroPitch0;
}

async function enableGyro() {
  if (!isTouch) return;
  try {
    // iOS 13+ gates orientation events behind an explicit permission prompt
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') return setGyroUI();
    }
    if (!gyroListening) {
      addEventListener('deviceorientation', onDeviceOrientation);
      gyroListening = true;
    }
    gyroYaw0 = null; gyroYaw = 0; gyroPitch = 0; // recalibrate to current pose
    gyroEnabled = true;
  } catch { gyroEnabled = false; }
  setGyroUI();
}

function setGyroUI() {
  gyroBtn.textContent = gyroEnabled ? 'Gyro on' : 'Gyro off';
  gyroBtn.classList.toggle('on', gyroEnabled);
}

if (isTouch) {
  gyroBtn.style.display = 'block';
  gyroBtn.addEventListener('click', () => {
    if (gyroEnabled) {
      // fold the gyro offset into the touch angles so the view doesn't snap
      yaw += gyroYaw;
      pitch = THREE.MathUtils.clamp(pitch + gyroPitch, 0.05, 1.2);
      gyroYaw = gyroPitch = 0;
      gyroEnabled = false;
      setGyroUI();
    } else {
      enableGyro();
    }
  });

  overlay.textContent = 'Tap to play';
  const hud = document.getElementById('hud');
  hud.innerHTML = '<b>Left thumb</b> move (push to rim to run) &nbsp;·&nbsp; <b>Right thumb</b> look &nbsp;·&nbsp; <b>Pinch</b> zoom';
  hud.appendChild(statusEl);
}

// ---------- Mobile: touch joystick, look drag, pinch zoom ----------
const stickEl = document.getElementById('stick');
const nubEl = document.getElementById('nub');
const JOY_R = 60;
let joyTouch = null, lookTouch = null, pinchTouch = null;
let joyOrigin = { x: 0, y: 0 };
const joyVec = { x: 0, y: 0 };
let joyRun = false;
let lookLast = { x: 0, y: 0 };
let pinchLast = 0;

const findTouch = (list, id) => {
  for (const t of list) if (t.identifier === id) return t;
  return null;
};
const pinchSpan = (touches) => {
  const a = findTouch(touches, lookTouch), b = findTouch(touches, pinchTouch);
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
};
function moveNub(x, y) {
  nubEl.style.left = `${x - 26}px`;
  nubEl.style.top = `${y - 26}px`;
}

const canvas = renderer.domElement;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joyTouch === null && t.clientX < innerWidth * 0.45) {
      // joystick spawns wherever the left thumb lands
      joyTouch = t.identifier;
      joyOrigin = { x: t.clientX, y: t.clientY };
      joyVec.x = joyVec.y = 0;
      joyRun = false;
      stickEl.style.display = nubEl.style.display = 'block';
      stickEl.style.left = `${t.clientX - JOY_R}px`;
      stickEl.style.top = `${t.clientY - JOY_R}px`;
      moveNub(t.clientX, t.clientY);
    } else if (lookTouch === null) {
      lookTouch = t.identifier;
      lookLast = { x: t.clientX, y: t.clientY };
    } else if (pinchTouch === null) {
      pinchTouch = t.identifier;
      pinchLast = pinchSpan(e.touches);
    }
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joyTouch) {
      let dx = t.clientX - joyOrigin.x, dy = t.clientY - joyOrigin.y;
      const len = Math.hypot(dx, dy);
      joyRun = len > JOY_R * 0.95; // pushed to the rim = run
      if (len > JOY_R) { dx *= JOY_R / len; dy *= JOY_R / len; }
      joyVec.x = dx / JOY_R;
      joyVec.y = dy / JOY_R;
      moveNub(joyOrigin.x + dx, joyOrigin.y + dy);
    } else if (t.identifier === lookTouch && pinchTouch === null) {
      yaw -= (t.clientX - lookLast.x) * 0.005;
      pitch = THREE.MathUtils.clamp(pitch + (t.clientY - lookLast.y) * 0.005, 0.05, 1.2);
      lookLast = { x: t.clientX, y: t.clientY };
    }
  }
  if (pinchTouch !== null) {
    const d = pinchSpan(e.touches);
    if (d && pinchLast) camDist = THREE.MathUtils.clamp(camDist * (pinchLast / d), CAM_MIN, CAM_MAX);
    if (d) pinchLast = d;
  }
}, { passive: false });

const endTouch = (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === joyTouch) {
      joyTouch = null;
      joyVec.x = joyVec.y = 0;
      joyRun = false;
      stickEl.style.display = nubEl.style.display = 'none';
    } else if (t.identifier === lookTouch) {
      lookTouch = null;
      if (pinchTouch !== null) {
        // promote the remaining pinch finger to the look finger
        lookTouch = pinchTouch;
        pinchTouch = null;
        const p = findTouch(e.touches, lookTouch);
        if (p) lookLast = { x: p.clientX, y: p.clientY };
      }
    } else if (t.identifier === pinchTouch) {
      pinchTouch = null;
    }
  }
};
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

// ---------- Movement ----------
const WALK_SPEED = 2.2;
const RUN_SPEED = 6.0;
const TURN_LERP = 12;
const velocity = new THREE.Vector3();
let playerHeading = 0;

let camDist = 0.9;
const CAM_MIN = 0.18, CAM_MAX = 30;
addEventListener('wheel', (e) => {
  camDist = THREE.MathUtils.clamp(camDist * (1 + e.deltaY * 0.001), CAM_MIN, CAM_MAX);
}, { passive: true });
const camTarget = new THREE.Vector3();

// scratch vectors reused every frame so the loop allocates nothing
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _zero = new THREE.Vector3();

const clock = new THREE.Clock();

// ---------- Adaptive resolution ----------
// Render resolution dominates GPU cost, so when frame times slip we shed
// pixels instead of stuttering, and claw them back when there's headroom.
// Disable with ?fixedres to compare quality settings at full resolution.
const adaptiveRes = !urlParams.has('fixedres');
let renderScale = 1;
let frameAvg = 1 / 60;
let lastScaleChange = 0;

function applyRenderSize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap) * renderScale);
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
}

function adaptResolution(rawDt, now) {
  if (!adaptiveRes || rawDt > 0.25) return; // ignore tab-switch spikes
  frameAvg += (rawDt - frameAvg) * 0.05;    // ~1s exponential average
  if (now - lastScaleChange < 1) return;    // let the average settle between steps
  if (frameAvg > 1 / 40 && renderScale > 0.55) {
    renderScale = Math.max(0.55, renderScale - 0.15);
  } else if (frameAvg < 1 / 65 && renderScale < 1) {
    renderScale = Math.min(1, renderScale + 0.1);
  } else {
    return;
  }
  lastScaleChange = now;
  applyRenderSize();
}

function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  adaptResolution(rawDt, clock.elapsedTime);

  // Input direction (camera-relative)
  let ix = 0, iz = 0;
  if (pressed('KeyW', 'ArrowUp')) iz += 1;
  if (pressed('KeyS', 'ArrowDown')) iz -= 1;
  if (pressed('KeyA', 'ArrowLeft')) ix += 1;
  if (pressed('KeyD', 'ArrowRight')) ix -= 1;
  if (joyTouch !== null && Math.hypot(joyVec.x, joyVec.y) > 0.2) {
    ix = -joyVec.x;
    iz = -joyVec.y;
  }

  const moving = ix !== 0 || iz !== 0;
  const running = moving && (pressed('ShiftLeft', 'ShiftRight') || joyRun);
  const speed = running ? RUN_SPEED : WALK_SPEED;

  // effective camera angles: touch/mouse steering plus the gyro offset
  const camYaw = yaw + gyroYaw;
  const camPitch = THREE.MathUtils.clamp(pitch + gyroPitch, 0.05, 1.2);

  if (moving) {
    // Build world-space direction from camera yaw
    _forward.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    _right.set(-_forward.z, 0, _forward.x);
    _dir.set(0, 0, 0)
      .addScaledVector(_forward, iz)
      .addScaledVector(_right, -ix)
      .normalize();

    velocity.lerp(_target.copy(_dir).multiplyScalar(speed), 1 - Math.exp(-10 * dt));

    // Smoothly face movement direction
    const targetHeading = Math.atan2(_dir.x, _dir.z);
    let diff = targetHeading - playerHeading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    playerHeading += diff * Math.min(1, TURN_LERP * dt);
    player.rotation.y = playerHeading;
  } else {
    velocity.lerp(_zero, 1 - Math.exp(-12 * dt));
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
  camTarget.copy(player.position);
  camTarget.y += 0.15;
  _target.set(
    Math.sin(camYaw) * Math.cos(camPitch),
    Math.sin(camPitch),
    Math.cos(camYaw) * Math.cos(camPitch)
  ).multiplyScalar(camDist);
  camera.position.copy(camTarget).add(_target);
  if (camera.position.y < 0.15) camera.position.y = 0.15;
  camera.lookAt(camTarget);

  composer.render();
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyRenderSize();
});
