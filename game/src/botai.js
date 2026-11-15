// FERROLINE bot AI — one brain per bot, driven by the match context.
//
// A bot is a state machine: it walks its waypoint path (advance / rotate),
// holds its angle (hold), channels the spike (plant / defuse), or is dead.
// The carrier tries to plant whenever it stands inside a site, whatever
// state it is in; a defender routes to the planted site and defuses when
// close. Combat runs in every walking/holding state: the bot scans for
// foes on a short countdown, turns to face a new target after a human-like
// reaction delay, and fires in bursts. Objectives are checked through the
// context callbacks, which return whether the channel actually started —
// the AI only enters a channel state on a true return, and re-checks the
// channel every tick so a cancelled or stolen channel recovers instead of
// wedging.
//
// Movement walks the path with axis-separated steps (so a bot slides along
// a wall instead of stopping on it). A bot that has not moved for a second
// starts sidestepping, flipping side each time the slide is itself blocked;
// a node that makes no progress for three seconds is skipped. The brain
// (bot._ai) is created lazily on the first step and survives round resets;
// resetBot only clears the fields that must not leak across rounds.
import * as THREE from 'three';

// ---- tuning ----
const WALK_SPEED = 3.6; // units per second on foot
const ARRIVE_DIST = 0.5; // close enough to a waypoint to take the next one
const NODE_TIMEOUT = 3; // seconds without progress before a node is skipped
const PROGRESS_STEP = 0.03; // a shrinking distance that counts as progress
const STILL_STEP = 0.03; // accumulated displacement that counts as "moved"
const STILL_SIDESTEP_AFTER = 1; // seconds without moving before sidestepping
const SIDESTEP_TIME = 0.6; // seconds a sidestep lasts
const TURN_RATE = 7; // rad/s for every turn the bot makes
const SWAY_RATE = 0.5; // rad/s of the hold sway
const SWAY_AMP = 0.3; // radians of hold sway
const SCAN_EVERY = 0.12; // seconds between foe scans
const REACT_MIN = 0.25; // reaction delay, minimum
const REACT_VAR = 0.35; // reaction delay, extra random span
const BURST_MIN = 3; // shots per burst, minimum
const BURST_VAR = 3; // shots per burst, extra random span
const BURST_PAUSE_MIN = 0.45; // pause between bursts, minimum
const BURST_PAUSE_VAR = 0.5; // pause between bursts, extra random span
const TARGET_RANGE = 45; // foes farther away than this are ignored
const NOISE_HEAR = 30; // how far away a noise can be heard
const NOISE_KEEP = 1.5; // seconds a heard noise stays fresh
const DEFUSE_REACH = 2.2; // how close a defuser must stand to the spike
const SITE_PROBE_H = 0.5; // height used for the site-zone probe
const EYE_BOT = 1.2; // aim height for a bot foe
const EYE_PLAYER = 1.25; // aim height for the player foe

// The world is captured once at creation; every helper below closes over it.
let world = null;

const tmpV = new THREE.Vector3();

function clampTurn(from, to, maxStep) {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  if (d > maxStep) return from + maxStep;
  if (d < -maxStep) return from - maxStep;
  return to;
}

function turnBot(bot, angle, dt) {
  bot.yaw = clampTurn(bot.yaw, angle, TURN_RATE * dt);
  bot.group.rotation.y = bot.yaw;
}

function yawToward(x, z, tx, tz) {
  return Math.atan2(tx - x, tz - z);
}

function freshBrain(bot) {
  return {
    target: null,
    distance: Infinity,
    scanT: 0,
    reactUntil: 0,
    burstPauseUntil: 0,
    burstLeft: 0,
    noiseSeen: -1,
    noiseUntil: 0,
    noiseYaw: 0,
    swayPhase: Math.random() * Math.PI * 2,
    stillT: 0,
    sideT: 0,
    sideDir: 1,
    repaths: 0,
    nodeIdx: -1,
    nodeStuckT: 0,
    bestDistance: Infinity,
    lastX: bot.group.position.x,
    lastZ: bot.group.position.z,
  };
}

function brainOf(bot) {
  if (!bot._ai) bot._ai = freshBrain(bot);
  return bot._ai;
}

function nearestNodeId(bot) {
  let best = null;
  let bestD = Infinity;
  for (const id of Object.keys(world.waypoints.nodes)) {
    const n = world.waypoints.nodes[id];
    const d = (n[0] - bot.group.position.x) * (n[0] - bot.group.position.x)
      + (n[1] - bot.group.position.z) * (n[1] - bot.group.position.z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function setPath(bot, goal) {
  let route;
  try {
    route = bot.findPath ? bot.findPath(nearestNodeId(bot), goal) : null;
  } catch (e) {
    route = null;
  }
  bot.path = route && route.length ? route : [goal];
  bot.pathIndex = 0;
  bot.afterMid = bot.afterMid || null;
  const brain = brainOf(bot);
  brain.nodeIdx = -1;
  brain.nodeStuckT = 0;
  brain.bestDistance = Infinity;
}

function plantNodeFor(site) {
  return site === 'A' ? 'aPlant' : 'bPlant';
}

// ---- planting: the carrier plants whenever it stands inside a site,
// whatever it was doing. Returns true when a channel started. ----
function tryPlant(bot, ctx) {
  if (!bot.isCarrier || !ctx.bomb || ctx.bomb.status !== 'carried') return false;
  const zone = world.sites[bot.site] ? world.sites[bot.site].zone : null;
  const p = bot.group.position;
  if (!zone || !zone.containsPoint(tmpV.set(p.x, p.y + SITE_PROBE_H, p.z))) return false;
  if (!ctx.plantStart(bot)) return false;
  bot.state = 'plant';
  return true;
}

// ---- hearing: walk the batch newest-first; an inaudible noise never
// masks an older audible one, and the whole batch is marked seen. ----
function listenForNoise(bot, ctx, brain) {
  const p = bot.group.position;
  let newest = brain.noiseSeen;
  const sounds = ctx.noise || [];
  for (let i = sounds.length - 1; i >= 0; i--) {
    const sound = sounds[i];
    if (sound.time > newest) newest = sound.time;
    if (sound.time <= brain.noiseSeen) continue;
    if (Math.hypot(sound.pos.x - p.x, sound.pos.z - p.z) > NOISE_HEAR) continue;
    brain.noiseYaw = yawToward(p.x, p.z, sound.pos.x, sound.pos.z);
    brain.noiseUntil = ctx.time + NOISE_KEEP;
    break;
  }
  brain.noiseSeen = newest;
}

// ---- combat: scan on a countdown, aim, fire in bursts. ----
function combatStep(bot, dt, ctx, brain) {
  if (ctx.phase !== 'live') {
    brain.target = null;
    brain.burstLeft = 0;
    return;
  }
  brain.scanT -= dt;
  if (brain.scanT <= 0) {
    brain.scanT = SCAN_EVERY;
    let selected = null;
    let closest = Infinity;
    const p = bot.group.position;
    for (const foe of ctx.enemiesOf(bot) || []) {
      if (!foe.alive) continue;
      const d = Math.hypot(foe.pos.x - p.x, foe.pos.z - p.z);
      if (d > TARGET_RANGE || d >= closest) continue;
      const aimY = foe.isPlayer ? EYE_PLAYER : EYE_BOT;
      if (!ctx.los(p.x, p.y + 1.55, p.z, foe.pos.x, foe.pos.y + aimY, foe.pos.z)) continue;
      selected = foe;
      closest = d;
    }
    const previous = brain.target;
    if (selected && (!previous || selected.isPlayer !== previous.foe.isPlayer || selected.bot !== previous.foe.bot)) {
      brain.reactUntil = ctx.time + REACT_MIN + Math.random() * REACT_VAR;
      brain.burstLeft = 0;
    }
    brain.target = selected ? { foe: selected } : null;
    brain.distance = closest;
  }
  const target = brain.target;
  if (!target || !target.foe.alive) return;
  const foe = target.foe;
  const p = bot.group.position;
  turnBot(bot, yawToward(p.x, p.z, foe.pos.x, foe.pos.z), dt);
  if (ctx.time < brain.reactUntil) return;
  if (ctx.time < brain.burstPauseUntil) return;
  const gun = bot.loadout;
  if (!gun.ready()) return;
  if (brain.burstLeft <= 0) {
    brain.burstLeft = BURST_MIN + Math.floor(Math.random() * BURST_VAR);
  }
  if (!gun.takeRound()) {
    // Empty magazine: reload if there is reserve, otherwise fall back to
    // the stocked sidearm instead of standing dry.
    if (!gun.reload() && gun.state.current !== 'pistol') {
      const ammo = gun.ammoText();
      if (ammo.mag === 0 && ammo.reserve === 0) gun.switchTo('pistol');
    }
    brain.burstLeft = 0;
    return;
  }
  let error = 0.014 + brain.distance * 0.0011;
  if (foe.vel && (Math.abs(foe.vel.x) > 0.5 || Math.abs(foe.vel.z) > 0.5)) error += 0.012;
  if (bot.state === 'advance' || bot.state === 'rotate') error += 0.010;
  ctx.botShoot(bot, foe, error, gun.def());
  gun.pullTrigger();
  brain.burstLeft -= 1;
  if (brain.burstLeft <= 0) {
    brain.burstPauseUntil = ctx.time + BURST_PAUSE_MIN + Math.random() * BURST_PAUSE_VAR;
  }
}

// ---- movement: axis-separated steps so a bot slides along a wall;
// a bot that has not moved for a second sidesteps, and a node that
// makes no progress is skipped. Returns true when the path is done. ----
function translate(bot, dx, dz, ctx) {
  const p = bot.group.position;
  if (!ctx.blocked || !ctx.blocked(p.x + dx, p.z + dz)) {
    p.x += dx;
    p.z += dz;
  } else if (!ctx.blocked(p.x + dx, p.z)) {
    p.x += dx;
  } else if (!ctx.blocked(p.x, p.z + dz)) {
    p.z += dz;
  }
}

function walkPath(bot, dt, ctx, brain) {
  if (!bot.path || bot.pathIndex >= bot.path.length) return true;
  const nodeId = bot.path[bot.pathIndex];
  const node = world.waypoints.nodes[nodeId];
  if (!node) {
    // Missing waypoint: drop it and stay walking this tick, so the
    // arrival transition is delayed by one tick.
    bot.pathIndex += 1;
    return false;
  }
  const p = bot.group.position;
  const dx = node[0] - p.x;
  const dz = node[1] - p.z;
  const distance = Math.hypot(dx, dz);
  if (distance < ARRIVE_DIST) {
    bot.pathIndex += 1;
    brain.stillT = 0;
    brain.nodeIdx = -1;
    return bot.pathIndex >= bot.path.length;
  }
  if (brain.nodeIdx !== bot.pathIndex) {
    brain.nodeIdx = bot.pathIndex;
    brain.bestDistance = distance;
    brain.nodeStuckT = 0;
  }
  // Progress: only a shrinking distance to the node resets the timer, so
  // a healthy long edge is never skipped merely for taking a while.
  if (distance < brain.bestDistance - PROGRESS_STEP) {
    brain.bestDistance = distance;
    brain.nodeStuckT = 0;
  } else {
    brain.nodeStuckT += dt;
  }
  if (brain.nodeStuckT > NODE_TIMEOUT) {
    // No progress for too long: skip the node and clear any sidestep.
    bot.pathIndex += 1;
    brain.nodeIdx = -1;
    brain.stillT = 0;
    brain.sideT = 0;
    return bot.pathIndex >= bot.path.length;
  }
  const angle = yawToward(p.x, p.z, node[0], node[1]);
  turnBot(bot, angle, dt);
  if (brain.sideT > 0) {
    brain.sideT -= dt;
    const sx = -Math.cos(angle) * brain.sideDir * WALK_SPEED * dt;
    const sz = Math.sin(angle) * brain.sideDir * WALK_SPEED * dt;
    if (ctx.blocked && ctx.blocked(p.x + sx, p.z + sz)) brain.sideDir *= -1;
    else {
      p.x += sx;
      p.z += sz;
    }
  } else {
    translate(bot, dx / distance * WALK_SPEED * dt, dz / distance * WALK_SPEED * dt, ctx);
    // Stillness: accumulated displacement from the anchor.
    if (Math.hypot(p.x - brain.lastX, p.z - brain.lastZ) < STILL_STEP) {
      brain.stillT += dt;
    } else {
      brain.stillT = 0;
      brain.lastX = p.x;
      brain.lastZ = p.z;
    }
    if (brain.stillT > STILL_SIDESTEP_AFTER) {
      brain.stillT = 0;
      brain.sideT = SIDESTEP_TIME;
      brain.sideDir *= -1;
      brain.repaths += 1;
      if (brain.repaths % 3 === 0) setPath(bot, bot.path[bot.path.length - 1]);
    }
  }
  return false;
}

function stepBot(bot, dt, ctx) {
  if (!bot.alive) return;
  const brain = brainOf(bot);
  // Channels: a lost channel drops the bot back to hold; the plant or
  // defuse is re-attempted on the next tick, never wedged in place.
  if (bot.state === 'plant') {
    const bomb = ctx.bomb;
    if (!bomb || bomb.status !== 'carried' || !bot.isCarrier || (ctx.plantActive && !ctx.plantActive(bot))) bot.state = 'hold';
    return;
  }
  if (bot.state === 'defuse') {
    const bomb = ctx.bomb;
    if (!bomb || bomb.status !== 'planted' || (ctx.defuseActive && !ctx.defuseActive(bot))) bot.state = 'hold';
    return;
  }
  const bomb = ctx.bomb;
  if (tryPlant(bot, ctx)) return;
  if (bot.role === 'defend' && bomb && bomb.status === 'planted') {
    const p = bot.group.position;
    if (bomb.plantPos && Math.hypot(p.x - bomb.plantPos.x, p.z - bomb.plantPos.z) <= DEFUSE_REACH && ctx.defuseStart(bot)) {
      bot.state = 'defuse';
      return;
    }
    if (bot.state === 'hold') {
      setPath(bot, plantNodeFor(bomb.site));
      bot.state = 'advance';
    }
  }
  if (bot.state === 'advance' || bot.state === 'rotate') {
    if (walkPath(bot, dt, ctx, brain)) {
      if (bot.afterMid) {
        const goal = bot.afterMid;
        bot.afterMid = null;
        setPath(bot, goal);
      } else {
        bot.state = 'hold';
        if (bot.holdNode && world.waypoints.nodes[bot.holdNode]) {
          turnBot(bot, bot.holdYaw !== undefined && bot.holdYaw !== null ? bot.holdYaw : bot.yaw, dt);
        }
        if (bot.isCarrier && bomb && bomb.status === 'carried' && !tryPlant(bot, ctx)) {
          setPath(bot, plantNodeFor(bot.site));
          bot.state = 'advance';
        }
      }
    }
    combatStep(bot, dt, ctx, brain);
    return;
  }
  // Holding: listen, face the hold angle (or a fresh noise) with a sway,
  // and work the objective when the round is live.
  listenForNoise(bot, ctx, brain);
  brain.swayPhase += dt * SWAY_RATE;
  if (!brain.target) {
    const facing = ctx.time < brain.noiseUntil
      ? brain.noiseYaw
      : (bot.holdYaw !== undefined && bot.holdYaw !== null ? bot.holdYaw : bot.yaw) + Math.sin(brain.swayPhase) * SWAY_AMP;
    turnBot(bot, facing, dt);
  }
  combatStep(bot, dt, ctx, brain);
  if (bot.isCarrier && bomb && bomb.status === 'carried') {
    if (tryPlant(bot, ctx)) return;
    const zone = world.sites[bot.site] ? world.sites[bot.site].zone : null;
    const p = bot.group.position;
    if (zone && !zone.containsPoint(tmpV.set(p.x, p.y + SITE_PROBE_H, p.z))) {
      setPath(bot, plantNodeFor(bot.site));
      bot.state = 'advance';
    }
  }
  if (bot.holdTimer !== undefined && bot.holdTimer !== null) {
    bot.holdTimer -= dt;
    if (bot.holdTimer <= 0) {
      bot.holdTimer = 60;
      const neighbors = (world.waypoints.adjacency[nearestNodeId(bot)] || []).filter((id) => id !== bot.holdNode);
      if (neighbors.length) {
        const goal = neighbors[Math.floor(Math.random() * neighbors.length)];
        bot.holdNode = goal;
        bot.holdYaw = Math.random() * Math.PI * 2;
        setPath(bot, goal);
        bot.state = 'advance';
      }
    }
  }
}

export function createBotAI(worldArg) {
  world = worldArg;
  return { stepBot, setPath };
}
