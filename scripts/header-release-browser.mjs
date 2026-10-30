// One-release compact-header UI gate. Run in GitHub Actions with a fresh Playwright context.
// The local artifact is the byte-for-byte reference for both preflight and live checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = '/Sales_Haken_simu/';
const PUBLIC_ORIGIN = 'https://kyamada-z.github.io';
const APPLICATION_SOURCE = '785892583ab41367bd3184337ca58fee03452ddf';
const yen = n => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(n);
const number = n => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(n);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SALES = '#simulation-panel-sales';
const PROFIT = '#simulation-panel-profit';
const PROFIT_TABLE = `${PROFIT} table:has(caption)`;
const PROFIT_CHART = `${PROFIT} section[aria-labelledby="monthly-profit-heading"] .recharts-wrapper > svg.recharts-surface`;
const SALES_CASES = [
  { name: 'zero-churn', churn: '0', rows: [[100, 10, 110, 100000, 10000, 110000], [100, 20, 120, 100000, 20000, 120000], [100, 30, 130, 100000, 30000, 130000]], totals: [300000, 60000, 360000] },
  { name: 'ten-percent-churn', churn: '10', rows: [[90, 9, 99, 90000, 9000, 99000], [81, 17.1, 98.1, 81000, 17100, 98100], [72.9, 24.39, 97.29, 72900, 24390, 97290]], totals: [243900, 50490, 294390] },
];
const profitRows = (loss = false) => [
  [100, 10, 110, 100000, 10000, 110000, loss ? 104500 : 82500, 11000, loss ? -5500 : 16500],
  [100, 20, 120, 100000, 20000, 120000, loss ? 114000 : 90000, 12000, loss ? -6000 : 18000],
  [100, 30, 130, 100000, 30000, 130000, loss ? 123500 : 97500, 13000, loss ? -6500 : 19500],
];
const formattedRows = rows => rows.map((r, i) => [`${i + 1}ヶ月目`, ...r.slice(0, 3).map(number), ...r.slice(3).map(yen)]);

function assertHeaderLayout(layout, mobile, activeId) {
  assert.equal(layout.tablistCount, 1, 'Exactly one tablist may be present, including hidden panels');
  assert.equal(layout.tabCount, 2, 'Exactly two tab buttons may be present');
  assert.deepEqual(layout.tabIdCounts, { sales: 1, profit: 1 }, 'Tab IDs must remain unique after remounting');
  assert.deepEqual(layout.tabs.map(tab => tab.label), ['売上', '売上粗利']);
  assert.equal(layout.selectedId, `simulation-tab-${activeId}`);
  assert.equal(layout.sameTitleRow, true, 'Title and tablist must share the same header row container');
  assert.equal(layout.withinActivePanel, true, 'Navigation must belong to the visible panel header');
  assert.equal(layout.independentNote, false, 'Remove the separate explanatory paragraph above the app header');
  assert(layout.headerTop >= 0 && layout.headerTop <= 32, 'No separate tab section or blank block may precede the title card');
  assert(layout.pageWidth <= layout.viewportWidth + 1, 'Page must not overflow horizontally');
  for (const tab of layout.tabs) {
    assert(tab.width >= 44 && tab.height >= 44, 'Tab buttons must provide at least a 44 by 44 CSS-pixel target');
    assert.equal(tab.textLines, 1, 'Each short tab label must remain on one line');
  }
  assert(Math.abs(layout.tabs[0].top - layout.tabs[1].top) <= 1, 'The two tabs must remain on the same row');
  assert(layout.tabs[0].right <= layout.tabs[1].left, 'Tab touch targets must not overlap');
  if (!mobile) {
    assert(Math.abs(layout.title.centerY - layout.tablist.centerY) <= 2, 'Desktop title and tabs must be vertically aligned on one row');
    assert(layout.title.right + 8 <= layout.tablist.left, 'Desktop tabs must sit beside the title with a visible gap');
  }
}

function allowedRequest(url, method, origin, paths) {
  const parsed = new URL(url);
  return method === 'GET' && parsed.origin === origin && !parsed.search && paths.has(parsed.pathname);
}

function selfTest() {
  const layout = {
    tablistCount: 1, tabCount: 2, tabIdCounts: { sales: 1, profit: 1 }, selectedId: 'simulation-tab-sales',
    sameTitleRow: true, withinActivePanel: true, independentNote: false, headerTop: 24, pageWidth: 1440, viewportWidth: 1440,
    title: { right: 480, centerY: 75 }, tablist: { left: 1000, centerY: 75 },
    tabs: [
      { label: '売上', width: 76, height: 44, textLines: 1, top: 53, left: 1005, right: 1081 },
      { label: '売上粗利', width: 104, height: 44, textLines: 1, top: 53, left: 1085, right: 1189 },
    ],
  };
  assertHeaderLayout(layout, false, 'sales');
  assertHeaderLayout({ ...layout, headerTop: 16, pageWidth: 390, viewportWidth: 390 }, true, 'sales');
  for (const changed of [
    { tablistCount: 2 }, { tabCount: 4 }, { tabIdCounts: { sales: 2, profit: 1 } }, { independentNote: true },
    { sameTitleRow: false }, { withinActivePanel: false }, { headerTop: 90 }, { pageWidth: 1443 },
    { tablist: { left: 1000, centerY: 150 } }, { tablist: { left: 480, centerY: 75 } },
    { tabs: [{ ...layout.tabs[0], height: 40 }, layout.tabs[1]] },
    { tabs: [layout.tabs[0], { ...layout.tabs[1], textLines: 2 }] },
    { tabs: [layout.tabs[0], { ...layout.tabs[1], top: 110 }] },
  ]) assert.throws(() => assertHeaderLayout({ ...layout, ...changed }, false, 'sales'));
  assert.equal(formattedRows(SALES_CASES[1].rows)[2][6], yen(97290));
  assert.equal(formattedRows(profitRows(true))[2][9], yen(-6500));
  assert.equal(profitRows(true).reduce((sum, r) => sum + r[8], 0), -18000);
  const paths = new Set([BASE, `${BASE}assets/index-a.js`, `${BASE}assets/index-a.css`]);
  assert(allowedRequest(PUBLIC_ORIGIN + BASE, 'GET', PUBLIC_ORIGIN, paths));
  assert(allowedRequest(`${PUBLIC_ORIGIN}${BASE}assets/index-a.css`, 'GET', PUBLIC_ORIGIN, paths));
  for (const [url, method] of [
    [`${PUBLIC_ORIGIN}${BASE}`, 'POST'], [`${PUBLIC_ORIGIN}${BASE}?bypass=1`, 'GET'],
    [`${PUBLIC_ORIGIN}/unrelated/`, 'GET'], [`${PUBLIC_ORIGIN}${BASE}assets/unknown.js`, 'GET'],
    ['https://generativelanguage.googleapis.com/v1beta/models/model:generateContent', 'POST'],
    ['https://generativelanguage.googleapis.com/', 'GET'], ['https://cdn.tailwindcss.com/', 'GET'],
    ['https://example.com/', 'GET'], ['data:text/html,preview', 'GET'],
  ]) assert(!allowedRequest(url, method, PUBLIC_ORIGIN, paths), `Unexpectedly permitted ${url}`);
  console.log('Header release layout, fixture, and GET-only exact-path network policy self-tests passed.');
}

function readArtifact(site) {
  assert(lstatSync(site).isDirectory() && !lstatSync(site).isSymbolicLink(), 'Site must be a real directory');
  assert.deepEqual(readdirSync(site).sort(), ['assets', 'index.html']);
  assert(lstatSync(join(site, 'assets')).isDirectory() && !lstatSync(join(site, 'assets')).isSymbolicLink());
  const names = readdirSync(join(site, 'assets')).sort();
  assert.equal(names.length, 2, 'Expected exactly one bundled JS and one bundled CSS');
  const js = names.find(name => /^index-[A-Za-z0-9_-]+\.js$/.test(name));
  const css = names.find(name => /^index-[A-Za-z0-9_-]+\.css$/.test(name));
  assert(js && css, 'Unexpected asset names');
  const files = new Map();
  for (const name of ['index.html', ...names.map(name => `assets/${name}`)]) {
    const path = join(site, name);
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    files.set(name, readFileSync(path));
  }
  const html = files.get('index.html').toString();
  assert(html.includes(`src="${BASE}assets/${js}"`));
  assert(html.includes(`href="${BASE}assets/${css}"`));
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 1);
  assert(!html.includes('cdn.tailwindcss.com'), 'No runtime Tailwind CDN');
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const get = key => { const i = args.indexOf(key); assert(i >= 0 && args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key}`); return args[i + 1]; };
  const site = resolve(get('--site'));
  const phase = get('--phase');
  assert(/^(preflight|candidate|rollback)$/.test(phase), 'Unexpected phase');
  const out = resolve(get('--out'));
  const mobile = args.includes('--mobile');
  const live = args.includes('--live');
  const suffix = `${phase}-${mobile ? 'mobile' : 'desktop'}`;
  const files = readArtifact(site);
  const paths = new Set([BASE, ...[...files.keys()].filter(p => p !== 'index.html').map(p => BASE + p)]);
  mkdirSync(out, { recursive: true });
  let server, browser, context, page;
  let origin = PUBLIC_ORIGIN;
  let stage = 'startup';
  const blocked = [], errors = [], consoleErrors = [], observations = [], responseChecks = [];
  const seen = new Set();
  let aiRequests = 0;
  const screenshots = [];
  try {
    if (!live) {
      server = createServer((request, response) => {
        const name = request.url === BASE ? 'index.html' : request.url?.startsWith(BASE) ? request.url.slice(BASE.length) : '';
        const bytes = request.method === 'GET' && files.get(name);
        if (!bytes) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' });
        response.end(bytes);
      });
      await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
      origin = `http://127.0.0.1:${server.address().port}`;
    }
    assert(process.env.PLAYWRIGHT_CORE, 'Set PLAYWRIGHT_CORE to the pinned Playwright module path');
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, locale: 'ja-JP', serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'generativelanguage.googleapis.com') aiRequests++;
      if (allowedRequest(request.url(), request.method(), origin, paths)) return route.continue();
      blocked.push({ origin: url.origin, path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(message.text()); });
    page.on('dialog', async dialog => { errors.push(`Unexpected dialog: ${dialog.type()}`); await dialog.dismiss(); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !paths.has(url.pathname)) return;
      responseChecks.push((async () => {
        assert.equal(response.status(), 200, `First-party HTTP failure: ${url.pathname}`);
        const name = url.pathname === BASE ? 'index.html' : url.pathname.slice(BASE.length);
        assert.equal(sha256(await response.body()), sha256(files.get(name)), `Unexpected first-party bytes: ${name}`);
        seen.add(name);
      })().catch(error => errors.push(error.message)));
    });
    const shot = async name => {
      const filename = `${suffix}-${name}.png`;
      await page.screenshot({ path: join(out, filename), fullPage: true });
      screenshots.push(filename);
      if (name === 'sales-default' || name === 'profit-default') {
        const viewportFilename = `${suffix}-${name}-viewport.png`;
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(out, viewportFilename), fullPage: false });
        screenshots.push(viewportFilename);
      }
    };
    const checkHeader = async activeId => {
      const panelSelector = activeId === 'sales' ? SALES : PROFIT;
      const layout = await page.evaluate(({ panelSelector }) => {
        const panel = document.querySelector(panelSelector);
        const title = panel?.querySelector('h1');
        const tablist = panel?.querySelector('[role="tablist"]');
        if (!title || !tablist) throw new Error('Visible title and tablist are required for header measurements');
        const bounds = element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, centerY: rect.top + rect.height / 2 };
        };
        const tabs = [...tablist.querySelectorAll('[role="tab"]')].map(button => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => Math.round(rect.top * 2) / 2));
          return { label: button.textContent.trim(), ...bounds(button), textLines: lines.size };
        });
        return {
          tablistCount: document.querySelectorAll('[role="tablist"]').length,
          tabCount: document.querySelectorAll('[role="tab"]').length,
          tabIdCounts: {
            sales: document.querySelectorAll('#simulation-tab-sales').length,
            profit: document.querySelectorAll('#simulation-tab-profit').length,
          },
          selectedId: tablist.querySelector('[aria-selected="true"]')?.id ?? null,
          sameTitleRow: title.parentElement === tablist.parentElement,
          withinActivePanel: panel.contains(tablist),
          independentNote: document.body.textContent.includes('入力条件はタブごとに独立しています。'),
          headerTop: title.parentElement.parentElement.getBoundingClientRect().top + window.scrollY,
          pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
          title: bounds(title), tablist: bounds(tablist), tabs,
        };
      }, { panelSelector });
      assertHeaderLayout(layout, mobile, activeId);
      observations.push({ stage, header: activeId, layout });
    };
    const waitRows = async (tableSelector, expected) => {
      await page.waitForFunction(({ tableSelector, expected }) => {
        const table = document.querySelector(tableSelector);
        const actual = table ? [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent.trim())) : null;
        return JSON.stringify(actual) === JSON.stringify(expected);
      }, { tableSelector, expected });
      assert.deepEqual(await page.locator(`${tableSelector} tbody tr`).evaluateAll(rows => rows.map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent.trim()))), expected);
    };
    const assertProfitSummary = async (sales, profit, margin) => {
      const summary = page.locator(`${PROFIT} section[aria-labelledby="profit-overview-heading"]`);
      await summary.getByText(yen(sales), { exact: true }).waitFor();
      await summary.getByText(yen(profit), { exact: true }).waitFor();
      await summary.getByText(margin, { exact: true }).waitFor();
    };
    const checkCharts = async (selector, count, barsPerChart, loss = false) => {
      await page.waitForFunction(({ selector, count, barsPerChart }) => {
        const charts = [...document.querySelectorAll(selector)];
        return charts.length === count && charts.every(chart => chart.getBoundingClientRect().width > 0 && chart.getBoundingClientRect().height > 0 && [...chart.querySelectorAll('.recharts-bar-rectangle path')].filter(path => path.getBoundingClientRect().height > 0).length === barsPerChart);
      }, { selector, count, barsPerChart });
      const charts = await page.locator(selector).evaluateAll(svgs => svgs.map(svg => {
        const reference = svg.querySelector('.recharts-reference-line line');
        const profitPaths = [...(svg.querySelectorAll('.recharts-bar')[2]?.querySelectorAll('.recharts-bar-rectangle path') || [])];
        return {
          width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
          renderedBars: [...svg.querySelectorAll('.recharts-bar-rectangle path')].filter(p => p.getBoundingClientRect().height > 0).length,
          invalidPaths: [...svg.querySelectorAll('path')].some(p => /NaN|Infinity/.test(p.getAttribute('d') || '')),
          line: svg.querySelector('.recharts-line-curve')?.getAttribute('d') || null,
          zeroY: reference?.getBoundingClientRect().y ?? null,
          profitBars: profitPaths.map(path => ({ y: path.getBoundingClientRect().y, height: path.getBoundingClientRect().height, fill: path.getAttribute('fill') })),
        };
      }));
      assert.equal(charts.length, count);
      for (const chart of charts) {
        assert(chart.width > 0 && chart.height > 0);
        assert.equal(chart.renderedBars, barsPerChart);
        assert.equal(chart.invalidPaths, false, 'Graph paths must contain finite coordinates');
        if (loss) {
          assert(chart.line && chart.zeroY !== null && chart.profitBars.length === 3, 'Loss chart needs sales line, zero line, and three profit bars');
          for (const bar of chart.profitBars) {
            assert(bar.height > 0 && bar.y >= chart.zeroY - 1, 'Negative profit bars must be rendered below zero');
            assert.equal(bar.fill.toLowerCase(), '#dc2626', 'Negative profit bars must be red');
          }
        }
      }
      observations.push({ stage, charts });
      return charts;
    };

    stage = 'legacy-sales-default';
    await page.goto(origin + BASE, { waitUntil: 'networkidle' });
    const sales = page.locator(SALES), profit = page.locator(PROFIT);
    const salesTab = page.getByRole('tab', { name: '売上', exact: true });
    const profitTab = page.getByRole('tab', { name: '売上粗利', exact: true });
    assert.equal(await salesTab.getAttribute('aria-selected'), 'true');
    assert(await sales.isVisible() && !await profit.isVisible());
    await sales.getByRole('heading', { name: '派遣売上シミュレーション', exact: true }).waitFor();
    await checkHeader('sales');
    assert.equal(await sales.locator('input[type=number]').count(), 7);
    await checkCharts(`${SALES} .recharts-wrapper > svg.recharts-surface`, 3, 24);
    if (mobile) assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Sales page must not overflow the mobile viewport');
    await shot('sales-default');

    stage = 'legacy-sales-synthetic';
    const salesInputs = sales.locator('input[type=number]');
    for (const fixture of SALES_CASES) {
      for (const [i, value] of ['3', '100', '1000', fixture.churn, '10', '70', '10'].entries()) await salesInputs.nth(i).fill(value);
      await waitRows(`${SALES} table`, formattedRows(fixture.rows));
      assert.deepEqual((await sales.locator('tfoot td').allTextContents()).map(s => s.trim()), ['期間累計 (PL)', ...fixture.totals.map(yen)]);
      observations.push({ stage, fixture: fixture.name, total: fixture.totals[2] });
    }
    await checkCharts(`${SALES} .recharts-wrapper > svg.recharts-surface`, 3, 6);

    stage = 'profit-default';
    await profitTab.click();
    assert.equal(await profitTab.getAttribute('aria-selected'), 'true');
    assert(await profit.isVisible() && !await sales.isVisible());
    await assertProfitSummary(1817400319, 267884807, '14.74%');
    await checkHeader('profit');
    assert.equal(await profit.getByLabel('月間単価 (円)', { exact: true }).inputValue(), '280000', 'Profit inputs must be independent of legacy sales');
    const defaultProfitCharts = await checkCharts(PROFIT_CHART, 1, 36);
    assert(defaultProfitCharts[0].line, 'Profit chart must render a sales line');
    await shot('profit-default');

    stage = 'baseline-rate-change';
    await profit.getByRole('button', { name: '基準条件を記録', exact: true }).click();
    await profit.getByLabel('直給率 (%)', { exact: true }).fill('73.99');
    await assertProfitSummary(1817400319, 286058810, '15.74%');
    const comparison = `${PROFIT} section[aria-labelledby="baseline-heading"] table`;
    await waitRows(comparison, [
      ['期間売上', yen(1817400319), yen(1817400319), yen(0)],
      ['粗利（社保引き後）', yen(267884807), yen(286058810), `+${yen(18174003)}`],
      ['粗利率（社保引き後）', '14.74%', '15.74%', '+1.00ポイント'],
    ]);
    await shot('baseline-comparison');

    stage = 'tab-state-retention';
    await salesTab.click();
    assert.equal(await salesInputs.nth(2).inputValue(), '1000');
    assert.equal(await salesInputs.nth(5).inputValue(), '70');
    await salesInputs.nth(2).fill('2000');
    await sales.getByText(yen(588780), { exact: true }).first().waitFor();
    await checkCharts(`${SALES} .recharts-wrapper > svg.recharts-surface`, 3, 6);
    await profitTab.click();
    assert.equal(await profit.getByLabel('直給率 (%)', { exact: true }).inputValue(), '73.99');
    assert.equal(await profit.getByLabel('月間単価 (円)', { exact: true }).inputValue(), '280000');
    await assertProfitSummary(1817400319, 286058810, '15.74%');
    await profit.getByRole('button', { name: '基準条件に戻す', exact: true }).click();
    assert.equal(await profit.getByLabel('直給率 (%)', { exact: true }).inputValue(), '74.99');
    await assertProfitSummary(1817400319, 267884807, '14.74%');
    await waitRows(comparison, [
      ['期間売上', yen(1817400319), yen(1817400319), yen(0)],
      ['粗利（社保引き後）', yen(267884807), yen(267884807), yen(0)],
      ['粗利率（社保引き後）', '14.74%', '14.74%', '0.00ポイント'],
    ]);
    await profit.getByRole('button', { name: '基準を解除', exact: true }).click();
    await profit.getByRole('button', { name: '基準条件を記録', exact: true }).waitFor();
    observations.push({ stage, independent_inputs_and_baseline_retained: true, baseline_restore_and_clear: true });

    stage = 'profit-synthetic';
    for (const [label, value] of [
      ['シミュレーション期間 (ヶ月)', '3'], ['期初継続稼働数 (人)', '100'], ['月間単価 (円)', '1000'],
      ['月間退職率 (%)', '0'], ['月間新規開始数 (人)', '10'], ['直給率 (%)', '75'], ['対売上社保率 (%)', '10'],
    ]) await profit.getByLabel(label, { exact: true }).fill(value);
    await assertProfitSummary(360000, 54000, '15.00%');
    await waitRows(PROFIT_TABLE, formattedRows(profitRows()));
    assert.deepEqual((await page.locator(`${PROFIT_TABLE} tfoot td`).allTextContents()).map(s => s.trim()), ['期間累計 (PL)', ...[300000, 60000, 360000, 270000, 36000, 54000].map(yen)]);
    await checkCharts(PROFIT_CHART, 1, 9);

    stage = 'negative-profit';
    await profit.getByLabel('直給率 (%)', { exact: true }).fill('95');
    await assertProfitSummary(360000, -18000, '-5.00%');
    await waitRows(PROFIT_TABLE, formattedRows(profitRows(true)));
    await profit.getByRole('status').filter({ hasText: '合計が100%を超えています' }).waitFor();
    await checkCharts(PROFIT_CHART, 1, 9, true);
    await shot('negative-profit');

    if (mobile) {
      stage = 'mobile-monthly-table-scroll';
      const overflow = page.locator(PROFIT_TABLE).locator('..');
      await overflow.scrollIntoViewIfNeeded();
      const dimensions = await overflow.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX }));
      assert(dimensions.clientWidth > 0 && dimensions.scrollWidth > dimensions.clientWidth, 'Monthly table must have a usable horizontal scroll area on mobile');
      assert.equal(dimensions.overflowX, 'auto');
      await overflow.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      const position = await overflow.evaluate(element => {
        const last = element.querySelector('thead th:last-child').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { scrollLeft: element.scrollLeft, lastColumnVisible: last.left >= box.left - 1 && last.right <= box.right + 1 };
      });
      assert(position.scrollLeft > 0 && position.lastColumnVisible, 'Profit column must be reachable by scrolling');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Profit page must not overflow the mobile viewport');
      observations.push({ stage, ...dimensions, ...position });
      await shot('monthly-table-scrolled');
    }

    stage = 'final-invariants';
    // Check the switch back once more after the profit-side synthetic changes.
    await salesTab.click();
    assert.equal(await salesInputs.nth(2).inputValue(), '2000');
    assert.equal(await salesInputs.nth(0).inputValue(), '3');
    await profitTab.click();
    await assertProfitSummary(360000, -18000, '-5.00%');
    await checkCharts(PROFIT_CHART, 1, 9, true);
    await checkHeader('profit');
    // Navigation moves into the newly visible header, so keyboard focus must follow it.
    stage = 'header-keyboard-focus';
    await profitTab.press('ArrowLeft');
    await page.waitForFunction(() => document.activeElement?.id === 'simulation-tab-sales');
    assert.equal(await salesTab.getAttribute('aria-selected'), 'true');
    assert.equal(await salesInputs.nth(2).inputValue(), '2000');
    await checkHeader('sales');
    await salesTab.press('End');
    await page.waitForFunction(() => document.activeElement?.id === 'simulation-tab-profit');
    assert.equal(await profitTab.getAttribute('aria-selected'), 'true');
    await assertProfitSummary(360000, -18000, '-5.00%');
    await checkHeader('profit');
    await Promise.all(responseChecks);
    assert.deepEqual([...seen].sort(), [...files.keys()].sort(), 'Browser must fetch every exact artifact asset');
    assert.deepEqual(errors, [], 'No uncaught page errors or unexpected artifact bytes');
    assert.equal(aiRequests, 0, 'AI endpoints must never be requested, even if the request would be blocked');
    assert(blocked.every(request => request.method === 'GET' && request.origin === origin && request.path === '/vite.svg'), 'Unexpected attempted network request');
    assert.equal(await page.locator('link[rel=stylesheet]').count(), 1);
    assert.equal(await page.locator('body').evaluate(body => getComputedStyle(body).margin), '0px', 'Bundled stylesheet must apply');
    assert.deepEqual(await page.evaluate(() => ({ legacy: localStorage.getItem('simulationSavedReports'), profit: localStorage.getItem('simulationProfitSavedReports') })), { legacy: null, profit: null }, 'Synthetic interaction tests must not create stored reports');
    const report = {
      status: 'passed', phase, viewport: page.viewportSize(), mode: live ? 'production' : 'loopback', origin,
      expected_application_source: APPLICATION_SOURCE,
      source_files: Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)])),
      observations, screenshots, ai_requests: aiRequests, blocked, errors, console_errors: consoleErrors,
      storage: 'fresh isolated context; no existing user data; no report writes',
    };
    writeFileSync(join(out, `${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = { status: 'failed', phase, stage, mode: live ? 'production' : 'loopback', error: error.message, ai_requests: aiRequests, blocked, errors, console_errors: consoleErrors, observations, screenshots };
    writeFileSync(join(out, `${suffix}-failure.json`), JSON.stringify(report, null, 2) + '\n');
    await page?.screenshot({ path: join(out, `${suffix}-failure.png`), fullPage: true }).catch(() => {});
    console.error(JSON.stringify(report, null, 2));
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
    if (server) await new Promise(done => server.close(done));
  }
}

await main();
