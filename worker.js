import puppeteer from "@cloudflare/puppeteer";

function buildAwardUrl(dateStr){
  // 你提供的正確里程頁面
  return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${dateStr}&A=1&RT=false&RequestType=Calendar&ShoppingMethod=onlineaward&int=flightresultsmicrosite%3Aviewby-calendar&locale=en-us&FareType=Partner+Business`;
}

async function scrapeAward(env, dateStr){
  let browser=null, page=null;
  try{
    browser=await puppeteer.launch(env.BROWSER);
    page=await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    let url=buildAwardUrl(dateStr);
    await page.goto(url, {waitUntil:"domcontentloaded", timeout:40000});
    await new Promise(r=>setTimeout(r, 9000));

    let data = await page.evaluate(()=>{
      let txt=document.body.innerText||"";
      let htmlLen=document.documentElement.innerHTML.length;
      let title=document.title;
      // 抓所有像 75k +$26 的格子
      let cells=[];
      let els=document.querySelectorAll('div, button, [role="gridcell"], span');
      for(let i=0;i<els.length;i++){
        let t=(els[i].innerText||"").trim();
        if(!t) continue;
        if(t.length>40) continue; // 過濾長文字
        if(/\d{2,3}k\s*\+\s*\$\d+/i.test(t)){
          // 往上找日期
          let parent=els[i].closest('[role="gridcell"], div');
          let day="";
          if(parent){
            let m=parent.innerText.match(/^\s*(\d{1,2})\s*\n/);
            if(m) day=m[1];
          }
          cells.push({raw:t, miles:(t.match(/\d+k/i)||[""])[0].toLowerCase(), day:day, text:t});
        }
      }
      // 去重
      let uniq=[], seen={};
      for(let c of cells){ if(!seen[c.raw+c.day]){ seen[c.raw+c.day]=1; uniq.push(c); } }
      // 檢查頁面是否真的是 award
      let isAward = txt.includes("Lowest available award fares") || txt.includes("Partner Business");
      let has75 = /75k\s*\+\s*\$\d+/i.test(txt);
      return {title, url:location.href, htmlLen, isAward, has75, snippet:txt.slice(0,3500), cells:uniq};
    });

    return {ok:true, url:data.url, title:data.title, htmlLen:data.htmlLen, isAward:data.isAward, has75:data.has75, snippet:data.snippet, all:data.cells, error:""};
  }catch(e){
    return {ok:false, error:String(e).slice(0,2000), stack:e.stack?.slice(0,2000), all:[], snippet:"", isAward:false, has75:false, htmlLen:0, title:"", url:buildAwardUrl(dateStr)};
  }finally{
    try{if(page) await page.close();}catch{}
    try{if(browser) await browser.close();}catch{}
  }
}

export default {
  async fetch(req, env){
    try{
      let u=new URL(req.url);
      if(u.pathname==="/api/test-browser"){
        let b=await puppeteer.launch(env.BROWSER); let p=await b.newPage(); await p.goto("https://example.com",{waitUntil:"domcontentloaded",timeout:10000}); let t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:{"content-type":"application/json"}});
      }
      if(u.pathname==="/api/check"){
        let d=u.searchParams.get("date")||"2026-07-20";
        let r=await scrapeAward(env,d);
        let matched=r.all.filter(x=>x.miles==="75k");
        return new Response(JSON.stringify({
          ok:true,
          mode:"REAL_AWARD_PARTNER_BUSINESS",
          date:d,
          url:r.url,
          isAwardPage:r.isAward,
          has75inPage:r.has75,
          htmlLen:r.htmlLen,
          allCount:r.all.length,
          all:r.all,
          matchedCount:matched.length,
          matched,
          debug:`title:${r.title}\nisAward:${r.isAward} has75:${r.has75} htmlLen:${r.htmlLen}\nerror:${r.error}\nurl:${r.url}\nsnippet:${(r.snippet||"").slice(0,1800)}`,
          error:r.error
        },null,2),{headers:{"content-type":"application/json"}});
      }
      if(u.pathname==="/"){
        return new Response("alive FINAL award url. /api/check?date=2026-07-20 should show 75k",{headers:{"content-type":"text/plain"}});
      }
      return new Response("not found",{status:404});
    }catch(e){ return new Response(JSON.stringify({fatal:String(e),stack:e.stack?.slice(0,2000)}),{status:500,headers:{"content-type":"application/json"}}); }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil((async()=>{
      try{
        // 每天掃未來7天，抓到75k就寄信
        let dates=[];
        let today=new Date();
        for(let i=0;i<12;i++){ let d=new Date(today); d.setDate(today.getDate()+i+7); let s=d.toISOString().slice(0,10); dates.push(s); }
        for(let d of dates){
          let r=await scrapeAward(env,d);
          let matched=r.all.filter(x=>x.miles==="75k");
          if(matched.length>0 && env.SENDGRID_API_KEY && env.FROM_EMAIL){
            let to=env.TO_EMAIL||env.FROM_EMAIL;
            await fetch("https://api.sendgrid.com/v3/mail/send",{method:"POST",headers:{"Authorization":`Bearer ${env.SENDGRID_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({personalizations:[{to:[{email:to}]}],from:{email:env.FROM_EMAIL},subject:`✈️ STARLUX 75K 出現！ ${d}`,content:[{type:"text/plain",value:`抓到 ${d} 75k +$26\n${JSON.stringify(matched,null,2)}\n${r.url}`} ]})});
          }
          await new Promise(r=>setTimeout(r,2000));
        }
      }catch(e){}
    })());
  }
}
