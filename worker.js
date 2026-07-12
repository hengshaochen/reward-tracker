import puppeteer from "@cloudflare/puppeteer";

function buildUrl(dateStr){
  return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${dateStr}&TripType=OneWay&Passengers=1&FareType=Partner&AwardType=Business&PayingWith=Points`;
}

async function safeScrape(env, dateStr){
  let browser=null; let page=null;
  try{
    browser=await puppeteer.launch(env.BROWSER);
    page=await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    await page.goto(buildUrl(dateStr), {waitUntil:"domcontentloaded", timeout:35000});
    await new Promise(function(r){ setTimeout(r, 6000); });

    // 1st try: click dropdowns with SYNC evaluate (no async, no arrow that triggers __name)
    let clicks=[];
    try{
      clicks = await page.evaluate(function(){
        var logs=[];
        var all = document.querySelectorAll('button, div, span, [role="combobox"]');
        var fareBtn=null, payBtn=null;
        for(var i=0;i<all.length;i++){
          var el=all[i];
          var txt=(el.innerText||"").trim();
          if(!txt) continue;
          if(txt.indexOf("Fare type")!==-1 && el.offsetParent!==null && !fareBtn) fareBtn=el;
          if(txt.indexOf("Paying with")!==-1 && el.offsetParent!==null && !payBtn) payBtn=el;
        }
        if(fareBtn){ fareBtn.click(); logs.push("clicked Fare type"); }
        return logs;
      });
    }catch(e){ clicks.push("fare click err:"+String(e).slice(0,200)); }

    await new Promise(function(r){ setTimeout(r, 1200); });

    try{
      await page.evaluate(function(){
        var opts=document.querySelectorAll('li, button, div[role="option"], span');
        for(var i=0;i<opts.length;i++){
          var t=(opts[i].innerText||"").trim();
          if(t==="Partner Business"){ opts[i].click(); break; }
        }
      });
      clicks.push("selected Partner Business");
    }catch(e){}

    await new Promise(function(r){ setTimeout(r, 1500); });

    try{
      await page.evaluate(function(){
        var all=document.querySelectorAll('button, div, span');
        for(var i=0;i<all.length;i++){
          var txt=(all[i].innerText||"").trim();
          if(txt.indexOf("Paying with")!==-1 && all[i].offsetParent!==null){ all[i].click(); break; }
        }
      });
    }catch(e){}

    await new Promise(function(r){ setTimeout(r, 1200); });

    try{
      await page.evaluate(function(){
        var opts=document.querySelectorAll('li, button, div[role="option"], span');
        for(var i=0;i<opts.length;i++){
          var t=(opts[i].innerText||"").trim();
          if(t==="Points"||t==="Miles"){ opts[i].click(); break; }
        }
      });
      clicks.push("selected Points");
    }catch(e){}

    await new Promise(function(r){ setTimeout(r, 6000); });

    var info = await page.evaluate(function(){
      var txt=document.body.innerText||"";
      return {
        title: document.title,
        url: location.href,
        bodyLen: document.documentElement.innerHTML.length,
        snippet: txt.slice(0,3000),
        hasAward: txt.indexOf("award")!==-1,
        hasK: txt.indexOf("k +$")!==-1 || txt.indexOf("K +$")!==-1
      };
    });

    var parsed = await page.evaluate(function(){
      var out=[];
      var cells=document.querySelectorAll('[role="gridcell"], button, div');
      for(var i=0;i<cells.length;i++){
        var c=cells[i];
        var t=(c.innerText||"").trim();
        if(!t) continue;
        if(t.length>30) continue;
        if(/\d+k\s*\+\s*\$\d+/i.test(t)){
          out.push({raw:t, miles:(t.match(/\d+k/i)||[""])[0].toLowerCase()});
        }
      }
      var uniq=[]; var seen={};
      for(var j=0;j<out.length;j++){ if(!seen[out[j].raw]){ seen[out[j].raw]=1; uniq.push(out[j]); } }
      var full= (document.body.innerText||"").indexOf("75k")!==-1;
      return {list:uniq, has75:full};
    });

    return {ok:true, results:parsed.list, has75:parsed.has75, debug:info, clicks:clicks, error:""};
  }catch(e){
    return {ok:false, results:[], has75:false, debug:{title:"",url:buildUrl(dateStr),bodyLen:0,snippet:String(e).slice(0,2000),hasAward:false,hasK:false}, clicks:[], error:String(e).slice(0,2000)};
  }finally{
    try{ if(page) await page.close(); }catch(e){}
    try{ if(browser) await browser.close(); }catch(e){}
  }
}

export default {
  async fetch(request, env, ctx){
    try{
      var u=new URL(request.url);
      if(u.pathname==="/api/test-browser"){
        var b=await puppeteer.launch(env.BROWSER); var p=await b.newPage(); await p.goto("https://example.com",{waitUntil:"domcontentloaded",timeout:10000}); var t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:{"content-type":"application/json"}});
      }
      if(u.pathname==="/api/check"){
        var d=u.searchParams.get("date")||"2026-07-22";
        var r=await safeScrape(env,d);
        return new Response(JSON.stringify({ok:true,mode:"REAL_V4_NO__NAME",date:d,clicks:r.clicks,allCount:r.results.length,all:r.results,has75inPage:r.has75,debug:"title:"+r.debug.title+"\nurl:"+r.debug.url+"\nbodyLen:"+r.debug.bodyLen+"\nhasAward:"+r.debug.hasAward+" hasK:"+r.debug.hasK+"\nclicks:"+(r.clicks||[]).join("|")+"\nerror:"+r.error+"\nsnippet:"+(r.debug.snippet||"").slice(0,1500),error:r.error},null,2),{headers:{"content-type":"application/json"}});
      }
      return new Response("alive v4 no __name. /api/check?date=2026-07-22",{headers:{"content-type":"text/plain"}});
    }catch(e){
      return new Response(JSON.stringify({ok:false,fatal:String(e),stack:(e.stack||"").slice(0,2000)}),{status:500,headers:{"content-type":"application/json"}});
    }
  }
}
