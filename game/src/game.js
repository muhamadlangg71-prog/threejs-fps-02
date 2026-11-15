// The match: one state object for everything — phase, round, score, money, the spike.
// Fixed-step simulation; rendering reads this state and nothing else. Phases:
// menu -> buy (15 s) -> live (100 s, or 40 s after the plant) -> roundEnd (4 s) ->
// next buy. First to 7 rounds takes the match; sides swap after round 7.
//
// PHASE GATING — the rule every combat function obeys: nothing dies, plants or
// defuses outside the live phase. endRound() returns early unless phase is
// 'live', damagePlayer() refuses damage outside 'live', and tryPlant /
// tryDefuse refuse to start a channel outside 'live'. The buy phase is
// therefore bloodless by construction: bots may walk and buy, but no kill,
// plant or defuse can happen until the round goes live.
import * as THREE from 'three';
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

// ---- Round timing ----
const BUY_SECONDS = 15; // buy phase length
const ROUND_SECONDS = 100; // live phase length without a plant
const FUSE_SECONDS = 40; // live phase length once the spike is planted
const PLANT_SECONDS = 3; // channel time to plant the spike
const DEFUSE_SECONDS = 5; // channel time to defuse the spike
const ROUND_END_SECONDS = 4; // pause between rounds
const WIN_ROUNDS = 7; // rounds needed to take the match
const HALFTIME_ROUND = 7; // sides swap after this round

// ---- Economy (see endRound for the payout rule) ----
const START_MONEY = 800; // every fighter's starting bankroll
const WIN_PAY = 3250; // round-win payout, winners and the player when they win
const LOSE_PAY_BASE = 1900; // round-loss payout before the streak bonus
const LOSE_PAY_STEP = 500; // extra loss pay per consecutive loss
const LOSE_PAY_CAP = 3400; // loss pay never exceeds this
const KILL_REWARD = 300; // money per kill (player and bots alike)
const PLANT_REWARD = 300; // money for planting the spike
const BOMB_SITE_A_CHANCE = 0.55; // probability the spike target is Site A

// ---- Combat ----
const HEADSHOT_MULTIPLIER = 3; // headshots deal 3x damage to the player
const ARMOR_ABSORB_FRACTION = 0.5; // armor absorbs up to half of a hit
const DEFUSE_RANGE = 2.2; // max distance from the spike to defuse
const SITE_CHECK_HEIGHT = 0.5; // probe height when testing which site a fighter stands in

// ---- Feed / noise bookkeeping ----
const FEED_MAX_ENTRIES = 5; // kill-feed lines kept on screen
const NOISE_MAX_ENTRIES = 24; // recent noise events bots can hear
const NOISE_TTL_SECONDS = 2; // noise older than this is forgotten

// ---- Fuse beep pacing: faster as detonation nears ----
const BEEP_SLOW_AFTER = 20; // >20 s left: beep every 1 s
const BEEP_MED_AFTER = 10; // >10 s left: beep every 0.5 s
const BEEP_SLOW_INTERVAL = 1;
const BEEP_MED_INTERVAL = 0.5;
const BEEP_FAST_INTERVAL = 0.25;

export function createGame(world, bots, player, loadout, hud, audio, effects) {
  const state = {
    phase: 'menu',
    half: 1,
    round: 0,
    score: { vanguard: 0, sentinel: 0 },
    lossStreak: { vanguard: 0, sentinel: 0 },
    money: START_MONEY,
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
  const tmpV = new THREE.Vector3();

  // ---- Sides: roles flip at halftime, the teams themselves never change. ----
  function teamOf(side) {
    if (state.half === 1) return side === 'attack' ? 'vanguard' : 'sentinel';
    return side === 'attack' ? 'sentinel' : 'vanguard';
  }
  function attackTeam() {
    return teamOf('attack');
  }
  function defendTeam() {
    return teamOf('defend');
  }
  function playerTeam() {
    return 'vanguard';
  }
  function playerAttacks() {
    return attackTeam() === 'vanguard';
  }

  // ---- Kill feed and hearing ----
  function addFeed(text, cls) {
    state.feed.unshift({ text, cls, t: 0 });
    if (state.feed.length > FEED_MAX_ENTRIES) state.feed.pop();
    hud.setFeed(state.feed);
  }

  function addNoise(x, z, radius) {
    state.noise.push({ pos: { x, z }, radius, time: state.time || 0 });
    if (state.noise.length > NOISE_MAX_ENTRIES) state.noise.shift();
  }

  // Is a bot-sized box at (x, z) inside any world collider?
  function blocked(x, z) {
    probe.min.set(x - 0.34, 0.05, z - 0.34);
    probe.max.set(x + 0.34, 1.7, z + 0.34);
    for (const c of world.colliders) {
      if (probe.intersectsBox(c)) return true;
    }
    return false;
  }

  // ---- Spawning: Vanguard always spawns south in half 1, north in half 2. ----
  function spawnPositions(team) {
    const south = state.half === 1;
    if (team === 'vanguard') return south ? world.spawns.vanguard : world.spawns.sentinel;
    return south ? world.spawns.sentinel : world.spawns.vanguard;
  }

  function spawnYaw(team) {
    const south = state.half === 1;
    if (team === 'vanguard') return south ? Math.PI : 0;
    return south ? 0 : Math.PI;
  }

  function startMatch() {
    state.phase = 'buy';
    state.half = 1;
    state.round = 0;
    state.score = { vanguard: 0, sentinel: 0 };
    state.lossStreak = { vanguard: 0, sentinel: 0 };
    state.money = START_MONEY;
    state.kills = { player: 0, deaths: 0 };
    state.winner = null;
    startRound();
  }

  function startRound() {
    state.round += 1;
    state.phase = 'buy';
    state.timer = BUY_SECONDS;
    state.bomb = { status: 'carried', site: Math.random() < BOMB_SITE_A_CHANCE ? 'A' : 'B', carrier: 'player', plantPos: null, plantedAt: 0, defuser: null };
    state.plant = { active: false, progress: 0, who: null };
    state.defuse = { active: false, progress: 0, who: null };
    state.feed = [];
    hud.setFeed([]);
    hud.setPhase('buy', state.round, state.score);
    hud.setBomb(null);
    hud.setMoney(state.money);

    const atk = attackTeam();
    const def = defendTeam();
    // Player: spawn, face the map, keep weapons if they survived last round.
    const survived = state.lastSurvived === true;
    const pSpawns = spawnPositions('vanguard');
    const pSpawn = pSpawns[2];
    player.teleport(pSpawn.x, pSpawn.y, pSpawn.z, spawnYaw('vanguard'));
    player.state.health = 100;
    player.state.armor = survived ? player.state.armor : 0;
    player.state.alive = true;
    loadout.resetRound(survived);
    state.lastSurvived = false;
    if (playerAttacks()) {
      state.bomb.carrier = 'player';
      hud.setBomb('carry');
    } else {
      state.bomb.carrier = null;
      hud.setBomb(null);
    }

    // Bots: buy, spawn, assign lanes and hold angles.
    const atkBots = bots.bots.filter((b) => b.team === atk);
    const defBots = bots.bots.filter((b) => b.team === def);
    const dSpawns = spawnPositions(def);
    const aSpawns = spawnPositions(atk);
    atkBots.forEach((bot, i) => {
      const spawn = aSpawns[i % aSpawns.length];
      bots.resetBot(bot, spawn, spawnYaw(atk));
      bot.role = 'attack';
      bot.site = state.bomb.site;
      bots.buyFor(bot);
      bot.isCarrier = false;
      assignAttacker(bot, i, atkBots.length);
    });
    defBots.forEach((bot, i) => {
      const spawn = dSpawns[i % dSpawns.length];
      bots.resetBot(bot, spawn, spawnYaw(def));
      bot.role = 'defend';
      bot.site = i % 2 === 0 ? 'A' : 'B';
      bots.buyFor(bot);
      bot.isCarrier = false;
      assignDefender(bot, i, defBots.length);
    });
    // If the player defends, a random attacker bot carries the spike.
    if (!playerAttacks()) {
      const carrier = atkBots[Math.floor(Math.random() * atkBots.length)];
      carrier.isCarrier = true;
      state.bomb.carrier = carrier;
    }
    audio.buy();
    hud.showBanner(`ROUND ${state.round}`, playerAttacks() ? `Plant the spike at Site ${state.bomb.site}` : 'Defend both sites', 2.6);
  }

  // Attackers split: point takes the long lane, second goes through mid,
  // third lurks the other site, the rest take mid control.
  function assignAttacker(bot, i, total) {
    const site = state.bomb.site;
    const other = site === 'A' ? 'B' : 'A';
    const ai = bot.ai;
    if (i === 0) {
      // Point: straight to the site through the long lane.
      ai.setPath(bot, site === 'A' ? 'aEntry' : 'bEntry');
      bot.state = 'advance';
    } else if (i === 1) {
      // Second: through mid to the site.
      ai.setPath(bot, site === 'A' ? 'midA' : 'midB');
      bot.state = 'advance';
      bot.afterMid = site === 'A' ? 'aEntry' : 'bEntry';
    } else if (i === 2) {
      // Lurk: the other site, to split the defence.
      ai.setPath(bot, other === 'A' ? 'aLong2' : 'bLong2');
      bot.state = 'advance';
    } else {
      // Mid control.
      ai.setPath(bot, 'midDoor');
      bot.state = 'advance';
    }
    bot.holdYaw = 0;
  }

  // Defenders hold their site angles; the last defender roams mid.
  function assignDefender(bot, i, total) {
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
  // Winners get WIN_PAY, losers get LOSE_PAY_BASE plus LOSE_PAY_STEP per
  // consecutive loss (capped at LOSE_PAY_CAP) — the classic loss-streak
  // bonus that lets a struggling team buy back in. The player is paid
  // exactly like a bot on their team: winPay when Vanguard wins, losePay
  // when Vanguard loses. (Was: winning bots were never paid, and losing
  // bots got winPay.)
  function endRound(winner, reason) {
    // Phase gate: a round can only end from 'live'. Calls from buy or
    // roundEnd (stray kills, late timers) are ignored.
    if (state.phase !== 'live') return;
    state.phase = 'roundEnd';
    state.timer = ROUND_END_SECONDS;
    state.winner = winner;
    state.reason = reason;
    state.score[winner] += 1;
    const loser = winner === 'vanguard' ? 'sentinel' : 'vanguard';
    state.lossStreak[winner] = 0;
    state.lossStreak[loser] += 1;
    const winPay = WIN_PAY;
    const losePay = Math.min(LOSE_PAY_CAP, LOSE_PAY_BASE + (state.lossStreak[loser] - 1) * LOSE_PAY_STEP);
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
    addFeed(`${winner === 'vanguard' ? 'Vanguard' : 'Sentinel'} takes round ${state.round} — ${reason}`, playerWon ? 'good' : 'bad');
    if (state.bomb.status === 'planted') hud.setBomb(null);
  }

  function checkMatchEnd() {
    if (state.score.vanguard >= WIN_ROUNDS || state.score.sentinel >= WIN_ROUNDS) {
      state.phase = 'matchEnd';
      const winner = state.score.vanguard >= WIN_ROUNDS ? 'vanguard' : 'sentinel';
      hud.showMatchEnd(winner === 'vanguard' ? 'VANGUARD' : 'SENTINEL', state.score, state.kills);
      if (document.pointerLockElement) document.exitPointerLock();
      return true;
    }
    if (state.round === HALFTIME_ROUND && state.half === 1) {
      state.half = 2;
      hud.showBanner('HALFTIME — SIDES SWAP', 'Vanguard now defends, Sentinel attacks', 3);
    }
    return false;
  }

  function aliveCount(team) {
    let n = 0;
    if (team === 'vanguard' && player.state.alive) n += 1;
    for (const b of bots.bots) if (b.team === team && b.alive) n += 1;
    return n;
  }

  function onKill(victim, killer, part) {
    const vName = victim === 'player' ? 'You' : victim.name;
    const kName = killer === 'player' ? 'You' : killer.name;
    const weaponName = killer === 'player' ? loadout.def().name : killer.loadout.def().name;
    addFeed(`${kName} ▸ ${vName}  ·  ${weaponName}${part === 'head' ? '  ·  HEADSHOT' : ''}`, killer === 'player' ? 'good' : 'bad');
    // Kill reward goes to whoever landed it: the player or the bot.
    if (killer === 'player') {
      state.money += KILL_REWARD;
      state.kills.player += 1;
      hud.setMoney(state.money);
    } else if (killer && killer !== 'player') {
      killer.money += KILL_REWARD;
      killer.kills += 1;
    }
    if (victim === 'player') {
      state.kills.deaths += 1;
      player.state.alive = false;
      // Drop the spike: the nearest living attacker bot picks it up.
      if (state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
        const atkBots = bots.bots.filter((b) => b.team === attackTeam() && b.alive);
        if (atkBots.length) {
          const carrier = atkBots[0];
          carrier.isCarrier = true;
          state.bomb.carrier = carrier;
          addFeed(`${carrier.name} picks up the spike`, 'info');
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
        const atkBots = bots.bots.filter((b) => b.team === attackTeam() && b.alive && b !== victim);
        if (atkBots.length) {
          const carrier = atkBots[0];
          carrier.isCarrier = true;
          state.bomb.carrier = carrier;
        } else if (playerAttacks() && player.state.alive) {
          state.bomb.carrier = 'player';
          hud.setBomb('carry');
        } else {
          state.bomb.carrier = null;
        }
      }
    }
    // Elimination wins the round — live phase only, unless the spike is planted.
    if (state.phase === 'live' && state.bomb.status !== 'planted') {
      if (aliveCount('vanguard') === 0) endRound('sentinel', 'Vanguard eliminated');
      else if (aliveCount('sentinel') === 0) endRound('vanguard', 'Sentinel eliminated');
    }
  }

  // ---- Spike plant: only in live, only by the carrier, only inside a site. ----
  function tryPlant(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'carried') return false;
    if (who !== state.bomb.carrier) return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    const site = world.sites.A.zone.containsPoint(tmpV.set(pos.x, pos.y + SITE_CHECK_HEIGHT, pos.z)) ? 'A'
      : world.sites.B.zone.containsPoint(tmpV.set(pos.x, pos.y + SITE_CHECK_HEIGHT, pos.z)) ? 'B' : null;
    if (!site) return false;
    state.plant.active = true;
    state.plant.who = who;
    state.plant.progress = 0;
    state.plant.site = site;
    return true;
  }

  function plantTick(dt, who) {
    if (!state.plant.active || state.plant.who !== who) return;
    state.plant.progress += dt / PLANT_SECONDS;
    hud.setChannel('PLANTING SPIKE', state.plant.progress);
    if (state.plant.progress >= 1) {
      state.plant.active = false;
      hud.setChannel(null, 0);
      state.bomb.status = 'planted';
      state.bomb.site = state.plant.site;
      state.bomb.plantedAt = state.timer;
      state.bomb.plantPos = world.sites[state.plant.site].plant.clone();
      state.timer = FUSE_SECONDS;
      if (who === 'player') {
        state.money += PLANT_REWARD;
        hud.setMoney(state.money);
      }
      hud.setBomb('planted');
      hud.showBanner('SPIKE PLANTED', `Site ${state.bomb.site} — ${FUSE_SECONDS}s to detonation`, 2.6);
      audio.plantBeep(true);
      addFeed(`Spike planted at Site ${state.bomb.site}`, who === 'player' ? 'good' : 'bad');
      // Every defender rotates to the planted site.
      for (const b of bots.bots) {
        if (b.team === defendTeam() && b.alive) {
          b.state = 'rotate';
          b.ai.setPath(b, state.bomb.site === 'A' ? 'aSite' : 'bSite');
        }
      }
    }
  }

  // ---- Spike defuse: only in live, only while planted, only within range. ----
  function tryDefuse(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'planted') return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    if (!state.bomb.plantPos || pos.distanceTo(state.bomb.plantPos) > DEFUSE_RANGE) return false;
    state.defuse.active = true;
    state.defuse.who = who;
    state.defuse.progress = 0;
    return true;
  }

  function defuseTick(dt, who) {
    if (!state.defuse.active || state.defuse.who !== who) return;
    state.defuse.progress += dt / DEFUSE_SECONDS;
    hud.setChannel('DEFUSING SPIKE', state.defuse.progress);
    if (state.defuse.progress >= 1) {
      state.defuse.active = false;
      hud.setChannel(null, 0);
      state.bomb.status = 'defused';
      endRound('sentinel', 'Spike defused');
    }
  }

  function cancelChannel(who) {
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
  function damagePlayer(amount, part, attacker) {
    if (!player.state.alive || state.phase !== 'live') return false;
    let dmg = amount;
    if (part === 'head') dmg *= HEADSHOT_MULTIPLIER;
    if (player.state.armor > 0) {
      const absorbed = Math.min(player.state.armor, dmg * ARMOR_ABSORB_FRACTION);
      player.state.armor -= absorbed;
      dmg -= absorbed;
    }
    player.state.health -= dmg;
    audio.hurt();
    hud.flashDamage();
    if (player.state.health <= 0) {
      player.state.health = 0;
      onKill('player', attacker, part);
      return true;
    }
    return false;
  }

  // ---- The fixed-step phase machine ----
  function step(dt, input) {
    state.time = (state.time || 0) + dt;
    for (const f of state.feed) f.t += dt;
    if (state.phase === 'buy') {
      state.timer -= dt;
      hud.setTimer(Math.max(0, Math.ceil(state.timer)), 'BUY');
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = ROUND_SECONDS;
        hud.closeBuy();
        hud.setPhase('live', state.round, state.score);
        hud.showBanner('ROUND LIVE', playerAttacks() ? 'Plant the spike' : 'Hold the sites', 1.6);
      }
    } else if (state.phase === 'live') {
      state.timer -= dt;
      hud.setTimer(Math.max(0, Math.ceil(state.timer)), state.bomb.status === 'planted' ? 'DETONATION' : 'ROUND');
      // Plant / defuse channels for the player (hold E).
      if (input.keys.has('KeyE')) {
        if (playerAttacks() && state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
          if (!state.plant.active) tryPlant('player');
          if (state.plant.active) plantTick(dt, 'player');
        } else if (!playerAttacks() && state.bomb.status === 'planted') {
          if (!state.defuse.active) tryDefuse('player');
          if (state.defuse.active) defuseTick(dt, 'player');
        }
      } else {
        cancelChannel('player');
      }
      // Bomb fuse beeps, faster as it nears zero.
      if (state.bomb.status === 'planted' && state.timer > 0) {
        const interval = state.timer > BEEP_SLOW_AFTER ? BEEP_SLOW_INTERVAL : state.timer > BEEP_MED_AFTER ? BEEP_MED_INTERVAL : BEEP_FAST_INTERVAL;
        if (Math.floor(state.timer / interval) !== Math.floor((state.timer + dt) / interval)) audio.plantBeep(false);
      }
      if (state.timer <= 0) {
        if (state.bomb.status === 'planted') {
          state.bomb.status = 'exploded';
          effects.explosion(state.bomb.plantPos);
          audio.explosion();
          endRound('vanguard', 'Spike detonated');
        } else {
          endRound('sentinel', 'Time expired — spike never planted');
        }
      }
    } else if (state.phase === 'roundEnd') {
      state.timer -= dt;
      if (state.timer <= 0) {
        if (!checkMatchEnd()) startRound();
      }
    }
    // Prune old noise.
    while (state.noise.length && state.noise[0].time < (state.time || 0) - NOISE_TTL_SECONDS) state.noise.shift();
  }

  return {
    state,
    teamOf, attackTeam, defendTeam, playerTeam, playerAttacks,
    startMatch, startRound, endRound,
    onKill, tryPlant, plantTick, tryDefuse, defuseTick, cancelChannel,
    damagePlayer, addNoise, blocked, aliveCount,
    step,
  };
}
