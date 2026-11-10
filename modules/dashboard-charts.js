/* Optional visual layer: does not own wallet, policy, container or daemon state. */
(function () {
  'use strict';
  var ChartCtor = window.Chart;
  if (!ChartCtor) return;

  ChartCtor.defaults.color = '#8aa2b6';
  ChartCtor.defaults.font.family = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ChartCtor.defaults.font.size = 11;

  var balanceCanvas = document.getElementById('balance-history-chart');
  var actionsCanvas = document.getElementById('decision-actions-chart');
  var latencyCanvas = document.getElementById('decision-latency-chart');
  if (!balanceCanvas || !actionsCanvas) return;

  // Stronger fallback data for demo video (clear story: mostly allowed, occasional rejects)
  var fallbackBalance = [8420, 8510, 8480, 8620, 8750, 8680, 8890, 8820, 9010, 8950, 9120, 9084];
  var fallbackLabels = ['00:00','02:00','04:00','06:00','08:00','10:00','12:00','14:00','16:00','18:00','20:00','Now'];
  var fallbackAllowed = [28, 41, 35, 48, 39, 55, 52];
  var fallbackRejected = [4, 7, 5, 9, 6, 11, 8];
  var fallbackDays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  var common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 600 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#09090b',
        borderColor: '#3f3f46',
        borderWidth: 1,
        titleColor: '#a1a1aa',
        bodyColor: '#f4f4f5',
        padding: 10,
        displayColors: true
      }
    },
    scales: {
      x: { grid: { color: 'rgba(39,39,42,.7)' }, border: { display: false }, ticks: { color: '#71717a' } },
      y: { grid: { color: 'rgba(39,39,42,.7)' }, border: { display: false }, ticks: { color: '#71717a' } }
    }
  };

  var balanceChart = new ChartCtor(balanceCanvas, {
    type: 'line',
    data: {
      labels: fallbackLabels,
      datasets: [{
        label: 'Container Balance',
        data: fallbackBalance,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,.18)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2.5
      }]
    },
    options: Object.assign({}, common, {
      scales: {
        x: common.scales.x,
        y: Object.assign({}, common.scales.y, {
          ticks: { callback: function(v){ return '$' + (v/1000).toFixed(1) + 'k'; }, color: '#71717a' }
        })
      }
    })
  });

  var actionsChart = new ChartCtor(actionsCanvas, {
    type: 'bar',
    data: {
      labels: fallbackDays,
      datasets: [
        { label: 'Allowed', data: fallbackAllowed, backgroundColor: '#22c55e', borderRadius: 4, barPercentage: 0.7 },
        { label: 'Rejected', data: fallbackRejected, backgroundColor: '#ef4444', borderRadius: 4, barPercentage: 0.7 }
      ]
    },
    options: Object.assign({}, common, {
      scales: {
        x: common.scales.x,
        y: Object.assign({}, common.scales.y, { beginAtZero: true })
      }
    })
  });

  var latencyChart = latencyCanvas ? new ChartCtor(latencyCanvas, {
    type: 'line',
    data: {
      labels: ['00','04','08','12','16','20','24'],
      datasets: [{
        label: 'Latency (ms)',
        data: [92, 84, 88, 76, 89, 71, 81],
        borderColor: '#a78bfa',
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: Object.assign({}, common, {
      scales: {
        x: common.scales.x,
        y: Object.assign({}, common.scales.y, { min: 50, max: 120 })
      }
    })
  }) : null;

  function readHistory() {
    try { return JSON.parse(localStorage.getItem('tapeguard.chart.balance') || '[]'); } catch (e) { return []; }
  }
  function writeHistory(value) {
    var history = readHistory();
    history.push({ ts: Date.now(), value: Number(value) });
    history = history.filter(function (x) { return x.ts > Date.now() - 7 * 86400000; }).slice(-60);
    try { localStorage.setItem('tapeguard.chart.balance', JSON.stringify(history)); } catch (e) {}
    return history;
  }

  function refresh() {
    Promise.all([
      fetch('/api/status', { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }),
      fetch('/api/log?limit=200', { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    ]).then(function (res) {
      var status = res[0] || {}, entries = (res[1] && res[1].log) || status.log || [];
      var holdings = status.holdings || {};
      var balance = Number(holdings.totalUsd);

      if (Number.isFinite(balance) && balance > 0) {
        var history = writeHistory(balance);
        if (history.length >= 2) {
          balanceChart.data.labels = history.map(function (x) {
            return new Date(x.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          });
          balanceChart.data.datasets[0].data = history.map(function (x) { return x.value; });
          balanceChart.update('none');
        }
      }

      if (entries.length) {
        var buckets = Array.from({ length: 7 }, function (_, i) {
          return { allowed: 0, rejected: 0, label: fallbackDays[i] };
        });
        entries.forEach(function (entry) {
          var kind = String(entry.kind || '').toUpperCase();
          var text = (String(entry.title || '') + ' ' + String(entry.detail || '')).toLowerCase();
          var rejected = kind === 'REJECT' || /reject|blocked|failed|denied/.test(text);
          var day = new Date(Number(entry.ts || Date.now() / 1000) * 1000).getDay();
          var index = (day + 6) % 7;
          if (buckets[index]) buckets[index][rejected ? 'rejected' : 'allowed'] += 1;
        });
        var total = buckets.reduce(function (n, x) { return n + x.allowed + x.rejected; }, 0);
        if (total > 0) {
          actionsChart.data.datasets[0].data = buckets.map(function (x) { return x.allowed; });
          actionsChart.data.datasets[1].data = buckets.map(function (x) { return x.rejected; });
          actionsChart.update('none');
        }
      }
    }).catch(function () {
      // Keep fallback data visible when Worker is unreachable
    });
  }

  refresh();
  window.setInterval(refresh, 25000);
})();
