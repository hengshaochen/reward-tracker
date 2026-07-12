
import puppeteer from "@cloudflare/puppeteer";

const DEFAULT_MAX = 85000;
function getKV(env){ return env.CACHE || env["alaska-cache"] || env.KV; }
function maskEmail(e){ try{const [l,d]=e.split("@"); if(!d) return e; return l.slice(0,3)+"****"+l.slice(-2)+"@"+d;}catch{return e;} }
async function getConfig(kv){ if(!kv) return {maxMiles:DEFAULT_MAX}; try{const r=await kv.get("config"); return r?JSON.parse(r):{maxMiles:DEFAULT_MAX};}catch{return {maxMiles:DEFAULT_MAX}} }
async function saveConfig(kv,c){ if(kv) await kv.put("config", JSON.stringify(c)); }
async function getSubs(kv){ if(!kv) return []; try{const raw=await kv.get("subscribers"); if(!raw) return []; const arr=JSON.parse(raw); return arr.map(i=>typeof i==="string"?{email:i.toLowerCase(),maxMiles:null}:{email:(i.email||"").toLowerCase().trim(),maxMiles:i.maxMiles?parseInt(i.maxMiles,10):null}).filter(s=>s.email.includes("@"));}catch{return [];} }
async function saveSubs(kv,list){ const m=new Map(); for(const s of list){ const k=s.email.toLowerCase().trim(); if(!m.has(k)) m.set(k,s);} if(kv) await kv.put("subscribers", JSON.stringify([...m.values()])); }
async function sendEmail(env,to,subject,html){ const r=await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",headers:{"Authorization":`Bearer ${env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({personalizations:[{to:[{email:to}]}],from:{email:env.FROM_EMAIL.trim(),name:"STARLUX Monitor"},subject,content:[{type:"text/html",value:html}],tracking_settings:{click_tracking:{enable:false},open_tracking:{enable:false}}})}); const t=await r.text(); if(!r.ok) throw new Error(`SendGrid ${r.status}: ${t.slice(0,400)}`); }
function cors(){return{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};}

function buildAwardUrl(dateStr){
  return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${dateStr}&A=1&RT=false&RequestType=Calendar&ShoppingMethod=onlineaward&int=flightresultsmicrosite%3Aviewby-calendar&locale=en-us&FareType=Partner+Business`;
}

async function scrapeAward(env, maxMiles, dateStr){
  if(!env.BROWSER) throw new Error("BROWSER binding missing");
  let browser=null, page=null;
  try{
    browser=await puppeteer.launch(env.BROWSER);
    page=await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    const url=buildAwardUrl(dateStr);
    await page.goto(url,{waitUntil:"domcontentloaded", timeout:45000});
    await new Promise(r=>setTimeout(r,10000));
    const data=await page.evaluate(()=>{
      let txt=document.body.innerText||"";
      let title=document.title;
      let htmlLen=document.documentElement.innerHTML.length;
      let isAward=txt.includes("Lowest available award fares");
      let pairs=[];
      let re=/(\d{1,2})\s*\n+\s*(N\/A|\d{1,3}k\s*\+\s*\n?\$?\d+)/gi;
      let m;
      while((m=re.exec(txt))!==null){
        let day=parseInt(m[1],10);
        let fare=m[2].replace(/\s+/g,' ').replace(/\n/g,'').trim();
        if(day>=1&&day<=31){ pairs.push({day, raw:m[2], fare}); }
        if(pairs.length>40) break;
      }
      let allK=[]; let re2=/\d{2,3}k\s*\+\s*\$?\d+/gi; let m2;
      while((m2=re2.exec(txt))!==null){ allK.push(m2[0].replace(/\s+/g,' ')); if(allK.length>60) break; }
      let has75=/75k\s*\+\s*\$?26/i.test(txt);
      return {title, url:location.href, htmlLen, isAward, has75, snippet:txt.slice(0,4000), pairs, allK, txtLen:txt.length};
    });
    let tickets=[];
    for(let p of data.pairs){
      if(p.fare==="N/A") continue;
      let mm=p.fare.match(/(\d+)k/i); if(!mm) continue;
      let miles=parseInt(mm[1],10)*1000;
      if(miles<=maxMiles){
        tickets.push({date:`${dateStr.slice(0,7)}-${String(p.day).padStart(2,'0')}`, day:String(p.day), miles, fare:p.fare, tax:"$26", flight:"JX STARLUX"});
      }
    }
    return {ok:true, ...data, tickets, all:data.pairs.filter(p=>p.fare!=="N/A").map(p=>{let m=p.fare.match(/(\d+)k/i); return {day:String(p.day), miles:m?m[1]+"k":"", fare:p.fare, text:`${p.day} ${p.fare}`}}), error:""};
  }catch(e){
    return {ok:false, error:String(e).slice(0,1200), tickets:[], all:[], pairs:[], allK:[], snippet:"", isAward:false, has75:false, htmlLen:0, title:"", url:buildAwardUrl(dateStr)};
  }finally{ try{if(page) await page.close();}catch{} try{if(browser) await browser.close();}catch{} }
}

function buildHtml(eff, tickets, debug){
  const k=eff/1000;
  if(!tickets.length) return `<!DOCTYPE html><body style="font-family:system-ui;padding:20px"><h2>掃描結果 ≤${k}k：0 張</h2><p>目前日曆沒有 ≤${k}k 的票，多為 85k / 175k / 250k。</p><pre style="background:#0f172a;color:#cbd5e1;padding:12px;border-radius:8px;white-space:pre-wrap">${(debug||"").slice(0,2000)}</pre></body>`;
  return `<!DOCTYPE html><body style="font-family:system-ui;background:#f6f9fc;margin:0;padding:16px"><div style="max-width:600px;margin:auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden"><div style="background:#02426D;color:#fff;padding:18px 22px"><h2 style="margin:0">STARLUX 命中 ≤${k}k！</h2><div style="font-size:13px;opacity:.9">${tickets.length} 天符合</div></div><div style="padding:20px"><ul style="list-style:none;padding:0;margin:0">${tickets.map(t=>`<li style="padding:12px 0;border-bottom:1px solid #f1f5f9"><b>${t.date}</b> <span style="color:#02426D;font-weight:800">${t.miles/1000}k +${t.tax}</span></li>`).join("")}</ul><a href="https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${tickets[0].date}&A=1&RT=false&RequestType=Calendar&ShoppingMethod=onlineaward&FareType=Partner+Business" style="background:#02426D;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block;margin-top:16px">去搶票 →</a></div></div></body>`;
}

function htmlDashboard(){
return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STARLUX 75K Tracker</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f8fb;margin:0;padding:24px;color:#111}
.card{max-width:980px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 6px} h3{margin:16px 0 8px;font-size:16px}
.sub{color:#666;font-size:13px;margin-bottom:12px;line-height:1.5}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:12px}
input{padding:10px 12px;border-radius:10px;border:1px solid #d0d7de;font-size:14px;flex:1;min-width:180px}
button{padding:10px 16px;border-radius:10px;border:0;font-weight:700;cursor:pointer}
.p{background:#0a7cff;color:#fff} .dark{background:#111;color:#fff} .ok{background:#16a34a;color:#fff} .ghost{background:#eef2f7;color:#333}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700}
.badge.ok{background:#dcfce7;color:#166534} .badge.bad{background:#fee2e2;color:#991b1b} .badge.warn{background:#fef3c7;color:#92400e}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-top:12px}
.cell{border:1px solid #e5e7eb;border-radius:10px;padding:10px;min-height:62px;background:#fbfdff}
.cell small{color:#888;display:block;font-size:11px} .cell b{font-size:14px}
.cell.hit{background:#dcfce7;border-color:#22c55e} .cell.na{opacity:.4}
pre{white-space:pre-wrap;word-break:break-all;background:#0f172a;color:#cbd5e1;padding:12px;border-radius:10px;font-size:12px;max-height:280px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px} th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
a{color:#0a7cff;text-decoration:none}
</style></head><body>
<div class="card">
<h1>✈️ SEA → TPE STARLUX 75K 監控 <span id="status" class="badge warn">idle</span></h1>
<div class="sub">已修正為正確里程 URL <code>ShoppingMethod=onlineaward</code> + <code>FareType=Partner+Business</code>，來源 <b>Lowest available award fares</b>。支援 Email 訂閱，排程每 30 分鐘自動掃描。</div>
<div class="row"><input id="date" type="date" value="2026-07-22"><button id="btn" class="p">立即掃描此月</button><button id="btn7" class="dark">掃未來 7 天</button><a href="/api/check?date=2026-07-22" target="_blank" class="ghost" style="padding:10px 12px;border-radius:10px;text-decoration:none">Raw JSON</a></div>
<div id="meta" class="sub"></div>
<div id="grid" class="grid"></div>
</div>

<div class="card">
<h3>📧 Email 訂閱通知</h3>
<div class="sub">訂閱後一旦掃到 ≤ 你設定的門檻（預設 85k，75k 出現也會通知），系統會用 SendGrid 寄信。資料存在 KV，可隨時退訂。</div>
<div class="row"><input id="email" placeholder="you@gmail.com"><input id="max" placeholder="85000 (預設 85000 = 85k)"><button id="subBtn" class="ok">訂閱並測試寄信</button><button id="unsubBtn" class="ghost">退訂</button></div>
<div id="subMsg" class="sub"></div>
<div id="subsTable"></div>
</div>

<div class="card"><h3>原始票價 allK</h3><pre id="allk"></pre><h3>Debug</h3><pre id="dbg"></pre></div>

<script>
const $=s=>document.querySelector(s);
function renderCalendar(all){
  const grid=$("#grid"); grid.innerHTML="";
  const map={}; (all||[]).forEach(a=>{ map[parseInt(a.day)]=a.fare; });
  for(let d=1;d<=31;d++){ let fare=map[d]||"N/A"; let div=document.createElement("div"); div.className="cell"+(fare==="N/A"?" na":"")+(fare.toLowerCase().includes("75k")?" hit":""); div.innerHTML="<small>"+d+"日</small><b>"+fare+"</b>"; grid.appendChild(div); }
}
async function check(date){
  $("#status").textContent="scanning..."; $("#status").className="badge warn"; $("#btn").disabled=true;
  try{
    let r=await fetch("/api/check?date="+date).then(r=>r.json());
    $("#meta").innerHTML="isAward: <b>"+r.isAwardPage+"</b> | htmlLen: "+r.htmlLen+" | allCount: "+r.allCount+" | has75: "+r.has75inPage+" | <a target=_blank href='"+r.url+"'>Alaska 原網頁</a>";
    renderCalendar(r.all);
    $("#allk").textContent=JSON.stringify(r.allK,null,2);
    $("#dbg").textContent=r.debug;
    if(r.matchedCount>0){ $("#status").textContent="FOUND "+r.matchedCount+" x ≤門檻!"; $("#status").className="badge ok"; }
    else { $("#status").textContent="no match ("+r.allCount+" fares)"; $("#status").className="badge bad"; }
    loadSubs();
  }catch(e){ $("#status").textContent="error"; $("#dbg").textContent=String(e); }
  $("#btn").disabled=false;
}
async function loadSubs(){
  try{ let r=await fetch("/api/subs").then(r=>r.json()); let html="<table><tr><th>Email</th><th>門檻</th></tr>"+r.subs.map(s=>"<tr><td>"+s.email+"</td><td>"+(s.maxMiles||"全域")+"</td></tr>").join("")+"</table><div class=sub>共 "+r.subs.length+" 人 | 全域門檻 "+(r.config.maxMiles/1000)+"k</div>"; $("#subsTable").innerHTML=html; }catch(e){}
}
$("#btn").onclick=()=>check($("#date").value);
$("#btn7").onclick=async()=>{ let base=new Date($("#date").value); for(let i=0;i<7;i++){ let d=new Date(base); d.setDate(base.getDate()+i); let s=d.toISOString().slice(0,10); await check(s); await new Promise(r=>setTimeout(r,900)); } };
$("#subBtn").onclick=async()=>{
  let email=$("#email").value.trim(); let max=$("#max").value.trim(); if(!email.includes("@")){ $("#subMsg").textContent="請輸入正確 Email"; return; }
  $("#subMsg").textContent="訂閱中並真爬測試寄信，約 15 秒..."; let r=await fetch("/api/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,maxMiles:max?parseInt(max):null})}); let j=await r.json(); $("#subMsg").textContent=r.ok?"✅ 已訂閱並已寄測試信，請收信箱":"❌ "+j.error; loadSubs();
};
$("#unsubBtn").onclick=async()=>{ let email=$("#email").value.trim(); if(!email) return; let r=await fetch("/api/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})}); let j=await r.json(); $("#subMsg").textContent=j.ok?"已退訂":"失敗"; loadSubs(); };
check($("#date").value); loadSubs();
</script>
</body></html>`;
}

export default{
 async fetch(req,env,ctx){
  const u=new URL(req.url); const kv=getKV(env);
  if(req.method==="OPTIONS") return new Response(null,{headers:cors()});
  if(u.pathname==="/api/config"){
    if(req.method==="GET"){const c=await getConfig(kv);return new Response(JSON.stringify(c),{headers:cors()});}
    const {maxMiles}=await req.json(); await saveConfig(kv,{maxMiles}); return new Response(JSON.stringify({ok:true}),{headers:cors()});
  }
  if(u.pathname==="/api/subs"){ const subs=await getSubs(kv); const cfg=await getConfig(kv); return new Response(JSON.stringify({subs,config:cfg}),{headers:cors()}); }
  if(u.pathname==="/api/test-browser"){ try{ const b=await puppeteer.launch(env.BROWSER); const p=await b.newPage(); await p.goto("https://example.com"); const t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:cors()}); }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:cors()}); } }
  if(u.pathname==="/api/subscribe"&&req.method==="POST"){
    try{
      const {email,maxMiles}=await req.json(); const clean=(email||"").toLowerCase().trim(); if(!clean.includes("@")) throw new Error("invalid email");
      const subs=await getSubs(kv); const idx=subs.findIndex(s=>s.email===clean); if(idx>=0) subs[idx].maxMiles=maxMiles?parseInt(maxMiles,10):null; else subs.push({email:clean,maxMiles:maxMiles?parseInt(maxMiles,10):null}); await saveSubs(kv,subs);
      const cfg=await getConfig(kv); const eff=maxMiles||cfg.maxMiles||DEFAULT_MAX;
      const dateStr=new Date().toISOString().slice(0,10);
      const {tickets, debug, all, allK, isAward}=await scrapeAward(env, eff, dateStr);
      const html=buildHtml(eff,tickets,debug);
      await sendEmail(env,clean,`[已訂閱] 門檻 ≤${eff/1000}k ${tickets.length?`命中${tickets.length}天`:`目前0張，測試信`}`,html);
      return new Response(JSON.stringify({ok:true,mode:"REAL_AWARD",effective:eff,matched:tickets.length,tickets,all,allK,isAward,debug}),{headers:cors()});
    }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message,stack:e.stack?.slice(0,800)}),{status:500,headers:cors()}); }
  }
  if(u.pathname==="/api/check"){
    try{
      const d=u.searchParams.get("date")||new Date().toISOString().slice(0,10);
      const cfg=await getConfig(kv); const g=cfg.maxMiles||DEFAULT_MAX;
      const r=await scrapeAward(env,g,d);
      const matched=r.tickets;
      return new Response(JSON.stringify({ok:true,mode:"REAL_AWARD",date:d,url:r.url,isAwardPage:r.isAward,has75inPage:r.has75,htmlLen:r.htmlLen,pairsCount:r.pairs?.length||0,allK:r.allK,allCount:r.all.length,all:r.all,matchedCount:matched.length,matched,tickets:matched,debug:`title:${r.title}\nisAward:${r.isAward} has75:${r.has75} htmlLen:${r.htmlLen}\nallK:${JSON.stringify(r.allK.slice(0,12))}\nerror:${r.error}\nsnippet:${(r.snippet||"").slice(0,1500)}`,error:r.error},null,2),{headers:{"Content-Type":"application/json",...cors()}});
    }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message,stack:e.stack?.slice(0,800)}),{status:500,headers:cors()}); }
  }
  if(u.pathname==="/api/unsubscribe"){ let email=""; if(req.method==="POST"){const b=await req.json().catch(()=>({})); email=(b.email||"").toLowerCase().trim();} else email=(u.searchParams.get("email")||"").toLowerCase().trim(); let subs=await getSubs(kv); subs=subs.filter(s=>s.email!==email); await saveSubs(kv,subs); return new Response(JSON.stringify({ok:true}),{headers:cors()}); }
  if(u.pathname==="/"){ return new Response(htmlDashboard(),{headers:{"Content-Type":"text/html; charset=utf-8",...cors()}}); }
  return new Response("Not found",{status:404,headers:cors()});
 },
 async scheduled(ev,env,ctx){
  ctx.waitUntil((async()=>{
    try{
      const kv=getKV(env); const cfg=await getConfig(kv); const g=cfg.maxMiles||DEFAULT_MAX; const subs=await getSubs(kv); if(!subs.length) return;
      const today=new Date(); const dateStr=today.toISOString().slice(0,10);
      const r=await scrapeAward(env,g,dateStr);
      if(!r.tickets.length) return;
      for(const s of subs){ const eff=s.maxMiles||g; const m=r.tickets.filter(t=>t.miles<=eff); if(!m.length) continue; await sendEmail(env,s.email,`[${eff/1000}k] STARLUX 命中 ${m[0].date} ${m[0].miles/1000}k`,buildHtml(eff,m,r.snippet)); await new Promise(r=>setTimeout(r,800)); }
    }catch(e){ console.log("cron fail",e.message); }
  })());
 }
}
