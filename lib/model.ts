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
//
// Three proofs ride along with the board, all computed from the same snapshot:
//   Validate.   The fitting procedure is refit on one half of the snapshot alone (a slug-hash
//               split) and priced against two disjoint held-out sets of live protocols — the only
//               protocols whose true value is known — so the dashboard can state the model's
//               out-of-sample error next to the model itself (validateModel).
//   Account.    Every one of the snapshot's protocols is either a board row or set aside for one
//               stated reason, counted on the dashboard: nothing is dropped silently
//               (accountFor).
//   Verdict.    Each row carries a farm / thin / skip verdict whose reasoning is costed: the
//               plan's gas plus its capital carried by the week, set against the row's implied
//               value and the evidence behind its multiple (verdictFor).

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
  // The verdict's cost model: capital locked in a farm plan is carried at this rate per week
  // (about 10% a year), on top of the plan's gas, to give the plan's all-in cost.
  capital_week_rate: 0.002,
  // The verdict's bars, stated on the dashboard: a farm needs real implied value, a multiple
  // backed by at least this many live peers, and a week that is not collapsing.
  verdict_farm_min_usd: 2_500_000,
  verdict_farm_min_samples: 3,
  verdict_skip_below_usd: 1_000_000,
  verdict_falling_pct: -25,
  // A row with no live peer behind its multiple and a week this weak has neither evidence nor
  // momentum: it is a skip at any size.
  verdict_evidence_fall_pct: -10,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3 (held-out validated)';

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
 * median protocol age for the rows whose listing date is unknown. `restrict`, when given, limits
 * both the ratios and the ages to the protocols it accepts: the held-out validation fits the
 * identical procedure on its fit split alone, so nothing about a held-out protocol — not its
 * ratio, not its age — can reach the multiples it is then priced with.
 */
export function calibrate(snapshot: Snapshot, restrict?: (p: SnapshotProtocol) => boolean): Calibration {
  const pool = restrict === undefined ? snapshot.protocols : snapshot.protocols.filter(restrict);
  const live = pool.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
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
  const ages = pool.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
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
  // Every factor is rounded to 4 places before it prices the row, so the dashboard can recompute
  // a row's implied value from the factors it prints and land on the board's number exactly.
  const growthMult = round4(1 + (growthPct / 100) * MODEL.growth_weight);
  const ageForModel = age ?? calib.median_age_days;
  const maturityMult = round4(MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range);
  const breadthMult = round4(1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra));
  const implied = Math.max(1, Math.round(p.tvl_usd * cal.multiple * growthMult * maturityMult * breadthMult));
  return {
    implied,
    multiple: cal.multiple,
    multiple_samples: cal.live_samples,
    growth_pct: growthPct,
    growth_multiplier: growthMult,
    maturity_multiplier: maturityMult,
    breadth_multiplier: breadthMult,
    age,
  };
}

/** A stable 32-bit FNV-1a hash of a slug: the same slug lands in the same split on every run. */
function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The validation split: a protocol's bucket is its slug hash mod 4. Buckets 0 and 1 are the fit
 * split; bucket 2 is held-out A and bucket 3 is held-out B — two disjoint held-out sets, neither
 * of which the fit ever sees, assigned by the slug alone so the split is the same for every run
 * and every reader.
 */
export function splitBucket(slug: string): number {
  return slugHash(slug) % 4;
}

/** Whether a protocol can teach or test the model: a live token with both a market cap and a TVL. */
function isCalibratable(p: SnapshotProtocol): boolean {
  return !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/** One held-out set's score: how far the fit-split model's prices land from the market caps it never saw. */
export interface HoldoutScore {
  split: string;
  bucket: number;
  n: number;
  median_ape_pct: number;
  mean_ape_pct: number;
  median_pred_ratio: number;
  /** The share of the set priced within a factor of three of its market cap, either way. */
  within_3x_pct: number;
}

/** The held-out validation's whole report, rendered on the dashboard beside the model. */
export interface Validation {
  method: string;
  fit_protocols: number;
  fit_live: number;
  fit_global_median_ratio: number;
  holdouts: HoldoutScore[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The held-out validation. Only live-token protocols can be tested: their market cap is a fact,
 * where a pre-token protocol's value is the model's own claim. The fitting procedure — category
 * medians, shrinkage, clamps, the median age — is refit on the fit split alone and then prices
 * each held-out protocol with the full pricing formula; the error is against the market cap the
 * fit never saw. The board itself is priced by the same procedure refit on every live protocol:
 * the validation measures the procedure, twice, on two disjoint sets.
 */
export function validateModel(snapshot: Snapshot): Validation {
  const inFit = (p: SnapshotProtocol): boolean => splitBucket(p.slug) < 2;
  const fitCalib = calibrate(snapshot, inFit);
  const holdouts: HoldoutScore[] = [2, 3].map((bucket) => {
    const rows = snapshot.protocols.filter((p) => splitBucket(p.slug) === bucket && isCalibratable(p));
    const apes: number[] = [];
    const ratios: number[] = [];
    for (const p of rows) {
      const predicted = impliedValue(p, snapshot, fitCalib).implied;
      apes.push(Math.abs(predicted - p.mcap_usd!) / p.mcap_usd!);
      ratios.push(predicted / p.mcap_usd!);
    }
    return {
      split: bucket === 2 ? 'A' : 'B',
      bucket,
      n: rows.length,
      median_ape_pct: round1((median(apes) ?? 0) * 100),
      mean_ape_pct: round1((apes.reduce((a, b) => a + b, 0) / Math.max(1, apes.length)) * 100),
      median_pred_ratio: round2(median(ratios) ?? 0),
      within_3x_pct: round1((ratios.filter((r) => r >= 1 / 3 && r <= 3).length / Math.max(1, ratios.length)) * 100),
    };
  });
  return {
    method:
      'Every protocol is assigned to a split by its slug hash (FNV-1a mod 4): buckets 0-1 fit, bucket 2 held-out A, bucket 3 held-out B. ' +
      'Every fitted term — the category multiples, the global median, the median age — is fitted on the fit split alone, then the full pricing ' +
      'formula prices the held-out live protocols against the market caps the fit never saw. The board is priced by the same procedure refit on all live protocols.',
    fit_protocols: snapshot.protocols.filter(inFit).length,
    fit_live: snapshot.protocols.filter((p) => inFit(p) && isCalibratable(p)).length,
    fit_global_median_ratio: fitCalib.global_median_ratio,
    holdouts,
  };
}

/** One line of the coverage accounting: a reason a protocol is not on the board, and how many it takes. */
export interface CoverageReason {
  key: string;
  label: string;
  count: number;
}

/** The integrity accounting: every protocol in the snapshot, scored or set aside for a stated reason. */
export interface Coverage {
  total: number;
  scored: number;
  reasons: CoverageReason[];
}

/**
 * Why a protocol is not ranked, in the order the tests bite: it already trades; it has no usable
 * TVL; or it is a product of a token that trades, by category, by version marker, by a wrapped or
 * staked word in its name, or as an exchange's own product. Null when none of them bites — which
 * for a pre-token protocol means the board ranks it, so the accounting and the board agree.
 */
function setAsideReason(p: SnapshotProtocol): { key: string; label: string } | null {
  if (!isPreToken(p)) return { key: 'token_trades', label: 'already records a token — never ranked as a launch' };
  if (!(p.tvl_usd > 0)) return { key: 'no_tvl', label: 'records no usable TVL to price from' };
  if (PRODUCT_CATEGORIES.has(p.category ?? '')) return { key: 'product_category', label: 'a product category — bridge, liquid staking or restaking, or an exchange' };
  if (VERSIONED.test(p.name)) return { key: 'versioned_name', label: 'a versioned pool of another protocol — its name ends in a version marker' };
  if (PRODUCT_WORDS.test(p.name)) return { key: 'wrapped_word', label: 'named as a wrapped or staked product of a token that trades' };
  if (EXCHANGE_PREFIX.test(p.name)) return { key: 'exchange_prefix', label: "an exchange's own product — its name opens with the exchange's" };
  return null;
}

/** Account for every protocol the snapshot carries: the board's rows plus one reason per protocol left off. */
export function accountFor(snapshot: Snapshot, board: BoardRow[]): Coverage {
  const onBoard = new Set(board.map((r) => r.slug));
  const counts = new Map<string, CoverageReason>();
  for (const p of snapshot.protocols) {
    if (onBoard.has(p.slug)) continue;
    const reason = setAsideReason(p) ?? { key: 'other', label: 'set aside by the rankability rule' };
    const row = counts.get(reason.key) ?? { ...reason, count: 0 };
    row.count += 1;
    counts.set(reason.key, row);
  }
  const order = ['token_trades', 'no_tvl', 'product_category', 'versioned_name', 'wrapped_word', 'exchange_prefix', 'other'];
  const reasons = [...counts.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { total: snapshot.protocols.length, scored: board.length, reasons };
}

/** A whole-dollar figure for the verdict's reasoning, in the board's own compact style. */
function usdText(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** A board row's verdict: farm it, a thin case, or skip it — with the costed reasoning stated. */
export interface Verdict {
  verdict: 'farm' | 'thin' | 'skip';
  reason: string;
  all_in_cost_usd: number;
}

/**
 * The verdict, from the row's own numbers. The plan's all-in cost is its gas plus its capital
 * carried at MODEL.capital_week_rate a week. A farm needs implied value at or above
 * MODEL.verdict_farm_min_usd, a multiple backed by at least MODEL.verdict_farm_min_samples live
 * peers, and a week no worse than MODEL.verdict_falling_pct. A row is a skip when its implied
 * value is under MODEL.verdict_skip_below_usd, or when it has neither evidence nor momentum (no
 * live peer prices its category and its TVL is falling). Everything else is thin, and the reason
 * names the weak leg.
 */
export function verdictFor(p: SnapshotProtocol, priced: Priced, farm: { capital_usd: number; weeks: number; est_gas_usd: number }): Verdict {
  const carry = Math.round(farm.capital_usd * farm.weeks * MODEL.capital_week_rate);
  const allIn = farm.est_gas_usd + carry;
  const cost = `the plan costs about ${usdText(allIn)} all-in (${usdText(farm.est_gas_usd)} gas + ${usdText(carry)} capital carry over ${farm.weeks} weeks)`;
  const change = p.change_7d ?? 0;
  if (priced.implied < MODEL.verdict_skip_below_usd) {
    return {
      verdict: 'skip',
      all_in_cost_usd: allIn,
      reason: `Skip: at ${usdText(priced.implied)} this is the board's tail — ${cost}, and the weeks buy a position in the smallest kind of launch the board carries. Skip it unless you already use the protocol.`,
    };
  }
  if (priced.multiple_samples === 0 && change <= MODEL.verdict_evidence_fall_pct) {
    return {
      verdict: 'skip',
      all_in_cost_usd: allIn,
      reason: `Skip: no live peer prices its category, so its multiple is the global median alone, and its TVL fell ${Math.abs(round1(change))}% this week — the model has neither evidence nor momentum here, while ${cost}.`,
    };
  }
  if (priced.implied >= MODEL.verdict_farm_min_usd && priced.multiple_samples >= MODEL.verdict_farm_min_samples && change > MODEL.verdict_falling_pct) {
    return {
      verdict: 'farm',
      all_in_cost_usd: allIn,
      reason: `Farm: ${usdText(priced.implied)} of implied value against ${cost} — the multiple of ${priced.multiple}x rests on ${priced.multiple_samples} live peers, and the position costs a small fraction of the launch it positions for.`,
    };
  }
  const weak =
    priced.multiple_samples === 0
      ? 'its multiple is the global median alone — no live peer trades in its category, the thinnest evidence the model gives'
      : priced.multiple_samples < MODEL.verdict_farm_min_samples
        ? `its multiple rests on only ${priced.multiple_samples} live peer${priced.multiple_samples === 1 ? '' : 's'}`
        : change <= MODEL.verdict_falling_pct
          ? `its TVL fell ${Math.abs(round1(change))}% this week, so the record it would launch from is shrinking`
          : `its implied value sits in the board's middle band, below the ${usdText(MODEL.verdict_farm_min_usd)} the farm verdict asks for`;
  return {
    verdict: 'thin',
    all_in_cost_usd: allIn,
    reason: `Thin: ${usdText(priced.implied)} of implied value and ${cost}, but ${weak}. Worth it only at small size, or if you already use it.`,
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
  verdict: 'farm' | 'thin' | 'skip';
  verdict_reason: string;
  all_in_cost_usd: number;
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
    const verdict = verdictFor(s.p, s.priced, summary);
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
      verdict: verdict.verdict,
      verdict_reason: verdict.reason,
      all_in_cost_usd: verdict.all_in_cost_usd,
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
  verdict: 'farm' | 'thin' | 'skip';
  verdict_reason: string;
  all_in_cost_usd: number;
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
  validation: Validation;
  coverage: Coverage;
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
    validation: validateModel(snapshot),
    coverage: accountFor(snapshot, board),
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
      verdict: row.verdict,
      verdict_reason: row.verdict_reason,
      all_in_cost_usd: row.all_in_cost_usd,
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
