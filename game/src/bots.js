// Squad roster: nine AI combatants (4 vanguard attackers, 5 sentinel
// defenders) built as low-poly figures from boxes and spheres. A bot is a
// plain state record plus a THREE.Group; the brains live in botai.js, the
// round bookkeeping in game.js — this module only owns the bodies, the
// waypoint routing, the buy-phase shopping and the damage arithmetic.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createLoadout, WEAPONS } from './weapons.js';

// Deterministic per-bot dice: same seed always deals the same sequence, so
// replays and harness runs stay reproducible.
function seededRand(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let h = Math.imul(s ^ (s >>> 15), s | 1);
    h = (h + Math.imul(h ^ (h >>> 7), h | 61)) ^ h;
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

// Shortest hop-count route through the waypoint graph. Neighbours are
// visited in adjacency order and a node is claimed the moment it is queued,
// so the route is fully determined by the graph.
export function findPath(waypoints, start, goal, random) {
  if (start === goal) return [goal];
  const cameFrom = new Map([[start, null]]);
  const frontier = [start];
  for (let head = 0; head < frontier.length; head += 1) {
    const node = frontier[head];
    for (const next of waypoints.adjacency[node] || []) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, node);
      if (next === goal) {
        const route = [];
        for (let cur = goal; cur !== null; cur = cameFrom.get(cur)) route.push(cur);
        return route.reverse();
      }
      frontier.push(next);
    }
  }
  return [goal];
}

// Closest waypoint to a ground point, by squared distance. On an exact tie
// the first node in insertion order wins.
function closestWaypoint(waypoints, x, z) {
  let winner = null;
  let winnerDist = Infinity;
  for (const [id, [nx, nz]] of Object.entries(waypoints.nodes)) {
    const dist = (nx - x) * (nx - x) + (nz - z) * (nz - z);
    if (dist < winnerDist) {
      winnerDist = dist;
      winner = id;
    }
  }
  return winner;
}

// One entry per body part. `mirror` spawns the same part at +x and -x;
// `key` keeps a handle for the parts the game raycasts against (torso/head).
const BODY_PLAN = [
  { key: 'legL', mirror: 'legR', geo: () => new THREE.BoxGeometry(0.16, 0.78, 0.16), mat: 'dark', at: [-0.11, 0.39, 0] },
  { key: 'torso', geo: () => new THREE.BoxGeometry(0.52, 0.62, 0.3), mat: 'team', at: [0, 1.09, 0] },
  { key: 'vest', geo: () => new THREE.BoxGeometry(0.56, 0.4, 0.34), mat: 'dark', at: [0, 1.12, 0] },
  { key: 'head', geo: () => new THREE.SphereGeometry(0.16, 12, 10), mat: 'skin', at: [0, 1.56, 0] },
  { key: 'helmet', geo: () => new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mat: 'team', at: [0, 1.58, 0] },
  { key: 'armL', mirror: 'armR', geo: () => new THREE.BoxGeometry(0.12, 0.5, 0.12), mat: 'team', at: [-0.32, 1.15, 0.12], tiltX: -1.1 },
  { key: 'gun', geo: () => new THREE.BoxGeometry(0.07, 0.09, 0.62), mat: 'gunmetal', at: [0.1, 1.32, -0.28] },
];

const ROSTER = {
  vanguard: ['Rook', 'Havoc', 'Dusty', 'Mira'],
  sentinel: ['Warden', 'Sable', 'Kite', 'Bram', 'Nox'],
};

const ARMOR_PRICE = 650;
const GRENADE_PRICE = 300;
const GRENADE_CHANCE = 0.6;

// Primary tiers, richest first: rifle, then smg, then the free pistol.
const PRIMARY_TIERS = [['rifle', 2700], ['smg', 1500]];

// Hit-zone damage multipliers; anything else scores a plain body hit.
const ZONE_MULT = { head: 3, leg: 0.75 };

export function createBots(scene, world) {
  const kit = {
    team: {
      vanguard: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.vanguard), roughness: 0.7, metalness: 0.1 }),
      sentinel: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.sentinel), roughness: 0.7, metalness: 0.1 }),
    },
    dark: new THREE.MeshStandardMaterial({ color: new THREE.Color('#1c1f24'), roughness: 0.85 }),
    skin: new THREE.MeshStandardMaterial({ color: new THREE.Color('#c9a582'), roughness: 0.8 }),
    gunmetal: new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.5, metalness: 0.5 }),
  };
  const stripeColor = { vanguard: '#f0a830', sentinel: '#7fd4de' };

  const squad = [];
  const hittable = [];

  function assembleBot(index, team, name) {
    const figure = new THREE.Group();
    const parts = {};
    for (const spec of BODY_PLAN) {
      const slots = spec.mirror ? [spec, { ...spec, key: spec.mirror, at: [-spec.at[0], spec.at[1], spec.at[2]] }] : [spec];
      for (const slot of slots) {
        const mat = slot.mat === 'team' ? kit.team[team] : kit[slot.mat];
        const mesh = new THREE.Mesh(slot.geo(), mat);
        mesh.position.set(slot.at[0], slot.at[1], slot.at[2]);
        if (slot.tiltX) mesh.rotation.x = slot.tiltX;
        figure.add(mesh);
        parts[slot.key] = mesh;
      }
    }
    figure.traverse((m) => { if (m.isMesh) m.castShadow = true; });
    // Coloured chest stripe so the side reads at a glance. Added after the
    // shadow pass on purpose, so it stays unlit-flat.
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.1, 0.32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(stripeColor[team]) }),
    );
    stripe.position.y = 1.32;
    figure.add(stripe);
    figure.visible = false;
    scene.add(figure);

    const bot = {
      index, team, name,
      group: figure, head: parts.head, torso: parts.torso, gun: parts.gun,
      health: 100, armor: 0, alive: false,
      loadout: createLoadout(null, false),
      money: 800,
      role: team === 'vanguard' ? 'attack' : 'defend',
      site: 'A',
      state: 'idle',
      path: [], pathIndex: 0,
      holdNode: null, holdYaw: 0, holdTimer: 0,
      target: null, targetVisible: false, losTimer: Math.random() * 0.1,
      reactTimer: 0, burstLeft: 0, burstPause: 0,
      aimError: 0.02, moveTarget: null,
      plantTimer: 0, defuseTimer: 0, channeling: null,
      investigate: null, investigateTimer: 0,
      fall: 0, fadeTimer: 0,
      yaw: 0, walkPhase: 0, moving: false,
      kills: 0, deaths: 0,
      random: seededRand(1000 + index * 77),
    };
    parts.torso.userData.bot = bot;
    parts.torso.userData.part = 'torso';
    parts.head.userData.bot = bot;
    parts.head.userData.part = 'head';
    hittable.push(parts.torso, parts.head);
    squad.push(bot);
    return bot;
  }

  for (let i = 0; i < ROSTER.vanguard.length; i += 1) assembleBot(i, 'vanguard', ROSTER.vanguard[i]);
  for (let i = 0; i < ROSTER.sentinel.length; i += 1) assembleBot(ROSTER.vanguard.length + i, 'sentinel', ROSTER.sentinel[i]);

  function resetBot(bot, spawn, yaw) {
    bot.group.position.copy(spawn);
    bot.group.rotation.set(0, 0, 0);
    bot.yaw = yaw;
    bot.group.visible = true;
    bot.health = 100;
    bot.armor = 0;
    bot.alive = true;
    bot.state = 'advance';
    bot.path = [];
    bot.pathIndex = 0;
    bot.target = null;
    bot.targetVisible = false;
    bot.burstLeft = 0;
    bot.burstPause = 0;
    bot.plantTimer = 0;
    bot.defuseTimer = 0;
    bot.channeling = null;
    bot.investigate = null;
    bot.fall = 0;
    bot.fadeTimer = 0;
    bot.group.traverse((m) => {
      if (m.isMesh && m.material.transparent) m.material.opacity = 1;
    });
  }

  function buyFor(bot) {
    // Shop like a player: best primary the purse allows, then armour, then
    // maybe a grenade. Every item is charged only when the bot can actually
    // pay for it — the pistol is the free sidearm, so a broke bot keeps it
    // and spends nothing. Money can never go below zero from shopping.
    const purse = bot.money;
    let primary = 'pistol';
    for (const [id, floor] of PRIMARY_TIERS) {
      if (purse >= floor) { primary = id; break; }
    }
    bot.loadout.buyPrimary(primary);
    const tag = WEAPONS[primary].price;
    if (bot.money >= tag) bot.money -= tag;
    if (bot.money >= ARMOR_PRICE) {
      bot.armor = 100;
      bot.money -= ARMOR_PRICE;
    }
    if (bot.money >= GRENADE_PRICE && bot.random() < GRENADE_CHANCE) {
      bot.loadout.addGrenade();
      bot.money -= GRENADE_PRICE;
    }
    bot.money = Math.max(0, bot.money);
  }

  function damage(bot, amount, part) {
    if (!bot.alive) return false;
    let dmg = amount * (ZONE_MULT[part] ?? 1);
    if (bot.armor > 0) {
      const soaked = Math.min(bot.armor, dmg * 0.5);
      bot.armor -= soaked;
      dmg -= soaked;
    }
    bot.health -= dmg;
    if (bot.health > 0) return false;
    bot.health = 0;
    bot.alive = false;
    bot.state = 'dead';
    bot.deaths += 1;
    bot.fall = 0;
    return true;
  }

  return {
    bots: squad,
    hitMeshes: hittable,
    resetBot,
    buyFor,
    damage,
    nearestNode(x, z) {
      return closestWaypoint(world.waypoints, x, z);
    },
    findPath(start, goal, random) {
      return findPath(world.waypoints, start, goal, random);
    },
    setVisible(bot, visible) {
      bot.group.visible = visible;
    },
  };
}
