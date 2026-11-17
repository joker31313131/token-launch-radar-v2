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
     honestly: implied = TVL x multiple x growth x maturity. The multiple is
     each row's fitted multiple; the growth and maturity constants come from
     the sandbox inputs, defaulting to the selected model's constants. */
  function unknownAgeDays() {
    var u = R.final_spec.unknown_age;
    if (u === 'days0') return 0;
    if (u === 'median') return R.train_median_age;
    return R.model.unknown_age_days;
  }
  function scoreRow(row, c) {
    var multiple = Math.min(row.model.multiple, c.multiple_cap);
    var growthPct = clamp(typeof row.change_7d === 'number' ? row.change_7d : 0, R.model.growth_floor_pct, R.model.growth_cap_pct);
    var growth = 1 + c.growth_weight * (growthPct / 100);
    var age = row.age_days === null || row.age_days === undefined ? unknownAgeDays() : row.age_days;
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
    var source = multipleSource(m);
    var steps = found.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    panel.innerHTML =
      '<button class="close" type="button" id="detail-close">Close detail</button>' +
      '<h2>' + esc(found.name) + '</h2>' +
      '<p class="meta">Rank ' + found.rank + ' of ' + R.rows.length + ' · ' + esc(found.slug) + ' · ' + esc(found.category || 'uncategorized') +
      ' · ' + esc(fmtChains(found.chains)) + ' · listed ' + esc(found.listed_at || 'date unknown') +
      ' · ' + (found.on_watchlist ? 'on the watchlist' : 'an early find below the floor') + '</p>' +
      '<div class="breakdown">' +
      '<div class="factor"><b>' + fmtUSD(found.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div class="factor"><b>×' + multiple.toFixed(4) + '</b><span>Multiple — ' + esc(source) + '</span></div>' +
      '<div class="factor"><b>×' + growth.toFixed(4) + '</b><span>Growth (' + fmtPct(found.change_7d) + ' in 7d)</span></div>' +
      '<div class="factor"><b>×' + maturity.toFixed(4) + '</b><span>Maturity (' + fmtAge(found.age_days) + ' old)</span></div>' +
      '<div class="factor"><b>' + fmtUSD(implied) + '</b><span>Implied value' + (sandbox ? ' (sandbox)' : '') + '</span></div>' +
      '</div>' +
      '<p class="rank-range">Rank range across leave-one-out refits: <strong>' + found.rank_lo + '–' + found.rank_hi + '</strong>. ' +
      'It measures how much this rank moves when one calibration group is removed — sensitivity to one reporter, not prediction error.</p>' +
      '<p class="token-note">This protocol records no token in the snapshot — no market cap, no CoinGecko id, no symbol. That is the record, not proof it has none.</p>' +
      '<h3>How to farm it</h3><ol>' + steps + '</ol>';
    panel.hidden = false;
    document.getElementById('detail-close').addEventListener('click', function () { location.hash = '#/board'; });
  }

  function multipleSource(m) {
    if (m.multiple_kind === 'category') return 'category median (n=' + m.multiple_n + ')';
    if (m.multiple_kind === 'shrunk') return 'shrunk blend, w=' + (m.multiple_w === null ? '—' : m.multiple_w.toFixed(2)) + ' (n=' + m.multiple_n + ')';
    if (m.multiple_kind === 'curve') return 'size curve at this TVL';
    if (m.multiple_kind === 'curve-offset') return 'size curve + category offset';
    if (m.multiple_kind === 'curve-seg') return 'segmented size curve';
    return 'global median';
  }

  function describeCalibration() {
    var spec = R.final_spec;
    var cal = R.calibration;
    var clampNote = ' Clamped to [' + R.model.multiple_floor + ', ' + R.model.multiple_cap + '].';
    if (spec.calibration === 'flat') return '<strong>M</strong> — the global median market-cap-to-TVL ratio across all token-bearing protocols.' + clampNote;
    if (spec.calibration === 'shrink-n' || spec.calibration === 'shrink-var' || spec.calibration === 'shrink-trim') {
      var how = spec.calibration === 'shrink-n' ? 'w = n/(n+k)' : spec.calibration === 'shrink-var' ? 'a variance-ratio weight' : 'a blend toward the trimmed-mean multiple';
      return '<strong>M</strong> — a shrunk blend of the category median and the global median, w × M(category) + (1 − w) × M(global), with ' + how + '. Categories with fewer than 3 reporters use the global median.' + clampNote;
    }
    if (spec.calibration.indexOf('curve') === 0) {
      var curve = cal.curve;
      var method = curve ? curve.method : 'log-log';
      var extra = spec.calibration === 'curve-offset' ? ', plus a shrunk offset per category on the residuals' : spec.calibration === 'curve-seg' ? ', fitted separately below and above the median TVL' : '';
      return '<strong>M</strong> — a size curve: log(market cap) = a + b × log(TVL), fitted by ' + method + extra +
        (curve ? ' (a=' + curve.a + ', b=' + curve.b + ')' : '') + ', giving M = exp(a + b × log(TVL)) / TVL.' + clampNote;
    }
    return '<strong>M(category)</strong> — the median market-cap-to-TVL ratio of the token-bearing protocols in the same category (at least ' +
      R.model.min_category_sample + ' of them), otherwise the global median across all token-bearing protocols.' + clampNote;
  }

  function renderFormulaSteps() {
    var spec = R.final_spec;
    var unknown = spec.unknown_age === 'days0' ? 'An unknown listing date counts as 0 days.'
      : spec.unknown_age === 'median' ? 'An unknown listing date counts as the median known age (' + R.train_median_age + ' days).'
      : 'An unknown listing date counts as ' + R.model.unknown_age_days + ' days.';
    var dedup = spec.use_dedup ? ' Fitted on deduplicated token groups, not raw rows.' : '';
    document.getElementById('formula-steps').innerHTML =
      '<li>' + describeCalibration() + dedup + '</li>' +
      '<li><strong>Growth</strong> — 1 + ' + spec.growth_weight + ' × clamp(7-day TVL change, ' + R.model.growth_floor_pct + '%, +' + R.model.growth_cap_pct + '%) ÷ 100. An unreported change counts as 0.</li>' +
      '<li><strong>Maturity</strong> — ' + spec.maturity_floor + ' + ' + (1 - spec.maturity_floor).toFixed(2) + ' × min(age in days, ' + R.model.maturity_days + ') ÷ ' + R.model.maturity_days + ', from the listing date to the snapshot date. ' + unknown + '</li>';
  }

  function renderCalibration() {
    var cal = R.calibration;
    var html = '';
    if (cal.kind === 'curve' && cal.curve) {
      html += '<p>Size curve (' + esc(cal.curve.method) + '): a=' + cal.curve.a + ', b=' + cal.curve.b +
        (cal.curve.splitX !== undefined ? ', split at log(TVL)=' + cal.curve.splitX + ' with a2=' + cal.curve.a2 + ', b2=' + cal.curve.b2 : '') +
        ', fitted on ' + cal.globalN + ' reporter groups. Global median mcap/TVL ' + cal.globalMultiple.toFixed(4) + ' shown on the chart for reference.</p>';
      if (cal.offsets && cal.offsets.length > 0) {
        var offs = cal.offsets.map(function (o) {
          return '<tr><td>' + esc(o.category) + '</td><td class="num">' + o.offset.toFixed(4) + '</td><td class="num">' + o.n + '</td></tr>';
        }).join('');
        html += '<table><thead><tr><th>Category</th><th class="num">Shrunk log offset</th><th class="num">Reporters</th></tr></thead><tbody>' + offs + '</tbody></table>';
      }
    } else {
      var rows = cal.categories.map(function (c) {
        var src = c.kind === 'category' ? 'category median' : c.kind === 'shrunk' ? 'shrunk blend' : 'global median';
        return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.multiple.toFixed(4) + '</td><td class="num">' + c.n + '</td><td class="num">' + (c.w === null ? '—' : c.w.toFixed(2)) + '</td><td>' + src + '</td></tr>';
      }).join('');
      html += '<table><thead><tr><th>Category</th><th class="num">Multiple</th><th class="num">Reporters</th><th class="num">w</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p>Global median ' + cal.globalMultiple.toFixed(4) + ' (' + cal.globalN + ' reporter groups). Categories with fewer than ' +
        R.model.min_category_sample + ' reporters use the global median unless the model shrinks them. Multiples are clamped to [' +
        R.model.multiple_floor + ', ' + R.model.multiple_cap + '].</p>';
    }
    document.getElementById('calibration').innerHTML = html;
  }

  function renderFarmMetrics() {
    var fm = R.farm_metrics;
    document.getElementById('farm-metrics').innerHTML =
      '<h3>Farm plans</h3><p>Each row carries a six-step farm plan, differentiated by the protocol\'s mechanism family (from its category), ' +
      'its main chain\'s gas tier, its TVL tier, and its hold window — ending in a netting step that totals the plan itself. ' +
      fm.total_steps + ' steps in all, ' + fm.distinct_steps + ' distinct step strings (ratio ' + fm.distinct_ratio + '), ' +
      fm.template_distinct + ' distinct plan shapes with names, chains, and numbers masked out. Step lengths ' + fm.min_len + '–' + fm.max_len + ' characters. ' +
      'Gas tiers are author estimates, not snapshot data: high $5–$20 per transaction (Ethereum), medium $2–$8, low $0.10–$2.</p>';
  }

  /* ---- validation section: fold design, all candidates, charts, caveats ---- */

  function renderValidation() {
    var v = R.validation;
    var winner = null, baseline = null, finalRow = null;
    v.candidates.forEach(function (c) {
      if (c.id === v.winner_id) winner = c;
      if (c.id === v.baseline_id) baseline = c;
      if (c.id === 'final') finalRow = c;
    });
    var summary =
      '<p><strong>Test population.</strong> ' + v.reporter_rows + ' token-bearing reporter rows, deduplicated into ' + v.groups +
      ' token groups (' + v.merges_tier1 + ' Tier-1 merges by shared CoinGecko id, ' + v.merges_tier2 +
      ' Tier-2 merges by symbol plus name overlap, ' + v.spread_flagged + ' groups flagged for within-group market-cap spread). ' +
      'Assumption: TVLs across entries do not double-count the same liquidity.</p>' +
      '<p><strong>Fold design.</strong> Grouped 5-fold cross-validation (fold sizes ' + v.fold_sizes.join(', ') +
      '): rows sharing one token identity always share a fold, so no token leaks between train and test. Leave-one-group-out refits complement ' +
      'the folds. Every statistic — medians, curve parameters, trim thresholds, shrinkage weights — is computed from the training fold only; ' +
      'nothing is normalized on the full data before splitting.</p>' +
      '<p><strong>Pre-registered adoption rule.</strong> A challenger is adopted only if its pooled MdAPE is at least 10% relatively better than the ' +
      'baseline AND it wins at least 3 of 5 folds AND its Spearman correlation is not worse than the baseline\'s. ' +
      'If nothing passes, the first version\'s model is kept. Stage 2 tests one-factor ablations of the winner under the same rule.</p>' +
      '<p><strong>Outcome.</strong> ' + (v.winner_is_baseline
        ? 'No challenger passed the rule, so the first version\'s model was kept — honestly, with the numbers below.'
        : 'The winner is ' + esc(winner.label) + ' (MdAPE ' + winner.mdape.toFixed(4) + ' vs baseline ' + baseline.mdape.toFixed(4) + ').') +
      ' The final row repeats the selected model\'s holdout numbers for reference.</p>' +
      '<ul class="notes">' + v.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    document.getElementById('validation-summary').innerHTML = summary;

    var tableRows = v.candidates.map(function (c) {
      return '<tr' + (c.adopted ? ' class="adopted"' : '') + '><td>' + esc(c.label) + '</td><td>' + esc(c.stage) + '</td>' +
        '<td class="num">' + c.mdape.toFixed(4) + '</td><td class="num">' + (c.signed >= 0 ? '+' : '') + c.signed.toFixed(4) + '</td>' +
        '<td class="num">' + c.spearman.toFixed(4) + '</td><td class="num">' + c.foldWins + '</td>' +
        '<td class="num">' + c.logoMdape.toFixed(4) + '</td><td>' + (c.adopted ? 'adopted' : '—') + '</td></tr>';
    }).join('');
    document.getElementById('candidate-table').innerHTML =
      '<h3>All candidates, same protocol</h3>' +
      '<table><thead><tr><th>Candidate</th><th>Stage</th><th class="num">MdAPE</th><th class="num">Signed err</th>' +
      '<th class="num">Spearman</th><th class="num">Fold wins</th><th class="num">LOGO MdAPE</th><th>Decision</th></tr></thead><tbody>' +
      tableRows + '</tbody></table>' +
      '<p class="footnote">Fold wins count folds where the candidate beat the reference: the baseline in stage 1, the stage-1 winner in stage 2. ' +
      'The baseline\'s own row shows 0 by definition. MdAPE is the median absolute percentage error; signed error is the median signed error; ' +
      'Spearman is the rank correlation between predicted and actual market cap.</p>';

    var fin = finalRow || baseline;
    document.getElementById('caveats').innerHTML =
      '<h3>What this does not prove</h3><ul>' +
      '<li><strong>Survivorship bias.</strong> The test population is protocols whose tokens already trade — survivors. Failed launches never appear, so the errors flatter the model.</li>' +
      '<li><strong>Holdout measures multiple fit, not launch-value accuracy.</strong> Predicting a traded token\'s market cap from its TVL is not the same as predicting what an unlaunched token will be worth.</li>' +
      '<li><strong>Selection effect.</strong> The final model was selected using this same holdout, so its error is optimistic as an absolute figure; the table is a relative comparison.</li>' +
      '<li><strong>Rough heuristic, not pricing.</strong> The selected model\'s MdAPE is ' + fin.mdape.toFixed(4) + ' and its Spearman correlation ' + fin.spearman.toFixed(4) +
      ' — the board ranks, it does not price. Treat every implied value as an order-of-magnitude guess.</li></ul>';

    renderCharts();
  }

  function scatterSVG() {
    var pts = R.scatter;
    var W = 640, H = 300, padL = 56, padR = 16, padT = 14, padB = 34;
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    minX -= 0.4; maxX += 0.4; minY -= 0.4; maxY += 0.4;
    function X(v) { return padL + (v - minX) / (maxX - minX) * (W - padL - padR); }
    function Y(v) { return H - padB - (v - minY) / (maxY - minY) * (H - padT - padB); }
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Log-log scatter of TVL against market cap for the trading reporters">'];
    var i, t;
    for (i = 0; i <= 4; i++) {
      t = minX + (maxX - minX) * i / 4;
      out.push('<line x1="' + X(t).toFixed(1) + '" y1="' + Y(minY) + '" x2="' + X(t).toFixed(1) + '" y2="' + Y(maxY) + '" class="grid"/>');
      out.push('<text x="' + X(t).toFixed(1) + '" y="' + (H - 18) + '" class="tick">' + fmtUSD(Math.exp(t)) + '</text>');
      t = minY + (maxY - minY) * i / 4;
      out.push('<line x1="' + X(minX) + '" y1="' + Y(t).toFixed(1) + '" x2="' + X(maxX) + '" y2="' + Y(t).toFixed(1) + '" class="grid"/>');
      out.push('<text x="' + (padL - 8) + '" y="' + (Y(t).toFixed(1) + 4) + '" class="tick end">' + fmtUSD(Math.exp(t)) + '</text>');
    }
    out.push('<line x1="' + X(minX) + '" y1="' + Y(minY) + '" x2="' + X(maxX) + '" y2="' + Y(minY) + '" class="axis"/>');
    out.push('<line x1="' + X(minX) + '" y1="' + Y(minY) + '" x2="' + X(minX) + '" y2="' + Y(maxY) + '" class="axis"/>');
    var med = Math.log(R.median_line);
    out.push('<line x1="' + X(minX) + '" y1="' + Y(minX + med) + '" x2="' + X(maxX) + '" y2="' + Y(maxX + med) + '" class="medianline"/>');
    if (R.curve_points) {
      var d = R.curve_points.map(function (p, k) { return (k === 0 ? 'M' : 'L') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ');
      out.push('<path d="' + d + '" class="curveline"/>');
    }
    pts.forEach(function (p) {
      out.push('<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.6" class="dot"><title>' + esc(p.c) + '</title></circle>');
    });
    out.push('<text x="' + (W / 2) + '" y="' + (H - 4) + '" class="axislabel">TVL (log scale)</text>');
    out.push('<text x="14" y="' + (H / 2) + '" class="axislabel" transform="rotate(-90 14 ' + (H / 2) + ')">Market cap (log scale)</text>');
    out.push('<text x="' + (W - padR) + '" y="' + (padT + 8) + '" class="tick end">dashed: global median ×' + R.median_line.toFixed(4) + '</text>');
    out.push('</svg>');
    return out.join('');
  }

  function mdapeBarSVG() {
    var cands = R.validation.candidates.filter(function (c) { return c.stage === 'calibration'; })
      .slice().sort(function (a, b) { return a.mdape - b.mdape; });
    var rowH = 20, labelW = 210, valW = 52, W = 640;
    var H = cands.length * rowH + 30;
    var maxV = Math.max.apply(null, cands.map(function (c) { return c.mdape; })) * 1.05;
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="MdAPE comparison of the calibration candidates">'];
    cands.forEach(function (c, i) {
      var y = 8 + i * rowH;
      var w = (c.mdape / maxV) * (W - labelW - valW - 8);
      out.push('<text x="0" y="' + (y + 13) + '" class="barlabel">' + esc(c.label) + '</text>');
      out.push('<rect x="' + labelW + '" y="' + y + '" width="' + w.toFixed(1) + '" height="14" class="' + (c.adopted ? 'bar adopted' : 'bar') + '"/>');
      out.push('<text x="' + (labelW + w + 6).toFixed(1) + '" y="' + (y + 12) + '" class="tick">' + c.mdape.toFixed(3) + '</text>');
    });
    out.push('<text x="0" y="' + (H - 6) + '" class="axislabel">Pooled MdAPE, grouped 5-fold — lower is better. The adopted row is the selected model.</text>');
    out.push('</svg>');
    return out.join('');
  }

  function renderCharts() {
    document.getElementById('charts').innerHTML =
      '<h3>Evidence charts</h3>' +
      '<figure>' + scatterSVG() + '<figcaption>Each dot is one trading reporter: TVL against its market cap, both log scale. The dashed line is the global median multiple; a winning curve would draw over it.</figcaption></figure>' +
      '<figure>' + mdapeBarSVG() + '<figcaption>Calibration candidates only — ablation variants live in the table above.</figcaption></figure>';
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
    document.getElementById('sb-growth').value = R.final_spec.growth_weight;
    document.getElementById('sb-maturity').value = R.final_spec.maturity_floor;
    document.getElementById('sb-cap').value = R.model.multiple_cap;
    render();
  });

  document.getElementById('formula-text').textContent = R.model_description;
  document.getElementById('sb-growth').value = R.final_spec.growth_weight;
  document.getElementById('sb-maturity').value = R.final_spec.maturity_floor;
  document.getElementById('sb-cap').value = R.model.multiple_cap;
  lede.textContent = R.rows.length + ' protocols that record no token, ranked by what a launch would be worth if each record stayed as it is — ' +
    R.watchlist_size + ' from the watchlist floor and ' + R.early_size + ' early finds below it. Snapshot frozen ' + R.as_of +
    '. Select any row for its farm plan.';
  renderFormulaSteps();
  renderCalibration();
  renderFarmMetrics();
  renderValidation();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  render();
})();
