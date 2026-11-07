import { short, dayfmt, fmtUnits } from './core.js';
import { word } from './codec.js';

var RULE_CODE = {
  'Circuit not paused':'PAUSED',
  'Target on allowlist':'TARGET_NOT_ALLOWED',
  'Selector permitted':'SELECTOR_NOT_ALLOWED',
  'Per-transaction limit':'TX_LIMIT_EXCEEDED',
  'Rolling 24h volume cap':'DAILY_VOLUME_EXCEEDED',
  'Circuit validity window':'CIRCUIT_EXPIRED',
  'Authorized requester':'NOT_AUTHORIZED'
};

function createPolicy(ctx){
  function state(){ return ctx.getState(); }
  function spentInWindow(){
    var from=ctx.now()-24*3600*1000, sum=0n;
    (state().spend||[]).forEach(function(item){ if(item.at>=from){ try{sum+=BigInt(item.amount);}catch(e){} } });
    return sum;
  }
  function evaluate(action){
    var S=state(), p=S.policy, checks=[], val=BigInt(action.value||0);
    function add(name,pass,detail){ checks.push({name:name,pass:!!pass,detail:detail}); }
    add('Circuit not paused',!p.paused,p.paused?'policy.paused == true':'policy.paused == false');
    var entry=null;
    for(var i=0;i<p.allowlist.length;i++){ if(p.allowlist[i].target.toLowerCase()===String(action.target).toLowerCase()){entry=p.allowlist[i];break;} }
    add('Target on allowlist',!!entry,entry?('allowlist['+p.allowlist.indexOf(entry)+'] · '+entry.label):(short(action.target)+' is not one of the '+p.allowlist.length+' allowed targets'));
    var selOk=!entry||!entry.selectors||entry.selectors.length===0||entry.selectors.indexOf(String(action.selector).toLowerCase())>=0;
    add('Selector permitted',selOk,entry&&entry.selectors&&entry.selectors.length?(selOk?action.selector+' ∈ allowed set':action.selector+' not allowed on this target'):'no selector restriction for this target');
    var perTx=val<=BigInt(p.maxPerTx); add('Per-transaction limit',perTx,fmtUnits(val)+' ≤ '+fmtUnits(p.maxPerTx)+' '+ctx.chain.sym);
    var after=spentInWindow()+val, cap=BigInt(p.dailyLimit); add('Rolling 24h volume cap',after<=cap,fmtUnits(after)+' / '+fmtUnits(cap)+' '+ctx.chain.sym+' in the last 24h');
    var expOk=!p.expiry||ctx.now()<p.expiry; add('Circuit validity window',expOk,p.expiry?(expOk?'expires '+dayfmt(p.expiry):'expired '+dayfmt(p.expiry)):'no expiry set');
    add('Authorized requester',true,'daemon permit bound to circuit '+short(S.agent.circuitId));
    var failed=null; for(i=0;i<checks.length;i++){if(!checks[i].pass){failed=checks[i];break;}}
    return {ok:!failed,checks:checks,passed:checks.filter(function(c){return c.pass;}).length,total:checks.length,code:failed?RULE_CODE[failed.name]:null,reason:failed?failed.detail:null};
  }
  function buildExecutionRequest(action){
    var S=state(), sel=String(action.selector||'').slice(0,10); if(sel.length<10) sel=ctx.selectors.transfer;
    return {version:1,circuitId:S.agent.circuitId,policyId:S.agent.policyId,container:ctx.containerAddr(),chainId:ctx.chainId,target:action.target,selector:sel,calldata:sel+word(BigInt(action.target)).slice(24).padEnd(64,'0'),value:action.value,memo:action.memo,proposedAt:ctx.now(),policy:{maxPerTx:S.policy.maxPerTx,dailyLimit:S.policy.dailyLimit,spent24h:spentInWindow().toString()}};
  }
  return {spentInWindow:spentInWindow,evaluate:evaluate,buildExecutionRequest:buildExecutionRequest};
}
export { createPolicy };
