import puppeteer from "@cloudflare/puppeteer";

function buildAwardUrl(d){
  return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${d}&A=1&RT=false&RequestType=Calendar&ShoppingMethod=onlineaward&int=flightresultsmicrosite%3Aviewby-calendar&locale=en-us&FareType=Partner+Business`;
}

async function scrapeAward(env, dateStr){
  let browser=null, page=null;
  try{
    browser=await puppeteer.launch(env.BROWSER);
    page=await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    await page.goto(buildAwardUrl(dateStr), {waitUntil:"domcontentloaded", timeout:45000});
    await new Promise(r=>setTimeout(r, 10000));

    let data = await page.evaluate(()=>{
      let txt=document.body.innerText||"";
      let title=document.title;
      let htmlLen=document.documentElement.innerHTML.length;
      let isAward = txt.includes("Lowest available award fares");
      // 用正則直接從純文字日曆解析 日期 -> 票價
      // 文字長這樣: "13\n\n85k +\n$26\n\n14\n\nN/A"
      let pairs=[];
      let re=/(\d{1,2})\s*\n+\s*(N\/A|\d{1,3}k\s*\+\s*\n?\$?\d+)/gi;
      let m;
      while((m=re.exec(txt))!==null){
        let day=parseInt(m[1],10);
        let fare=m[2].replace(/\s+/g,' ').replace(/\n/g,'').trim(); // "85k + $26" or "N/A"
        if(day>=1 && day<=31){
          pairs.push({day:day, raw:m[2], fare:fare});
        }
        if(pairs.length>40) break;
      }
      // 另外掃所有 k + $26 的原始匹配，確保不漏
      let allK=[];
      let re2=/\d{2,3}k\s*\+\s*\$?\d+/gi;
      let m2;
      while((m2=re2.exec(txt))!==null){ allK.push(m2[0].replace(/\s+/g,' ')); if(allK.length>50) break; }

      let has75 = /75k\s*\+\s*\$?26/i.test(txt);
      return {title, url:location.href, htmlLen, isAward, has75, snippet:txt.slice(0,4000), pairs, allK};
    });

    // 轉成 all 格式
    let all=[];
    for(let p of data.pairs){
      if(/k/i.test(p.fare)){
        let miles=(p.fare.match(/\d+k/i)||[""])[0].toLowerCase();
        all.push({day:String(p.day), raw:p.raw.replace(/\n/g,' ').slice(0,30), miles:miles, fare:p.fare, text:`${p.day} ${p.fare}`});
      }
    }

    return {ok:true, ...data, all, error:""};
  }catch(e){
    return {ok:false, error:String(e).slice(0,2000), stack:e.stack?.slice(0,2000), all:[], pairs:[], allK:[], snippet:"", isAward:false, has75:false, htmlLen:0, title:"", url:buildAwardUrl(dateStr)};
  }finally{
    try{if(page) await page.close();}catch{}
    try{if(browser) await browser.close();}catch{}
  }
}

function htmlDashboard(){
return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STARLUX 75K Tracker</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f8fb;margin:0;padding:24px;color:#111}.card{max-width:980px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:24px}h1{font-size:22px;margin:0 0 8px}.sub{color:#666;font-size:14px;margin-bottom:18px}.row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}input,button{padding:10px 14px;border-radius:10px;border:1px solid #ddd;font-size:14px}button{background:#0a7cff;color:#fff;border:none;cursor:pointer;font-weight:600}button:disabled{opacity:.5}.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}.ok{background:#e6f7e9;color:#1a7a2a}.warn{background:#fff3cd;color:#8a6d00}.bad{background:#fde8e8;color:#a00}.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-top:16px}.cell{border:1px solid #eee;border-radius:10px;padding:10px;min-height:64px;background:#fafcff}.cell small{color:#888;display:block}.cell b{font-size:15px}.cell.hit{background:#e8ffe9;border-color:#5ccf6a}.cell.na{opacity:.45}pre{white-space:pre-wrap;word-break:break-all;background:#f5f7fb;padding:12px;border-radius:10px;font-size:12px;max-height:260px;overflow:auto}a{color:#0a7cff;text-decoration:none}</style></head><body><div class="card"><h1>SEA to TPE STARLUX 75K Tracker <span id="status" class="badge warn">idle</span></h1><div class="sub">Using ShoppingMethod=onlineaward & FareType=Partner Business | Alaska Lowest available award fares</div><div class="row"><input id="date" type="date" value="2026-07-22"><button id="btn">Scan Now</button><button id="btn2" style="background:#111">Scan next 7 days</button><a href="/api/check?date=2026-07-22" target="_blank" style="align-self:center">Raw JSON</a></div><div id="meta" class="sub"></div><div id="grid" class="grid"></div><h3>allK fares</h3><pre id="allk"></pre><h3>Debug</h3><pre id="dbg"></pre></div><script>
const $=s=>document.querySelector(s);
function renderCalendar(all){
  const grid=$("#grid"); grid.innerHTML="";
  const map={}; (all||[]).forEach(a=>{ map[parseInt(a.day)]=a.fare; });
  for(let d=1;d<=31;d++){ let fare=map[d]||"N/A"; let div=document.createElement("div"); div.className="cell"+(fare==="N/A"?" na":"")+(fare.toLowerCase().includes("75k")?" hit":""); div.innerHTML="<small>"+d+"</small><b>"+fare+"</b>"; grid.appendChild(div); }
}
async function check(date){
  $("#status").textContent="scanning..."; $("#status").className="badge warn"; $("#btn").disabled=true;
  try{
    let r=await fetch("/api/check?date="+date).then(r=>r.json());
    $("#meta").innerHTML="isAward: <b>"+r.isAwardPage+"</b> | allCount: "+r.allCount+" | has75: "+r.has75inPage+" | <a target=_blank href='"+r.url+"'>Alaska source</a>";
    renderCalendar(r.all);
    document.getElementById("allk").textContent=JSON.stringify(r.allK,null,2);
    document.getElementById("dbg").textContent=r.debug;
    if(r.matchedCount>0){ $("#status").textContent="FOUND "+r.matchedCount+" x 75K!"; $("#status").className="badge ok"; }
    else { $("#status").textContent="no 75k ("+r.allCount+" fares)"; $("#status").className="badge bad"; }
  }catch(e){ $("#status").textContent="error"; document.getElementById("dbg").textContent=String(e); }
  $("#btn").disabled=false;
}
document.getElementById("btn").onclick=()=>check(document.getElementById("date").value);
document.getElementById("btn2").onclick=async()=>{ let base=new Date(document.getElementById("date").value); for(let i=0;i<7;i++){ let d=new Date(base); d.setDate(base.getDate()+i); let s=d.toISOString().slice(0,10); await check(s); await new Promise(r=>setTimeout(r,1200)); } };
check(document.getElementById("date").value);
<\/script></body></html>`;
}

export default {
  async fetch(req, env){
    try{
      let u=new URL(req.url);
      if(u.pathname==="/api/check"){
        let d=u.searchParams.get("date")||"2026-07-20";
        let r=await scrapeAward(env,d);
        let matched=r.all.filter(x=>x.miles==="75k");
        return new Response(JSON.stringify({
          ok:true,
          mode:"FINAL_AWARD_V2_REGEX",
          date:d,
          url:r.url,
          isAwardPage:r.isAward,
          has75inPage:r.has75,
          htmlLen:r.htmlLen,
          pairsCount:r.pairs?.length||0,
          allK:r.allK,
          allCount:r.all.length,
          all:r.all,
          matchedCount:matched.length,
          matched,
          debug:`title:${r.title}\nisAward:${r.isAward} has75:${r.has75} htmlLen:${r.htmlLen}\nallK:${JSON.stringify(r.allK.slice(0,15))}\nerror:${r.error}\nsnippet:${(r.snippet||"").slice(0,2000)}`,
          error:r.error
        },null,2),{headers:{"content-type":"application/json"}});
      }
      if(u.pathname==="/api/test-browser"){
        let b=await puppeteer.launch(env.BROWSER); let p=await b.newPage(); await p.goto("https://example.com",{waitUntil:"domcontentloaded",timeout:10000}); let t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:{"content-type":"application/json"}});
      }
      return new Response(htmlDashboard(),{headers:{"content-type":"text/html; charset=utf-8"}});
    }catch(e){ return new Response(JSON.stringify({fatal:String(e),stack:e.stack?.slice(0,2000)}),{status:500,headers:{"content-type":"application/json"}}); }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil((async()=>{
      try{
        let dates=[];
        let today=new Date();
        for(let i=0;i<14;i++){ let dd=new Date(today); dd.setDate(today.getDate()+i+5); dates.push(dd.toISOString().slice(0,10)); }
        for(let d of dates){
          let r=await scrapeAward(env,d);
          let matched=r.all.filter(x=>x.miles==="75k");
          if(matched.length>0 && env.SENDGRID_API_KEY && env.FROM_EMAIL){
            let to=env.TO_EMAIL||env.FROM_EMAIL;
            await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",headers:{"Authorization":`Bearer ${env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({personalizations:[{to:[{email:to}]}],from:{email:env.FROM_EMAIL},subject:`✈️ STARLUX 75K 出現！ ${d} (${matched.map(m=>m.day).join(",")}日)`,content:[{type:"text/plain",value:`抓到 ${d} 月曆中有 75k！\n${JSON.stringify(matched,null,2)}\n${r.url}`} ]})});
          }
          await new Promise(r=>setTimeout(r,2500));
        }
      }catch(e){}
    })());
  }
}
