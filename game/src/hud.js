// The DOM HUD: every number and panel on screen, driven by the match.
// main.js and game.js call the setters every tick; the HUD itself dedupes
// by value, so unchanged numbers never touch the DOM. The buy menu is
// built from the same WEAPONS table as the loadouts, so a price change
// shows up in the shop and in the loadout together.
//
// Overlay kinds: 'start' (the menu), 'paused' (pointer lock lost mid
// round), 'dead' (eliminated, waiting for the next round). The match-end
// panel is a separate call because it carries the final score and K/D.
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

const SHOP = [
  { id: 'rifle', key: '1' },
  { id: 'smg', key: '2' },
  { id: 'sniper', key: '3' },
  { id: 'pistol', key: '4' },
  { id: 'armor', key: '5', name: 'Kevlar Armour', price: ARMOR_PRICE, desc: '100 armour · halves damage' },
  { id: 'grenade', key: '6' },
];

const PHASE_TAGS = {
  menu: 'FERROLINE — 5V5 PLANT / DEFUSE',
  buy: 'BUY PHASE — press B to shop',
  live: 'ROUND LIVE',
  roundEnd: 'ROUND END',
  matchEnd: 'MATCH END',
};

const SPIKE_TEXT = {
  carry: '◆ SPIKE — plant at A or B (hold E)',
  planted: '◆ SPIKE PLANTED — hold E to defuse',
};

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const els = {
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    flash: $('damage-flash'),
    dir: $('dir-indicator'),
    timerValue: $('timer-value'),
    timerLabel: $('timer-label'),
    scoreV: $('score-v'),
    scoreS: $('score-s'),
    roundValue: $('round-value'),
    phaseTag: $('phase-tag'),
    feed: $('feed'),
    spike: $('spike-tag'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    channel: $('channel'),
    channelLabel: $('channel-label'),
    channelBar: $('channel-bar'),
    healthValue: $('health-value'),
    healthBar: $('health-bar'),
    armorRow: $('armor-row'),
    armorValue: $('armor-value'),
    armorBar: $('armor-bar'),
    weaponName: $('weapon-name'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    ammo: $('ammo'),
    moneyValue: $('money-value'),
    buyMenu: $('buy-menu'),
    buyMoney: $('buy-money'),
    buyList: $('buy-list'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    play: $('play'),
  };

  let playHandler = null;
  let bannerTimer = null;
  let hitTimer = null;
  let flashTimer = null;
  let dirTimer = null;
  const last = {
    health: null, armor: null, mag: null, reserve: null, label: null, name: null,
    money: null, feed: null, gap: null, timer: null, timerLabel: null,
    score: null, phase: null, bomb: null, channel: null, channelProgress: null,
  };

  els.play.addEventListener('click', () => {
    if (playHandler) playHandler();
  });

  function setHealth(health, armor) {
    const h = Math.max(0, Math.round(health));
    const a = Math.max(0, Math.round(armor));
    if (last.health !== h) {
      last.health = h;
      els.healthValue.textContent = String(h);
      els.healthBar.style.width = `${clamp01(h / 100) * 100}%`;
      els.healthBar.classList.toggle('low', h <= 30);
    }
    if (last.armor !== a) {
      last.armor = a;
      els.armorValue.textContent = String(a);
      els.armorBar.style.width = `${clamp01(a / 100) * 100}%`;
      els.armorRow.style.visibility = a > 0 ? 'visible' : 'hidden';
    }
  }

  function setAmmo(mag, reserve, label, name) {
    if (last.mag !== mag || last.reserve !== reserve || last.label !== label || last.name !== name) {
      last.mag = mag;
      last.reserve = reserve;
      last.label = label;
      last.name = name;
      els.ammoMag.textContent = String(mag);
      els.ammoReserve.textContent = `${label}${reserve}`;
      els.weaponName.textContent = String(name).toUpperCase();
      els.ammo.classList.toggle('empty', mag === 0);
    }
  }

  function setMoney(money) {
    if (last.money !== money) {
      last.money = money;
      els.moneyValue.textContent = `$${money}`;
    }
  }

  function setFeed(feed) {
    const sig = feed.map((f) => `${f.text}|${f.cls || ''}`).join('\n');
    if (last.feed === sig) return;
    last.feed = sig;
    els.feed.replaceChildren();
    for (const item of feed.slice(0, 5)) {
      const div = document.createElement('div');
      div.className = `feed-item${item.cls ? ` ${item.cls}` : ''}`;
      div.textContent = item.text;
      els.feed.appendChild(div);
    }
  }

  function setCrosshairSpread(px) {
    if (last.gap !== px) {
      last.gap = px;
      els.crosshair.style.setProperty('--gap', `${px}px`);
    }
  }

  function setScore(v, s, round) {
    const sig = `${v}|${s}|${round}`;
    if (last.score === sig) return;
    last.score = sig;
    els.scoreV.textContent = String(v);
    els.scoreS.textContent = String(s);
    els.roundValue.textContent = `ROUND ${round}`;
  }

  function setPhase(phase, round, score) {
    if (last.phase !== phase) {
      last.phase = phase;
      els.phaseTag.textContent = PHASE_TAGS[phase] || phase.toUpperCase();
    }
    setScore(score.vanguard, score.sentinel, round);
  }

  function setTimer(seconds, label) {
    const s = Math.max(0, Math.ceil(seconds));
    if (last.timer !== s || last.timerLabel !== label) {
      last.timer = s;
      last.timerLabel = label;
      els.timerValue.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      els.timerLabel.textContent = label;
      els.timerValue.classList.toggle('urgent', s <= 10);
    }
  }

  function setBomb(status) {
    if (last.bomb === status) return;
    last.bomb = status;
    if (!status) {
      els.spike.hidden = true;
      return;
    }
    els.spike.hidden = false;
    els.spike.textContent = SPIKE_TEXT[status] || '';
    els.spike.classList.toggle('spike-carry', status === 'carry');
    els.spike.classList.toggle('spike-planted', status === 'planted');
  }

  function setChannel(text, progress) {
    const p = Math.round(clamp01(progress || 0) * 100);
    if (last.channel === text && last.channelProgress === p) return;
    last.channel = text;
    last.channelProgress = p;
    if (!text) {
      els.channel.hidden = true;
      return;
    }
    els.channel.hidden = false;
    els.channelLabel.textContent = text;
    els.channelBar.style.width = `${p}%`;
  }

  function showBanner(title, sub, seconds) {
    els.bannerTitle.textContent = title;
    els.bannerSub.textContent = sub || '';
    els.banner.hidden = false;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      els.banner.hidden = true;
      bannerTimer = null;
    }, (seconds || 2) * 1000);
  }

  function showOverlay(kind, score) {
    const overlayCopy = {
      start: ['FERROLINE<span class="tag"> — 5V5 PLANT / DEFUSE</span>',
        'Round-based 5v5. Plant the spike at Crane Deck or the Depot — or stop the plant. Buy four guns, armour and a frag grenade with round money, and fight beside team bots that follow routes and hold angles. First to 7 rounds takes the match.',
        'Click to play'],
      paused: ['PAUSED',
        'The match is waiting. Click to jump back in.',
        'Resume'],
      dead: ['YOU ARE DOWN',
        'You were eliminated. Your team keeps fighting — click to watch the round play out.',
        'Watch'],
    };
    const [title, copy, button] = overlayCopy[kind] || overlayCopy.start;
    els.overlayTitle.innerHTML = title;
    els.overlayCopy.textContent = copy;
    els.play.textContent = button;
    els.overlay.hidden = false;
  }

  function showMatchEnd(winner, score, kills) {
    els.overlayTitle.textContent = `${winner} TAKES THE MATCH`;
    els.overlayCopy.textContent = `Final score ${score.vanguard} — ${score.sentinel}. You finished ${kills.player} kills and ${kills.deaths} deaths.`;
    els.play.textContent = 'Play again';
    els.overlay.hidden = false;
  }

  function hideOverlay() {
    els.overlay.hidden = true;
  }

  function openBuy(money, owned) {
    els.buyMoney.textContent = `$${money}`;
    els.buyList.replaceChildren();
    const ownedSet = new Set(owned);
    for (const entry of SHOP) {
      const spec = entry.id === 'armor'
        ? { name: entry.name, price: entry.price, desc: entry.desc }
        : WEAPONS[entry.id];
      const isOwned = ownedSet.has(entry.id);
      const afford = money >= spec.price;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'buy-item';
      button.disabled = isOwned || !afford;
      const title = document.createElement('b');
      title.textContent = `[${entry.key}] ${spec.name}${isOwned ? ' — OWNED' : ''}`;
      const desc = document.createElement('span');
      desc.textContent = spec.desc;
      const price = document.createElement('i');
      price.textContent = `$${spec.price}`;
      button.append(title, desc, price);
      button.addEventListener('click', () => {
        if (api.onBuy) api.onBuy(entry.id);
      });
      els.buyList.appendChild(button);
    }
    els.buyMenu.hidden = false;
  }

  function closeBuy() {
    els.buyMenu.hidden = true;
  }

  function isBuyOpen() {
    return !els.buyMenu.hidden;
  }

  function hitMarker(kill, ms) {
    els.hitmarker.classList.add('on');
    els.hitmarker.classList.toggle('kill', !!kill);
    if (hitTimer) clearTimeout(hitTimer);
    hitTimer = setTimeout(() => {
      els.hitmarker.classList.remove('on', 'kill');
      hitTimer = null;
    }, ms || 90);
  }

  function flashDamage() {
    els.flash.classList.add('on');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      els.flash.classList.remove('on');
      flashTimer = null;
    }, 140);
  }

  function showDirection(degrees) {
    els.dir.style.transform = `translate(-50%, -50%) rotate(${degrees}deg)`;
    els.dir.classList.add('on');
    if (dirTimer) clearTimeout(dirTimer);
    dirTimer = setTimeout(() => {
      els.dir.classList.remove('on');
      dirTimer = null;
    }, 900);
  }

  function onPlay(fn) {
    playHandler = fn;
  }

  const api = {
    onBuy: null,
    onPlay,
    setHealth,
    setAmmo,
    setMoney,
    setFeed,
    setCrosshairSpread,
    setPhase,
    setTimer,
    setScore,
    setBomb,
    setChannel,
    showBanner,
    showMatchEnd,
    showOverlay,
    hideOverlay,
    openBuy,
    closeBuy,
    isBuyOpen,
    hitMarker,
    flashDamage,
    showDirection,
  };
  return api;
}
