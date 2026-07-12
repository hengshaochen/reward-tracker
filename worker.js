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
      return new Response("alive FINAL v2 regex. /api/check?date=2026-07-20",{headers:{"content-type":"text/plain"}});
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
