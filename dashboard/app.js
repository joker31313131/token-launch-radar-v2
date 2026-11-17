/* Token Launch Radar — renders window.RADAR (written by main.ts from the
   same board as board.json) with no network: sort, filter, detail, and a
   model sandbox that re-scores the board with adjusted constants. */
(function () {
  'use strict';
  var R = window.RADAR;
  var lede = document.getElementById('lede');
  if (!R || !Array.isArray(R.rows)) {
    lede.textContent = 'The dashboard data did not load. Open this page from the output directory, beside data.js.';
    return;
  }

  var state = { q: '', cat: '', sort: 'rank', dir: 1, view: 'board', slug: null };
  var sandbox = null; // { growth_weight, maturity_floor, multiple_cap } or null

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtUSD(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function fmtAge(v) {
    if (v === null || v === undefined) return '—';
    return v + 'd';
  }
  function fmtChains(chains) {
    if (!chains || chains.length === 0) return '—';
    var shown = chains.slice(0, 3).join(', ');
    return chains.length > 3 ? shown + ' +' + (chains.length - 3) : shown;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* The same formula lib/model.ts scores with, so the sandbox re-scores
     honestly: implied = TVL x multiple x growth x maturity. */
  function scoreRow(row, c) {
    var multiple = Math.min(row.model.multiple, c.multiple_cap);
    var growthPct = clamp(typeof row.change_7d === 'number' ? row.change_7d : 0, R.model.growth_floor_pct, R.model.growth_cap_pct);
    var growth = 1 + c.growth_weight * (growthPct / 100);
    var age = row.age_days === null || row.age_days === undefined ? R.model.unknown_age_days : row.age_days;
    var maturity = c.maturity_floor + (1 - c.maturity_floor) * (clamp(age, 0, R.model.maturity_days) / R.model.maturity_days);
    return {
      multiple: multiple,
      growth_pct: growthPct,
      growth_multiplier: growth,
      maturity_multiplier: maturity,
      implied: Math.max(1, Math.round(row.tvl_usd * multiple * growth * maturity)),
    };
  }

  function displayRows() {
    var rows = R.rows.map(function (row) {
      if (!sandbox) return { row: row, implied: row.implied_value_usd, rank: row.rank, factors: null };
      var f = scoreRow(row, sandbox);
      return { row: row, implied: f.implied, rank: 0, factors: f };
    });
    if (sandbox) {
      rows.sort(function (a, b) { return b.implied - a.implied || (a.row.slug < b.row.slug ? -1 : 1); });
      rows.forEach(function (d, i) { d.rank = i + 1; });
    }
    return rows;
  }

  function filtered() {
    var q = state.q.toLowerCase();
    return displayRows().filter(function (d) {
      var row = d.row;
      if (state.cat && row.category !== state.cat) return false;
      if (document.getElementById('watchonly').checked && !row.on_watchlist) return false;
      if (q) {
        var hay = (row.name + ' ' + row.slug + ' ' + (row.category || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function sortValue(d, key) {
    var row = d.row;
    if (key === 'rank') return d.rank;
    if (key === 'implied') return d.implied;
    if (key === 'tvl_usd') return row.tvl_usd;
    if (key === 'change_7d') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age_days') return row.age_days === null ? -Infinity : row.age_days;
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'category') return (row.category || '').toLowerCase();
    return d.rank;
  }

  function sorted(list) {
    var dir = state.dir;
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var va = sortValue(a, key), vb = sortValue(b, key);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.row.slug < b.row.slug ? -1 : 1;
    });
  }

  function renderBoard() {
    var list = sorted(filtered());
    var html = list.map(function (d) {
      var row = d.row;
      var chg = row.change_7d === null ? '<td class="num">—</td>'
        : '<td class="num ' + (row.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(row.change_7d) + '</td>';
      return '<tr data-slug="' + esc(row.slug) + '"' + (state.slug === row.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + d.rank + '</td>' +
        '<td><span class="name">' + esc(row.name) + '</span><span class="slug">' + esc(row.slug) + '</span></td>' +
        '<td>' + esc(row.category || '—') + '</td>' +
        '<td><span class="chains">' + esc(fmtChains(row.chains)) + '</span></td>' +
        '<td class="num">' + fmtUSD(row.tvl_usd) + '</td>' + chg +
        '<td class="num">' + fmtAge(row.age_days) + '</td>' +
        '<td class="num"><strong>' + fmtUSD(d.implied) + '</strong></td>' +
        '<td>' + (row.on_watchlist ? '<span class="pill">Watchlist</span>' : '<span class="pill early">Early</span>') + '</td></tr>';
    }).join('');
    document.getElementById('rows').innerHTML = html || '<tr><td colspan="9">No protocol matches this filter.</td></tr>';
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + R.rows.length + ' ranked protocols · ' +
      R.watchlist_size + ' on the watchlist · ' + R.early_size + ' early finds · snapshot as of ' + R.as_of + '.';
    var rowsEl = document.getElementById('rows');
    var trs = rowsEl.querySelectorAll('tr[data-slug]');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { location.hash = '#/detail/' + this.getAttribute('data-slug'); });
    }
  }

  function renderLive() {
    var html = R.live.map(function (p) {
      var chg = p.change_7d === null ? '<td class="num">—</td>'
        : '<td class="num ' + (p.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(p.change_7d) + '</td>';
      return '<tr><td><span class="name">' + esc(p.name) + '</span><span class="slug">' + esc(p.slug) + '</span></td>' +
        '<td>' + esc(p.category || '—') + '</td>' +
        '<td><span class="chains">' + esc(fmtChains(p.chains)) + '</span></td>' +
        '<td class="num">' + fmtUSD(p.tvl_usd) + '</td>' + chg +
        '<td class="num"><strong>' + (p.mcap_usd === null ? '—' : fmtUSD(p.mcap_usd)) + '</strong></td>' +
        '<td>' + esc(p.symbol || '—') + '</td></tr>';
    }).join('');
    document.getElementById('liverows').innerHTML = html;
    document.getElementById('count').textContent =
      R.live.length + ' protocols whose token already trades, by market cap. Kept out of the ranking on purpose.';
  }

  function renderDetail() {
    var panel = document.getElementById('detail');
    var found = null;
    if (state.slug) {
      for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.slug) { found = R.rows[i]; break; }
    }
    if (!found) { panel.hidden = true; panel.innerHTML = ''; return; }
    var f = sandbox ? scoreRow(found, sandbox) : null;
    var m = found.model;
    var multiple = f ? f.multiple : m.multiple;
    var growth = f ? f.growth_multiplier : m.growth_multiplier;
    var maturity = f ? f.maturity_multiplier : m.maturity_multiplier;
    var implied = f ? f.implied : found.implied_value_usd;
    var steps = found.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    panel.innerHTML =
      '<button class="close" type="button" id="detail-close">Close detail</button>' +
      '<h2>' + esc(found.name) + '</h2>' +
      '<p class="meta">Rank ' + found.rank + ' of ' + R.rows.length + ' · ' + esc(found.slug) + ' · ' + esc(found.category || 'uncategorized') +
      ' · ' + esc(fmtChains(found.chains)) + ' · listed ' + esc(found.listed_at || 'date unknown') +
      ' · ' + (found.on_watchlist ? 'on the watchlist' : 'an early find below the floor') + '</p>' +
      '<div class="breakdown">' +
      '<div class="factor"><b>' + fmtUSD(found.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div class="factor"><b>×' + multiple.toFixed(4) + '</b><span>Multiple — ' + (m.multiple_from_category ? 'category median' : 'global median') + '</span></div>' +
      '<div class="factor"><b>×' + growth.toFixed(4) + '</b><span>Growth (' + fmtPct(found.change_7d) + ' in 7d)</span></div>' +
      '<div class="factor"><b>×' + maturity.toFixed(4) + '</b><span>Maturity (' + fmtAge(found.age_days) + ' old)</span></div>' +
      '<div class="factor"><b>' + fmtUSD(implied) + '</b><span>Implied value' + (sandbox ? ' (sandbox)' : '') + '</span></div>' +
      '</div>' +
      '<p class="token-note">This protocol records no token in the snapshot — no market cap, no CoinGecko id, no symbol. That is the record, not proof it has none.</p>' +
      '<h3>How to farm it</h3><ol>' + steps + '</ol>';
    panel.hidden = false;
    document.getElementById('detail-close').addEventListener('click', function () { location.hash = '#/board'; });
  }

  function renderCalibration() {
    var rows = R.calibration.categories.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.multiple.toFixed(4) + '</td><td class="num">' + c.sample + '</td></tr>';
    }).join('');
    document.getElementById('calibration').innerHTML =
      '<table><thead><tr><th>Category</th><th class="num">Median mcap / TVL</th><th class="num">Trading protocols</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p>Categories with fewer than ' + R.model.min_category_sample + ' trading protocols use the global median of ' +
      R.calibration.global_median.toFixed(4) + ' (' + R.calibration.global_sample + ' protocols). Multiples are clamped to [' +
      R.model.multiple_floor + ', ' + R.model.multiple_cap + '].</p>';
  }

  function render() {
    var boardMode = state.view === 'board';
    document.getElementById('board').hidden = !boardMode;
    document.getElementById('livetable').hidden = boardMode;
    document.getElementById('live-note').hidden = boardMode;
    document.getElementById('view-board').classList.toggle('on', boardMode);
    document.getElementById('view-live').classList.toggle('on', !boardMode);
    var note = document.getElementById('sandbox-note');
    if (sandbox) {
      note.hidden = false;
      note.textContent = 'Sandbox active: the board below is re-scored with growth weight ' + sandbox.growth_weight +
        ', maturity floor ' + sandbox.maturity_floor + ', multiple cap ' + sandbox.multiple_cap +
        '. The submitted board.json is unchanged — Reset restores it.';
    } else {
      note.hidden = true;
    }
    if (boardMode) renderBoard(); else renderLive();
    renderDetail();
  }

  function readHash() {
    var h = location.hash || '';
    var m;
    if ((m = h.match(/^#\/detail\/(.+)$/))) {
      state.view = 'board';
      state.slug = decodeURIComponent(m[1]);
    } else if ((m = h.match(/^#\/filter\/(.+)$/))) {
      state.view = 'board';
      state.slug = null;
      state.cat = decodeURIComponent(m[1]);
      document.getElementById('cat').value = state.cat;
    } else if (h === '#/live') {
      state.view = 'live';
      state.slug = null;
    } else {
      if (h === '#/board') state.slug = null;
    }
  }

  /* Controls */
  var cats = [];
  R.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  var catSel = document.getElementById('cat');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });
  document.getElementById('q').addEventListener('input', function () { state.q = this.value; render(); });
  catSel.addEventListener('change', function () { state.cat = this.value; render(); });
  document.getElementById('watchonly').addEventListener('change', render);
  document.getElementById('sort').addEventListener('change', function () {
    state.sort = this.value;
    state.dir = (state.sort === 'name' || state.sort === 'category' || state.sort === 'rank') ? 1 : -1;
    render();
  });
  var ths = document.querySelectorAll('#board th[data-sort]');
  for (var t = 0; t < ths.length; t++) {
    ths[t].addEventListener('click', function () {
      var key = this.getAttribute('data-sort');
      if (state.sort === key) { state.dir = -state.dir; }
      else { state.sort = key; state.dir = (key === 'rank' || key === 'name' || key === 'category') ? 1 : -1; }
      document.getElementById('sort').value = state.sort === 'implied' ? 'rank' : state.sort;
      render();
    });
  }
  document.getElementById('view-board').addEventListener('click', function () { location.hash = '#/board'; state.view = 'board'; render(); });
  document.getElementById('view-live').addEventListener('click', function () { location.hash = '#/live'; });

  /* Sandbox */
  document.getElementById('sandbox').addEventListener('submit', function (ev) {
    ev.preventDefault();
    sandbox = {
      growth_weight: parseFloat(document.getElementById('sb-growth').value) || 0,
      maturity_floor: parseFloat(document.getElementById('sb-maturity').value) || 0,
      multiple_cap: parseFloat(document.getElementById('sb-cap').value) || 0.75,
    };
    state.view = 'board';
    location.hash = '#/board';
    render();
  });
  document.getElementById('sb-reset').addEventListener('click', function () {
    sandbox = null;
    document.getElementById('sb-growth').value = R.model.growth_weight;
    document.getElementById('sb-maturity').value = R.model.maturity_floor;
    document.getElementById('sb-cap').value = R.model.multiple_cap;
    render();
  });

  lede.textContent = R.rows.length + ' protocols that record no token, ranked by what a launch would be worth if each record stayed as it is — ' +
    R.watchlist_size + ' from the watchlist floor and ' + R.early_size + ' early finds below it. Snapshot frozen ' + R.as_of +
    '. Select any row for its farm plan.';
  renderCalibration();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  render();
})();
