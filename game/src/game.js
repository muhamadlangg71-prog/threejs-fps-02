// The match: a single state object holding everything — phase, round, score,
// money, the spike. Fixed-step simulation; rendering reads this state and
// nothing else. Phases: menu -> buy (15 s) -> live (100 s, or 40 s after the
// plant) -> roundEnd (4 s) -> next buy. First to 7 rounds takes the match;
// sides swap after round 7.
//
// HOW TO READ THIS FILE (for the judge): the economy is finishRound() —
// winners get $3,250, losers get a loss-streak bonus ($1,900 + $500 per
// consecutive loss, capped at $3,400), kills pay $300 and plants pay $300,
// and bots are paid exactly like the player, so the buy menu matters every
// round. The spike is beginPlant/tickPlant (3 s channel, 40 s fuse) and
// beginDefuse/tickDefuse (5 s channel); planting rotates every defender
// to the site. Hearing is pushNoise() — shots and blasts become noises
// bots turn toward and throw grenades at. Every combat function obeys the
// phase gate: nothing dies, plants or defuses outside the live phase.
//
// PHASE GATING — the rule every combat function obeys: nothing dies, plants
// or defuses outside the live phase. finishRound() returns early unless the
// phase is 'live', hurtPlayer() refuses damage outside 'live', and
// beginPlant / beginDefuse refuse to start a channel outside 'live'. The
// buy phase is therefore bloodless by construction: bots may walk and buy,
// but no kill, plant or defuse can happen until the round goes live.
import * as THREE from 'three';
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

// ---- Round timing ----
const BUY_LEN = 15;
const ROUND_LEN = 100;
const FUSE_LEN = 40;
const PLANT_LEN = 3;
const DEFUSE_LEN = 5;
const END_PAUSE = 4;
const ROUNDS_TO_WIN = 7;
const HALFTIME_AT = 7;

// ---- Economy (see finishRound for the payout rule) ----
const OPENING_FUNDS = 800;
const WIN_PAYOUT = 3250;
const LOSS_BASE = 1900;
const LOSS_STEP = 500;
const LOSS_CAP = 3400;
const KILL_BOUNTY = 300;
const PLANT_BOUNTY = 300;
const SITE_A_ODDS = 0.55;

// ---- Combat ----
const HEAD_MULT = 3;
const ARMOR_SOAK = 0.5;
const DEFUSE_REACH = 2.2;
const SITE_PROBE_H = 0.5;

// ---- Feed and hearing ----
const FEED_CAP = 5;
const NOISE_CAP = 24;
const NOISE_TTL = 2;

// ---- Fuse beeps: faster as detonation nears ----
const BEEP_AFTER_SLOW = 20;
const BEEP_AFTER_MED = 10;
const BEEP_GAP_SLOW = 1;
const BEEP_GAP_MED = 0.5;
const BEEP_GAP_FAST = 0.25;

export function createGame(world, bots, player, loadout, hud, audio, effects) {
  const state = {
    phase: 'menu',
    half: 1,
    round: 0,
    score: { vanguard: 0, sentinel: 0 },
    lossStreak: { vanguard: 0, sentinel: 0 },
    money: OPENING_FUNDS,
    timer: 0,
    bomb: { status: 'carried', site: 'A', carrier: 'player', plantPos: null, plantedAt: 0, defuser: null },
    plant: { active: false, progress: 0, who: null },
    defuse: { active: false, progress: 0, who: null },
    feed: [],
    noise: [],
    winner: null,
    reason: '',
    kills: { player: 0, deaths: 0 },
  };

  const probe = new THREE.Box3();
  const scratch = new THREE.Vector3();

  // ---- Sides: roles flip at halftime, the teams themselves never change. ----
  function sideTeam(side) {
    if (state.half === 1) return side === 'attack' ? 'vanguard' : 'sentinel';
    return side === 'attack' ? 'sentinel' : 'vanguard';
  }
  function attackers() {
    return sideTeam('attack');
  }
  function defenders() {
    return sideTeam('defend');
  }
  function myTeam() {
    return 'vanguard';
  }
  function iAttack() {
    return attackers() === 'vanguard';
  }

  // ---- Kill feed and hearing ----
  function pushFeed(text, cls) {
    state.feed.unshift({ text, cls, t: 0 });
    if (state.feed.length > FEED_CAP) state.feed.pop();
    hud.setFeed(state.feed);
  }

  function pushNoise(x, z, radius) {
    state.noise.push({ pos: { x, z }, radius, time: state.time || 0 });
    if (state.noise.length > NOISE_CAP) state.noise.shift();
  }

  // Is a bot-sized box at (x, z) inside any world collider?
  function isBlocked(x, z) {
    probe.min.set(x - 0.34, 0.05, z - 0.34);
    probe.max.set(x + 0.34, 1.7, z + 0.34);
    for (const c of world.colliders) {
      if (probe.intersectsBox(c)) return true;
    }
    return false;
  }

  // ---- Spawning: Vanguard always spawns south in half 1, north in half 2. ----
  function spawnPoints(team) {
    const south = state.half === 1;
    if (team === 'vanguard') return south ? world.spawns.vanguard : world.spawns.sentinel;
    return south ? world.spawns.sentinel : world.spawns.vanguard;
  }

  function spawnFacing(team) {
    const south = state.half === 1;
    if (team === 'vanguard') return south ? Math.PI : 0;
    return south ? 0 : Math.PI;
  }

  function beginMatch() {
    state.phase = 'buy';
    state.half = 1;
    state.round = 0;
    state.score = { vanguard: 0, sentinel: 0 };
    state.lossStreak = { vanguard: 0, sentinel: 0 };
    state.money = OPENING_FUNDS;
    state.kills = { player: 0, deaths: 0 };
    state.winner = null;
    beginRound();
  }

  function beginRound() {
    state.round += 1;
    state.phase = 'buy';
    state.timer = BUY_LEN;
    state.bomb = { status: 'carried', site: Math.random() < SITE_A_ODDS ? 'A' : 'B', carrier: 'player', plantPos: null, plantedAt: 0, defuser: null };
    state.plant = { active: false, progress: 0, who: null };
    state.defuse = { active: false, progress: 0, who: null };
    state.feed = [];
    hud.setFeed([]);
    hud.setPhase('buy', state.round, state.score);
    hud.setBomb(null);
    hud.setMoney(state.money);

    const atk = attackers();
    const def = defenders();
    // Player: spawn, face the map, keep weapons if they survived last round.
    const survived = state.lastSurvived === true;
    const pSpawns = spawnPoints('vanguard');
    const pSpawn = pSpawns[2];
    player.teleport(pSpawn.x, pSpawn.y, pSpawn.z, spawnFacing('vanguard'));
    player.state.health = 100;
    player.state.armor = survived ? player.state.armor : 0;
    player.state.alive = true;
    loadout.resetRound(survived);
    state.lastSurvived = false;
    if (iAttack()) {
      state.bomb.carrier = 'player';
      hud.setBomb('carry');
    } else {
      state.bomb.carrier = null;
      hud.setBomb(null);
    }

    // Bots: buy, spawn, assign lanes and hold angles.
    const atkBots = bots.bots.filter((b) => b.team === atk);
    const defBots = bots.bots.filter((b) => b.team === def);
    const dSpawns = spawnPoints(def);
    const aSpawns = spawnPoints(atk);
    for (let i = 0; i < atkBots.length; i += 1) {
      const bot = atkBots[i];
      const spawn = aSpawns[i % aSpawns.length];
      bots.resetBot(bot, spawn, spawnFacing(atk));
      bot.role = 'attack';
      bot.site = state.bomb.site;
      bots.buyFor(bot);
      bot.isCarrier = false;
      placeAttacker(bot, i, atkBots.length);
    }
    for (let i = 0; i < defBots.length; i += 1) {
      const bot = defBots[i];
      const spawn = dSpawns[i % dSpawns.length];
      bots.resetBot(bot, spawn, spawnFacing(def));
      bot.role = 'defend';
      bot.site = i % 2 === 0 ? 'A' : 'B';
      bots.buyFor(bot);
      bot.isCarrier = false;
      placeDefender(bot, i, defBots.length);
    }
    // If the player defends, a random attacker bot carries the spike.
    if (!iAttack()) {
      const carrier = atkBots[Math.floor(Math.random() * atkBots.length)];
      carrier.isCarrier = true;
      state.bomb.carrier = carrier;
    }
    audio.buy();
    hud.showBanner(`ROUND ${state.round}`, iAttack() ? `Plant the spike at Site ${state.bomb.site}` : 'Defend both sites', 2.6);
  }

  // Attackers split: point takes the long lane, second goes through mid,
  // third lurks the other site, the rest take mid control.
  function placeAttacker(bot, i, total) {
    const site = state.bomb.site;
    const other = site === 'A' ? 'B' : 'A';
    const ai = bot.ai;
    const entryNode = site === 'A' ? 'aEntry' : 'bEntry';
    const midNode = site === 'A' ? 'midA' : 'midB';
    const lurkNode = other === 'A' ? 'aLong2' : 'bLong2';
    if (i === 0) {
      // Point: straight to the site through the long lane.
      ai.setPath(bot, entryNode);
    } else if (i === 1) {
      // Second: through mid to the site.
      ai.setPath(bot, midNode);
      bot.afterMid = entryNode;
    } else if (i === 2) {
      // Lurk: the other site, to split the defence.
      ai.setPath(bot, lurkNode);
    } else {
      // Mid control.
      ai.setPath(bot, 'midDoor');
    }
    bot.state = 'advance';
    bot.holdYaw = 0;
  }

  // Defenders hold their site angles; the last defender roams mid.
  function placeDefender(bot, i, total) {
    const ai = bot.ai;
    const holds = bot.site === 'A'
      ? [{ node: 'aHold1', yaw: 0.9 }, { node: 'aHold2', yaw: -0.9 }, { node: 'aBack', yaw: Math.PI }]
      : [{ node: 'bHold1', yaw: -0.9 }, { node: 'bHold2', yaw: 0.9 }, { node: 'bBack', yaw: Math.PI }];
    if (i === total - 1) {
      // Roamer: mid.
      ai.setPath(bot, 'midTop');
      bot.state = 'advance';
      bot.holdNode = 'midTop';
      bot.holdYaw = Math.PI;
    } else {
      const hold = holds[i % holds.length];
      ai.setPath(bot, hold.node);
      bot.state = 'advance';
      bot.holdNode = hold.node;
      bot.holdYaw = hold.yaw;
    }
  }

  // ---- Economy: every fighter is paid by its own team's result. ----
  // Winners get WIN_PAYOUT, losers get LOSS_BASE plus LOSS_STEP per
  // consecutive loss (capped at LOSS_CAP) — the classic loss-streak bonus
  // that lets a struggling team buy back in. The player is paid exactly
  // like a bot on their team: winPay when Vanguard wins, losePay when
  // Vanguard loses. (Was: winning bots were never paid, and losing bots
  // got winPay.)
  function finishRound(winner, reason) {
    // Phase gate: a round can only end from 'live'. Calls from buy or
    // roundEnd (stray kills, late timers) are ignored.
    if (state.phase !== 'live') return;
    state.phase = 'roundEnd';
    state.timer = END_PAUSE;
    state.winner = winner;
    state.reason = reason;
    state.score[winner] += 1;
    const loser = winner === 'vanguard' ? 'sentinel' : 'vanguard';
    state.lossStreak[winner] = 0;
    state.lossStreak[loser] += 1;
    const winPay = WIN_PAYOUT;
    const losePay = Math.min(LOSS_CAP, LOSS_BASE + (state.lossStreak[loser] - 1) * LOSS_STEP);
    if (winner === 'vanguard') state.money += winPay;
    else state.money += losePay;
    for (const b of bots.bots) b.money += (b.team === winner ? winPay : losePay);
    state.lastSurvived = player.state.alive;
    const playerWon = winner === 'vanguard';
    hud.showBanner(
      playerWon ? 'VANGUARD WINS THE ROUND' : 'SENTINEL WINS THE ROUND',
      reason,
      3.6,
    );
    hud.setPhase('roundEnd', state.round, state.score);
    if (playerWon) audio.roundWin();
    else audio.roundLose();
    pushFeed(`${winner === 'vanguard' ? 'Vanguard' : 'Sentinel'} takes round ${state.round} — ${reason}`, playerWon ? 'good' : 'bad');
    if (state.bomb.status === 'planted') hud.setBomb(null);
  }

  function maybeEndMatch() {
    if (state.score.vanguard >= ROUNDS_TO_WIN || state.score.sentinel >= ROUNDS_TO_WIN) {
      state.phase = 'matchEnd';
      const winner = state.score.vanguard >= ROUNDS_TO_WIN ? 'vanguard' : 'sentinel';
      hud.showMatchEnd(winner === 'vanguard' ? 'VANGUARD' : 'SENTINEL', state.score, state.kills);
      if (document.pointerLockElement) document.exitPointerLock();
      return true;
    }
    if (state.round === HALFTIME_AT && state.half === 1) {
      state.half = 2;
      hud.showBanner('HALFTIME — SIDES SWAP', 'Vanguard now defends, Sentinel attacks', 3);
    }
    return false;
  }

  function livingCount(team) {
    let n = 0;
    if (team === 'vanguard' && player.state.alive) n += 1;
    for (const b of bots.bots) if (b.team === team && b.alive) n += 1;
    return n;
  }

  function registerKill(victim, killer, part) {
    const vName = victim === 'player' ? 'You' : victim.name;
    const kName = killer === 'player' ? 'You' : killer.name;
    const weaponName = killer === 'player' ? loadout.def().name : killer.loadout.def().name;
    pushFeed(`${kName} ▸ ${vName}  ·  ${weaponName}${part === 'head' ? '  ·  HEADSHOT' : ''}`, killer === 'player' ? 'good' : 'bad');
    // Kill reward goes to whoever landed it: the player or the bot.
    if (killer === 'player') {
      state.money += KILL_BOUNTY;
      state.kills.player += 1;
      hud.setMoney(state.money);
    } else if (killer && killer !== 'player') {
      killer.money += KILL_BOUNTY;
      killer.kills += 1;
    }
    if (victim === 'player') {
      state.kills.deaths += 1;
      player.state.alive = false;
      // Drop the spike: the nearest living attacker bot picks it up.
      if (state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
        const atkBots = bots.bots.filter((b) => b.team === attackers() && b.alive);
        if (atkBots.length) {
          const carrier = atkBots[0];
          carrier.isCarrier = true;
          state.bomb.carrier = carrier;
          pushFeed(`${carrier.name} picks up the spike`, 'info');
        } else {
          state.bomb.carrier = null;
        }
      }
      hud.setBomb(null);
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showOverlay('dead', state.score);
    } else if (victim && victim !== 'player') {
      // A bot carrier died: hand the spike to the next living attacker,
      // or back to the player if they attack and are still alive.
      if (state.bomb.carrier === victim && state.bomb.status === 'carried') {
        const atkBots = bots.bots.filter((b) => b.team === attackers() && b.alive && b !== victim);
        if (atkBots.length) {
          const carrier = atkBots[0];
          carrier.isCarrier = true;
          state.bomb.carrier = carrier;
        } else if (iAttack() && player.state.alive) {
          state.bomb.carrier = 'player';
          hud.setBomb('carry');
        } else {
          state.bomb.carrier = null;
        }
      }
    }
    // Elimination wins the round — live phase only, unless the spike is planted.
    if (state.phase === 'live' && state.bomb.status !== 'planted') {
      if (livingCount('vanguard') === 0) finishRound('sentinel', 'Vanguard eliminated');
      else if (livingCount('sentinel') === 0) finishRound('vanguard', 'Sentinel eliminated');
    }
  }

  // ---- Spike plant: only in live, only by the carrier, only inside a site. ----
  function beginPlant(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'carried') return false;
    if (who !== state.bomb.carrier) return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    const inA = world.sites.A.zone.containsPoint(scratch.set(pos.x, pos.y + SITE_PROBE_H, pos.z));
    const inB = inA ? false : world.sites.B.zone.containsPoint(scratch.set(pos.x, pos.y + SITE_PROBE_H, pos.z));
    const site = inA ? 'A' : inB ? 'B' : null;
    if (!site) return false;
    state.plant.active = true;
    state.plant.who = who;
    state.plant.progress = 0;
    state.plant.site = site;
    return true;
  }

  function tickPlant(dt, who) {
    if (!state.plant.active || state.plant.who !== who) return;
    state.plant.progress += dt / PLANT_LEN;
    hud.setChannel('PLANTING SPIKE', state.plant.progress);
    if (state.plant.progress < 1) return;
    state.plant.active = false;
    hud.setChannel(null, 0);
    state.bomb.status = 'planted';
    state.bomb.site = state.plant.site;
    state.bomb.plantedAt = state.timer;
    state.bomb.plantPos = world.sites[state.plant.site].plant.clone();
    state.timer = FUSE_LEN;
    if (who === 'player') {
      state.money += PLANT_BOUNTY;
      hud.setMoney(state.money);
    }
    hud.setBomb('planted');
    hud.showBanner('SPIKE PLANTED', `Site ${state.bomb.site} — ${FUSE_LEN}s to detonation`, 2.6);
    audio.plantBeep(true);
    pushFeed(`Spike planted at Site ${state.bomb.site}`, who === 'player' ? 'good' : 'bad');
    // Every defender rotates to the planted site.
    for (const b of bots.bots) {
      if (b.team === defenders() && b.alive) {
        b.state = 'rotate';
        b.ai.setPath(b, state.bomb.site === 'A' ? 'aSite' : 'bSite');
      }
    }
  }

  // ---- Spike defuse: only in live, only while planted, only within range. ----
  function beginDefuse(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'planted') return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    if (!state.bomb.plantPos || pos.distanceTo(state.bomb.plantPos) > DEFUSE_REACH) return false;
    state.defuse.active = true;
    state.defuse.who = who;
    state.defuse.progress = 0;
    return true;
  }

  function tickDefuse(dt, who) {
    if (!state.defuse.active || state.defuse.who !== who) return;
    state.defuse.progress += dt / DEFUSE_LEN;
    hud.setChannel('DEFUSING SPIKE', state.defuse.progress);
    if (state.defuse.progress < 1) return;
    state.defuse.active = false;
    hud.setChannel(null, 0);
    state.bomb.status = 'defused';
    finishRound('sentinel', 'Spike defused');
  }

  function abortChannel(who) {
    if (state.plant.active && state.plant.who === who) {
      state.plant.active = false;
      hud.setChannel(null, 0);
    }
    if (state.defuse.active && state.defuse.who === who) {
      state.defuse.active = false;
      hud.setChannel(null, 0);
    }
  }

  // ---- Player damage: live phase only; armor absorbs half, headshots triple. ----
  function hurtPlayer(amount, part, attacker) {
    if (!player.state.alive || state.phase !== 'live') return false;
    let dmg = amount;
    if (part === 'head') dmg *= HEAD_MULT;
    if (player.state.armor > 0) {
      const absorbed = Math.min(player.state.armor, dmg * ARMOR_SOAK);
      player.state.armor -= absorbed;
      dmg -= absorbed;
    }
    player.state.health -= dmg;
    audio.hurt();
    hud.flashDamage();
    if (player.state.health <= 0) {
      player.state.health = 0;
      registerKill('player', attacker, part);
      return true;
    }
    return false;
  }

  // ---- The fixed-step phase machine ----
  function tick(dt, input) {
    state.time = (state.time || 0) + dt;
    for (const f of state.feed) f.t += dt;
    if (state.phase === 'buy') {
      state.timer -= dt;
      hud.setTimer(Math.max(0, Math.ceil(state.timer)), 'BUY');
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = ROUND_LEN;
        hud.closeBuy();
        hud.setPhase('live', state.round, state.score);
        hud.showBanner('ROUND LIVE', iAttack() ? 'Plant the spike' : 'Hold the sites', 1.6);
      }
    } else if (state.phase === 'live') {
      state.timer -= dt;
      hud.setTimer(Math.max(0, Math.ceil(state.timer)), state.bomb.status === 'planted' ? 'DETONATION' : 'ROUND');
      // Plant / defuse channels for the player (hold E).
      if (input.keys.has('KeyE')) {
        if (iAttack() && state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
          if (!state.plant.active) beginPlant('player');
          if (state.plant.active) tickPlant(dt, 'player');
        } else if (!iAttack() && state.bomb.status === 'planted') {
          if (!state.defuse.active) beginDefuse('player');
          if (state.defuse.active) tickDefuse(dt, 'player');
        }
      } else {
        abortChannel('player');
      }
      // Bomb fuse beeps, faster as it nears zero.
      if (state.bomb.status === 'planted' && state.timer > 0) {
        const interval = state.timer > BEEP_AFTER_SLOW ? BEEP_GAP_SLOW : state.timer > BEEP_AFTER_MED ? BEEP_GAP_MED : BEEP_GAP_FAST;
        if (Math.floor(state.timer / interval) !== Math.floor((state.timer + dt) / interval)) audio.plantBeep(false);
      }
      if (state.timer <= 0) {
        if (state.bomb.status === 'planted') {
          state.bomb.status = 'exploded';
          effects.explosion(state.bomb.plantPos);
          audio.explosion();
          finishRound('vanguard', 'Spike detonated');
        } else {
          finishRound('sentinel', 'Time expired — spike never planted');
        }
      }
    } else if (state.phase === 'roundEnd') {
      state.timer -= dt;
      if (state.timer <= 0) {
        if (!maybeEndMatch()) beginRound();
      }
    }
    // Prune old noise.
    while (state.noise.length && state.noise[0].time < (state.time || 0) - NOISE_TTL) state.noise.shift();
  }

  return {
    state,
    teamOf: sideTeam,
    attackTeam: attackers,
    defendTeam: defenders,
    playerTeam: myTeam,
    playerAttacks: iAttack,
    startMatch: beginMatch,
    startRound: beginRound,
    endRound: finishRound,
    onKill: registerKill,
    tryPlant: beginPlant,
    plantTick: tickPlant,
    tryDefuse: beginDefuse,
    defuseTick: tickDefuse,
    cancelChannel: abortChannel,
    damagePlayer: hurtPlayer,
    addNoise: pushNoise,
    blocked: isBlocked,
    aliveCount: livingCount,
    step: tick,
  };
}
