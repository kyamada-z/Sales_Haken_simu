import React, { useLayoutEffect, useRef, useState } from 'react';
import SalesSimulation from './SalesSimulation';
import ProfitSimulation from './ProfitSimulation';

const tabs = [
  { id: 'sales', label: '売上' },
  { id: 'profit', label: '売上粗利' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('sales');
  const [hasOpenedProfit, setHasOpenedProfit] = useState(false);
  const tabRefs = useRef({});
  const shouldFocusTab = useRef(false);

  // The tablist moves between mounted panels; restore focus after its new buttons mount.
  useLayoutEffect(() => {
    if (shouldFocusTab.current) {
      tabRefs.current[activeTab]?.focus();
      shouldFocusTab.current = false;
    }
  }, [activeTab]);

  const selectTab = (id) => {
    if (id === 'profit') setHasOpenedProfit(true);
    shouldFocusTab.current = id !== activeTab;
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
    if (nextId === activeTab) tabRefs.current[nextId]?.focus();
  };

  const tabNavigation = (
          <div role="tablist" aria-label="シミュレーションの種類" className="inline-flex shrink-0 gap-1 self-start rounded-lg border border-gray-200 bg-gray-50 p-1 md:self-auto">
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
                className={`min-h-11 whitespace-nowrap rounded-md px-4 py-2 text-sm font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${activeTab === tab.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800">
      <div id="simulation-panel-sales" role="tabpanel" aria-labelledby="simulation-tab-sales" hidden={activeTab !== 'sales'}>
        <SalesSimulation headerTabs={activeTab === 'sales' ? tabNavigation : null} />
      </div>
      <div id="simulation-panel-profit" role="tabpanel" aria-labelledby="simulation-tab-profit" hidden={activeTab !== 'profit'}>
        {hasOpenedProfit && <ProfitSimulation headerTabs={activeTab === 'profit' ? tabNavigation : null} />}
      </div>
    </div>
  );
}
