// FERROLINE — the entry program.
//
// Run it with `node main.ts` from this repository. It stages the playable
// game and its screenshots under the output directory, then writes the
// dossier the scorer recomputes from those same staged files — so the
// dossier and the game it describes always come from one pass, and a stale
// file can never leak in.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

// The bounty's gate caps: 160 KiB of source text, at most four screenshots
// of 256 KiB each, at most 993 entries inside game/.
const GATE_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

const TREES = ['game', 'screenshots'];

function outputDir() {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

function emptyContents(dir) {
  // Only clear the contents. The directory itself must never be removed:
  // in the grader it is a mount point, and deleting it fails for the entry
  // user (65534) — that crash is what failed the resubmission's dev-phase
  // grade run. The contents are owned by the entry user, so removing them
  // is fine.
  for (const child of readdirSync(dir)) {
    rmSync(join(dir, child), { recursive: true, force: true });
  }
}

function stageTrees(root, out) {
  for (const tree of TREES) {
    cpSync(join(root, tree), join(out, tree), { recursive: true });
  }
}

const repoRoot = dirname(fileURLToPath(import.meta.url));
const outDir = outputDir();
mkdirSync(outDir, { recursive: true });
emptyContents(outDir);
stageTrees(repoRoot, outDir);

const dossier = buildDossier(outDir, GATE_CAPS);
writeFileSync(join(outDir, 'dossier.json'), dossier);
console.log(`dossier.json written (${dossier.length} bytes)`);
