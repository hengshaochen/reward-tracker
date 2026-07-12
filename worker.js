import puppeteer from "@cloudflare/puppeteer";

const ORIGIN = "SEA";
const DEST = "TPE";

function buildUrl(dateStr) {
  return `https://www.alaskaair.com/search/calendar?O=${ORIGIN}&D=${DEST}&OD=${dateStr}&TripType=OneWay&Passengers=1&FareType=Partner&AwardType=Business&PayingWith=Points`;
}

async function safeScrape(env, dateStr) {
  let browser = null;
  let page = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36");
    const url = buildUrl(dateStr);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // 等待 - 不用 waitForNetworkIdle，改用定時等待 + 輪詢
    await new Promise(r => setTimeout(r, 6000));

    let foundSelector = null;
    const sels = ['div[role="gridcell"]','[data-date]','button','[class*="calendar"]'];
    for (const s of sels) {
      try {
        const el = await page.$(s);
        if (el) { foundSelector = s; break; }
      } catch(e){}
    }

    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || "";
      const htmlLen = document.documentElement.innerHTML.length;
      return {
        title: document.title,
        url: location.href,
        bodyLen: htmlLen,
        snippet: bodyText.slice(0, 2000),
        has75: bodyText.includes("75k") || bodyText.includes("75K") || bodyText.includes("75.0"),
        allTextSample: bodyText.slice(0, 4000)
      };
    });

    const results = await page.evaluate(() => {
      const out = [];
      const cells = document.querySelectorAll('[role="gridcell"], [data-date], div[class*="day"], button');
      cells.forEach(c => {
        const t = (c.innerText||"").trim();
        if (!t) return;
        // 抓 75k +$26 這種
        if (/75k/i.test(t) && t.includes("$")) {
          out.push({ raw: t.replace(/\n/g,' ').slice(0,100), miles: "75k", text: t });
        } else if (/75(\.0)?\s*k/i.test(t)) {
          out.push({ raw: t.replace(/\n/g,' ').slice(0,100), miles: "75k", text: t });
        }
      });
      return out;
    });

    return { ok: true, results, debug: info, selector: foundSelector, error: "" };
  } catch (e) {
    return { ok: false, results: [], debug: { title: "", url: buildUrl(dateStr), bodyLen: 0, snippet: String(e).slice(0,1000) }, selector: null, error: String(e).slice(0,1000) };
  } finally {
    try { if (page) await page.close(); } catch(e){}
    try { if (browser) await browser.close(); } catch(e){}
  }
}

export default {
  async scheduled(event, env, ctx) {
    try { ctx.waitUntil((async()=>{ try{ const b=await puppeteer.launch(env.BROWSER); await b.close(); }catch(e){} })()); } catch(e){}
  },
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/test-browser") {
        try {
          const browser = await puppeteer.launch(env.BROWSER);
          const page = await browser.newPage();
          await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 10000 });
          const title = await page.title();
          await browser.close();
          return new Response(JSON.stringify({ ok: true, browserWorks: true, title }), { headers: { "content-type": "application/json" }});
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: String(e).slice(0,2000), stack: e.stack?.slice(0,1000) }), { status: 500, headers: { "content-type": "application/json" }});
        }
      }
      if (url.pathname === "/api/check") {
        const date = url.searchParams.get("date") || "2026-07-22";
        const r = await safeScrape(env, date);
        const matched = r.results.filter(x=>/75/i.test(x.miles));
        return new Response(JSON.stringify({
          ok: true,
          mode: "REAL_SAFE",
          date,
          allCount: r.results.length,
          all: r.results,
          matchedCount: matched.length,
          debug: `title:${r.debug.title} | url:${r.debug.url} | bodyLen:${r.debug.bodyLen} | has75:${r.debug.has75} | selector:${r.selector} | error:${r.error}\n snippet:${(r.debug.snippet||"").slice(0,800)}`,
          selector: r.selector,
          error: r.error
        }, null, 2), { headers: { "content-type": "application/json" }});
      }
      if (url.pathname === "/") {
        return new Response("reward-tracker alive v2 safe. try /api/test-browser and /api/check?date=2026-07-22", { headers: { "content-type":"text/plain" }});
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ ok:false, fatal: String(e), stack: e.stack?.slice(0,2000) }), { status: 500, headers: { "content-type":"application/json" }});
    }
  }
}
