export const DEFAULT_PARAMS = Object.freeze({
  initialUsers: 530,
  unitPrice: 280000,
  churnRate: 0.055,
  newUsersPerMonth: 33,
  directPayRate: 0.7499,
  socialInsuranceRate: 0.1027,
  months: 12,
});

// Keep restored reports and typed values within the supported simulation range.
export function normalizeParams(input = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_PARAMS).map(([key, fallback]) => {
    const raw = input?.[key];
    const parsed = raw === undefined || raw === null ? fallback : Number(raw);
    let value = Number.isFinite(parsed) ? parsed : fallback;
    value = Math.max(0, value);
    if (key.endsWith('Rate')) value = Math.min(1, value);
    if (key === 'months') value = Math.max(1, Math.min(120, Math.trunc(value)));
    return [key, value];
  }));
}

// --- 計算ロジック (Model) ---
export const calculateSimulation = (input) => {
  const params = normalizeParams(input);
  const { initialUsers, unitPrice, churnRate, newUsersPerMonth, directPayRate, socialInsuranceRate, months } = params;
  
  const rawMargin = 1 - (directPayRate + socialInsuranceRate);
  const grossMargin = Math.abs(rawMargin) < 1e-12 ? 0 : rawMargin;
  let monthlyData = [];
  let currentExistingUsers = initialUsers;
  let currentNewUsers = 0;
  
  let totalExistingRevenue = 0;
  let totalNewRevenue = 0;
  let totalNewTheoreticalRevenue = 0;

  for (let month = 1; month <= months; month++) {
    currentExistingUsers = currentExistingUsers * (1 - churnRate);
    const existingRevenue = currentExistingUsers * unitPrice;
    totalExistingRevenue += existingRevenue;

    const existingTheoreticalUsers = initialUsers;
    const existingTheoreticalRevenue = existingTheoreticalUsers * unitPrice;
    const existingLostRevenue = existingTheoreticalRevenue - existingRevenue;

    currentNewUsers = (currentNewUsers + newUsersPerMonth) * (1 - churnRate);
    const newRevenue = currentNewUsers * unitPrice;
    totalNewRevenue += newRevenue;

    const newTheoreticalUsers = month * newUsersPerMonth;
    const newTheoreticalRevenue = newTheoreticalUsers * unitPrice;
    totalNewTheoreticalRevenue += newTheoreticalRevenue;
    const newLostRevenue = newTheoreticalRevenue - newRevenue;

    const revenue = existingRevenue + newRevenue;
    monthlyData.push({
      month: `${month}ヶ月目`,
      existingUsers: currentExistingUsers,
      existingRevenue,
      existingTheoreticalRevenue,
      existingLostRevenue,
      newUsers: currentNewUsers,
      newRevenue,
      newTheoreticalRevenue,
      newLostRevenue,
      totalUsers: currentExistingUsers + currentNewUsers,
      totalRevenue: existingRevenue + newRevenue,
      directPayCost: revenue * directPayRate,
      socialInsuranceCost: revenue * socialInsuranceRate,
      grossProfit: revenue === 0 ? 0 : revenue * grossMargin,
      cost: revenue * (directPayRate + socialInsuranceRate),
    });
  }

  const initialARR = initialUsers * unitPrice * 12;
  const existingTheoreticalPeriodRevenue = initialUsers * unitPrice * months;
  const existingChurnLoss = existingTheoreticalPeriodRevenue - totalExistingRevenue;
  const newChurnLoss = totalNewTheoreticalRevenue - totalNewRevenue;
  const totalRevenue = totalExistingRevenue + totalNewRevenue;
  const finalUsers = monthlyData.length > 0 ? monthlyData[months - 1].totalUsers : initialUsers;
  const endingARR = finalUsers * unitPrice * 12;

  return {
    monthlyData,
    finalUsers,
    plMetrics: {
      initialARR,
      existingTheoreticalPeriodRevenue,
      existingChurnLoss,
      existingRevenue: totalExistingRevenue,
      newTheoreticalPeriodRevenue: totalNewTheoreticalRevenue,
      newChurnLoss,
      newRevenue: totalNewRevenue,
      totalRevenue,
      directPayCost: totalRevenue * directPayRate,
      socialInsuranceCost: totalRevenue * socialInsuranceRate,
      grossProfit: totalRevenue === 0 ? 0 : totalRevenue * grossMargin,
      grossMargin,
    },
    saasMetrics: {
      endingARR,
    }
  };
};

