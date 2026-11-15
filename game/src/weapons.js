// Weapons: the numbers and the view models. The caller owns the ray and the damage;
// this module owns magazines, fire rates, reloads, spread and recoil per weapon.
// Four guns plus a grenade: stopping to aim pays, spraying on the move does not.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// One row per weapon: id, display name, buy-menu slot, price, kind, damage,
// headshot multiplier, seconds between shots, full-auto?, magazine, reserve ammo,
// reload seconds, spread standing, spread on the move, recoil kick, range in metres.
const SPEC_ROWS = [
  ['pistol', 'P9 Sidearm', 2, 300, 'pistol', 26, 3.0, 0.16, false, 12, 36, 1.5, 0.004, 0.024, 0.011, 60],
  ['smg', 'Kestrel-9', 1, 1500, 'smg', 22, 3.0, 0.075, true, 32, 96, 1.7, 0.006, 0.03, 0.008, 55],
  ['rifle', 'AR-77 Longshot', 1, 2700, 'rifle', 33, 3.2, 0.096, true, 30, 90, 1.9, 0.0022, 0.028, 0.013, 80],
  ['sniper', 'Lance .50', 1, 4750, 'sniper', 95, 2.0, 1.1, false, 5, 15, 2.6, 0.0006, 0.05, 0.05, 120],
  ['grenade', 'Frag Grenade', 3, 300, 'grenade', 0, 1, 0.9, false, 1, 0, 0, 0, 0, 0, 0],
];
const SPEC_FIELDS = ['id', 'name', 'slot', 'price', 'kind', 'damage', 'headMult', 'fireGap', 'auto', 'mag', 'reserve', 'reloadTime', 'spreadStill', 'spreadMove', 'recoil', 'range'];

export const WEAPONS = {};
for (const row of SPEC_ROWS) {
  const def = {};
  SPEC_FIELDS.forEach((field, i) => { def[field] = row[i]; });
  WEAPONS[def.id] = def;
}

export const ARMOR_PRICE = 650;
export const ARMOR_VALUE = 100;

// ---------- view models ----------
// One part row: [shape, size args, material, x, y, z, rotX?] — assembled in order.
// Shapes: box [w,h,d], tube [rTop, rBottom, len, segments], ball [r, wSeg, hSeg].
const MODEL_PARTS = {
  pistol: [
    ['box', [0.05, 0.06, 0.24], 'body', 0, 0, 0],
    ['box', [0.045, 0.07, 0.2], 'grip', 0, -0.02, 0.02],
    ['box', [0.045, 0.12, 0.07], 'grip', 0, -0.09, 0.09, 0.25],
  ],
  smg: [
    ['box', [0.07, 0.09, 0.34], 'body', 0, 0, 0],
    ['box', [0.04, 0.04, 0.26], 'grip', 0, 0.02, -0.28],
    ['box', [0.05, 0.16, 0.06], 'grip', 0, -0.1, -0.02],
    ['box', [0.06, 0.07, 0.16], 'grip', 0, -0.01, 0.24],
  ],
  sniper: [
    ['box', [0.08, 0.1, 0.5], 'body', 0, 0, 0],
    ['box', [0.035, 0.035, 0.55], 'grip', 0, 0.03, -0.5],
    ['tube', [0.035, 0.035, 0.2, 12], 'accent', 0, 0.09, -0.05, Math.PI / 2],
    ['box', [0.07, 0.09, 0.24], 'grip', 0, -0.02, 0.34],
    ['box', [0.03, 0.12, 0.03], 'grip', 0, -0.08, -0.4],
  ],
  grenade: [
    ['ball', [0.055, 12, 10], 'body', 0, 0, 0],
    ['box', [0.02, 0.05, 0.02], 'accent', 0.05, 0.05, 0],
  ],
  rifle: [
    ['box', [0.09, 0.1, 0.42], 'body', 0, 0, 0],
    ['box', [0.045, 0.045, 0.4], 'grip', 0, 0.025, -0.38],
    ['box', [0.075, 0.08, 0.22], 'grip', 0, -0.02, 0.3],
    ['box', [0.03, 0.05, 0.08], 'accent', 0, 0.075, -0.05],
  ],
};

function makeGunMaterials() {
  return {
    grip: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.25 }),
    body: new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.45, metalness: 0.6 }),
    accent: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.2 }),
  };
}

function buildGunModel(def, mats) {
  const model = new THREE.Group();
  for (const [shape, size, mat, px, py, pz, rotX] of MODEL_PARTS[def.kind]) {
    let geo;
    if (shape === 'box') geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    else if (shape === 'tube') geo = new THREE.CylinderGeometry(size[0], size[1], size[2], size[3]);
    else geo = new THREE.SphereGeometry(size[0], size[1], size[2]);
    const part = new THREE.Mesh(geo, mats[mat]);
    part.position.set(px, py, pz);
    if (rotX) part.rotation.x = rotX;
    model.add(part);
  }
  model.position.set(0.27, -0.25, -0.46);
  model.scale.setScalar(0.8);
  return model;
}

function makeFlashTexture() {
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width: 128, height: 128 });
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  const stops = [
    [0, 'rgba(255, 240, 200, 1)'], [0.25, 'rgba(240, 168, 48, 0.9)'],
    [0.6, 'rgba(240, 140, 40, 0.35)'], [1, 'rgba(240, 140, 40, 0)'],
  ];
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

// One fighter's loadout: primary + sidearm + grenades, with per-weapon ammo state.
export function createLoadout(camera, isPlayer) {
  const mats = makeGunMaterials();
  const models = {};
  for (const def of Object.values(WEAPONS)) {
    const model = buildGunModel(def, mats);
    model.visible = false;
    if (isPlayer) camera.add(model);
    models[def.id] = model;
  }

  // Muzzle flash: radial-gradient burst quad (no hard square edges) + a light.
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ map: makeFlashTexture(), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.27, -0.22, -0.88);
  flash.visible = false;
  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 6);
  flashLight.position.set(0.27, -0.2, -0.7);
  if (isPlayer) {
    camera.add(flash);
    camera.add(flashLight);
  }

  const state = {
    primary: 'rifle',
    current: 'rifle',
    ammo: {},
    cooldown: 0,
    reloadLeft: 0,
    flash: 0,
    kick: 0,
    grenades: 0,
  };
  for (const def of Object.values(WEAPONS)) {
    state.ammo[def.id] = { mag: def.mag, reserve: def.reserve };
  }
  state.ammo.pistol = { mag: 12, reserve: 36 };

  function currentDef() {
    return WEAPONS[state.current];
  }

  function showModel() {
    for (const id of Object.keys(models)) models[id].visible = id === state.current;
  }
  showModel();

  function finishReload() {
    const def = currentDef();
    const slot = state.ammo[def.id];
    const need = def.mag - slot.mag;
    const take = Math.min(need, slot.reserve);
    slot.mag += take;
    slot.reserve -= take;
  }

  function fullAmmo(id) {
    return { mag: WEAPONS[id].mag, reserve: WEAPONS[id].reserve };
  }

  return {
    state,
    models,
    def() {
      return currentDef();
    },
    step(dt) {
      state.cooldown = Math.max(0, state.cooldown - dt);
      state.flash = Math.max(0, state.flash - dt);
      state.kick += (0 - state.kick) * Math.min(1, dt * 14);
      const model = models[state.current];
      if (model) {
        model.position.z = -0.42 + state.kick;
        model.rotation.x = state.kick * 2.2;
      }
      flash.visible = state.flash > 0;
      flash.rotation.z = state.flash * 30;
      flashLight.intensity = state.flash > 0 ? 18 : 0;
      if (state.reloadLeft > 0) {
        state.reloadLeft = Math.max(0, state.reloadLeft - dt);
        if (model) model.rotation.x = -0.55 * Math.min(1, (currentDef().reloadTime - state.reloadLeft) * 2);
        if (state.reloadLeft === 0) finishReload();
      }
    },
    ready() {
      const def = currentDef();
      if (def.kind === 'grenade') return state.grenades > 0 && state.cooldown === 0;
      return state.ammo[def.id].mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    takeRound() {
      const def = currentDef();
      if (def.kind === 'grenade') {
        if (state.grenades <= 0) return false;
        state.grenades -= 1;
        return true;
      }
      const slot = state.ammo[def.id];
      if (slot.mag <= 0) return false;
      slot.mag -= 1;
      return true;
    },
    pullTrigger() {
      state.cooldown = currentDef().fireGap;
      state.flash = 0.06;
      state.kick = 0.055;
    },
    reload() {
      const def = currentDef();
      if (def.kind === 'grenade') return;
      const slot = state.ammo[def.id];
      if (state.reloadLeft > 0 || slot.mag === def.mag || slot.reserve === 0) return;
      state.reloadLeft = def.reloadTime;
    },
    spread(speed) {
      const def = currentDef();
      return def.spreadStill + Math.min(1, speed / 5.2) * def.spreadMove;
    },
    switchTo(id) {
      if (!WEAPONS[id] || state.current === id) return false;
      if (id === state.primary || id === 'pistol' || id === 'grenade') {
        state.current = id;
        state.reloadLeft = 0;
        showModel();
        return true;
      }
      return false;
    },
    buyPrimary(id) {
      state.primary = id;
      state.current = id;
      state.ammo[id] = fullAmmo(id);
      state.reloadLeft = 0;
      showModel();
    },
    addGrenade() {
      state.grenades += 1;
    },
    resetRound(keepWeapons) {
      if (!keepWeapons) {
        state.primary = 'rifle';
        state.ammo.rifle = fullAmmo('rifle');
        state.ammo.smg = fullAmmo('smg');
        state.ammo.sniper = fullAmmo('sniper');
        state.ammo.pistol = fullAmmo('pistol');
        state.grenades = 0;
      }
      state.current = state.primary;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      showModel();
    },
    ammoText() {
      const def = currentDef();
      if (def.kind === 'grenade') return { mag: state.grenades, reserve: 0, label: 'x' };
      const slot = state.ammo[def.id];
      return { mag: slot.mag, reserve: slot.reserve, label: '/ ' };
    },
  };
}
