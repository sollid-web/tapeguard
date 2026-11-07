import { now, parseUnits } from './core.js';
import { LIVE } from './config.js';
import { keccak256 } from './codec.js';

var KEY = 'tapeout.agent.v1';
var memStore = null;
function lsGet(){ try{ return localStorage.getItem(KEY); }catch(e){ return memStore; } }
function lsSet(v){ try{ localStorage.setItem(KEY, v); }catch(e){ memStore = v; } }

var DEMO = {
  container: '0x7ae4c9b1f0d23a85c6b4e91d2f3a5c7b8e0d1f42',
  router:    '0x2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
  treasury:  '0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c',
  stranger:  '0x1111222233334444555566667777888899990000'
};
var SEL = { swapETH: '0x7ff36ab5', transfer: '0xa9059cbb' };

function defaultState(){
  var t = now();
  return {
    v: 1,
    createdAt: t,
    mode: LIVE ? 'live' : 'demo',
    wallet: { address: null, chainId: null },
    agent: {
      circuitId: 'tapeout://circuit/dca-guard-v1',
      policyId: '0x'+keccak256('dca-guard-v1'),
      container: LIVE ? null : DEMO.container,
      active: false,
      activatedAt: 0
    },
    policy: {
      paused: false,
      maxPerTx: parseUnits('0.5').toString(),
      dailyLimit: parseUnits('2').toString(),
      windowStart: t,
      allowlist: [
        { label:'X Layer DEX router', target: DEMO.router, selectors:[SEL.swapETH] },
        { label:'Treasury (cold)', target: DEMO.treasury, selectors:[SEL.transfer] }
      ],
      expiry: 0,
      owner: 'circuit container'
    },
    balance: { OKB: parseUnits('12.4').toString(), USDT: parseUnits('250').toString() },
    spend: [],
    activity: [],
    daemon: { running:false, startedAt:0, ticks:0, lastTick:0, resumes:0 },
    triggers: [
      { id:'tg1', type:'price', name:'DCA guard', enabled:true, op:'<=', threshold:42.0, cooldownMs:30000, lastFired:0,
        action:{ label:'Buy BEM on dip', target:DEMO.router, targetLabel:'X Layer DEX router', selector:SEL.swapETH, value:parseUnits('0.30').toString(), memo:'DCA buy via daemon', receiveUsdt:parseUnits('13.2').toString() } },
      { id:'tg2', type:'event', name:'TapeOut task reward', enabled:true, p:0.08, cooldownMs:45000, lastFired:0,
        action:{ label:'Sweep reward to treasury', target:DEMO.treasury, targetLabel:'Treasury (cold)', selector:SEL.transfer, value:parseUnits('0.10').toString(), memo:'reward sweep' } },
      { id:'tg3', type:'block', name:'Block heartbeat', enabled:true, blocks:15, cooldownMs:25000, lastFired:0, lastBlock:0,
        action:{ label:'Micro DCA', target:DEMO.router, targetLabel:'X Layer DEX router', selector:SEL.swapETH, value:parseUnits('0.05').toString(), memo:'heartbeat buy', receiveUsdt:parseUnits('2.2').toString() } }
    ],
    market: { price: 44.2, threshold: 42.0, history: [], tasksMinted: 1284, activeMiners: 46, blockHeight: 41802300 },
    fees: { activation: parseUnits('5').toString(), bps: 20, ledger: [], paid: false },
    pending: [],
    filters: 'all'
  };
}
export { KEY, DEMO, SEL, lsGet, lsSet, defaultState };
