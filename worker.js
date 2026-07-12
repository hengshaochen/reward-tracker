import puppeteer from "@cloudflare/puppeteer";

function buildUrl(dateStr) {
  // 先用最寬鬆的 URL，再靠頁面點擊切到哩程
  return `https://www.alaskaair.com/search/calendar?O=SEA&D=TPE&OD=${dateStr}&TripType=OneWay&Passengers=1`;
}

async function safeScrape(env, dateStr) {
  let browser = null;
  let page = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    await page.goto(buildUrl(dateStr), { waitUntil: "domcontentloaded", timeout: 35000 });
    await new Promise(r => setTimeout(r, 5000));

    // 自動點 Fare type -> Partner Business / Award Business
    const clicked = await page.evaluate(async () => {
      const logs = [];
      function findClickable(text) {
        const els = Array.from(document.querySelectorAll('button, div, span, [role="combobox"], [role="button"]'));
        return els.find(e => (e.innerText||"").trim().toLowerCase().includes(text.toLowerCase()) && e.offsetParent !== null);
      }
      function findOption(text) {
        const els = Array.from(document.querySelectorAll('li, button, div[role="option"], span'));
        return els.find(e => (e.innerText||"").trim().toLowerCase() === text.toLowerCase() || (e.innerText||"").toLowerCase().includes(text.toLowerCase()));
      }
      // 1. Fare type
      let fareBtn = findClickable("Fare type");
      if (fareBtn) { fareBtn.click(); logs.push("clicked Fare type"); await new Promise(r=>setTimeout(r,800));
        let opt = findOption("Partner Business") || findOption("Partner") || findOption("Business");
        if (opt) { opt.click(); logs.push("selected "+opt.innerText); await new Promise(r=>setTimeout(r,1500)); }
      }
      // 2. Paying with
      let payBtn = findClickable("Paying with");
      if (payBtn) { payBtn.click(); logs.push("clicked Paying with"); await new Promise(r=>setTimeout(r,800));
        let opt2 = findOption("Points") || findOption("Miles");
        if (opt2) { opt2.click(); logs.push("selected "+opt2.innerText); await new Promise(r=>setTimeout(r,2000)); }
      }
      return logs;
    });

    await new Promise(r => setTimeout(r, 5000));

    const info = await page.evaluate(() => {
      return {
        title: document.title,
        url: location.href,
        bodyLen: document.documentElement.innerHTML.length,
        snippet: (document.body.innerText||"").slice(0,3000),
        hasAwardWord: document.body.innerText.includes("award"),
        hasK: document.body.innerText.includes("k +$"),
      };
    });

    const results = await page.evaluate(() => {
      const out = [];
      const text = document.body.innerText;
      // 日曆格
      const cells = document.querySelectorAll('div, button, [role="gridcell"]');
      cells.forEach(c=>{
        const t=(c.innerText||"").trim();
        if (!t) return;
        if (t.length>80) return; // 避免抓到整個頁面
        // 匹配 75k +$26 / 175k +$26 / 250k +$26
        if (/\d+k\s*\+\s*\$\d+/i.test(t)) {
          out.push({ raw:t, miles: (t.match(/\d+k/i)||[""])[0].toLowerCase() });
        }
      });
      // 去重
      const uniq = [];
      const seen = new Set();
      out.forEach(o=>{ if(!seen.has(o.raw)){ seen.add(o.raw); uniq.push(o);} });
      return { list: uniq, fullHas75: /75k\s*\+\s*\$26/i.test(text) };
    });

    return { ok:true, results: results.list, fullHas75: results.fullHas75, debug: info, clicks: clicked, error:"" };
  } catch(e) {
    return { ok:false, results:[], fullHas75:false, debug:{ title:"", url:buildUrl(dateStr), bodyLen:0, snippet:String(e).slice(0,2000)}, clicks:[], error:String(e).slice(0,1500) };
  } finally {
    try{ if(page) await page.close(); }catch{}
    try{ if(browser) await browser.close(); }catch{}
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/test-browser") {
        const b=await puppeteer.launch(env.BROWSER); const p=await b.newPage(); await p.goto("https://example.com",{waitUntil:"domcontentloaded",timeout:10000}); const t=await p.title(); await b.close(); return new Response(JSON.stringify({ok:true,browserWorks:true,title:t}),{headers:{"content-type":"application/json"}});
      }
      if (url.pathname === "/api/check") {
        const date = url.searchParams.get("date") || "2026-07-22";
        const r = await safeScrape(env, date);
        return new Response(JSON.stringify({
          ok:true, mode:"REAL_AWARD_FIX", date,
          clicks: r.clicks,
          allCount: r.results.length,
          all: r.results,
          has75inPage: r.fullHas75,
          debug: `title:${r.debug.title}\nurl:${r.debug.url}\nbodyLen:${r.debug.bodyLen}\nhasAward:${r.debug.hasAwardWord} hasK:${r.debug.hasK}\nclicks:${(r.clicks||[]).join("|")}\nerror:${r.error}\nsnippet:${(r.debug.snippet||"").slice(0,1200)}`,
          error: r.error
        }, null, 2), {headers:{"content-type":"application/json"}});
      }
      return new Response("alive v3 award-fix. /api/check?date=2026-07-22",{headers:{"content-type":"text/plain"}});
    } catch(e){
      return new Response(JSON.stringify({ok:false,fatal:String(e),stack:e.stack?.slice(0,1500)}),{status:500,headers:{"content-type":"application/json"}});
    }
  }
}
