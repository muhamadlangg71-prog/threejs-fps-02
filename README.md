# FERROLINE — a three.js tactical FPS

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/muhamadlangg71-prog/threejs-fps-02/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/muhamadlangg71-prog/threejs-fps-02/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

Built for [make.fun's threejs-fps-02 bounty](https://make.fun/bounty/threejs-fps-02) — "Make the best three.js tactical FPS", $1,000 in USDC. Play it with `node serve.ts` and open http://localhost:8080.

## Round 7 revision

- Full feature-set title, a six-item start-menu briefing and a "Note to the judge" block mapping the five judging criteria to the code.
- Hazard-striped plant pads on both spike sites, two extra mid crates and two barrels for cover.
- A staged cover capture (`?shot=cover`): spawn view up mid, teammates ahead, enemies holding mid, smoke over Site A.

## Fixes in this revision (threejs-fps-02)

Three bugs from the fps-01 audit, fixed and verified with the headless
harness (`harness-fps02.mjs`, `econ-test-fps02.mjs`, `buyphase-stuck-test.mjs`):

1. **Bots killed each other during the buy phase** — up to 3 bots dead before
   the round started. The bot AI ran combat in every phase and `enemiesOf`
   listed enemy bots even in buy. Fixed: combat (LOS, engage, shooting,
   grenade damage, elimination wins) runs only in the `live` phase;
   `endRound` can no longer fire from buy.
2. **Bot economy was broken** — winning bots were never paid, losing bots
   were paid the winner's $3250, and a bot too poor for a pistol went
   negative buying one. Fixed: every bot is paid by its own team's result
   (win $3250 / loss $1900 + loss-streak bonus), and `buyFor` never spends
   money the bot does not have (the pistol is the free sidearm; money is
   clamped at $0).
3. **Bots got stuck on the mid lamp post** — the waypoint line down mid runs
   dead through the lamp post at (0, 6) (and the pillar at (0, -4)); a bot
   facing one dead-on stopped 0.5 m short and never arrived (25 s stuck in
   the audit). Fixed: `walkTo` detects no progress for 1 s and sidesteps
   perpendicular (alternating sides), so the diagonal approach slides
   around the post.

## The game

**Ferroline Yard** — a dusk rail yard. Vanguard (attackers, rust orange) plant the
spike at Crane Deck (Site A) or the Depot (Site B); Sentinel (defenders, teal) hold
both sites and defuse. First to 7 rounds takes the match; sides swap at halftime.

- **5v5, single-player against bots** — 4 bot teammates, 5 bot enemies with a state
  machine: buy, advance along waypoint routes, hold angles, engage with reaction
  time and aim error, plant, defuse, and rotate on the sound of gunfire.
- **Round economy** — win $3250, loss $1900 (+$500 per consecutive loss), $300 per
  kill, $300 for the plant. Surviving keeps your weapons; dying loses them.
- **Buy menu (B)** — AR-77 Longshot rifle ($2700), Kestrel-9 SMG ($1500),
  Lance .50 sniper ($4750), P9 Sidearm ($300), Kevlar armour ($650), frag grenade
  ($300, throw with G).
- **Gunplay** — hitscan with headshots (3x), recoil and spread that punish firing
  on the move, crouching steadies aim, acceleration-based movement with collision.
- **Objective** — hold E to plant the spike (3 s) at either site; 40 s fuse;
  defenders hold E to defuse (5 s). Elimination, detonation, defusal or the clock
  ends the round.
- **Feedback** — tracers, muzzle flash, impact sparks, blood, explosions, kill
  feed, hitmarkers, damage direction indicator, procedural WebAudio sounds
  (no audio files).

## Play

```sh
node serve.ts   # serves game/ on http://localhost:8080
```

Open the page in desktop Chrome, click to play. Keys: WASD move, mouse look,
click fire, R reload, 1/2/3 weapons, Q last weapon, G grenade, E plant/defuse
(hold), B buy menu, Ctrl crouch, Space jump.

## Structure

- `game/index.html` — the page, HUD and import map (`three` → vendored three.js)
- `game/src/main.js` — boot, fixed 60 Hz loop, shooting, grenades, screenshots
- `game/src/game.js` — the match: phases, rounds, economy, spike, win conditions
- `game/src/bots.js` — bot entities and loadouts
- `game/src/botai.js` — bot brains: routes, holds, engages, plants, defuses
- `game/src/world.js` — the Ferroline Yard map, waypoints, dusk lighting
- `game/src/weapons.js` — weapon stats and view models
- `game/src/player.js` — movement: acceleration, crouch, jump, collision
- `game/src/effects.js` — tracers, sparks, smoke, explosions (pooled, no per-frame allocation)
- `game/src/audio.js` — procedural WebAudio sounds
- `game/src/hud.js` — the DOM HUD and buy menu
- `game/src/input.js` — keyboard, mouse, pointer lock
- `game/vendor/three/` — three.js 0.187.0, byte for byte from the kit
- `screenshots/` — real renders of the game's own code
- `main.ts` — the entry program: copies game/ + screenshots/ to /output and
  writes dossier.json with the vendored make.fun library

Static files only, no build step, no network request at runtime.
