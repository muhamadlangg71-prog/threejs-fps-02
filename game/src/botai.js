// Bot brains: one step function per bot per fixed tick. A bot reads the world through
// line of sight (a real raycast, staggered at 10 Hz) and hearing (noise events from
// gunfire), then walks the waypoint graph, holds angles, fires in bursts, plants and
// defuses. Roles come from the match: attackers take a site, defenders hold one.
import * as THREE from 'three';

const TURN_RATE = 4.2;
const EYE = 1.55;

function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, t);
}

function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export function createBotAI(world) {
  const tmp = new THREE.Vector3();

  function setPath(bot, goalNode) {
    const pos = bot.group.position;
    let start = null;
    let bestD = Infinity;
    for (const [id, [nx, nz]] of Object.entries(world.waypoints.nodes)) {
      const d = (nx - pos.x) * (nx - pos.x) + (nz - pos.z) * (nz - pos.z);
      if (d < bestD) {
        bestD = d;
        start = id;
      }
    }
    bot.path = bot.findPath(start, goalNode, bot.random);
    bot.pathIndex = 0;
  }

  function nodePos(id) {
    const n = world.waypoints.nodes[id];
    return { x: n[0], z: n[1] };
  }

  function stepBot(bot, dt, ctx) {
    if (!bot.alive) {
      // Fall over, then sink out of sight.
      if (bot.fall < 1) {
        bot.fall = Math.min(1, bot.fall + dt / 0.4);
        bot.group.rotation.x = -bot.fall * 1.45;
        bot.group.position.y = -bot.fall * 0.1;
      } else {
        bot.fadeTimer += dt;
        if (bot.fadeTimer > 3) bot.group.visible = false;
      }
      return;
    }

    const pos = bot.group.position;
    const now = ctx.time;
    // Combat only runs in the live phase: during buy / roundEnd bots walk
    // their lanes but never acquire a target or fire. (Bots used to spot and
    // kill each other during the 15 s buy phase, before the round started.)
    const live = ctx.phase === 'live';
    const enemies = live ? ctx.enemiesOf(bot) : [];

    // --- Hearing: a fresh noise nearby becomes an investigation.
    if (bot.state !== 'engage' && bot.state !== 'plant' && bot.state !== 'defuse') {
      for (const n of ctx.noise) {
        if (n.time < now - 0.5 || n.time > now) continue;
        const d2 = (n.pos.x - pos.x) ** 2 + (n.pos.z - pos.z) ** 2;
        if (d2 < n.radius * n.radius && bot.random() < 0.7) {
          bot.investigate = { x: n.pos.x, z: n.pos.z };
          bot.investigateTimer = 3;
          if (bot.state === 'hold') bot.state = 'investigate';
        }
      }
    }

    // --- Line of sight, staggered so nine bots do not raycast every frame.
    bot.losTimer -= dt;
    if (bot.losTimer <= 0) {
      bot.losTimer = 1 / 10 + bot.index * 0.011;
      bot.targetVisible = false;
      bot.target = null;
      let bestD = Infinity;
      for (const e of enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
        if (d > 55) continue;
        if (!ctx.los(pos.x, pos.y + EYE, pos.z, e.pos.x, e.pos.y + 1.2, e.pos.z, e)) continue;
        if (d < bestD) {
          bestD = d;
          bot.target = e;
          bot.targetVisible = true;
        }
      }
      if (bot.targetVisible && bot.state !== 'engage') {
        bot.reactTimer = 0.25 + bot.random() * 0.35 + bestD * 0.004;
        bot.prevState = bot.state;
        bot.state = 'engage';
        bot.burstLeft = 0;
        bot.burstPause = 0;
      }
    }

    // --- Plant / defuse channels are owned by the match (game.js): the bot stands
    // still while the channel runs; main.js advances it each tick.
    if (bot.state === 'plant' || bot.state === 'defuse') {
      bot.moving = false;
      return;
    }

    // --- Engage: aim, wait out the reaction, fire in bursts.
    if (bot.state === 'engage') {
      if (!live) {
        // Round ended (or never started) mid-fight: stand down, no shots.
        bot.state = bot.prevState || 'hold';
        bot.target = null;
        bot.targetVisible = false;
        bot.burstLeft = 0;
        return;
      }
      const t = bot.target;
      if (!t || !t.alive || !bot.targetVisible) {
        bot.loseTimer = (bot.loseTimer || 0) + dt;
        if (bot.loseTimer > 1.2) {
          bot.loseTimer = 0;
          bot.state = bot.investigate ? 'investigate' : (bot.prevState || 'hold');
        }
        return;
      }
      bot.loseTimer = 0;
      const wantYaw = yawTo(pos, t.pos);
      bot.yaw = angleLerp(bot.yaw, wantYaw, TURN_RATE * dt);
      bot.group.rotation.y = bot.yaw;
      bot.moving = false;
      bot.reactTimer -= dt;
      if (bot.reactTimer > 0) return;
      bot.loadout.step(dt);
      if (bot.burstLeft <= 0) {
        bot.burstPause -= dt;
        if (bot.burstPause <= 0) {
          bot.burstLeft = 3 + Math.floor(bot.random() * 3);
          bot.burstPause = 0.5 + bot.random() * 0.4;
        }
        return;
      }
      if (!bot.loadout.ready()) {
        if (bot.loadout.state.reloadLeft === 0) bot.loadout.reload();
        return;
      }
      const def = bot.loadout.def();
      const dist = Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z);
      const targetMoving = Math.hypot(t.vel?.x || 0, t.vel?.z || 0) > 1.5;
      const err = 0.012 + dist * 0.0006 + (targetMoving ? 0.012 : 0);
      bot.loadout.takeRound();
      bot.loadout.pullTrigger();
      ctx.botShoot(bot, t, err, def);
      bot.burstLeft -= 1;
      return;
    }

    // --- Investigate: walk to the noise, look around, go back to holding.
    if (bot.state === 'investigate' && bot.investigate) {
      bot.investigateTimer -= dt;
      const arrived = walkTo(bot, bot.investigate.x, bot.investigate.z, dt, ctx);
      if (arrived || bot.investigateTimer <= 0) {
        bot.holdTimer = 1.5;
        bot.state = 'hold';
        bot.investigate = null;
      }
      return;
    }

    // --- Hold: stand at the hold node, sweep the angle slowly.
    if (bot.state === 'hold') {
      bot.holdTimer -= dt;
      const sweep = Math.sin(now * 0.5 + bot.index * 1.3) * 0.55;
      bot.yaw = angleLerp(bot.yaw, bot.holdYaw + sweep, 2.2 * dt);
      bot.group.rotation.y = bot.yaw;
      bot.moving = false;
      if (bot.holdTimer <= 0 && bot.role === 'attack' && bot.isCarrier && ctx.bomb.state === 'carried') {
        // Carrier reaches the site and nobody is watching: plant.
        const site = ctx.bomb.site;
        const p = world.sites[site].plant;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < 1.6) {
          bot.state = 'plant';
          bot.plantTimer = 0;
          ctx.plantStart(bot);
          return;
        }
        setPath(bot, site === 'A' ? 'aPlant' : 'bPlant');
        bot.state = 'advance';
      }
      return;
    }

    // --- Advance: walk the waypoint path; at the end, hold, plant or defuse.
    if (bot.state === 'advance' || bot.state === 'rotate') {
      if (bot.pathIndex >= bot.path.length) {
        if (bot.afterMid) {
          const next = bot.afterMid;
          bot.afterMid = null;
          setPath(bot, next);
          return;
        }
        // A defender who reaches the planted spike starts defusing.
        if (bot.role === 'defend' && ctx.bomb.state === 'planted' && ctx.bomb.plantPos) {
          const p = ctx.bomb.plantPos;
          if (Math.hypot(p.x - pos.x, p.z - pos.z) < 2.4) {
            bot.state = 'defuse';
            bot.defuseTimer = 0;
            ctx.defuseStart(bot);
            return;
          }
          setPath(bot, ctx.bomb.site === 'A' ? 'aSite' : 'bSite');
          return;
        }
        if (bot.role === 'attack' && bot.isCarrier && ctx.bomb.state === 'carried') {
          const site = ctx.bomb.site;
          const p = world.sites[site].plant;
          if (Math.hypot(p.x - pos.x, p.z - pos.z) < 2.2) {
            bot.state = 'plant';
            bot.plantTimer = 0;
            ctx.plantStart(bot);
            return;
          }
        }
        bot.state = 'hold';
        bot.holdTimer = 4 + bot.random() * 4;
        bot.holdYaw = bot.yaw;
        return;
      }
      const node = nodePos(bot.path[bot.pathIndex]);
      const arrived = walkTo(bot, node.x, node.z, dt, ctx);
      if (arrived) bot.pathIndex += 1;
      return;
    }
  }

  function walkTo(bot, x, z, dt, ctx) {
    const pos = bot.group.position;
    const dx = x - pos.x;
    const dz = z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) return true;
    // --- Unstuck: the waypoint line down mid runs dead through the mid lamp
    // post (0, 6) and the mid pillar (0, -4), so a bot facing one dead-on
    // stops 0.5 m short and never arrives. If we barely moved in the last
    // second while trying to walk, sidestep perpendicular for a moment, then
    // resume — the diagonal approach slides around the post. Sides alternate
    // so a bot never strafes into the same wall twice.
    if (bot.stuckX === undefined) { bot.stuckX = pos.x; bot.stuckZ = pos.z; bot.stuckTimer = 0; }
    const moved = Math.hypot(pos.x - bot.stuckX, pos.z - bot.stuckZ);
    if (moved > 0.15) {
      bot.stuckX = pos.x;
      bot.stuckZ = pos.z;
      bot.stuckTimer = 0;
    } else {
      bot.stuckTimer += dt;
      if (bot.stuckTimer > 1.0 && !(bot.sidestep > 0)) {
        bot.stuckTimer = 0;
        bot.stuckDir = (bot.stuckDir || 1) * -1;
        // Fixed sidestep point, 1.4 m perpendicular to the current facing.
        // (Must be fixed at trigger time: recomputing it from the turning
        // yaw each tick makes the target orbit the bot and it spins in place.)
        bot.sideX = pos.x + Math.cos(bot.yaw) * bot.stuckDir * 1.4;
        bot.sideZ = pos.z - Math.sin(bot.yaw) * bot.stuckDir * 1.4;
        bot.sidestep = 0.9;
      }
    }
    let tx = x;
    let tz = z;
    if (bot.sidestep > 0) {
      bot.sidestep -= dt;
      tx = bot.sideX;
      tz = bot.sideZ;
      // Arrived at the sidestep point early: stop sidestepping.
      if (Math.hypot(tx - pos.x, tz - pos.z) < 0.3) bot.sidestep = 0;
    }
    const wdx = tx - pos.x;
    const wdz = tz - pos.z;
    const wantYaw = Math.atan2(-wdx, -wdz);
    bot.yaw = angleLerp(bot.yaw, wantYaw, TURN_RATE * dt);
    bot.group.rotation.y = bot.yaw;
    const speed = bot.state === 'engage' ? BOT_AIM_SPEED : 3.6;
    // Step forward along the facing yaw; waypoints sit in open lanes, so no steering needed.
    const nx = pos.x + -Math.sin(bot.yaw) * speed * dt;
    const nz = pos.z + -Math.cos(bot.yaw) * speed * dt;
    if (!ctx.blocked(nx, pos.z)) pos.x = nx;
    if (!ctx.blocked(pos.x, nz)) pos.z = nz;
    bot.moving = true;
    bot.walkPhase += dt * 9;
    const swing = Math.sin(bot.walkPhase) * 0.08;
    bot.group.children[0].rotation.x = swing;
    bot.group.children[1].rotation.x = -swing;
    return false;
  }

  return { stepBot, setPath, nodePos };
}
