// FERROLINE — the entry program.
//
// Run it with `node main.ts` from this repository. It stages the playable
// game and its screenshots under /output, then writes the dossier the scorer
// recomputes from those same staged files — so the dossier and the game it
// describes always come from one pass, and a stale file can never leak in.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

// The bounty's gate caps: 160 KiB of source text, at most four screenshots
// of 256 KiB each, at most 993 entries inside game/.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

const here = dirname(fileURLToPath(import.meta.url));
const stage = '/output';

// Start from an empty stage, then lay down the two trees beside this file.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const tree of ['game', 'screenshots']) {
  cpSync(join(here, tree), join(stage, tree), { recursive: true });
}

const dossier = buildDossier(stage, CAPS);
writeFileSync(join(stage, 'dossier.json'), dossier);
console.log(`dossier.json written (${dossier.length} bytes)`);
