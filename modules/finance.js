/* Pure financial and trigger helpers. */
function triggerThreshold(triggers){
  var t = null;
  (triggers || []).forEach(function(g){ if(g.type==='price' && (t===null || g.threshold<t)) t = g.threshold; });
  return t===null ? 42 : t;
}
function feeTotal(ledger, activation, paid){
  var sum = 0n;
  (ledger || []).forEach(function(l){ try{ sum += BigInt(l.amount); }catch(e){} });
  if(paid){ try{ sum += BigInt(activation); }catch(e){} }
  return sum;
}
export { triggerThreshold, feeTotal };
