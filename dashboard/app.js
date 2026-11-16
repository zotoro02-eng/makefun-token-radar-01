/* Token Radar dashboard: renders window.RADAR (written by main.ts from the
   sealed snapshot) as a sortable, filterable board with a detail view per
   protocol. No network: every byte it shows comes from data.js beside it. */
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.getElementById('rows').textContent = 'No radar data loaded.';
    return;
  }
  var rows = R.rows;

  var $ = function (id) { return document.getElementById(id); };
  var qEl = $('q'), catEl = $('cat'), sortEl = $('sort'), rowsEl = $('rows');

  function money(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v;
  }
  function pct(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function age(v) {
    if (v === null || v === undefined) return '—';
    if (v < 1) return Math.round(v * 12) + ' mo';
    return v.toFixed(1) + ' yr';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* ---- header stats ---- */
  var stats = [
    [rows.length, 'protocols ranked'],
    [R.watchlist_size, 'on the watchlist'],
    [R.summary.pre_token_total, 'record no token'],
    [R.summary.token_bearing_total, 'already trade a token'],
  ];
  stats.forEach(function (s) {
    var d = el('div', 'stat');
    d.appendChild(el('b', null, String(s[0])));
    d.appendChild(el('span', null, s[1]));
    $('stats').appendChild(d);
  });
  $('asof').textContent = R.as_of;
  $('nrows').textContent = String(rows.length);

  /* ---- category filter ---- */
  var cats = {};
  rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = true; });
  Object.keys(cats).sort().forEach(function (c) {
    catEl.appendChild(el('option', null, c));
  });

  /* ---- state from the hash, so each view has a link ---- */
  function readHash() {
    var h = {};
    location.hash.slice(1).split('&').forEach(function (part) {
      var kv = part.split('=');
      if (kv[0]) h[kv[0]] = decodeURIComponent(kv[1] || '');
    });
    return h;
  }
  function writeHash(h) {
    var parts = [];
    if (h.p) parts.push('p=' + encodeURIComponent(h.p));
    if (h.cat) parts.push('cat=' + encodeURIComponent(h.cat));
    if (h.q) parts.push('q=' + encodeURIComponent(h.q));
    var next = parts.length ? '#' + parts.join('&') : '';
    if (location.hash !== next) history.replaceState(null, '', next || location.pathname + location.search);
  }
  var state = { q: '', cat: '', sort: 'value', open: null };
  var h0 = readHash();
  if (h0.q) state.q = h0.q;
  if (h0.cat) state.cat = h0.cat;
  if (h0.p) state.open = h0.p;
  qEl.value = state.q;
  catEl.value = state.cat;

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (!q) return true;
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var key = state.sort;
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_years || 0) - (a.age_years || 0); },
    };
    return list.sort(by[key] || by.value);
  }

  function render() {
    var list = filtered();
    rowsEl.textContent = '';
    $('empty').hidden = list.length !== 0;
    $('count').textContent = list.length + ' of ' + rows.length + ' shown';
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      if (state.open === r.slug) tr.className = 'open';
      tr.appendChild(el('td', 'num', String(r.rank)));
      var name = el('td', 'name', r.name);
      name.appendChild(el('span', 'slug', r.slug));
      if (r.rank <= 3) name.appendChild(el('span', 'badge', 'TOP 3'));
      tr.appendChild(name);
      tr.appendChild(el('td', null, r.category || '—'));
      tr.appendChild(el('td', null, r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '')));
      tr.appendChild(el('td', 'num', money(r.tvl_usd)));
      var g = el('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), pct(r.change_7d));
      tr.appendChild(g);
      tr.appendChild(el('td', 'num', age(r.age_years)));
      tr.appendChild(el('td', 'num value', money(r.implied_value_usd)));
      tr.addEventListener('click', function () { openDetail(r.slug); });
      rowsEl.appendChild(tr);
    });
    renderDetail();
  }

  function openDetail(slug) {
    state.open = state.open === slug ? null : slug;
    writeHash({ p: state.open || '', cat: state.cat, q: state.q });
    render();
    if (state.open) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDetail() {
    var box = $('detail');
    box.textContent = '';
    if (!state.open) return;
    var r = null;
    rows.forEach(function (x) { if (x.slug === state.open) r = x; });
    if (!r) return;
    var head = el('h2');
    head.appendChild(el('span', 'rank', '#' + r.rank + '  '));
    head.appendChild(document.createTextNode(r.name));
    box.appendChild(head);
    box.appendChild(el('p', 'sub',
      (r.category || 'Uncategorised') + ' · ' + r.chains.join(', ') +
      ' · first listed ' + (r.listed_at || 'unknown') + ' · records no token'));
    var kv = el('div', 'kv');
    [
      [money(r.implied_value_usd), 'implied launch value'],
      [money(r.tvl_usd), 'TVL'],
      [pct(r.change_7d), 'TVL change, 7 days'],
      [age(r.age_years), 'running with no token recorded'],
    ].forEach(function (pair) {
      var d = el('div');
      d.appendChild(el('b', null, pair[0]));
      d.appendChild(el('span', null, pair[1]));
      kv.appendChild(d);
    });
    box.appendChild(kv);
    box.appendChild(el('h3', null, 'How to farm it — before any token exists, and after'));
    var ol = el('ol', 'steps');
    r.farm_steps.forEach(function (s) { ol.appendChild(el('li', null, s)); });
    box.appendChild(ol);
    box.appendChild(el('h3', null, 'Why the model prices it here'));
    var t = el('table', 'modeltable');
    var tb = document.createElement('tbody');
    [
      ['TVL × category multiple', money(r.tvl_usd) + ' × ' + r.model.multiple.toFixed(3) + '  —  median market-cap / TVL of live ' + (r.category || 'uncategorised') + ' protocols'],
      ['× growth', '× ' + r.model.growth.toFixed(3) + '  —  7-day TVL change ' + pct(r.change_7d)],
      ['× age', '× ' + r.model.age.toFixed(3) + '  —  ' + age(r.age_years) + ' since first listed'],
      ['× breadth', '× ' + r.model.breadth.toFixed(3) + '  —  on ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's')],
      ['= implied value', '= ' + money(r.implied_value_usd)],
    ].forEach(function (pair) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', null, pair[0]));
      tr.appendChild(el('td', null, pair[1]));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    box.appendChild(t);
    box.appendChild(el('p', 'sub',
      'A reminder: this is the radar\u2019s own claim from the snapshot, not a prediction. ' +
      'If ' + r.name + ' ever issues a token, the value above is what its record so far would support — nothing more.'));
  }

  /* ---- what the board leaves out, so the two sides stay separate ---- */
  var s = R.summary;
  var aside = el('p');
  aside.appendChild(document.createTextNode(
    'Set aside, not ranked: ' + s.token_bearing_total + ' protocols whose token already trades, and ' +
    s.excluded_products + ' wrapped, staked or bridged products of tokens that trade. ' +
    'This board ranks only the ' + s.pre_token_total + ' protocols that record no token — the ' +
    s.watchlist_total + '-protocol watchlist (TVL ≥ ' + money(R.floor_usd) + ') plus the ' +
    s.early_total + ' early ones below the floor that pass the same rule.'));
  $('setaside').appendChild(el('b', null, 'The other side of the radar. '));
  $('setaside').appendChild(aside);

  /* ---- events ---- */
  var timer = null;
  qEl.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      state.q = qEl.value;
      writeHash({ p: state.open || '', cat: state.cat, q: state.q });
      render();
    }, 120);
  });
  catEl.addEventListener('change', function () {
    state.cat = catEl.value;
    writeHash({ p: state.open || '', cat: state.cat, q: state.q });
    render();
  });
  sortEl.addEventListener('change', function () {
    state.sort = sortEl.value;
    render();
  });
  var headMap = { rank: 'value', name: 'value', category: 'value', chains: 'value', tvl: 'tvl', growth: 'growth', age: 'age', value: 'value' };
  document.querySelectorAll('#board thead th').forEach(function (th) {
    th.addEventListener('click', function () {
      state.sort = headMap[th.getAttribute('data-k')] || 'value';
      sortEl.value = state.sort;
      render();
    });
  });
  window.addEventListener('hashchange', function () {
    var h = readHash();
    state.q = h.q || ''; state.cat = h.cat || ''; state.open = h.p || null;
    qEl.value = state.q; catEl.value = state.cat;
    render();
  });

  render();
})();
