// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// FERROLINE — a round-based tactical FPS: 5v5, spike plant/defuse, economy and a buy
// menu, bots that walk routes, hold angles and shoot back. ?shot=start|play|buy|end
// with &seed=N sets up a deterministic frame for a capture, renders it twice, then
// freezes it and sets window.__shotReady.
//
// COMBAT GATING — the rule this file enforces alongside game.js: no combat
// outside the live phase. enemiesOf() returns an empty list unless the phase
// is 'live' (bots cannot spot or shoot anyone during buy / roundEnd /
// matchEnd), grenade blast damage is skipped unless the phase is 'live'
// (a fuse that runs past the round end must not kill bots), and the player
// can only fire while the phase is 'live'. The buy phase is bloodless
// because every damage path checks the phase before dealing damage.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createLoadout, WEAPONS, ARMOR_PRICE } from './weapons.js';
import { createBots } from './bots.js';
import { createBotAI } from './botai.js';
import { createGame } from './game.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';

// ---- Simulation and camera constants ----
const FIXED_STEP = 1 / 60; // fixed simulation step (60 Hz)
const MAX_FRAME_DT = 0.1; // clamp a long frame to 100 ms of simulation
const MAX_STEPS_PER_FRAME = 5; // never run more than 5 fixed steps per frame
const EYE = 1.55; // bot eye height above the ground (aim origin)
const PLAYER_EYE_OFFSET = 1.25; // bot aim height on the player capsule
const BOT_EYE_OFFSET = 1.2; // bot aim height on another bot
const RAYCAST_FAR = 140; // default raycast range (m)
const CAMERA_FOV = 74;
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 300;
const FOG_NEAR = 34;
const FOG_FAR = 110;
const MAX_PIXEL_RATIO = 2;
const TONE_MAPPING_EXPOSURE = 1.0;
const TRAUMA_DECAY = 0.02; // camera trauma recovered per frame
const TRAUMA_SHAKE = 0.02; // shake scale (multiplied by trauma^2)

// ---- Grenade constants ----
const GRENADE_THROW_SPEED = 15; // horizontal throw speed (m/s)
const GRENADE_THROW_UP = 4.5; // upward throw component (m/s)
const GRENADE_FUSE = 1.6; // seconds from throw to explosion
const GRENADE_GRAVITY = 16; // downward acceleration (m/s^2)
const GRENADE_BOUNCE = 0.45; // velocity kept on the dominant bounce axis
const GRENADE_FRICTION = 0.7; // velocity kept on the other axes per bounce
const GRENADE_FLOOR_Y = 0.09; // grenade radius: rest height on the floor
const GRENADE_FLOOR_BOUNCE_MIN_SPEED = 1.5; // below this, floor hits are silent
const GRENADE_SPAWN_AHEAD = 0.6; // spawn distance in front of the camera
const BLAST_RADIUS = 6.5; // grenade lethal radius (m)
const BLAST_CENTER_DMG = 110; // damage at the centre of the blast
const BLAST_EDGE_DMG = 15; // damage at the edge of the blast
const BLAST_VICTIM_HEIGHT = 1.1; // chest height used for blast distance
const BLAST_NOISE_RADIUS = 42; // how far the explosion can be heard
const TRAUMA_GRENADE = 0.7; // camera trauma added by an explosion

// ---- Shooting constants ----
const HEADSHOT_AIM_CHANCE = 0.14; // bots aim for the head this often
const HEADSHOT_AIM_OFFSET = 0.32; // vertical aim offset for a headshot attempt
const MUZZLE_AHEAD = 0.5; // player tracer start, ahead of the camera
const BOT_MUZZLE_AHEAD = 0.6; // bot tracer start, ahead of the muzzle
const PLAYER_HALF_WIDTH = 0.34; // player capsule half-width (m)
const PLAYER_HEIGHT = 1.72; // player capsule height (m)
const PLAYER_HEAD_LINE = 1.45; // above this height a hit counts as a headshot
const BOT_HEARING_RANGE = 30; // within this range bot shots use the near sound
const NOISE_SHOT_RIFLE = 26; // noise radius of a rifle-class shot
const NOISE_SHOT_SNIPER = 34; // noise radius of a sniper shot
const NOISE_SHOT_BOT = 22; // noise radius of a bot shot
const TRAUMA_SHOT = 0.08; // camera trauma per normal shot
const TRAUMA_SHOT_SNIPER = 0.35; // camera trauma per sniper shot
const RECOIL_BASE = 0.009; // base pitch recoil
const RECOIL_REFERENCE = 0.013; // recoil normalisation (rifle recoil)
const RECOIL_JITTER = 0.004; // random pitch/yaw recoil jitter

// ---- HUD / movement constants ----
const STEP_INTERVAL = 0.42; // seconds between footstep sounds while moving
const MIN_MOVE_SPEED_FOR_STEPS = 1; // below this speed no footsteps play
const CROSSHAIR_BASE_PX = 4; // crosshair spread at rest (px)
const CROSSHAIR_SPREAD_SCALE = 900; // spread units -> px
const CROSSHAIR_MAX_PX = 34; // crosshair spread cap (px)
const HITMARKER_MS = 90; // hitmarker display time (ms)
const HITMARKER_SHOT_MS = 4000; // hitmarker display time in the play capture

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color('#232a38'), FOG_NEAR, FOG_FAR);
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
scene.add(camera);

const world = createWorld(scene);
const audio = createAudio();
const effects = createEffects(scene, camera);
const hud = createHud();
const player = createPlayer(world.colliders);
const loadout = createLoadout(camera, true);
const botsApi = createBots(scene, world);
const botAI = createBotAI(world);
for (const bot of botsApi.bots) {
  bot.ai = botAI;
  bot.findPath = botsApi.findPath;
}
const game = createGame(world, botsApi, player, loadout, hud, audio, effects);
const input = createInput(renderer.domElement, onLockChange);

const body = player.state;
const raycaster = new THREE.Raycaster();
raycaster.far = RAYCAST_FAR;
const direction = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const playerBox = new THREE.Box3();
const hitPoint = new THREE.Vector3();

let elapsed = 0;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let trauma = 0;
let stepTimer = 0;
let lastWeapon = 'rifle';
let wasFiring = false;
let buyOpen = false;
let grenades = [];

// ---- Grenades: thrown with an arc, bounce off colliders, explode on the fuse. ----
const grenadeGeo = new THREE.SphereGeometry(GRENADE_FLOOR_Y, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.5, metalness: 0.5 });

function throwGrenade(from, dir) {
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
  mesh.position.copy(from);
  mesh.castShadow = true;
  scene.add(mesh);
  grenades.push({
    mesh,
    vel: tmpV.copy(dir).multiplyScalar(GRENADE_THROW_SPEED).add(new THREE.Vector3(0, GRENADE_THROW_UP, 0)).clone(),
    fuse: GRENADE_FUSE,
  });
  audio.grenadeBounce();
}

function explodeGrenade(g) {
  const pos = g.mesh.position.clone();
  scene.remove(g.mesh);
  effects.explosion(pos);
  audio.explosion();
  trauma = Math.min(1, trauma + TRAUMA_GRENADE);
  game.addNoise(pos.x, pos.z, BLAST_NOISE_RADIUS);
  // Radius damage with falloff: BLAST_CENTER_DMG at the centre, BLAST_EDGE_DMG at BLAST_RADIUS.
  const victims = [];
  if (player.state.alive) victims.push({ kind: 'player', pos: tmpV2.copy(body.position).setY(body.position.y + BLAST_VICTIM_HEIGHT).clone(), ref: 'player' });
  for (const b of botsApi.bots) {
    if (b.alive) victims.push({ kind: 'bot', pos: b.group.position.clone().add(new THREE.Vector3(0, BLAST_VICTIM_HEIGHT, 0)), ref: b });
  }
  for (const v of victims) {
    const d = v.pos.distanceTo(pos);
    if (d > BLAST_RADIUS) continue;
    // A wall between the blast and the victim blocks it.
    raycaster.set(pos, tmpV.copy(v.pos).sub(pos).normalize());
    raycaster.far = d;
    const blockedByWall = raycaster.intersectObjects(world.shootables, false)[0];
    if (blockedByWall) continue;
    const dmg = Math.round(BLAST_CENTER_DMG - (d / BLAST_RADIUS) * (BLAST_CENTER_DMG - BLAST_EDGE_DMG));
    // Damage only counts in the live phase: a fuse that runs past the round
    // end must not kill bots during buy / roundEnd.
    if (game.state.phase !== 'live') continue;
    if (v.kind === 'player') game.damagePlayer(dmg, 'torso', null);
    else if (botsApi.damage(v.ref, dmg, 'torso')) game.onKill(v.ref, 'player', 'torso');
  }
}

function stepGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i -= 1) {
    const g = grenades[i];
    g.fuse -= dt;
    g.vel.y -= GRENADE_GRAVITY * dt;
    const next = g.mesh.position.clone().addScaledVector(g.vel, dt);
    // Bounce: if the next point is inside a collider, reflect the dominant axis.
    let bounced = false;
    for (const c of world.colliders) {
      if (c.containsPoint(next)) {
        const dx = Math.min(Math.abs(next.x - c.min.x), Math.abs(next.x - c.max.x));
        const dz = Math.min(Math.abs(next.z - c.min.z), Math.abs(next.z - c.max.z));
        const dy = Math.min(Math.abs(next.y - c.min.y), Math.abs(next.y - c.max.y));
        if (dx <= dy && dx <= dz) g.vel.x *= -GRENADE_BOUNCE;
        else if (dz <= dy) g.vel.z *= -GRENADE_BOUNCE;
        else g.vel.y *= -GRENADE_BOUNCE;
        g.vel.multiplyScalar(GRENADE_FRICTION);
        bounced = true;
        audio.grenadeBounce();
        break;
      }
    }
    if (!bounced) g.mesh.position.copy(next);
    if (g.mesh.position.y < GRENADE_FLOOR_Y) {
      g.mesh.position.y = GRENADE_FLOOR_Y;
      if (Math.abs(g.vel.y) > GRENADE_FLOOR_BOUNCE_MIN_SPEED) audio.grenadeBounce();
      g.vel.y = Math.abs(g.vel.y) * GRENADE_BOUNCE;
      g.vel.x *= GRENADE_FRICTION;
      g.vel.z *= GRENADE_FRICTION;
    }
    if (g.fuse <= 0) {
      explodeGrenade(g);
      grenades.splice(i, 1);
    }
  }
}

// ---- Shooting: one hitscan path for the player, one for bots. ----
const shootables = world.shootables.concat(botsApi.hitMeshes);

function playerShoot(spread) {
  const def = loadout.def();
  if (def.kind === 'grenade') {
    if (!loadout.takeRound()) return false;
    camera.getWorldDirection(direction);
    throwGrenade(tmpV.copy(camera.position).addScaledVector(direction, GRENADE_SPAWN_AHEAD).clone(), direction);
    loadout.pullTrigger();
    loadout.switchTo(lastWeapon);
    return true;
  }
  if (!loadout.takeRound()) {
    audio.dryFire();
    return false;
  }
  camera.getWorldDirection(direction);
  direction.x += (random() * 2 - 1) * spread;
  direction.y += (random() * 2 - 1) * spread;
  direction.z += (random() * 2 - 1) * spread;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  raycaster.far = def.range;
  const hit = raycaster.intersectObjects(shootables, false)[0];
  const muzzle = tmpV.copy(camera.position).addScaledVector(direction, MUZZLE_AHEAD).clone();
  if (hit) {
    effects.tracer(muzzle, hit.point);
    const bot = hit.object.userData.bot;
    if (bot && bot.alive) {
      const part = hit.object.userData.part;
      const dmg = def.damage * (part === 'head' ? def.headMult : 1);
      effects.blood(hit.point, hit.face ? hit.face.normal : tmpV2.set(0, 1, 0));
      hud.hitMarker(false, HITMARKER_MS);
      if (part === 'head') audio.headshot();
      else audio.hit();
      if (botsApi.damage(bot, dmg, part)) game.onKill(bot, 'player', part);
    } else {
      effects.impact(hit.point, hit.face ? hit.face.normal : tmpV2.set(0, 1, 0));
    }
  } else {
    effects.tracer(muzzle, tmpV.copy(camera.position).addScaledVector(direction, def.range));
  }
  loadout.pullTrigger();
  player.recoil(RECOIL_BASE * (def.recoil / RECOIL_REFERENCE) + random() * RECOIL_JITTER, (random() * 2 - 1) * RECOIL_JITTER);
  game.addNoise(body.position.x, body.position.z, def.kind === 'sniper' ? NOISE_SHOT_SNIPER : NOISE_SHOT_RIFLE);
  audio.shot(def.kind);
  trauma = Math.min(1, trauma + (def.kind === 'sniper' ? TRAUMA_SHOT_SNIPER : TRAUMA_SHOT));
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, def.name);
  return true;
}

// Bot-to-target shot: a real raycast with aim error, so bots miss moving targets.
function botShoot(bot, target, err, def) {
  const from = tmpV.copy(bot.group.position).setY(bot.group.position.y + EYE).clone();
  const aim = target.isPlayer
    ? tmpV2.copy(body.position).setY(body.position.y + PLAYER_EYE_OFFSET)
    : tmpV2.copy(target.pos).setY(target.pos.y + BOT_EYE_OFFSET);
  direction.copy(aim).sub(from).normalize();
  // Aim error: mostly chest, sometimes the head.
  const aimHead = random() < HEADSHOT_AIM_CHANCE;
  if (aimHead) direction.y += HEADSHOT_AIM_OFFSET / Math.max(1, from.distanceTo(aim));
  direction.x += (random() * 2 - 1) * err;
  direction.y += (random() * 2 - 1) * err;
  direction.z += (random() * 2 - 1) * err;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(from, direction);
  raycaster.far = def.range;
  const hits = raycaster.intersectObjects(shootables, false);
  const hit = hits[0];
  const muzzle = from.clone().addScaledVector(direction, BOT_MUZZLE_AHEAD);
  if (target.isPlayer) {
    // The player is a capsule: test the ray against a box around them.
    playerBox.min.set(body.position.x - PLAYER_HALF_WIDTH, body.position.y, body.position.z - PLAYER_HALF_WIDTH);
    playerBox.max.set(body.position.x + PLAYER_HALF_WIDTH, body.position.y + PLAYER_HEIGHT, body.position.z + PLAYER_HALF_WIDTH);
    const playerHit = raycaster.ray.intersectBox(playerBox, hitPoint);
    const wallDist = hit ? hit.distance : Infinity;
    if (playerHit && hitPoint.distanceTo(from) < wallDist) {
      effects.tracer(muzzle, hitPoint.clone());
      const part = hitPoint.y > body.position.y + PLAYER_HEAD_LINE ? 'head' : 'torso';
      game.damagePlayer(def.damage, part, bot);
      // Direction indicator: 0 deg means the shooter is straight ahead.
      const dx = bot.group.position.x - body.position.x;
      const dz = bot.group.position.z - body.position.z;
      const rel = Math.atan2(dx, dz) - body.yaw - Math.PI;
      hud.showDirection((rel * 180) / Math.PI);
    } else if (hit) {
      effects.tracer(muzzle, hit.point);
      effects.impact(hit.point, hit.face ? hit.face.normal : tmpV2.set(0, 1, 0));
    } else {
      effects.tracer(muzzle, from.clone().addScaledVector(direction, def.range));
    }
  } else if (hit && hit.object.userData.bot === target.bot) {
    effects.tracer(muzzle, hit.point);
    const part = hit.object.userData.part;
    const dmg = def.damage * (part === 'head' ? def.headMult : 1);
    effects.blood(hit.point, hit.face ? hit.face.normal : tmpV2.set(0, 1, 0));
    if (botsApi.damage(target.bot, dmg, part)) game.onKill(target.bot, bot, part);
  } else if (hit) {
    effects.tracer(muzzle, hit.point);
    effects.impact(hit.point, hit.face ? hit.face.normal : tmpV2.set(0, 1, 0));
  } else {
    effects.tracer(muzzle, from.clone().addScaledVector(direction, def.range));
  }
  const distToPlayer = from.distanceTo(body.position);
  if (distToPlayer < BOT_HEARING_RANGE) audio.shot(def.kind);
  else audio.distantShot();
  game.addNoise(bot.group.position.x, bot.group.position.z, NOISE_SHOT_BOT);
}

// Line of sight between two points: clear when no world surface is closer than the target.
function los(x1, y1, z1, x2, y2, z2) {
  tmpV.set(x2 - x1, y2 - y1, z2 - z1);
  const dist = tmpV.length();
  if (dist < 0.01) return true;
  raycaster.set(tmpV2.set(x1, y1, z1), tmpV.normalize());
  raycaster.far = dist;
  return !raycaster.intersectObjects(world.shootables, false)[0];
}

function enemiesOf(bot) {
  const list = [];
  // No combat outside the live phase: bots must not spot or shoot each
  // other (or the player) during buy, roundEnd or matchEnd.
  if (game.state.phase !== 'live') return list;
  if (bot.team === 'sentinel' && player.state.alive) {
    list.push({
      isPlayer: true, alive: true, pos: body.position, vel: body.velocity, bot: null,
    });
  }
  for (const other of botsApi.bots) {
    if (other.team === bot.team || !other.alive) continue;
    list.push({
      isPlayer: false, alive: true, pos: other.group.position, vel: tmpV2.set(0, 0, 0), bot: other,
    });
  }
  return list;
}

// The context botAI sees: time, phase, noise, bomb, and the combat
// primitives. All combat calls funnel through the phase gates above.
const botCtx = {
  get time() {
    return elapsed;
  },
  get phase() {
    return game.state.phase;
  },
  get noise() {
    return game.state.noise;
  },
  get bomb() {
    return game.state.bomb;
  },
  enemiesOf,
  los(x1, y1, z1, x2, y2, z2) {
    return los(x1, y1, z1, x2, y2, z2);
  },
  blocked(x, z) {
    return game.blocked(x, z);
  },
  botShoot(bot, target, err, def) {
    botShoot(bot, target, err, def);
  },
  plantStart(bot) {
    game.tryPlant(bot);
  },
  defuseStart(bot) {
    game.tryDefuse(bot);
  },
};

// ---- Buy menu ----
function buyItem(id) {
  if (game.state.phase !== 'buy') return;
  const money = game.state.money;
  if (id === 'armor') {
    if (money < ARMOR_PRICE || player.state.armor >= 100) return;
    game.state.money -= ARMOR_PRICE;
    player.state.armor = 100;
  } else if (id === 'grenade') {
    if (money < WEAPONS.grenade.price) return;
    game.state.money -= WEAPONS.grenade.price;
    loadout.addGrenade();
  } else {
    const def = WEAPONS[id];
    if (!def || money < def.price) return;
    game.state.money -= def.price;
    if (def.slot === 1) loadout.buyPrimary(id);
    lastWeapon = id;
  }
  audio.buy();
  hud.setMoney(game.state.money);
  hud.openBuy(game.state.money, ownedIds());
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, loadout.def().name);
}

function ownedIds() {
  const owned = [loadout.state.primary, 'pistol'];
  if (player.state.armor >= 100) owned.push('armor');
  if (loadout.state.grenades > 0) owned.push('grenade');
  return owned;
}

hud.onBuy = buyItem;

function toggleBuy(open) {
  if (game.state.phase !== 'buy') return;
  buyOpen = open;
  if (open) {
    hud.openBuy(game.state.money, ownedIds());
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    hud.closeBuy();
    input.requestLock();
  }
}

hud.onPlay(() => {
  audio.unlock();
  if (shot) return;
  if (game.state.phase === 'menu' || game.state.phase === 'matchEnd') {
    game.startMatch();
    toggleBuy(true);
  }
  if (game.state.phase === 'buy' && !buyOpen) input.requestLock();
  else if (game.state.phase === 'live') input.requestLock();
  else if (game.state.phase === 'roundEnd') input.requestLock();
  hud.hideOverlay();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
    if (buyOpen) toggleBuy(false);
  } else if (game.state.phase === 'live' && player.state.alive) {
    hud.showOverlay('paused', game.state.score);
  }
}

function syncCamera() {
  trauma = Math.max(0, trauma - TRAUMA_DECAY);
  const shake = trauma * trauma * TRAUMA_SHAKE;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(
    body.pitch + (random() * 2 - 1) * shake,
    body.yaw + (random() * 2 - 1) * shake,
    0,
    'YXZ',
  );
}

function step(dt) {
  elapsed += dt;
  game.step(dt, input.state);
  // Bots think and move.
  for (const bot of botsApi.bots) {
    if (!bot.alive && bot.state !== 'dead') continue;
    botAI.stepBot(bot, dt, botCtx);
    if (bot.state === 'plant') game.plantTick(dt, bot);
    if (bot.state === 'defuse') game.defuseTick(dt, bot);
    bot.loadout.step(dt);
  }
  // Player movement and weapon.
  if (player.state.alive && (game.state.phase === 'buy' || game.state.phase === 'live')) {
    player.step(dt, input.state.keys);
    const speed = player.groundSpeed();
    if (speed > MIN_MOVE_SPEED_FOR_STEPS && player.onGround) {
      stepTimer -= dt;
      if (stepTimer <= 0) {
        stepTimer = STEP_INTERVAL;
        audio.step();
      }
    }
  }
  loadout.step(dt);
  stepGrenades(dt);
  effects.step(dt);
  // HUD numbers, every tick (the HUD dedupes by value).
  const ammoText = loadout.ammoText();
  hud.setHealth(player.state.health, player.state.armor);
  hud.setAmmo(ammoText.mag, ammoText.reserve, ammoText.label, loadout.def().name);
  hud.setMoney(game.state.money);
  hud.setFeed(game.state.feed);
  const spreadPx = CROSSHAIR_BASE_PX + loadout.spread(player.groundSpeed()) * CROSSHAIR_SPREAD_SCALE;
  hud.setCrosshairSpread(Math.min(CROSSHAIR_MAX_PX, spreadPx));
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    const pressed = input.takePressed();
    if (!shot && game.state.phase !== 'menu' && game.state.phase !== 'matchEnd') {
      if (pressed.has('KeyB') || pressed.has('Escape')) {
        if (hud.isBuyOpen()) toggleBuy(false);
        else if (game.state.phase === 'buy') toggleBuy(true);
      }
      if (hud.isBuyOpen()) {
        for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']) {
          if (pressed.has(key)) {
            buyItem(['rifle', 'smg', 'sniper', 'pistol', 'armor', 'grenade'][Number(key.slice(5)) - 1]);
          }
        }
      } else {
        if (pressed.has('Digit1')) {
          lastWeapon = loadout.state.current;
          loadout.switchTo(loadout.state.primary);
        }
        if (pressed.has('Digit2')) {
          lastWeapon = loadout.state.current;
          loadout.switchTo('pistol');
        }
        if (pressed.has('Digit3')) {
          lastWeapon = loadout.state.current;
          loadout.switchTo('grenade');
        }
        if (pressed.has('KeyQ')) {
          const cur = loadout.state.current;
          loadout.switchTo(lastWeapon);
          lastWeapon = cur;
        }
        if (pressed.has('WheelUp') || pressed.has('WheelDown')) {
          const order = [loadout.state.primary, 'pistol', 'grenade'];
          const idx = order.indexOf(loadout.state.current);
          const next = order[(idx + (pressed.has('WheelUp') ? 1 : order.length - 1)) % order.length];
          lastWeapon = loadout.state.current;
          loadout.switchTo(next);
        }
        if (pressed.has('KeyG')) {
          lastWeapon = loadout.state.current;
          if (loadout.switchTo('grenade') && loadout.ready()) playerShoot(0);
          else loadout.switchTo(lastWeapon);
        }
      }
    }
    // Firing is live-phase only: holding the trigger during buy does nothing.
    if (input.state.firing && game.state.phase === 'live' && player.state.alive) {
      const def = loadout.def();
      if (loadout.ready() && (def.auto || !wasFiring)) {
        playerShoot(loadout.spread(player.groundSpeed()));
      } else if (loadout.ammoText().mag === 0 && def.kind !== 'grenade') {
        loadout.reload();
      }
    }
    wasFiring = input.state.firing;
    if (input.state.keys.has('KeyR')) loadout.reload();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * MAX_STEPS_PER_FRAME) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function placeBotForShot(bot, x, z, yaw, holdNode) {
  bot.group.position.set(x, 0, z);
  bot.group.visible = true;
  bot.alive = true;
  bot.health = 100;
  bot.yaw = yaw;
  bot.group.rotation.y = yaw;
  bot.state = 'hold';
  bot.holdNode = holdNode;
  bot.holdYaw = yaw;
  bot.holdTimer = 60;
}

// ---- Screenshot captures: deterministic scenes for the entry's screenshots. ----
function runShot(name) {
  hud.hideOverlay();
  hud.closeBuy();
  game.startMatch();
  // Deterministic bots: fixed lanes, fixed site.
  game.state.bomb.site = 'A';
  const vanguard = botsApi.bots.filter((b) => b.team === 'vanguard');
  const sentinel = botsApi.bots.filter((b) => b.team === 'sentinel');
  if (name === 'start') {
    hud.setPhase('buy', 1, [0, 0]);
    body.pitch = 0;
    player.teleport(0, 0, 17.5, Math.PI);
    placeBotForShot(vanguard[0], -3, 12, Math.PI, 'vMid');
    placeBotForShot(vanguard[1], 3, 13, Math.PI, 'vMid');
    placeBotForShot(sentinel[0], -8, -2, 0, 'midA');
    placeBotForShot(sentinel[1], 8, -4, 0, 'midB');
    settle(30);
    aimAt(new THREE.Vector3(-6, 2.2, -8));
    hud.setHealth(100, 0);
    hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(800);
    hud.setTimer(15, 'BUY');
    hud.setScore(0, 0, 1);
    hud.showOverlay('start', { vanguard: 0, sentinel: 0 });
  } else if (name === 'buy') {
    hud.setPhase('buy', 2, [1, 0]);
    player.teleport(0, 0, 16, Math.PI);
    placeBotForShot(vanguard[0], -4, 12, Math.PI, 'vMid');
    placeBotForShot(vanguard[1], 4, 12, Math.PI, 'vMid');
    placeBotForShot(sentinel[0], 0, -6, 0, 'midTop');
    settle(30);
    aimAt(new THREE.Vector3(0, 1.6, -6));
    hud.setHealth(100, 100);
    hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(3250);
    hud.setTimer(12, 'BUY');
    hud.setScore(1, 0, 2);
    hud.openBuy(3250, ['rifle', 'pistol']);
  } else if (name === 'play') {
    game.state.phase = 'live';
    game.state.timer = 87;
    hud.setPhase('live', 2, [1, 0]);
    player.teleport(1.5, 0, 8, Math.PI);
    placeBotForShot(sentinel[0], -2, -4, 0.3, 'midDoor');
    placeBotForShot(sentinel[1], 3, -7, -0.4, 'midTop');
    placeBotForShot(vanguard[0], -5, 4, Math.PI, 'midLow');
    settle(20);
    const target = sentinel[0].group.position.clone().setY(1.25);
    aimAt(target);
    playerShoot(0);
    settle(1);
    hud.setHealth(82, 50);
    hud.setAmmo(27, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(3550);
    hud.setTimer(87, 'ROUND');
    hud.setScore(1, 0, 2);
    hud.setBomb('carry');
    hud.hitMarker(false, HITMARKER_SHOT_MS);
  } else {
    // end: round won, banner up, spike smoke over Site A.
    game.state.phase = 'roundEnd';
    game.state.score = { vanguard: 2, sentinel: 0 };
    game.state.round = 2;
    hud.setPhase('roundEnd', 2, [2, 0]);
    player.teleport(-6, 0, 2, Math.PI * 0.85);
    placeBotForShot(vanguard[0], -10, -4, Math.PI, 'aEntry');
    placeBotForShot(vanguard[1], -4, -8, Math.PI, 'aSite');
    placeBotForShot(sentinel[0], 12, -6, 0.5, 'bEntry');
    effects.smoke(new THREE.Vector3(-12, 1.5, -10), 5, 4);
    effects.smoke(new THREE.Vector3(-10, 2, -8), 3.5, 4);
    settle(20);
    aimAt(new THREE.Vector3(-14, 1.8, -12));
    hud.setHealth(64, 25);
    hud.setAmmo(18, 60, '/ ', 'AR-77 Longshot');
    hud.setMoney(6500);
    hud.setTimer(0, 'ROUND');
    hud.setScore(2, 0, 2);
    hud.setBomb(null);
    hud.showBanner('VANGUARD WINS THE ROUND', 'Spike detonated at Crane Deck', 4000);
  }
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.setHealth(100, 0);
hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
hud.setMoney(800);
hud.setTimer(15, 'BUY');
hud.setScore(0, 0, 1);
syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
