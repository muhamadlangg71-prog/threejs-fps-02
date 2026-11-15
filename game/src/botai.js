// Bot brains: routes, holds, engages, plants, defuses. One stepBot call
// per bot per tick; the brain is a small state machine over the states
// game.js assigns — 'advance' along a waypoint path, 'hold' on an angle,
// 'rotate' to a planted spike, 'plant' and 'defuse' while channelling.
//
// Two rules shape everything here. First, combat is live-phase only: the
// brain never scans, aims or shoots unless ctx.phase is 'live', so the buy
// phase stays bloodless even though the bots keep walking to their holds.
// Second, walking never wedges: walkTo watches for no progress and, after
// a second of standing still, sidesteps perpendicular to its heading
// (alternating sides) and re-paths if that still fails, so a bot facing a
// post dead-on slides around it instead of pushing forever.
//
// Fights are bursts with a reaction delay: a bot that spots an enemy
// waits a beat, fires three to five rounds with an aim error that grows
// with distance and movement, then pauses. It reloads when its magazine
// runs dry, turns toward loud noises while holding, and — when it carries
// the spike — plants as soon as it stands inside a site.
import * as THREE from 'three';

const WALK_SPEED = 3.6;
const ARRIVE_DIST = 0.5;
const TURN_RATE = 7;
const SCAN_EVERY = 0.12;
const ENGAGE_RANGE = 45;
const REACT_MIN = 0.25;
const REACT_VAR = 0.35;
const BURST_MIN = 3;
const BURST_VAR = 3;
const BURST_PAUSE_MIN = 0.45;
const BURST_PAUSE_VAR = 0.5;
const AIM_BASE = 0.014;
const AIM_PER_METER = 0.0011;
const AIM_MOVING_TARGET = 0.012;
const AIM_MOVING_SELF = 0.01;
const STUCK_AFTER = 1.0;
const NODE_SKIP_AFTER = 3.0;
const STILL_EPS = 0.03;
const SIDESTEP_TIME = 0.6;
const NOISE_HEAR_DIST = 30;
const NOISE_FRESH = 1.0;
const HOLD_SWAY = 0.3;
const PLANT_NODES = { A: 'aPlant', B: 'bPlant' };
const DEFUSE_REACH = 2.2;

function nearestNodeId(world, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const id of Object.keys(world.waypoints.nodes)) {
    const [nx, nz] = world.waypoints.nodes[id];
    const d = (nx - x) * (nx - x) + (nz - z) * (nz - z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function nodePos(world, id) {
  const n = world.waypoints.nodes[id];
  return n ? { x: n[0], z: n[1] } : null;
}

function turnToward(current, target, maxStep) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

function yawToward(bot, tx, tz) {
  const dx = tx - bot.group.position.x;
  const dz = tz - bot.group.position.z;
  return Math.atan2(dx, dz);
}

export function createBotAI(world) {
  const scratch = new THREE.Vector3();

  function setPath(bot, goalId) {
    const start = nearestNodeId(world, bot.group.position.x, bot.group.position.z);
    let path = [];
    if (bot.findPath) {
      try {
        path = bot.findPath(start, goalId) || [];
      } catch {
        path = [];
      }
    }
    if (!path.length) path = [goalId];
    bot.path = path;
    bot.pathIndex = 0;
    bot.afterMid = bot.afterMid || null;
  }

  function ensureBrain(bot) {
    if (!bot._ai) {
      bot._ai = {
        scanT: 0,
        target: null,
        reactUntil: 0,
        burstLeft: 0,
        burstPauseUntil: 0,
        lastX: bot.group.position.x,
        lastZ: bot.group.position.z,
        stillT: 0,
        sideT: 0,
        sideDir: 1,
        repaths: 0,
        noiseSeen: -1,
        noiseYaw: 0,
        noiseUntil: 0,
        swayPhase: Math.random() * Math.PI * 2,
      };
    }
    return bot._ai;
  }

  // Walk one tick toward the current path node. Returns 'arrived' when the
  // path is done, 'walking' while moving, 'stuck' while sidestepping.
  function walkTo(bot, dt, ctx, brain) {
    if (!bot.path || bot.pathIndex >= bot.path.length) return 'arrived';
    const node = nodePos(world, bot.path[bot.pathIndex]);
    if (!node) {
      bot.pathIndex += 1;
      return 'walking';
    }
    // Unreachable-node skip: some waypoint nodes sit inside solid
    // geometry (a site on the crane deck, a hold tight against it) and
    // no amount of sidestepping gets the bot onto them. If one node eats
    // three seconds without arrival, drop it and walk on — the bot holds
    // where it stands, which is close enough to fight from.
    if (brain.nodeIdx !== bot.pathIndex) {
      brain.nodeIdx = bot.pathIndex;
      brain.nodeStuckT = 0;
    } else {
      brain.nodeStuckT = (brain.nodeStuckT || 0) + dt;
      if (brain.nodeStuckT > NODE_SKIP_AFTER) {
        bot.pathIndex += 1;
        brain.nodeIdx = bot.pathIndex;
        brain.nodeStuckT = 0;
        brain.stillT = 0;
        brain.sideT = 0;
        return bot.pathIndex >= bot.path.length ? 'arrived' : 'walking';
      }
    }
    const pos = bot.group.position;
    const dx = node.x - pos.x;
    const dz = node.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_DIST) {
      bot.pathIndex += 1;
      brain.stillT = 0;
      return bot.pathIndex >= bot.path.length ? 'arrived' : 'walking';
    }
    // Sidestepping: slide perpendicular to the heading for a short burst.
    if (brain.sideT > 0) {
      brain.sideT -= dt;
      const px = -dz / (dist || 1);
      const pz = dx / (dist || 1);
      const sx = pos.x + px * brain.sideDir * WALK_SPEED * dt;
      const sz = pos.z + pz * brain.sideDir * WALK_SPEED * dt;
      if (!ctx.blocked(sx, sz)) {
        pos.x = sx;
        pos.z = sz;
      } else {
        brain.sideDir *= -1;
      }
      bot.yaw = turnToward(bot.yaw, Math.atan2(dx, dz), TURN_RATE * dt);
      bot.group.rotation.y = bot.yaw;
      return 'stuck';
    }
    const step = WALK_SPEED * dt;
    const nx = pos.x + (dx / dist) * step;
    const nz = pos.z + (dz / dist) * step;
    if (!ctx.blocked(nx, nz)) {
      pos.x = nx;
      pos.z = nz;
    } else if (!ctx.blocked(nx, pos.z)) {
      pos.x = nx;
    } else if (!ctx.blocked(pos.x, nz)) {
      pos.z = nz;
    }
    bot.yaw = turnToward(bot.yaw, Math.atan2(dx, dz), TURN_RATE * dt);
    bot.group.rotation.y = bot.yaw;
    // Stuck watch: no real movement while trying to walk means wedged.
    const moved = Math.hypot(pos.x - brain.lastX, pos.z - brain.lastZ);
    if (moved < STILL_EPS) {
      brain.stillT += dt;
      if (brain.stillT > STUCK_AFTER) {
        brain.stillT = 0;
        brain.sideDir *= -1;
        brain.sideT = SIDESTEP_TIME;
        brain.repaths += 1;
        if (brain.repaths >= 3) {
          brain.repaths = 0;
          const goal = bot.path[bot.path.length - 1];
          setPath(bot, goal);
        }
      }
    } else {
      brain.stillT = 0;
      brain.lastX = pos.x;
      brain.lastZ = pos.z;
    }
    return 'walking';
  }

  function visibleEnemies(bot, ctx) {
    const foes = ctx.enemiesOf(bot);
    const eye = scratch.set(bot.group.position.x, bot.group.position.y + 1.55, bot.group.position.z);
    const out = [];
    for (const foe of foes) {
      if (!foe.alive) continue;
      const fx = foe.pos.x;
      const fz = foe.pos.z;
      const d = Math.hypot(fx - bot.group.position.x, fz - bot.group.position.z);
      if (d > ENGAGE_RANGE) continue;
      const chestY = foe.isPlayer ? foe.pos.y + 1.25 : foe.pos.y + 1.2;
      if (!ctx.los(eye.x, eye.y, eye.z, fx, chestY, fz)) continue;
      out.push({ foe, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function aimError(bot, target) {
    let err = AIM_BASE + target.dist * AIM_PER_METER;
    if (target.foe.vel && (Math.abs(target.foe.vel.x) > 0.5 || Math.abs(target.foe.vel.z) > 0.5)) {
      err += AIM_MOVING_TARGET;
    }
    if (bot.state === 'advance' || bot.state === 'rotate') err += AIM_MOVING_SELF;
    return err;
  }

  function engage(bot, dt, ctx, brain) {
    if (ctx.phase !== 'live') {
      brain.target = null;
      brain.burstLeft = 0;
      return;
    }
    brain.scanT -= dt;
    if (brain.scanT <= 0) {
      brain.scanT = SCAN_EVERY;
      const seen = visibleEnemies(bot, ctx);
      const next = seen.length ? seen[0] : null;
      // Compare the fighter behind the entry, not the entry itself:
      // enemiesOf builds a fresh wrapper object on every call, so an
      // object-identity check would see a "new" target each scan and
      // reset the reaction delay forever — the bot would never fire.
      if (next && (!brain.target || brain.target.foe.bot !== next.foe.bot)) {
        brain.reactUntil = ctx.time + REACT_MIN + Math.random() * REACT_VAR;
        brain.burstLeft = 0;
      }
      brain.target = next;
    }
    const target = brain.target;
    if (!target) return;
    const foe = target.foe;
    const aimAt = foe.isPlayer
      ? { x: foe.pos.x, y: foe.pos.y + 1.25, z: foe.pos.z }
      : { x: foe.pos.x, y: foe.pos.y + 1.2, z: foe.pos.z };
    bot.yaw = turnToward(bot.yaw, yawToward(bot, aimAt.x, aimAt.z), TURN_RATE * dt);
    bot.group.rotation.y = bot.yaw;
    if (ctx.time < brain.reactUntil) return;
    if (ctx.time < brain.burstPauseUntil) return;
    const gun = bot.loadout;
    if (!gun.ready()) return;
    if (brain.burstLeft <= 0) {
      brain.burstLeft = BURST_MIN + Math.floor(Math.random() * BURST_VAR);
    }
    if (!gun.takeRound()) {
      gun.reload();
      brain.burstLeft = 0;
      return;
    }
    ctx.botShoot(bot, foe, aimError(bot, target), gun.def());
    gun.pullTrigger();
    brain.burstLeft -= 1;
    if (brain.burstLeft <= 0) {
      brain.burstPauseUntil = ctx.time + BURST_PAUSE_MIN + Math.random() * BURST_PAUSE_VAR;
    }
  }

  function listenForNoise(bot, ctx, brain) {
    const noises = ctx.noise || [];
    for (let i = noises.length - 1; i >= 0; i -= 1) {
      const n = noises[i];
      if (n.time <= brain.noiseSeen) continue;
      brain.noiseSeen = n.time;
      const d = Math.hypot(n.pos.x - bot.group.position.x, n.pos.z - bot.group.position.z);
      if (d > NOISE_HEAR_DIST) continue;
      brain.noiseYaw = Math.atan2(n.pos.x - bot.group.position.x, n.pos.z - bot.group.position.z);
      brain.noiseUntil = ctx.time + 1.5;
    }
  }

  function tryPlant(bot, ctx) {
    if (!bot.isCarrier) return false;
    if (!ctx.bomb || ctx.bomb.status !== 'carried') return false;
    const site = world.sites[bot.site];
    if (!site) return false;
    const pos = bot.group.position;
    scratch.set(pos.x, pos.y + 0.5, pos.z);
    if (!site.zone.containsPoint(scratch)) return false;
    if (ctx.plantStart(bot)) {
      bot.state = 'plant';
      return true;
    }
    return false;
  }

  function walkToPlant(bot, ctx) {
    const node = PLANT_NODES[bot.site] || 'aPlant';
    setPath(bot, node);
    bot.state = 'advance';
  }

  function tryDefuse(bot, ctx) {
    if (bot.role !== 'defend') return false;
    if (!ctx.bomb || ctx.bomb.status !== 'planted' || !ctx.bomb.plantPos) return false;
    const pos = bot.group.position;
    const d = Math.hypot(ctx.bomb.plantPos.x - pos.x, ctx.bomb.plantPos.z - pos.z);
    if (d > DEFUSE_REACH) return false;
    if (ctx.defuseStart(bot)) {
      bot.state = 'defuse';
      return true;
    }
    return false;
  }

  function stepBot(bot, dt, ctx) {
    if (!bot.alive) return;
    const brain = ensureBrain(bot);
    const pos = bot.group.position;

    // Channelling: stand still until the spike changes state.
    if (bot.state === 'plant') {
      if (!ctx.bomb || ctx.bomb.status !== 'carried' || !bot.isCarrier) {
        bot.state = 'hold';
      }
      return;
    }
    if (bot.state === 'defuse') {
      if (!ctx.bomb || ctx.bomb.status !== 'planted') {
        bot.state = 'hold';
      }
      return;
    }

    // The carrier plants the moment it stands inside a site.
    if (bot.isCarrier && ctx.bomb && ctx.bomb.status === 'carried') {
      if (tryPlant(bot, ctx)) return;
    }
    // A defender with a planted spike walks to the plant spot.
    if (bot.role === 'defend' && ctx.bomb && ctx.bomb.status === 'planted') {
      if (tryDefuse(bot, ctx)) return;
      if (bot.state === 'hold') {
        walkToPlant(bot, ctx);
      }
    }

    if (bot.state === 'advance' || bot.state === 'rotate') {
      const result = walkTo(bot, dt, ctx, brain);
      if (result === 'arrived') {
        if (bot.afterMid) {
          const next = bot.afterMid;
          bot.afterMid = null;
          setPath(bot, next);
        } else {
          bot.state = 'hold';
          if (bot.holdNode) {
            const hold = nodePos(world, bot.holdNode);
            if (hold) {
              bot.yaw = turnToward(bot.yaw, bot.holdYaw != null ? bot.holdYaw : bot.yaw, TURN_RATE * dt);
              bot.group.rotation.y = bot.yaw;
            }
          }
          if (bot.isCarrier && ctx.bomb && ctx.bomb.status === 'carried') {
            if (!tryPlant(bot, ctx)) walkToPlant(bot, ctx);
          }
        }
      }
      engage(bot, dt, ctx, brain);
      return;
    }

    // Hold: face the assigned angle (swaying slowly, turning toward fresh
    // gunfire), and shoot anything that shows itself.
    listenForNoise(bot, ctx, brain);
    brain.swayPhase += dt * 0.5;
    let faceYaw = bot.holdYaw != null ? bot.holdYaw : bot.yaw;
    if (ctx.time < brain.noiseUntil) {
      faceYaw = brain.noiseYaw;
    } else {
      faceYaw += Math.sin(brain.swayPhase) * HOLD_SWAY;
    }
    if (!brain.target) {
      bot.yaw = turnToward(bot.yaw, faceYaw, TURN_RATE * dt);
      bot.group.rotation.y = bot.yaw;
    }
    engage(bot, dt, ctx, brain);
    // A carrier that ends up holding inside a site plants from the hold.
    if (bot.isCarrier && ctx.bomb && ctx.bomb.status === 'carried') {
      if (!tryPlant(bot, ctx)) {
        const site = world.sites[bot.site];
        if (site) {
          scratch.set(pos.x, pos.y + 0.5, pos.z);
          if (!site.zone.containsPoint(scratch)) walkToPlant(bot, ctx);
        }
      }
    }
    // Hold timer: a timed hold repositions to a nearby angle instead of
    // camping one spot for the whole round.
    if (bot.holdTimer != null) {
      bot.holdTimer -= dt;
      if (bot.holdTimer <= 0) {
        bot.holdTimer = 60;
        const here = nearestNodeId(world, pos.x, pos.z);
        const options = (world.waypoints.adjacency[here] || []).filter((id) => id !== bot.holdNode);
        if (options.length) {
          const pick = options[Math.floor(Math.random() * options.length)];
          bot.holdNode = pick;
          bot.holdYaw = Math.random() * Math.PI * 2;
          setPath(bot, pick);
          bot.state = 'advance';
        }
      }
    }
  }

  return {
    setPath,
    stepBot,
  };
}
