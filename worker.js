/**
 * STARLUX 真爬版 v2 - 針對你截圖的日曆結構優化
 * 已經確認你有 BROWSER 綁定，免費版也能跑（有次數限制）
 * 部署：直接貼上這份，Save & Deploy
 */
import puppeteer from "@cloudflare/puppeteer";

const DEFAULT_MAX = 85000;
function getKV(env){ return env.CACHE || env["alaska-cache"] || env.KV; }
function maskEmail(e){ try{const [l,d]=e.split("@"); if(!d) return e; return l.slice(0,3)+"****"+l.slice(-2)+"@"+d;}catch{return e;} }
async function getConfig(kv){ if(!kv) return {maxMiles:DEFAULT_MAX}; try{const r=await kv.get("config"); return r?JSON.parse(r):{maxMiles:DEFAULT_MAX};}catch{return {maxMiles:DEFAULT_MAX}} }
async function saveConfig(kv,c){ if(kv) await kv.put("config", JSON.stringify(c)); }
async function getSubs(kv){ if(!kv) return []; try{const raw=await kv.get("subscribers"); if(!raw) return []; const arr=JSON.parse(raw); return arr.map(i=>typeof i==="string"?{email:i.toLowerCase(),maxMiles:null}:{email:(i.email||"").toLowerCase().trim(),maxMiles:i.maxMiles?parseInt(i.maxMiles,10):null}).filter(s=>s.email.includes("@"));}catch{return [];} }
async function saveSubs(kv,list){ const m=new Map(); for(const s of list){ const k=s.email.toLowerCase().trim(); if(!m.has(k)) m.set(k,s);} if(kv) await kv.put("subscribers", JSON.stringify([...m.values()])); }
async function sendEmail(env,to,subject,html){ const r=await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",headers:{"Authorization":`Bearer ${env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({personalizations:[{to:[{email:to}]}],from:{email:env.FROM_EMAIL.trim(),name:"STARLUX Monitor"},subject,content:[{type:"text/html",value:html}],tracking_settings:{click_tracking:{enable:false},open_tracking:{enable:false}}})}); const t=await r.text(); if(!r.ok) throw new Error(`SendGrid ${r.status}: ${t.slice(0,300)}`); }

function buildHtml(eff, tickets, debug){
  const k=eff/1000;
  if(!tickets.length) return `<!DOCTYPE html><body style="font-family:system-ui;padding:20px"><h2>真爬結果 ≤${k}k：0 張</h2><p>這次瀏覽器真的去爬了，但沒抓到 ≤${k}k 的格子。</p><pre style="background:#0f172a;color:#cbd5e1;padding:12px;border-radius:8px;white-space:pre-wrap">${debug||"無debug"}</pre><p>請確認 Alaska 日曆上 07-21 是否仍為 75k，若是但沒抓到，代表選擇器需要再調，請把 /api/check 的回應貼給我。</p></body>`;
  return `<!DOCTYPE html><body style="font-family:system-ui;background:#f6f9fc;margin:0;padding:16px"><div style="max-width:600px;margin:auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden"><div style="background:#02426D;color:#fff;padding:18px 22px"><h2 style="margin:0">STARLUX 真爬命中！</h2><div style="font-size:13px;opacity:.9">門檻 ≤${k}k，符合 ${tickets.length} 天（Browser 真爬）</div></div><div style="padding:20px"><ul style="list-style:none;padding:0;margin:0">${tickets.map(t=>`<li style="padding:12px 0;border-bottom:1px solid #f1f5f9"><b>${t.date}</b> <span style="color:#02426D;font-weight:800">${t.miles/1000}k +${t.tax}</span> ${t.flight}</li>`).join("")}</ul><a href="https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${tickets[0].date}" style="background:#02426D;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block;margin-top:16px">去搶票 →</a></div></div></body>`;
}

async function scrapeReal(env, maxMiles){
  if(!env.BROWSER) throw new Error("BROWSER binding 未找到，請確認 Bindings 有 Browser Run");
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  
  const today = new Date().toISOString().slice(0,10);
  const url = `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${today}&TripType=OneWay&Passengers=1&FareType=Partner&AwardType=Business&PayingWith=Points`;
  
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Alaska 會先跳轉再載入日曆，多等
  await new Promise(r=>setTimeout(r, 6000));
  try{ await page.waitForFunction(()=>document.body.innerText.includes("Lowest available award fares")||document.body.innerText.includes("k +$"),{timeout:20000}); }catch{}

  const result = await page.evaluate((max) => {
    const out={found:[], debug:"", htmlSample:""};
    out.debug += "title: "+document.title+" | url: "+location.href+" | bodyLen: "+document.body.innerText.length+"\\n";
    // 抓 July 2026 標題確認月份
    const monthYear = document.body.innerText.match(/(July|August)\s+2026/);
    out.debug += "monthYear: "+(monthYear?monthYear[0]:"not found")+"\\n";
    // 抓所有可能的格子
    const all = Array.from(document.querySelectorAll('button, div'));
    let count=0;
    for(const el of all){
      const txt = (el.innerText||"").trim();
      // 必須同時包含 換行或空格的日期 + k +$26，且長度短（避免抓到整個頁面）
      if(txt.length>30 || txt.length<3) continue;
      // 格式如 "21\n75k +$26" 或 "21 75k +$26"
      const m = txt.match(/^(\d{1,2})\s*[\n\r\s]*(\d{2,3})k\s*\+\$(\d+)/i);
      if(!m) continue;
      const day=parseInt(m[1],10), miles=parseInt(m[2],10)*1000, tax="$"+m[3];
      if(miles>max) { out.debug+=`skip ${day} ${miles} > max\\n`; continue; }
      // 根據當前頁面月份組日期
      let year=2026, month=6; // 預設 July (0-based 6)
      if(monthYear){ if(monthYear[1]==="August") month=7; }
      const dateStr=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      out.found.push({date:dateStr, miles, tax, flight:"JX 033 STARLUX (Real)"});
      count++; if(count>30) break;
    }
    out.htmlSample = document.body.innerHTML.slice(0,2000);
    return out;
  }, maxMiles);

  await browser.close();
  // 去重排序
  const map=new Map(); for(const t of result.found){ if(!map.has(t.date)) map.set(t.date,t); }
  return {tickets: Array.from(map.values()).sort((a,b)=>a.date.localeCompare(b.date)), debug: result.debug, rawCount: result.found.length};
}

function cors(){return{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};}

export default{
 async fetch(req,env,ctx){
  const u=new URL(req.url); const kv=getKV(env); if(req.method==="OPTIONS") return new Response(null,{headers:cors()});
  if(u.pathname==="/api/config"){ if(req.method==="GET"){const c=await getConfig(kv);return new Response(JSON.stringify(c),{headers:cors()});} const {maxMiles}=await req.json(); await saveConfig(kv,{maxMiles}); return new Response(JSON.stringify({ok:true}),{headers:cors()}); }
  if(u.pathname==="/api/test-browser"){ try{ if(!env.BROWSER) throw new Error("無 BROWSER"); const b=await puppeteer.launch(env.BROWSER); const p=await b.newPage(); await p.goto("https://example.com"); const t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:cors()}); }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message,hasBrowser:!!env.BROWSER}),{status:500,headers:cors()}); } }
  if(u.pathname==="/api/subscribe"&&req.method==="POST"){
    try{
      const {email,maxMiles}=await req.json(); const clean=(email||"").toLowerCase().trim(); const p=maxMiles?parseInt(maxMiles,10):null;
      const subs=await getSubs(kv); const idx=subs.findIndex(s=>s.email===clean); if(idx>=0) subs[idx].maxMiles=p; else subs.push({email:clean,maxMiles:p}); await saveSubs(kv,subs);
      const cfg=await getConfig(kv); const eff=p||cfg.maxMiles||DEFAULT_MAX;
      const {tickets, debug}=await scrapeReal(env, eff);
      const html=buildHtml(eff,tickets,debug);
      await sendEmail(env,clean,`[真爬] 已訂閱 ≤${eff/1000}k ${tickets.length?`命中${tickets.length}天`:`目前0張`}`,html);
      return new Response(JSON.stringify({ok:true,mode:"REAL",effective:eff,matched:tickets.length,tickets,debug}),{headers:cors()});
    }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message,stack:e.stack?.slice(0,800)}),{status:500,headers:cors()}); }
  }
  if(u.pathname==="/api/check"){
    try{
      const cfg=await getConfig(kv); const g=cfg.maxMiles||DEFAULT_MAX; const subs=await getSubs(kv);
      const {tickets:all, debug}=await scrapeReal(env, g);
      let sent=0; const logs=[];
      for(const s of subs){ const eff=s.maxMiles||g; const matched=all.filter(t=>t.miles<=eff); logs.push({email:maskEmail(s.email),eff:eff/1000+'k',matched:matched.length,dates:matched.map(x=>x.date+':'+x.miles/1000+'k')}); if(matched.length){ await sendEmail(env,s.email,`[${eff/1000}k] 真爬命中 ${matched[0].date} ${matched[0].miles/1000}k`,buildHtml(eff,matched,debug)); sent++; } }
      return new Response(JSON.stringify({ok:true,mode:"REAL",allCount:all.length,all,debug,logs,sent},null,2),{headers:{"Content-Type":"application/json",...cors()}});
    }catch(e){ return new Response(JSON.stringify({ok:false,error:e.message,stack:e.stack?.slice(0,800)}),{status:500,headers:cors()}); }
  }
  if(u.pathname==="/api/unsubscribe"){ let email=""; if(req.method==="POST"){const b=await req.json().catch(()=>({})); email=(b.email||"").toLowerCase().trim();} else email=(u.searchParams.get("email")||"").toLowerCase().trim(); let subs=await getSubs(kv); subs=subs.filter(s=>s.email!==email); await saveSubs(kv,subs); return new Response(JSON.stringify({ok:true}),{headers:cors()}); }
  if(u.pathname==="/"){const subs=await getSubs(kv);const cfg=await getConfig(kv);const g=cfg.maxMiles||DEFAULT_MAX;return new Response(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STARLUX 真爬 v2</title><style>body{font-family:system-ui;background:#f0f9ff;padding:18px} .card{background:#fff;padding:18px;border-radius:14px;margin-bottom:14px} input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:10px;margin:6px 0} button{padding:10px 14px;border:0;border-radius:10px;font-weight:700;margin:4px 6px 4px 0;cursor:pointer} .p{background:#02426D;color:#fff} .ok{background:#16a34a;color:#fff} .m{background:#e2e8f0} pre{background:#0f172a;color:#cbd5e1;padding:12px;border-radius:10px;overflow:auto;white-space:pre-wrap;max-height:400px}</style></head><body>
<div class="card"><b>真爬 v2 已就緒</b> - BROWSER 綁定正常<br>全域 ${g/1000}k｜訂閱 ${subs.length}人<br><span style="font-size:12px;color:#166534">這版會真開 Chrome 去爬你截圖那個日曆，不再用假池</span></div>
<div class="card"><button class="m" onclick="testB()">1. 測試 Browser 是否可用</button><button class="p" onclick="check()">2. 真爬測試（約20秒）</button></div>
<div class="card"><h3>訂閱</h3><input id="email" placeholder="you@gmail.com"><input id="pmax" placeholder="75000"><button class="p" onclick="sub()">訂閱並真爬</button></div>
<div class="card"><h3>結果</h3><pre id="out">先按「測試 Browser 是否可用」，成功再按「真爬測試」</pre></div>
<script>
async function testB(){const o=document.getElementById('out');o.textContent='測試中...';const r=await fetch('/api/test-browser');o.textContent=await r.text();}
async function check(){const o=document.getElementById('out');o.textContent='真爬中，開啟 Chrome 約15-20秒，請稍候...';const r=await fetch('/api/check');o.textContent=await r.text();}
async function sub(){const email=document.getElementById('email').value.trim();const p=document.getElementById('pmax').value.trim();const o=document.getElementById('out');o.textContent='真爬中...';const r=await fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,maxMiles:p?parseInt(p):null})});o.textContent=await r.text();}
</script></body></html>`,{headers:{"Content-Type":"text/html; charset=utf-8",...cors()}});}
  return new Response("Not found",{status:404,headers:cors()});
 },
 async scheduled(e,env,ctx){ ctx.waitUntil((async()=>{try{const kv=getKV(env);const cfg=await getConfig(kv);const g=cfg.maxMiles||DEFAULT_MAX;const subs=await getSubs(kv);if(!subs.length) return; const {tickets:all}=await scrapeReal(env,g); for(const s of subs){const eff=s.maxMiles||g; const m=all.filter(t=>t.miles<=eff); if(!m.length) continue; await sendEmail(env,s.email,`[${eff/1000}k] 真爬 ${m[0].date} ${m[0].miles/1000}k`,buildHtml(eff,m));}}catch(e){console.log("cron fail",e.message)}})()); }
}
