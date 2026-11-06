/**
 * The bazaar at dusk: three stalls, each with a merchant whose body language follows the
 * rules engine's "tell". Built from primitives + canvas textures, so there are no assets to load.
 */
import * as THREE from "three";
import type { Tell } from "./api";

export interface StallLook {
  id: string;
  cloth: string; // canopy + counter cloth
  cloth2: string; // stripe
  robe: string;
  skin: string;
  hat: "wrap" | "hood" | "cap";
  good: "rug" | "saffron" | "lamp";
}

export interface Merchant {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  browL: THREE.Mesh;
  browR: THREE.Mesh;
  mouth: THREE.Mesh;
  tell: Tell;
  talkUntil: number;
  style: string;
}

export interface Stall {
  look: StallLook;
  group: THREE.Group;
  merchant: Merchant;
  lantern: THREE.PointLight;
  cloth: THREE.MeshStandardMaterial;
  anchor: THREE.Vector3; // label position
  face: THREE.Vector3; // merchant head (world)
  forward: THREE.Vector3;
}

const rand = mulberry(7);
function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = 1) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, 1);
  t.anisotropy = 4;
  return t;
}

const stripes = (a: string, b: string) =>
  canvasTexture(256, 64, (g) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? b : a;
      g.fillRect(i * 32, 0, 32, 64);
    }
  });

/** A woven-rug pattern: borders + diamonds. Original motif, generated. */
const rugPattern = (base: string, ink: string, accent: string) =>
  canvasTexture(256, 384, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 384);
    g.strokeStyle = ink;
    g.lineWidth = 10;
    g.strokeRect(14, 14, 228, 356);
    g.lineWidth = 4;
    g.strokeStyle = accent;
    g.strokeRect(30, 30, 196, 324);
    for (let row = 0; row < 3; row++) {
      const cy = 90 + row * 102;
      g.fillStyle = row === 1 ? accent : ink;
      g.beginPath();
      g.moveTo(128, cy - 40);
      g.lineTo(178, cy);
      g.lineTo(128, cy + 40);
      g.lineTo(78, cy);
      g.closePath();
      g.fill();
      g.fillStyle = base;
      g.beginPath();
      g.arc(128, cy, 10, 0, Math.PI * 2);
      g.fill();
    }
    for (let x = 0; x < 256; x += 16) {
      g.fillStyle = ink;
      g.fillRect(x, 0, 8, 6);
      g.fillRect(x + 8, 378, 8, 6);
    }
  });

const mat = (color: string | number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o });

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, cast = true) {
  const x = new THREE.Mesh(geo, m);
  x.castShadow = cast;
  x.receiveShadow = true;
  return x;
}

// ---------- props ----------

function lamp(scale = 1) {
  const pts = [
    [0, 0],
    [0.09, 0],
    [0.1, 0.03],
    [0.05, 0.06],
    [0.06, 0.12],
    [0.13, 0.2],
    [0.12, 0.27],
    [0.05, 0.3],
    [0.03, 0.36],
    [0, 0.38],
  ].map(([x, y]) => new THREE.Vector2(x * scale, y * scale));
  const g = new THREE.Group();
  const brass = mat("#c9963a", { metalness: 0.9, roughness: 0.3 });
  g.add(mesh(new THREE.LatheGeometry(pts, 24), brass));
  const spout = mesh(new THREE.ConeGeometry(0.025 * scale, 0.18 * scale, 10), brass);
  spout.rotation.z = -Math.PI / 2.4;
  spout.position.set(0.17 * scale, 0.22 * scale, 0);
  g.add(spout);
  const handle = mesh(new THREE.TorusGeometry(0.06 * scale, 0.012 * scale, 8, 16, Math.PI * 1.2), brass);
  handle.position.set(-0.13 * scale, 0.22 * scale, 0);
  handle.rotation.z = Math.PI / 2;
  g.add(handle);
  return g;
}

function sack(color: string, spice: string) {
  const g = new THREE.Group();
  const pts = [
    [0, 0],
    [0.16, 0.01],
    [0.2, 0.08],
    [0.2, 0.22],
    [0.16, 0.3],
    [0.19, 0.34],
    [0.17, 0.36],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  g.add(mesh(new THREE.LatheGeometry(pts, 20), mat(color, { side: THREE.DoubleSide })));
  const heap = mesh(new THREE.ConeGeometry(0.16, 0.12, 20), mat(spice, { roughness: 1 }));
  heap.position.y = 0.36;
  g.add(heap);
  return g;
}

function rolledRug(tex: THREE.Texture) {
  const r = mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.0, 18), mat("#ffffff", { map: tex }));
  r.rotation.z = Math.PI / 2;
  return r;
}

function hangingLantern(color = "#ffb347") {
  const g = new THREE.Group();
  const metal = mat("#3a2a1c", { metalness: 0.6, roughness: 0.5 });
  const cap = mesh(new THREE.ConeGeometry(0.11, 0.1, 8), metal);
  cap.position.y = 0.16;
  g.add(cap);
  const glass = mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.22, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.2 }), false);
  g.add(glass);
  const chain = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.5, 4), metal, false);
  chain.position.y = 0.45;
  g.add(chain);
  return g;
}

// ---------- merchant ----------

function buildMerchant(look: StallLook): Merchant {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const robe = mat(look.robe);
  const skin = mat(look.skin, { roughness: 0.7 });
  const dark = mat("#20140c", { roughness: 0.5 });

  const robePts = [
    [0, 0],
    [0.42, 0],
    [0.36, 0.5],
    [0.3, 1.0],
    [0.24, 1.3],
    [0.14, 1.42],
    [0, 1.44],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  body.add(mesh(new THREE.LatheGeometry(robePts, 24), robe));
  const sash = mesh(new THREE.TorusGeometry(0.31, 0.035, 8, 24), mat(look.cloth2));
  sash.rotation.x = Math.PI / 2;
  sash.position.y = 0.95;
  body.add(sash);

  const mkArm = (side: 1 | -1) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.25 * side, 1.3, 0);
    const arm = mesh(new THREE.CapsuleGeometry(0.07, 0.48, 4, 10), robe);
    arm.position.y = -0.28;
    pivot.add(arm);
    const hand = mesh(new THREE.SphereGeometry(0.065, 12, 10), skin);
    hand.position.y = -0.58;
    pivot.add(hand);
    pivot.rotation.z = 0.12 * side;
    body.add(pivot);
    return pivot;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  const head = new THREE.Group();
  head.position.y = 1.62;
  body.add(head);
  head.add(mesh(new THREE.SphereGeometry(0.2, 24, 18), skin));
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.025, 10, 8), dark, false);
    eye.position.set(0.07 * s, 0.03, 0.18);
    head.add(eye);
  }
  const brow = () => mesh(new THREE.BoxGeometry(0.08, 0.018, 0.02), dark, false);
  const browL = brow();
  browL.position.set(-0.07, 0.085, 0.185);
  const browR = brow();
  browR.position.set(0.07, 0.085, 0.185);
  head.add(browL, browR);
  const mouth = mesh(new THREE.BoxGeometry(0.07, 0.014, 0.02), dark, false);
  mouth.position.set(0, -0.07, 0.185);
  head.add(mouth);

  if (look.hat === "wrap") {
    const cloth = mat("#efe6d4");
    for (let i = 0; i < 3; i++) {
      const t = mesh(new THREE.TorusGeometry(0.18 - i * 0.03, 0.06, 10, 24), cloth);
      t.rotation.x = Math.PI / 2;
      t.position.y = 0.13 + i * 0.06;
      head.add(t);
    }
    const beard = mesh(new THREE.ConeGeometry(0.13, 0.26, 14), mat("#cfc6b8"));
    beard.rotation.x = Math.PI;
    beard.position.set(0, -0.2, 0.08);
    head.add(beard);
  } else if (look.hat === "hood") {
    const hood = mesh(new THREE.SphereGeometry(0.235, 24, 16, Math.PI * 0.85, Math.PI * 1.3, 0, Math.PI * 0.62), mat(look.cloth, { side: THREE.DoubleSide }));
    hood.position.set(0, 0.02, -0.03);
    head.add(hood);
    const drape = mesh(new THREE.ConeGeometry(0.26, 0.4, 20, 1, true), mat(look.cloth, { side: THREE.DoubleSide }));
    drape.position.set(0, -0.2, -0.05);
    head.add(drape);
  } else {
    const cap = mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.12, 20), mat(look.cloth2));
    cap.position.y = 0.17;
    head.add(cap);
    const brass = mat("#c9963a", { metalness: 0.9, roughness: 0.3 });
    for (const s of [-1, 1]) {
      const lens = mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 16), brass, false);
      lens.position.set(0.07 * s, 0.03, 0.195);
      head.add(lens);
    }
  }
  return { root, body, head, armL, armR, browL, browR, mouth, tell: "relaxed", talkUntil: 0, style: look.id };
}

// ---------- stall ----------

/** A stall with its merchant, built from primitives. Also used by the Canal Street city mode. */
export function buildStall(look: StallLook): Omit<Stall, "anchor" | "face" | "forward"> {
  const group = new THREE.Group();
  const wood = mat("#7a4e2f");
  const darkWood = mat("#5a3820");
  const cloth = mat(look.cloth);

  const counter = mesh(new THREE.BoxGeometry(3.0, 0.95, 0.9), wood);
  counter.position.set(0, 0.475, 0.55);
  group.add(counter);
  const top = mesh(new THREE.BoxGeometry(3.15, 0.05, 1.0), cloth);
  top.position.set(0, 0.97, 0.55);
  group.add(top);
  const skirt = mesh(new THREE.PlaneGeometry(3.1, 0.6), mat("#ffffff", { map: stripes(look.cloth, look.cloth2) }));
  skirt.position.set(0, 0.68, 1.006);
  group.add(skirt);

  for (const [x, z] of [
    [-1.6, 1.15],
    [1.6, 1.15],
    [-1.6, -1.0],
    [1.6, -1.0],
  ]) {
    const post = mesh(new THREE.CylinderGeometry(0.06, 0.07, 2.9, 10), darkWood);
    post.position.set(x, 1.45, z);
    group.add(post);
  }

  // Sagging striped canopy.
  const canopyGeo = new THREE.PlaneGeometry(3.7, 2.7, 24, 12);
  const pos = canopyGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    pos.setZ(i, -0.18 * Math.cos((x / 3.7) * Math.PI) * Math.cos((y / 2.7) * Math.PI) - 0.04 * Math.sin(x * 3));
  }
  canopyGeo.computeVertexNormals();
  const canopyTex = stripes(look.cloth, look.cloth2);
  canopyTex.repeat.set(3, 1);
  const canopy = mesh(canopyGeo, mat("#ffffff", { map: canopyTex, side: THREE.DoubleSide }));
  canopy.rotation.x = -Math.PI / 2 + 0.12;
  canopy.position.set(0, 2.95, 0.07);
  group.add(canopy);
  // Pennants along the front edge.
  for (let i = 0; i < 11; i++) {
    const p = mesh(new THREE.ConeGeometry(0.1, 0.24, 3), mat(i % 2 ? look.cloth2 : look.cloth), false);
    p.rotation.x = Math.PI;
    p.position.set(-1.75 + i * 0.35, 2.68, 1.42);
    group.add(p);
  }

  // Back wall hanging.
  const wall = mesh(new THREE.PlaneGeometry(3.2, 2.2), mat("#ffffff", { map: rugPattern("#5b2333", "#e8c07a", "#2e5e6e") }));
  wall.position.set(0, 1.55, -1.02);
  group.add(wall);

  // Goods.
  if (look.good === "rug") {
    const t1 = rugPattern("#8c2f39", "#f0d49b", "#1f4e5f");
    const t2 = rugPattern("#2e4a6b", "#f2c46d", "#a63d40");
    for (let i = 0; i < 3; i++) {
      const r = rolledRug(i % 2 ? t2 : t1);
      r.position.set(-0.7 + i * 0.05, 1.11 + i * 0.2, 0.45 - i * 0.03);
      if (i === 2) r.position.y = 1.11 + 0.19;
      group.add(r);
    }
    const flat = mesh(new THREE.BoxGeometry(1.0, 0.04, 0.7), mat("#ffffff", { map: t2 }));
    flat.position.set(0.65, 1.02, 0.55);
    group.add(flat);
  } else if (look.good === "saffron") {
    const spices = ["#e0661c", "#c43b1e", "#e9a925", "#7b3a1d", "#d9822b"];
    for (let i = 0; i < 5; i++) {
      const s = sack(["#c9a46a", "#b88f58", "#d2b07a"][i % 3], spices[i]);
      s.position.set(-1.1 + i * 0.55, 0.995, 0.5 + (i % 2) * 0.12);
      group.add(s);
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const l = lamp(1.2 + (i % 2) * 0.35);
      l.position.set(-1.0 + i * 0.66, 0.995, 0.55);
      l.rotation.y = rand() * Math.PI;
      group.add(l);
    }
  }

  const merchant = buildMerchant(look);
  merchant.root.position.set(0, 0, -0.35);
  group.add(merchant.root);

  // Lanterns + their light.
  const l1 = hangingLantern();
  l1.position.set(-1.1, 2.25, 1.0);
  const l2 = hangingLantern();
  l2.position.set(1.1, 2.3, 1.0);
  group.add(l1, l2);
  const lantern = new THREE.PointLight("#ffa046", 9, 7, 1.6);
  lantern.position.set(0, 2.1, 1.3);
  group.add(lantern);

  return { look, group, merchant, lantern, cloth };
}

// ---------- the scene ----------

export class Bazaar {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  private stalls: Stall[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private camFrom = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() };
  private camTo = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() };
  private camT = 1;
  private target = new THREE.Vector3();
  private focused: Stall | null = null;
  private hovered: Stall | null = null;
  private dust!: THREE.Points;
  private clock = new THREE.Clock();
  onHover: (id: string | null) => void = () => {};
  onPick: (id: string) => void = () => {};
  /** Called each frame with screen positions of stall labels (null = off screen). */
  onLabels: (pos: Record<string, { x: number; y: number } | null>) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    looks: StallLook[],
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.buildWorld();
    const R = 9.5;
    looks.forEach((look, i) => {
      const a = (i - (looks.length - 1) / 2) * 0.62;
      const s = buildStall(look);
      s.group.position.set(Math.sin(a) * R, 0, -Math.cos(a) * R + 2);
      s.group.rotation.y = -a;
      this.scene.add(s.group);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(s.group.quaternion);
      const face = s.group.localToWorld(new THREE.Vector3(0, 1.6, -0.35));
      const anchor = s.group.localToWorld(new THREE.Vector3(0, 3.35, 1.2));
      this.stalls.push({ ...s, forward, face, anchor });
    });

    this.overview(true);
    addEventListener("resize", () => this.resize());
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener("pointerleave", () => this.pointer.set(9, 9));
    canvas.addEventListener("click", () => {
      if (!this.focused && this.hovered) this.onPick(this.hovered.look.id);
    });
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildWorld() {
    const s = this.scene;
    // Sky dome: gradient from deep indigo to a burnt-orange horizon.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(200, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {},
        vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }",
        fragmentShader: `varying vec3 vP;
          void main(){
            float h = vP.y;
            vec3 top = vec3(0.10,0.10,0.24), mid = vec3(0.55,0.27,0.30), hor = vec3(0.98,0.58,0.32);
            vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.6, h)) : mix(hor, mid, smoothstep(-0.02, 0.12, h));
            gl_FragColor = vec4(c, 1.);
          }`,
      }),
    );
    s.add(sky);
    s.fog = new THREE.Fog("#c97a55", 28, 120);

    s.add(new THREE.HemisphereLight("#ffd7a8", "#5a2f22", 0.75));
    const sun = new THREE.DirectionalLight("#ffae6b", 2.4);
    sun.position.set(-18, 9, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -10;
    sun.shadow.bias = -0.0004;
    s.add(sun);

    // A low sun disc on the horizon.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 32), new THREE.MeshBasicMaterial({ color: "#ffd59a", fog: false }));
    disc.position.set(-150, 14, -40);
    disc.lookAt(0, 0, 0);
    s.add(disc);

    // Sand with gentle dunes.
    const g = new THREE.PlaneGeometry(260, 260, 160, 160);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const d = Math.hypot(x, y);
      const dune = d < 16 ? 0 : Math.min(1, (d - 16) / 40) * (2.2 * Math.sin(x * 0.07) * Math.cos(y * 0.05) + 1.6 * Math.sin((x + y) * 0.04) + 1.4);
      p.setZ(i, d < 16 ? -0.05 : dune + (rand() - 0.5) * 0.04);
    }
    g.computeVertexNormals();
    const sand = mesh(g, mat("#d69a62", { roughness: 1 }), false);
    sand.rotation.x = -Math.PI / 2;
    s.add(sand);

    // Plaza tiles.
    const tiles = canvasTexture(256, 256, (c) => {
      c.fillStyle = "#b9835a";
      c.fillRect(0, 0, 256, 256);
      c.strokeStyle = "#8f5f3e";
      c.lineWidth = 3;
      for (let i = 0; i <= 256; i += 64) {
        c.beginPath();
        c.moveTo(i, 0);
        c.lineTo(i, 256);
        c.moveTo(0, i);
        c.lineTo(256, i);
        c.stroke();
      }
    });
    tiles.repeat.set(10, 10);
    const plaza = mesh(new THREE.CircleGeometry(14, 48), mat("#ffffff", { map: tiles, roughness: 0.95 }), false);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.02, -4);
    s.add(plaza);

    // Palms.
    for (const [x, z, h] of [
      [-14, -12, 6.5],
      [13, -14, 7.2],
      [-19, 2, 5.8],
      [18, 0, 6.2],
      [-7, -20, 7.5],
      [8, -22, 6.8],
    ]) {
      s.add(this.palm(x, z, h));
    }

    // Clutter: crates and jars around the plaza.
    const crate = mat("#8a5d38");
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2;
      const r = 12 + rand() * 4;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r - 4;
      if (z > 4) continue;
      if (rand() > 0.5) {
        const c = mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), crate);
        c.position.set(x, 0.3, z);
        c.rotation.y = rand() * 3;
        s.add(c);
      } else {
        const jar = mesh(
          new THREE.LatheGeometry(
            [
              [0, 0],
              [0.25, 0],
              [0.35, 0.3],
              [0.3, 0.6],
              [0.14, 0.75],
              [0.16, 0.85],
            ].map(([a, b]) => new THREE.Vector2(a, b)),
            18,
          ),
          mat("#b5643c"),
        );
        jar.position.set(x, 0, z);
        s.add(jar);
      }
    }

    // Dust motes.
    const N = 500;
    const dp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      dp[i * 3] = (rand() - 0.5) * 34;
      dp[i * 3 + 1] = rand() * 6;
      dp[i * 3 + 2] = (rand() - 0.5) * 28 - 4;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(dp, 3));
    this.dust = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ color: "#ffd9a0", size: 0.05, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    s.add(this.dust);
  }

  private palm(x: number, z: number, h: number) {
    const g = new THREE.Group();
    const bark = mat("#6d4a2e");
    const seg = 7;
    let px = 0;
    for (let i = 0; i < seg; i++) {
      const t = mesh(new THREE.CylinderGeometry(0.16 - i * 0.012, 0.2 - i * 0.012, h / seg + 0.05, 8), bark);
      px += 0.08 * i * 0.3;
      t.position.set(px, (i + 0.5) * (h / seg), 0);
      t.rotation.z = -0.04 * i;
      g.add(t);
    }
    const leaf = mat("#3f6b3a", { side: THREE.DoubleSide });
    for (let i = 0; i < 8; i++) {
      const lg = new THREE.PlaneGeometry(0.6, 3, 1, 6);
      const lp = lg.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < lp.count; k++) {
        const yy = lp.getY(k) + 1.5;
        lp.setZ(k, -0.12 * yy * yy);
        lp.setX(k, lp.getX(k) * (1 - yy / 3.2));
      }
      lg.computeVertexNormals();
      const l = mesh(lg, leaf, false);
      l.position.set(px, h, 0);
      l.rotation.set(-Math.PI / 2 + 0.5, (i / 8) * Math.PI * 2, 0, "YXZ");
      l.translateY(1.4);
      g.add(l);
    }
    g.position.set(x, 0, z);
    return g;
  }

  // ---------- camera ----------

  private moveCamera(pos: THREE.Vector3, tgt: THREE.Vector3, instant = false) {
    this.camFrom.pos.copy(this.camera.position);
    this.camFrom.tgt.copy(this.target);
    this.camTo.pos.copy(pos);
    this.camTo.tgt.copy(tgt);
    this.camT = instant ? 1 : 0;
    if (instant) {
      this.camera.position.copy(pos);
      this.target.copy(tgt);
    }
  }

  overview(instant = false) {
    this.focused = null;
    const narrow = innerWidth < 760;
    this.moveCamera(new THREE.Vector3(0, narrow ? 9 : 6.8, narrow ? 15 : 10.5), new THREE.Vector3(0, 1.3, -5.5), instant);
  }

  focus(id: string) {
    const s = this.stalls.find((x) => x.look.id === id);
    if (!s) return;
    this.focused = s;
    this.hovered = null;
    this.onHover(null);
    const narrow = innerWidth < 760;
    const right = new THREE.Vector3().crossVectors(s.forward, new THREE.Vector3(0, 1, 0)).normalize();
    // Keep the merchant clear of the chat panel: right side on desktop, bottom sheet on phones.
    const tgt = s.face.clone().add(narrow ? new THREE.Vector3(0, -1.0, 0) : right.clone().multiplyScalar(-1.25)).add(new THREE.Vector3(0, -0.35, 0));
    const pos = s.face.clone().add(s.forward.clone().multiplyScalar(narrow ? 6.4 : 5.0)).add(new THREE.Vector3(0, 0.55, 0));
    if (!narrow) pos.add(right.multiplyScalar(-1.25));
    this.moveCamera(pos, tgt);
  }

  setTell(id: string, tell: Tell) {
    const s = this.stalls.find((x) => x.look.id === id);
    if (s) s.merchant.tell = tell;
  }

  talk(id: string, ms = 1600) {
    const s = this.stalls.find((x) => x.look.id === id);
    if (s) s.merchant.talkUntil = performance.now() + ms;
  }

  private resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < 760 ? 55 : 45;
    this.camera.updateProjectionMatrix();
  }

  // ---------- frame ----------

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    if (this.camT < 1) {
      this.camT = Math.min(1, this.camT + dt / 1.3);
      const k = this.camT < 0.5 ? 4 * this.camT ** 3 : 1 - (-2 * this.camT + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.camFrom.pos, this.camTo.pos, k);
      this.target.lerpVectors(this.camFrom.tgt, this.camTo.tgt, k);
    } else if (!this.focused) {
      // Idle drift over the plaza.
      this.camera.position.x = this.camTo.pos.x + Math.sin(t * 0.12) * 0.9;
      this.camera.position.y = this.camTo.pos.y + Math.sin(t * 0.17) * 0.15;
    }
    this.camera.lookAt(this.target);

    // Hover.
    if (!this.focused) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(
        this.stalls.map((s) => s.group),
        true,
      )[0];
      const s = hit ? this.stalls.find((x) => x.group === findRoot(hit.object, this.stalls)) ?? null : null;
      if (s !== this.hovered) {
        this.hovered = s;
        this.canvas.style.cursor = s ? "pointer" : "";
        this.onHover(s?.look.id ?? null);
      }
    }

    const now = performance.now();
    for (const s of this.stalls) {
      animateMerchant(s.merchant, t, dt, now);
      const glow = s === this.hovered ? 1 : 0;
      s.cloth.emissive.set(s.look.cloth);
      s.cloth.emissiveIntensity += (glow * 0.35 - s.cloth.emissiveIntensity) * Math.min(1, dt * 8);
      const angry = s.merchant.tell === "irritated" && s === this.focused;
      s.lantern.color.lerp(new THREE.Color(angry ? "#ff5a36" : "#ffa046"), Math.min(1, dt * 2));
      s.lantern.intensity = 9 + Math.sin(t * 9 + s.group.position.x) * 0.6 + Math.sin(t * 23) * 0.3;
    }

    const dpos = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < dpos.count; i++) {
      let y = dpos.getY(i) + dt * 0.08;
      if (y > 6) y = 0;
      dpos.setY(i, y);
      dpos.setX(i, dpos.getX(i) + Math.sin(t * 0.3 + i) * dt * 0.05);
    }
    dpos.needsUpdate = true;

    // Labels.
    const labels: Record<string, { x: number; y: number } | null> = {};
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (const s of this.stalls) {
      const v = s.anchor.clone().project(this.camera);
      labels[s.look.id] = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 ? { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h } : null;
    }
    this.onLabels(labels);
    this.renderer.render(this.scene, this.camera);
  }
}

function findRoot(o: THREE.Object3D, stalls: Stall[]) {
  let x: THREE.Object3D | null = o;
  while (x && !stalls.some((s) => s.group === x)) x = x.parent;
  return x;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

interface Pose {
  aLx: number;
  aLz: number;
  aRx: number;
  aRz: number;
  lean: number;
  sway: number;
  jitter: number;
  glance: number;
  browTilt: number;
  browLift: number;
  headTilt: number;
}

const REST: Pose = { aLx: 0, aLz: -0.12, aRx: 0, aRz: 0.12, lean: 0, sway: 0, jitter: 0, glance: 0, browTilt: 0, browLift: 0, headTilt: 0 };
const CROSSED = { aLx: -1.25, aLz: 0.75, aRx: -1.25, aRz: -0.75 };
/** A periodic gesture: 1 during the first `dur` seconds of every `every` seconds. */
const pulse = (t: number, every: number, dur: number) => ((t % every) < dur ? 1 : 0);

/**
 * Each merchant leaks each tell differently (matching the stage directions the model is told
 * to use), so reading a merchant is a skill you learn per merchant, not a label in the UI.
 */
function poseFor(style: string, tell: Tell, t: number): Pose {
  const p: Pose = { ...REST };
  switch (`${style}:${tell}`) {
    // Old Farrukh: the beard and the rugs.
    case "farrukh:relaxed": // strokes beard slowly
      if (pulse(t, 5, 2.2)) Object.assign(p, { aRx: -2.0, aRz: -0.45 + Math.sin(t * 3) * 0.08 });
      p.sway = Math.sin(t * 1.1) * 0.03;
      break;
    case "farrukh:firm": // palms flat on the counter
      Object.assign(p, { aLx: -1.35, aLz: 0.05, aRx: -1.35, aRz: -0.05, lean: 0.06, browTilt: 0.12 });
      break;
    case "farrukh:nervous": // smoothing the same corner of a rug
      Object.assign(p, { aRx: -1.15, aRz: -0.2 + Math.sin(t * 4) * 0.25, browLift: 0.015, glance: Math.sin(t * 0.8) > 0.7 ? 0.4 : 0 });
      break;
    case "farrukh:irritated": // tugs at the beard, hard
      Object.assign(p, { aRx: -2.1 + Math.abs(Math.sin(t * 7)) * 0.25, aRz: -0.4, lean: 0.12, browTilt: 0.45 });
      break;
    // Zaria: saffron, jars and rings.
    case "zaria:relaxed": // sifts threads through her fingers
      Object.assign(p, { aLx: -1.0 + Math.sin(t * 2.2) * 0.08, aLz: 0.15, sway: Math.sin(t * 1.3) * 0.03 });
      break;
    case "zaria:firm": // snaps a jar lid shut
      Object.assign(p, CROSSED, { browTilt: 0.15, lean: -0.04 });
      break;
    case "zaria:nervous": // drums her rings against a jar
      Object.assign(p, { aRx: -1.1 + Math.sin(t * 15) * 0.07, aRz: -0.1, browLift: 0.018, browTilt: -0.25, jitter: Math.sin(t * 19) * 0.006 });
      break;
    case "zaria:irritated": // stops sifting, eyes narrowed
      Object.assign(p, CROSSED, { lean: 0.14, browTilt: 0.5, headTilt: 0.12 });
      break;
    // Tobin: lamps, cloth and spectacles.
    case "tobin:relaxed": // polishes a lamp, humming
      Object.assign(p, { aRx: -1.0, aRz: -0.15 + Math.sin(t * 5) * 0.18, sway: Math.sin(t * 1.0) * 0.035, headTilt: Math.sin(t * 0.9) * 0.05 });
      break;
    case "tobin:firm": // puts the cloth down: arms still at the sides
      Object.assign(p, { browTilt: 0.1, lean: -0.03 });
      break;
    case "tobin:nervous": // pushes spectacles up the nose, twice
      if (pulse(t, 2.4, 0.5) || pulse(t + 0.7, 2.4, 0.4)) Object.assign(p, { aRx: -2.55, aRz: -0.55 });
      Object.assign(p, { browLift: 0.02, glance: Math.sin(t * 1.1) > 0.6 ? -0.35 : 0 });
      break;
    case "tobin:irritated": // snuffs out the little lamp
      Object.assign(p, CROSSED, { lean: 0.1, browTilt: 0.4 });
      break;
    default:
      p.sway = Math.sin(t * 1.1) * 0.03;
  }
  return p;
}

export function animateMerchant(m: Merchant, t: number, dt: number, now: number) {
  const k = Math.min(1, dt * 6);
  const p = poseFor(m.style, m.tell, t);
  m.body.rotation.x = lerp(m.body.rotation.x, p.lean, k);
  m.body.rotation.z = lerp(m.body.rotation.z, p.sway, k);
  m.body.position.x = p.jitter;
  m.body.position.y = Math.sin(t * 1.8) * 0.008;
  m.head.rotation.y = lerp(m.head.rotation.y, p.glance, Math.min(1, dt * 3));
  m.head.rotation.z = lerp(m.head.rotation.z, p.headTilt, k);
  m.armL.rotation.x = lerp(m.armL.rotation.x, p.aLx, k);
  m.armL.rotation.z = lerp(m.armL.rotation.z, p.aLz, k);
  m.armR.rotation.x = lerp(m.armR.rotation.x, p.aRx, k);
  m.armR.rotation.z = lerp(m.armR.rotation.z, p.aRz, k);
  m.browL.rotation.z = lerp(m.browL.rotation.z, -p.browTilt, k);
  m.browR.rotation.z = lerp(m.browR.rotation.z, p.browTilt, k);
  m.browL.position.y = m.browR.position.y = lerp(m.browL.position.y, 0.085 + p.browLift, k);
  // Talking: mouth flaps + a little head bob.
  const talking = now < m.talkUntil;
  m.mouth.scale.y = talking ? 1 + Math.abs(Math.sin(t * 16)) * 3.5 : lerp(m.mouth.scale.y, 1, k);
  m.head.rotation.x = talking ? Math.sin(t * 8) * 0.05 : lerp(m.head.rotation.x, 0, k);
}
