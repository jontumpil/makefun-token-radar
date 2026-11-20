// Token Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks every pre-token protocol the snapshot carries (the watchlist is the floor, not
// the ceiling), and it prices each one with a multiple the snapshot itself supplies:
//
//   Calibrate.  For every protocol whose token already trades, the snapshot records both a market
//   cap and a TVL, so it records what the market pays per dollar of TVL. Group those live ratios
//   by category and take each category's median: that median is the multiple a pre-token protocol
//   of the same kind is priced with. A category with few live samples is shrunk toward the global
//   median (a prior worth PRIOR_STRENGTH samples), so a thin category cannot produce a wild price,
//   and every multiple is clamped to [MULTIPLE_FLOOR, MULTIPLE_CAP].
//
//   Price.      implied = tvl_usd x category_multiple x growth_factor x maturity_factor x breadth_factor
//     growth_factor   = 1 + clamp(change_7d, -50, 100) / 100 x 0.4     (a hot week is not a re-rating)
//     maturity_factor = 0.72 + 0.28 x min(age_days, 1460) / 1460       (time run with no token, saturating)
//     breadth_factor  = 1 + 0.015 x min(chains - 1, 10)                (more chains, more surface)
//   An unknown age uses the snapshot's own median age; an unreported change_7d counts as 0.
//
// No protocol's name is ever special-cased: the same functions price every row, and the dashboard
// states the calibration table the multiples came from, so a reader can check any row's price
// against the live protocols it was calibrated on. Farm plans come from dashboard/farm.js, the one
// generator the program and the page share.

import '../dashboard/farm.js';

/** The farm-plan generator the dashboard ships, loaded above onto globalThis. */
interface FarmApi {
  farmStepsFor(p: { name: string; category: string | null; chains: string[]; tvl_usd: number }, ageDays: number | null): { text: string; cost: string; time: string }[];
  stepText(step: { text: string; cost: string; time: string }): string;
  planSummary(p: { name: string; category: string | null; chains: string[]; tvl_usd: number }, ageDays: number | null): { capital_usd: number; weeks: number; est_gas_usd: number; archetype: string };
}
const FARM = (globalThis as { TokenRadarFarm?: FarmApi }).TokenRadarFarm;
if (FARM === undefined) throw new Error('dashboard/farm.js did not load: TokenRadarFarm is missing');

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's method view. */
export const MODEL = {
  prior_strength: 6,
  median_clamp_lo: 0.02,
  median_clamp_hi: 2.0,
  multiple_floor: 0.05,
  multiple_cap: 1.5,
  growth_weight: 0.4,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  maturity_floor: 0.72,
  maturity_range: 0.28,
  maturity_days: 1460,
  breadth_per_chain: 0.015,
  breadth_max_extra: 10,
  fallback_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2 (snapshot-calibrated)';

/** How many live-token protocols the dashboard's "already trading" view carries, by market cap. */
export const LIVE_ROWS = 40;

const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, or null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist rule names as products of another protocol, or as exchanges. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word in the name that marks a wrapped or staked product of a token that already trades. */
const PRODUCT_WORDS = /\b(wrapped|staked|staking)\b/i;

/** A name that begins with an exchange's name: the exchange's product, not a launch candidate. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether the board may rank a protocol as a launch candidate. The board applies the watchlist's
 * own product exclusions at every size and drops only its $50M floor: a candidate records no
 * token, is not a wrapped, staked or bridged product of one that trades (WBTC, Binance staked ETH
 * and USDT0 are the snapshot's own examples), is not an exchange or its product, and is not a
 * versioned pool of another protocol. One watchlist test cannot be applied here: DefiLlama's
 * parent-protocol record is not one of the snapshot's ten fields, so a product whose parent is
 * recorded only there can still appear; the list the house produced is ranked whole regardless.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !PRODUCT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !PRODUCT_WORDS.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** One category's calibration: the live evidence behind the multiple its pre-token rows are priced with. */
export interface CategoryCalibration {
  category: string;
  live_samples: number;
  median_ratio: number | null;
  multiple: number;
}

/** Everything the snapshot teaches the model before it prices a single row. */
export interface Calibration {
  global_samples: number;
  global_median_ratio: number;
  median_age_days: number;
  categories: CategoryCalibration[];
  byCategory: Map<string, CategoryCalibration>;
}

/**
 * The calibration pass: read every live protocol's market-cap-per-TVL ratio, take medians by
 * category, shrink thin categories toward the global median, clamp, and record the snapshot's
 * median protocol age for the rows whose listing date is unknown.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const globalMedian = median(live.map((p) => p.mcap_usd! / p.tvl_usd)) ?? 0.25;
  const ratiosByCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '(uncategorised)';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    ratiosByCategory.set(key, list);
  }
  const categories: CategoryCalibration[] = [...ratiosByCategory.entries()]
    .map(([category, ratios]) => {
      const med = median(ratios)!;
      const n = ratios.length;
      // A category's own median is winsorised to a sane band before it is shrunk, so one extreme
      // live protocol (a thin market's 9x print) cannot price a whole category on its own.
      const shrunk = (n * clamp(med, MODEL.median_clamp_lo, MODEL.median_clamp_hi) + MODEL.prior_strength * globalMedian) / (n + MODEL.prior_strength);
      return { category, live_samples: n, median_ratio: round4(med), multiple: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)) };
    })
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const byCategory = new Map(categories.map((c) => [c.category, c]));
  const ages = snapshot.protocols.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  return {
    global_samples: live.length,
    global_median_ratio: round4(globalMedian),
    median_age_days: Math.round(median(ages) ?? MODEL.fallback_age_days),
    categories,
    byCategory,
  };
}

/** The multiple a protocol is priced with: its category's calibration, or the global median shrunk to itself. */
function multipleFor(p: SnapshotProtocol, calib: Calibration): CategoryCalibration {
  return (
    calib.byCategory.get(p.category ?? '(uncategorised)') ?? {
      category: p.category ?? '(uncategorised)',
      live_samples: 0,
      median_ratio: null,
      multiple: round4(clamp(calib.global_median_ratio, MODEL.multiple_floor, MODEL.multiple_cap)),
    }
  );
}

/** The four factors and the implied value one protocol gets. */
export interface Priced {
  implied: number;
  multiple: number;
  multiple_samples: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age: number | null;
}

export function impliedValue(p: SnapshotProtocol, snapshot: Snapshot, calib: Calibration): Priced {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const cal = multipleFor(p, calib);
  const growthPct = clamp(p.change_7d ?? 0, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? calib.median_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const breadthMult = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra);
  const implied = Math.max(1, Math.round(p.tvl_usd * cal.multiple * growthMult * maturityMult * breadthMult));
  return {
    implied,
    multiple: cal.multiple,
    multiple_samples: cal.live_samples,
    growth_pct: growthPct,
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    breadth_multiplier: round4(breadthMult),
    age,
  };
}

/** One row of board.json: the ranked board's row, its price's workings, and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    multiple_live_samples: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm: { archetype: string; capital_usd: number; weeks: number; est_gas_usd: number };
  farm_steps: string[];
}

/** The protocols the board ranks, strongest first, with ranks 1..n, and each row's structured farm steps. */
export function buildBoard(snapshot: Snapshot, calib: Calibration): { board: BoardRow[]; stepsBySlug: Map<string, { text: string; cost: string; time: string }[]> } {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug is ranked, whatever the rankability rule says.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The radar proper: every other rankable pre-token protocol, at any TVL the snapshot carries.
  for (const p of snapshot.protocols) if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);

  const watch = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, priced: impliedValue(p, snapshot, calib) }));
  scored.sort((a, b) => b.priced.implied - a.priced.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const stepsBySlug = new Map<string, { text: string; cost: string; time: string }[]>();
  const board = scored.map((s, i) => {
    const steps = FARM.farmStepsFor(s.p, s.priced.age);
    stepsBySlug.set(s.p.slug, steps);
    const summary = FARM.planSummary(s.p, s.priced.age);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      watchlist: watch.has(s.p.slug),
      age_days: s.priced.age,
      implied_value_usd: s.priced.implied,
      model: {
        category_multiple: s.priced.multiple,
        multiple_live_samples: s.priced.multiple_samples,
        growth_pct: s.priced.growth_pct,
        growth_multiplier: s.priced.growth_multiplier,
        maturity_multiplier: s.priced.maturity_multiplier,
        breadth_multiplier: s.priced.breadth_multiplier,
        age_days: s.priced.age,
      },
      farm: summary,
      farm_steps: steps.map(FARM.stepText),
    };
  });
  return { board, stepsBySlug };
}

/** A live-token protocol for the dashboard's "already trading" view: the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_per_tvl: number | null;
}

/** The live-token protocols, by market cap: the calibration set, and the board's control group. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_per_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** The dashboard's compact view of one board row, farm plan included as structured steps. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  multiple: number;
  multiple_samples: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm: {
    archetype: string;
    capital_usd: number;
    weeks: number;
    est_gas_usd: number;
    steps: { text: string; cost: string; time: string }[];
  };
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  calibration: {
    global_samples: number;
    global_median_ratio: number;
    median_age_days: number;
    categories: CategoryCalibration[];
  };
  stats: {
    protocols: number;
    pre_token: number;
    token_live: number;
    products_set_aside: number;
    watchlist_size: number;
    board_size: number;
    live_size: number;
    total_implied_usd: number;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Everything the dashboard needs, and the board it renders from. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const calib = calibrate(snapshot);
  const { board, stepsBySlug } = buildBoard(snapshot, calib);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    calibration: {
      global_samples: calib.global_samples,
      global_median_ratio: calib.global_median_ratio,
      median_age_days: calib.median_age_days,
      categories: calib.categories,
    },
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      token_live: snapshot.protocols.filter((p) => !isPreToken(p)).length,
      products_set_aside: snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length,
      watchlist_size: snapshot.watchlist.length,
      board_size: board.length,
      live_size: live.length,
      total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    },
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      listed_at: row.listed_at,
      age_days: row.age_days,
      watchlist: row.watchlist,
      implied_value_usd: row.implied_value_usd,
      multiple: row.model.category_multiple,
      multiple_samples: row.model.multiple_live_samples,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      breadth_multiplier: row.model.breadth_multiplier,
      farm: { ...row.farm, steps: stepsBySlug.get(row.slug)! },
    })),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
