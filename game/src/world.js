// Ferroline Yard — a dusk rail yard with two spike sites. Vanguard pushes up from
// the south yard, Sentinel holds the north sheds, and the spike goes down at the
// Crane Deck (A) or the Depot (B). The whole map is one layout table: every solid
// in it blocks movement and stops bullets, in table order. Textures are painted
// on canvases at load — no image files, no network.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// ---------- canvas textures ----------

function makeCanvasTex(size, painter, repeat) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width: size, height: size });
  painter(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat || 1, repeat || 1);
  tex.anisotropy = 4;
  return tex;
}

function sprinkle(g, s, count, colorFor, widthFor, heightFor) {
  for (let i = 0; i < count; i += 1) {
    g.fillStyle = colorFor();
    g.fillRect(Math.random() * s, Math.random() * s, widthFor(), heightFor());
  }
}

function cracks(g, s, count, segments, step) {
  g.strokeStyle = 'rgba(20, 18, 16, 0.5)';
  g.lineWidth = 1;
  for (let i = 0; i < count; i += 1) {
    g.beginPath();
    let x = Math.random() * s;
    let y = Math.random() * s;
    g.moveTo(x, y);
    for (let j = 0; j < segments; j += 1) {
      x += (Math.random() - 0.5) * step;
      y += (Math.random() - 0.5) * step;
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

function stains(g, s, count) {
  g.fillStyle = 'rgba(30, 26, 22, 0.35)';
  for (let i = 0; i < count; i += 1) {
    g.beginPath();
    g.ellipse(Math.random() * s, Math.random() * s, 12 + Math.random() * 30, 8 + Math.random() * 20, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
}

function concreteTex(g, s) {
  g.fillStyle = '#4a4640';
  g.fillRect(0, 0, s, s);
  sprinkle(g, s, 2600, () => {
    const v = 60 + Math.random() * 40;
    return `rgba(${v}, ${v - 4}, ${v - 10}, 0.25)`;
  }, () => 1 + Math.random() * 2, () => 1 + Math.random() * 2);
  cracks(g, s, 7, 4, 70);
  stains(g, s, 12);
}

function hazardTex(g, s) {
  g.fillStyle = '#f0a830';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#181d26';
  for (let x = -s; x < s * 2; x += 32) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 16 + s, s);
    g.lineTo(x + s, s);
    g.closePath();
    g.fill();
  }
}

function containerTex(base) {
  return (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(x, 0, 5, s);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(x + 8, 0, 4, s);
    }
    sprinkle(g, s, 300,
      () => `rgba(20,14,10,${0.05 + Math.random() * 0.2})`,
      () => 2 + Math.random() * 6,
      () => 2 + Math.random() * 4);
  };
}

function skyTex() {
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width: 16, height: 256 });
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const stops = [[0, '#232c3e'], [0.45, '#4a4a58'], [0.62, '#c97e46'], [0.72, '#8a5a3a'], [1, '#181d26']];
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  return new THREE.CanvasTexture(canvas);
}

// ---------- materials ----------

function buildMaterials(tex) {
  const std = (opts) => new THREE.MeshStandardMaterial(opts);
  return {
    ground: std({ map: tex.concrete, roughness: 0.95, metalness: 0.02 }),
    steel: std({ color: new THREE.Color(PALETTE.surface), roughness: 0.6, metalness: 0.55 }),
    wall: std({ color: new THREE.Color('#2e343c'), roughness: 0.85, metalness: 0.25 }),
    rust: std({ color: new THREE.Color(PALETTE.rust), roughness: 0.9, metalness: 0.15 }),
    contA: std({ map: tex.contA, roughness: 0.7, metalness: 0.4 }),
    contB: std({ map: tex.contB, roughness: 0.7, metalness: 0.4 }),
    contC: std({ map: tex.contC, roughness: 0.7, metalness: 0.4 }),
    hazard: std({ map: tex.hazard, roughness: 0.8, metalness: 0.1 }),
    wood: std({ color: new THREE.Color('#6b5232'), roughness: 0.9, metalness: 0.05 }),
    dark: std({ color: new THREE.Color('#20242a'), roughness: 0.9, metalness: 0.2 }),
    lamp: std({ color: new THREE.Color(PALETTE.accent), emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 1.6 }),
  };
}

// ---------- the map as data ----------
// Rows: ['box', w, h, d, x, y, z, material, solid?] or ['cyl', r, h, x, y, z, material].
// Order is load-bearing: it is the order colliders are tested in, so keep it.
const MAP_ROWS = [
  // Ground slab and the four perimeter walls (48 x 40 m yard, 5 m high).
  ['box', 49, 0.4, 41, 0, -0.2, 0, 'ground'],
  ['box', 0.6, 5, 41, -24.3, 2.5, 0, 'wall'],
  ['box', 0.6, 5, 41, 24.3, 2.5, 0, 'wall'],
  ['box', 49, 5, 0.6, 0, 2.5, -20.3, 'wall'],
  ['box', 49, 5, 0.6, 0, 2.5, 20.3, 'wall'],
  // Site A — Crane Deck (northwest): raised deck, crane pillars and beam, crates.
  ['box', 10, 0.8, 7, -15, 0.4, -12, 'steel'],
  ['box', 1.2, 0.4, 1.2, -11, 0.2, -7.5, 'wood'],
  ['box', 0.8, 7, 0.8, -19.5, 3.5, -15, 'rust'],
  ['box', 0.8, 7, 0.8, -10.5, 3.5, -15, 'rust'],
  ['box', 10.5, 0.7, 0.9, -15, 7, -15, 'rust'],
  ['box', 2.2, 1.1, 1.2, -18, 1.35, -10, 'wood'],
  ['box', 1.2, 1.1, 2.2, -11.5, 1.35, -13.5, 'wood'],
  ['box', 1.2, 1.1, 1.2, -18.5, 1.35, -14.5, 'wood'],
  ['box', 10, 0.06, 0.5, -15, 0.83, -8.6, 'hazard', false],
  // Hazard-striped plant pad at Site A, where the spike goes down.
  ['box', 3.2, 0.06, 3.2, -15, 0.87, -8.5, 'hazard', false],
  // Site B — Depot (northeast): rail car on wheels, containers, one stacked.
  ['box', 9, 2.6, 2.6, 15, 1.3, -15.5, 'contC'],
  ['box', 9, 0.5, 2.8, 15, 2.85, -15.5, 'dark'],
  ['cyl', 0.5, 0.4, 11.5, 0.2, -14.2, 'dark'],
  ['cyl', 0.5, 0.4, 18.5, 0.2, -14.2, 'dark'],
  ['box', 2.4, 2.4, 2.4, 20.5, 1.2, -10, 'contA'],
  ['box', 2.4, 2.4, 2.4, 9.5, 1.2, -10.5, 'contB'],
  ['box', 2.4, 1.2, 2.4, 20.5, 3.0, -10, 'contB'],
  ['box', 10, 0.06, 0.5, 15, 0.03, -8.6, 'hazard', false],
  // Hazard-striped plant pad at Site B, where the spike goes down.
  ['box', 3.2, 0.06, 3.2, 15, 0.07, -8.5, 'hazard', false],
  // Mid: container wall with a door gap, a steel pillar, low crates.
  ['box', 2.4, 2.4, 6, -3.6, 1.2, 2, 'contA'],
  ['box', 2.4, 2.4, 6, 3.6, 1.2, 2, 'contB'],
  ['box', 2.4, 2.4, 2.4, -3.6, 3.6, 2, 'contB'],
  ['box', 1.4, 3.4, 1.4, 2.5, 1.7, -4, 'steel'],
  ['box', 3.2, 1.1, 1.4, -7, 0.55, 6, 'wood'],
  ['box', 3.2, 1.1, 1.4, 7, 0.55, 6, 'wood'],
  ['box', 1.4, 1.1, 1.4, -7, 0.55, -6, 'wood'],
  ['box', 1.4, 1.1, 1.4, 7, 0.55, -6, 'wood'],
  // Two extra mid crates for cover: off the x=0 mid lane and clear of the
  // midLow-to-midA/midB diagonals, so no waypoint lane is blocked.
  ['box', 1.4, 1.1, 1.4, -4, 0.55, 9, 'wood'],
  ['box', 1.4, 1.1, 1.4, 4, 0.55, 9, 'wood'],
  // Long lanes: crates, barrels, the overhead pipe run along B-long.
  ['box', 2.2, 1.1, 1.2, -21, 0.55, 4, 'wood'],
  ['box', 1.2, 1.1, 2.2, -21, 0.55, -4, 'wood'],
  ['box', 2.2, 1.1, 1.2, 21, 0.55, 4, 'wood'],
  ['box', 1.2, 1.1, 2.2, 21, 0.55, -4, 'wood'],
  ['cyl', 0.55, 1.1, -22, 0.55, 12, 'rust'],
  ['cyl', 0.55, 1.1, 22, 0.55, 12, 'rust'],
  ['cyl', 0.55, 1.1, -22, 0.55, -13, 'rust'],
  ['cyl', 0.55, 1.1, 22, 0.55, -13, 'rust'],
  // Two extra barrels flanking mid, clear of the midLow-to-long lanes.
  ['cyl', 0.55, 1.1, -12, 0.55, 6, 'rust'],
  ['cyl', 0.55, 1.1, 12, 0.55, 6, 'rust'],
  ['box', 0.5, 0.5, 22, 22.5, 3.6, 0, 'steel'],
  // Spawn cover, both ends.
  ['box', 2.4, 1.2, 1.2, -4, 0.6, 15, 'wood'],
  ['box', 2.4, 1.2, 1.2, 4, 0.6, 15, 'wood'],
  ['box', 2.4, 1.2, 1.2, -4, 0.6, -15.5, 'wood'],
  ['box', 2.4, 1.2, 1.2, 4, 0.6, -15.5, 'wood'],
];

// Lamp posts: warm light at both sites, mid, and both longs.
// The mid lamp sits at x=2.5, off the midLow -> midDoor waypoint line (x=0),
// so bots walking the lane never wedge against it.
const LAMP_POINTS = [[-15, -8.5], [15, -8.5], [2.5, 6], [-19, 10], [19, 10]];

// Distant skyline blocks outside the walls, for depth: [x, height, z, w, d].
const SKYLINE_BLOCKS = [
  [-40, 6, -34, 8, 12], [-28, 9, -38, 10, 18], [-12, 5, -40, 7, 10],
  [6, 11, -38, 9, 22], [22, 7, -36, 8, 14], [38, 10, -30, 10, 20],
  [-44, 8, 10, 8, 16], [44, 6, 14, 8, 12], [-38, 5, 34, 8, 10], [36, 8, 36, 9, 16],
];

// Waypoint graph for the bots: [id, x, z] nodes, [a, b] links between neighbours.
const WAYPOINTS = [
  ['vSpawn', 0, 17], ['vMid', 0, 12], ['vWest', -8, 13], ['vEast', 8, 13],
  ['midLow', 0, 6], ['midDoor', 0, -1], ['midTop', 0, -8],
  ['aLong1', -19, 10], ['aLong2', -19, 0], ['aLong3', -19, -8], ['aEntry', -14, -9],
  ['bLong1', 19, 10], ['bLong2', 19, 0], ['bLong3', 19, -8], ['bEntry', 14, -9],
  ['midA', -8, -3], ['midB', 8, -3],
  ['aSite', -15, -12], ['aPlant', -15, -12], ['aHold1', -20, -15], ['aHold2', -9, -15], ['aBack', -15, -17],
  ['bSite', 15, -12], ['bPlant', 15, -12], ['bHold1', 20, -15], ['bHold2', 9, -15], ['bBack', 15, -17],
  ['sSpawn', 0, -17], ['sMid', 0, -13],
];
const LINKS = [
  ['vSpawn', 'vMid'], ['vSpawn', 'vWest'], ['vSpawn', 'vEast'],
  ['vMid', 'midLow'], ['vWest', 'aLong1'], ['vEast', 'bLong1'],
  ['midLow', 'midDoor'], ['midLow', 'aLong2'], ['midLow', 'bLong2'],
  ['midLow', 'midA'], ['midLow', 'midB'],
  ['midDoor', 'midTop'], ['midTop', 'sMid'],
  ['aLong1', 'aLong2'], ['aLong2', 'aLong3'], ['aLong3', 'aEntry'],
  ['bLong1', 'bLong2'], ['bLong2', 'bLong3'], ['bLong3', 'bEntry'],
  ['midA', 'aEntry'], ['midB', 'bEntry'],
  ['aEntry', 'aSite'], ['aSite', 'aHold1'], ['aSite', 'aHold2'], ['aSite', 'aBack'], ['aSite', 'aPlant'],
  ['bEntry', 'bSite'], ['bSite', 'bHold1'], ['bSite', 'bHold2'], ['bSite', 'bBack'], ['bSite', 'bPlant'],
  ['sMid', 'aHold2'], ['sMid', 'bHold2'], ['sMid', 'sSpawn'],
  ['aHold1', 'aBack'], ['bHold1', 'bBack'],
];
const NODE_POS = {};
for (const [id, x, z] of WAYPOINTS) NODE_POS[id] = [x, z];
const NEIGHBORS = {};
for (const id of Object.keys(NODE_POS)) NEIGHBORS[id] = [];
for (const [a, b] of LINKS) {
  NEIGHBORS[a].push(b);
  NEIGHBORS[b].push(a);
}

// Site zones and plant spots.
function makeZone(x0, z0, x1, z1) {
  return new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 4, z1));
}
const SITE_DEFS = {
  A: { name: 'Crane Deck', zone: makeZone(-20, -16, -10, -8), plant: new THREE.Vector3(-15, 0.8, -12) },
  B: { name: 'Depot', zone: makeZone(10, -16, 20, -8), plant: new THREE.Vector3(15, 0, -12) },
};
const SPAWN_SPOTS = {
  vanguard: [[-4, 17.5], [-2, 18.5], [0, 17], [2, 18.5], [4, 17.5]],
  sentinel: [[-4, -17.5], [-2, -18.5], [0, -17], [2, -18.5], [4, -17.5]],
};
function spawnVectors(points) {
  return points.map(([x, z]) => new THREE.Vector3(x, 0, z));
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const tex = {
    concrete: makeCanvasTex(256, concreteTex, 8),
    hazard: makeCanvasTex(128, hazardTex),
    contA: makeCanvasTex(256, containerTex('#3a4a52')),
    contB: makeCanvasTex(256, containerTex('#5c4632')),
    contC: makeCanvasTex(256, containerTex('#6b4a2a')),
  };
  const mats = buildMaterials(tex);

  const colliders = [];
  const shootables = [];

  function addSolid(mesh, solid) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (solid !== false) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }
  function buildBox(row) {
    const [, w, h, d, x, y, z, mat, solid] = row;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[mat]);
    mesh.position.set(x, y, z);
    return addSolid(mesh, solid);
  }
  function buildPost(row) {
    const [, r, h, x, y, z, mat] = row;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), mats[mat]);
    mesh.position.set(x, y, z);
    return addSolid(mesh, true);
  }
  for (const row of MAP_ROWS) {
    if (row[0] === 'box') buildBox(row);
    else buildPost(row);
  }

  // Lamp posts with warm light.
  for (const [lx, lz] of LAMP_POINTS) {
    buildBox(['box', 0.18, 4.2, 0.18, lx, 2.1, lz, 'dark']);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.5), mats.lamp);
    head.position.set(lx, 4.25, lz);
    group.add(head);
    const glow = new THREE.PointLight(new THREE.Color(PALETTE.accent), 14, 13, 1.8);
    glow.position.set(lx, 4.0, lz);
    scene.add(glow);
  }

  // Distant skyline silhouettes outside the walls.
  const skyline = new THREE.Group();
  const silMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#12151c'), fog: false });
  for (const [sx, sh, sz, sw, sd] of SKYLINE_BLOCKS) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, sd), silMat);
    block.position.set(sx, sh / 2 - 0.2, sz);
    skyline.add(block);
  }
  scene.add(skyline);

  // Sky dome: vertical dusk gradient, with the sun low in the west.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(130, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex(), side: THREE.BackSide, fog: false }),
  );
  scene.add(sky);
  const sunCanvas = document.createElement('canvas');
  Object.assign(sunCanvas, { width: 128, height: 128 });
  const sg = sunCanvas.getContext('2d');
  const halo = sg.createRadialGradient(64, 64, 4, 64, 64, 64);
  halo.addColorStop(0, 'rgba(255, 196, 120, 1)');
  halo.addColorStop(0.35, 'rgba(240, 150, 70, 0.55)');
  halo.addColorStop(1, 'rgba(240, 150, 70, 0)');
  sg.fillStyle = halo;
  sg.fillRect(0, 0, 128, 128);
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sunCanvas), transparent: true, fog: false, depthWrite: false }),
  );
  sun.position.set(-108, 40, -72);
  sun.lookAt(0, 8, 0);
  scene.add(sun);

  // Light: low warm sun from the west, cool dusk fill, hemisphere sky/ground.
  const hemi = new THREE.HemisphereLight(new THREE.Color('#5a6a86'), new THREE.Color('#2a241e'), 1.0);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(new THREE.Color('#ffb066'), 2.2);
  sunLight.position.set(-45, 42, 8);
  sunLight.target.position.set(4, 0, -6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, far: 110 });
  sunLight.shadow.bias = -0.0006;
  scene.add(sunLight, sunLight.target);
  const fill = new THREE.DirectionalLight(new THREE.Color('#7d8aa5'), 0.5);
  fill.position.set(20, 18, 24);
  scene.add(fill);

  return {
    colliders,
    shootables,
    group,
    sites: SITE_DEFS,
    spawns: { vanguard: spawnVectors(SPAWN_SPOTS.vanguard), sentinel: spawnVectors(SPAWN_SPOTS.sentinel) },
    waypoints: { nodes: NODE_POS, edges: LINKS, adjacency: NEIGHBORS },
  };
}
