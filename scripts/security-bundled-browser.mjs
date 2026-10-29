// Bundled-CSS bootstrap gate derived from the immutable original smoke gate.
// Same calculation/chart/storage assertions; first-party exact bytes only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = '/Sales_Haken_simu/';
const publicOrigin = 'https://kyamada-z.github.io';
const money = n => new Intl.NumberFormat('ja-JP', {style:'currency', currency:'JPY', maximumFractionDigits:0}).format(n);
const number = n => new Intl.NumberFormat('ja-JP', {maximumFractionDigits:1}).format(n);
const hash = b => createHash('sha256').update(b).digest('hex');
const cases = [
  {name:'zero-churn', churn:'0', rows:[[100,10,110,100000,10000,110000],[100,20,120,100000,20000,120000],[100,30,130,100000,30000,130000]], totals:[300000,60000,360000], final:130, arr:1560000},
  {name:'ten-percent-churn', churn:'10', rows:[[90,9,99,90000,9000,99000],[81,17.1,98.1,81000,17100,98100],[72.9,24.39,97.29,72900,24390,97290]], totals:[243900,50490,294390], final:97.29, arr:1167480},
];

function expectedRows(fixture) {
  return fixture.rows.map((r,i) => [`${i+1}ヶ月目`, ...r.slice(0,3).map(number), ...r.slice(3).map(money)]);
}

function verifyRows(actual, fixture) {
  assert.deepEqual(actual, expectedRows(fixture), 'Displayed monthly calculations differ from fixed synthetic expectations');
}

function permittedRequest(url, method, origin, paths) {
  const u = new URL(url);
  if (method !== 'GET') return false;
  if (u.origin === origin && !u.search && paths.has(u.pathname)) return true;
  return false;
}

function selfTest() {
  verifyRows(expectedRows(cases[0]), cases[0]);
  verifyRows(expectedRows(cases[1]), cases[1]);
  const changed = expectedRows(cases[1]); changed[2][6] = money(1);
  assert.throws(() => verifyRows(changed, cases[1]));
  assert.throws(() => verifyRows([], cases[0]));
  const paths = new Set([base, base+'assets/index-test.js', base+'assets/index-test.css']);
  assert(permittedRequest(publicOrigin+base, 'GET', publicOrigin, paths));
  assert(permittedRequest(publicOrigin+base+'assets/index-test.css', 'GET', publicOrigin, paths));
  for (const [url,method] of [
    ['https://generativelanguage.googleapis.com/v1beta/models/x:generateContent','POST'],
    ['https://generativelanguage.googleapis.com/','GET'], [publicOrigin+base,'POST'],
    [publicOrigin+'/unrelated/','GET'], [publicOrigin+base+'?unexpected=1','GET'],
    ['https://cdn.tailwindcss.com/unapproved.js','GET'], ['https://example.com/','GET'],
    ['https://cdn.tailwindcss.com/','GET'], ['https://cdn.tailwindcss.com/3.4.17','GET'],
  ]) assert(!permittedRequest(url,method,publicOrigin,paths), `Unexpectedly permitted ${url}`);
  console.log('Bundled CSS browser fixture/network rejection self-tests passed; external CDN denied.');
}

async function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  const args = process.argv.slice(2);
  const get = key => { const i=args.indexOf(key); assert(i>=0 && args[i+1], `Missing ${key}`); return args[i+1]; };
  const site = resolve(get('--site'));
  const phase = get('--phase');
  assert(/^(branch-ci|preflight|candidate|rollback|republish|recovery)$/.test(phase), 'Unexpected phase');
  const out = resolve(get('--out'));
  const live = args.includes('--live');
  assert(!lstatSync(site).isSymbolicLink());
  const names = readdirSync(join(site,'assets')).sort();
  assert.equal(names.length,2);
  const js = names.find(name=>/^index-[A-Za-z0-9_-]+\.js$/.test(name));
  const css = names.find(name=>/^index-[A-Za-z0-9_-]+\.css$/.test(name));
  assert(js && css, 'Expected exactly one JS and one CSS bundle');
  assert.deepEqual(readdirSync(site).sort(), ['assets','index.html']);
  for(const name of names) assert(lstatSync(join(site,'assets',name)).isFile() && !lstatSync(join(site,'assets',name)).isSymbolicLink());
  const files = new Map([['index.html',readFileSync(join(site,'index.html'))], ...names.map(name=>['assets/'+name,readFileSync(join(site,'assets',name))])]);
  const html = files.get('index.html').toString();
  assert(html.includes(`src="${base}assets/${js}"`));
  assert(html.includes(`href="${base}assets/${css}"`));
  assert.equal((html.match(/<script\b/g)||[]).length,1);
  assert.equal((html.match(/rel="stylesheet"/g)||[]).length,1);
  assert(!html.includes('cdn.tailwindcss.com'), 'Runtime Tailwind CDN must be removed');
  let server;
  let origin = publicOrigin;
  if (!live) {
    server = createServer((req,res) => {
      const path = req.url === base ? 'index.html' : req.url?.startsWith(base) ? req.url.slice(base.length) : '';
      const value = req.method === 'GET' && files.get(path);
      if (!value) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'}); res.end(value);
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  const paths = new Set([base,...names.map(name=>base+'assets/'+name)]);
  const fixture = {id:'sales-pilot-synthetic', date:'SYNTHETIC PILOT',
    params:{initialUsers:100,unitPrice:1000,churnRate:0.1,newUsersPerMonth:10,directPayRate:0.7,socialInsuranceRate:0.1,months:3},
    initialPrompt:'SYNTHETIC PILOT ONLY', reportContent:'SYNTHETIC REPORT — no AI call',
    chatMessages:[{role:'user',text:'SYNTHETIC QUESTION'},{role:'model',text:'SYNTHETIC ANSWER'}], summaryRevenue:294390};
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
  const browser = await chromium.launch({headless:true});
  let context, page;
  const blocked = [], errors = [], seen = new Set(), observations = [], tailwind = [];
  let geminiRequests = 0;
  try {
    context = await browser.newContext({viewport:{width:args.includes('--mobile')?390:1440,height:args.includes('--mobile')?844:1100},locale:'ja-JP',serviceWorkers:'block',
      storageState:{cookies:[],origins:[{origin,localStorage:[{name:'simulationSavedReports',value:JSON.stringify([fixture])}]}]}});
    await context.route('**/*', async route => {
      const request=route.request(), u=new URL(request.url());
      if (u.hostname === 'generativelanguage.googleapis.com') geminiRequests++;
      if (permittedRequest(request.url(),request.method(),origin,paths)) return route.continue();
      blocked.push({origin:u.origin,path:u.pathname,method:request.method()});
      return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.on('pageerror', e=>errors.push(e.message));
    page.on('dialog', async dialog=> {
      assert.equal(dialog.type(),'confirm');
      assert(/保存されたレポートを復元|保存済みレポートを削除/.test(dialog.message()), 'Unexpected dialog');
      await dialog.accept();
    });
    const responseChecks = [];
    page.on('response', response => {
      const u=new URL(response.url());
      if(u.origin === 'https://cdn.tailwindcss.com') tailwind.push({url:response.url(),status:response.status()});
      if(u.origin !== origin || !paths.has(u.pathname)) return;
      responseChecks.push((async()=> {
        assert.equal(response.status(),200, 'First-party HTTP failure');
        const name=u.pathname===base?'index.html':u.pathname.slice(base.length);
        assert.equal(hash(await response.body()),hash(files.get(name)), 'Browser received unexpected first-party bytes');
        seen.add(name);
      })().catch(error=>errors.push(error.message)));
    });
    const checkCalculations = async c => {
      await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('td')].map(c=>c.textContent.trim())))===JSON.stringify(expected), expectedRows(c));
      verifyRows(await page.locator('tbody tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('td')].map(c=>c.textContent.trim()))),c);
      assert.deepEqual(await page.locator('tfoot td').allTextContents(),['期間累計 (PL)',...c.totals.map(money)]);
      assert((await page.getByText('期間予測 総売上',{exact:true}).locator('xpath=../..').textContent()).includes(money(c.totals[2])));
      assert((await page.getByText('最終月末の総稼働見込',{exact:true}).locator('..').textContent()).includes(number(c.final)));
      assert((await page.getByText('参考: 期末時点の理論年商 (ARR)',{exact:true}).locator('..').textContent()).includes(money(c.arr)));
    };
    await page.goto(origin+base,{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'派遣売上シミュレーション',exact:true}).waitFor();
    const inputs=page.locator('input[type=number]');
    assert.equal(await inputs.count(),7);
    for(const c of cases) {
      for(const [i,value] of ['3','100','1000',c.churn,'10','70','10'].entries()) await inputs.nth(i).fill(value);
      await checkCalculations(c);
      observations.push({fixture:c.name,rows:expectedRows(c),total:money(c.totals[2]),final:number(c.final)});
    }
    // Restore/save/reload/delete an explicitly synthetic report and chat without AI generation.
    await page.getByText('3ヶ月: '+money(294390),{exact:true}).click();
    await page.getByText(fixture.reportContent,{exact:true}).waitFor();
    await page.getByText('SYNTHETIC QUESTION',{exact:true}).waitFor();
    await page.getByText('SYNTHETIC ANSWER',{exact:true}).waitFor();
    assert.equal(await inputs.nth(2).inputValue(),'1000');
    await inputs.nth(2).fill('2000');
    await page.getByRole('button',{name:'このレポートとチャット履歴を保存',exact:true}).click();
    await page.getByRole('button',{name:'保存しました',exact:true}).waitFor();
    let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('simulationSavedReports')));
    assert.equal(saved.length,2); assert.equal(saved[0].summaryRevenue,588780);
    assert.equal(saved[0].reportContent,fixture.reportContent); assert.deepEqual(saved[0].chatMessages,fixture.chatMessages);
    await page.reload({waitUntil:'networkidle'});
    await page.getByText('3ヶ月: '+money(588780),{exact:true}).click();
    assert.equal(await inputs.nth(2).inputValue(),'2000');
    await page.getByText(fixture.reportContent,{exact:true}).waitFor();
    await page.getByText('SYNTHETIC ANSWER',{exact:true}).waitFor();
    for(const value of [588780,294390]) {
      await page.getByText('3ヶ月: '+money(value),{exact:true}).locator('..').locator('button').click();
    }
    saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('simulationSavedReports')));
    assert.deepEqual(saved,[]);
    await page.getByText('保存されたレポートはありません',{exact:true}).waitFor();
    await inputs.nth(2).fill('1000');
    await checkCalculations(cases[1]);
    await page.waitForFunction(()=> {
      const charts=[...document.querySelectorAll('.recharts-wrapper > svg.recharts-surface')];
      return charts.length===3 && charts.every(c=> {
        const bars=[...c.querySelectorAll('.recharts-bar-rectangle path')];
        return c.getBoundingClientRect().width>0 && c.getBoundingClientRect().height>0 && bars.length===6 && bars.every(p=>p.getBoundingClientRect().height>0);
      }) && charts[2].querySelectorAll('.recharts-line-dot').length===3;
    });
    const charts=await page.locator('.recharts-wrapper > svg.recharts-surface').evaluateAll(svgs=>svgs.map(svg=>({
      width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,
      bars:svg.querySelectorAll('.recharts-bar-rectangle path').length,
      renderedBars:[...svg.querySelectorAll('.recharts-bar-rectangle path')].filter(p=>p.getBoundingClientRect().height>0).length,
      invalidPaths:[...svg.querySelectorAll('path')].some(p=>/NaN|Infinity/.test(p.getAttribute('d')||'')),
      line:svg.querySelector('.recharts-line-curve')?.getAttribute('d')||null,
      dots:svg.querySelectorAll('.recharts-line-dot').length,
    })));
    assert.equal(charts.length,3);
    for(const chart of charts) { assert(chart.width>0&&chart.height>0); assert.equal(chart.bars,6); assert.equal(chart.renderedBars,6); assert.equal(chart.invalidPaths,false); }
    assert(charts[2].line && charts[2].dots===3,'Third chart must render the total-users line and three data points');
    for(const heading of ['既存顧客：退職による減収推移','新規獲得：退職による減収推移','総稼働人数の推移']) await page.getByRole('heading',{name:heading,exact:true}).waitFor();
    if(args.includes('--mobile')) assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), 'Mobile page must not overflow horizontally');
    await Promise.all(responseChecks);
    assert.deepEqual([...seen].sort(),[...files.keys()].sort());
    assert.deepEqual(errors,[],'Uncaught browser errors'); assert.equal(geminiRequests,0,'Gemini must never be requested');
    assert.deepEqual(tailwind,[], 'Runtime Tailwind CDN must never be contacted');
    assert.equal(await page.locator('link[rel=stylesheet]').count(),1);
    assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).margin),'0px', 'Bundled Tailwind preflight must apply');
    assert(blocked.every(r=>r.method==='GET' && r.origin===origin && r.path==='/vite.svg'),'Unexpected attempted network request');
    mkdirSync(out,{recursive:true});
    await page.screenshot({path:join(out,phase+'.png'),fullPage:true});
    const report={phase,viewport:page.viewportSize(),mode:live?'production':'loopback',origin,source_files:Object.fromEntries([...files].map(([p,b])=>[p,hash(b)])),
      fixtures:observations,charts,storage:'restore/change/save/reload/delete passed using synthetic report/chat',gemini_requests:geminiRequests,blocked,tailwind,errors};
    writeFileSync(join(out,phase+'.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    mkdirSync(out,{recursive:true});
    const diagnostic={phase,error:error.message,gemini_requests:geminiRequests,blocked,tailwind,errors,fixtures:observations,
      chart_count:await page?.locator('.recharts-wrapper > svg.recharts-surface').count(),
      charts:await page?.locator('.recharts-wrapper > svg.recharts-surface').evaluateAll(svgs=>svgs.map(s=>({width:s.getBoundingClientRect().width,height:s.getBoundingClientRect().height,html:s.outerHTML.slice(0,300)})))};
    writeFileSync(join(out,phase+'-failure.json'),JSON.stringify(diagnostic,null,2)+'\n');
    await page?.screenshot({path:join(out,phase+'-failure.png'),fullPage:true}).catch(()=>{});
    console.error(JSON.stringify(diagnostic,null,2));
    throw error;
  } finally { await context?.close(); await browser.close(); if(server) await new Promise(done=>server.close(done)); }
}

const legacySite = process.argv.includes('--allow-legacy') && !process.argv.includes('--self-test')
  ? resolve(process.argv[process.argv.indexOf('--site')+1]) : null;
if(legacySite && readdirSync(join(legacySite,'assets')).length===1) {
  const legacyPath = new URL('./security-pilot-browser.mjs', import.meta.url);
  assert.equal(hash(readFileSync(legacyPath)), '82127328a2d259a794dbe3ef9f2960af43e0e4f08ad5edd9e2173a2976f288c6');
  await import(legacyPath.href);
} else {
  await main();
}
