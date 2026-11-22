// Token Radar model: fits log10(market cap) on log-features of already-traded
// protocols, then prices pre-token protocols with the same equation plus a
// shrunken per-category offset. Pure Node standard library, deterministic:
// every ordering below is either snapshot order or an explicit slug tiebreak.

import { createHash } from "node:crypto";

export interface Proto {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number | null;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface EvalMetrics {
  n: number;
  medianRatio: number;
  medianAbsLog10: number;
  typicalMultiple: number;
  within2x: number;
}

export interface Fitted {
  weights: number[];
  offsets: Record<string, number>;
  growth: boolean;
}

export interface Ctx {
  asOf: string;
  medAge: number;
  medChg: number;
  bigcats: Set<string>;
}

const DAY_MS = 86400000;

function utcDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function ageDays(p: Proto, asOf: string): number | null {
  if (p.listed_at === null) return null;
  return Math.round((utcDay(asOf) - utcDay(p.listed_at)) / DAY_MS);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function trainingPool(snap: Snapshot): Proto[] {
  return snap.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd !== null && p.tvl_usd > 0,
  );
}

export function buildCtx(snap: Snapshot, train: Proto[]): Ctx {
  const ages: number[] = [];
  const chgs: number[] = [];
  for (const p of train) {
    const a = ageDays(p, snap.as_of);
    if (a !== null) ages.push(a);
    if (p.change_7d !== null) chgs.push(p.change_7d);
  }
  const counts = new Map<string, number>();
  for (const p of train) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const bigcats = new Set<string>();
  for (const [c, n] of counts) if (n >= 6) bigcats.add(c);
  return { asOf: snap.as_of, medAge: median(ages), medChg: median(chgs), bigcats };
}

function clip(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function feats(p: Proto, ctx: Ctx, growth: boolean): number[] {
  const age = ageDays(p, ctx.asOf);
  const ageImp = age === null ? ctx.medAge : age;
  const base = [
    1,
    Math.log10(p.tvl_usd as number),
    Math.log10(Math.max(ageImp, 1)),
    Math.log10(p.chains.length),
  ];
  if (!growth) return base;
  const g = clip(p.change_7d === null ? ctx.medChg : p.change_7d, -60, 120);
  return [base[0], base[1], g, base[2], base[3]];
}

// Solve (X'X + 1e-8 I) w = X'y by Gaussian elimination with partial pivoting.
export function ols(X: number[][], y: number[]): number[] {
  const k = X[0].length;
  const a: number[][] = [];
  for (let i = 0; i < k; i++) {
    a.push(new Array(k + 1).fill(0));
    a[i][i] += 1e-8;
  }
  for (let r = 0; r < X.length; r++) {
    const row = X[r];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) a[i][j] += row[i] * row[j];
      a[i][k] += row[i] * y[r];
    }
  }
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (piv !== col) {
      const tmp = a[piv];
      a[piv] = a[col];
      a[col] = tmp;
    }
    if (Math.abs(a[col][col]) < 1e-12) a[col][col] = 1e-12;
    const pv = a[col][col];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col] / pv;
      if (f === 0) continue;
      for (let j = col; j <= k; j++) a[r][j] -= f * a[col][j];
    }
  }
  const w = new Array(k).fill(0);
  for (let i = 0; i < k; i++) w[i] = a[i][k] / a[i][i];
  return w;
}

export function fit(train: Proto[], ctx: Ctx, growth: boolean): Fitted {
  const X = train.map((p) => feats(p, ctx, growth));
  const y = train.map((p) => Math.log10(p.mcap_usd as number));
  const w1 = ols(X, y);
  const residByCat = new Map<string, number[]>();
  train.forEach((p, i) => {
    let pred = 0;
    for (let j = 0; j < w1.length; j++) pred += w1[j] * X[i][j];
    const arr = residByCat.get(p.category) ?? [];
    arr.push(y[i] - pred);
    residByCat.set(p.category, arr);
  });
  const offsets: Record<string, number> = {};
  for (const c of [...residByCat.keys()].sort()) {
    if (!ctx.bigcats.has(c)) continue;
    const rs = residByCat.get(c) as number[];
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    offsets[c] = mean * (rs.length / (rs.length + 4));
  }
  const y2 = train.map((p, i) => y[i] - (offsets[p.category] ?? 0));
  const weights = ols(X, y2);
  return { weights, offsets, growth };
}

export function predict(p: Proto, model: Fitted, ctx: Ctx): number {
  const f = feats(p, ctx, model.growth);
  let s = model.offsets[p.category] ?? 0;
  for (let j = 0; j < model.weights.length; j++) s += model.weights[j] * f[j];
  return Math.pow(10, s);
}

export function foldOf(slug: string): number {
  const hex = createHash("md5").update(slug, "utf8").digest("hex");
  let acc = 0;
  for (const ch of hex) acc = (acc * 16 + parseInt(ch, 16)) % 5;
  return acc;
}

function metrics(pairs: { pred: number; actual: number }[]): EvalMetrics {
  const ratios = pairs.map((x) => x.pred / x.actual);
  const absLogs = ratios.map((r) => Math.abs(Math.log10(r)));
  const medAbs = median(absLogs);
  const inside = ratios.filter((r) => r >= 0.5 && r <= 2).length;
  return {
    n: pairs.length,
    medianRatio: median(ratios),
    medianAbsLog10: medAbs,
    typicalMultiple: Math.pow(10, medAbs),
    within2x: pairs.length === 0 ? 0 : inside / pairs.length,
  };
}

function evaluate(model: Fitted, test: Proto[], ctx: Ctx): EvalMetrics {
  return metrics(
    test.map((p) => ({ pred: predict(p, model, ctx), actual: p.mcap_usd as number })),
  );
}

export interface Validation {
  chosen: { heldoutA: EvalMetrics; heldoutB: EvalMetrics; walkForward: EvalMetrics; loo: EvalMetrics };
  growthVariant: { heldoutA: EvalMetrics; heldoutB: EvalMetrics };
}

export function runValidation(train: Proto[], ctx: Ctx): Validation {
  const testA = train.filter((p) => foldOf(p.slug) === 0);
  const trainA = train.filter((p) => foldOf(p.slug) !== 0);
  const testB = train.filter((p) => foldOf(p.slug) === 2);
  const trainB = train.filter((p) => foldOf(p.slug) !== 2);
  const heldoutA = evaluate(fit(trainA, ctx, false), testA, ctx);
  const heldoutB = evaluate(fit(trainB, ctx, false), testB, ctx);
  const dated = train
    .filter((p) => p.listed_at !== null)
    .sort((a, b) =>
      a.listed_at === b.listed_at
        ? a.slug < b.slug
          ? -1
          : 1
        : (a.listed_at as string) < (b.listed_at as string)
          ? -1
          : 1,
    );
  const cut = Math.floor(dated.length * 0.7);
  const walkForward = evaluate(fit(dated.slice(0, cut), ctx, false), dated.slice(cut), ctx);
  const looPairs: { pred: number; actual: number }[] = [];
  for (let i = 0; i < train.length; i++) {
    const rest = train.filter((_, j) => j !== i);
    looPairs.push({ pred: predict(train[i], fit(rest, ctx, false), ctx), actual: train[i].mcap_usd as number });
  }
  const growthA = evaluate(fit(trainA, ctx, true), testA, ctx);
  const growthB = evaluate(fit(trainB, ctx, true), testB, ctx);
  return {
    chosen: { heldoutA, heldoutB, walkForward, loo: metrics(looPairs) },
    growthVariant: { heldoutA: growthA, heldoutB: growthB },
  };
}

export interface PeerRec {
  traded: number;
  total: number;
  share: number;
}

export function peerTable(snap: Snapshot): { byCat: Map<string, { traded: number; total: number }>; global: { traded: number; total: number } } {
  const byCat = new Map<string, { traded: number; total: number }>();
  let gTraded = 0;
  for (const p of snap.protocols) {
    const traded = p.gecko_id !== null || p.symbol !== null;
    if (traded) gTraded++;
    const rec = byCat.get(p.category) ?? { traded: 0, total: 0 };
    rec.total++;
    if (traded) rec.traded++;
    byCat.set(p.category, rec);
  }
  return { byCat, global: { traded: gTraded, total: snap.protocols.length } };
}

export function peerFor(
  category: string,
  table: { byCat: Map<string, { traded: number; total: number }>; global: { traded: number; total: number } },
): PeerRec {
  const rec = table.byCat.get(category);
  const use = rec !== undefined && rec.total >= 8 ? rec : table.global;
  return { traded: use.traded, total: use.total, share: use.traded / use.total };
}

const EXCLUDED_CATS = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIV_WORD_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

export function asideReason(p: Proto): string | null {
  if (EXCLUDED_CATS.has(p.category)) return `excluded category: ${p.category}`;
  if (VERSION_RE.test(p.name)) return "versioned product name";
  if (DERIV_WORD_RE.test(p.name)) return "wrapped or staked derivative name";
  for (const pre of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(pre)) return "exchange-branded product";
  }
  return null;
}

export function isEligible(p: Proto): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  return asideReason(p) === null;
}

export interface Costs {
  setup: number;
  monthly: number;
  weeks: number;
  capital: number;
  total: number;
}

const ARCHETYPES: Record<string, { setup: number; monthly: number; weeks: number; capital: number }> = {
  Dexs: { setup: 40, monthly: 25, weeks: 6, capital: 500 },
  Lending: { setup: 35, monthly: 15, weeks: 8, capital: 1000 },
  Yield: { setup: 25, monthly: 10, weeks: 8, capital: 500 },
  Derivatives: { setup: 50, monthly: 60, weeks: 6, capital: 1000 },
  "Risk Curators": { setup: 30, monthly: 12, weeks: 8, capital: 750 },
  "Onchain Capital Allocator": { setup: 30, monthly: 12, weeks: 8, capital: 750 },
  CDP: { setup: 35, monthly: 15, weeks: 8, capital: 1000 },
  "Basis Trading": { setup: 45, monthly: 40, weeks: 6, capital: 1500 },
};
const DEFAULT_ARCH = { setup: 20, monthly: 10, weeks: 6, capital: 250 };

export function costsFor(p: Proto): Costs {
  const a = ARCHETYPES[p.category] ?? DEFAULT_ARCH;
  const setup = a.setup + 8 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  const months = Math.ceil(a.weeks / 4);
  return { setup, monthly: a.monthly, weeks: a.weeks, capital: a.capital, total: setup + a.monthly * months };
}

const ACTIVITY: Record<string, string> = {
  Dexs: "swap between the main pairs and add two-sided liquidity",
  Lending: "supply collateral and run a conservative borrow loop",
  Yield: "deposit into the flagship vaults and compound the yield",
  Derivatives: "trade the main perpetual markets with small, hedged size",
  "Risk Curators": "allocate into the curated vaults and track curator risk scores",
  "Onchain Capital Allocator": "allocate into the managed strategies and follow the allocation reports",
  CDP: "open a collateral position and mint against it within safe ratios",
  "Basis Trading": "run delta-neutral basis positions across spot and perpetuals",
};

export function fmtUsd(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return (n < 0 ? "-$" : "$") + out;
}

export function verdictFor(implied: number, peerShare: number): string {
  if (implied >= 25000000 && peerShare >= 0.4) return "FARM FIRST";
  if (implied >= 15000000) return "FARM";
  if (implied >= 6000000) return "WATCH";
  return "SKIP";
}

export function farmSteps(p: Proto, peer: PeerRec, implied: number, verdict: string, costs: Costs): string[] {
  const main = p.chains[0] ?? "its main chain";
  const act = ACTIVITY[p.category] ?? "use the core protocol flows end to end";
  const tvl = fmtUsd(p.tvl_usd ?? 0);
  const chg = p.change_7d === null ? "no 7d change reading" : `a 7d change of ${p.change_7d.toFixed(1)}%`;
  const months = Math.ceil(costs.weeks / 4);
  return [
    `Prepare a dedicated wallet and bridge funds to ${main}, the main chain of ${p.name} (${p.chains.length} chain${p.chains.length === 1 ? "" : "s"} total, TVL ${tvl}). Budget the one-off setup cost of ${fmtUsd(costs.setup)} and allow 2 days for bridging, approvals and test transactions.`,
    `Start the core activity on ${p.name}: ${act}, with ${fmtUsd(costs.capital)} of working capital on ${main}. With TVL at ${tvl} and ${chg}, keep size small and reversible; allow the first 7 days to learn fees, slippage and the points rules.`,
    `Repeat the activity on a fixed weekly rhythm for ${costs.weeks} weeks (about ${months} months). The recurring budget is ${fmtUsd(costs.monthly)} per month, ${fmtUsd(costs.monthly * months)} of running costs on top of setup, and steady consistency is what most points systems reward.`,
    `Expand to a second chain where ${p.name} is live, or into its governance and points layer, and log progress weekly. The peer record for ${p.category} is ${peer.traded} of ${peer.total} protocols already trading, which frames the launch odds; setup takes about 1 week and stays inside the ${fmtUsd(costs.monthly)} monthly budget.`,
    `Watch for launch signals from ${p.name} (snapshot announcements, claim pages, exchange listings) against an implied value of ${fmtUsd(implied)} and a ${verdict} verdict. Keep records of every step so a claim can be filed within days; monitoring costs $0 extra and runs until launch.`,
  ];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string;
  chains: string[];
  tvl_usd: number | null;
  change_7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  peer: PeerRec;
  terms: { intercept: number; tvlTerm: number; ageTerm: number; chainsTerm: number; catOffset: number };
  implied_value_usd: number;
  verdict: string;
  costs: Costs;
  farm_steps: string[];
}

export interface Board {
  as_of: string;
  floor_usd: number;
  counts: {
    scanned: number;
    traded: number;
    preToken: number;
    boardRows: number;
    setAside: number;
    watchlist: number;
    watchlistCovered: number;
  };
  model: {
    trainedOn: number;
    weights: number[];
    offsets: Record<string, number>;
    medAge: number;
    medChg: number;
    validation: Validation;
  };
  rows: BoardRow[];
  live: { slug: string; name: string; category: string; tvl_usd: number | null; mcap_usd: number | null }[];
  setAside: { slug: string; name: string; reason: string }[];
}

export function buildBoard(snap: Snapshot): Board {
  const train = trainingPool(snap);
  const ctx = buildCtx(snap, train);
  const model = fit(train, ctx, false);
  const validation = runValidation(train, ctx);
  const table = peerTable(snap);
  const watch = new Set(snap.watchlist);
  const rows: BoardRow[] = [];
  for (const p of snap.protocols) {
    if (!isEligible(p)) continue;
    const peer = peerFor(p.category, table);
    const implied = Math.max(1, Math.round(predict(p, model, ctx)));
    const verdict = verdictFor(implied, peer.share);
    const costs = costsFor(p);
    const age = ageDays(p, snap.as_of);
    const ageImp = age === null ? ctx.medAge : age;
    const f = feats(p, ctx, false);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      ageDays: age,
      watchlist: watch.has(p.slug),
      peer,
      terms: {
        intercept: model.weights[0],
        tvlTerm: model.weights[1] * f[1],
        ageTerm: model.weights[2] * f[2],
        chainsTerm: model.weights[3] * f[3],
        catOffset: model.offsets[p.category] ?? 0,
      },
      implied_value_usd: implied,
      verdict,
      costs,
      farm_steps: farmSteps(p, peer, implied, verdict, costs),
    });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  const live = snap.protocols
    .filter((p) => p.gecko_id !== null || p.symbol !== null)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const setAside = snap.protocols
    .filter((p) => p.gecko_id === null && p.symbol === null && !isEligible(p))
    .map((p) => ({ slug: p.slug, name: p.name, reason: asideReason(p) as string }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const covered = rows.filter((r) => r.watchlist).length;
  return {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    counts: {
      scanned: snap.protocols.length,
      traded: live.length,
      preToken: snap.protocols.length - live.length,
      boardRows: rows.length,
      setAside: setAside.length,
      watchlist: snap.watchlist.length,
      watchlistCovered: covered,
    },
    model: {
      trainedOn: train.length,
      weights: model.weights,
      offsets: model.offsets,
      medAge: ctx.medAge,
      medChg: ctx.medChg,
      validation,
    },
    rows,
    live,
    setAside,
  };
}

