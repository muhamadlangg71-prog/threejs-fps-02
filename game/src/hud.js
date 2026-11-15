// The DOM HUD: crosshair, hit marker, health, armour, ammo, money, timer, score,
// kill feed, buy menu, banners and the one overlay panel. It never touches the
// simulation; main.js pushes numbers in and reads callbacks out.
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

// Overlay texts: [title, body, button label]. The match-end body is built live.
const COPY = {
  start: ['FERROLINE', 'A dusk rail yard. Two teams, one spike. Plant it at Crane Deck or the Depot — or stop the plant. First to 7 rounds takes the match.', 'Click to play'],
  paused: ['FERROLINE', 'Paused. Click to resume.', 'Click to resume'],
  dead: ['You are down', 'Your team fights on. You rejoin next round.', 'Spectate'],
  end: ['Match over', '', 'Play again'],
};

// Buy menu rows: [hotkey, item id, description]. Names and prices come from the
// weapon table (armour is the one non-weapon row).
const SHOP_SPEC = [
  ['1', 'rifle', 'Auto rifle · 30 rounds · accurate'],
  ['2', 'smg', 'Fast SMG · 32 rounds · close quarters'],
  ['3', 'sniper', 'Bolt sniper · 5 rounds · one-shot body'],
  ['4', 'pistol', 'Sidearm · 12 rounds · always with you'],
  ['5', 'armor', '100 armour · halves damage'],
  ['6', 'grenade', 'Frag grenade · throw with G'],
];

const ELEMENT_IDS = {
  overlay: 'overlay', overlayTitle: 'overlay-title', overlayCopy: 'overlay-copy',
  play: 'play', ammo: 'ammo', ammoMag: 'ammo-mag', ammoReserve: 'ammo-reserve',
  weaponName: 'weapon-name', healthValue: 'health-value', healthBar: 'health-bar',
  armorValue: 'armor-value', armorBar: 'armor-bar', armorRow: 'armor-row',
  moneyValue: 'money-value', timerValue: 'timer-value', timerLabel: 'timer-label',
  scoreV: 'score-v', scoreS: 'score-s', roundValue: 'round-value',
  feed: 'feed', hitmarker: 'hitmarker', crosshair: 'crosshair',
  damageFlash: 'damage-flash', dirIndicator: 'dir-indicator',
  banner: 'banner', bannerTitle: 'banner-title', bannerSub: 'banner-sub',
  channel: 'channel', channelLabel: 'channel-label', channelBar: 'channel-bar',
  buyMenu: 'buy-menu', buyMoney: 'buy-money', buyList: 'buy-list', buyHint: 'buy-hint',
  spikeTag: 'spike-tag', phaseTag: 'phase-tag',
};

export function createHud() {
  const ui = {};
  for (const [key, id] of Object.entries(ELEMENT_IDS)) ui[key] = document.getElementById(id);

  // Last values pushed, so unchanged numbers never touch the DOM again.
  const seen = { ammo: '', health: -1, armor: -1, money: -1, timer: -1, score: '' };
  let hitTimer = 0;
  let bannerTimer = 0;

  function makeEl(tag, cls, text) {
    const node = document.createElement(tag);
    node.className = cls || '';
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setHealth(health, armor) {
    const h = Math.max(0, Math.round(health));
    const a = Math.max(0, Math.round(armor));
    if (h !== seen.health) {
      seen.health = h;
      ui.healthValue.textContent = String(h);
      ui.healthBar.style.width = `${h}%`;
      ui.healthBar.classList.toggle('low', h <= 30);
    }
    if (a !== seen.armor) {
      seen.armor = a;
      ui.armorValue.textContent = String(a);
      ui.armorBar.style.width = `${a}%`;
      ui.armorRow.style.visibility = a > 0 ? 'visible' : 'hidden';
    }
  }

  function setAmmo(mag, reserve, label, name) {
    const key = `${mag}|${reserve}|${name}`;
    if (key === seen.ammo) return;
    seen.ammo = key;
    ui.ammoMag.textContent = String(mag);
    ui.ammoReserve.textContent = `${label} ${reserve}`;
    ui.weaponName.textContent = name;
    ui.ammo.classList.toggle('empty', mag === 0);
  }

  function setMoney(value) {
    if (value === seen.money) return;
    seen.money = value;
    ui.moneyValue.textContent = `$${value}`;
    ui.buyMoney.textContent = `$${value}`;
  }

  function setTimer(seconds, label) {
    if (seconds === seen.timer && ui.timerLabel.textContent === label) return;
    seen.timer = seconds;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    ui.timerValue.textContent = `${m}:${String(s).padStart(2, '0')}`;
    ui.timerLabel.textContent = label;
    ui.timerValue.classList.toggle('urgent', seconds <= 10);
  }

  function setScore(v, s, round) {
    const key = `${v}|${s}|${round}`;
    if (key === seen.score) return;
    seen.score = key;
    ui.scoreV.textContent = String(v);
    ui.scoreS.textContent = String(s);
    ui.roundValue.textContent = `ROUND ${round}`;
  }

  function setPhase(phase, round, score) {
    setScore(score.vanguard, score.sentinel, round);
    ui.phaseTag.textContent = phase === 'buy'
      ? 'BUY PHASE — press B to shop'
      : phase === 'live' ? 'ROUND LIVE' : phase.toUpperCase();
  }

  function setFeed(feed) {
    ui.feed.replaceChildren();
    for (const entry of feed) {
      const age = entry.t || 0;
      if (age > 6) continue;
      ui.feed.appendChild(makeEl('div', `feed-item ${entry.cls || ''}`, entry.text));
    }
  }

  function hitMarker(killed, holdMs = 90) {
    ui.hitmarker.classList.add('on');
    ui.hitmarker.classList.toggle('kill', !!killed);
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => ui.hitmarker.classList.remove('on', 'kill'), holdMs);
  }

  function flashDamage() {
    ui.damageFlash.classList.add('on');
    setTimeout(() => ui.damageFlash.classList.remove('on'), 140);
  }

  function showDirection(angleDeg) {
    ui.dirIndicator.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
    ui.dirIndicator.classList.add('on');
    setTimeout(() => ui.dirIndicator.classList.remove('on'), 500);
  }

  function setCrosshairSpread(px) {
    ui.crosshair.style.setProperty('--gap', `${px}px`);
  }

  function setBomb(status) {
    // status: 'carry' | 'planted' | null
    if (status === 'carry') {
      ui.spikeTag.hidden = false;
      ui.spikeTag.textContent = '◆ SPIKE — plant at A or B (hold E)';
      ui.spikeTag.className = 'spike-carry';
    } else if (status === 'planted') {
      ui.spikeTag.hidden = false;
      ui.spikeTag.textContent = '◆ SPIKE PLANTED — defend it';
      ui.spikeTag.className = 'spike-planted';
    } else {
      ui.spikeTag.hidden = true;
    }
  }

  function setChannel(label, progress) {
    if (!label) {
      ui.channel.hidden = true;
      return;
    }
    ui.channel.hidden = false;
    ui.channelLabel.textContent = label;
    ui.channelBar.style.width = `${Math.round(progress * 100)}%`;
  }

  function showBanner(titleText, subText, seconds = 2.5) {
    ui.bannerTitle.textContent = titleText;
    ui.bannerSub.textContent = subText;
    ui.banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      ui.banner.hidden = true;
    }, seconds * 1000);
  }

  function shopName(id) {
    return id === 'armor' ? 'Kevlar Armour' : WEAPONS[id].name;
  }

  function shopPrice(id) {
    return id === 'armor' ? ARMOR_PRICE : WEAPONS[id].price;
  }

  function openBuy(money, owned) {
    ui.buyMenu.hidden = false;
    ui.buyMoney.textContent = `$${money}`;
    ui.buyList.replaceChildren();
    for (const [hotkey, id, desc] of SHOP_SPEC) {
      const name = shopName(id);
      const price = shopPrice(id);
      const item = makeEl('button', 'buy-item', '');
      item.type = 'button';
      item.dataset.buy = id;
      const ownedMark = owned && owned.includes(id) ? ' — OWNED' : '';
      item.innerHTML = `<b>[${hotkey}] ${name}${ownedMark}</b><span>${desc}</span><i>$${price}</i>`;
      item.disabled = money < price;
      ui.buyList.appendChild(item);
    }
    ui.buyHint.textContent = 'Keys 1–6 to buy · B or Esc to close';
  }

  function closeBuy() {
    ui.buyMenu.hidden = true;
  }

  function isBuyOpen() {
    return !ui.buyMenu.hidden;
  }

  function showOverlay(mode, score, extra) {
    const [titleText, copyText, actionText] = COPY[mode];
    ui.overlayTitle.textContent = titleText;
    if (mode === 'end' && extra) {
      ui.overlayCopy.textContent = `${extra.winner} wins the match ${extra.score.vanguard}–${extra.score.sentinel}. You scored ${extra.kills} eliminations with ${extra.deaths} deaths.`;
    } else {
      ui.overlayCopy.textContent = copyText;
    }
    ui.play.textContent = actionText;
    ui.overlay.hidden = false;
    ui.play.focus();
  }

  function showMatchEnd(winner, score, kills) {
    showOverlay('end', score, { winner, score, kills: kills.player, deaths: kills.deaths });
  }

  function hideOverlay() {
    ui.overlay.hidden = true;
  }

  function onPlay(handler) {
    ui.play.addEventListener('click', handler);
  }

  const api = {
    setHealth,
    setAmmo,
    setMoney,
    setTimer,
    setScore,
    setPhase,
    setFeed,
    hitMarker,
    flashDamage,
    showDirection,
    setCrosshairSpread,
    setBomb,
    setChannel,
    showBanner,
    openBuy,
    closeBuy,
    isBuyOpen,
    showOverlay,
    showMatchEnd,
    hideOverlay,
    onPlay,
    onBuy: null,
  };

  // One delegated listener for the whole shop list: buttons are rebuilt on every
  // open, so per-button listeners would pile up; delegation fires once per click.
  ui.buyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-buy]');
    if (button && api.onBuy) api.onBuy(button.dataset.buy);
  });

  return api;
}
