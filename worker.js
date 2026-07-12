import puppeteer from "@cloudflare/puppeteer";

const ORIGIN = "SEA";
const DEST = "TPE";
const TRIP_TYPE = "OneWay";
const AWARD_TYPE = "Business";

function buildUrl(dateStr) {
  return `https://www.alaskaair.com/search/calendar?O=${ORIGIN}&D=${DEST}&OD=${dateStr}&TripType=${TRIP_TYPE}&Passengers=1&FareType=Partner&AwardType=${AWARD_TYPE}&PayingWith=Points`;
}

async function scrapeOneDate(browser, dateStr) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 900 });
  const url = buildUrl(dateStr);
  let debugInfo = { title: "", url, bodyLen: 0, monthYear: "", htmlSnippet: "", error: "" };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(()=>{});
    const selectors = ['[data-test*="calendar"]','[class*="calendar"]','[class*="Calendar"]','button[aria-label*="July"]','div[role="gridcell"]','.calendar-day','[data-date]'];
    let foundSelector = null;
    for (const sel of selectors) {
      try { await page.waitForSelector(sel, { timeout: 3000 }); foundSelector = sel; break; } catch(e){}
    }
    await new Promise(r => setTimeout(r, 4000));
    debugInfo.title = await page.title();
    debugInfo.url = page.url();
    const bodyText = await page.evaluate(() => document.body.innerHTML.length + " | " + document.body.innerText.slice(0,2000));
    debugInfo.bodyLen = bodyText.length;
    debugInfo.htmlSnippet = bodyText.slice(0, 2000);
    try {
      debugInfo.monthYear = await page.evaluate(() => {
        const el = document.querySelector('[class*="month"], [data-test*="month"], h2, h3');
        return el ? el.innerText.slice(0,100) : document.title;
      });
    } catch(e){}
    const results = await page.evaluate(() => {
      const out = [];
      const text = document.body.innerText;
      const dayCells = document.querySelectorAll('[role="gridcell"], [data-date], button[class*="day"], div[class*="calendar"] button, [class*="day"]');
      dayCells.forEach(cell => {
        const t = cell.innerText;
        if (!t) return;
        if (/75(\.0)?K|85K|95K/i.test(t)) {
          const dateAttr = cell.getAttribute('data-date') || cell.getAttribute('aria-label') || t.split('\n')[0];
          const milesMatch = t.match(/(\d+\.?\d*)\s*K/);
          out.push({ raw: t.slice(0,80).replace(/\n/g,' '), date: dateAttr, miles: milesMatch ? milesMatch[0] : t, isStarlux: true });
        }
      });
      if (out.length === 0 && /75(\.0)?K/.test(text)) {
        out.push({ raw: "found 75K in page text", miles: "75K", date: "calendar", isStarlux: true });
      }
      return out;
    });
    await page.close();
    return { results, debugInfo, foundSelector };
  } catch (err) {
    try { await page.close(); } catch(e){}
    debugInfo.error = String(err).slice(0,500);
    return { results: [], debugInfo, foundSelector: null };
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(handleCheck(env, null)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/test-browser") {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
        const title = await page.title();
        await browser.close();
        return new Response(JSON.stringify({ ok: true, browserWorks: true, title }), { headers: { "content-type": "application/json" }});
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e).slice(0,1000) }), { status: 500, headers: { "content-type": "application/json" }});
      }
    }
    if (url.pathname === "/api/check") {
      const date = url.searchParams.get("date") || "2026-07-12";
      const result = await handleCheck(env, date);
      return new Response(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json" }});
    }
    if (url.pathname === "/") {
      return new Response("reward-tracker alive. /api/test-browser /api/check?date=2026-07-21", { headers: { "content-type":"text/plain" }});
    }
    return new Response("Not found", { status: 404 });
  }
}

async function handleCheck(env, singleDate) {
  const browser = await puppeteer.launch(env.BROWSER);
  let all = []; let lastDebug = ""; let lastFound = null;
  const datesToCheck = singleDate ? [singleDate] : ["2026-07-12","2026-07-13","2026-07-14","2026-07-15","2026-07-16","2026-07-17","2026-07-18","2026-07-19","2026-07-20","2026-07-21","2026-07-22"];
  for (const d of datesToCheck) {
    const { results, debugInfo, foundSelector } = await scrapeOneDate(browser, d);
    lastDebug = `title: ${debugInfo.title} | url: ${debugInfo.url} | bodyLen: ${debugInfo.bodyLen}\nmonthYear: ${debugInfo.monthYear}\nselector: ${foundSelector}\nsnippet: ${debugInfo.htmlSnippet?.slice(0,400)}\nerror: ${debugInfo.error||'none'}`;
    lastFound = foundSelector;
    if (results && results.length) { results.forEach(r => all.push({ date: d, ...r })); }
    await new Promise(r => setTimeout(r, 1200));
  }
  await browser.close();
  const matched = all.filter(a => /75/.test(a.miles));
  try {
    const logKey = `log_${new Date().toISOString().slice(0,10)}`;
    const existing = await env.CACHE.get(logKey, "json") || [];
    existing.push({ ts: Date.now(), allCount: all.length, matchedCount: matched.length, debug: lastDebug });
    await env.CACHE.put(logKey, JSON.stringify(existing.slice(-20)));
  } catch(e){}
  let sent = 0;
  if (matched.length > 0 && env.SENDGRID_API_KEY && env.FROM_EMAIL) {
    try {
      const to = env.TO_EMAIL || env.FROM_EMAIL;
      const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.FROM_EMAIL },
          subject: `✈️ 抓到 STARLUX 75K! ${matched.map(m=>m.date).join(",")}`,
          content: [{ type: "text/plain", value: `Found ${matched.length} 75K: ${JSON.stringify(matched,null,2)}\n\nDebug: ${lastDebug}` }]
        })
      });
      sent = resp.ok ? 1 : 0;
    } catch(e){ sent = 0; }
  }
  return { ok: true, mode: "REAL", allCount: all.length, all, debug: lastDebug, logs: [{ email: (env.FROM_EMAIL||'').replace(/(?<=^.{3}).+(?=@)/,'****'), eff: "75k", matched: matched.length, dates: matched.map(m=>m.date) }], sent, selector: lastFound };
}
