/* Optional visual layer: does not own wallet, policy, container or daemon state. */
(function () {
  'use strict';
  var ChartCtor = window.Chart;
  if (!ChartCtor) return;

  ChartCtor.defaults.color = '#8aa2b6';
  ChartCtor.defaults.font.family = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  ChartCtor.defaults.font.size = 10;

  var balanceCanvas = document.getElementById('balance-history-chart');
  var actionsCanvas = document.getElementById('decision-actions-chart');
  var latencyCanvas = document.getElementById('decision-latency-chart');
  if (!balanceCanvas || !actionsCanvas) return;

  var fallbackBalance = [8420, 8380, 8520, 8475, 8680, 8625, 8790, 8750, 8910, 8884, 9032, 8992, 9084];
  var fallbackLabels = ['00:00','02:00','04:00','06:00','08:00','10:00','12:00','14:00','16:00','18:00','20:00','22:00','Now'];
  var fallbackAllowed = [32,46,39,54,47,61,58];
  var fallbackRejected = [7,11,8,13,9,16,12];
  var fallbackDays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var common = { responsive:true, maintainAspectRatio:false, animation:{duration:500}, plugins:{legend:{display:false}, tooltip:{backgroundColor:'#09090b', borderColor:'#3f3f46', borderWidth:1, titleColor:'#8aa2b6', bodyColor:'#f4f4f5', padding:10}}, scales:{x:{grid:{color:'rgba(39,39,42,.8)'}, border:{display:false}}, y:{grid:{color:'rgba(39,39,42,.8)'}, border:{display:false}}} };
  var balanceChart = new ChartCtor(balanceCanvas, {
    type:'line',
    data:{labels:fallbackLabels, datasets:[{label:'Balance', data:fallbackBalance, borderColor:'#22c55e', backgroundColor:'rgba(34,197,94,.15)', fill:true, tension:.38, pointRadius:0, pointHoverRadius:4, borderWidth:2}]},
    options:Object.assign({}, common, {scales:{x:common.scales.x, y:Object.assign({}, common.scales.y, {ticks:{callback:function(v){return '$'+(v/1000).toFixed(1)+'k';}}})}})
  });
  var actionsChart = new ChartCtor(actionsCanvas, {
    type:'bar',
    data:{labels:fallbackDays, datasets:[{label:'Allowed',data:fallbackAllowed,backgroundColor:'#22c55e',borderRadius:3},{label:'Rejected',data:fallbackRejected,backgroundColor:'#ef4444',borderRadius:3}]},
    options:Object.assign({}, common, {scales:{x:common.scales.x, y:Object.assign({}, common.scales.y, {beginAtZero:true})}})
  });
  var latencyChart = latencyCanvas ? new ChartCtor(latencyCanvas, {
    type:'line',
    data:{labels:['00','04','08','12','16','20','24'],datasets:[{label:'Latency',data:[94,83,86,79,91,74,81],borderColor:'#a78bfa',tension:.35,pointRadius:0,borderWidth:2}]},
    options:Object.assign({}, common, {scales:{x:common.scales.x,y:Object.assign({}, common.scales.y, {min:50,max:110})}})
  }) : null;

  function readHistory() {
    try { return JSON.parse(localStorage.getItem('tapeguard.chart.balance') || '[]'); } catch (e) { return []; }
  }
  function writeHistory(value) {
    var history = readHistory();
    history.push({ ts: Date.now(), value: Number(value) });
    history = history.filter(function (x) { return x.ts > Date.now() - 7 * 86400000; }).slice(-48);
    try { localStorage.setItem('tapeguard.chart.balance', JSON.stringify(history)); } catch (e) {}
    return history;
  }
  function refresh() {
    var base = location.pathname.indexOf('/') === 0 ? '' : '';
    Promise.all([
      fetch(base + '/api/status', { headers:{Accept:'application/json'} }).then(function (r) { if (!r.ok) throw new Error('status '+r.status); return r.json(); }),
      fetch(base + '/api/log?limit=120', { headers:{Accept:'application/json'} }).then(function (r) { if (!r.ok) throw new Error('log '+r.status); return r.json(); })
    ]).then(function (res) {
      var status = res[0] || {}, entries = (res[1] && res[1].log) || status.log || [];
      var holdings = status.holdings || {};
      var balance = Number(holdings.totalUsd);
      if (Number.isFinite(balance) && balance >= 0) {
        var history = writeHistory(balance);
        if (history.length >= 2) {
          balanceChart.data.labels = history.map(function (x) { return new Date(x.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); });
          balanceChart.data.datasets[0].data = history.map(function (x) { return x.value; });
          balanceChart.update();
        }
      }
      if (entries.length) {
        var buckets = Array.from({length:7}, function (_, i) { return { allowed:0, rejected:0, label:fallbackDays[i] }; });
        entries.forEach(function (entry) {
          var kind = String(entry.kind || '').toUpperCase();
          var rejected = kind === 'REJECT' || /reject|blocked|failed/i.test(String(entry.title || '') + ' ' + String(entry.detail || ''));
          var day = new Date(Number(entry.ts || 0) * 1000).getDay();
          var index = (day + 6) % 7;
          if (buckets[index]) buckets[index][rejected ? 'rejected' : 'allowed'] += 1;
        });
        var total = buckets.reduce(function (n, x) { return n + x.allowed + x.rejected; }, 0);
        if (total) {
          actionsChart.data.labels = buckets.map(function (x) { return x.label; });
          actionsChart.data.datasets[0].data = buckets.map(function (x) { return x.allowed; });
          actionsChart.data.datasets[1].data = buckets.map(function (x) { return x.rejected; });
          actionsChart.update();
        }
      }
    }).catch(function () { /* demo fallback remains visible when the Worker is unreachable */ });
  }
  refresh();
  window.setInterval(refresh, 30000);
})();
