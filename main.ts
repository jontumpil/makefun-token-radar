// Token Radar: a token launch radar entry for make.fun's token-radar-01 (Node 22, standard
// library only).
//
// The program reads the sealed snapshot at /input/snapshot.json, prices every pre-token protocol
// with the snapshot-calibrated model in lib/model.ts, and writes:
//   /output/board.json    the ranked board: implied values and a farm plan per protocol
//   /output/data.js       the dashboard's dataset, written beside the page it renders
//   /output/dashboard/    a copy of this repository's dashboard/ (a static page, no network)
//   /output/screenshots/  a copy of this repository's screenshots/
//   /output/dossier.json  the judge's dossier, written last with the vendored buildDossier, byte
//                         for byte what the scorer rebuilds from the same /output
//
// Farm plans come from dashboard/farm.js, the generator the page also loads, so the plan in
// board.json and the plan on the page are one function's output. Outside the grader's container,
// MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the dossier's bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> (or --name=<value>) out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'board.json'),
  `${JSON.stringify({ model_version: radar.model_version, as_of: snapshot.as_of, validation: radar.validation, coverage: radar.coverage, rows: board })}\n`,
);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into `to`, recursively, skipping names that start with a dot. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (statSync(path).isDirectory()) {
      for (const inner of copyTree(path, join(to, name))) copied.push(`${name}/${inner}`);
    } else if (statSync(path).isFile()) {
      copyFileSync(path, join(to, name));
      copied.push(name);
    }
  }
  return copied;
}

const dashFiles = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

const holdoutText = radar.validation.holdouts.map((h) => `${h.split} n=${h.n} median APE ${h.median_ape_pct}%`).join(', ');
const asideText = radar.coverage.reasons.map((r) => `${r.count} ${r.key}`).join(', ');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols (${radar.stats.pre_token} pre-token, ${radar.stats.token_live} already trading), ` +
    `${board.length} rows ranked, watchlist ${radar.stats.watchlist_size}/${radar.stats.watchlist_size} covered, ` +
    `calibrated on ${radar.calibration.global_samples} live ratios (global median ${radar.calibration.global_median_ratio} x TVL)\n` +
    `token radar: held-out validation (fit on ${radar.validation.fit_live} live alone): ${holdoutText}; ` +
    `coverage ${radar.coverage.scored} scored + ${radar.coverage.total - radar.coverage.scored} set aside (${asideText}) = ${radar.coverage.total}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ` +
    `${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
