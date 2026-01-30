
import React, { useState, useEffect, useRef } from 'react';
import { 
  Download, Activity, Settings, Database, Terminal, RefreshCw, Cpu, Monitor, Tag, Zap, ListOrdered, CircleX, CircleCheck, BarChart3, Clock, Lock, Unlock, Home, Globe, ShieldCheck, ChevronRight, CirclePlay, CircleArrowDown, CirclePause
} from 'lucide-react';
import { TestConfig, TestResult, ERROR_CODES, CommandType } from './types';
import { 
  build64HRequest, build61HRequest, build35HRequest, uint8ArrayToHex, scanAllPackets, DecodedPacket 
} from './utils/protocol';

interface ExtendedTestResult extends TestResult {
  configTimeout: number;
  configPower?: number;
  configMaxRecords?: number;
  epcList: string[];
}

interface LogEntry {
  timestamp: string;
  type: 'tx' | 'rx' | 'system' | 'error' | 'info' | 'tag';
  msg: string;
}

interface RawLogEntry {
  timestamp: string;
  data: string;
}

const App: React.FC = () => {
  const [isLocalFile, setIsLocalFile] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [config, setConfig] = useState<TestConfig>({
    commandType: '64H',
    totalCycles: 10,
    timeoutMs: 5000,
    intervalMs: 500,
    maxRecords: 10,
    id: 1, 
    channel: 0, 
    power: 33,
    baudRate: 38400,
    stopOnError: false,
  });
  const [results, setResults] = useState<ExtendedTestResult[]>([]);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [rawRxLogs, setRawRxLogs] = useState<RawLogEntry[]>([]);
  
  const [autoScrollLogs, setAutoScrollLogs] = useState(false);
  const [autoScrollRaw, setAutoScrollRaw] = useState(false);

  const [port, setPort] = useState<any>(null);
  const masterBufferRef = useRef<Uint8Array>(new Uint8Array(0));
  const isReadingRef = useRef<boolean>(false);
  const backgroundReaderRef = useRef<any>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const rawLogEndRef = useRef<HTMLDivElement>(null);

  const LAST_UPDATED = "2026-01-03 18:10 (台北標準時間)";

  const getFullTimestamp = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}.${ms}`;
  };

  useEffect(() => {
    console.log("App Module Loaded. Build Time:", LAST_UPDATED);
    if (window.location.protocol === 'file:') setIsLocalFile(true);
  }, []);

  useEffect(() => {
    if (autoScrollLogs && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScrollLogs]);

  useEffect(() => {
    if (autoScrollRaw && rawLogEndRef.current) {
      rawLogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [rawRxLogs, autoScrollRaw]);

  const addLog = (msg: string, type: 'tx' | 'rx' | 'system' | 'error' | 'info' | 'tag' = 'info') => {
    const timestamp = getFullTimestamp();
    setLogs(prev => [...prev, { timestamp, type, msg }].slice(-500));
  };

  const addRawRxLog = (data: Uint8Array) => {
    const timestamp = getFullTimestamp();
    const hex = uint8ArrayToHex(data);
    setRawRxLogs(prev => [...prev, { timestamp, data: hex }].slice(-200));
  };

  const startBackgroundRead = async (portObj: any) => {
    if (isReadingRef.current) return;
    isReadingRef.current = true;
    const reader = portObj.readable.getReader();
    backgroundReaderRef.current = reader;
    try {
      while (isReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          addRawRxLog(value);
          const next = new Uint8Array(masterBufferRef.current.length + value.length);
          next.set(masterBufferRef.current);
          next.set(value, masterBufferRef.current.length);
          masterBufferRef.current = next;
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error("Read error:", err);
    } finally {
      reader.releaseLock();
      isReadingRef.current = false;
    }
  };

  const connectSerial = async () => {
    const serial = (navigator as any).serial;
    if (!serial) {
      alert("瀏覽器不支援 Web Serial");
      return;
    }
    try {
      const selectedPort = await serial.requestPort();
      await selectedPort.open({ baudRate: config.baudRate });
      setPort(selectedPort);
      setIsConnected(true);
      addLog(`串口已連接`, 'system');
      startBackgroundRead(selectedPort);
    } catch (err: any) {
      addLog("連線失敗: " + err.message, 'error');
    }
  };

  const disconnectSerial = async () => {
    if (isTesting) stopRequestedRef.current = true;
    isReadingRef.current = false;
    if (backgroundReaderRef.current) await backgroundReaderRef.current.cancel();
    if (port) {
      await port.close();
      setPort(null); setIsConnected(false); setIsTesting(false);
      addLog("串口已關閉", 'system');
    }
  };

  const runSingleTest = async (cycle: number): Promise<ExtendedTestResult | null> => {
    if (!port || !port.writable) return null;
    masterBufferRef.current = new Uint8Array(0);
    
    let txBuffer: Uint8Array;
    switch(config.commandType) {
        case '61H': txBuffer = build61HRequest(config.id, config.channel); break;
        case '35H': txBuffer = build35HRequest(config.id); break;
        default: txBuffer = build64HRequest(config.id, config.channel, config.power, config.timeoutMs, config.maxRecords);
    }

    const writer = port.writable.getWriter();
    await writer.write(txBuffer);
    writer.releaseLock();
    
    addLog(`${config.commandType} TX: ${uint8ArrayToHex(txBuffer)}`, 'tx');
    const startTime = Date.now();
    const deadline = startTime + config.timeoutMs + 1500; // 稍微放寬等待緩衝
    
    let isFinished = false;
    let finalErrorCode = 'N/A';
    let epcList: string[] = [];
    let processedRaw = new Set<string>();

    while (Date.now() < deadline && !stopRequestedRef.current) {
      const packets = scanAllPackets(masterBufferRef.current, config.commandType);
      packets.forEach(p => {
        if (!processedRaw.has(p.raw)) {
          processedRaw.add(p.raw);
          if (p.epc) {
              addLog(`EPC: ${p.epc}`, 'tag');
              if (!epcList.includes(p.epc)) epcList.push(p.epc);
          }
          if (p.fwVersion) {
              addLog(`韌體版本: ${p.fwVersion}`, 'system');
          }
          
          if (config.commandType === '64H') {
              if (p.status === 0x01) { // 收到結束封包
                isFinished = true; finalErrorCode = p.errorCode;
              }
          } else if ((config.commandType === '61H' || config.commandType === '35H')) {
              isFinished = true; finalErrorCode = p.errorCode;
          }
        }
      });
      if (isFinished) break;
      await new Promise(r => setTimeout(r, 50));
    }

    const isSuccess = isFinished && (finalErrorCode === '0001' || finalErrorCode === '0000');
    const statusText: any = isSuccess ? 'Success' : (isFinished ? 'Failure' : 'Timeout');

    return {
      timestamp: new Date().toISOString(),
      cycle,
      status: statusText,
      errorCode: finalErrorCode,
      errorMsg: ERROR_CODES[finalErrorCode] || (statusText === 'Timeout' ? '逾時' : '異常'),
      rawTx: uint8ArrayToHex(txBuffer),
      rawRx: uint8ArrayToHex(masterBufferRef.current),
      recordsFound: epcList.length,
      configTimeout: config.timeoutMs,
      configPower: config.commandType === '64H' ? config.power : undefined,
      configMaxRecords: config.commandType === '64H' ? config.maxRecords : undefined,
      cmdType: config.commandType,
      epcList
    };
  };

  const handleSingleTestManual = async () => {
    if (!isConnected || isTesting) return;
    setIsTesting(true);
    stopRequestedRef.current = false;
    addLog(`手動單次測試 [${config.commandType}] (ID: ${config.id}, ANT: ${config.channel})`, 'system');
    setCurrentCycle(1);
    const res = await runSingleTest(1);
    if (res) {
      setResults(prev => [res, ...prev]);
    }
    setIsTesting(false);
  };

  const startTesting = async () => {
    if (!isConnected) return;
    setIsTesting(true);
    stopRequestedRef.current = false;
    setResults([]);
    setLogs([]);
    setRawRxLogs([]);
    addLog(`啟動壓力測試 [${config.commandType}] (ID: ${config.id}, ANT: ${config.channel})`, 'system');

    for (let i = 1; i <= config.totalCycles; i++) {
      if (stopRequestedRef.current) break;
      setCurrentCycle(i);
      const res = await runSingleTest(i);
      if (res) {
        setResults(prev => [res, ...prev]);
        if (config.stopOnError && res.status !== 'Success') break;
      }
      if (config.intervalMs > 0 && i < config.totalCycles) await new Promise(r => setTimeout(r, config.intervalMs));
    }
    setIsTesting(false);
  };

  const handleDownloadCSV = () => {
    const headers = ["輪次", "指令", "結果", "錯誤碼", "EPC筆數", "原始發送", "原始接收"];
    const csv = "\ufeff" + [headers, ...results.map(r => [r.cycle, r.cmdType, r.status, r.errorCode, r.recordsFound, r.rawTx, r.rawRx])].map(e => e.join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `RFID_Report_${config.commandType}_${Date.now()}.csv`;
    link.click();
  };

  const getThemeColor = () => {
      if (config.commandType === '64H') return 'indigo';
      if (config.commandType === '61H') return 'amber';
      return 'emerald';
  };

  if (isLocalFile) return null;

  const total = results.length;
  const successCount = results.filter(r => r.status === 'Success').length;
  const successRate = total > 0 ? (successCount / total * 100).toFixed(1) : '0';

  return (
    <div className={`p-4 md:p-8 bg-slate-50 min-h-screen text-slate-700 font-sans pb-24 theme-${getThemeColor()}`}>
      <header className="mb-8 flex flex-col xl:flex-row items-center justify-between gap-6 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
        <div className="flex items-center gap-5 shrink-0">
          <div className={`p-4 rounded-2xl shadow-xl transition-colors ${
              config.commandType === '64H' ? 'bg-indigo-600 shadow-indigo-100' : 
              config.commandType === '61H' ? 'bg-amber-500 shadow-amber-100' : 
              'bg-emerald-500 shadow-emerald-100'
          }`}>
            <Activity className="text-white w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-800 italic leading-none">RFID PROTOCOL TESTER</h1>
            <div className="flex gap-2 mt-2">
               <span className={`text-[10px] font-bold px-3 py-1 rounded-full ${isConnected ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                  {isConnected ? 'ONLINE' : 'OFFLINE'}
               </span>
               <span className="text-[10px] font-bold px-3 py-1 rounded-full bg-slate-100 text-slate-500">
                  {config.commandType} MODE
               </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-8 bg-slate-50 px-8 py-3 rounded-2xl border border-slate-100 mx-4 flex-1 justify-center max-w-sm">
           <div className="flex flex-col items-center">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">穩定性</span>
              <span className={`text-2xl font-black ${parseFloat(successRate) > 95 ? 'text-emerald-500' : 'text-rose-500'}`}>
                 {successRate}%
              </span>
           </div>
           <div className="w-px h-8 bg-slate-200"></div>
           <div className="flex flex-col items-center">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">成功率</span>
              <span className="text-sm font-black text-slate-600">
                 {successCount} / {total}
              </span>
           </div>
        </div>

        <div className="flex gap-2 shrink-0">
          {!isConnected ? (
            <button onClick={connectSerial} className="bg-slate-900 text-white px-8 py-3.5 rounded-2xl font-bold hover:bg-black transition-all">連線設備</button>
          ) : (
            <>
              <button onClick={disconnectSerial} className="bg-white text-rose-500 px-5 py-3.5 rounded-2xl font-bold border border-rose-100 hover:bg-rose-50 transition-all">斷開</button>
              
              <button 
                onClick={handleSingleTestManual} 
                disabled={isTesting}
                className="bg-white text-slate-900 border border-slate-200 px-5 py-3.5 rounded-2xl font-bold hover:bg-slate-50 transition-all flex flex-col items-center justify-center gap-0.5 disabled:opacity-50 min-w-[100px]"
              >
                <CirclePlay className="w-4 h-4" />
                <span className="text-[10px]">單次測試</span>
              </button>

              {total > 0 && (
                <button 
                  onClick={handleDownloadCSV}
                  className="bg-white text-slate-600 border border-slate-200 px-5 py-3.5 rounded-2xl font-bold hover:bg-slate-50 transition-all flex flex-col items-center justify-center gap-0.5 min-w-[100px]"
                >
                  <Download className="w-4 h-4" />
                  <span className="text-[10px]">下載 CSV</span>
                </button>
              )}
            </>
          )}
          <button 
            onClick={isTesting ? () => stopRequestedRef.current = true : startTesting} 
            disabled={!isConnected} 
            className={`px-8 py-3.5 rounded-2xl font-black transition-all shadow-lg flex flex-col items-center justify-center gap-0.5 min-w-[140px] ${
              isTesting ? 'bg-rose-500 text-white animate-pulse' : 
              config.commandType === '64H' ? 'bg-indigo-600 text-white hover:bg-indigo-700' :
              config.commandType === '61H' ? 'bg-amber-500 text-white hover:bg-amber-600' :
              'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            {isTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            <span className="text-[10px]">{isTesting ? '停止測試' : '開始壓力測試'}</span>
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        <div className="xl:col-span-3 space-y-6">
          <section className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-6">
            <div className="flex items-center justify-between border-b pb-4">
               <h3 className="text-xs font-black uppercase text-slate-400 tracking-widest flex items-center gap-2"><Settings className="w-4 h-4" /> 測試配置</h3>
               {isTesting && <div className="flex items-center gap-1.5"><span className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span><span className="text-[9px] font-black text-emerald-500">RUNNING</span></div>}
            </div>
            
            <div className="space-y-4">
               <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase block mb-2">測試指令類型</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['64H', '61H', '35H'] as CommandType[]).map(type => (
                        <button 
                            key={type}
                            onClick={() => setConfig({...config, commandType: type})}
                            className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                                config.commandType === type 
                                ? 'bg-slate-900 text-white border-slate-900' 
                                : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                            }`}
                        >
                            {type}
                        </button>
                    ))}
                  </div>
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                    <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">設備 ID (Byte 4)</label>
                    <input 
                      type="number" 
                      min="0" 
                      max="255" 
                      value={config.id} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        setConfig({...config, id: isNaN(val) ? 0 : val});
                      }} 
                      className="w-full bg-transparent font-black text-slate-700 outline-none" 
                    />
                  </div>
                  <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                    <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">天線通道 (Byte 5)</label>
                    <input 
                      type="number" 
                      min="0" 
                      max="255" 
                      value={config.channel} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        setConfig({...config, channel: isNaN(val) ? 0 : val});
                      }} 
                      className="w-full bg-transparent font-black text-slate-700 outline-none" 
                    />
                  </div>
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                    <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">壓力測試輪次</label>
                    <input type="number" min="1" value={config.totalCycles} onChange={e => setConfig({...config, totalCycles: Math.max(1, parseInt(e.target.value) || 1)})} className="w-full bg-transparent font-black text-slate-700 outline-none" />
                  </div>
                  <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                    <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">輪次間隔 (ms)</label>
                    <input type="number" min="0" value={config.intervalMs} onChange={e => setConfig({...config, intervalMs: Math.max(0, parseInt(e.target.value) || 0)})} className="w-full bg-transparent font-black text-slate-700 outline-none" />
                  </div>
               </div>

               <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100 space-y-3">
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                    <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">逾時等待 (Timeout ms)</label>
                    <input type="number" min="100" value={config.timeoutMs} onChange={e => setConfig({...config, timeoutMs: Math.max(100, parseInt(e.target.value) || 100)})} className="w-full bg-transparent font-black text-slate-700 outline-none" />
                  </div>

                  {config.commandType === '64H' && (
                    <div className="grid grid-cols-2 gap-3 animate-in slide-in-from-top-2">
                        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                            <label className="text-[9px] font-black text-slate-400 uppercase block">功率 (dBm)</label>
                            <input type="number" value={config.power} onChange={e => setConfig({...config, power: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-700 outline-none" />
                        </div>
                        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                            <label className="text-[9px] font-black text-slate-400 uppercase block">收資料筆數</label>
                            <input type="number" value={config.maxRecords} onChange={e => setConfig({...config, maxRecords: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-700 outline-none" />
                        </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 px-1">
                      <input type="checkbox" id="stopErr" checked={config.stopOnError} onChange={e => setConfig({...config, stopOnError: e.target.checked})} className="rounded" />
                      <label htmlFor="stopErr" className="text-[10px] font-bold text-slate-500 uppercase">出錯時停止</label>
                  </div>
               </div>
            </div>
          </section>

          <section className="bg-slate-900 p-6 rounded-[2rem] text-white/50 shadow-2xl space-y-2">
            <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-indigo-400" />
                <span className="text-[10px] font-black text-white/80 uppercase tracking-widest">系統參數</span>
            </div>
            <div className="text-[10px] space-y-1.5 font-mono">
                <div className="flex justify-between border-b border-white/5 pb-1"><span>波特率:</span> <span className="text-white">{config.baudRate} bps</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>通訊介面:</span> <span className="text-white">RS485/UART</span></div>
                <div className="flex justify-between"><span>當前輪次:</span> <span className="text-indigo-400 font-black">#{currentCycle.toString().padStart(3, '0')}</span></div>
            </div>
          </section>
        </div>

        <div className="xl:col-span-9 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-[2rem] shadow-sm overflow-hidden flex flex-col h-[400px] border border-slate-200">
              <div className="px-6 py-4 bg-slate-900 flex justify-between items-center">
                <span className="text-white text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Terminal className="w-3 h-3 text-indigo-400" /> 指令追蹤 Trace</span>
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setAutoScrollLogs(!autoScrollLogs)} 
                    className={`flex items-center gap-1.5 text-[9px] font-bold px-2 py-1 rounded-md transition-all ${autoScrollLogs ? 'bg-indigo-600/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}
                  >
                    {autoScrollLogs ? <CircleArrowDown className="w-3 h-3" /> : <CirclePause className="w-3 h-3" />}
                    {autoScrollLogs ? '自動捲動 ON' : '捲動鎖定'}
                  </button>
                  <button onClick={() => setLogs([])} className="text-[9px] text-slate-500 font-bold hover:text-white">CLEAR</button>
                </div>
              </div>
              <div className="p-6 overflow-y-auto flex-1 font-mono text-[10px] bg-slate-950 custom-scrollbar">
                {logs.map((log, i) => (
                  <div key={i} className={`py-1 border-l-2 pl-4 mb-2 flex flex-col ${
                      log.type === 'tx' ? "border-indigo-500 bg-indigo-500/5" : 
                      log.type === 'tag' ? "border-emerald-500 bg-emerald-500/5" : 
                      log.type === 'error' ? "border-rose-500 bg-rose-500/5" : "border-slate-800"
                  }`}>
                    <span className="text-[9px] text-slate-500 font-bold tracking-tight mb-0.5 opacity-60">[{log.timestamp}]</span>
                    <span className={`leading-relaxed ${
                      log.type === 'tx' ? "text-indigo-300 font-bold" : 
                      log.type === 'tag' ? "text-emerald-400" : 
                      log.type === 'error' ? "text-rose-400" : "text-slate-400"
                    }`}>
                      {log.type === 'tx' ? '>> ' : log.type === 'tag' ? '[TAG] ' : log.type === 'system' ? '[SYS] ' : ''}
                      {log.msg}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>

            <div className="bg-white rounded-[2rem] shadow-sm overflow-hidden flex flex-col h-[400px] border border-slate-200">
              <div className="px-6 py-4 bg-slate-900 flex justify-between items-center">
                <span className="text-white text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Monitor className="w-3 h-3 text-emerald-400" /> 原始數據 Raw RX</span>
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setAutoScrollRaw(!autoScrollRaw)} 
                    className={`flex items-center gap-1.5 text-[9px] font-bold px-2 py-1 rounded-md transition-all ${autoScrollRaw ? 'bg-emerald-600/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}
                  >
                    {autoScrollRaw ? <CircleArrowDown className="w-3 h-3" /> : <CirclePause className="w-3 h-3" />}
                    {autoScrollRaw ? '自動捲動 ON' : '捲動鎖定'}
                  </button>
                  <button onClick={() => setRawRxLogs([])} className="text-[9px] text-slate-500 font-bold hover:text-white">CLEAR</button>
                </div>
              </div>
              <div className="p-6 overflow-y-auto flex-1 font-mono text-[10px] bg-black text-emerald-500/80 custom-scrollbar leading-relaxed">
                {rawRxLogs.map((log, i) => (
                  <div key={i} className="mb-2 opacity-90 border-b border-emerald-900/30 pb-2">
                    <div className="text-emerald-600 font-black mb-1 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" />
                      <span>[{log.timestamp}]</span>
                    </div>
                    <div className="break-all tracking-wider text-emerald-500/90 font-medium bg-emerald-950/20 p-1.5 rounded-md">
                      {log.data}
                    </div>
                  </div>
                ))}
                <div ref={rawLogEndRef} />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-8 py-5 border-b bg-slate-50/50 flex items-center justify-between">
              <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                <Database className="w-4 h-4" /> 歷史測試記錄 ({results.length})
              </h3>
            </div>
            <div className="overflow-x-auto max-h-[400px] custom-scrollbar">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-white sticky top-0 font-black text-slate-400 uppercase border-b z-10">
                  <tr>
                    <th className="p-4 pl-8">輪次</th>
                    <th className="p-4">指令</th>
                    <th className="p-4">結果</th>
                    <th className="p-4">資料</th>
                    <th className="p-4">錯誤碼</th>
                    <th className="p-4 text-right pr-8">時間</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50/50 transition-colors group">
                      <td className="p-4 pl-8 font-black text-slate-400 italic">#{r.cycle.toString().padStart(3, '0')}</td>
                      <td className="p-4">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 font-bold text-slate-500">{r.cmdType}</span>
                      </td>
                      <td className="p-4">
                        <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase flex items-center gap-1.5 w-fit ${
                          r.status === 'Success' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                        }`}>
                          {r.status === 'Success' ? <CircleCheck className="w-3 h-3" /> : <CircleX className="w-3 h-3" />}
                          {r.status}
                        </span>
                      </td>
                      <td className="p-4 font-bold text-slate-600">
                          {r.recordsFound} Tags
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col">
                           <span className="font-mono text-slate-400 font-bold">{r.errorCode}</span>
                           <span className="text-[9px] text-slate-300 uppercase">{r.errorMsg}</span>
                        </div>
                      </td>
                      <td className="p-4 text-right pr-8 text-slate-400 font-bold">{new Date(r.timestamp).toLocaleTimeString([], { hour12: false })}</td>
                    </tr>
                  ))}
                  {results.length === 0 && (
                    <tr><td colSpan={6} className="p-20 text-center text-slate-200 font-black italic text-xl">NO DATA YET</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-200 px-8 py-3 flex items-center justify-between z-50">
        <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Build {LAST_UPDATED}</span>
        </div>
        <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
                <span className="text-[9px] font-black text-slate-300 uppercase leading-none">Status</span>
                <span className={`text-[11px] font-bold ${isConnected ? 'text-emerald-500' : 'text-slate-400'}`}>
                    {isConnected ? 'PORT READY' : 'PORT WAITING'}
                </span>
            </div>
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}} />
    </div>
  );
};

export default App;
