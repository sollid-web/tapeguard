/* Pure RPC endpoint validation. */
function safeRpcUrl(raw){
  if(typeof raw !== 'string') return null;
  var v = raw.trim();
  if(!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])(\:[0-9]{2,5})?(\/[^\s"'<>]*)?$/i.test(v)) return null;
  if(v.indexOf('@') !== -1) return null;
  return v;
}
export { safeRpcUrl };
