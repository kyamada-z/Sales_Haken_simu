import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSimulation, DEFAULT_PARAMS, normalizeParams } from './simulation.js';

const simpleScenario = {
  initialUsers: 100,
  unitPrice: 1000,
  churnRate: 0,
  newUsersPerMonth: 10,
  directPayRate: 0.75,
  socialInsuranceRate: 0.1,
  months: 3,
};

function closeTo(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite value, got ${actual}`);
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-12);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

test('the established default sales forecast is unchanged', () => {
  const result = calculateSimulation(DEFAULT_PARAMS);
  assert.equal(result.monthlyData.length, 12);
  assert.equal(Math.round(result.plMetrics.totalRevenue), 1817400319);
  assert.equal(Math.round(result.plMetrics.existingRevenue), 1256525163);
  assert.equal(Math.round(result.plMetrics.newRevenue), 560875156);
  assert.equal(result.finalUsers.toFixed(1), '548.2');
  closeTo(result.plMetrics.grossMargin, 0.1474, 'default gross margin');
  assert.equal(Math.round(result.plMetrics.grossProfit), 267884807);
});

test('three months with no churn retain the 360000 sales benchmark', () => {
  const result = calculateSimulation(simpleScenario);
  assert.deepEqual(result.monthlyData.map(row => row.totalUsers), [110, 120, 130]);
  assert.deepEqual(result.monthlyData.map(row => row.totalRevenue), [110000, 120000, 130000]);
  assert.equal(result.plMetrics.totalRevenue, 360000);
  assert.equal(result.plMetrics.existingRevenue, 300000);
  assert.equal(result.plMetrics.newRevenue, 60000);
  assert.equal(result.finalUsers, 130);
});

test('churn still applies to existing and new starters in the first month', () => {
  const result = calculateSimulation({ ...simpleScenario, churnRate: 0.1 });
  const expectedSales = [99000, 98100, 97290];
  result.monthlyData.forEach((row, index) => {
    closeTo(row.totalRevenue, expectedSales[index], `month ${index + 1} sales`);
  });
  closeTo(result.plMetrics.totalRevenue, 294390, 'three-month sales');
  closeTo(result.finalUsers, 97.29, 'final users');
});

test('monthly and period costs plus gross profit reconcile with sales', () => {
  const result = calculateSimulation(simpleScenario);
  const expected = [
    { directPayCost: 82500, socialInsuranceCost: 11000, grossProfit: 16500 },
    { directPayCost: 90000, socialInsuranceCost: 12000, grossProfit: 18000 },
    { directPayCost: 97500, socialInsuranceCost: 13000, grossProfit: 19500 },
  ];
  result.monthlyData.forEach((row, index) => {
    for (const key of ['directPayCost', 'socialInsuranceCost', 'grossProfit']) {
      closeTo(row[key], expected[index][key], `month ${index + 1} ${key}`);
    }
    closeTo(row.directPayCost + row.socialInsuranceCost + row.grossProfit,
      row.totalRevenue, `month ${index + 1} reconciliation`);
    closeTo(row.cost, row.directPayCost + row.socialInsuranceCost,
      `month ${index + 1} legacy cost`);
  });
  for (const [key, expectedTotal] of [
    ['directPayCost', 270000], ['socialInsuranceCost', 36000], ['grossProfit', 54000],
  ]) {
    closeTo(result.plMetrics[key], expectedTotal, `period ${key}`);
    closeTo(result.monthlyData.reduce((sum, row) => sum + row[key], 0),
      result.plMetrics[key], `sum of monthly ${key}`);
  }
  closeTo(result.plMetrics.directPayCost + result.plMetrics.socialInsuranceCost + result.plMetrics.grossProfit,
    result.plMetrics.totalRevenue, 'period reconciliation');
});

test('a one-percentage-point reduction in direct pay rate increases profit by 1% of sales', () => {
  const before = calculateSimulation(simpleScenario);
  const after = calculateSimulation({ ...simpleScenario, directPayRate: 0.74 });
  assert.equal(after.plMetrics.totalRevenue, before.plMetrics.totalRevenue);
  assert.equal(after.finalUsers, before.finalUsers);
  closeTo(after.plMetrics.grossMargin - before.plMetrics.grossMargin, 0.01, 'margin improvement');
  closeTo(after.plMetrics.grossProfit - before.plMetrics.grossProfit, 3600, 'profit improvement');
  closeTo(after.plMetrics.socialInsuranceCost, before.plMetrics.socialInsuranceCost, 'unchanged social insurance');
});

test('zero sales produce finite zero costs and profit', () => {
  for (const zeroCase of [
    { initialUsers: 0, newUsersPerMonth: 0 },
    { unitPrice: 0 },
    { unitPrice: 0, directPayRate: 0.95, socialInsuranceRate: 0.1 },
  ]) {
    const result = calculateSimulation({ ...simpleScenario, ...zeroCase });
    for (const row of [...result.monthlyData, result.plMetrics]) {
      for (const key of ['totalRevenue', 'directPayCost', 'socialInsuranceCost', 'grossProfit']) {
        closeTo(row[key], 0, `zero-sales ${key}`);
      }
    }
    closeTo(result.plMetrics.grossMargin, zeroCase.directPayRate ? -0.05 : 0.15, 'configured margin remains defined');
    assert.equal(Object.is(result.plMetrics.grossProfit, -0), false, 'no negative zero currency');
  }
});

test('cost rates totaling 100% give exactly zero rather than a false loss', () => {
  const result = calculateSimulation({ ...simpleScenario, directPayRate: 0.8, socialInsuranceRate: 0.2 });
  assert.equal(result.plMetrics.grossMargin, 0);
  assert.equal(result.plMetrics.grossProfit, 0);
  for (const row of result.monthlyData) assert.equal(row.grossProfit, 0);
});

test('cost rates above 100% retain negative profit instead of clamping to zero', () => {
  const result = calculateSimulation({ ...simpleScenario, directPayRate: 0.95, socialInsuranceRate: 0.1 });
  closeTo(result.plMetrics.grossMargin, -0.05, 'negative margin');
  closeTo(result.plMetrics.grossProfit, -18000, 'negative period profit');
  for (const row of result.monthlyData) {
    assert.ok(row.grossProfit < 0);
    closeTo(row.directPayCost + row.socialInsuranceCost + row.grossProfit,
      row.totalRevenue, 'negative-margin reconciliation');
  }
});

test('typed values are normalized to safe supported rates and integer months', () => {
  const input = {
    initialUsers: -10,
    unitPrice: '123456',
    churnRate: 1.2,
    newUsersPerMonth: 'invalid',
    directPayRate: '0.8',
    socialInsuranceRate: -0.1,
    months: '3.9',
    unused: 'ignored',
  };
  const normalized = normalizeParams(input);
  assert.deepEqual(normalized, {
    initialUsers: 0,
    unitPrice: 123456,
    churnRate: 1,
    newUsersPerMonth: DEFAULT_PARAMS.newUsersPerMonth,
    directPayRate: 0.8,
    socialInsuranceRate: 0,
    months: 3,
  });
  assert.equal(input.months, '3.9', 'normalization must not mutate the source report/input');
  assert.equal(normalizeParams({ months: 0 }).months, 1);
  assert.equal(normalizeParams({ months: 999 }).months, 120);
  assert.equal(normalizeParams({ directPayRate: 1.1 }).directPayRate, 1);
  assert.equal(normalizeParams({ socialInsuranceRate: 1.1 }).socialInsuranceRate, 1);
  assert.equal(calculateSimulation({ months: '3.9' }).monthlyData.length, 3);
});

test('missing or non-finite saved report parameters fall back to existing defaults', () => {
  assert.deepEqual(normalizeParams(), DEFAULT_PARAMS);
  assert.deepEqual(normalizeParams(null), DEFAULT_PARAMS);
  const restored = normalizeParams({
    initialUsers: 100, unitPrice: 1000, churnRate: 0, newUsersPerMonth: 10, months: 3,
  });
  assert.equal(restored.directPayRate, DEFAULT_PARAMS.directPayRate);
  assert.equal(restored.socialInsuranceRate, DEFAULT_PARAMS.socialInsuranceRate);
  const result = calculateSimulation(restored);
  assert.equal(result.plMetrics.totalRevenue, 360000);
  closeTo(result.plMetrics.grossProfit, 53064, 'profit after restoring a legacy report');
  assert.deepEqual(normalizeParams({
    initialUsers: NaN, unitPrice: Infinity, churnRate: undefined,
    newUsersPerMonth: -Infinity, directPayRate: null, socialInsuranceRate: 'NaN', months: NaN,
  }), DEFAULT_PARAMS);
});
