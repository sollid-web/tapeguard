/* Shared browser helpers used by the TapeGuard frontend. */
function $(s, r){ return (r||document).querySelector(s); }
function $$(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }
function mk(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!==undefined && text!==null) e.textContent=String(text); return e; }
function short(a){ a=String(a||''); return a.length>14 ? a.slice(0,8)+'…'+a.slice(-6) : a; }
function clean0x(h){ return String(h||'').replace(/^0x/,''); }
function uid(){ return Math.random().toString(36).slice(2,10); }
function now(){ return Date.now(); }
function clock(t){ var d=new Date(t||now()); return d.toLocaleTimeString([], {hour12:false}); }
function dayfmt(t){ return new Date(t).toISOString().slice(0,10); }
function fmtNum(n, dp){ dp = dp===undefined?4:dp; var s=Number(n).toFixed(dp).replace(/0+$/,'').replace(/\.$/,''); return s==='-0'?'0':s; }
function fmtUnits(v, dp){
  dp = dp===undefined?4:dp;
  var b; try{ b=BigInt(v); }catch(e){ return String(v); }
  var neg = b < 0n; var a = neg ? -b : b; var D = 10n**18n;
  var whole = a / D; var frac = (a % D).toString().padStart(18,'0').slice(0,dp).replace(/0+$/,'');
  return (neg?'-':'') + whole.toString() + (frac ? '.'+frac : '');
}
function parseUnits(s, dp){
  dp = dp===undefined?18:dp;
  var str = String(s===undefined||s===null?'0':s).trim();
  if(!/^-?\d*\.?\d*$/.test(str) || str==='' || str==='-') throw new Error('Invalid amount: '+s);
  var neg = str.charAt(0)==='-'; if(neg) str = str.slice(1);
  var parts = str.split('.'); var w = parts[0]||'0'; var f = (parts[1]||'').padEnd(dp,'0').slice(0,dp);
  var v = BigInt(w)*(10n**BigInt(dp)) + BigInt(f||'0');
  return neg ? -v : v;
}
function randHash(){
  var b = new Uint8Array(32);
  if(window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
  else for(var i=0;i<32;i++) b[i]=Math.floor(Math.random()*256);
  return '0x'+Array.prototype.map.call(b, function(x){ return x.toString(16).padStart(2,'0'); }).join('');
}
function randAddr(){
  var h = randHash().slice(2,42);
  return '0x'+h;
}
function utf8(str){
  if(window.TextEncoder) return new TextEncoder().encode(str);
  var out=[]; for(var i=0;i<str.length;i++){ var c=str.charCodeAt(i);
    if(c<128) out.push(c); else if(c<2048){ out.push(192|(c>>6),128|(c&63)); }
    else { out.push(224|(c>>12),128|((c>>6)&63),128|(c&63)); } }
  return new Uint8Array(out);
}
function bytesToHex(bytes){ return Array.prototype.map.call(bytes, function(b){ return b.toString(16).padStart(2,'0'); }).join(''); }
function hexToBytes(h){
  h = clean0x(h); if(h.length%2) h='0'+h;
  var out = new Uint8Array(h.length/2);
  for(var i=0;i<out.length;i++) out[i]=parseInt(h.substr(i*2,2),16);
  return out;
}

export { $, $$, mk, short, clean0x, uid, now, clock, dayfmt, fmtNum, fmtUnits, parseUnits, randHash, randAddr, utf8, bytesToHex, hexToBytes };
