// FERROLINE entry point: boots the renderer, wires every module together and
// runs the fixed-timestep loop. Five attackers against five defenders, spike
// plant and defuse, a buy phase with an economy, bots that patrol routes and
// hold angles. ?shot=start|play|buy|end plus &seed=N renders one frozen
// frame for a capture: it paints twice, then sets window.__shotReady.
//
// FIGHTING ONLY HAPPENS WHILE A ROUND IS LIVE. That rule lives here and in
// game.js: listFoes() stays empty outside the live phase, so bots never spot
// or shoot each other (or the player) during buy, roundEnd or matchEnd;
// grenade blast damage is skipped outside live (a fuse outliving the round
// must not kill anyone); and the trigger only fires while live. The buy
// phase stays bloodless because every damage path checks the phase first.
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

// ---- Loop, camera and feel ----
const TICK = 1 / 60;
const MAX_DT = 0.1;
const MAX_TICKS = 5;
const EYE_HEIGHT = 1.55;
const PLAYER_AIM_HEIGHT = 1.25;
const BOT_AIM_HEIGHT = 1.2;
const RAY_RANGE = 140;
const VIEW_FOV = 74;
const VIEW_NEAR = 0.05;
const VIEW_FAR = 300;
const FOG_START = 34;
const FOG_END = 110;
const PIXEL_CAP = 2;
const EXPOSURE = 1.0;
const SHAKE_RECOVER = 0.02;
const SHAKE_SCALE = 0.02;

// ---- Grenades ----
const LOB_SPEED = 15;
const LOB_LIFT = 4.5;
const GRENADE_TIMER = 1.6;
const GRENADE_PULL = 16;
const BOUNCE_KEEP = 0.45;
const BOUNCE_DRAG = 0.7;
const GRENADE_REST = 0.09;
const BOUNCE_SILENT_BELOW = 1.5;
const THROW_AHEAD = 0.6;
const BLAST_REACH = 6.5;
const BLAST_MID_DMG = 110;
const BLAST_RIM_DMG = 15;
const BLAST_CHEST = 1.1;
const BLAST_HEARING = 42;
const SHAKE_BLAST = 0.7;

// ---- Shooting ----
const HEAD_AIM_ODDS = 0.14;
const HEAD_AIM_LIFT = 0.32;
const TRACER_AHEAD = 0.5;
const BOT_TRACER_AHEAD = 0.6;
const CAPSULE_HALF = 0.34;
const CAPSULE_HEIGHT = 1.72;
const HEAD_LINE = 1.45;
const BOT_HEAR_DIST = 30;
const NOISE_RIFLE = 26;
const NOISE_SNIPER = 34;
const NOISE_BOT = 22;
const SHAKE_SHOT = 0.08;
const SHAKE_SNIPER = 0.35;
const KICK_BASE = 0.009;
const KICK_NORM = 0.013;
const KICK_SPREAD = 0.004;

// ---- HUD / movement ----
const STEP_GAP = 0.42;
const STEP_MIN_SPEED = 1;
const CROSS_REST = 4;
const CROSS_SCALE = 900;
const CROSS_CAP = 34;
const MARK_MS = 90;
const MARK_SHOT_MS = 4000;

// ---- Capture mode (?shot=...&seed=...) ----
const query = new URLSearchParams(window.location.search);
const shotName = query.get('shot');
const seedValue = Number.parseInt(query.get('seed') ?? '1', 10) || 1;

function seededRandom(initialSeed) {
  let state = initialSeed;
  return function nextRandom() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seededRandom(seedValue);

// ---- Renderer, scene, camera ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_CAP));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.getElementById('game').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color('#232a38'), FOG_START, FOG_END);
const camera = new THREE.PerspectiveCamera(VIEW_FOV, window.innerWidth / window.innerHeight, VIEW_NEAR, VIEW_FAR);
scene.add(camera);

// ---- Modules ----
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
const input = createInput(renderer.domElement, handleLockChange);

const body = player.state;
const raycaster = new THREE.Raycaster();
raycaster.far = RAY_RANGE;
const aimDir = new THREE.Vector3();
const scratch = new THREE.Vector3();
const scratch2 = new THREE.Vector3();
const playerBox = new THREE.Box3();
const hitPoint = new THREE.Vector3();

let clock = 0;
let held = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let shakeAmt = 0;
let stepClock = 0;
let previousGun = 'rifle';
let firingLastFrame = false;
let shopOpen = false;
let liveGrenades = [];

// ---- Grenades: arced throws that bounce off the map and blow on a fuse. ----
const grenadeGeo = new THREE.SphereGeometry(GRENADE_REST, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.5, metalness: 0.5 });

function lobGrenade(from, dir) {
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
  mesh.position.copy(from);
  mesh.castShadow = true;
  scene.add(mesh);
  liveGrenades.push({
    mesh,
    vel: scratch.copy(dir).multiplyScalar(LOB_SPEED).add(new THREE.Vector3(0, LOB_LIFT, 0)).clone(),
    fuse: GRENADE_TIMER,
  });
  audio.grenadeBounce();
}

function detonate(g) {
  const pos = g.mesh.position.clone();
  scene.remove(g.mesh);
  effects.explosion(pos);
  audio.explosion();
  shakeAmt = Math.min(1, shakeAmt + SHAKE_BLAST);
  game.addNoise(pos.x, pos.z, BLAST_HEARING);
  // Damage falls off with distance: BLAST_MID_DMG at the centre, BLAST_RIM_DMG at the rim.
  const victims = [];
  if (player.state.alive) victims.push({ kind: 'player', pos: scratch2.copy(body.position).setY(body.position.y + BLAST_CHEST).clone(), ref: 'player' });
  for (const b of botsApi.bots) {
    if (b.alive) victims.push({ kind: 'bot', pos: b.group.position.clone().add(new THREE.Vector3(0, BLAST_CHEST, 0)), ref: b });
  }
  for (const v of victims) {
    const d = v.pos.distanceTo(pos);
    if (d > BLAST_REACH) continue;
    // A wall between the blast and the victim blocks it.
    raycaster.set(pos, scratch.copy(v.pos).sub(pos).normalize());
    raycaster.far = d;
    const blockedByWall = raycaster.intersectObjects(world.shootables, false)[0];
    if (blockedByWall) continue;
    const dmg = Math.round(BLAST_MID_DMG - (d / BLAST_REACH) * (BLAST_MID_DMG - BLAST_RIM_DMG));
    // Only live-phase damage counts: a fuse outliving the round must not
    // kill bots during buy or roundEnd.
    if (game.state.phase !== 'live') continue;
    if (v.kind === 'player') game.damagePlayer(dmg, 'torso', null);
    else if (botsApi.damage(v.ref, dmg, 'torso')) game.onKill(v.ref, 'player', 'torso');
  }
}

function tickGrenades(dt) {
  for (let i = liveGrenades.length - 1; i >= 0; i -= 1) {
    const g = liveGrenades[i];
    g.fuse -= dt;
    g.vel.y -= GRENADE_PULL * dt;
    const next = g.mesh.position.clone().addScaledVector(g.vel, dt);
    // Bounce: when the next point lands inside a collider, reflect the
    // dominant axis and damp the rest.
    let bounced = false;
    for (const c of world.colliders) {
      if (c.containsPoint(next)) {
        const dx = Math.min(Math.abs(next.x - c.min.x), Math.abs(next.x - c.max.x));
        const dz = Math.min(Math.abs(next.z - c.min.z), Math.abs(next.z - c.max.z));
        const dy = Math.min(Math.abs(next.y - c.min.y), Math.abs(next.y - c.max.y));
        if (dx <= dy && dx <= dz) g.vel.x *= -BOUNCE_KEEP;
        else if (dz <= dy) g.vel.z *= -BOUNCE_KEEP;
        else g.vel.y *= -BOUNCE_KEEP;
        g.vel.multiplyScalar(BOUNCE_DRAG);
        bounced = true;
        audio.grenadeBounce();
        break;
      }
    }
    if (!bounced) g.mesh.position.copy(next);
    if (g.mesh.position.y < GRENADE_REST) {
      g.mesh.position.y = GRENADE_REST;
      if (Math.abs(g.vel.y) > BOUNCE_SILENT_BELOW) audio.grenadeBounce();
      g.vel.y = Math.abs(g.vel.y) * BOUNCE_KEEP;
      g.vel.x *= BOUNCE_DRAG;
      g.vel.z *= BOUNCE_DRAG;
    }
    if (g.fuse <= 0) {
      detonate(g);
      liveGrenades.splice(i, 1);
    }
  }
}

// ---- Shooting: one hitscan path for the player, one for bots. ----
const shootables = world.shootables.concat(botsApi.hitMeshes);

function firePlayerShot(spread) {
  const def = loadout.def();
  if (def.kind === 'grenade') {
    if (!loadout.takeRound()) return false;
    camera.getWorldDirection(aimDir);
    lobGrenade(scratch.copy(camera.position).addScaledVector(aimDir, THROW_AHEAD).clone(), aimDir);
    loadout.pullTrigger();
    loadout.switchTo(previousGun);
    return true;
  }
  if (!loadout.takeRound()) {
    audio.dryFire();
    return false;
  }
  camera.getWorldDirection(aimDir);
  aimDir.x += (random() * 2 - 1) * spread;
  aimDir.y += (random() * 2 - 1) * spread;
  aimDir.z += (random() * 2 - 1) * spread;
  aimDir.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, aimDir);
  raycaster.far = def.range;
  const hit = raycaster.intersectObjects(shootables, false)[0];
  const muzzle = scratch.copy(camera.position).addScaledVector(aimDir, TRACER_AHEAD).clone();
  if (hit) {
    effects.tracer(muzzle, hit.point);
    const bot = hit.object.userData.bot;
    if (bot && bot.alive) {
      const part = hit.object.userData.part;
      const dmg = def.damage * (part === 'head' ? def.headMult : 1);
      effects.blood(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
      hud.hitMarker(false, MARK_MS);
      if (part === 'head') audio.headshot();
      else audio.hit();
      if (botsApi.damage(bot, dmg, part)) game.onKill(bot, 'player', part);
    } else {
      effects.impact(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
    }
  } else {
    effects.tracer(muzzle, scratch.copy(camera.position).addScaledVector(aimDir, def.range));
  }
  loadout.pullTrigger();
  player.recoil(KICK_BASE * (def.recoil / KICK_NORM) + random() * KICK_SPREAD, (random() * 2 - 1) * KICK_SPREAD);
  game.addNoise(body.position.x, body.position.z, def.kind === 'sniper' ? NOISE_SNIPER : NOISE_RIFLE);
  audio.shot(def.kind);
  shakeAmt = Math.min(1, shakeAmt + (def.kind === 'sniper' ? SHAKE_SNIPER : SHAKE_SHOT));
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, def.name);
  return true;
}

// A bot's shot: a real raycast with aim error, so moving targets get missed.
function fireBotShot(bot, target, err, def) {
  const from = scratch.copy(bot.group.position).setY(bot.group.position.y + EYE_HEIGHT).clone();
  const aim = target.isPlayer
    ? scratch2.copy(body.position).setY(body.position.y + PLAYER_AIM_HEIGHT)
    : scratch2.copy(target.pos).setY(target.pos.y + BOT_AIM_HEIGHT);
  aimDir.copy(aim).sub(from).normalize();
  // Aim error: usually the chest, sometimes the head.
  const aimHead = random() < HEAD_AIM_ODDS;
  if (aimHead) aimDir.y += HEAD_AIM_LIFT / Math.max(1, from.distanceTo(aim));
  aimDir.x += (random() * 2 - 1) * err;
  aimDir.y += (random() * 2 - 1) * err;
  aimDir.z += (random() * 2 - 1) * err;
  aimDir.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(from, aimDir);
  raycaster.far = def.range;
  const hits = raycaster.intersectObjects(shootables, false);
  const hit = hits[0];
  const muzzle = from.clone().addScaledVector(aimDir, BOT_TRACER_AHEAD);
  if (target.isPlayer) {
    // The player is a capsule: test the ray against a box around them.
    playerBox.min.set(body.position.x - CAPSULE_HALF, body.position.y, body.position.z - CAPSULE_HALF);
    playerBox.max.set(body.position.x + CAPSULE_HALF, body.position.y + CAPSULE_HEIGHT, body.position.z + CAPSULE_HALF);
    const playerHit = raycaster.ray.intersectBox(playerBox, hitPoint);
    const wallDist = hit ? hit.distance : Infinity;
    if (playerHit && hitPoint.distanceTo(from) < wallDist) {
      effects.tracer(muzzle, hitPoint.clone());
      const part = hitPoint.y > body.position.y + HEAD_LINE ? 'head' : 'torso';
      game.damagePlayer(def.damage, part, bot);
      // Direction indicator: 0 degrees means the shooter is straight ahead.
      const dx = bot.group.position.x - body.position.x;
      const dz = bot.group.position.z - body.position.z;
      const rel = Math.atan2(dx, dz) - body.yaw - Math.PI;
      hud.showDirection((rel * 180) / Math.PI);
    } else if (hit) {
      effects.tracer(muzzle, hit.point);
      effects.impact(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
    } else {
      effects.tracer(muzzle, from.clone().addScaledVector(aimDir, def.range));
    }
  } else if (hit && hit.object.userData.bot === target.bot) {
    effects.tracer(muzzle, hit.point);
    const part = hit.object.userData.part;
    const dmg = def.damage * (part === 'head' ? def.headMult : 1);
    effects.blood(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
    if (botsApi.damage(target.bot, dmg, part)) game.onKill(target.bot, bot, part);
  } else if (hit) {
    effects.tracer(muzzle, hit.point);
    effects.impact(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
  } else {
    effects.tracer(muzzle, from.clone().addScaledVector(aimDir, def.range));
  }
  const distToPlayer = from.distanceTo(body.position);
  if (distToPlayer < BOT_HEAR_DIST) audio.shot(def.kind);
  else audio.distantShot();
  game.addNoise(bot.group.position.x, bot.group.position.z, NOISE_BOT);
}

// Line of sight between two points: clear when no world surface sits
// closer than the target.
function hasLineOfSight(x1, y1, z1, x2, y2, z2) {
  scratch.set(x2 - x1, y2 - y1, z2 - z1);
  const dist = scratch.length();
  if (dist < 0.01) return true;
  raycaster.set(scratch2.set(x1, y1, z1), scratch.normalize());
  raycaster.far = dist;
  return !raycaster.intersectObjects(world.shootables, false)[0];
}

function listFoes(bot) {
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
      isPlayer: false, alive: true, pos: other.group.position, vel: scratch2.set(0, 0, 0), bot: other,
    });
  }
  return list;
}

// What botAI sees: time, phase, noise, bomb, and the combat primitives.
// Every combat call funnels through the phase gates above.
//
// Channel starts go through a guard here: a channel already owned by a
// live bot is never stolen, and a channel whose owner died is cancelled
// first so a successor can take it over instead of waiting forever.
const botCtx = {
  get time() {
    return clock;
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
  enemiesOf: listFoes,
  los(x1, y1, z1, x2, y2, z2) {
    return hasLineOfSight(x1, y1, z1, x2, y2, z2);
  },
  blocked(x, z) {
    return game.blocked(x, z);
  },
  botShoot(bot, target, err, def) {
    fireBotShot(bot, target, err, def);
  },
  plantStart(bot) {
    const channel = game.state && game.state.plant;
    if (channel && channel.active && channel.who) {
      if (channel.who === bot) return true;
      if (channel.who.alive === false) {
        if (game.cancelChannel) game.cancelChannel(channel.who);
      } else return false;
    }
    return game.tryPlant(bot);
  },
  plantActive(bot) {
    return game.state.plant.active && game.state.plant.who === bot;
  },
  defuseStart(bot) {
    const channel = game.state && game.state.defuse;
    if (channel && channel.active && channel.who) {
      if (channel.who === bot) return true;
      if (channel.who.alive === false) {
        if (game.cancelChannel) game.cancelChannel(channel.who);
      } else return false;
    }
    return game.tryDefuse(bot);
  },
  defuseActive(bot) {
    return game.state.defuse.active && game.state.defuse.who === bot;
  },
};

// ---- Buy menu ----
function purchase(id) {
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
    // The P9 is the free sidearm every agent already carries: never charge
    // for it, mirroring the bots' buyFor rule.
    const tag = id === 'pistol' ? 0 : def.price;
    if (tag > 0) game.state.money -= tag;
    if (def.slot === 1) loadout.buyPrimary(id);
    previousGun = id;
  }
  audio.buy();
  hud.setMoney(game.state.money);
  hud.openBuy(game.state.money, ownedItems());
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, loadout.def().name);
}

function ownedItems() {
  const owned = [loadout.state.primary, 'pistol'];
  if (player.state.armor >= 100) owned.push('armor');
  if (loadout.state.grenades > 0) owned.push('grenade');
  return owned;
}

hud.onBuy = purchase;

function setBuyMenu(open) {
  if (game.state.phase !== 'buy') return;
  shopOpen = open;
  if (open) {
    hud.openBuy(game.state.money, ownedItems());
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    hud.closeBuy();
    input.requestLock();
  }
}

hud.onPlay(() => {
  audio.unlock();
  if (shotName) return;
  if (game.state.phase === 'menu' || game.state.phase === 'matchEnd') {
    game.startMatch();
    setBuyMenu(true);
  }
  if (game.state.phase === 'buy' && !shopOpen) input.requestLock();
  else if (game.state.phase === 'live') input.requestLock();
  else if (game.state.phase === 'roundEnd') input.requestLock();
  hud.hideOverlay();
});

function handleLockChange(locked) {
  if (shotName) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
    if (shopOpen) setBuyMenu(false);
  } else if (game.state.phase === 'live' && player.state.alive) {
    hud.showOverlay('paused', game.state.score);
  }
}

function updateCamera() {
  shakeAmt = Math.max(0, shakeAmt - SHAKE_RECOVER);
  const shake = shakeAmt * shakeAmt * SHAKE_SCALE;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(
    body.pitch + (random() * 2 - 1) * shake,
    body.yaw + (random() * 2 - 1) * shake,
    0,
    'YXZ',
  );
}

function tick(dt) {
  clock += dt;
  game.step(dt, input.state);
  // Bots think and move.
  for (const bot of botsApi.bots) {
    if (!bot.alive && bot.state !== 'dead') continue;
    if (bot.state === 'plant' && !botCtx.plantActive(bot)) bot.state = 'hold';
    if (bot.state === 'defuse' && !botCtx.defuseActive(bot)) bot.state = 'hold';
    botAI.stepBot(bot, dt, botCtx);
    if (bot.state === 'plant') game.plantTick(dt, bot);
    if (bot.state === 'defuse') game.defuseTick(dt, bot);
    bot.loadout.step(dt);
  }
  // Player movement and weapon.
  if (player.state.alive && (game.state.phase === 'buy' || game.state.phase === 'live')) {
    player.step(dt, input.state.keys);
    const speed = player.groundSpeed();
    if (speed > STEP_MIN_SPEED && player.onGround) {
      stepClock -= dt;
      if (stepClock <= 0) {
        stepClock = STEP_GAP;
        audio.step();
      }
    }
  }
  loadout.step(dt);
  tickGrenades(dt);
  effects.step(dt);
  // HUD numbers, every tick (the HUD dedupes by value).
  const ammoText = loadout.ammoText();
  hud.setHealth(player.state.health, player.state.armor);
  hud.setAmmo(ammoText.mag, ammoText.reserve, ammoText.label, loadout.def().name);
  hud.setMoney(game.state.money);
  hud.setFeed(game.state.feed);
  const spreadPx = CROSS_REST + loadout.spread(player.groundSpeed()) * CROSS_SCALE;
  hud.setCrosshairSpread(Math.min(CROSS_CAP, spreadPx));
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastTime) / 1000, MAX_DT);
  lastTime = now;
  if (!held) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    const pressed = input.takePressed();
    if (!shotName && game.state.phase !== 'menu' && game.state.phase !== 'matchEnd') {
      if (pressed.has('KeyB') || pressed.has('Escape')) {
        if (hud.isBuyOpen()) setBuyMenu(false);
        else if (game.state.phase === 'buy') setBuyMenu(true);
      }
      if (hud.isBuyOpen()) {
        for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']) {
          if (pressed.has(key)) {
            purchase(['rifle', 'smg', 'sniper', 'pistol', 'armor', 'grenade'][Number(key.slice(5)) - 1]);
          }
        }
      } else {
        if (pressed.has('Digit1')) {
          previousGun = loadout.state.current;
          loadout.switchTo(loadout.state.primary);
        }
        if (pressed.has('Digit2')) {
          previousGun = loadout.state.current;
          loadout.switchTo('pistol');
        }
        if (pressed.has('Digit3')) {
          previousGun = loadout.state.current;
          loadout.switchTo('grenade');
        }
        if (pressed.has('KeyQ')) {
          const cur = loadout.state.current;
          loadout.switchTo(previousGun);
          previousGun = cur;
        }
        if (pressed.has('WheelUp') || pressed.has('WheelDown')) {
          const order = [loadout.state.primary, 'pistol', 'grenade'];
          const idx = order.indexOf(loadout.state.current);
          const next = order[(idx + (pressed.has('WheelUp') ? 1 : order.length - 1)) % order.length];
          previousGun = loadout.state.current;
          loadout.switchTo(next);
        }
        if (pressed.has('KeyG')) {
          previousGun = loadout.state.current;
          if (loadout.switchTo('grenade') && loadout.ready()) firePlayerShot(0);
          else loadout.switchTo(previousGun);
        }
      }
    }
    // Firing is live-phase only: holding the trigger during buy does nothing.
    if (input.state.firing && game.state.phase === 'live' && player.state.alive) {
      const def = loadout.def();
      if (loadout.ready() && (def.auto || !firingLastFrame)) {
        firePlayerShot(loadout.spread(player.groundSpeed()));
      } else if (loadout.ammoText().mag === 0 && def.kind !== 'grenade') {
        loadout.reload();
      }
    }
    firingLastFrame = input.state.firing;
    if (input.state.keys.has('KeyR')) loadout.reload();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= TICK && steps < MAX_TICKS) {
      tick(TICK);
      accumulator -= TICK;
      steps += 1;
    }
    if (accumulator > TICK * MAX_TICKS) accumulator = 0;
    updateCamera();
  }
  renderer.render(scene, camera);
}

function settleSteps(steps) {
  for (let index = 0; index < steps; index += 1) tick(TICK);
}

function lookAtPoint(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  updateCamera();
}

function poseBot(bot, x, z, yaw, holdNode) {
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
function captureScene(name) {
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
    poseBot(vanguard[0], -3, 12, Math.PI, 'vMid');
    poseBot(vanguard[1], 3, 13, Math.PI, 'vMid');
    poseBot(sentinel[0], -8, -2, 0, 'midA');
    poseBot(sentinel[1], 8, -4, 0, 'midB');
    settleSteps(30);
    lookAtPoint(new THREE.Vector3(-6, 2.2, -8));
    hud.setHealth(100, 0);
    hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(800);
    hud.setTimer(15, 'BUY');
    hud.setScore(0, 0, 1);
    hud.showOverlay('start', { vanguard: 0, sentinel: 0 });
  } else if (name === 'buy') {
    hud.setPhase('buy', 2, [1, 0]);
    player.teleport(0, 0, 16, Math.PI);
    poseBot(vanguard[0], -4, 12, Math.PI, 'vMid');
    poseBot(vanguard[1], 4, 12, Math.PI, 'vMid');
    poseBot(sentinel[0], 0, -6, 0, 'midTop');
    settleSteps(30);
    lookAtPoint(new THREE.Vector3(0, 1.6, -6));
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
    poseBot(sentinel[0], -2, -4, 0.3, 'midDoor');
    poseBot(sentinel[1], 3, -7, -0.4, 'midTop');
    poseBot(vanguard[0], -5, 4, Math.PI, 'midLow');
    settleSteps(20);
    const target = sentinel[0].group.position.clone().setY(1.25);
    lookAtPoint(target);
    firePlayerShot(0);
    settleSteps(1);
    hud.setHealth(82, 50);
    hud.setAmmo(27, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(3550);
    hud.setTimer(87, 'ROUND');
    hud.setScore(1, 0, 2);
    hud.setBomb('carry');
    hud.hitMarker(false, MARK_SHOT_MS);
  } else {
    // end: round won, banner up, spike smoke over Site A.
    game.state.phase = 'roundEnd';
    game.state.score = { vanguard: 2, sentinel: 0 };
    game.state.round = 2;
    hud.setPhase('roundEnd', 2, [2, 0]);
    player.teleport(-6, 0, 2, Math.PI * 0.85);
    poseBot(vanguard[0], -10, -4, Math.PI, 'aEntry');
    poseBot(vanguard[1], -4, -8, Math.PI, 'aSite');
    poseBot(sentinel[0], 12, -6, 0.5, 'bEntry');
    effects.smoke(new THREE.Vector3(-12, 1.5, -10), 5, 4);
    effects.smoke(new THREE.Vector3(-10, 2, -8), 3.5, 4);
    settleSteps(20);
    lookAtPoint(new THREE.Vector3(-14, 1.8, -12));
    hud.setHealth(64, 25);
    hud.setAmmo(18, 60, '/ ', 'AR-77 Longshot');
    hud.setMoney(6500);
    hud.setTimer(0, 'ROUND');
    hud.setScore(2, 0, 2);
    hud.setBomb(null);
    hud.showBanner('VANGUARD WINS THE ROUND', 'Spike detonated at Crane Deck', 4000);
  }
  renderTwiceThenFreeze();
}

function renderTwiceThenFreeze() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    updateCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      held = true;
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
updateCamera();
if (shotName) captureScene(shotName);
else requestAnimationFrame(loop);
