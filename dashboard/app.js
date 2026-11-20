// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, a per-protocol detail view, an "already trading" view of the live protocols the
// model calibrated on, and a method view that states the model and prints its calibration table.
// No network: every byte it shows is in data.js, and every farm plan it renders is the structured
// plan dashboard/farm.js generated and main.ts wrote into board.json.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', tab: 'board', sort: 'implied', dir: -1, selected: null };

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + Number(n).toFixed(4); }
  // The page recomputes a row's implied value from the factors it prints: the model's factors are
  // rounded to 4 places before they price a row, so this lands on board.json's number exactly.
  function impliedOf(r) {
    return Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_multiplier * r.maturity_multiplier * r.breadth_multiplier));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var ARCH_LABEL = {
    lending: 'Lending market', cdp: 'CDP vault', dex: 'DEX liquidity', bridge: 'Bridge route',
    restaking: 'Restaking', staking: 'Staking', derivatives: 'Derivatives', vault: 'Curated vault',
    yield: 'Yield vault', rwa: 'Real-world assets', stable: 'Stablecoin', insurance: 'Insurance',
    prediction: 'Prediction market', launchpad: 'Launchpad', chain: 'Chain itself', generic: 'General use'
  };

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.multiple; bv = b.multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('div', null,
          el('span', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('div', { class: 'brand-sub', text: 'which pre-token protocol is worth farming next' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Universe ', el('b', { text: DATA.stats.protocols + ' protocols' }))
      )
    );
  }

  function lede() {
    var s = DATA.stats;
    var early = s.board_size - s.watchlist_size;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, s.board_size + ' protocols that record no token, ranked by ', el('span', { class: 'hl', text: 'implied value' })),
        el('p', { text: 'The watchlist is the floor, not the ceiling: all ' + s.watchlist_size + ' of its protocols are ranked, and the radar adds ' + early + ' more below its $' + Math.round(DATA.floor_usd / 1e6) + 'M floor. Wrapped, staked and bridged products of tokens that already trade are set aside with the ' + s.token_live + ' live-token protocols, never ranked as launches. Implied value is this board\'s model, not a promise.' })
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'Watchlist' }), el('b', null, s.watchlist_size + '', el('small', { text: ' / ' + s.watchlist_size }))),
        el('div', { class: 'stat' }, el('span', { text: 'Rows ranked' }), el('b', { text: String(s.board_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'Early finds' }), el('b', { text: String(early) })),
        el('div', { class: 'stat' }, el('span', { text: 'Board implied' }), el('b', { text: fmtUsd(s.total_implied_usd) }))
      )
    );
  }

  function methodBand() {
    var c = DATA.calibration;
    return el('section', { class: 'method-band' },
      el('div', { class: 'formula', text: 'implied = TVL x multiple x growth x maturity x breadth' }),
      el('p', { text: 'The multiple is calibrated, not chosen: the median market cap per TVL of the ' + c.global_samples + ' live protocols in the same category (global median ' + c.global_median_ratio.toFixed(3) + 'x), shrunk toward that median when a category has few live peers. Full table in the Method tab.' })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCount = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCount[c] = (chainCount[c] || 0) + 1; }); });
    var chains = Object.keys(chainCount).sort(function (a, b) { return chainCount[b] - chainCount[a] || (a < b ? -1 : 1); });
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chn = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c + ' (' + chainCount[c] + ')', selected: c === state.chain ? 'selected' : null }); })
    );
    chn.addEventListener('change', function () { state.chain = chn.value; writeHash(); render(); });
    function tab(id, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === id ? 'true' : 'false', text: label, onclick: function () { state.tab = id; state.selected = null; writeHash(); render(); } });
    }
    var shown = state.tab === 'board' ? filteredRows().length : state.tab === 'live' ? DATA.live.length : DATA.calibration.categories.length;
    var noun = state.tab === 'board' ? 'protocols' : state.tab === 'live' ? 'live protocols' : 'calibrated categories';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chn),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, tab('board', 'Board'), tab('live', 'Already trading'), tab('method', 'Method'))),
      el('span', { class: 'count' }, el('b', { text: String(shown) }), ' ' + noun + ' shown')
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'no chain recorded') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', { class: 'plan' }, el('b', { text: '≈' + fmtUsd(r.farm.est_gas_usd) + ' gas' }), ' · ' + r.farm.weeks + ' wks'),
        el('td', null, r.watchlist ? el('span', { class: 'tag', text: 'Watchlist' }) : el('span', { class: 'tag early', text: 'Early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model workings and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', '#'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'x TVL'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Farm plan' }),
            el('th', { scope: 'col', text: 'List' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'no chain recorded') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_per_tvl === null ? 'n/a' : fmtMult(r.mcap_per_tvl) }),
        el('td', null, el('span', { class: 'tag live', text: 'Trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Already trading: the ' + DATA.live.length + ' largest live-token protocols by market cap. They are never ranked as launches; their market cap per TVL is the evidence the board\'s multiples are calibrated from.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function methodView() {
    var m = DATA.model, c = DATA.calibration, s = DATA.stats;
    var cats = c.categories.slice().sort(function (a, b) { return b.live_samples - a.live_samples || (a.category < b.category ? -1 : 1); });
    var tbody = el('tbody');
    cats.forEach(function (row) {
      tbody.appendChild(el('tr', null,
        el('td', { text: row.category }),
        el('td', { class: 'num', text: String(row.live_samples) }),
        el('td', { class: 'num', text: row.median_ratio === null ? 'n/a' : fmtMult(row.median_ratio) }),
        el('td', { class: 'num', text: fmtMult(row.multiple) })
      ));
    });
    var archCount = {};
    DATA.rows.forEach(function (r) { archCount[r.farm.archetype] = (archCount[r.farm.archetype] || 0) + 1; });
    var archList = Object.keys(archCount).sort(function (a, b) { return archCount[b] - archCount[a]; }).map(function (k) {
      return el('li', null, el('b', { text: (ARCH_LABEL[k] || k) + ' — ' + archCount[k] + ' protocols. ' }), ARCH_TEXT[k] || '');
    });
    return el('div', null,
      el('div', { class: 'method-grid' },
        el('section', { class: 'card' },
          el('h2', { text: 'The value model' }),
          el('p', { class: 'formula', text: 'implied = tvl_usd x category_multiple x growth_factor x maturity_factor x breadth_factor' }),
          el('ul', null,
            el('li', null, el('b', { text: 'Category multiple. ' }), 'The median market cap per TVL of the live protocols in the same category, winsorised to [' + m.median_clamp_lo + ', ' + m.median_clamp_hi + '] and shrunk toward the global median ' + c.global_median_ratio.toFixed(3) + 'x with a prior of ' + m.prior_strength + ' samples, then clamped to [' + m.multiple_floor + ', ' + m.multiple_cap + ']. A category with no live peers is priced at the global median.'),
            el('li', null, el('b', { text: 'Growth factor. ' }), '1 + clamp(change_7d, ' + m.growth_floor_pct + ', ' + m.growth_cap_pct + ') / 100 x ' + m.growth_weight + ': a strong week lifts a price by at most 40%, a bad one cuts it by at most 20%. An unreported change counts as 0.'),
            el('li', null, el('b', { text: 'Maturity factor. ' }), m.maturity_floor + ' + ' + m.maturity_range + ' x min(age, ' + m.maturity_days + ' days) / ' + m.maturity_days + ': how long the protocol has run with no token, saturating at four years. An unknown age uses the snapshot\'s median age, ' + c.median_age_days + ' days.'),
            el('li', null, el('b', { text: 'Breadth factor. ' }), '1 + ' + m.breadth_per_chain + ' per chain past the first, up to 10: a protocol live on more chains has more surface for a token to be useful on.')
          ),
          el('p', null, el('b', { text: 'Who is ranked. ' }), 'Every protocol that records no token, minus the products: ' + s.products_set_aside + ' pre-token records are set aside as wrapped, staked or bridged products of tokens that already trade, exchanges and their products, or versioned pools, by the same tests the watchlist itself uses. The watchlist\'s $50M floor is the only test dropped. A protocol is said to record no token, never to have none: DefiLlama\'s record is the evidence, and it can lag.'),
          el('p', null, el('b', { text: 'Farm plans. ' }), 'Each row\'s plan is generated from its own record: the category picks the archetype (right), the first chain prices the gas, the TVL sizes the position, and the age sets the plan\'s length in weeks. Every step names its cost and its time; the gas and week totals on the board are the plan\'s own sums.')
        ),
        el('section', { class: 'card' },
          el('h2', { text: 'Calibration: what the market pays per $1 of TVL' }),
          el('div', { class: 'table-wrap' },
            el('table', { class: 'calib' },
              el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Live peers' }), el('th', { scope: 'col', text: 'Median' }), el('th', { scope: 'col', text: 'Multiple used' }))),
              tbody
            )
          ),
          el('p', { class: 'note', text: 'Read from the ' + c.global_samples + ' live protocols in this same snapshot that record both a market cap and a TVL. Thin categories sit close to the global median by construction; the multiple used is the claim, the median is the evidence.' })
        )
      ),
      el('section', { class: 'card' },
        el('h2', { text: 'Farm plan archetypes on this board' }),
        el('ul', null, archList)
      )
    );
  }

  var ARCH_TEXT = {
    lending: 'Supply collateral, borrow against it, repay, and stay active on both sides of the market.',
    cdp: 'Open a vault, mint against it, and keep its health factor safe week by week.',
    dex: 'Build real swap volume in small trades and hold an LP position in the busiest pool.',
    bridge: 'Bridge in, use the funds on the far side, and repeat the trip in both directions.',
    restaking: 'Restake a liquid staking token, delegate it, and compound the rewards.',
    staking: 'Stake, keep the liquid receipt, and put half of it to work in an integration.',
    derivatives: 'Post margin and trade small hedged pairs, so the cost is fees, not losses.',
    vault: 'Deposit into curated vaults and hold the shares across the whole plan window.',
    yield: 'Deposit, harvest and re-deposit weekly so the position compounds on record.',
    rwa: 'Onboard, mint the yield asset, and hold it where its distributions land.',
    stable: 'Mint the stablecoin and supply it to its own main pair.',
    insurance: 'Buy cover you would use anyway and underwrite on the other side of the market.',
    prediction: 'Trade small positions in liquid markets and settle each as it resolves.',
    launchpad: 'Register, hold the qualifying stake, and join each small sale.',
    chain: 'Bridge to the chain and transact weekly across its native apps.',
    generic: 'Deposit through the protocol\'s own app and make one qualifying action a week.'
  };

  function openDetail(slug) {
    state.selected = slug;
    writeHash();
    render();
    window.scrollTo(0, 0);
  }

  function detailView(row) {
    var recomputed = impliedOf(row);
    var agrees = recomputed === row.implied_value_usd;
    var cal = DATA.calibration.categories.filter(function (c) { return c.category === (row.category || ''); })[0];
    var why = [];
    why.push(row.name + ' is priced as a ' + (row.category || 'uncategorised') + ' protocol: its category multiple of ' + fmtMult(row.multiple) + ' comes from ' + (row.multiple_samples > 0 ? row.multiple_samples + ' live peer' + (row.multiple_samples === 1 ? '' : 's') : 'no live peers, so the global median') + ' in this snapshot.');
    if (row.change_7d !== null) why.push('Its week was ' + fmtPct(row.change_7d) + ', which the model damps to a growth factor of ' + fmtMult(row.growth_multiplier) + '.');
    why.push(row.age_days === null ? 'DefiLlama records no listing date for it, so its maturity uses the snapshot\'s median age.' : 'It has run ' + fmtAge(row.age_days) + ' with no token on record, a maturity factor of ' + fmtMult(row.maturity_multiplier) + '.');
    var steps = row.farm.steps.map(function (s) {
      return el('li', null,
        el('div', null,
          el('span', { class: 'act', text: s.text }),
          el('span', { class: 'meta' }, el('b', { text: 'Cost: ' }), s.cost + ' · ', el('b', { text: 'Time: ' }), s.time)
        )
      );
    });
    return el('div', null,
      el('a', { class: 'back', href: '#', text: '← Back to the board', onclick: function (e) { e.preventDefault(); state.selected = null; writeHash(); render(); } }),
      el('div', { class: 'detail-head' },
        el('div', null,
          el('h1', { text: row.name }),
          el('div', { class: 'chips' },
            el('span', { class: 'chip' }, 'Rank ', el('b', { text: '#' + row.rank }), ' of ' + DATA.stats.board_size),
            row.watchlist ? el('span', { class: 'chip', text: 'On the watchlist' }) : el('span', { class: 'chip', text: 'Early find, below the floor' }),
            el('span', { class: 'chip', text: (row.category || 'Other') }),
            el('span', { class: 'chip', text: 'Records no token' }),
            el('span', { class: 'chip' }, el('b', { text: (row.chains || []).length + '' }), ' chains')
          )
        ),
        el('div', { class: 'implied-big' }, el('span', { text: 'Implied value' }), el('b', { text: usdFull.format(row.implied_value_usd) }))
      ),
      el('p', { class: 'note', text: why.join(' ') }),
      el('div', { class: 'cols' },
        el('div', null,
          el('section', { class: 'card' },
            el('h2', { text: 'The record' }),
            el('div', { class: 'kv' },
              el('div', null, el('span', { text: 'TVL' }), el('b', { text: usdFull.format(row.tvl_usd) })),
              el('div', null, el('span', { text: '7d change' }), el('b', { text: fmtPct(row.change_7d) })),
              el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
              el('div', null, el('span', { text: 'First tracked' }), el('b', { text: row.listed_at || 'not recorded' })),
              el('div', null, el('span', { text: 'Chains' }), el('b', { text: String((row.chains || []).length) })),
              el('div', null, el('span', { text: 'Token' }), el('b', { text: 'none recorded' }))
            ),
            el('p', { class: 'note', text: 'Chains: ' + ((row.chains || []).join(', ') || 'none recorded') + '.' })
          ),
          el('section', { class: 'card' },
            el('h2', { text: 'How this price is built' }),
            el('p', { class: 'eq' },
              usdFull.format(row.tvl_usd) + ' ', el('span', { class: 'op', text: 'x' }), ' ' + row.multiple.toFixed(4) + ' ',
              el('span', { class: 'op', text: 'x' }), ' ' + row.growth_multiplier.toFixed(4) + ' ',
              el('span', { class: 'op', text: 'x' }), ' ' + row.maturity_multiplier.toFixed(4) + ' ',
              el('span', { class: 'op', text: 'x' }), ' ' + row.breadth_multiplier.toFixed(4) + ' ',
              el('span', { class: 'op', text: '=' }), ' ', el('span', { class: 'res', text: usdFull.format(row.implied_value_usd) })
            ),
            el('table', { class: 'factors' },
              el('tbody', null,
                el('tr', null, el('td', { text: 'Category multiple (' + (row.category || 'uncategorised') + ')' }), el('td', { text: fmtMult(row.multiple) })),
                el('tr', null, el('td', { text: 'Growth factor (7d ' + fmtPct(row.change_7d) + ', damped)' }), el('td', { text: fmtMult(row.growth_multiplier) })),
                el('tr', null, el('td', { text: 'Maturity factor (' + fmtAge(row.age_days) + ' with no token)' }), el('td', { text: fmtMult(row.maturity_multiplier) })),
                el('tr', null, el('td', { text: 'Breadth factor (' + (row.chains || []).length + ' chains)' }), el('td', { text: fmtMult(row.breadth_multiplier) }))
              )
            ),
            el('p', { class: 'note' }, 'This page recomputes the row from the same factors: ', el('span', { class: agrees ? 'check' : '', text: usdFull.format(recomputed) + (agrees ? ' — the same number board.json carries.' : ' — which differs from the board; the data would be stale.') }), cal ? ' Category evidence: median ' + fmtMult(cal.median_ratio) + ' over ' + cal.live_samples + ' live peer' + (cal.live_samples === 1 ? '' : 's') + '.' : '')
          )
        ),
        el('section', { class: 'card' },
          el('h2', { text: 'Farm plan — ' + (ARCH_LABEL[row.farm.archetype] || row.farm.archetype) }),
          el('div', { class: 'totals' },
            el('div', { class: 'stat' }, el('span', { text: 'Capital in play' }), el('b', { text: fmtUsd(row.farm.capital_usd) })),
            el('div', { class: 'stat' }, el('span', { text: 'Gas, whole plan' }), el('b', { text: '≈' + fmtUsd(row.farm.est_gas_usd) })),
            el('div', { class: 'stat' }, el('span', { text: 'Plan length' }), el('b', { text: row.farm.weeks + ' weeks' }))
          ),
          el('ol', { class: 'steps' }, steps),
          el('p', { class: 'note', text: 'Capital stays in the positions and is recoverable on exit; the gas is the plan\'s real cost. Nothing here is a promise that a token, a points program or a reward exists: it is the work a farmer would do if they chose this protocol.' })
        )
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('b', { text: 'Source. ' }), DATA.source + '. ',
      el('b', { text: 'Reading it. ' }), 'A protocol is said to record no token, never to have none: the snapshot is DefiLlama\'s record at one moment, and a launch\'s implied value is this board\'s model claim, not a price and not a prediction that a token will be issued.'
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    var selected = state.selected ? DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    if (selected) {
      shell.appendChild(detailView(selected));
    } else {
      shell.appendChild(lede());
      shell.appendChild(methodBand());
      shell.appendChild(controls());
      shell.appendChild(state.tab === 'live' ? liveTable() : state.tab === 'method' ? methodView() : boardTable());
    }
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
})();
