// Token Radar entry point: reads a snapshot, builds the board, self-checks
// it, and writes board.json, data.js, the dashboard, screenshots and a
// dossier into the output directory. Byte-identical across repeated runs.

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, type Board, type BoardRow, type Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = "/input";
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && i + 1 < argv.length) input = argv[++i];
    else if (argv[i] === "--output" && i + 1 < argv.length) output = argv[++i];
  }
  return { input, output };
}

function loadSnapshot(input: string): Snapshot {
  const path = statSync(input).isDirectory() ? join(input, "snapshot.json") : input;
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

// Self-check required by the board contract; returns the first problem found.
export function boardIssue(board: Board, snap: Snapshot): string | null {
  const rows = board.rows;
  if (rows.length < 100 || rows.length > 4000) return `row count ${rows.length} outside 100..4000`;
  const known = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (!known.has(r.slug)) return `slug ${r.slug} not in snapshot`;
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].rank !== i + 1) return `rank sequence broken at index ${i}`;
    if (i > 0 && rows[i].implied_value_usd > rows[i - 1].implied_value_usd) {
      return `implied value rises at rank ${rows[i].rank}`;
    }
  }
  for (const slug of snap.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} missing from board`;
  }
  for (const r of rows as BoardRow[]) {
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `farm_steps count off for ${r.slug}`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `farm step length ${t.length} for ${r.slug}`;
    }
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `implied value invalid for ${r.slug}`;
    }
  }
  if (rows.length > 0 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) {
    return "all implied values are identical";
  }
  return null;
}

function fmtMetric(label: string, m: { n: number; medianRatio: number; medianAbsLog10: number; typicalMultiple: number; within2x: number }): string {
  return (
    `  ${label}: n=${m.n} median pred/actual=${m.medianRatio.toFixed(3)} ` +
    `median |log10 err|=${m.medianAbsLog10.toFixed(3)} typical multiple=${m.typicalMultiple.toFixed(2)}x ` +
    `within [0.5, 2]=${(m.within2x * 100).toFixed(1)}%`
  );
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap = loadSnapshot(input);
  const board = buildBoard(snap);
  const issue = boardIssue(board, snap);
  if (issue !== null) {
    console.error(`board self-check failed: ${issue}`);
    process.exit(1);
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "board.json"), JSON.stringify({ rows: board.rows }, null, 2) + "\n");
  writeFileSync(join(output, "data.js"), `window.RADAR = ${JSON.stringify(board, null, 2)};\n`);
  const root = dirname(fileURLToPath(import.meta.url));
  for (const dir of ["dashboard", "screenshots"]) {
    const src = join(root, dir);
    if (existsSync(src)) cpSync(src, join(output, dir), { recursive: true });
  }
  const dossier = buildDossier(output, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(output, "dossier.json"), dossier);

  const c = board.counts;
  const v = board.model.validation;
  const verdicts = new Map<string, number>();
  for (const r of board.rows) verdicts.set(r.verdict, (verdicts.get(r.verdict) ?? 0) + 1);
  const impliedSorted = board.rows.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const mid = Math.floor(impliedSorted.length / 2);
  const medImplied =
    impliedSorted.length % 2 === 1
      ? impliedSorted[mid]
      : Math.round((impliedSorted[mid - 1] + impliedSorted[mid]) / 2);
  console.log("token-radar board built");
  console.log(`as_of=${board.as_of} floor_usd=${board.floor_usd}`);
  console.log(
    `scanned=${c.scanned} traded=${c.traded} pre-token=${c.preToken} board rows=${c.boardRows} set aside=${c.setAside}`,
  );
  console.log(`watchlist covered=${c.watchlistCovered}/${c.watchlist}`);
  console.log(`model trained on=${board.model.trainedOn} protocols`);
  console.log("validation:");
  console.log(fmtMetric("held-out A (fold 0)", v.chosen.heldoutA));
  console.log(fmtMetric("held-out B (fold 2)", v.chosen.heldoutB));
  console.log(fmtMetric("walk-forward (first 70% by listing date)", v.chosen.walkForward));
  console.log(fmtMetric("leave-one-out", v.chosen.loo));
  console.log(fmtMetric("growth variant held-out A", v.growthVariant.heldoutA));
  console.log(fmtMetric("growth variant held-out B", v.growthVariant.heldoutB));
  console.log(
    `verdicts: FARM FIRST=${verdicts.get("FARM FIRST") ?? 0} FARM=${verdicts.get("FARM") ?? 0} ` +
      `WATCH=${verdicts.get("WATCH") ?? 0} SKIP=${verdicts.get("SKIP") ?? 0}`,
  );
  console.log(`median implied=$${medImplied.toLocaleString("en-US")}`);
  console.log(`top row: #1 ${board.rows[0].slug} implied=$${board.rows[0].implied_value_usd.toLocaleString("en-US")}`);
}

main();

