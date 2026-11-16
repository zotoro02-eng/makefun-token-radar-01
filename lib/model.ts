// Token-radar value model and board builder (Node 22, standard library only).
//
// The snapshot is a frozen DefiLlama protocol list. This module turns it into a
// ranked board of protocols that record no token, with an implied launch value
// for each one and a concrete farm plan. Nothing here names a protocol by slug:
// every number comes from the snapshot's own figures, and every farm step is
// built from the protocol's category, chains and size tier.
//
// The implied value:
//
//   implied = tvl_usd x categoryMultiple x growth x age x breadth
//
//   categoryMultiple  median market-cap / TVL of the token-bearing protocols
//                     in the same category (at least 3 peers with a market
//                     cap, otherwise the median over every token-bearing
//                     protocol), clamped to [0.05, 1.50]. A token's market cap
//                     is what the market already pays for a live protocol's
//                     TVL, so the median of the category is the honest anchor
//                     for a protocol whose token does not exist yet.
//   growth            1 + clamp(change_7d, -30, +60) / 200. A protocol growing
//                     60% in a week is worth 30% more than a flat one; one
//                     shrinking 30% is worth 15% less. Null change counts 1.
//   age               1 + 0.15 x min(years since listed_at, 4). A protocol
//                     that has run for years with no token recorded has more
//                     pent-up launch value than one listed last month.
//                     Null listed_at counts 1.
//   breadth           1 + 0.02 x min(chains, 10). More chains, more surface
//                     for a launch to reach.
//
// The board ranks the watchlist first in spirit but not by privilege: every
// pre-token protocol that is not a wrapped, staked or bridged product of a
// token that already trades competes on the same formula, watchlist or not.
// Token-bearing protocols are never ranked; they are counted and set aside.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  tvl_usd: number;
  category: string | null;
  chains: string[];
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  status: 'pre-token';
  model: { multiple: number; growth: number; age: number; breadth: number };
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  watchlist_size: number;
  rows: BoardRow[];
  summary: {
    protocols_total: number;
    pre_token_total: number;
    token_bearing_total: number;
    watchlist_total: number;
    early_total: number;
    excluded_products: number;
    global_multiple: number;
    category_multiples: Record<string, number>;
  };
  method: string;
}

/** The snapshot's own shape, checked just enough to fail loudly on bad input. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot: not an object');
  const protocols = raw.protocols as SnapshotProtocol[];
  if (!Array.isArray(protocols) || protocols.length === 0) throw new Error('snapshot: protocols missing');
  if (!Array.isArray(raw.watchlist)) throw new Error('snapshot: watchlist missing');
  for (const p of protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('snapshot: a protocol lacks slug, name or tvl_usd');
    }
  }
  return {
    as_of: String(raw.as_of),
    source: String(raw.source),
    floor_usd: Number(raw.floor_usd),
    protocols,
    watchlist: raw.watchlist as string[],
  };
}

/** A protocol records no token in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * A wrapped, staked or bridged product of a token that already trades, or a
 * versioned copy of another protocol: not a launch that does not exist yet.
 * This mirrors the house's own watchlist rule, so the "early" rows below the
 * floor are held to the same standard as the watchlist itself.
 */
export function isExcludedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  const name = p.name;
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(name)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(name)) return true;
  for (const ex of EXCHANGE_PREFIXES) if (name.startsWith(ex)) return true;
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The category multiples: for each category with at least three token-bearing
 * protocols that carry a market cap, the median of their market-cap / TVL;
 * every other category falls back to the global median. All clamped to
 * [0.05, 1.50] so one outlier peer cannot set the price.
 */
export function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const global = clamp(median(live.map((p) => p.mcap_usd! / p.tvl_usd)), 0.05, 1.5);
  const byCategory = new Map<string, number>();
  const perCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const list = perCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    perCategory.set(key, list);
  }
  for (const [cat, ratios] of perCategory) {
    if (ratios.length >= 3) byCategory.set(cat, clamp(median(ratios), 0.05, 1.5));
  }
  return { byCategory, global };
}

function ageYears(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 86400000 / 365.25;
}

/** The implied launch value of one pre-token protocol, and its four factors. */
export function impliedValue(
  p: SnapshotProtocol,
  multiples: { byCategory: Map<string, number>; global: number },
  asOf: string,
): { value: number; multiple: number; growth: number; age: number; breadth: number; years: number | null } {
  const multiple = multiples.byCategory.get(p.category ?? 'Uncategorised') ?? multiples.global;
  const growth = 1 + clamp(p.change_7d ?? 0, -30, 60) / 200;
  const years = ageYears(p.listed_at, asOf);
  const age = 1 + 0.15 * Math.min(years ?? 0, 4);
  const breadth = 1 + 0.02 * Math.min(p.chains.length, 10);
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * growth * age * breadth));
  return { value, multiple: round3(multiple), growth: round3(growth), age: round3(age), breadth: round3(breadth), years };
}

// ---------------------------------------------------------------- farm plans

/** A deposit size that fits the protocol's scale, so steps name real money. */
function depositTier(tvlUsd: number): { deposit: string; small: string } {
  if (tvlUsd >= 500_000_000) return { deposit: '$100–$250', small: '$25' };
  if (tvlUsd >= 100_000_000) return { deposit: '$50–$100', small: '$10–$25' };
  return { deposit: '$25–$50', small: '$5–$10' };
}

type StepFn = (name: string, chain: string, tier: { deposit: string; small: string }) => string[];

/** One concrete plan per category family; every step names a cost or a time. */
const PLANS: Record<string, StepFn> = {
  Dexs: (n, c, t) => [
    `Bridge ${t.deposit} of USDC to ${c} (about $1–$3 in gas) and open ${n}; swap ${t.small} of USDC for another asset, then swap half back the same day so the wallet shows two-way volume.`,
    `Add ${t.deposit} to a ${n} liquidity pool on ${c} in one transaction (roughly $2–$5 gas) and leave the position open at least 4 weeks; note the pool address and the date you entered.`,
    `Swap ${t.small} once a week for 8 weeks, changing the pair each time; budget about ${t.deposit} of volume plus roughly $20 in gas across the whole period.`,
    `If ${n} shows a points or leaderboard page, connect the same wallet every week and record the balance; a weekly screenshot makes a missed week visible.`,
    `After 8 weeks, withdraw half the liquidity and leave the rest in place; keep at least $5 of ${c} gas token in the wallet so later transactions never fail for gas.`,
  ],
  Lending: (n, c, t) => [
    `Bridge ${t.deposit} of USDC to ${c} and supply it to ${n} as collateral in one transaction (about $2–$4 gas); keep the deposit in place for at least 6 weeks.`,
    `Borrow a small amount against the deposit — no more than 30% of its value — and repay it in full within 7 days, so the wallet shows a complete borrow-and-repay cycle.`,
    `Repeat the supply-and-borrow cycle once every 2 weeks for 8 weeks, varying the borrowed asset each time; total planned gas is roughly $15–$25 over the period.`,
    `If ${n} lists a points program, connect the same wallet weekly and log the balance; use the same wallet for every step so the history stays in one place.`,
    `After 8 weeks, repay any open loan and withdraw half the supply; leave the rest supplied so the position stays live while you decide what to do next.`,
  ],
  Yield: (n, c, t) => [
    `Bridge ${t.deposit} of USDC to ${c} and deposit it into a ${n} vault in one transaction (about $2–$4 gas); pick the vault whose strategy you can describe in one sentence.`,
    `Leave the deposit compounding for at least 6 weeks and check the vault page once a week; record the balance each Sunday so growth is visible week to week.`,
    `Add a second deposit of ${t.small} in week 3 to a different ${n} vault, so the wallet shows activity across two products rather than one.`,
    `If ${n} runs a points program, connect the same wallet weekly and note the points balance; never split activity across two wallets.`,
    `After 8 weeks, withdraw the smaller vault in full and keep the larger one open; keep $5 of ${c} gas token aside for the withdrawal transaction.`,
  ],
  RWA: (n, c, t) => [
    `Bridge ${t.deposit} of USDC to ${c} and buy or mint the tokenised asset ${n} offers (one transaction, about $2–$5 gas); read the asset's terms page first and note its minimum holding period.`,
    `Hold the position for at least 8 weeks and check the issuer's page weekly for distributions or redemptions; record each payout date and amount in a note.`,
    `In week 4, add ${t.small} more to the same asset so the wallet shows a second, later entry rather than a single purchase.`,
    `If ${n} has a points or waitlist page, register the same wallet and check it weekly; keep every receipt and transaction hash in one place.`,
    `After 8 weeks, redeem or sell only half the position; keep the rest held while you watch whether the issuer announces a token or a new product.`,
  ],
  CDP: (n, c, t) => [
    `Bridge ${t.deposit} of collateral (ETH or USDC) to ${c} and open a vault on ${n} in one transaction (about $2–$5 gas); mint a stablecoin worth at most 40% of the collateral.`,
    `Hold the vault open for at least 6 weeks and check its health ratio weekly; top it up if the ratio falls under 200% so it is never at risk of liquidation.`,
    `In week 3, mint a second, smaller amount (${t.small}) from the same vault and use it in another ${c} app, so the wallet shows the minted asset being used, not parked.`,
    `If ${n} shows a points page, connect the same wallet weekly and log the balance; use one wallet for the whole plan.`,
    `After 8 weeks, repay the smaller mint in full and leave the main vault open; keep $5 of ${c} gas token aside for the repayment transaction.`,
  ],
  Chain: (n, c, t) => [
    `Bridge ${t.deposit} of USDC into ${n} (about $1–$3 in gas) and make one swap or transfer on its main app the same day, so the wallet is active from day one.`,
    `Use one ${n} app every week for 8 weeks — a swap, a transfer or a deposit — spending about ${t.small} a week; total planned spend is roughly ${t.deposit} plus $15 in gas.`,
    `In week 3, try a second app on ${n} and interact with it twice, so the wallet's history covers more than one product on the chain.`,
    `If ${n} has a points, quest or leaderboard page, connect the same wallet weekly and record the balance; screenshot it each week.`,
    `After 8 weeks, leave at least ${t.small} of value on ${n} and keep $5 of gas token in the wallet, so the address stays funded and usable.`,
  ],
  Payments: (n, c, t) => [
    `Fund a wallet with ${t.deposit} of USDC on ${c} and make a first payment through ${n} (about $1–$2 in fees); send it to a real recipient or merchant, not to yourself.`,
    `Use ${n} to pay for something real once a week for 6 weeks — a bill, a transfer or a purchase — about ${t.small} each time, and keep every receipt.`,
    `In week 3, try a second ${n} feature (a card, a recurring payment or a different currency) so the wallet shows more than one kind of use.`,
    `If ${n} runs a rewards or points page, connect the same wallet weekly and log the balance; one wallet for the whole plan.`,
    `After 6 weeks, keep the wallet funded with at least ${t.small} and keep using ${n} for one payment a week; a dormant wallet tells the story of someone who stopped.`,
  ],
  Default: (n, c, t) => [
    `Bridge ${t.deposit} of USDC to ${c} (about $1–$3 in gas) and use ${n}'s main feature once in the first week — a deposit, a swap or a position — with ${t.small}.`,
    `Repeat the same action once a week for 8 weeks, about ${t.small} each time; budget roughly ${t.deposit} in total plus about $15–$20 in gas over the period.`,
    `In week 3, try a second feature of ${n} so the wallet's history covers two products, and note the date and the transaction hash of each step.`,
    `If ${n} shows a points or leaderboard page, connect the same wallet every week and record the balance; a weekly screenshot makes a missed week visible.`,
    `After 8 weeks, unwind half the position and leave the rest in place; keep at least $5 of ${c} gas token in the wallet so later transactions never fail.`,
  ],
};

/** The plan family a category falls into. */
function planKey(category: string | null): string {
  if (category === null) return 'Default';
  if (category === 'Dexs') return 'Dexs';
  if (category === 'Lending' || category === 'Collateral Markets') return 'Lending';
  if (category === 'Yield' || category === 'Yield Aggregator' || category === 'Risk Curators' || category === 'Onchain Capital Allocator' || category === 'Basis Trading') return 'Yield';
  if (category === 'RWA') return 'RWA';
  if (category === 'CDP') return 'CDP';
  if (category === 'Chain') return 'Chain';
  if (category === 'Payments') return 'Payments';
  return 'Default';
}

/** Five concrete steps for one protocol, built from its category and size. */
export function farmSteps(p: SnapshotProtocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const tier = depositTier(p.tvl_usd);
  return PLANS[planKey(p.category)]!(p.name, chain, tier);
}

// ---------------------------------------------------------------- the board

const BOARD_ROWS = 200;

export const METHOD_TEXT =
  'implied = TVL x category multiple x growth x age x breadth. ' +
  'Category multiple: median market-cap / TVL of token-bearing protocols in the same category ' +
  '(3+ peers with a market cap, else the all-category median), clamped 0.05–1.50. ' +
  'Growth: 1 + clamp(7-day TVL change, -30%, +60%) / 200. ' +
  'Age: 1 + 0.15 x min(years since first listed, 4). ' +
  'Breadth: 1 + 0.02 x min(chains, 10).';

/** Build the ranked board: the whole watchlist plus the best early pre-token protocols. */
export function buildRadar(snapshot: Snapshot): Radar {
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));

  const preToken = snapshot.protocols.filter(isPreToken);
  const excluded = preToken.filter(isExcludedProduct).length;
  const candidates = preToken.filter((p) => watchlist.has(p.slug) || !isExcludedProduct(p));
  const early = candidates.filter((p) => !watchlist.has(p.slug));

  const scored = candidates.map((p) => {
    const v = impliedValue(p, multiples, snapshot.as_of);
    return { p, ...v };
  });
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const chosen = scored.slice(0, BOARD_ROWS);
  const rows: BoardRow[] = chosen.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: farmSteps(s.p),
    tvl_usd: s.p.tvl_usd,
    category: s.p.category,
    chains: s.p.chains,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_years: s.years === null ? null : round3(s.years),
    status: 'pre-token',
    model: { multiple: s.multiple, growth: s.growth, age: s.age, breadth: s.breadth },
  }));

  // The watchlist is the floor: every one of its protocols must appear, even
  // if the 200-row cut would drop the smallest. (With 40 on the list and a
  // 200-row board this never triggers, but the guarantee is explicit.)
  const missing = snapshot.watchlist.filter((slug) => !rows.some((r) => r.slug === slug));
  for (const slug of missing) {
    const p = bySlug.get(slug)!;
    const v = impliedValue(p, multiples, snapshot.as_of);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: rows.length + 1,
      implied_value_usd: v.value,
      farm_steps: farmSteps(p),
      tvl_usd: p.tvl_usd,
      category: p.category,
      chains: p.chains,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_years: v.years === null ? null : round3(v.years),
      status: 'pre-token',
      model: { multiple: v.multiple, growth: v.growth, age: v.age, breadth: v.breadth },
    });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const categoryMultiplesOut: Record<string, number> = {};
  for (const [k, v] of [...multiples.byCategory.entries()].sort()) categoryMultiplesOut[k] = round3(v);

  return {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    watchlist_size: snapshot.watchlist.length,
    rows,
    summary: {
      protocols_total: snapshot.protocols.length,
      pre_token_total: preToken.length,
      token_bearing_total: snapshot.protocols.length - preToken.length,
      watchlist_total: snapshot.watchlist.length,
      early_total: early.length,
      excluded_products: excluded,
      global_multiple: round3(multiples.global),
      category_multiples: categoryMultiplesOut,
    },
    method: METHOD_TEXT,
  };
}

/** The board the gate refuses, named in one line, or null when it is valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, not 100 to 4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const values = new Set<number>();
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!slugs.has(r.slug)) return `row ${i + 1} names ${r.slug}, not in the snapshot`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i + 1} has rank ${r.rank}, not ${i + 1}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) return `row ${r.slug} has a bad implied value`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `implied value rises at rank ${r.rank}`;
    values.add(r.implied_value_usd);
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} has ${r.farm_steps?.length} farm steps, not 3 to 12`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters, not 20 to 600`;
    }
  }
  if (values.size < 2) return 'every implied value is the same: not a ranking';
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug ${slug} is missing`;
  return null;
}

/** The dashboard's data file: the board and the model, as one script. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
