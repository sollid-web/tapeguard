import { $, $$, mk, short, clean0x, uid, now, clock, dayfmt, fmtNum, fmtUnits, parseUnits, randHash, randAddr, utf8, bytesToHex, hexToBytes } from './core.js';
import { ABI_OK, encodeCall, decodeOutputs, parseInput, keccak256, word } from './codec.js';
import { CFG, CONFIG_WARNINGS, CONTRACTS, CONTRACT_NAMES, LIVE, API, CHAIN_ID, CHAINS, CHAIN } from './config.js';
import { DEMO, SEL, lsGet, lsSet, defaultState } from './state.js';
import { triggerThreshold, feeTotal } from './finance.js';
import { createPolicy } from './policy.js';
import { safeRpcUrl } from './rpc.js';

(function(){
'use strict';

/* =========================================================================
   0. Config injected by the app after deploy (never hardcoded here)
   ========================================================================= */


/* =========================================================================
   1. Helpers
   ========================================================================= */
function copy(text, label){
  var done = function(){ toast((label||'Copied')+' ✓'); };
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, fallback); return; }
  }catch(e){}
  fallback();
  function fallback(){
    try{
      var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
    }catch(e){ toast('Copy failed'); }
  }
}


var toastTimer=null;
function toast(msg){
  var n=$('#notice'); if(!n) return;
  n.hidden=false; n.className='notice ok'; n.textContent=msg;
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ if(n.dataset.keep!=='1') n.hidden=true; }, 2600);
}

/* =========================================================================
   2. Minimal keccak-256 + ABI codec (no external libraries)
   ========================================================================= */

var S;
(function load(){
  var raw = lsGet();
  if(raw){
    try{
      S = JSON.parse(raw);
      var d = defaultState();
      for(var k in d){ if(!(k in S)) S[k]=d[k]; }
      if(!S.market || typeof S.market.price!=='number') S.market = d.market;
      if(!S.market.history) S.market.history=[];
    }catch(e){ S = defaultState(); }
  } else { S = defaultState(); }
})();
function persist(){ try{ lsSet(JSON.stringify(S)); }catch(e){} }
function containerAddr(){ return (S.wallet.address && LIVE) ? (S.agent.container || null) : (S.agent.container || (LIVE?null:DEMO.container)); }
function allowlist(){ return S.policy.allowlist; }
policy = createPolicy({ getState:function(){ return S; }, chain:CHAIN, containerAddr:containerAddr, chainId:CHAIN_ID, selectors:SEL, now:now });

/* =========================================================================
   4. Chain access
   ========================================================================= */
/* An RPC URL typed into a page is only accepted when it is a plain https endpoint:
   no credentials, no javascript:, no plain http. Anything else is ignored so an
   injected value cannot redirect every read of the app. */
var USER_RPC = (function(){
  var raw = null;
  try{ raw = localStorage.getItem('tapeout.rpc'); }catch(e){ return null; }
  if(!raw) return null;
  var safe = safeRpcUrl(raw);
  if(!safe){ try{ localStorage.removeItem('tapeout.rpc'); }catch(e){} }
  return safe;
})();
function rpcUrl(){ return API ? API+'/api/rpc' : (USER_RPC || null); }
function chainRpc(method, params){
  var wp = activeProvider();
  if(wp && S.wallet.address){
    return wp.request({ method: method, params: params });
  }
  if(rpcUrl()){
    return fetch(rpcUrl(), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id: now(), method: method, params: params })
    }).then(function(r){ return r.json(); }).then(function(j){
      if(j && j.error) throw new Error(j.error.message || 'RPC error');
      return j.result;
    });
  }
  return Promise.reject(new Error('No RPC endpoint: connect a wallet on '+CHAIN.name+' to read live state.'));
}
function callView(addr, item, args){
  var enc = encodeCall(item, args||[]);
  return chainRpc('eth_call', [{ to: addr, data: enc.data }, 'latest']).then(function(res){
    return decodeOutputs(item.outputs||[], res);
  });
}
/* Every write goes through this: the wallet's current chain is re-read right before
   the transaction, so a wallet switched in another tab cannot silently send on
   another chain. */
function ensureChain(){
  var wp = activeProvider();
  if(!wp) return Promise.reject(new Error('Connect a wallet first.'));
  return wp.request({ method:'eth_chainId' }).then(function(id){
    var got = parseInt(id, 16);
    if(got === CHAIN_ID) return true;
    return wp.request({ method:'wallet_switchEthereumChain', params:[{ chainId:'0x'+CHAIN_ID.toString(16) }] })
      .then(function(){ return true; })
      .catch(function(){
        throw new Error('Your wallet is on chain '+got+'. Add/switch to '+CHAIN.name+' ('+CHAIN_ID+') before sending.');
      });
  });
}
function sendTx(addr, item, args, valueWei){
  var wp = activeProvider();
  if(!wp || !S.wallet.address) return Promise.reject(new Error('Connect a wallet first.'));
  var enc = encodeCall(item, args||[]);
  var value = '0x0';
  try{ if(valueWei && BigInt(valueWei) > 0n) value = '0x' + BigInt(valueWei).toString(16); }catch(e){ value = '0x0'; }
  return ensureChain().then(function(){
    return wp.request({ method:'eth_sendTransaction', params:[{ from:S.wallet.address, to:addr, data: enc.data, value: value }] });
  });
}
/* Plain native transfer (no calldata): used to fund the container. */
function sendNative(to, valueWei){
  var wp = activeProvider();
  if(!wp || !S.wallet.address) return Promise.reject(new Error('Connect a wallet first.'));
  var value = '0x' + BigInt(valueWei).toString(16);
  return ensureChain().then(function(){
    return wp.request({ method:'eth_sendTransaction', params:[{ from:S.wallet.address, to:to, value: value }] });
  });
}

/* =========================================================================
   5. Policy engine (local mirror of the circuit rules)
   ========================================================================= */
var policy;

/* =========================================================================
   6. Activity log
   ========================================================================= */
function log(kind, title, detail, extra){
  var e = { t: now(), kind: kind, title: title, detail: detail || '' };
  if(extra){ for(var k in extra) e[k]=extra[k]; }
  S.activity.unshift(e);
  if(S.activity.length > 400) S.activity.length = 400;
  renderFeed(); renderDaemon();
  return e;
}
function feedNode(e){
  var box = mk('div','ev '+e.kind);
  var t = mk('div','t');
  t.appendChild(mk('span',null,clock(e.t)));
  t.appendChild(mk('span','pill',e.kind));
  if(e.hash) t.appendChild(mk('span','pill',short(e.hash)));
  box.appendChild(t);
  box.appendChild(mk('div','ti', e.title));
  if(e.detail) box.appendChild(mk('div','de', e.detail));
  return box;
}
function renderFeed(){
  var host = $('#ov-feed'); if(!host) return;
  host.textContent='';
  var f = S.filters||'all';
  var list = S.activity.filter(function(e){ return f==='all' ? true : e.kind===f; }).slice(0,80);
  if(!list.length){ host.appendChild(mk('div','small dim','No events yet. Start the daemon or run the demo.')); }
  list.forEach(function(e){ host.appendChild(feedNode(e)); });
  var c = $('#ov-act'); if(c) c.textContent = S.activity.length+' events';
}

/* =========================================================================
   7. Overview rendering
   ========================================================================= */
function statCard(k, v, s, cls){
  var d = mk('div','stat');
  d.appendChild(mk('div','k',k));
  var vv = mk('div','v',v); if(cls) vv.className='v '+cls;
  d.appendChild(vv);
  if(s) d.appendChild(mk('div','s',s));
  return d;
}
function renderOverview(){
  var h = $('#ov-stats'); if(!h) return;
  h.textContent='';
  var p = S.policy;
  var spent = policy.spentInWindow(), cap = BigInt(p.dailyLimit);
  var bal = BigInt(S.balance.OKB);
  var ok = S.daemon.running;
  var rv = feeTotal(S.fees.ledger, S.fees.activation, S.fees.paid);
  h.appendChild(statCard('Container balance', fmtUnits(bal,4)+' '+CHAIN.sym, 'USDT '+fmtUnits(S.balance.USDT,2)+' · '+short(containerAddr()||'not bound')));
  h.appendChild(statCard('Daily volume used', fmtUnits(spent,4)+' / '+fmtUnits(cap,4), 'rolling 24h window · cap '+fmtUnits(p.maxPerTx,3)+' '+CHAIN.sym+' per tx'));
  h.appendChild(statCard('Daemon', ok ? 'RUNNING' : 'STOPPED', (S.daemon.ticks||0)+' ticks · '+S.triggers.length+' triggers', ok?null:null));
  h.appendChild(statCard('Fees credited', fmtUnits(rv,4)+' USDT', 'activation + '+(S.fees.bps/100).toFixed(2)+'% of executed volume'));

  var cards = $('#ov-cards'); cards.textContent='';
  /* policy summary */
  var c1 = mk('div','card');
  c1.appendChild(mk('h3',null,'Policy circuit'));
  var k1 = mk('div');
  [['Circuit ID', S.agent.circuitId],['Max per tx', fmtUnits(p.maxPerTx)+' '+CHAIN.sym],['24h volume cap', fmtUnits(p.dailyLimit)+' '+CHAIN.sym],
   ['Allowed targets', String(p.allowlist.length)],['Paused', p.paused ? 'true' : 'false']].forEach(function(r){
    var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); k1.appendChild(row);
  });
  c1.appendChild(k1);
  cards.appendChild(c1);
  /* container summary */
  var c2 = mk('div','card');
  c2.appendChild(mk('h3',null,'Container'));
  var k2 = mk('div');
  [['Address', short(containerAddr()||'not bound')],['Executions', String(S.activity.filter(function(e){return e.kind==='EXEC';}).length)],
   ['Rejections', String(S.activity.filter(function(e){return e.kind==='REJECT';}).length)],['Binding','circuit container (ERC-6551-style)']].forEach(function(r){
    var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); k2.appendChild(row);
  });
  c2.appendChild(k2);
  cards.appendChild(c2);
  /* chain summary */
  var c3 = mk('div','card');
  c3.appendChild(mk('h3',null,'Chain & tape-out'));
  var k3 = mk('div');
  [['Network', CHAIN.name+' ('+CHAIN_ID+')'],['Policy processor', primaryContract() ? short(primaryContract().address) : 'not deployed'],
   ['Contract source', LIVE ? 'live reads enabled' : 'demo simulation'],['Block height', String(S.market.blockHeight)]].forEach(function(r){
    var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); k3.appendChild(row);
  });
  c3.appendChild(k3);
  cards.appendChild(c3);
  renderMarket();
}

/* --- market simulation + chart --- */
function advanceMarket(){
  var m = S.market;
  m.price = Math.max(20, Math.min(200, m.price - 0.09 + (Math.random()-0.5)*0.44));
  m.history.push(Number(m.price.toFixed(3)));
  if(m.history.length > 120) m.history.shift();
  m.blockHeight += 1;
  if(Math.random() < 0.25) m.tasksMinted += Math.floor(Math.random()*4);
  if(Math.random() < 0.15) m.activeMiners = Math.max(10, m.activeMiners + (Math.random()<0.5?-1:1));
}
function renderMarket(){
  var c = $('#ov-price'); if(!c) return;
  var p = S.market.price, thr = triggerThreshold(S.triggers);
  c.textContent = 'OKB/USD '+p.toFixed(2);
  c.className = 'chip ' + (p<=thr ? 'ok' : '');
  var m = $('#ov-market');
  if(m){
    m.textContent = 'blocks '+S.market.blockHeight+' · TapeOut tasks '+S.market.tasksMinted+' · active miners '+S.market.activeMiners+
      ' · nearest trigger at '+thr.toFixed(2)+(S.daemon.running?' · daemon live':' · daemon stopped');
  }
  drawChart();
}
function drawChart(){
  var cv = $('#price-chart'); if(!cv || !cv.getContext) return;
  var w = cv.clientWidth || 400, dpr = window.devicePixelRatio || 1, hgt = 130;
  cv.width = Math.floor(w*dpr); cv.height = Math.floor(hgt*dpr);
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,hgt);
  var hist = S.market.history.slice(-90); if(hist.length<2) hist=[S.market.price-0.5, S.market.price];
  var thr = triggerThreshold(S.triggers);
  var lo = Math.min.apply(null, hist.concat([thr])) - 0.4;
  var hi = Math.max.apply(null, hist.concat([thr])) + 0.4;
  function X(i){ return (i/(hist.length-1))*w; }
  function Y(v){ return hgt - ((v-lo)/(hi-lo))*hgt; }
  ctx.strokeStyle = 'rgba(255,184,77,.6)'; ctx.setLineDash([4,4]); ctx.beginPath();
  ctx.moveTo(0,Y(thr)); ctx.lineTo(w,Y(thr)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#25e08b'; ctx.lineWidth = 1.6; ctx.beginPath();
  hist.forEach(function(v,i){ if(i===0) ctx.moveTo(X(i),Y(v)); else ctx.lineTo(X(i),Y(v)); });
  ctx.stroke();
  var g = ctx.createLinearGradient(0,0,0,hgt);
  g.addColorStop(0,'rgba(37,224,139,.22)'); g.addColorStop(1,'rgba(37,224,139,0)');
  ctx.lineTo(w,hgt); ctx.lineTo(0,hgt); ctx.closePath(); ctx.fillStyle=g; ctx.fill();
}

/* =========================================================================
   8. Policy view
   ========================================================================= */
function renderPolicy(){
  var id = $('#pol-identity'); if(!id) return;
  id.textContent='';
  var pc = primaryContract();
  [['Circuit ID', S.agent.circuitId],['Policy id (hash)', S.agent.policyId],['Container', containerAddr()||'not bound'],
   ['Policy processor', pc ? pc.address : 'not deployed — demo simulation'],['Circuit owner', S.policy.owner]].forEach(function(r){
    var row = mk('div','kv');
    var a = mk('span',null,r[0]);
    var b = mk('span',null,'');
    if(r[0]==='Circuit ID') b.setAttribute('data-copy-anchor','circuit');
    if(r[0]==='Container') b.setAttribute('data-copy-anchor','container');
    b.textContent = String(r[1]);
    row.appendChild(a); row.appendChild(b); id.appendChild(row);
  });
  var mode = $('#pol-mode');
  mode.textContent = LIVE ? 'LIVE' : 'LOCAL MIRROR';
  mode.className = 'chip '+(LIVE?'live':'');

  var p = S.policy, spent = policy.spentInWindow(), cap = BigInt(p.dailyLimit);
  var pct = cap>0n ? Number((spent*1000n/cap))/10 : 0;
  var win = $('#pol-window'); win.textContent = 'spent '+fmtUnits(spent,3)+' / '+fmtUnits(cap,3);
  var r = $('#pol-rules'); r.textContent='';
  function ruleRow(name, value, detail, okCls){
    var row = mk('div','rule');
    var d = mk('div','dot '+(okCls?'p':'f')); d.textContent = okCls?'✓':'!';
    var body = mk('div');
    body.appendChild(mk('div',null,name+' — '));
    body.lastChild.appendChild(mk('span','mono',String(value)));
    body.appendChild(mk('div','small dim',detail));
    row.appendChild(d); row.appendChild(body); return row;
  }
  r.appendChild(ruleRow('Pause flag', p.paused?'PAUSED':'ACTIVE', p.paused?'Circuit halted — every proposal is rejected':'Circuit live, proposals are evaluated', !p.paused));
  r.appendChild(ruleRow('Max per transaction', fmtUnits(p.maxPerTx)+' '+CHAIN.sym, 'hard cap enforced on every single execution', true));
  r.appendChild(ruleRow('Rolling 24h cap', fmtUnits(p.dailyLimit)+' '+CHAIN.sym, 'used '+fmtUnits(spent,3)+' '+CHAIN.sym+' ('+pct.toFixed(1)+'%)', pct<100));
  r.appendChild(ruleRow('Validity window', p.expiry? dayfmt(p.expiry) : 'no expiry', p.expiry? 'circuit refuses to execute after this date' : 'circuit stays valid until revoked', !p.expiry || now()<p.expiry));
  r.appendChild(ruleRow('Allowed targets', S.policy.allowlist.length+' entries', 'only these addresses (and selectors) may be called', true));
  var bar = mk('div','bar'); var fill = mk('i'); fill.style.width = Math.min(100,pct)+'%'; bar.appendChild(fill);
  r.appendChild(bar);
  drawAllowlist();
  fillSimTargets();
}
function drawAllowlist(){
  var t = $('#pol-allowlist'); if(!t) return;
  t.textContent='';
  var head = mk('tr');
  ['Label','Target','Selectors',''].forEach(function(x){ head.appendChild(mk('th',null,x)); });
  t.appendChild(head);
  S.policy.allowlist.forEach(function(a, i){
    var tr = mk('tr');
    tr.appendChild(mk('td',null,a.label));
    tr.appendChild(mk('td','mono',short(a.target)));
    tr.appendChild(mk('td','mono',(a.selectors&&a.selectors.length)?a.selectors.join(', '):'any'));
    var td = mk('td'); var b = mk('button','btn sm danger','Remove');
    b.onclick = function(){ S.policy.allowlist.splice(i,1); log('CONFIG','Allowlist updated','Removed '+a.label); persist(); renderPolicy(); renderOverview(); };
    td.appendChild(b); tr.appendChild(td);
    t.appendChild(tr);
  });
  var c = $('#pol-al-count'); if(c) c.textContent = S.policy.allowlist.length+' allowed';
}
function fillSimTargets(){
  var sels = [$('#sim-target'), $('#tg-target')];
  sels.forEach(function(sel){
    if(!sel) return;
    var cur = sel.value; sel.textContent='';
    S.policy.allowlist.forEach(function(a){
      var o = mk('option',null,a.label+' · '+short(a.target)); o.value = a.target; sel.appendChild(o);
    });
    if(LIVE){ var o2 = mk('option',null,'custom address…'); o2.value='__custom'; sel.appendChild(o2); }
    if(cur){ try{ sel.value = cur; }catch(e){} }
  });
}
function policyResultNode(res, action){
  var box = mk('div','card');
  var head = mk('div','card-h');
  head.appendChild(mk('h3',null,'Policy verdict'));
  var chip = mk('span','chip '+(res.ok?'ok':'bad'), res.ok ? 'APPROVED · '+res.passed+'/'+res.total+' rules' : 'REJECTED · '+res.code);
  head.appendChild(chip); box.appendChild(head);
  res.checks.forEach(function(c){
    var row = mk('div','rule');
    var d = mk('div','dot '+(c.pass?'p':'f')); d.textContent = c.pass?'✓':'✕';
    var body = mk('div');
    body.appendChild(mk('div',null,c.name));
    body.appendChild(mk('div','small dim',c.detail));
    row.appendChild(d); row.appendChild(body); box.appendChild(row);
  });
  box.appendChild(mk('div','small dim mt', res.ok
    ? 'The container would now submit '+short(action.target)+' with '+fmtUnits(action.value)+' '+CHAIN.sym+' · memo "'+(action.memo||'')+'"'
    : 'Execution blocked by the circuit: '+res.reason));
  return box;
}
function currentSimAction(){
  var tv = $('#sim-target'), v = $('#sim-value'), s = $('#sim-sel'), mm = $('#sim-memo');
  var target = tv.value;
  if(target==='__custom') target = window.prompt('Target address (0x…)') || '';
  var entry = null;
  S.policy.allowlist.forEach(function(a){ if(a.target.toLowerCase()===String(target).toLowerCase()) entry = a; });
  var sel = (s.value||'').trim().toLowerCase();
  if(!sel && entry && entry.selectors && entry.selectors.length) sel = entry.selectors[0];
  return {
    target: target,
    targetLabel: entry ? entry.label : short(target),
    selector: sel,
    value: parseUnits(v.value||'0').toString(),
    memo: mm.value || ''
  };
}

/* =========================================================================
   9. Daemon
   ========================================================================= */
function renderDaemon(){
  var st = $('#dm-stats'); if(!st) return;
  st.textContent='';
  var approved = S.activity.filter(function(e){ return e.kind==='POLICY'; }).length;
  var rejected = S.activity.filter(function(e){ return e.kind==='REJECT'; }).length;
  var exec = S.activity.filter(function(e){ return e.kind==='EXEC'; }).length;
  st.appendChild(statCard('Daemon state', S.daemon.running?'RUNNING':'STOPPED', S.daemon.running? 'since '+clock(S.daemon.startedAt) : 'start it to watch triggers', null));
  st.appendChild(statCard('Ticks', String(S.daemon.ticks||0), 'restart-safe · '+S.daemon.resumes+' resumes'));
  st.appendChild(statCard('Approved / rejected', approved+' / '+rejected, 'circuit decisions so far'));
  st.appendChild(statCard('Executions', String(exec), 'submitted through the container'));
  var s = $('#dm-status');
  s.textContent = S.daemon.running?'running':'stopped';
  s.className = 'chip '+(S.daemon.running?'ok':'');
  var tl = $('#dm-timeline');
  if(tl){
    tl.textContent='';
    var last = S.daemon.lastTick ? new Date(S.daemon.lastTick).toLocaleString() : 'never';
    [['Last tick', last],['Tick interval','2 s'],['Persistence','localStorage (survives reload)'],['Log size', S.activity.length+' entries']].forEach(function(r){
      var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); tl.appendChild(row);
    });
  }
  drawTriggers();
  var df = $('#dm-feed');
  if(df){
    df.textContent='';
    var list = S.activity.filter(function(e){ return ['TRIGGER','POLICY','EXEC','REJECT'].indexOf(e.kind)>=0; }).slice(0,60);
    if(!list.length) df.appendChild(mk('div','small dim','No decisions yet.'));
    list.forEach(function(e){ df.appendChild(feedNode(e)); });
  }
  var lc = $('#dm-log-count'); if(lc) lc.textContent = S.activity.length+' entries';
  var tc = $('#dm-tg-count'); if(tc) tc.textContent = S.triggers.length+' triggers';
}
function drawTriggers(){
  var h = $('#dm-triggers'); if(!h) return;
  h.textContent='';
  if(!S.triggers.length) h.appendChild(mk('div','small dim','No triggers. Add one below.'));
  S.triggers.forEach(function(g){
    var box = mk('div','ev TRIGGER'); box.style.marginBottom='8px';
    var t = mk('div','t');
    t.appendChild(mk('span','pill', g.type.toUpperCase()));
    t.appendChild(mk('span','pill', g.enabled?'enabled':'disabled'));
    if(g.lastFired) t.appendChild(mk('span','pill','last '+clock(g.lastFired)));
    box.appendChild(t);
    var cond = g.type==='price' ? ('OKB/USD '+g.op+' '+Number(g.threshold).toFixed(2))
      : g.type==='time' ? ('every '+Math.round(g.intervalMs/1000)+'s')
      : g.type==='block' ? ('every '+g.blocks+' blocks')
      : 'p(tape-out event) = '+g.p;
    box.appendChild(mk('div','ti', g.name));
    box.appendChild(mk('div','de', cond+' → '+g.action.label+' · '+fmtUnits(g.action.value)+' '+CHAIN.sym+' → '+short(g.action.target)+' · cooldown '+Math.round(g.cooldownMs/1000)+'s'));
    var row = mk('div','row mt');
    var b1 = mk('button','btn sm', g.enabled?'Disable':'Enable');
    b1.onclick = function(){ g.enabled = !g.enabled; persist(); renderDaemon(); };
    var b2 = mk('button','btn sm','Fire now');
    b2.onclick = function(){ fireTrigger(g, 'manual'); };
    var b3 = mk('button','btn sm danger','Delete');
    b3.onclick = function(){ S.triggers = S.triggers.filter(function(x){ return x.id!==g.id; }); persist(); renderDaemon(); };
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3); box.appendChild(row);
    h.appendChild(box);
  });
}
function fireTrigger(g, why){
  var a = g.action;
  var action = {
    label: a.label, target: a.target, targetLabel: a.targetLabel, selector: a.selector,
    value: a.value, memo: a.memo, receiveUsdt: a.receiveUsdt
  };
  return proposeAndRun(action, g.name+' · '+why);
}
function proposeAndRun(action, sourceLabel){
  log('TRIGGER', sourceLabel || 'Trigger fired',
      action.label+' → '+fmtUnits(action.value)+' '+CHAIN.sym+' to '+short(action.target)+(action.memo?' · "'+action.memo+'"':''),
      { trigger: sourceLabel });
  if(!LIVE){
    var res = policy.evaluate(action);
    log(res.ok?'POLICY':'REJECT', res.ok?('Policy circuit approved — '+res.passed+'/'+res.total+' rules') : ('Policy circuit rejected — '+res.code),
        res.ok ? ('per-tx '+fmtUnits(action.value)+' '+CHAIN.sym+' · 24h used '+fmtUnits(policy.spentInWindow())+' / '+fmtUnits(S.policy.dailyLimit)+' '+CHAIN.sym)
               : res.reason);
    if(!res.ok) return false;
    return executeDemo(action, res);
  }
  return executeLive(action);
}
function executeDemo(action, res){
  var a = S.policy.allowlist.filter(function(x){ return x.target.toLowerCase()===String(action.target).toLowerCase(); })[0];
  var v = BigInt(action.value), bal = BigInt(S.balance.OKB);
  var gas = parseUnits('0.00021');
  if(bal < v+gas){
    log('REJECT','Insufficient container balance','needed '+fmtUnits(v+gas)+' '+CHAIN.sym+', container holds '+fmtUnits(bal)+' '+CHAIN.sym);
    return false;
  }
  var hash = randHash();
  var fee = v * BigInt(Math.round(S.fees.bps)) / 10000n;
  S.balance.OKB = (bal - v - gas).toString();
  if(action.receiveUsdt){ S.balance.USDT = (BigInt(S.balance.USDT) + BigInt(action.receiveUsdt)).toString(); }
  S.spend.push({ at: now(), amount: v.toString() });
  S.fees.ledger.unshift({ t: now(), kind:'performance', amount: fee.toString(), hash: hash });
  if(S.fees.ledger.length>200) S.fees.ledger.length=200;
  var txe = {
    t: now(), dir:'OUT', hash: hash, to: action.target, targetLabel: action.targetLabel || short(action.target),
    amount: fmtUnits(v)+' '+CHAIN.sym, memo: action.memo || '', status:'confirmed', gas: fmtUnits(gas,6)
  };
  log('EXEC','Executed through container', short(containerAddr())+' → '+short(action.target)+' · '+fmtUnits(v)+' '+CHAIN.sym+' · tx '+short(hash)+' · gas '+fmtUnits(gas,6)+' '+CHAIN.sym,
      { hash: hash, action: action, tx: txe });
  S.lastTx = txe;
  if(!S.txs) S.txs = [];
  S.txs.unshift(txe);
  if(S.txs.length>200) S.txs.length=200;
  persist();
  renderOverview(); renderContainer(); renderRevenue();
  return true;
}
function executeLive(action){
  var pc = primaryContract();
  if(!pc){ log('REJECT','No contract configured','Deploy a policy processor to execute on-chain.'); return Promise.resolve(false); }
  var item = null;
  Object.keys(pc.abiByName||{}).forEach(function(n){ if(!item && /^(execute|submit|run|dispatch)/i.test(n)) item = pc.abiByName[n]; });
  log('POLICY','Submitting to '+pc.name, item ? ('calling '+item.name+'()') : 'no execute function detected — exporting execution request only');
  var req = policy.buildExecutionRequest(action);
  S.pending.unshift(req); if(S.pending.length>50) S.pending.length=50; persist(); renderContainer();
  if(!item) return Promise.resolve(false);
  var args = (item.inputs||[]).map(function(inp){
    if(inp.type==='address') return action.target;
    if(/^u?int/.test(inp.type)) return BigInt(action.value||0);
    if(inp.type==='bytes') return req.calldata;
    return action.memo || '';
  });
  return sendTx(pc.address, item, args).then(function(hash){
    log('EXEC','Transaction sent', short(hash)+' · from '+short(S.wallet.address), { hash: hash });
    S.wallet.lastHash = hash; persist();
    return true;
  }).catch(function(err){
    log('REJECT','Transaction failed', String(err && err.message || err));
    return false;
  });
}
function tick(){
  if(!LIVE) advanceMarket();
  var m = S.market;
  if(LIVE && S.daemon.running && (S.daemon.ticks % 5 === 0)){
    chainRpc('eth_blockNumber', []).then(function(h){
      try{ m.blockHeight = Number(BigInt(h)); }catch(e){}
    }).catch(function(){});
  }
  if(S.daemon.running){
    S.daemon.ticks = (S.daemon.ticks||0)+1;
    S.daemon.lastTick = now();
    S.triggers.forEach(function(g){
      if(!g.enabled) return;
      if(now() - (g.lastFired||0) < (g.cooldownMs||0)) return;
      var fired = false, why='';
      if(g.type==='price'){ var p = m.price; fired = g.op==='<=' ? p<=g.threshold : p>=g.threshold;
        why = 'OKB/USD '+p.toFixed(2)+' '+g.op+' '+Number(g.threshold).toFixed(2); }
      else if(g.type==='time'){ fired = now()-(g.lastFired||0) >= (g.intervalMs||60000); why = 'interval '+Math.round((g.intervalMs||60000)/1000)+'s'; }
      else if(g.type==='block'){ fired = m.blockHeight-(g.lastBlock||0) >= (g.blocks||10); why = 'block '+m.blockHeight+' (+'+g.blocks+')'; }
      else if(g.type==='event'){ fired = Math.random() < (g.p||0.05); why = 'TapeOut task batch minted (tasks '+m.tasksMinted+')'; }
      if(fired){ g.lastFired = now(); g.lastBlock = m.blockHeight; fireTrigger(g, why); }
    });
    persist();
  }
  renderMarket(); renderOverviewStatsOnly();
}
function renderOverviewStatsOnly(){
  var h = $('#ov-stats'); if(!h || !h.children.length) return;
  var spent = policy.spentInWindow(), cap = BigInt(S.policy.dailyLimit);
  var cells = h.children;
  if(cells[0]) cells[0].querySelector('.v').textContent = fmtUnits(S.balance.OKB,4)+' '+CHAIN.sym;
  if(cells[1]) cells[1].querySelector('.v').textContent = fmtUnits(spent,4)+' / '+fmtUnits(cap,4);
  if(cells[2]) cells[2].querySelector('.v').textContent = S.daemon.running?'RUNNING':'STOPPED';
  var dm = $('#dm-status'); if(dm) dm.textContent = S.daemon.running?'running':'stopped';
  var ct = $('#ct-stats');
  if(ct && ct.children.length){
    ct.children[0].querySelector('.v').textContent = fmtUnits(S.balance.OKB,4)+' '+CHAIN.sym;
    if(ct.children[1]) ct.children[1].querySelector('.v').textContent = fmtUnits(S.balance.USDT,2)+' USDT';
  }
  var rc = $('#rv-stats');
  if(rc && rc.children.length){ rc.children[0].querySelector('.v').textContent = fmtUnits(feeTotal(S.fees.ledger, S.fees.activation, S.fees.paid),4)+' USDT'; }
  var mc = $('#chip-mode');
  if(mc){ mc.textContent = (S.daemon.running?'● daemon live · ':'')+(LIVE?'LIVE CONTRACTS':'DEMO SIMULATION'); mc.className = 'chip '+(LIVE?'live':'warn'); }
}
function startDaemon(){
  S.daemon.running = true;
  S.daemon.startedAt = now();
  log('CONFIG','Daemon started','watching '+S.triggers.length+' triggers · interval 2s · circuit '+S.agent.circuitId);
  persist(); renderDaemon(); renderOverviewStatsOnly(); renderStart();
}
function stopDaemon(){
  S.daemon.running = false;
  log('CONFIG','Daemon stopped','state persisted — a reload would resume it if it were still running');
  persist(); renderDaemon(); renderOverviewStatsOnly(); renderStart();
}
/* =========================================================================
   10. Container view
   ========================================================================= */
function renderContainer(){
  var h = $('#ct-stats'); if(!h) return;
  h.textContent='';
  h.appendChild(statCard('OKB balance', fmtUnits(S.balance.OKB,4)+' '+CHAIN.sym, 'held by the circuit container'));
  h.appendChild(statCard('USDT balance', fmtUnits(S.balance.USDT,2)+' USDT', 'revenue token for fees'));
  h.appendChild(statCard('Executions', String(S.activity.filter(function(e){return e.kind==='EXEC';}).length), 'submitted by the daemon'));
  var a = $('#ct-address'); a.textContent='';
  [['Container address', containerAddr()||'not bound yet'],['Binding','ERC-6551-style account owned by the circuit'],
   ['Circuit ID', S.agent.circuitId],['Private key','none — keyless execution'],['Policy id', S.agent.policyId]].forEach(function(r){
    var row = mk('div','kv');
    var s1 = mk('span',null,r[0]);
    var s2 = mk('span',null,r[1]);
    if(r[0]==='Container address') s2.setAttribute('data-copy-anchor','container');
    row.appendChild(s1); row.appendChild(s2); a.appendChild(row);
  });
  var kind = $('#ct-kind'); kind.textContent = LIVE?'bound to deployed processor':'simulated binding';

  var t = $('#ct-txs'); t.textContent='';
  var head = mk('tr'); ['Time','Direction','To','Amount','Memo','Tx','Status'].forEach(function(x){ head.appendChild(mk('th',null,x)); }); t.appendChild(head);
  var txs = S.txs || [];
  if(!txs.length){ var tr = mk('tr'); var td = mk('td','dim','No container transactions yet.');
    td.colSpan = 7; tr.appendChild(td); t.appendChild(tr); }
  txs.slice(0,60).forEach(function(x){
    var tr = mk('tr');
    tr.appendChild(mk('td',null,clock(x.t)));
    tr.appendChild(mk('td',null,x.dir));
    tr.appendChild(mk('td','mono',x.targetLabel+' '+short(x.to)));
    tr.appendChild(mk('td',null,x.amount));
    tr.appendChild(mk('td',null,x.memo||'—'));
    tr.appendChild(mk('td','mono',short(x.hash)));
    var st = mk('td'); st.appendChild(mk('span','chip ok',x.status)); tr.appendChild(st);
    t.appendChild(tr);
  });
  var tc = $('#ct-tx-count'); tc.textContent = txs.length+' transactions';

  var pend = $('#ct-pending'); pend.textContent='';
  var pc2 = $('#ct-pending-count'); pc2.textContent = S.pending.length+' pending';
  if(!S.pending.length) pend.appendChild(mk('div','small dim','Nothing queued. Approved actions are turned into execution requests here — this is the hand-off format a real daemon would submit.'));
  S.pending.slice(0,6).forEach(function(rq, i){
    var box = mk('div','ev POLICY'); box.style.marginBottom='8px';
    var t2 = mk('div','t'); t2.appendChild(mk('span','pill',clock(rq.proposedAt))); t2.appendChild(mk('span','pill','request'));
    box.appendChild(t2);
    box.appendChild(mk('div','ti', rq.memo || 'container execution'));
    box.appendChild(mk('div','de','to '+short(rq.target)+' · '+fmtUnits(rq.value)+' '+CHAIN.sym+' · selector '+rq.selector));
    var pre = mk('pre',null, JSON.stringify(rq, null, 1).slice(0,700));
    box.appendChild(pre);
    var row = mk('div','row');
    var b = mk('button','btn sm','Copy JSON');
    b.onclick = function(){ copy(JSON.stringify(rq), 'Execution request copied'); };
    var b2 = mk('button','btn sm danger','Drop');
    b2.onclick = function(){ S.pending.splice(i,1); persist(); renderContainer(); };
    row.appendChild(b); row.appendChild(b2); box.appendChild(row);
    pend.appendChild(box);
  });
}

/* =========================================================================
   11. Revenue view
   ========================================================================= */
function renderRevenue(){
  var h = $('#rv-stats'); if(!h) return;
  h.textContent='';
  var total = feeTotal(S.fees.ledger, S.fees.activation, S.fees.paid);
  var execVol = 0n;
  S.activity.forEach(function(e){ if(e.kind==='EXEC' && e.action) { try{ execVol += BigInt(e.action.value); }catch(err){} } });
  h.appendChild(statCard('Fees credited', fmtUnits(total,4)+' USDT', 'flows to the container the user controls'));
  h.appendChild(statCard('Executed volume', fmtUnits(execVol,4)+' '+CHAIN.sym, 'base for the performance fee'));
  h.appendChild(statCard('Fee rate', (S.fees.bps/100).toFixed(2)+'%', 'of every executed action'));
  var act = $('#rv-active');
  act.textContent = S.agent.active ? 'ACTIVE' : 'INACTIVE';
  act.className = 'chip '+(S.agent.active?'ok':'warn');
  var box = $('#rv-activate'); box.textContent='';
  [['Activation fee', fmtUnits(BigInt(S.fees.activation),2)+' USDT'],['Paid', S.agent.active ? ('yes · '+clock(S.agent.activatedAt)) : 'no'],
   ['Recipient', 'circuit container (treasury)']].forEach(function(r){
    var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); box.appendChild(row);
  });
  var b = mk('button','btn primary sm','Pay '+fmtUnits(BigInt(S.fees.activation),2)+' USDT and activate agent');
  b.onclick = function(){
    var fee = BigInt(S.fees.activation), bal = BigInt(S.balance.USDT);
    if(bal < fee){ log('REJECT','Activation failed','container holds '+fmtUnits(bal,2)+' USDT, needs '+fmtUnits(fee,2)); renderFeed(); return; }
    S.balance.USDT = (bal-fee).toString();
    S.agent.active = true; S.agent.activatedAt = now(); S.fees.paid = true;
    S.fees.ledger.unshift({ t: now(), kind:'activation', amount: fee.toString(), hash: randHash() });
    log('FEE','Activation fee paid', fmtUnits(fee,2)+' USDT moved into the container · agent is live');
    persist(); renderRevenue(); renderOverview();
  };
  b.style.marginTop='10px';
  box.appendChild(b);

  var led = $('#rv-ledger'); led.textContent='';
  var head = mk('tr'); ['Time','Kind','Amount','Tx'].forEach(function(x){ head.appendChild(mk('th',null,x)); }); led.appendChild(head);
  if(!S.fees.ledger.length){ var tr = mk('tr'); var td = mk('td','dim','No fees yet.'); td.colSpan=4; tr.appendChild(td); led.appendChild(tr); }
  S.fees.ledger.slice(0,20).forEach(function(l){
    var tr = mk('tr');
    tr.appendChild(mk('td',null,clock(l.t)));
    tr.appendChild(mk('td',null,l.kind));
    tr.appendChild(mk('td',null,fmtUnits(BigInt(l.amount),4)+' USDT'));
    tr.appendChild(mk('td','mono',short(l.hash)));
    led.appendChild(tr);
  });
  var lt = $('#rv-ledger-total'); lt.textContent = fmtUnits(total,4)+' USDT total';
  renderProjection();
}
function renderProjection(){
  var out = $('#rv-proj'); if(!out) return;
  out.textContent='';
  var execs = Number($('#rv-execs').value||0), vol = Number($('#rv-vol').value||0), px = Number($('#rv-px').value||0);
  var monthlyVol = execs*30*vol;
  var feeOkb = monthlyVol * (S.fees.bps/10000);
  var monthly = feeOkb * px;
  [['Executed volume / month', fmtNum(monthlyVol,2)+' OKB'],
   ['Performance fees / month', fmtNum(feeOkb,2)+' OKB'],
   ['Protocol revenue / month', '$'+fmtNum(monthly,2)],
   ['Plus activation fees', '$'+fmtNum(execs>0?5:0,2)+' per activated agent']].forEach(function(r){
    var row = mk('div','kv'); row.appendChild(mk('span',null,r[0])); row.appendChild(mk('span',null,r[1])); out.appendChild(row);
  });
}

/* =========================================================================
   12. Autonomy — the always-on server daemon (control plane)
   ========================================================================= */
var TOKEN_KEY = 'tapeguardian.token';
var TOKEN_EXP_KEY = 'tapeguardian.token.exp';
// The owner token lives in sessionStorage, not localStorage: it dies with the tab,
// and it is dropped the moment the server's own short expiry has passed. Any token
// left behind by an older build in localStorage is removed.
var SERVER_TOKEN = (function(){
  try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
  try{
    var t = sessionStorage.getItem(TOKEN_KEY);
    if(!t) return null;
    var exp = Number(sessionStorage.getItem(TOKEN_EXP_KEY) || 0);
    if(exp && Math.floor(Date.now()/1000) >= exp){
      sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_EXP_KEY);
      return null;
    }
    return t;
  }catch(e){ return null; }
})();
var LAST_PING = 0;

function saveToken(t, expiresAt){
  SERVER_TOKEN = t || null;
  try{
    if(t){
      sessionStorage.setItem(TOKEN_KEY, t);
      sessionStorage.setItem(TOKEN_EXP_KEY, String(expiresAt || (Math.floor(Date.now()/1000) + 8*3600)));
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_EXP_KEY);
    }
  }catch(e){}
}
function apiFetch(path, opts){
  opts = opts || {};
  if(!API) return Promise.reject(new Error('No server is deployed with this page yet.'));
  var headers = { 'Content-Type':'application/json' };
  if(SERVER_TOKEN) headers.Authorization = 'Bearer ' + SERVER_TOKEN;
  return fetch(API + path, {
    method: opts.method || 'GET', headers: headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  }).then(function(r){
    return r.text().then(function(text){
      var body = {};
      try{ body = text ? JSON.parse(text) : {}; }catch(e){ body = { error: text }; }
      if(!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      return body;
    });
  });
}
var SERVER = { loaded:false, ok:false, error:'', status:null, rules:[], queue:[] };

function loadServer(){
  if(!API){
    SERVER = { loaded:true, ok:false, error:'no-server', status:null, rules:[], queue:[] };
    renderAutonomy();
    return Promise.resolve();
  }
  return Promise.all([
    apiFetch('/api/status').then(function(s){ return s; }).catch(function(e){ return { __error: e.message }; }),
    apiFetch('/api/rules').catch(function(){ return { rules: [] }; }),
    apiFetch('/api/queue').catch(function(){ return { queue: [] }; })
  ]).then(function(res){
    var status = res[0] && !res[0].__error ? res[0] : null;
    SERVER = {
      loaded:true, ok: !!status, error: status ? '' : ((res[0] && res[0].__error) || 'unreachable'),
      status: status, rules: (res[1] && res[1].rules) || [], queue: (res[2] && res[2].queue) || []
    };
    renderAutonomy();
  });
}
function ago(ts){
  if(!ts) return 'never';
  var d = Math.max(0, Math.floor(now()/1000) - Number(ts));
  if(d < 60) return d + 's ago';
  if(d < 3600) return Math.floor(d/60) + 'm ago';
  return Math.floor(d/3600) + 'h ago';
}
function pct(part, total){ return total > 0 ? (part*100/total).toFixed(1)+'%' : '—'; }

function renderAutonomy(){
  var notice = $('#au-notice'); if(!notice) return;
  notice.textContent = '';

  function note(cls, text){ var n = mk('div','notice '+(cls||'')); n.textContent = text; notice.appendChild(n); }

  var stats = $('#au-stats'); stats.textContent = '';
  var mode = $('#au-mode');

  if(!API){
    mode.textContent = 'NO SERVER'; mode.className = 'chip warn';
    note('', 'No 24/7 server is deployed with this page yet, so nothing can run while you are away. Think of the Daemon tab as a practice run inside your browser: close the tab and it stops. The real agent needs a small program running on a server — deploy it (it holds the cron tick, your rules and the low-power keeper key) and this panel becomes the always-on agent that trades while your phone is off.');
    note('ok', 'You can still do everything else today: set your rules in the Policy circuit tab, watch the cycle in the Daemon tab, and read the plain-language explanation on Start here.');
    [['Daemon','offline','deploy the server'],['Agent value','—','no chain reads'],['OKB weight','—','no strategy running'],['Queue','—','nothing pending']].forEach(function(r){
      stats.appendChild(statCard(r[0], r[1], r[2]));
    });
    renderServerStatus(); renderAuth(); renderAlloc(); renderRules(); renderRelayer(); renderServerLog();
    return;
  }
  if(!SERVER.ok){
    mode.textContent = 'SERVER UNREACHABLE'; mode.className = 'chip bad';
    note('err', 'The server did not answer' + (SERVER.error ? ': ' + SERVER.error : '') + '. Check that it is deployed and that RPC_URL is set in its Secrets panel.');
    [['Daemon','?','unknown'],['Agent value','—','unknown'],['OKB weight','—','unknown'],['Queue','?','unknown']].forEach(function(r){
      stats.appendChild(statCard(r[0], r[1], r[2]));
    });
    renderServerStatus(); renderAuth(); renderAlloc(); renderRules(); renderRelayer(); renderServerLog();
    return;
  }

  var s = SERVER.status, cfg = s.config || {}, d = s.daemon || {}, h = s.holdings || null;
  var last = d.lastTick || null;
  mode.textContent = d.online ? 'ONLINE · CRON' : 'IDLE';
  mode.className = 'chip ' + (d.online ? 'ok' : 'warn');
  note(d.online ? 'ok' : '', d.online
    ? 'The daemon is running on the server: last cycle ' + ago(last && last.ts) + ' from ' + ((last && last.source) || 'cron') + '. Closing this tab changes nothing.'
    : 'No cycle in the last 5 minutes. Add a Cloudflare cron trigger (Worker → Settings → Triggers → Cron, every minute) or point an external scheduler at POST /api/tick, otherwise the agent only runs when something pokes it.');

  stats.appendChild(statCard('Daemon', d.online ? 'ONLINE' : 'IDLE',
    last ? ('last ' + ago(last.ts) + ' · ' + ((last && last.source) || 'cron')) : 'no cycle yet', d.online ? null : null));
  stats.appendChild(statCard('Agent value', h && h.totalUsd !== undefined ? '$' + Number(h.totalUsd).toFixed(2) : '—',
    h ? ('OKB ' + Number(h.okbNative || 0).toFixed(4) + ' + USDT ' + Number(h.usdtUnits || 0).toFixed(2)) : 'needs RPC_URL + container'));
  stats.appendChild(statCard('OKB weight', h && h.currentOkbBps !== undefined ? fmtBps(h.currentOkbBps) : '—',
    'target ' + fmtBps(cfg.targetOkbBps) + ' ± ' + fmtBps(cfg.driftBps) + ' · ' + (s.prices ? 'OKB $' + Number(s.prices.okb).toFixed(2) : 'no price')));
  stats.appendChild(statCard('Queue', String(d.pending || 0) + ' pending',
    'sent ' + ((d.counts && d.counts.sent) || 0) + ' · failed ' + ((d.counts && d.counts.failed) || 0) + ' · skipped ' + ((d.counts && d.counts.skipped) || 0)));

  renderServerStatus(); renderAuth(); renderAlloc(); renderRules(); renderRelayer(); renderServerLog();
}
function fmtBps(bps){ return (Number(bps || 0)/100).toFixed(2) + '%'; }

function kvRow(host, key, value, cls){
  var row = mk('div','kv');
  row.appendChild(mk('span', null, key));
  var v = mk('span', null, value === undefined || value === null ? '—' : String(value));
  if(cls) v.className = cls;
  row.appendChild(v);
  host.appendChild(row);
}
function renderServerStatus(){
  var host = $('#au-status'); if(!host) return;
  host.textContent = '';
  if(!SERVER.ok){
    kvRow(host, 'Server', API ? 'unreachable' : 'not deployed');
    if(API && SERVER.error){
      var hint = mk('div','notice');
      hint.style.marginTop = '8px';
      hint.textContent = /APP_ORIGINS|403|browser access is locked/i.test(String(SERVER.error))
        ? 'The daemon refused this browser origin. Add the URL of this page to the APP_ORIGINS secret of the worker, redeploy and reload: ' + SERVER.error
        : 'The page cannot reach the daemon: ' + SERVER.error;
      host.appendChild(hint);
    }
    return;
  }
  var s = SERVER.status, d = s.daemon || {}, c = s.circuit, a = s.agent, p = s.prices, cfg = s.config || {};
  kvRow(host, 'Agent container', cfg.container || 'not configured');
  kvRow(host, 'Policy circuit', cfg.policy || 'not configured');
  kvRow(host, 'Kill switch', cfg.armed ? 'released (may execute)' : 'engaged (queue only)');
  if(c){
    kvRow(host, 'Circuit limits', fmtUnits(c.maxPerAction, 4) + ' ' + CHAIN.sym + ' / tx · ' + fmtUnits(c.dailyLimit, 4) + ' / day');
    kvRow(host, 'Circuit remaining today', fmtUnits(c.remainingToday, 4) + ' ' + CHAIN.sym + (c.paused ? ' · PAUSED' : ''));
  }
  if(a) kvRow(host, 'Agent account', (a.active ? 'active' : 'activation fee required') + ' · ' + String(a.executions) + ' executions');
  if(p) kvRow(host, 'Price feed', 'OKB $' + Number(p.okb).toFixed(2) + ' · USDT $' + Number(p.usdt || 1).toFixed(2) + ' · ' + (p.source || 'unknown') + ' · ' + ago(p.ts));
  kvRow(host, 'Last cycle', d.lastTick ? ago(d.lastTick.ts) + ' · ' + (d.lastTick.source || 'cron') + ' · ' + d.lastTick.decisions + ' decisions, ' + d.lastTick.executions + ' executions, ' + d.lastTick.queued + ' queued' : 'never');
}
function renderAuth(){
  var host = $('#au-auth'); if(!host) return;
  host.textContent = '';
  if(SERVER_TOKEN){
    var row = mk('div','row');
    row.appendChild(mk('span','chip ok','owner session active'));
    var out = mk('button','btn sm danger','Sign out');
    out.onclick = function(){
      apiFetch('/api/logout', { method:'POST' }).catch(function(){}).then(function(){ saveToken(null); toast('Signed out'); renderAutonomy(); });
    };
    row.appendChild(out);
    host.appendChild(row);
    return;
  }
  var grid = mk('div','grid g2'); grid.style.margin = '0 0 8px';
  var d1 = mk('div');
  d1.appendChild(mk('label','f','Owner password (ADMIN_PASSWORD secret)'));
  var inp = mk('input'); inp.type = 'password'; inp.placeholder = 'server secret';
  d1.appendChild(inp);
  grid.appendChild(d1);
  var d2 = mk('div');
  d2.appendChild(mk('label','f','&nbsp;'));
  var b = mk('button','btn primary sm','Unlock control plane');
  b.onclick = function(){
    if(!API){ toast('No server deployed'); return; }
    b.disabled = true;
    apiFetch('/api/login', { method:'POST', body:{ password: inp.value } }).then(function(res){
      saveToken(res.token || res.session || null, res.expiresAt);
      toast('Unlocked');
      inp.value = '';
      renderAutonomy();
      return loadServer();
    }).catch(function(e){ toast('Unlock failed: ' + e.message); }).then(function(){ b.disabled = false; });
  };
  d2.appendChild(b);
  grid.appendChild(d2);
  host.appendChild(grid);
  host.appendChild(mk('div','small dim','The password is only exchanged for a session token and never stored in this page. Only the daemon’s owner needs it: viewing the agent is public.'));
}
function renderAlloc(){
  var host = $('#au-alloc'); if(!host) return;
  host.textContent = '';
  var h = SERVER.ok ? SERVER.status.holdings : null;
  var cfg = SERVER.ok ? (SERVER.status.config || {}) : {};
  if(h){
    kvRow(host, 'OKB held by container', Number(h.okbNative || 0).toFixed(6) + ' ' + CHAIN.sym);
    kvRow(host, 'USDT held by container', Number(h.usdtUnits || 0).toFixed(2) + ' USDT');
    kvRow(host, 'Portfolio value', '$' + Number(h.totalUsd || 0).toFixed(2));
    kvRow(host, 'Current OKB weight', fmtBps(h.currentOkbBps) + ' (target ' + fmtBps(cfg.targetOkbBps) + ')');
    var bar = mk('div','bar');
    var fill = mk('i'); fill.style.width = Math.min(100, Math.max(0, Number(h.currentOkbBps || 0)/100)) + '%';
    bar.appendChild(fill); host.appendChild(bar);
    var drift = $('#au-drift-chip');
    if(drift){
      var off = Math.abs(Number(h.currentOkbBps || 0) - Number(cfg.targetOkbBps || 0));
      var outside = off > Number(cfg.driftBps || 0);
      drift.textContent = outside ? 'OUT OF BAND · rebalance due' : 'in band · drift ' + fmtBps(off);
      drift.className = 'chip ' + (outside ? 'warn' : 'ok');
    }
  } else {
    kvRow(host, 'Holdings', 'unavailable — set the container and RPC_URL');
  }
  var c = SERVER.ok ? (SERVER.status.config || {}) : {};
  function setIf(id, value){ var el = $(id); if(el && document.activeElement !== el) el.value = value; }
  setIf('#au-target', c.targetOkbBps !== undefined ? c.targetOkbBps : 6000);
  setIf('#au-drift', c.driftBps !== undefined ? c.driftBps : 500);
  setIf('#au-maxtrades', c.maxTradesPerDay !== undefined ? c.maxTradesPerDay : 6);
  setIf('#au-mintrade', c.minTrade !== undefined ? fmtUnits(c.minTrade, 6) : '0.01');
  setIf('#au-cooldown', c.cooldownS !== undefined ? c.cooldownS : 300);
  setIf('#au-slip', c.slippageBps !== undefined ? c.slippageBps : 150);
  setIf('#au-router', c.router || '');
  setIf('#au-wokb', c.wrappedNative || '');
  setIf('#au-usdt', c.usdt || '');
  setIf('#au-usdtdec', c.usdtDecimals !== undefined ? c.usdtDecimals : 6);
}
function ruleSummary(rule){
  var p = {};
  try{ p = typeof rule.params === 'string' ? JSON.parse(rule.params) : (rule.params || {}); }catch(e){ p = {}; }
  if(rule.kind === 'rebalance') return 'drift above the band → trade back to target';
  if(rule.kind === 'price') return 'OKB ' + (p.op || '≤') + ' $' + p.threshold + ' → ' + (p.action || 'buy') + ' $' + p.amountUsd;
  if(rule.kind === 'interval') return 'every ' + Math.round(Number(p.everyS || 0)/60) + ' min → ' + (p.action || 'rebalance') + (p.action === 'rebalance' ? '' : ' $' + p.amountUsd);
  return rule.kind;
}
function renderRules(){
  var host = $('#au-rules'); if(!host) return;
  host.textContent = '';
  var rules = SERVER.rules || [];
  var count = $('#au-rule-count');
  if(count) count.textContent = rules.length + ' rules';
  if(!rules.length){
    host.appendChild(mk('div','small dim','No rules yet. Without a rule the daemon wakes up, reads the chain and does nothing.'));
    return;
  }
  rules.forEach(function(rule){
    var box = mk('div','ev ' + (rule.enabled ? 'POLICY' : 'CONFIG'));
    var t = mk('div','t');
    t.appendChild(mk('span','pill', String(rule.kind || '').toUpperCase()));
    t.appendChild(mk('span','pill', rule.enabled ? 'enabled' : 'disabled'));
    t.appendChild(mk('span','pill','cooldown ' + rule.cooldownS + 's'));
    t.appendChild(mk('span','pill','runs ' + (rule.runs || 0)));
    if(rule.lastRun) t.appendChild(mk('span','pill','last ' + ago(rule.lastRun)));
    box.appendChild(t);
    box.appendChild(mk('div','ti', rule.name || rule.id));
    box.appendChild(mk('div','de', ruleSummary(rule)));
    var row = mk('div','row mt');
    var tg = mk('button','btn sm', rule.enabled ? 'Disable' : 'Enable');
    tg.onclick = function(){
      apiFetch('/api/rules/' + encodeURIComponent(rule.id) + '/toggle', { method:'POST' }).then(loadServer).catch(function(e){ toast(e.message); });
    };
    var del = mk('button','btn sm danger','Delete');
    del.onclick = function(){
      apiFetch('/api/rules/' + encodeURIComponent(rule.id), { method:'DELETE' }).then(loadServer).catch(function(e){ toast(e.message); });
    };
    row.appendChild(tg); row.appendChild(del);
    box.appendChild(row);
    host.appendChild(box);
  });
}
function renderRelayer(){
  var host = $('#au-relayer'); if(!host) return;
  host.textContent = '';
  var chip = $('#au-relayer-chip');
  if(!SERVER.ok){
    kvRow(host, 'Relayer', 'unknown');
    if(chip){ chip.textContent = 'unknown'; chip.className = 'chip'; }
    return;
  }
  var r = SERVER.status.relayer || {};
  kvRow(host, 'Keeper address', r.address || 'none (no RELAYER_KEY secret)');
  kvRow(host, 'Signer self-test', r.selfTest ? 'passed' : ('failed — ' + (r.reason || 'keys disabled')));
  kvRow(host, 'Authorised on container', r.authorised === null ? 'unknown' : (r.authorised ? 'yes — can submit approved actions' : 'no — authorise it once from your TapeOut container'));
  kvRow(host, 'Custody', 'none — it can only push policy-approved actions');
  if(chip){
    var good = r.selfTest && r.authorised;
    chip.textContent = good ? 'READY' : (r.configured ? 'NOT READY' : 'NO KEY');
    chip.className = 'chip ' + (good ? 'ok' : 'warn');
  }
}
function renderServerLog(){
  var host = $('#au-log'); if(!host) return;
  host.textContent = '';
  var log = (SERVER.ok && SERVER.status.log) || [];
  var count = $('#au-log-count');
  if(count) count.textContent = log.length + ' entries';
  if(!log.length){
    host.appendChild(mk('div','small dim','No server decisions yet.'));
    return;
  }
  log.forEach(function(entry){
    var box = mk('div','ev ' + (entry.kind || 'CONFIG'));
    var t = mk('div','t');
    t.appendChild(mk('span',null, clock(Number(entry.ts) * 1000)));
    t.appendChild(mk('span','pill', entry.kind || ''));
    if(entry.txHash) t.appendChild(mk('span','pill', short(entry.txHash)));
    box.appendChild(t);
    box.appendChild(mk('div','ti', entry.title || ''));
    if(entry.detail) box.appendChild(mk('div','de', entry.detail));
    host.appendChild(box);
  });
}
function initAutonomy(){
  var refresh = $('#btn-au-refresh'); if(!refresh) return;
  refresh.onclick = function(){ toast('Refreshing…'); loadServer(); };

  $('#btn-au-tick').onclick = function(){
    if(!SERVER_TOKEN){ toast('Unlock the control plane first (owner password)'); return; }
    apiFetch('/api/tick', { method:'POST' }).then(function(res){
      var r = res.result || {};
      toast('Cycle done · ' + (r.decisions || 0) + ' decisions, ' + (r.executions || 0) + ' executions');
      return loadServer();
    }).catch(function(e){ toast('Tick failed: ' + e.message); });
  };
  $('#btn-au-arm').onclick = function(){
    apiFetch('/api/arm', { method:'POST', body:{ armed:true } }).then(function(){ toast('Kill switch released'); return loadServer(); }).catch(function(e){ toast(e.message); });
  };
  $('#btn-au-kill').onclick = function(){
    apiFetch('/api/arm', { method:'POST', body:{ armed:false } }).then(function(){ toast('Kill switch engaged — queue only'); return loadServer(); }).catch(function(e){ toast(e.message); });
  };
  $('#btn-au-demo-cfg').onclick = function(){
    $('#au-target').value = 6000; $('#au-drift').value = 500; $('#au-maxtrades').value = 6;
    $('#au-mintrade').value = '0.01'; $('#au-cooldown').value = 300; $('#au-slip').value = 150;
    $('#au-usdtdec').value = 6;
    toast('Demo strategy filled — paste the router, wrapped OKB and USDT addresses you whitelisted on the circuit');
  };
  $('#btn-au-save').onclick = function(){
    if(!SERVER_TOKEN){ toast('Unlock the control plane first (owner password)'); return; }
    var body = {
      targetOkbBps: Number($('#au-target').value || 0),
      driftBps: Number($('#au-drift').value || 0),
      maxTradesPerDay: Number($('#au-maxtrades').value || 1),
      cooldownS: Number($('#au-cooldown').value || 300),
      slippageBps: Number($('#au-slip').value || 0),
      usdtDecimals: Number($('#au-usdtdec').value || 6),
      router: $('#au-router').value.trim(),
      wrappedNative: $('#au-wokb').value.trim(),
      usdt: $('#au-usdt').value.trim()
    };
    try{ body.minTradeWei = parseUnits($('#au-mintrade').value || '0').toString(); }catch(e){ toast('Min trade is not a number'); return; }
    var usdt = body.usdt, wokb = body.wrappedNative;
    if(usdt && wokb){
      body.pathSell = [wokb, usdt];
      body.pathBuy = [usdt, wokb];
    }
    apiFetch('/api/config', { method:'PUT', body: body }).then(function(){ toast('Strategy saved'); return loadServer(); }).catch(function(e){ toast('Save failed: ' + e.message); });
  };
  $('#btn-au-add-rule').onclick = function(){
    if(!SERVER_TOKEN){ toast('Unlock the control plane first (owner password)'); return; }
    var kind = $('#au-rule-kind').value;
    var cond = Number($('#au-rule-cond').value || 0);
    var amount = Number($('#au-rule-amount').value || 0);
    var params = {};
    if(kind === 'price'){ params.op = $('#au-rule-op').value; params.threshold = cond; params.action = $('#au-rule-action').value; params.amountUsd = amount; }
    if(kind === 'interval'){ params.everyS = Math.max(60, cond); params.action = $('#au-rule-iaction').value; if(params.action !== 'rebalance') params.amountUsd = amount; }
    if(kind === 'rebalance'){ params.source = 'drift'; }
    apiFetch('/api/rules', {
      method:'POST',
      body:{ kind:kind, name: $('#au-rule-name').value.trim() || kind, params: params, cooldownS: Number($('#au-rule-cooldown').value || 300), enabled:true }
    }).then(function(){ toast('Rule added'); return loadServer(); }).catch(function(e){ toast('Rule rejected: ' + e.message); });
  };
  $('#btn-au-relayer-calldata').onclick = function(){
    var out = $('#au-relayer-out'); out.textContent = '';
    var address = SERVER.ok && SERVER.status.relayer ? SERVER.status.relayer.address : null;
    if(!address){ toast('No relayer key on the server yet'); return; }
    try{
      var item = { name:'setRelayer', inputs:[{type:'address'},{type:'bool'}] };
      var encoded = encodeCall(item, [address, true]);
      var card = mk('div','card');
      card.appendChild(mk('h4', null, 'One-time call from your TapeOut circuit container'));
      card.appendChild(mk('div','small dim','The container is owned by your circuit container, so this call has to be routed through it (the app does that for owner-only functions). It authorises the keeper to submit circuit-approved actions while you are away, and never lets it touch the funds.'));
      card.appendChild(mk('div','code mt', encoded.data));
      var b = mk('button','btn sm mt','Copy calldata');
      b.onclick = function(){ copy(encoded.data, 'setRelayer calldata copied'); };
      card.appendChild(b);
      out.appendChild(card);
    }catch(e){ toast('Could not encode: ' + e.message); }
  };
  if(API && SERVER_TOKEN){
    setInterval(function(){
      var view = $('#v-autonomy');
      if(!view || !view.classList.contains('active')) return;
      if(now() - LAST_PING < 60000) return;
      LAST_PING = now();
      apiFetch('/api/tick', { method:'POST' }).then(loadServer).catch(function(){});
    }, 5000);
  }
}

/* =========================================================================
   13. Generic contract panel — state + callable functions
   ========================================================================= */
function primaryContract(){
  if(!CONTRACT_NAMES.length) return null;
  /* The agent account is the contract the dashboard executes through, so prefer the
     one that exposes execute() instead of trusting the key order of APP_CONFIG. */
  var name = CONTRACT_NAMES[0];
  for(var i=0;i<CONTRACT_NAMES.length;i++){
    var cand = CONTRACTS[CONTRACT_NAMES[i]];
    var hasExec = (cand && cand.abi || []).some(function(fn){ return fn && fn.type==='function' && /^execute$/i.test(fn.name); });
    if(hasExec){ name = CONTRACT_NAMES[i]; break; }
  }
  var c = CONTRACTS[name];
  if(!c || !c.address) return null;
  var byName = {};
  (c.abi||[]).forEach(function(i){ if(i && i.type==='function') byName[i.name]=i; });
  return { name:name, address:c.address, abi:c.abi||[], abiByName:byName };
}
function fmtValue(v){
  if(v===null || v===undefined) return '—';
  if(typeof v==='bigint') return v.toString();
  if(typeof v==='boolean') return v?'true':'false';
  if(Array.isArray(v)) return v.map(fmtValue).join(', ');
  return String(v);
}
function renderContracts(){
  var host = $('#ct-contracts'); if(!host) return;
  host.textContent='';
  var notice = $('#ct-notice'); notice.textContent='';
  if(!CONTRACT_NAMES.length){
    var n = mk('div','notice');
    n.textContent = 'No contract is deployed with this page yet, so there is no on-chain state to read. Deploy a policy processor (owner = your TapeOut circuit container), add it to the project and publish again: the app injects window.APP_CONFIG and every view function appears here automatically, with the write functions callable from your wallet. Until then the dashboard above runs the faithful local mirror of the circuit (DEMO SIMULATION).';
    notice.appendChild(n);
    return;
  }
  CONTRACT_NAMES.forEach(function(name){
    var c = CONTRACTS[name] || {};
    var abi = c.abi || [];
    var fns = abi.filter(function(i){ return i && i.type==='function'; });
    var reads = fns.filter(function(f){ return f.stateMutability==='view' || f.stateMutability==='pure'; });
    var writes = fns.filter(function(f){ return !(f.stateMutability==='view' || f.stateMutability==='pure'); });

    var card = mk('div','card'); card.style.marginBottom='12px';
    var head = mk('div','card-h');
    head.appendChild(mk('h3',null, name));
    var chip = mk('span','chip live');
    chip.textContent = short(c.address || '') + (ABI_OK ? '' : ' · ABI codec failed self-test');
    head.appendChild(chip);
    card.appendChild(head);
    var addr = mk('div','code', c.address || 'no address');
    card.appendChild(addr);
    var row = mk('div','row mt');
    var bc = mk('button','btn ghost sm','Copy address');
    bc.onclick = function(){ copy(c.address, 'Address copied'); };
    var br = mk('button','btn primary sm','Refresh state');
    br.onclick = function(){ loadReads(name); };
    row.appendChild(bc); row.appendChild(br);
    card.appendChild(row);

    /* read section */
    var secR = mk('div'); secR.id = 'reads-'+name;
    secR.className = 'mt';
    card.appendChild(secR);
    var noArg = reads.filter(function(f){ return !(f.inputs||[]).length; });
    var withArg = reads.filter(function(f){ return (f.inputs||[]).length; });
    if(noArg.length){
      var tbl = mk('table');
      var tr = mk('tr'); ['State', 'Value'].forEach(function(x){ tr.appendChild(mk('th',null,x)); }); tbl.appendChild(tr);
      noArg.forEach(function(f){
        var r = mk('tr');
        r.appendChild(mk('td',null,f.name+'()'));
        var td = mk('td','mono'); td.id = 'read-'+name+'-'+f.name; td.textContent='…'; r.appendChild(td);
        tbl.appendChild(r);
      });
      secR.appendChild(tbl);
    }
    if(withArg.length){
      secR.appendChild(mk('h4',null,'Read functions with arguments'));
      withArg.forEach(function(f){ secR.appendChild(fnForm(name, f, 'call')); });
    }
    if(writes.length){
      secR.appendChild(mk('h4',null,'Write functions — sends a transaction from your wallet'));
      writes.forEach(function(f){ secR.appendChild(fnForm(name, f, 'send')); });
    }
    host.appendChild(card);
  });
  loadReads(CONTRACT_NAMES[0]);
}
function fnForm(name, f, mode){
  var box = mk('div','mt');
  var t = mk('div','small'); t.appendChild(mk('span','mono',f.name+'('+(f.inputs||[]).map(function(i){return i.type;}).join(', ')+')'));
  var tag = mk('span','pill', mode==='call'?'view':'write'); tag.style.marginLeft='6px'; t.appendChild(tag);
  box.appendChild(t);
  var inputs = {};
  if((f.inputs||[]).length){
    var grid = mk('div','grid g3'); grid.style.margin='6px 0';
    f.inputs.forEach(function(inp, i){
      var d = mk('div');
      d.appendChild(mk('label','f', (inp.name||('arg'+i))+' : '+inp.type));
      var el = mk('input');
      el.placeholder = inp.type;
      d.appendChild(el); inputs[i]=el; grid.appendChild(d);
    });
    box.appendChild(grid);
  }
  var out = mk('div','small mono dim');
  var valueInput = null;
  if(mode==='send' && f.stateMutability==='payable'){
    var vg = mk('div','grid g3'); vg.style.margin='6px 0';
    var vd = mk('div');
    vd.appendChild(mk('label','f','value sent with the call ('+CHAIN.sym+')'));
    valueInput = mk('input'); valueInput.placeholder = '0.02';
    vd.appendChild(valueInput); vg.appendChild(vd);
    box.appendChild(vg);
  }
  var b = mk('button','btn '+(mode==='send'?'primary':'')+' sm', mode==='send'?'Send transaction':'Call');
  b.onclick = function(){
    out.textContent='';
    var c = CONTRACTS[name];
    var args;
    try{ args = (f.inputs||[]).map(function(inp,i){ return parseInput(inp.type, inputs[i]?inputs[i].value:''); }); }
    catch(e){ out.textContent = 'Input error: '+e.message; return; }
    if(mode==='call'){
      b.disabled = true; out.textContent='calling…';
      callView(c.address, f, args).then(function(vals){
        out.textContent = '→ '+vals.map(fmtValue).join('  |  ');
      }).catch(function(err){ out.textContent = 'error: '+(err.message||err); })
      .then(function(){ b.disabled=false; });
    } else {
      var enc2, sel = '0x', valueWei = 0n;
      try{ enc2 = encodeCall(f, args); sel = enc2.selector; }catch(e){ sel = '0x'; }
      if(valueInput){
        try{ valueWei = parseUnits(valueInput.value || '0'); }
        catch(e){ out.textContent = 'Input error: value must be a number'; return; }
      }
      var summary = 'Send to ' + c.address + '\n\n' +
        f.name + '(' + (f.inputs||[]).map(function(i){return i.type;}).join(', ') + ')\n' +
        'selector ' + sel + ' · value ' + fmtUnits(valueWei, 6) + ' ' + CHAIN.sym;
      if(!window.confirm(summary + '\n\nConfirm this transaction?')) return;
      b.disabled = true; out.textContent='sending…';
      sendTx(c.address, f, args, valueWei).then(function(hash){
        out.textContent = 'tx '+hash;
        log('EXEC','Contract call · '+name+'.'+f.name, short(hash)+' sent from '+short(S.wallet.address), { hash:hash });
        persist();
      }).catch(function(err){ out.textContent = 'error: '+(err.message||err); })
      .then(function(){ b.disabled=false; });
    }
  };
  box.appendChild(b);
  if(mode==='send'){
    var hint = mk('div','small dim','Sent from your connected wallet. If this function is owner-only it can only be called by the contract owner — your TapeOut circuit container — so route it through the app\'s contract view; a plain wallet call reverts.');
    hint.style.marginTop='4px';
    box.appendChild(hint);
  }
  box.appendChild(out);
  return box;
}
function loadReads(name){
  var c = CONTRACTS[name]; if(!c || !c.address) return;
  var fns = (c.abi||[]).filter(function(i){ return i && i.type==='function' && (i.stateMutability==='view'||i.stateMutability==='pure') && !(i.inputs||[]).length; });
  fns.forEach(function(f){
    var cell = $('#read-'+name+'-'+f.name); if(!cell) return;
    cell.textContent = '…';
    callView(c.address, f, []).then(function(vals){
      var v = vals[0];
      if(typeof v==='string' && /^0x[0-9a-fA-F]{40}$/.test(v)){
        cell.textContent = v;
        var b = mk('button','btn sm','copy'); b.style.marginLeft='6px';
        b.onclick = function(){ copy(v,'Address copied'); };
        cell.appendChild(b);
      } else {
        cell.textContent = fmtValue(v);
      }
    }).catch(function(err){ cell.textContent = 'unavailable ('+(err.message||err)+')'; });
  });
}

/* =========================================================================
   13. Wiring / routing
   ========================================================================= */
function renderStart(){
  var host = $('#st-live'); if(!host) return;
  host.textContent = '';
  host.appendChild(mk('span', 'chip ' + (LIVE ? 'ok' : 'warn'), LIVE ? 'Live on ' + CHAIN.name : 'Demo simulation — no contracts deployed yet'));
  host.appendChild(mk('span','chip', S.daemon.running ? 'browser agent: running' : 'browser agent: stopped'));
  host.appendChild(mk('span','chip ' + (S.wallet.address ? 'ok' : ''), S.wallet.address ? ('wallet: ' + short(S.wallet.address)) : 'wallet: not connected'));
  if(API){
    host.appendChild(mk('span','chip ' + (SERVER.ok ? 'ok' : ''), SERVER.ok ? '24/7 server: online' : (SERVER.loaded ? '24/7 server: unreachable' : '24/7 server: state unknown')));
  } else {
    host.appendChild(mk('span','chip','24/7 server: not deployed'));
  }
  host.appendChild(mk('span','chip', (S.activity ? S.activity.length : 0) + ' decisions logged'));
}
function showView(v){
  $$('#tabs .tab').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-view')===v); });
  $$('.view').forEach(function(s){ s.classList.toggle('active', s.id==='v-'+v); });
  if(v==='start'){ renderStart(); if(API) loadServer(); }
  if(v==='overview'){ renderOverview(); renderFeed(); drawChart(); }
  if(v==='policy') renderPolicy();
  if(v==='daemon') renderDaemon();
  if(v==='autonomy'){ renderAutonomy(); loadServer(); }
  if(v==='container') renderContainer();
  if(v==='revenue') renderRevenue();
  if(v==='contracts') renderContracts();
  try{ if(history.replaceState) history.replaceState(null,'','#'+v); }catch(e){}
}
/* =========================================================================
   14. Wallet connectivity — desktop extensions AND mobile wallets
   -------------------------------------------------------------------------
   A phone browser has no injected provider, so this does not only look at
   window.ethereum: it asks every installed wallet to announce itself (EIP-6963),
   and when nothing is injected it offers the wallet's own in-app browser through
   the wallet's official universal link. Either way the page ends up connected,
   with the same chain check and the same guardrails.
   ========================================================================= */
var WALLET_LABEL = null;

function isMobileUA(){
  var ua = navigator.userAgent || '';
  if(/android|iphone|ipad|ipod|mobile|opera mini|iemobile|silk/i.test(ua)) return true;
  return (navigator.maxTouchPoints > 1) && /macintosh|mac os x/i.test(ua); /* iPad claiming to be a Mac */
}
function providerName(p){
  try{
    if(p.isMetaMask && !p.isBraveWallet) return 'MetaMask';
    if(p.isOkxWallet || p.isOKExWallet) return 'OKX Wallet';
    if(p.isCoinbaseWallet) return 'Coinbase Wallet';
    if(p.isTrust || p.isTrustWallet) return 'Trust Wallet';
    if(p.isRabby) return 'Rabby';
    if(p.isBitKeep || p.isBitgetWallet) return 'Bitget Wallet';
    if(p.isTokenPocket) return 'TokenPocket';
    if(p.isBraveWallet) return 'Brave Wallet';
    if(p.isPhantom) return 'Phantom';
  }catch(e){}
  return 'Browser wallet';
}
var EIP6963 = { announced: [] };
try{
  window.addEventListener('eip6963:announceProvider', function(ev){
    var d = ev && ev.detail;
    if(d && d.provider && d.info) EIP6963.announced.push(d);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}catch(e){}

/* Every wallet that can answer right now: injected ones first, then announcements. */
function injectedWallets(){
  var found = [], i;
  var eth = window.ethereum;
  if(eth && eth.request){
    if(Array.isArray(eth.providers) && eth.providers.length){
      for(i=0;i<eth.providers.length;i++){
        var p = eth.providers[i];
        if(p && p.request && !found.some(function(f){ return f.provider === p; })) found.push({ provider:p, name:providerName(p) });
      }
    } else {
      found.push({ provider:eth, name:providerName(eth) });
    }
  }
  for(i=0;i<EIP6963.announced.length;i++){
    var a = EIP6963.announced[i];
    if(a && a.provider && a.provider.request && !found.some(function(f){ return f.provider === a.provider; })){
      found.push({ provider:a.provider, name:(a.info && a.info.name) || providerName(a.provider) });
    }
  }
  return found;
}

/* Official universal links: the wallet opens its own in-app browser on this URL,
   so the page is then running with a provider it can talk to. */
function walletApps(){
  var href = location.href;
  if(!/^https?:\/\//i.test(href)) return [];   /* file:// pages cannot be deep-linked */
  var bare = href.replace(/^https?:\/\//i,'');
  return [
    { name:'MetaMask', icon:'🦊', note:'Opens MetaMask and loads this page inside it', href:'https://metamask.app.link/dapp/' + bare },
    { name:'OKX Wallet', icon:'◉', note:'Opens OKX and loads this page inside it', href:'https://www.okx.com/download?deeplink=' + encodeURIComponent('okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(href)) },
    { name:'Trust Wallet', icon:'🛡', note:'Opens Trust Wallet and loads this page inside it', href:'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(href) },
    { name:'Coinbase Wallet', icon:'🔵', note:'Opens Coinbase Wallet and loads this page inside it', href:'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(href) }
  ];
}

function closeWalletSheet(){ var s = $('#wallet-sheet'); if(!s) return; s.classList.add('hidden'); document.body.classList.remove('no-scroll'); }
/* One tap to open this page inside the user's own wallet browser. Phones have a
   native share sheet; if it is unavailable we fall back to the deep links below. */
function sharePage(){
  try{
    if(navigator.share){
      navigator.share({ title:'TapeGuardian', text:'Open TapeGuardian in your wallet app', url:location.href })
        .then(function(){ log('CONFIG','Shared this page to a wallet app','the wallet opens it and connects from there'); })
        .catch(function(){ /* user dismissed the share sheet — that is fine */ });
      return;
    }
  }catch(e){}
  toast('Tap a wallet below, or open your wallet app and visit this page');
}
function openWalletSheet(reason){
  var s = $('#wallet-sheet'); if(!s) return;
  s.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  var host = $('#ws-list'); if(!host) return;
  host.textContent = '';
  var sub = $('#ws-sub');
  var wallets = injectedWallets();
  var apps = walletApps();

  if(S.wallet.address){
    sub.textContent = 'Connected as ' + S.wallet.address + (WALLET_LABEL ? ' (' + WALLET_LABEL + ')' : '') + '.';
    var d = mk('button','wcard');
    d.appendChild(mk('span','wi','⏏'));
    var dt = mk('span','wt'); dt.appendChild(mk('b',null,'Disconnect wallet')); dt.appendChild(mk('span',null,'Forget the connection in this tab and go read-only'));
    d.appendChild(dt); d.appendChild(mk('span','wf',''));
    d.onclick = function(){ disconnectWallet(); closeWalletSheet(); };
    host.appendChild(d);
  } else if(wallets.length){
    sub.textContent = reason || 'Wallets detected in this browser. Pick the one you want to use.';
    wallets.forEach(function(w){
      var b = mk('button','wcard');
      b.appendChild(mk('span','wi','🔗'));
      var t = mk('span','wt'); t.appendChild(mk('b',null,w.name)); t.appendChild(mk('span',null,'Detected in this browser — connect and sign from here'));
      b.appendChild(t); b.appendChild(mk('span','wf','detected'));
      b.onclick = function(){ closeWalletSheet(); connectWith(w.provider, w.name); };
      host.appendChild(b);
    });
  } else {
    sub.textContent = reason || (isMobileUA()
      ? 'No wallet is running in this browser yet. Tap Share this page to open this site inside your wallet app, then tap Connect there — or tap a wallet below.'
      : 'No wallet extension was detected in this browser. Install one, or open this page inside a wallet app.');
  }

  if(!S.wallet.address && apps.length){
    var hdr = mk('div','divider', isMobileUA() ? 'open in your wallet' : 'or open this page inside a wallet app');
    host.appendChild(hdr);
    apps.forEach(function(a){
      var b = mk('button','wcard');
      b.appendChild(mk('span','wi', a.icon));
      var t = mk('span','wt'); t.appendChild(mk('b',null,a.name)); t.appendChild(mk('span',null,a.note));
      b.appendChild(t);
      b.onclick = function(){
        log('CONFIG','Opening ' + a.name, 'the wallet will load this page and connect from there');
        try{ location.href = a.href; }catch(e){ toast('Could not open ' + a.name); }
      };
      host.appendChild(b);
    });
  }
  $('#wallet-sheet').hidden = false;
}

function disconnectWallet(){
  if(CONNECTED_PROVIDER && CONNECTED_PROVIDER.removeListener){
    try{ CONNECTED_PROVIDER.removeListener('accountsChanged', onAccountsChanged); }catch(e){}
    try{ CONNECTED_PROVIDER.removeListener('chainChanged', onChainChanged); }catch(e){}
  }
  CONNECTED_PROVIDER = null; WALLET_LABEL = null;
  S.wallet.address = null; S.wallet.chainId = null; persist();
  var btn = $('#btn-wallet'); if(btn) btn.textContent = 'Connect wallet';
  log('CONFIG','Wallet disconnected','this tab is now read-only until you connect again');
  renderOverview(); renderPolicy(); renderContainer(); renderStart();
}
var CONNECTED_PROVIDER = null;
function onAccountsChanged(accs){
  var a = accs && accs[0] ? accs[0] : null;
  if(!a){ disconnectWallet(); toast('Wallet locked or disconnected'); return; }
  if(a.toLowerCase() === String(S.wallet.address||'').toLowerCase()) return;
  S.wallet.address = a; persist();
  var btn = $('#btn-wallet'); if(btn) btn.textContent = short(a);
  log('CONFIG','Wallet account changed', short(a));
  renderOverview(); renderPolicy(); renderContainer(); renderStart();
}
function onChainChanged(hexId){
  var got = parseInt(hexId, 16);
  S.wallet.chainId = got; persist();
  log('CONFIG','Wallet chain changed', 'now on chain ' + got + (got === CHAIN_ID ? '' : ' (this page expects ' + CHAIN_ID + ')'));
  renderOverview(); renderStart();
  toast(got === CHAIN_ID ? 'Wallet switched to ' + CHAIN.name : 'Wallet is on chain ' + got + ' — switch to ' + CHAIN.name + ' to send transactions');
}

function connectWith(provider, label){
  if(!provider || !provider.request){ openWalletSheet('That wallet did not answer. Try another one.'); return Promise.resolve(false); }
  return provider.request({ method:'eth_requestAccounts' }).then(function(accs){
    var acc = accs && accs[0] ? accs[0] : null;
    if(!acc) throw new Error('no account was shared');
    S.wallet.address = acc; WALLET_LABEL = label || providerName(provider); persist();
    var btn = $('#btn-wallet'); if(btn){ btn.textContent = short(acc); btn.title = WALLET_LABEL + ' · ' + acc; }
    CONNECTED_PROVIDER = provider;
    try{
      provider.removeListener && provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener && provider.removeListener('chainChanged', onChainChanged);
      provider.on && provider.on('accountsChanged', onAccountsChanged);
      provider.on && provider.on('chainChanged', onChainChanged);
    }catch(e){}
    log('CONFIG','Wallet connected', short(acc) + ' via ' + WALLET_LABEL);
    return provider.request({ method:'eth_chainId' }).catch(function(){ return null; });
  }).then(function(cid){
    if(cid === undefined || cid === null) return;
    var got = parseInt(cid,16);
    S.wallet.chainId = got; persist();
    if(got !== CHAIN_ID){
      log('CONFIG','Wallet network mismatch','wallet on chain '+got+', page expects '+CHAIN_ID+' ('+CHAIN.name+')');
      /* Ask the wallet to switch. We do not ship an RPC URL in the page, so if the
         chain is not in the wallet yet the switch fails and we say what to add. */
      return provider.request({ method:'wallet_switchEthereumChain', params:[{ chainId:'0x'+CHAIN_ID.toString(16) }] }).catch(function(){
        toast('Add ' + CHAIN.name + ' (chain ' + CHAIN_ID + ') to your wallet, then send again');
      });
    }
    return null;
  }).then(function(){
    if(LIVE && !S.agent.container){ S.agent.container = S.wallet.address; persist(); }
    closeWalletSheet();
    renderOverview(); renderPolicy(); renderContainer(); renderStart();
    if(LIVE) loadReads(CONTRACT_NAMES[0]);
    return true;
  }).catch(function(err){
    var msg = (err && err.message) ? err.message : String(err);
    if(/reject|denied|cancel|4001/i.test(msg)){
      log('REJECT','Connection cancelled by the user', msg);
      toast('You closed the wallet prompt — nothing was connected.');
      return false;
    }
    toast('Could not connect: ' + msg);
    openWalletSheet('That did not work (' + msg + '). Try another wallet:');
    return false;
  });
}

function activeProvider(){ return CONNECTED_PROVIDER || window.ethereum; }
function connectWallet(){
  if(S.wallet.address){ openWalletSheet(); return; }
  var wallets = injectedWallets();
  /* One provider and a desktop-sized screen: connect straight away, no extra tap.
     Several providers, or a phone: show the chooser, because the user has a choice
     to make (which extension, or which wallet app to open). */
  if(wallets.length === 1 && !isMobileUA()){ connectWith(wallets[0].provider, wallets[0].name); return; }
  if(wallets.length) openWalletSheet();
  else openWalletSheet(isMobileUA()
    ? 'This browser has no wallet built in. Pick your wallet below — it opens the app and loads this page inside it.'
    : 'No wallet extension detected. Install MetaMask (or another wallet), then reload this page — or open this page inside a wallet app.');
}
function handleHash(){
  var h = (location.hash||'').replace('#','');
  if(h==='public'){ document.body.classList.add('public'); return true; }
  var valid = ['start','overview','policy','daemon','autonomy','container','revenue','contracts','docs'];
  if(valid.indexOf(h)>=0){ showView(h); return true; }
  return false;
}
/* Confirms that each injected address actually has code on the configured chain.
   Without this, a page published with an address from another chain (or a typo)
   looks healthy and every read silently returns empty data. */
function verifyDeployed(){
  if(!LIVE || !ABI_OK) return;
  CONTRACT_NAMES.forEach(function(name){
    var c = CONTRACTS[name];
    if(!c || !c.address) return;
    chainRpc('eth_getCode', [c.address, 'latest']).then(function(code){
      var has = code && code !== '0x' && code !== '0x0';
      if(!has){
        log('CONFIG','No code at '+name+' address', c.address+' on '+CHAIN.name+' — check that this address was deployed on chain '+CHAIN_ID);
        toast(name+': no contract code at '+short(c.address)+' on '+CHAIN.name);
      }
    }).catch(function(){ /* no RPC yet: nothing to verify against */ });
  });
}
function boot(){
  $('#chip-chain').textContent = CHAIN.name+' · '+CHAIN_ID;
  renderOverviewStatsOnly();
  /* config sanity: a warning about a dropped address is shown, never ignored */
  CONFIG_WARNINGS.forEach(function(w){ try{ log('CONFIG','APP_CONFIG entry ignored', w); }catch(e){} });
  verifyDeployed();
  /* notice */
  var n = $('#notice');
  if(!LIVE){
    n.hidden = false; n.className='notice';
    n.textContent = 'No contract deployed with this page yet: running DEMO SIMULATION with a local mirror of the policy circuit, so triggers → policy check → container execution can be demonstrated end to end. Deploy the policy processor and republish to switch to live reads and real transactions.';
  } else if(!ABI_OK){
    n.hidden=false; n.className='notice err';
    n.textContent = 'ABI codec self-test failed in this browser, so on-chain calls are disabled. The dashboard keeps running in simulation mode.';
  } else if(!activeProvider()){
    n.hidden=false; n.className='notice';
    n.textContent = 'Live contracts detected. Connect a wallet on '+CHAIN.name+' to read state and send transactions; on a phone, tap “Connect wallet” to open this page inside your wallet app. Until then reads stay idle.';
  }
  /* public link */
  try{ if(new URLSearchParams(location.search).get('public')==='1') document.body.classList.add('public'); }catch(e){}

  /* wallet chooser sheet */
  var wsX = $('#ws-x'); if(wsX) wsX.onclick = closeWalletSheet;
  var wsClose = $('#ws-close'); if(wsClose) wsClose.onclick = closeWalletSheet;
  var wsShare = $('#ws-share'); if(wsShare) wsShare.onclick = sharePage;
  var wsPub = $('#ws-public'); if(wsPub) wsPub.onclick = function(){ closeWalletSheet(); document.body.classList.add('public'); toast('Read-only mode on'); };
  var wsBd = $('#wallet-sheet'); if(wsBd) wsBd.addEventListener('click', function(e){ if(e.target === wsBd) closeWalletSheet(); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' || e.keyCode === 27) closeWalletSheet(); });
  /* tabs */
  $$('#tabs .tab').forEach(function(t){ t.onclick = function(){ showView(t.getAttribute('data-view')); }; });
  /* plain-language landing: every "start here" button jumps to the matching view */
  $$('[data-goto]').forEach(function(b){ b.onclick = function(){ showView(b.getAttribute('data-goto')); }; });
  /* if the address carries #view, open it (so ?public=1 can deep-link) */
  /* header */
  $('#btn-wallet').onclick = connectWallet;
  $('#btn-public').onclick = function(){
    document.body.classList.toggle('public');
    var on = document.body.classList.contains('public');
    if(on){ try{ history.replaceState(null,'', location.pathname+'?public=1'); }catch(e){} toast('Public view on — share this link'); }
    else { try{ history.replaceState(null,'', location.pathname); }catch(e){} }
  };
  /* overview buttons */
  $('#btn-nudge').onclick = function(){ S.market.price = Math.max(20, S.market.price-0.30); advanceMarket(); tick(); renderMarket(); };
  $('#btn-demo-happy').onclick = function(){
    if(!S.daemon.running) startDaemon();
    S.market.price = Math.min(S.market.price, triggerThreshold(S.triggers)-0.05);
    advanceMarket(); tick();
    log('CONFIG','Demo · happy path','trigger → policy approval → container execution reproduced end to end');
    renderOverview(); renderFeed();
  };
  $('#btn-demo-rogue').onclick = function(){
    var a = { label:'Rogue transfer', target:DEMO.stranger, targetLabel:'unknown address', selector:SEL.transfer,
              value: parseUnits('0.25').toString(), memo:'drain attempt' };
    proposeAndRun(a, 'Manual hostile proposal');
    renderOverview();
  };
  $('#btn-export').onclick = function(){
    var bundle = { product:'TapeGuardian', version:1, exportedAt:new Date().toISOString(), chain:{ id:CHAIN_ID, name:CHAIN.name }, circuit:S.agent, policy:S.policy,
      container:containerAddr(), balances:S.balance, activity:S.activity, fees:S.fees, triggers:S.triggers, txs:S.txs||[] };
    var blob = new Blob([JSON.stringify(bundle,null,2)], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href=url; a.download='tapeguardian-evidence.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
    toast('Evidence bundle exported');
  };
  $('#btn-clear-log').onclick = function(){ S.activity=[]; persist(); renderFeed(); renderDaemon(); renderOverview(); };
  $$('[data-filter]').forEach(function(b){ b.onclick = function(){ S.filters = b.getAttribute('data-filter'); persist(); renderFeed(); }; });

  /* policy buttons */
  $('#btn-toggle-pause').onclick = function(){
    S.policy.paused = !S.policy.paused;
    log('CONFIG', S.policy.paused?'Circuit paused':'Circuit resumed', S.policy.paused?'every proposal will be rejected until unpaused':'proposals are evaluated again');
    persist(); renderPolicy(); renderOverview(); renderFeed();
  };
  $('#btn-edit-policy').onclick = function(){
    var e = $('#pol-edit'); e.style.display = e.style.display==='none'?'block':'none';
    $('#in-maxtx').value = fmtUnits(S.policy.maxPerTx,4);
    $('#in-daily').value = fmtUnits(S.policy.dailyLimit,4);
    $('#in-expiry').value = S.policy.expiry ? Math.max(0,Math.round((S.policy.expiry-now())/86400000)) : 0;
  };
  $('#btn-cancel-policy').onclick = function(){ $('#pol-edit').style.display='none'; };
  $('#btn-save-policy').onclick = function(){
    try{
      S.policy.maxPerTx = parseUnits($('#in-maxtx').value).toString();
      S.policy.dailyLimit = parseUnits($('#in-daily').value).toString();
      var days = Number($('#in-expiry').value||0);
      S.policy.expiry = days>0 ? now()+days*86400000 : 0;
    }catch(err){ toast('Invalid value: '+err.message); return; }
    log('CONFIG','Circuit rules updated', 'max/tx '+fmtUnits(S.policy.maxPerTx)+' '+CHAIN.sym+' · 24h cap '+fmtUnits(S.policy.dailyLimit)+' '+CHAIN.sym);
    persist(); $('#pol-edit').style.display='none'; renderPolicy(); renderOverview();
  };
  $('#btn-add-target').onclick = function(){
    var label = $('#al-label').value.trim() || 'target';
    var target = $('#al-target').value.trim();
    if(!/^0x[0-9a-fA-F]{40}$/.test(target)){ toast('Target must be a 0x address'); return; }
    var sels = $('#al-sel').value.split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(function(s){ return s; });
    S.policy.allowlist.push({ label:label, target:target, selectors:sels });
    log('CONFIG','Target allowed', label+' · '+target);
    $('#al-label').value=''; $('#al-target').value=''; $('#al-sel').value='';
    persist(); renderPolicy(); renderOverview();
  };
  $('#btn-evaluate').onclick = function(){
    var action;
    try{ action = currentSimAction(); }catch(err){ toast('Invalid amount'); return; }
    var res = policy.evaluate(action);
    var out = $('#sim-out'); out.textContent=''; out.appendChild(policyResultNode(res, action));
    log(res.ok?'POLICY':'REJECT', 'Simulated policy check · '+(res.ok?'approved':'rejected'),
        res.ok? (res.passed+'/'+res.total+' rules passed for '+short(action.target)) : (res.code+': '+res.reason));
  };
  $('#btn-preview-calldata').onclick = function(){
    var action;
    try{ action = currentSimAction(); }catch(err){ toast('Invalid amount'); return; }
    var rq = policy.buildExecutionRequest(action);
    var out = $('#sim-out'); out.textContent='';
    var box = mk('div','card');
    box.appendChild(mk('h3',null,'Execution request (what the daemon would submit)'));
    box.appendChild(mk('pre',null, JSON.stringify(rq,null,2)));
    var b = mk('button','btn sm','Copy JSON');
    b.onclick = function(){ copy(JSON.stringify(rq),'Execution request copied'); };
    box.appendChild(b);
    out.appendChild(box);
  };
  /* daemon buttons */
  $('#btn-start-daemon').onclick = startDaemon;
  $('#btn-stop-daemon').onclick = stopDaemon;
  $('#btn-tick').onclick = function(){ tick(); toast('Tick forced'); };
  $('#btn-add-trigger').onclick = function(){
    var type = $('#tg-type').value, name = $('#tg-name').value.trim()||'trigger';
    var cond = Number($('#tg-cond').value||0);
    var amount = $('#tg-amount').value, cooldown = Number($('#tg-cooldown').value||30)*1000;
    var sel = $('#tg-target'); var target = sel.value;
    if(target==='__custom') target = window.prompt('Target address (0x…)') || '';
    var entry = null;
    S.policy.allowlist.forEach(function(a){ if(a.target.toLowerCase()===String(target).toLowerCase()) entry=a; });
    if(!entry){ toast('Pick a target from the circuit allowlist'); return; }
    var g = { id:uid(), type:type, name:name, enabled:true, cooldownMs:cooldown, lastFired:0,
      action:{ label:name, target:entry.target, targetLabel:entry.label, selector:(entry.selectors&&entry.selectors[0])||SEL.transfer,
               value:parseUnits(amount||'0').toString(), memo:$('#tg-memo').value||name } };
    if(type==='price'){ g.op='<='; g.threshold=cond; }
    else if(type==='time'){ g.intervalMs = Math.max(5,cond||60)*1000; }
    else if(type==='block'){ g.blocks = Math.max(1,Math.round(cond||15)); }
    else { g.p = Math.min(0.5, Math.max(0.01, (cond||8)/100)); }
    S.triggers.push(g);
    log('CONFIG','Trigger added', name+' · '+type+' · → '+entry.label+' · '+fmtUnits(g.action.value)+' '+CHAIN.sym);
    persist(); renderDaemon();
  };
  /* container buttons */
  $('#btn-fund').onclick = function(){
    var asset = $('#fund-asset').value, amt = $('#fund-amount').value;
    var v; try{ v = parseUnits(amt); }catch(err){ toast('Invalid amount'); return; }
    var to = containerAddr();
    if(LIVE && activeProvider() && S.wallet.address && asset === 'OKB'){
      /* Live funding is a real transfer, so the container actually holds the money. */
      log('FUND','Funding the container', fmtUnits(v,4)+' '+CHAIN.sym+' → '+short(to));
      sendNative(to, v).then(function(hash){
        log('FUND','Container funded on chain', fmtUnits(v,4)+' '+CHAIN.sym+' · tx '+short(hash), { hash:hash });
        S.balance.OKB = (BigInt(S.balance.OKB) + v).toString();
        if(!S.txs) S.txs=[];
        S.txs.unshift({ t:now(), dir:'IN', hash:hash, to:to, targetLabel:'funding ('+short(S.wallet.address)+')',
          amount:fmtUnits(v,4)+' '+CHAIN.sym, memo:'fund agent', status:'confirmed', gas:'—' });
        persist(); renderContainer(); renderOverview();
      }).catch(function(err){ toast('Funding failed: '+(err.message||err)); });
      return;
    }
    if(LIVE && asset === 'USDT'){
      copy(to, 'USDT address copied');
      toast('Send USDT to '+short(to)+' from your wallet, then hit Refresh');
      return;
    }
    S.balance[asset] = (BigInt(S.balance[asset]) + v).toString();
    var txe = { t:now(), dir:'IN', hash:randHash(), to:to, targetLabel:'funding ('+(S.wallet.address?short(S.wallet.address):'external')+')',
      amount:fmtUnits(v,4)+' '+asset, memo:'fund agent', status:'confirmed', gas:'—' };
    if(!S.txs) S.txs=[];
    S.txs.unshift(txe);
    log('FUND','Container funded', fmtUnits(v,4)+' '+asset+' credited to '+short(to), { hash:txe.hash });
    persist(); renderContainer(); renderOverview();
  };
  $('#btn-refresh-chain').onclick = function(){
    if(!LIVE){ toast('Nothing to read — no contract deployed for this page yet.'); return; }
    loadReads(CONTRACT_NAMES[0]); toast('Refreshing state…');
  };
  /* revenue buttons */
  $('#btn-save-bps').onclick = function(){
    var v = Math.max(0, Math.min(1000, Math.round(Number($('#rv-bps').value||0))));
    S.fees.bps = v; log('CONFIG','Fee updated',(v/100).toFixed(2)+'% of executed volume credited to the container');
    persist(); renderRevenue(); renderOverview();
  };
  ['#rv-execs','#rv-vol','#rv-px'].forEach(function(id){ var el=$(id); if(el) el.oninput = renderProjection; });

  /* copy delegation */
  document.addEventListener('click', function(ev){
    var t = ev.target;
    while(t && t!==document){
      if(t.getAttribute && t.getAttribute('data-copy-target')){
        var which = t.getAttribute('data-copy-target');
        if(which==='relayer'){
          copy((SERVER && SERVER.status && SERVER.status.relayer && SERVER.status.relayer.address) || 'no relayer configured', 'Relayer address copied');
          return;
        }
        copy(which==='circuit' ? S.agent.circuitId : (containerAddr()||''), which==='circuit'?'Circuit ID copied':'Container copied');
        return;
      }
      t = t.parentNode;
    }
  });

  handleHash();
  if(!location.hash || location.hash==='#') showView('start');
  window.addEventListener('hashchange', function(){ if(!handleHash()) showView('start'); });

  /* restart-safe resume */
  if(S.daemon.running){
    S.daemon.resumes = (S.daemon.resumes||0)+1;
    log('CONFIG','Daemon resumed after restart','desired state was RUNNING — resume #'+S.daemon.resumes);
  }
  if(!S.activity.length){
    log('CONFIG','Agent initialised', (LIVE?'live contracts detected':'demo simulation')+' · circuit '+S.agent.circuitId);
    log('FUND','Container ready','balance '+fmtUnits(S.balance.OKB,4)+' '+CHAIN.sym+' · keyless execution through the policy circuit');
  }
  if(!S.market.history.length){ for(var i=0;i<40;i++) advanceMarket(); }
  renderOverview(); renderFeed(); renderDaemon(); renderContainer(); renderRevenue(); renderPolicy(); renderContracts();
  initAutonomy(); renderAutonomy();
  if(API) loadServer();
  setInterval(tick, 2000);
  persist();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();