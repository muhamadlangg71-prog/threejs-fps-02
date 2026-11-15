// Bot entities: nine fighters — four Vanguard bots beside the player,
// five Sentinel bots across the yard — plus the things the match needs
// from them: a damageable body with hit meshes, a per-round reset, a
// buy step that spends only money the bot actually has, and a waypoint
// pathfinder over the world's graph.
//
// A bot is a small blocky soldier: dark torso and legs, a round helmet
// in its team colour (rust orange for Vanguard, teal for Sentinel), a
// visor across the front and a rifle carried forward. The helmet and the
// torso are the hit meshes the shooting code raycasts against; the legs
// and the gun are decoration. Bots face local +Z: a bot with yaw θ looks
// along (sin θ, cos θ), which is why game.js spawns Vanguard facing π
// (north, up the map) and Sentinel facing 0 (south, down it).
//
// Economy: a bot starts a match with $800, the same opening funds as the
// player. buyFor buys the best primary it can afford — rifle, then SMG,
// the P9 sidearm is free — then armour, then a grenade, each only if the
// money is there after the last purchase, so a bot's money never goes
// below zero. Damage is soaked by armour first: armour absorbs half of
// each hit until it runs out.
import * as THREE from 'three';
import { createLoadout } from './weapons.js';

const TEAM_COLOR = {
  vanguard: '#c96a2e',
  sentinel: '#2e7f8a',
};
const BODY_COLOR = '#23262c';
const GUN_COLOR = '#1a1d21';
const ACCENT_COLOR = '#f0a830';
const START_MONEY = 800;
const MAX_HEALTH = 100;
const RIFLE_PRICE = 2700;
const SMG_PRICE = 1500;
const GRENADE_PRICE = 300;

const ROSTER = [
  { name: 'Mira', team: 'vanguard' },
  { name: 'Rook', team: 'vanguard' },
  { name: 'Havoc', team: 'vanguard' },
  { name: 'Dusty', team: 'vanguard' },
  { name: 'Bram', team: 'sentinel' },
  { name: 'Kite', team: 'sentinel' },
  { name: 'Nox', team: 'sentinel' },
  { name: 'Sable', team: 'sentinel' },
  { name: 'Warden', team: 'sentinel' },
];

function solidBox(w, h, d, mat, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

function buildSoldier(bot) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(BODY_COLOR), roughness: 0.85, metalness: 0.15 });
  const helmMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(TEAM_COLOR[bot.team]), roughness: 0.6, metalness: 0.3 });
  const gunMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(GUN_COLOR), roughness: 0.55, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(ACCENT_COLOR), roughness: 0.5, metalness: 0.4 });

  const leftLeg = solidBox(0.22, 0.55, 0.26, bodyMat, -0.16, 0.275, 0);
  const rightLeg = solidBox(0.22, 0.55, 0.26, bodyMat, 0.16, 0.275, 0);
  group.add(leftLeg, rightLeg);

  const torso = solidBox(0.62, 0.72, 0.36, bodyMat, 0, 0.95, 0);
  torso.userData.bot = bot;
  torso.userData.part = 'torso';
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), helmMat);
  head.position.set(0, 1.52, 0);
  head.castShadow = true;
  head.userData.bot = bot;
  head.userData.part = 'head';
  group.add(head);

  const visor = solidBox(0.3, 0.09, 0.06, gunMat, 0, 1.54, 0.21);
  group.add(visor);

  const gun = solidBox(0.07, 0.1, 0.66, gunMat, 0.2, 1.08, 0.28);
  group.add(gun);
  const muzzle = solidBox(0.07, 0.06, 0.08, accentMat, 0.2, 1.08, 0.6);
  group.add(muzzle);

  return { group, hitMeshes: [torso, head] };
}

export function createBots(scene, world) {
  const bots = [];
  const hitMeshes = [];

  for (const entry of ROSTER) {
    const bot = {
      name: entry.name,
      team: entry.team,
      alive: true,
      health: MAX_HEALTH,
      armor: 0,
      money: START_MONEY,
      kills: 0,
      deaths: 0,
      group: null,
      yaw: 0,
      state: 'hold',
      role: 'attack',
      site: 'A',
      isCarrier: false,
      holdNode: null,
      holdYaw: 0,
      holdTimer: null,
      ai: null,
      findPath: null,
      loadout: createLoadout(null, false),
      path: [],
      pathIndex: 0,
      afterMid: null,
    };
    const built = buildSoldier(bot);
    bot.group = built.group;
    scene.add(bot.group);
    hitMeshes.push(...built.hitMeshes);
    bots.push(bot);
  }

  // Armour soaks half of each hit until it is gone; whatever is left
  // comes off health. Returns true only when the hit kills the bot.
  function damage(bot, amount, part) {
    if (!bot.alive) return false;
    let dmg = amount;
    if (bot.armor > 0) {
      const absorbed = Math.min(bot.armor, dmg * 0.5);
      bot.armor -= absorbed;
      dmg -= absorbed;
    }
    bot.health -= dmg;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.deaths += 1;
      bot.state = 'dead';
      bot.group.visible = false;
      return true;
    }
    return false;
  }

  // Fresh round: back on its feet at the spawn point, facing the map,
  // sidearm in hand, no hold, no path, no spike. Money, kills and deaths
  // are match totals and are left alone.
  function resetBot(bot, spawn, facing) {
    bot.group.position.copy(spawn);
    bot.group.position.y = 0;
    bot.group.rotation.y = facing;
    bot.group.visible = true;
    bot.alive = true;
    bot.health = MAX_HEALTH;
    bot.armor = 0;
    bot.yaw = facing;
    bot.state = 'hold';
    bot.holdNode = null;
    bot.holdYaw = facing;
    bot.holdTimer = null;
    bot.path = [];
    bot.pathIndex = 0;
    bot.afterMid = null;
    bot.isCarrier = false;
    bot.loadout.resetToSidearm();
    if (bot._ai) {
      bot._ai.target = null;
      bot._ai.burstLeft = 0;
      bot._ai.stillT = 0;
      bot._ai.sideT = 0;
      bot._ai.repaths = 0;
      // Fresh node timer too: without this a bot that ended the last
      // round stuck on node 0 would carry a part-used 3s skip timer
      // into the new round and drop its first waypoint early.
      bot._ai.nodeIdx = -1;
      bot._ai.nodeStuckT = 0;
    }
  }

  // Spend the round's money: best affordable primary, then armour, then
  // a grenade — each step only if the money is still there, so the
  // balance can never go below zero. The P9 is free and is already in
  // hand after resetBot, so a broke bot simply keeps it.
  function buyFor(bot) {
    if (bot.money >= RIFLE_PRICE) {
      bot.loadout.buyPrimary('rifle');
      bot.money -= RIFLE_PRICE;
    } else if (bot.money >= SMG_PRICE) {
      bot.loadout.buyPrimary('smg');
      bot.money -= SMG_PRICE;
    }
    if (bot.money >= 650) {
      bot.armor = 100;
      bot.money -= 650;
    }
    if (bot.money >= GRENADE_PRICE) {
      if (bot.loadout.addGrenade()) bot.money -= GRENADE_PRICE;
    }
    bot.money = Math.max(0, bot.money);
  }

  // Shortest route over the waypoint graph, as a list of node ids to walk
  // through (the start node itself is not included). The optional random
  // source only shuffles the order neighbours are tried, so equal-length
  // routes vary without ever getting longer.
  function findPath(start, goal, rnd) {
    if (start === goal) return [];
    const adjacency = world.waypoints.adjacency;
    const prev = { [start]: null };
    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      const neighbours = (adjacency[current] || []).slice();
      if (typeof rnd === 'function') {
        for (let i = neighbours.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rnd() * (i + 1));
          [neighbours[i], neighbours[j]] = [neighbours[j], neighbours[i]];
        }
      }
      for (const next of neighbours) {
        if (prev[next] !== undefined) continue;
        prev[next] = current;
        if (next === goal) {
          const path = [goal];
          let step = current;
          while (step !== start && step != null) {
            path.unshift(step);
            step = prev[step];
          }
          return path;
        }
        queue.push(next);
      }
    }
    return [goal];
  }

  function nearestNode(x, z) {
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

  return {
    bots,
    hitMeshes,
    damage,
    resetBot,
    buyFor,
    findPath,
    nearestNode,
  };
}
