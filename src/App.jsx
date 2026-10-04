import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ComposedChart
} from 'recharts';
import { Calculator, Info, TrendingUp, Users, DollarSign, Sparkles, Loader2, Save, MessageCircle, Send, History, Trash2, Clock, Check } from 'lucide-react';

const apiKey = "";

// Gemini API呼び出し関数（対話履歴を配列で受け取れるように改修）
const callGeminiAPI = async (contents) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const payload = {
    contents: contents,
  };

  const maxRetries = 5;
  const baseDelay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "応答の生成に失敗しました。";
    } catch (error) {
      if (attempt === maxRetries) {
        console.error("API call failed after max retries", error);
        throw new Error("通信エラーが発生しました。しばらく経ってから再度お試しください。");
      }
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// --- 計算ロジック (Model) ---
const calculateSimulation = (params) => {
  const { initialUsers, unitPrice, churnRate, newUsersPerMonth, directPayRate, socialInsuranceRate, months } = params;
  
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
      cost: (existingRevenue + newRevenue) * (directPayRate + socialInsuranceRate),
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
    },
    saasMetrics: {
      endingARR,
    }
  };
};

const formatCurrency = (value) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
const formatNumber = (value) => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value);
const yAxisFormatter = (value) => `${value / 10000}万`;

const MetricCard = ({ title, value, description, type = 'default' }) => {
  const styles = {
    default: 'bg-white border-gray-200 text-gray-800',
    primary: 'bg-blue-50 border-blue-200 text-blue-900',
    danger: 'bg-red-50 border-red-200 text-red-900',
    success: 'bg-green-50 border-green-200 text-green-900',
    purple: 'bg-purple-50 border-purple-200 text-purple-900',
  };
  const iconColors = {
    default: 'text-gray-400',
    primary: 'text-blue-500',
    danger: 'text-red-500',
    success: 'text-green-500',
    purple: 'text-purple-500',
  };

  return (
    <div className={`p-3 md:p-4 rounded-xl border relative group transition-colors flex-1 shadow-sm min-w-0 ${styles[type]}`}>
      <div className="text-xs font-medium mb-1 flex items-center gap-1 opacity-80">
        <span className="truncate">{title}</span>
        <Info className={`w-3.5 h-3.5 cursor-help flex-shrink-0 ${iconColors[type]}`} />
      </div>
      <div className="text-sm md:text-lg font-bold truncate">{value}</div>
      <div className="absolute hidden group-hover:block bg-gray-900 text-white text-xs p-3 rounded-lg -top-2 left-1/2 transform -translate-x-1/2 -translate-y-full w-56 md:w-64 z-20 shadow-xl pointer-events-none font-normal leading-relaxed whitespace-normal">
        {description}
        <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-gray-900 rotate-45"></div>
      </div>
    </div>
  );
};

export default function App() {
  const [params, setParams] = useState({
    initialUsers: 530,
    unitPrice: 280000,
    churnRate: 0.055,
    newUsersPerMonth: 33,
    directPayRate: 0.7499,
    socialInsuranceRate: 0.1027,
    months: 12,
  });

  // AIレポート＆チャット関連のステート
  const [aiReport, setAiReport] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiError, setApiError] = useState("");
  
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [isChatting, setIsChatting] = useState(false);
  
  // 保存機能関連のステート
  const [savedReports, setSavedReports] = useState([]);
  const [isSavedDone, setIsSavedDone] = useState(false);
  
  const chatScrollRef = useRef(null);

  const result = useMemo(() => calculateSimulation(params), [params]);

  // ローカルストレージから保存済みレポートを読み込む
  useEffect(() => {
    const saved = localStorage.getItem('simulationSavedReports');
    if (saved) {
      try {
        setSavedReports(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load saved reports", e);
      }
    }
  }, []);

  // チャット追加時に一番下へスクロール
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, isChatting]);

  const handleParamChange = (key, value) => {
    setParams(prev => ({ ...prev, [key]: parseFloat(value) || 0 }));
    // パラメータが変わったら未保存状態にする
    setIsSavedDone(false);
  };

  const generateReport = async () => {
    setIsGenerating(true);
    setApiError("");
    setAiReport("");
    setChatMessages([]);
    setIsSavedDone(false);

    const prompt = `あなたは派遣事業に精通した経営コンサルタントです。
以下の売上シミュレーション結果を分析し、経営陣向けのレポートを作成してください。

【前提条件】
- シミュレーション期間: ${params.months}ヶ月
- 期初稼働数: ${params.initialUsers}人
- 月間単価: ${formatCurrency(params.unitPrice)}
- 月間退職率: ${params.churnRate * 100}%
- 月間新規開始数: ${params.newUsersPerMonth}人

【シミュレーション結果（${params.months}ヶ月累計）】
- 期間予測 総売上: ${formatCurrency(result.plMetrics.totalRevenue)}
- 既存顧客からの退職減収 (機会損失): ${formatCurrency(result.plMetrics.existingChurnLoss)}
- 新規顧客からの退職減収 (機会損失): ${formatCurrency(result.plMetrics.newChurnLoss)}
- 最終月末の総稼働見込: ${formatNumber(result.finalUsers)}人

以下の構成で、簡潔かつ説得力のある回答をしてください。
※注意：マークダウン記法（**太字**や#など）は使わず、プレーンテキストとして記号（■や・など）を使って読みやすく箇条書きにしてください。

■ シミュレーション結果のサマリー
■ 退職減収（機会損失）のインパクト評価
■ 利益を最大化するための具体的なアクションプラン（派遣事業特有の施策を3つ）
`;

    setInitialPrompt(prompt);

    try {
      const contents = [{ role: 'user', parts: [{ text: prompt }] }];
      const reportText = await callGeminiAPI(contents);
      setAiReport(reportText);
    } catch (err) {
      setApiError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;

    const userMessage = chatInput.trim();
    setChatInput("");
    setIsChatting(true);
    setApiError("");

    const newMessages = [...chatMessages, { role: 'user', text: userMessage }];
    setChatMessages(newMessages);

    // AIに文脈（初期プロンプト＋レポート＋チャット履歴）をすべて渡す
    const contents = [
      { role: 'user', parts: [{ text: initialPrompt }] },
      { role: 'model', parts: [{ text: aiReport }] },
      ...newMessages.map(msg => ({ role: msg.role, parts: [{ text: msg.text }] }))
    ];

    try {
      const replyText = await callGeminiAPI(contents);
      setChatMessages([...newMessages, { role: 'model', text: replyText }]);
      setIsSavedDone(false); // チャットが追加されたら未保存状態へ
    } catch (err) {
      setApiError("チャット送信エラー: " + err.message);
      // エラー時はユーザーのメッセージだけ残すかロールバックするか。今回は残す。
    } finally {
      setIsChatting(false);
    }
  };

  const handleSaveReport = () => {
    if (!aiReport) return;

    const newReport = {
      id: Date.now().toString(),
      date: new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute:'2-digit' }),
      params: { ...params },
      initialPrompt,
      reportContent: aiReport,
      chatMessages: [...chatMessages],
      summaryRevenue: result.plMetrics.totalRevenue,
    };

    const updatedReports = [newReport, ...savedReports];
    setSavedReports(updatedReports);
    localStorage.setItem('simulationSavedReports', JSON.stringify(updatedReports));
    setIsSavedDone(true);
    
    // 3秒後に「保存しました」表示を消す
    setTimeout(() => setIsSavedDone(false), 3000);
  };

  const loadSavedReport = (report) => {
    if (window.confirm("現在のシミュレーション状態を上書きして、保存されたレポートを復元しますか？")) {
      setParams(report.params);
      setAiReport(report.reportContent);
      setInitialPrompt(report.initialPrompt);
      setChatMessages(report.chatMessages || []);
      setApiError("");
      setIsSavedDone(true); // 読み込み直後は保存済み扱い
      
      // 画面一番下へスクロール
      setTimeout(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }, 100);
    }
  };

  const deleteSavedReport = (id, e) => {
    e.stopPropagation();
    if (window.confirm("この保存済みレポートを削除しますか？")) {
      const updatedReports = savedReports.filter(r => r.id !== id);
      setSavedReports(updatedReports);
      localStorage.setItem('simulationSavedReports', JSON.stringify(updatedReports));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8 font-sans text-gray-800">
      <div className="max-w-7xl mx-auto space-y-6">
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Calculator className="w-6 h-6 text-blue-600" />
              派遣売上シミュレーション
            </h1>
            <p className="text-gray-500 mt-1 text-sm">
              派遣事業の売上をSaaSのPL（損益計算書）になぞらえ、「既存顧客からの売上」と「新規顧客からの売上」に分解して任意の期間で予測します。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* 左サイドバー */}
          <div className="lg:col-span-3 space-y-4">
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-semibold border-b pb-3 mb-4">前提条件</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1 text-blue-600">シミュレーション期間 (ヶ月)</label>
                  <input type="number" value={params.months} onChange={(e) => handleParamChange('months', e.target.value)} min="1" max="120" className="w-full p-2 border rounded-md bg-blue-50 text-right focus:ring-2 focus:ring-blue-500 font-bold text-blue-700" />
                </div>
                <div className="pt-3 border-t">
                  <div className="flex items-center gap-1 mb-1 group relative">
                    <label className="block text-xs font-medium text-gray-500">期初継続稼働数 (人)</label>
                    <Info className="w-3.5 h-3.5 text-gray-400 cursor-help" />
                    <div className="absolute hidden group-hover:block bg-gray-900 text-white text-xs p-3 rounded-lg bottom-full left-0 mb-2 w-56 z-20 shadow-xl pointer-events-none font-normal leading-relaxed whitespace-normal">
                      再配予定の稼働者を含みます。<br/>
                      <span className="text-gray-300 text-[10.5px] mt-1 block leading-tight">
                        ※再配とは派遣先を変更することです。派遣先が変わっても当社との雇用契約は続くため、期初の継続稼働人数に含めて計算します。
                      </span>
                      <div className="absolute -bottom-1 left-20 w-2 h-2 bg-gray-900 rotate-45"></div>
                    </div>
                  </div>
                  <input type="number" value={params.initialUsers} onChange={(e) => handleParamChange('initialUsers', e.target.value)} className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">月間単価 (円)</label>
                  <input type="number" value={params.unitPrice} onChange={(e) => handleParamChange('unitPrice', e.target.value)} step="10000" className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">月間退職率 (%)</label>
                  <input type="number" value={params.churnRate * 100} onChange={(e) => handleParamChange('churnRate', e.target.value / 100)} step="0.1" className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                  <p className="text-[10px] text-gray-400 mt-1">※新規開始者も初月からこの率で退職する前提です</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">月間新規開始数 (人)</label>
                  <input type="number" value={params.newUsersPerMonth} onChange={(e) => handleParamChange('newUsersPerMonth', e.target.value)} className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="pt-3 border-t">
                  <label className="block text-xs font-medium text-gray-500 mb-1">直給率 (%)</label>
                  <input type="number" value={params.directPayRate * 100} onChange={(e) => handleParamChange('directPayRate', e.target.value / 100)} step="0.01" className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">対売上社保率 (%)</label>
                  <input type="number" value={params.socialInsuranceRate * 100} onChange={(e) => handleParamChange('socialInsuranceRate', e.target.value / 100)} step="0.01" className="w-full p-2 border rounded-md bg-gray-50 text-right focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
            </div>

            {/* 保存済みレポート一覧 */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-semibold border-b pb-3 mb-4 flex items-center gap-2">
                <History className="w-5 h-5 text-gray-500" />
                保存済みレポート
              </h2>
              {savedReports.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">保存されたレポートはありません</p>
              ) : (
                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {savedReports.map(report => (
                    <div 
                      key={report.id} 
                      onClick={() => loadSavedReport(report)}
                      className="p-3 border border-gray-200 rounded-lg hover:bg-purple-50 hover:border-purple-200 cursor-pointer transition-colors group"
                    >
                      <div className="flex justify-between items-start mb-1">
                        <div className="text-xs text-gray-500 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {report.date}
                        </div>
                        <button 
                          onClick={(e) => deleteSavedReport(report.id, e)}
                          className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="font-semibold text-sm text-gray-800">
                        {report.params.months}ヶ月: {formatCurrency(report.summaryRevenue)}
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1 flex gap-2">
                        <span>期初 {report.params.initialUsers}人</span>
                        <span>退職率 {report.params.churnRate * 100}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右メイン: 結果表示 */}
          <div className="lg:col-span-9 space-y-6">
            
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-gray-400" />
                  指定期間の売上予測内訳
                </h3>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                退職者が0人だった場合の「理論売上」から、退職によって失われた「機会損失（減収）」を差し引いて、最終的な「実績売上」を算出しています。
              </p>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2 bg-gray-50 p-4 rounded-xl border border-gray-200">
                  <div className="w-full md:w-20 text-sm font-bold text-gray-600 md:text-center shrink-0">既存顧客</div>
                  <div className="flex-1 flex items-center gap-2">
                    <MetricCard title="理論上の期間売上" value={formatCurrency(result.plMetrics.existingTheoreticalPeriodRevenue)} description={`期初の既存顧客が一人も退職しなかった場合の最大売上（期初人数 × 単価 × ${params.months}ヶ月）`} />
                    <div className="text-xl font-bold text-gray-400">－</div>
                    <MetricCard title="退職による減収 (Churn)" value={formatCurrency(result.plMetrics.existingChurnLoss)} type="danger" description="退職によって得られなくなった機会損失の合計額" />
                    <div className="text-xl font-bold text-gray-400">＝</div>
                    <MetricCard title="期間実績売上" value={formatCurrency(result.plMetrics.existingRevenue)} type="primary" description="既存顧客からの実際の売上着地見込" />
                  </div>
                </div>

                <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2 bg-gray-50 p-4 rounded-xl border border-gray-200">
                  <div className="w-full md:w-20 text-sm font-bold text-gray-600 md:text-center shrink-0">新規獲得</div>
                  <div className="flex-1 flex items-center gap-2">
                    <MetricCard title="理論上の期間売上" value={formatCurrency(result.plMetrics.newTheoreticalPeriodRevenue)} description="獲得した新規顧客がその後一人も退職しなかった場合の最大売上" />
                    <div className="text-xl font-bold text-gray-400">－</div>
                    <MetricCard title="退職による減収 (Churn)" value={formatCurrency(result.plMetrics.newChurnLoss)} type="danger" description="新規獲得した顧客が早期退職したことによる機会損失" />
                    <div className="text-xl font-bold text-gray-400">＝</div>
                    <MetricCard title="期間実績売上" value={formatCurrency(result.plMetrics.newRevenue)} type="success" description="新規顧客からの実際の売上着地見込" />
                  </div>
                </div>

                <div className="flex justify-end mt-2">
                  <div className="w-full md:w-1/2 lg:w-1/3">
                    <MetricCard title="期間予測 総売上" value={formatCurrency(result.plMetrics.totalRevenue)} type="purple" description={`既存と新規の実績売上を足し合わせた、${params.months}ヶ月間の総売上高です。`} />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-4 bg-blue-50 text-blue-600 rounded-full"><Users className="w-7 h-7" /></div>
                <div>
                  <p className="text-sm text-gray-500 font-medium">最終月末の総稼働見込</p>
                  <p className="text-3xl font-bold text-gray-900">{formatNumber(result.finalUsers)} <span className="text-base font-normal text-gray-500">人</span></p>
                </div>
              </div>
              
              <div className="md:border-l border-gray-100 md:pl-6 text-right w-full md:w-auto flex md:block justify-between items-center">
                <p className="text-[11px] text-gray-400 flex items-center md:justify-end gap-1 mb-0.5">
                  <Info className="w-3 h-3" />
                  参考: 期末時点の理論年商 (ARR)
                </p>
                <p className="text-sm text-gray-400 font-medium">{formatCurrency(result.saasMetrics.endingARR)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
                <h3 className="text-md font-bold mb-1 text-gray-800">既存顧客：退職による減収推移</h3>
                <p className="text-[11px] text-gray-500 mb-4 h-8">
                  全体（棒の高さ）が理論上の売上です。赤色部分が毎月の退職によって「失われ続けている売上」を示します。
                </p>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <BarChart data={result.monthlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} dy={10} />
                      <YAxis tickFormatter={yAxisFormatter} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                      <RechartsTooltip formatter={(value) => [formatCurrency(value), '']} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} iconType="circle" />
                      <Bar dataKey="existingRevenue" name="実績売上" stackId="a" fill="#3B82F6" radius={[0, 0, 4, 4]} />
                      <Bar dataKey="existingLostRevenue" name="失われた売上(退職)" stackId="a" fill="#FECACA" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
                <h3 className="text-md font-bold mb-1 text-gray-800">新規獲得：退職による減収推移</h3>
                <p className="text-[11px] text-gray-500 mb-4 h-8">
                  獲得により売上（緑色）は伸びますが、退職率の影響で本来得られるはずの売上（赤色）が徐々に削られています。
                </p>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <BarChart data={result.monthlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} dy={10} />
                      <YAxis tickFormatter={yAxisFormatter} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                      <RechartsTooltip formatter={(value) => [formatCurrency(value), '']} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} iconType="circle" />
                      <Bar dataKey="newRevenue" name="実績売上" stackId="a" fill="#10B981" radius={[0, 0, 4, 4]} />
                      <Bar dataKey="newLostRevenue" name="失われた売上(退職)" stackId="a" fill="#FECACA" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 mt-6">
              <h3 className="text-md font-bold mb-4">総稼働人数の推移</h3>
              <div className="h-56 w-full">
                <ResponsiveContainer>
                  <ComposedChart data={result.monthlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                    <RechartsTooltip formatter={(value) => [formatNumber(value) + ' 人', '']} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} iconType="circle" />
                    <Bar dataKey="existingUsers" name="既存稼働者" stackId="a" fill="#BFDBFE" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="newUsers" name="新規稼働者" stackId="a" fill="#6EE7B7" radius={[4, 4, 0, 0]} />
                    <Line type="monotone" dataKey="totalUsers" name="総稼働数" stroke="#1E40AF" strokeWidth={3} dot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-right">
                  <thead className="bg-gray-50 text-gray-500 font-medium border-b">
                    <tr>
                      <th className="px-4 py-3 text-left">月</th>
                      <th className="px-4 py-3">既存稼働数</th>
                      <th className="px-4 py-3">新規稼働数</th>
                      <th className="px-4 py-3 text-blue-600">総稼働数</th>
                      <th className="px-4 py-3">既存実績売上</th>
                      <th className="px-4 py-3">新規実績売上</th>
                      <th className="px-4 py-3 font-bold text-gray-900">当月売上合計</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.monthlyData.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-left font-medium text-gray-900">{row.month}</td>
                        <td className="px-4 py-3 text-gray-600">{formatNumber(row.existingUsers)}</td>
                        <td className="px-4 py-3 text-gray-600">{formatNumber(row.newUsers)}</td>
                        <td className="px-4 py-3 text-blue-600 font-medium">{formatNumber(row.totalUsers)}</td>
                        <td className="px-4 py-3 text-gray-600">{formatCurrency(row.existingRevenue)}</td>
                        <td className="px-4 py-3 text-gray-600">{formatCurrency(row.newRevenue)}</td>
                        <td className="px-4 py-3 font-bold text-gray-900">{formatCurrency(row.totalRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-bold text-gray-900 border-t-2">
                    <tr>
                      <td className="px-4 py-4 text-left" colSpan={4}>期間累計 (PL)</td>
                      <td className="px-4 py-4 text-blue-700">{formatCurrency(result.plMetrics.existingRevenue)}</td>
                      <td className="px-4 py-4 text-green-700">{formatCurrency(result.plMetrics.newRevenue)}</td>
                      <td className="px-4 py-4 text-purple-700">{formatCurrency(result.plMetrics.totalRevenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* AIレポート & チャット セクション */}
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 p-6 rounded-xl shadow-sm border border-purple-100 mt-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
                <div>
                  <h3 className="text-lg font-bold flex items-center gap-2 text-purple-900">
                    <Sparkles className="w-5 h-5 text-purple-500" />
                    AI経営分析レポート & 深掘りチャット
                  </h3>
                  <p className="text-sm text-purple-700 mt-1">
                    現在の数値をAIが分析します。さらにチャットで具体的な改善策を相談・深掘りできます。
                  </p>
                </div>
                <button
                  onClick={generateReport}
                  disabled={isGenerating}
                  className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shadow-sm"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      生成中...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      レポートを生成
                    </>
                  )}
                </button>
              </div>

              {apiError && (
                <div className="bg-red-50 text-red-600 p-4 rounded-lg mt-4 text-sm border border-red-200">
                  {apiError}
                </div>
              )}

              {aiReport && (
                <div className="mt-4 flex flex-col gap-4">
                  {/* レポート本文 */}
                  <div className="bg-white p-5 rounded-lg border border-purple-100 shadow-sm">
                    <div className="text-sm md:text-base text-gray-700 whitespace-pre-wrap leading-relaxed">
                      {aiReport}
                    </div>
                    
                    {/* 保存ボタン */}
                    <div className="mt-6 pt-4 border-t border-gray-100 flex justify-end">
                      <button 
                        onClick={handleSaveReport} 
                        disabled={isSavedDone}
                        className={`text-sm flex items-center gap-1.5 px-4 py-2 rounded-md transition-colors ${
                          isSavedDone 
                            ? 'bg-green-50 text-green-600 border border-green-200' 
                            : 'text-purple-600 hover:bg-purple-50 border border-transparent'
                        }`}
                      >
                        {isSavedDone ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                        {isSavedDone ? '保存しました' : 'このレポートとチャット履歴を保存'}
                      </button>
                    </div>
                  </div>

                  {/* チャット機能 (UI) */}
                  <div className="bg-white rounded-lg border border-purple-100 shadow-sm flex flex-col overflow-hidden h-[400px]">
                    <div className="bg-purple-50 p-3 border-b border-purple-100 flex items-center gap-2">
                      <MessageCircle className="w-4 h-4 text-purple-600" />
                      <span className="font-semibold text-sm text-purple-900">AIコンサルタントに質問する</span>
                    </div>
                    
                    {/* メッセージエリア */}
                    <div ref={chatScrollRef} className="flex-1 p-4 overflow-y-auto space-y-4 bg-gray-50/50">
                      {chatMessages.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-400 p-4 text-center">
                          <MessageCircle className="w-8 h-8 mb-2 opacity-50" />
                          <p className="text-sm">レポートの内容について、さらに深掘りしたいことを質問してみましょう。</p>
                          <p className="text-xs mt-2">例: 「目標売上を〇〇円にするには、退職率を何%まで下げるべき？」<br/>「再配を成功させるための具体的なステップを教えて」</p>
                        </div>
                      ) : (
                        chatMessages.map((msg, i) => (
                          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] p-3 rounded-xl text-sm whitespace-pre-wrap leading-relaxed ${
                              msg.role === 'user' 
                                ? 'bg-purple-600 text-white rounded-tr-none shadow-sm' 
                                : 'bg-white border border-gray-200 text-gray-800 rounded-tl-none shadow-sm'
                            }`}>
                              {msg.text}
                            </div>
                          </div>
                        ))
                      )}
                      {isChatting && (
                        <div className="flex justify-start">
                           <div className="bg-white border border-gray-200 p-3 rounded-xl rounded-tl-none shadow-sm flex items-center gap-2">
                             <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                             <span className="text-xs text-gray-500 font-medium">回答を生成中...</span>
                           </div>
                        </div>
                      )}
                    </div>

                    {/* 入力エリア */}
                    <div className="p-3 bg-white border-t border-gray-100 flex gap-2">
                      <input 
                        type="text" 
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            handleSendMessage();
                          }
                        }}
                        placeholder="質問を入力してください..."
                        className="flex-1 p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 transition-shadow"
                        disabled={isChatting}
                      />
                      <button 
                        onClick={handleSendMessage}
                        disabled={!chatInput.trim() || isChatting}
                        className="bg-purple-600 text-white p-2.5 rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[44px]"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
