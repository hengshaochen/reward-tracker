import puppeteer from "@cloudflare/puppeteer";

function buildUrl(d){ return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${d}&TripType=OneWay&Passengers=1&FareType=Partner&AwardType=Business&PayingWith=Points`; }

async function scrape(env, dateStr){
  let browser=null, page=null;
  let network=[];
  try{
    browser=await puppeteer.launch(env.BROWSER);
    page=await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    page.on('response', async (res)=>{
      try{
        let u=res.url();
        if(u.includes('alaska') && (u.includes('calendar')||u.includes('award')||u.includes('lox')||u.includes('/api/')||u.includes('shopping')||u.includes('availability'))){
          network.push(u.slice(0,500));
        }
      }catch(e){}
    });
    await page.goto(buildUrl(dateStr), {waitUntil:"domcontentloaded", timeout:35000});
    await new Promise(r=>setTimeout(r,8000));
    // Try to click with proper puppeteer click (not evaluate)
    try{
      // Find Fare type combobox via text
      let fareHandle = await page.evaluateHandle(()=>{
        let els=document.querySelectorAll('button, [role="combobox"]');
        for(let el of els){ if((el.innerText||"").includes("Fare type")) return el; }
        return null;
      });
      if(fareHandle && fareHandle.asElement()){
        try{ await fareHandle.asElement().click(); }catch(e){}
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,1000));
    try{
      // try to find Partner Business option in DOM after open
      let opt = await page.$('li ::-p-text(Partner Business)');
      if(opt) await opt.click();
      else {
        await page.evaluate(()=>{
          let opts=document.querySelectorAll('li, [role="option"], button');
          for(let o of opts){ if((o.innerText||"").trim()==="Partner Business"){ o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); o.click(); break; } }
        });
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,2000));

    let perf = await page.evaluate(()=>{
      let entries=[];
      try{ entries=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('alaska')||n.includes('calendar')||n.includes('award')).slice(0,30); }catch(e){}
      let txt=document.body.innerText||"";
      return {title:document.title, url:location.href, len:document.documentElement.innerHTML.length, snippet:txt.slice(0,2000), entries:entries, hasAward:txt.includes("award"), hasK:txt.includes("k +$")};
    });

    // Try direct fetch of known Alaska internal endpoints inside browser context
    let apiAttempts=[];
    try{
      apiAttempts = await page.evaluate(async (d)=>{
        let urls=[
          `/api/award/calendar?origin=SEA&destination=TPE&departureDate=${d}&tripType=OneWay`,
          `/lox/api/award/calendar?O=SEA&D=TPE&OD=${d}`,
          `/api/shopping/awardCalendar?origin=SEA&destination=TPE&departDate=${d}`,
          `https://www.alaskaair.com/api/award/calendar?origin=SEA&destination=TPE&departureDate=${d}`
        ];
        let results=[];
        for(let u of urls){
          try{
            let r=await fetch(u,{credentials:'include'});
            let t=await r.text();
            results.push({url:u, status:r.status, len:t.length, sample:t.slice(0,500)});
            if(t.includes("75")||t.includes("75k")) break;
          }catch(e){ results.push({url:u, error:String(e).slice(0,200)}); }
        }
        return results;
      }, dateStr);
    }catch(e){ apiAttempts=[{error:String(e).slice(0,500)}]; }

    return {ok:true, network:network, perf:perf, apiAttempts:apiAttempts};
  }catch(e){
    return {ok:false, error:String(e).slice(0,2000), stack:e.stack?.slice(0,2000), network:network};
  }finally{ try{if(page) await page.close();}catch{} try{if(browser) await browser.close();}catch{} }
}

export default {
  async fetch(req, env){
    try{
      let u=new URL(req.url);
      if(u.pathname==="/api/check"){
        let d=u.searchParams.get("date")||"2026-07-22";
        let r=await scrape(env,d);
        return new Response(JSON.stringify(r,null,2),{headers:{"content-type":"application/json"}});
      }
      return new Response("v5 network sniff. /api/check?date=2026-07-22",{headers:{"content-type":"text/plain"}});
    }catch(e){ return new Response(JSON.stringify({fatal:String(e),stack:e.stack?.slice(0,2000)}),{status:500,headers:{"content-type":"application/json"}}); }
  }
}
