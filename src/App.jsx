import React, { useRef, useState } from 'react';
import SalesSimulation from './SalesSimulation';
import ProfitSimulation from './ProfitSimulation';

const tabs = [
  { id: 'sales', label: '売上シミュレーション' },
  { id: 'profit', label: '売上・粗利シミュレーション' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('sales');
  const [hasOpenedProfit, setHasOpenedProfit] = useState(false);
  const tabRefs = useRef({});

  const selectTab = (id) => {
    if (id === 'profit') setHasOpenedProfit(true);
    setActiveTab(id);
  };

  const handleTabKeyDown = (event, index) => {
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextId = tabs[nextIndex].id;
    selectTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800">
      <div className="px-4 pt-4 md:px-8 md:pt-8">
        <div className="mx-auto max-w-7xl">
          <div role="tablist" aria-label="シミュレーションの種類" className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm sm:inline-flex">
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[tab.id] = node; }}
                id={`simulation-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`simulation-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={`min-h-11 rounded-lg px-3 py-2.5 text-sm font-semibold leading-relaxed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:px-5 ${activeTab === tab.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">入力条件はタブごとに独立しています。タブを切り替えても、それぞれの入力内容が保持されます。</p>
        </div>
      </div>

      <div id="simulation-panel-sales" role="tabpanel" aria-labelledby="simulation-tab-sales" hidden={activeTab !== 'sales'}>
        <SalesSimulation />
      </div>
      <div id="simulation-panel-profit" role="tabpanel" aria-labelledby="simulation-tab-profit" hidden={activeTab !== 'profit'}>
        {hasOpenedProfit && <ProfitSimulation />}
      </div>
    </div>
  );
}
