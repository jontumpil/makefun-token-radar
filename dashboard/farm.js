// Token Radar's farm-plan generator: one implementation, two homes.
//
// main.ts loads this file in Node and writes each protocol's plan into board.json; the dashboard
// loads it in the browser and renders the same plan in the detail view. One function writes both,
// so the page a reader sees is the board the program handed in, never a second telling of it.
//
// A plan is derived from the protocol's own snapshot record and nothing else: its category picks
// the archetype (what a farmer actually does there), its first chain prices the gas, its TVL sizes
// the position, and its age sets the plan's length. No protocol's name is ever special-cased.
(function (root) {
  'use strict';

  // What one on-chain action costs in gas, in US dollars, on the chains the board's protocols
  // mostly live on. An exact chain-name match wins; anything unlisted is priced as a typical
  // low-fee chain or app-chain, which most of the long tail is.
  var GAS_USD = {
    'Ethereum': 9.0, 'Bitcoin': 2.5, 'Tron': 1.4, 'Solana': 0.06, 'Hyperliquid L1': 0.02,
    'Binance': 0.35, 'Stellar': 0.01, 'Ripple': 0.01, 'TON': 0.05, 'Bittensor': 0.1
  };
  var GAS_DEFAULT_USD = 0.45;

  function gasFor(chain) {
    return Object.prototype.hasOwnProperty.call(GAS_USD, chain) ? GAS_USD[chain] : GAS_DEFAULT_USD;
  }

  function money(n) {
    if (n < 1) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  // The position a plan opens, sized to the protocol's own TVL: a whale protocol's plan is not a
  // $50 plan, and a $6M protocol's plan is not a $500 one.
  function capitalFor(tvl) {
    if (tvl >= 1e9) return 500;
    if (tvl >= 2.5e8) return 300;
    if (tvl >= 5e7) return 200;
    if (tvl >= 1.5e7) return 100;
    return 50;
  }

  // How long a plan runs, from the protocol's age: a young protocol's qualifying window is the
  // longer bet, an old one's record is already long, so its plan is the shorter rotation.
  function planWeeksFor(ageDays) {
    if (ageDays === null || ageDays === undefined) return 8;
    if (ageDays < 180) return 10;
    if (ageDays < 540) return 8;
    return 6;
  }

  // The archetype a category names: what the protocol is for, and so what farming it means.
  // Matched on the category's words, in order; the first match wins.
  var ARCHETYPES = [
    { key: 'lending', match: ['uncollateralized', 'lending'],
      open: function (p, c) { return 'Supply ' + money(c.capital) + ' of USDC as collateral in ' + p.name + "'s main market on " + c.chain + ', leaving the supply position open.'; },
      second: function (p, c) { return 'Borrow about 40% of the supplied value in a second stablecoin against it, then repay the borrow in full after a week, so the wallet shows both sides of the market.'; },
      weekly: function (p, c) { return 'Adjust the position once: top the supply up by a few dollars or repay and re-borrow a small amount, so the account is active in more than one week.'; } },
    { key: 'cdp', match: ['cdp'],
      open: function (p, c) { return 'Deposit ' + money(c.capital) + ' of the collateral asset ' + p.name + ' accepts on ' + c.chain + ' into a fresh vault.'; },
      second: function (p, c) { return "Mint about a third of the vault's value in " + p.name + "'s stablecoin and hold the minted coins in the same wallet, keeping the vault well above its liquidation line."; },
      weekly: function (p, c) { return 'Check the vault once a week and add a small amount of collateral whenever its health factor drifts down.'; } },
    { key: 'dex', match: ['dex'],
      open: function (p, c) { return 'Swap ' + money(c.capital) + ' of USDC into the main pair\'s other asset on ' + p.name + ' on ' + c.chain + ', in two swaps on different days.'; },
      second: function (p, c) { return "Provide the swapped assets as liquidity to " + p.name + "'s busiest pool and keep the LP position open."; },
      weekly: function (p, c) { return 'Make two or three small swaps a week, of $10 to $25 each, so the wallet builds real trading volume rather than one large trade.'; } },
    { key: 'bridge', match: ['bridge'],
      open: function (p, c) { return 'Bridge ' + money(c.capital) + ' of USDC from Ethereum to ' + c.chain + ' through ' + p.name + ', and keep the bridged funds on the far side.'; },
      second: function (p, c) { return 'Use the bridged funds in one app on ' + c.chain + ' (a deposit or a swap), so the trip ends in activity, not in an idle balance.'; },
      weekly: function (p, c) { return 'Bridge a small amount, $20 to $50, once more each fortnight, alternating direction, and use each landing the same day.'; } },
    { key: 'restaking', match: ['restaking', 'restaked'],
      open: function (p, c) { return 'Restake ' + money(c.capital) + ' of a liquid staking token through ' + p.name + ' on ' + c.chain + ' and keep the restaking receipt in the wallet.'; },
      second: function (p, c) { return 'Delegate or opt the position into one of ' + p.name + "'s operator sets or strategies, the step most holders skip."; },
      weekly: function (p, c) { return 'Claim and re-deposit any restaking rewards once a week, so the position compounds and the wallet stays active.'; } },
    { key: 'staking', match: ['staking'],
      open: function (p, c) { return 'Stake ' + money(c.capital) + ' of ' + c.chain + "'s staking asset through " + p.name + ' and keep the liquid receipt token.'; },
      second: function (p, c) { return 'Put half the receipt token to work in one of ' + p.name + "'s listed integrations (a lending market or a pool), keeping the other half liquid."; },
      weekly: function (p, c) { return 'Claim staking rewards once a week and restake them, so the balance and the activity both grow.'; } },
    { key: 'derivatives', match: ['derivative', 'perpetual', 'options', 'interest rate'],
      open: function (p, c) { return 'Deposit ' + money(c.capital) + ' of USDC as margin on ' + p.name + ' on ' + c.chain + '.'; },
      second: function (p, c) { return 'Open one small hedged position, a long and a short of the same size on two markets, and hold both for at least a day before closing.'; },
      weekly: function (p, c) { return 'Trade one small hedged pair a week, keeping total volume modest and every position hedged, so the cost is fees rather than losses.'; } },
    { key: 'vault', match: ['risk curators', 'capital allocator', 'liquidity manager', 'collateral'],
      open: function (p, c) { return 'Deposit ' + money(c.capital) + ' of USDC into one of ' + p.name + "'s curated vaults on " + c.chain + ' and keep the vault shares.'; },
      second: function (p, c) { return 'Split a second, smaller deposit into a different ' + p.name + ' vault, so the wallet holds two curations rather than one.'; },
      weekly: function (p, c) { return 'Check the vaults once a week and move a small amount between them only when one\'s rate clearly beats the other\'s.'; } },
    { key: 'yield', match: ['yield', 'farm', 'basis'],
      open: function (p, c) { return 'Deposit ' + money(c.capital) + ' of USDC into ' + p.name + "'s main vault or farm on " + c.chain + ' and keep the shares.'; },
      second: function (p, c) { return 'Claim the first week\'s yield and deposit it back into the same vault, starting the compounding record.'; },
      weekly: function (p, c) { return 'Harvest and re-deposit the yield once a week, a small transaction that keeps the position visibly active.'; } },
    { key: 'rwa', match: ['rwa'],
      open: function (p, c) { return 'Complete ' + p.name + "'s onboarding or KYC if it asks for one, then mint " + money(c.capital) + ' of its yield asset on ' + c.chain + '.'; },
      second: function (p, c) { return 'Hold the minted asset in the same wallet and, where ' + p.name + ' lists one, deposit half into its own liquidity pool.'; },
      weekly: function (p, c) { return 'Check the asset\'s reported yield once a week and claim any distribution through ' + p.name + "'s own page when one lands."; } },
    { key: 'stable', match: ['stable', 'reserve currency'],
      open: function (p, c) { return 'Mint ' + money(c.capital) + ' of ' + p.name + "'s stablecoin against collateral on " + c.chain + ', or buy it in its own app if minting is gated.'; },
      second: function (p, c) { return 'Provide the minted stablecoin as one side of ' + p.name + "'s main stable pair, so the wallet both mints and supplies."; },
      weekly: function (p, c) { return 'Add a small amount to the pair once a week, or rebalance it, so the position is not a single day\'s work.'; } },
    { key: 'insurance', match: ['insurance'],
      open: function (p, c) { return 'Buy ' + money(Math.max(25, Math.round(c.capital / 4))) + ' of cover from ' + p.name + ' on ' + c.chain + ' for a protocol you actually use, and keep the policy.'; },
      second: function (p, c) { return 'Deposit ' + money(c.capital) + ' into one of ' + p.name + "'s underwriting pools, the side of the market a launch usually rewards."; },
      weekly: function (p, c) { return 'Renew or extend one cover once during the plan, and check the underwriting pool\'s reported return once a week.'; } },
    { key: 'prediction', match: ['prediction'],
      open: function (p, c) { return 'Fund ' + p.name + ' with ' + money(c.capital) + ' on ' + c.chain + ' and take one position in its most liquid market.'; },
      second: function (p, c) { return 'Take a second position on the opposite side of a different market, small, so the wallet trades rather than bets once.'; },
      weekly: function (p, c) { return 'Place one or two small positions a week in liquid markets and settle each as it resolves.'; } },
    { key: 'launchpad', match: ['launchpad'],
      open: function (p, c) { return 'Register the wallet with ' + p.name + ' on ' + c.chain + ' and complete any allowlist or staking step it asks of participants.'; },
      second: function (p, c) { return 'Commit ' + money(c.capital) + ' to the next open sale on ' + p.name + ', or hold the qualifying stake if no sale is open.'; },
      weekly: function (p, c) { return 'Check the sale calendar once a week and join each small sale rather than waiting for one large one.'; } },
    { key: 'chain', match: ['chain'],
      open: function (p, c) { return 'Bridge ' + money(c.capital) + ' to ' + p.name + "'s chain and make the wallet's first transactions there: a swap and a deposit in two of its native apps."; },
      second: function (p, c) { return 'Register a name or an identity the chain offers, if it has one, and keep a small native balance for gas.'; },
      weekly: function (p, c) { return 'Make two or three transactions a week across different native apps, so the wallet reads as a user of the chain, not a passer-by.'; } },
    { key: 'generic', match: [],
      open: function (p, c) { return 'Deposit ' + money(c.capital) + ' of USDC into ' + p.name + ' on ' + c.chain + ' through its own app and keep the position open.'; },
      second: function (p, c) { return 'Make the second kind of action ' + p.name + ' offers (a vote, a claim, a second deposit or a withdrawal and re-deposit), so the wallet is a user, not a depositor only.'; },
      weekly: function (p, c) { return 'Make one qualifying action each week, such as a deposit, a swap, a claim or a vote, and keep each one small.'; } }
  ];

  function archetypeOf(category) {
    var c = (category || '').toLowerCase();
    for (var i = 0; i < ARCHETYPES.length; i++) {
      var a = ARCHETYPES[i];
      for (var j = 0; j < a.match.length; j++) if (c.indexOf(a.match[j]) >= 0) return a;
    }
    return ARCHETYPES[ARCHETYPES.length - 1];
  }

  function ctxFor(p, ageDays) {
    var chain = p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
    var chain2 = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    return {
      chain: chain,
      chain2: chain2,
      gas: gasFor(chain),
      gas2: chain2 ? gasFor(chain2) : 0,
      capital: capitalFor(p.tvl_usd),
      weeks: planWeeksFor(ageDays)
    };
  }

  function gasText(gas) {
    return gas < 1 ? 'about ' + money(Math.max(0.05, gas)) + ' of gas' : 'about ' + money(gas) + ' of gas';
  }

  // A protocol's farm plan: seven steps, each an action with its cost and its time, derived from
  // the protocol's record by the rules above. The totals are the plan's own arithmetic: the gas of
  // every step summed, the capital the largest position holds, the weeks the weekly step names.
  function farmStepsFor(p, ageDays) {
    var a = archetypeOf(p.category);
    var c = ctxFor(p, ageDays);
    var steps = [];
    steps.push({
      text: 'Set up a fresh wallet for ' + p.name + ' on ' + c.chain + ', fund it with enough of the chain\'s gas token for about fifteen actions, and keep its seed phrase offline.',
      cost: 'about ' + money(c.gas * 15) + ' of gas token bought once, spent only as fees',
      time: '10 minutes'
    });
    steps.push({
      text: a.open(p, c),
      cost: money(c.capital) + ' of capital and ' + gasText(c.gas),
      time: '15 minutes to set up'
    });
    steps.push({
      text: a.second(p, c),
      cost: gasText(c.gas) + ' and no new capital beyond the first step\'s',
      time: '10 minutes'
    });
    steps.push({
      text: a.weekly(p, c) + ' Repeat for ' + c.weeks + ' weeks.',
      cost: gasText(c.gas) + ' a week, about ' + money(c.gas * c.weeks) + ' over the plan',
      time: '10 minutes a week for ' + c.weeks + ' weeks'
    });
    if (c.chain2) {
      steps.push({
        text: 'Repeat the opening position on ' + c.chain2 + ', ' + p.name + "'s second chain, at half size, so the wallet is active on two of its chains rather than one.",
        cost: money(Math.round(c.capital / 2)) + ' of capital and ' + gasText(c.gas2),
        time: '15 minutes'
      });
    } else {
      steps.push({
        text: 'In week three, add half the opening capital again to the same position, so the wallet\'s activity spans more than one size and more than one month.',
        cost: money(Math.round(c.capital / 2)) + ' of capital and ' + gasText(c.gas),
        time: '10 minutes, once'
      });
    }
    steps.push({
      text: 'Hold every position until the plan window ends, and once a month open ' + p.name + '\'s own app to check for a points, rewards or governance page and note what it counts.',
      cost: 'no fee to check, and never pay anyone to claim a reward',
      time: '5 minutes a month'
    });
    steps.push({
      text: 'Keep a farm log of the wallet, the dates and every transaction. When you stop, unwind in reverse order and claim any distribution only from a link ' + p.name + ' publishes in its own app.',
      cost: gasText(c.gas) + ' to unwind, and the log costs nothing',
      time: '20 minutes, once'
    });
    return steps;
  }

  // A step as one string for board.json: the action, then its cost, then its time.
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    return s;
  }

  // The plan's totals: gas summed over its actions (setup is fifteen actions' worth of token but
  // is spent as fees only when used, so it is not counted twice), capital, and weeks.
  function planSummary(p, ageDays) {
    var c = ctxFor(p, ageDays);
    var actions = 3 + c.weeks + 2;
    var gas = c.gas * actions + (c.chain2 ? c.gas2 : 0);
    return {
      capital_usd: c.capital + Math.round(c.capital / 2),
      weeks: c.weeks,
      est_gas_usd: Math.max(1, Math.round(gas)),
      archetype: archetypeOf(p.category).key
    };
  }

  var api = {
    GAS_USD: GAS_USD,
    GAS_DEFAULT_USD: GAS_DEFAULT_USD,
    gasFor: gasFor,
    capitalFor: capitalFor,
    planWeeksFor: planWeeksFor,
    archetypeOf: archetypeOf,
    farmStepsFor: farmStepsFor,
    stepText: stepText,
    planSummary: planSummary
  };
  root.TokenRadarFarm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
