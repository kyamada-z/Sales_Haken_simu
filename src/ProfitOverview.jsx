import React from 'react';
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowRightLeft, BookmarkPlus, RotateCcw, TrendingUp, X } from 'lucide-react';

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const percent = (value) => `${(value * 100).toFixed(2)}%`;
const signedYen = (value) => `${value > 0 ? '+' : ''}${yen.format(value)}`;
const signedPoints = (value) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}ポイント`;
const deltaColor = (value) => value < 0 ? 'text-red-700' : value > 0 ? 'text-teal-700' : 'text-gray-600';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2';

function SummaryCard({ title, value, detail, tone = 'blue' }) {
  const colors = {
    blue: 'border-blue-100 bg-blue-50 text-blue-950',
    teal: 'border-teal-200 bg-teal-50 text-teal-950',
    gray: 'border-gray-200 bg-white text-gray-900',
    red: 'border-red-200 bg-red-50 text-red-900',
  };
  return (
    <div className={`min-w-0 rounded-xl border p-4 ${colors[tone]}`}>
      <p className="text-xs font-semibold leading-relaxed">{title}</p>
      <p className="mt-2 break-words text-xl font-bold tabular-nums leading-tight">{value}</p>
      <p className="mt-2 text-xs leading-relaxed opacity-75">{detail}</p>
    </div>
  );
}

function Comparison({ params, result, baseline, onRecordBaseline, onRestoreBaseline, onClearBaseline }) {
  const comparisons = baseline ? [
    { label: '期間売上', current: result.plMetrics.totalRevenue, base: baseline.result.plMetrics.totalRevenue, format: (value) => yen.format(value), difference: signedYen },
    { label: '粗利（社保引き後）', current: result.plMetrics.grossProfit, base: baseline.result.plMetrics.grossProfit, format: (value) => yen.format(value), difference: signedYen },
    { label: '粗利率（社保引き後）', current: result.plMetrics.grossMargin, base: baseline.result.plMetrics.grossMargin, format: percent, difference: signedPoints },
  ] : [];
  return (
    <section className="rounded-xl border border-blue-100 bg-white p-4 sm:p-5" aria-labelledby="baseline-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="baseline-heading" className="flex items-center gap-2 text-base font-bold text-gray-900">
          <ArrowRightLeft className="h-4 w-4 text-blue-600" aria-hidden="true" />基準条件との比較
        </h2>
        <button type="button" onClick={onRecordBaseline} className={`${buttonClass} bg-blue-600 text-white hover:bg-blue-700`}>
          <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
          {baseline ? '現在の条件で基準を更新' : '基準条件を記録'}
        </button>
      </div>
      {baseline ? (
        <>
          <p className="mt-3 text-xs leading-relaxed text-gray-500">入力を変えると、記録した基準との差額が更新されます。基準はこの画面を開いている間だけ保持されます。</p>
          <div className="mt-3 rounded-lg bg-gray-50 p-3">
            <p className="mb-2 text-xs font-bold text-gray-700">記録した基準条件</p>
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs leading-relaxed text-gray-600">
              <div className="flex gap-1"><dt>期間</dt><dd className="font-medium">{baseline.params.months}ヶ月</dd></div>
              <div className="flex gap-1"><dt>期初稼働</dt><dd className="font-medium">{number.format(baseline.params.initialUsers)}人</dd></div>
              <div className="flex gap-1"><dt>月間単価</dt><dd className="font-medium">{yen.format(baseline.params.unitPrice)}</dd></div>
              <div className="flex gap-1"><dt>月間退職率</dt><dd className="font-medium">{percent(baseline.params.churnRate)}</dd></div>
              <div className="flex gap-1"><dt>月間新規開始</dt><dd className="font-medium">{number.format(baseline.params.newUsersPerMonth)}人</dd></div>
              <div className="flex gap-1"><dt>直給率</dt><dd className="font-medium">{percent(baseline.params.directPayRate)}</dd></div>
              <div className="flex gap-1"><dt>対売上社保率</dt><dd className="font-medium">{percent(baseline.params.socialInsuranceRate)}</dd></div>
            </dl>
          </div>
          {params.months !== baseline.params.months && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900" role="status">
              期間が異なります：基準は{baseline.params.months}ヶ月、現在は{params.months}ヶ月です。差額には期間の違いも含まれます。
            </p>
          )}
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-100" tabIndex={0} role="region" aria-label="基準と現在の比較表">
            <table className="w-full min-w-[540px] text-right text-sm tabular-nums">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr><th scope="col" className="px-3 py-2 text-left">項目</th><th scope="col" className="px-3 py-2">基準</th><th scope="col" className="px-3 py-2">現在</th><th scope="col" className="px-3 py-2">基準との差</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {comparisons.map(({ label, current, base, format, difference }) => (
                  <tr key={label}>
                    <th scope="row" className="px-3 py-3 text-left text-xs font-medium text-gray-700">{label}</th>
                    <td className="whitespace-nowrap px-3 py-3 text-gray-500">{format(base)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-semibold text-gray-900">{format(current)}</td>
                    <td className={`whitespace-nowrap px-3 py-3 font-bold ${deltaColor(current - base)}`}>{difference(current - base)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onRestoreBaseline} className={`${buttonClass} border border-gray-200 text-gray-700 hover:bg-gray-50`}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />基準条件に戻す</button>
            <button type="button" onClick={onClearBaseline} className={`${buttonClass} text-gray-500 hover:bg-gray-100`}><X className="h-3.5 w-3.5" aria-hidden="true" />基準を解除</button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-gray-500">今の条件を基準として記録し、人数・単価・率を変えたときの売上と粗利の差を確認できます。基準は画面を再読み込みすると解除されます。</p>
      )}
    </section>
  );
}

export default function ProfitOverview({ params, result, baseline, onRecordBaseline, onRestoreBaseline, onClearBaseline }) {
  const { totalRevenue, directPayCost, socialInsuranceCost, grossProfit, grossMargin } = result.plMetrics;
  const isLoss = grossMargin < 0;
  const breakdown = [
    { label: '期間売上', amount: totalRevenue, description: `${params.months}ヶ月累計`, sign: '' },
    { label: '直給費', amount: directPayCost, description: `売上 × ${percent(params.directPayRate)}`, sign: '−' },
    { label: '社保費', amount: socialInsuranceCost, description: `売上 × ${percent(params.socialInsuranceRate)}`, sign: '−' },
    { label: '粗利（社保引き後）', amount: grossProfit, description: `粗利率 ${percent(grossMargin)}`, sign: '＝', profit: true },
  ];
  return (
    <div className="space-y-5">
      <section aria-labelledby="profit-overview-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="profit-overview-heading" className="text-lg font-bold text-gray-900">売上・粗利の試算結果</h2>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800">{params.months}ヶ月の見込</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard title="期間売上" value={yen.format(totalRevenue)} detail="既存・新規の売上合計" />
          <SummaryCard title="粗利（社保引き後）" value={yen.format(grossProfit)} detail="売上 − 直給費 − 社保費" tone={isLoss ? 'red' : 'teal'} />
          <SummaryCard title="粗利率（社保引き後）" value={percent(grossMargin)} detail="100% − 直給率 − 対売上社保率" tone={isLoss ? 'red' : 'teal'} />
          <SummaryCard title="最終月末の総稼働見込" value={`${number.format(result.finalUsers)}人`} detail={`${params.months}ヶ月目の既存・新規の合計`} tone="gray" />
        </div>
      </section>

      <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm sm:p-5" aria-labelledby="profit-breakdown-heading">
        <h2 id="profit-breakdown-heading" className="text-base font-bold text-gray-900">期間売上から粗利まで</h2>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {breakdown.map(({ label, amount, description, sign, profit }) => (
            <div key={label} className={`min-w-0 rounded-lg p-3 ${profit ? isLoss ? 'bg-red-50 text-red-900' : 'bg-teal-50 text-teal-900' : 'bg-gray-50 text-gray-700'}`}>
              <p className="text-xs font-medium"><span className="mr-1 font-bold" aria-hidden="true">{sign}</span>{label}</p>
              <p className="mt-2 break-words text-base font-bold tabular-nums">{yen.format(amount)}</p>
              <p className="mt-1 text-xs opacity-75">{description}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-gray-500">直給率・対売上社保率は、どちらも売上に対する割合として全月に一定で適用します。単価を変えると直給費・社保費も連動します。その他の経費は含みません。表示額は円単位に四捨五入するため、内訳の合計と差が出る場合があります。</p>
        {isLoss && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800" role="status">直給率と対売上社保率の合計が100%を超えています。粗利率はマイナスとして計算されます。</p>}
      </section>

      <Comparison params={params} result={result} baseline={baseline} onRecordBaseline={onRecordBaseline} onRestoreBaseline={onRestoreBaseline} onClearBaseline={onClearBaseline} />

      <section className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm sm:p-5" aria-labelledby="monthly-profit-heading">
        <h2 id="monthly-profit-heading" className="flex items-center gap-2 text-base font-bold text-gray-900"><TrendingUp className="h-4 w-4 text-blue-600" aria-hidden="true" />月別の売上・費用・粗利</h2>
        <p className="mt-2 text-xs leading-relaxed text-gray-500">棒グラフは直給費・社保費・粗利の内訳、青い線は売上を示します。{isLoss ? '費用が売上を超えるため、マイナスの粗利をゼロより下に表示しています。' : '各月の棒グラフの合計が売上です。'} 月別の金額は下の明細表でも確認できます。</p>
        <div className="mt-4 h-72 w-full" role="img" aria-label={`月別の直給費・社保費・粗利と売上の推移。粗利率は全月${percent(grossMargin)}。数値は月別明細表に記載。`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={result.monthlyData} stackOffset="sign" margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6b7280' }} minTickGap={20} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(value) => `${number.format(value / 10000)}万`} width={64} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
              <Tooltip formatter={(value, name) => [yen.format(value), name]} contentStyle={{ borderRadius: 8, borderColor: '#e5e7eb', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} iconType="circle" />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Bar dataKey="directPayCost" name="直給費" stackId="costs" fill="#94a3b8" isAnimationActive={false} />
              <Bar dataKey="socialInsuranceCost" name="社保費" stackId="costs" fill="#cbd5e1" isAnimationActive={false} />
              <Bar dataKey="grossProfit" name="粗利（社保引き後）" stackId="costs" fill={isLoss ? '#dc2626' : '#0d9488'} isAnimationActive={false} />
              <Line type="linear" dataKey="totalRevenue" name="売上" stroke="#2563eb" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
