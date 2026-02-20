
import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Settings, Database, Terminal, RefreshCw, Cpu, Tag, Zap, Trash2, X, ChevronUp, ChevronDown, Link, Link2Off, FileUp, Pause, Play, Download
} from 'lucide-react';
import { TestConfig, TestResult, ERROR_CODES, CommandType } from './types';
import { 
  build64HRequest, build61HRequest, build35HRequest, build63HRequest, build70HRequest, uint8ArrayToHex, scanAllPackets, hexToAscii,
  buildF0HRequest, buildF1HRequest, buildF2HRequest
} from './utils/protocol';
import { initDB, saveResultToDB, getAllResultsFromDB, clearDB } from './utils/db';

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
  type: 'tx' | 'rx';
  data: string;
}

const App: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSingleTesting, setIsSingleTesting] = useState(false);
  const [activeTab, setActiveTab] = useState<'terminal' | 'history' | 'update'>('terminal');
  const [logView, setLogView] = useState<'trace' | 'raw'>('trace');
  const [isControlExpanded, setIsControlExpanded] = useState(true);
  const [isAdvConfigOpen, setIsAdvConfigOpen] = useState(false);
  const [isCmdMenuOpen, setIsCmdMenuOpen] = useState(false);
  
  const dbRef = useRef<IDBDatabase | null>(null);

  const [summaryStats, setSummaryStats] = useState({
    total: 0,
    success: 0,
    tagsFound: 0
  });

  const commandLabels: Record<CommandType, string> = {
    '64H': 'Read EPC Data Advance(64H)',
    '61H': 'Read EPC Data Auto Power(61H)',
    '35H': 'Read FW Version(35H)',
    '63H': 'Read User Memory Auto Power(63H)',
    '70H': 'Write Tag Data(70H)'
  };

  const shortCommandLabels: Record<CommandType, string> = {
    '64H': 'EPC (64H)',
    '61H': 'Auto (61H)',
    '35H': 'FW (35H)',
    '63H': 'User (63H)',
    '70H': 'Write (70H)'
  };

  const [config, setConfig] = useState<TestConfig>(() => {
    const saved = localStorage.getItem('rfid_tester_config');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { console.error("Parse config error", e); }
    }
    return {
      commandType: '64H', totalCycles: 10, timeoutMs: 3000, intervalMs: 100, maxRecords: 10,
      id: 1, channel: 0, power: 33, baudRate: 38400, stopOnError: false,
      userAddr: '0000', userLen: 4,
      writeAddr: '0002', writeLen: 6, writeData: 'FFFF00000000000000000000'
    };
  });
  
  const [results, setResults] = useState<ExtendedTestResult[]>([]);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [rawLogs, setRawLogs] = useState<RawLogEntry[]>([]);
  
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileVersion, setFileVersion] = useState<string>('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatePaused, setIsUpdatePaused] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateStatus, setUpdateStatus] = useState('');

  const [port, setPort] = useState<any>(null);
  const masterBufferRef = useRef<Uint8Array>(new Uint8Array(0));
  const isReadingRef = useRef<boolean>(false);
  const backgroundReaderRef = useRef<any>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const updatePausedRef = useRef<boolean>(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  
  const initialBaudRateRef = useRef<number>(config.baudRate);

  useEffect(() => {
    initDB().then(db => {
      dbRef.current = db;
    }).catch(err => {
      addLog("無法初始化資料庫: " + err.message, 'error');
    });
  }, []);

  useEffect(() => {
    updatePausedRef.current = isUpdatePaused;
  }, [isUpdatePaused]);

  useEffect(() => {
    if (autoScrollLogs && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, rawLogs, autoScrollLogs]);

  useEffect(() => {
    const onDisconnect = (event: any) => {
      if (port && event.port === port) {
        addLog("偵測到設備中斷 (Device Lost)", 'error');
        cleanupState();
      }
    };
    const serial = (navigator as any).serial;
    if (serial) serial.addEventListener('disconnect', onDisconnect);
    return () => { if (serial) serial.removeEventListener('disconnect', onDisconnect); };
  }, [port]);

  const cleanupState = () => {
    setIsConnected(false); setIsTesting(false); setIsSingleTesting(false);
    setIsUpdating(false); setIsUpdatePaused(false); setPort(null);
    isReadingRef.current = false; backgroundReaderRef.current = null;
  };

  const addLog = (msg: string, type: 'tx' | 'rx' | 'system' | 'error' | 'info' | 'tag' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { timestamp, type, msg }].slice(-300));
  };

  const addRawLog = (data: Uint8Array, type: 'tx' | 'rx') => {
    const timestamp = new Date().toLocaleTimeString();
    const hex = uint8ArrayToHex(data);
    setRawLogs(prev => [...prev, { timestamp, type, data: hex }].slice(-200));
  };

  const writeToSerial = async (data: Uint8Array, description: string) => {
    if (!port || !port.writable) return;
    try {
      const writer = port.writable.getWriter();
      await writer.write(data);
      writer.releaseLock();
      addLog(`[TX] ${description}: ${uint8ArrayToHex(data)}`, 'tx');
      addRawLog(data, 'tx');
    } catch (err: any) { addLog(`寫入失敗: ${err.message}`, 'error'); }
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
          addRawLog(value, 'rx');
          const next = new Uint8Array(masterBufferRef.current.length + value.length);
          next.set(masterBufferRef.current);
          next.set(value, masterBufferRef.current.length);
          masterBufferRef.current = next;
        }
      }
    } catch (err: any) { if (err.name === 'NetworkError' || err.message.includes('lost')) cleanupState(); } 
    finally { try { if (backgroundReaderRef.current === reader) reader.releaseLock(); } catch (e) {} isReadingRef.current = false; backgroundReaderRef.current = null; }
  };

  const connectSerial = async () => {
    const serial = (navigator as any).serial;
    if (!serial) { alert("瀏覽器不支援 Web Serial"); return; }
    try {
      const selectedPort = await serial.requestPort();
      await selectedPort.open({ baudRate: config.baudRate });
      setPort(selectedPort); setIsConnected(true);
      addLog(`串口已連接成功 (Baud: ${config.baudRate})`, 'system');
      startBackgroundRead(selectedPort);
    } catch (err: any) { addLog("連線失敗: " + err.message, 'error'); }
  };

  const disconnectSerial = async () => {
    if (isTesting || isUpdating || isSingleTesting) stopRequestedRef.current = true;
    isReadingRef.current = false;
    if (backgroundReaderRef.current) { try { await backgroundReaderRef.current.cancel(); } catch (e) {} }
    if (port) { try { await port.close(); addLog("串口已正常關閉", 'system'); } catch (e: any) { addLog(`關閉異常: ${e.message}`, 'error'); } finally { cleanupState(); } }
  };

  const handleSaveConfig = async () => {
    localStorage.setItem('rfid_tester_config', JSON.stringify(config));
    setIsAdvConfigOpen(false);
    if (isConnected && config.baudRate !== initialBaudRateRef.current) {
      await disconnectSerial();
      await connectSerial();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    if (file) {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer).slice(0, 32);
      const text = new TextDecoder().decode(data);
      const binIndex = text.indexOf('.bin');
      const ver = (binIndex !== -1 ? text.substring(0, binIndex) : text).replace(/\0/g, '').trim();
      setFileVersion(ver || '未知');
    }
  };

  const runFirmwareUpdate = async (isRestart = false) => {
    if (!isConnected || !selectedFile) return;
    if (isRestart) { stopRequestedRef.current = true; await new Promise(r => setTimeout(r, 200)); }
    setIsUpdating(true); setIsUpdatePaused(false); setUpdateProgress(0); stopRequestedRef.current = false;

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const fileData = new Uint8Array(arrayBuffer);
      const pageSize = 512;
      const totalP = Math.ceil(fileData.length / pageSize);

      await writeToSerial(buildF0HRequest(config.id), 'F0H');
      await new Promise(r => setTimeout(r, 1000));

      for (let i = 1; i <= totalP; i++) {
        while (updatePausedRef.current && !stopRequestedRef.current) { setUpdateStatus('暫停中...'); await new Promise(r => setTimeout(r, 100)); }
        if (stopRequestedRef.current || !isConnected) break;
        setUpdateStatus(`寫入封包 ${i}/${totalP}`);
        const chunk = new Uint8Array(pageSize).fill(0x00);
        chunk.set(fileData.slice((i - 1) * pageSize, i * pageSize));
        masterBufferRef.current = new Uint8Array(0);
        await writeToSerial(buildF1HRequest(config.id, i, chunk), `F1H Pkt:${i}`);
        
        let confirmed = false; let start = Date.now();
        while (Date.now() - start < 3000) {
          if (stopRequestedRef.current) break;
          const pkts = scanAllPackets(masterBufferRef.current, 'F1');
          if (pkts.find(p => p.cmd === 0xF1 && (p.currentPacketNum === i || p.currentPacketNum === i - 1) && p.errorCode === '0001')) { confirmed = true; break; }
          await new Promise(r => setTimeout(r, 20));
        }
        if (stopRequestedRef.current) break;
        if (!confirmed) throw new Error(`封包 ${i} 寫入逾時`);
        setUpdateProgress(Math.floor((i / totalP) * 100));
      }

      if (!stopRequestedRef.current) {
        setUpdateStatus('完成更新...');
        await writeToSerial(buildF2HRequest(config.id), 'F2H');
        setUpdateStatus('更新成功！');
        setTimeout(() => setIsUpdating(false), 3000);
      }
    } catch (err: any) { setUpdateStatus(`失敗: ${err.message}`); setIsUpdating(false); }
  };

  const runSingleTest = async (cycle: number): Promise<ExtendedTestResult | null> => {
    if (!port || !port.writable) return null;
    masterBufferRef.current = new Uint8Array(0);
    let txBuffer: Uint8Array;
    switch(config.commandType) {
        case '61H': txBuffer = build61HRequest(config.id, config.channel); break;
        case '63H': txBuffer = build63HRequest(config.id, config.channel, config.userAddr, config.userLen); break;
        case '35H': txBuffer = build35HRequest(config.id); break;
        case '70H': txBuffer = build70HRequest(config.id, config.channel, config.power, config.writeAddr, config.writeLen, config.writeData); break;
        default: txBuffer = build64HRequest(config.id, config.channel, config.power, config.timeoutMs, config.maxRecords);
    }
    
    await writeToSerial(txBuffer, config.commandType);
    const deadline = Date.now() + config.timeoutMs + 500; 
    let isFinished = false, finalErrorCode = 'N/A', epcList: string[] = [], processedRaw = new Set<string>(), userData = '', fwVersion = '';

    while (Date.now() < deadline && !stopRequestedRef.current && isConnected) {
      const packets = scanAllPackets(masterBufferRef.current, config.commandType);
      packets.forEach(p => {
        if (!processedRaw.has(p.raw)) {
          processedRaw.add(p.raw);
          addLog(`[RX] Raw: ${p.raw}`, 'rx');
          if (p.cmd === 0x35) {
            addLog(`[RX] 版本: ${p.fwVersion}`, 'rx');
            isFinished = true; finalErrorCode = p.errorCode; fwVersion = p.fwVersion || '';
          }
          else if (p.cmd === 0x70) {
            addLog(`[RX] 寫入結果: ${p.errorCode === '0001' || p.errorCode === '0000' ? '成功' : '失敗'}`, p.errorCode === '0001' || p.errorCode === '0000' ? 'info' : 'error');
            isFinished = true; finalErrorCode = p.errorCode;
          }
          else if (p.cmd === 0x61) {
            if (p.epc) {
              addLog(`[RX] 標籤: ${p.epc}`, 'tag');
              if (p.epc.replace(/\s/g, '').length > 0) addLog(`[RX] EPC (ASCII): ${hexToAscii(p.epc)}`, 'info');
              if (!epcList.includes(p.epc)) epcList.push(p.epc);
            }
            if (p.errorCode !== 'N/A') { isFinished = true; finalErrorCode = p.errorCode; }
          } else if (p.cmd === 0x63) {
            if (p.userData) {
              addLog(`[RX] User Data: ${p.userData}`, 'info');
              if (p.userData.replace(/\s/g, '').length > 0) addLog(`[RX] User Data (ASCII): ${hexToAscii(p.userData)}`, 'info');
              userData = p.userData;
            }
            if (p.errorCode !== 'N/A') { isFinished = true; finalErrorCode = p.errorCode; }
          } else if (p.cmd === 0x64) {
            if (p.status === 0x01) {
              addLog(`[RX] 結束: 找到 ${p.count} 筆`, 'rx');
              isFinished = true; finalErrorCode = p.errorCode;
            }
            else if (p.status === 0x00 && p.epc) {
              addLog(`[RX] 標籤: ${p.epc}`, 'tag');
              if (p.epc.replace(/\s/g, '').length > 0) addLog(`[RX] EPC (ASCII): ${hexToAscii(p.epc)}`, 'info');
              if (!epcList.includes(p.epc)) epcList.push(p.epc);
            }
          }
        }
      });
      if (isFinished) break;
      await new Promise(r => setTimeout(r, 50));
    }

    const isSuccess = isFinished && (finalErrorCode === '0001' || finalErrorCode === '0000');
    return {
      timestamp: new Date().toISOString(), cycle, status: isSuccess ? 'Success' : (isFinished ? 'Failure' : 'Timeout'),
      errorCode: finalErrorCode, errorMsg: ERROR_CODES[finalErrorCode] || '逾時',
      rawTx: uint8ArrayToHex(txBuffer), rawRx: uint8ArrayToHex(masterBufferRef.current),
      recordsFound: epcList.length, cmdType: config.commandType, epcList,
      configTimeout: config.timeoutMs, configPower: config.power, configMaxRecords: config.maxRecords,
      userData: userData || undefined, fwVersion: fwVersion || undefined
    };
  };

  const processTestResult = async (res: ExtendedTestResult) => {
    setResults(prev => [res, ...prev].slice(0, 1000));
    setSummaryStats(prev => ({
      total: prev.total + 1,
      success: prev.success + (res.status === 'Success' ? 1 : 0),
      tagsFound: prev.tagsFound + res.recordsFound
    }));
    if (dbRef.current) await saveResultToDB(dbRef.current, res);
  };

  const handleSingleTest = async () => {
    if (!isConnected || isTesting || isSingleTesting) return;
    setIsSingleTesting(true);
    const res = await runSingleTest(0);
    if (res) await processTestResult(res);
    setIsSingleTesting(false);
  };

  const startTesting = async () => {
    if (!isConnected) return;
    setIsTesting(true); stopRequestedRef.current = false;
    setResults([]); setLogs([]); setRawLogs([]);
    setSummaryStats({ total: 0, success: 0, tagsFound: 0 });
    if (dbRef.current) await clearDB(dbRef.current);

    addLog(`啟動壓力測試流程 (共 ${config.totalCycles} 次)`, 'system');
    for (let i = 1; i <= config.totalCycles; i++) {
      if (stopRequestedRef.current || !isConnected) break;
      setCurrentCycle(i);
      const res = await runSingleTest(i);
      if (res) {
        await processTestResult(res);
        if (config.stopOnError && res.status !== 'Success') break;
      }
      if (config.intervalMs > 0 && i < config.totalCycles) await new Promise(r => setTimeout(r, config.intervalMs));
    }
    setIsTesting(false);
  };

  const exportToCSV = async () => {
    if (!dbRef.current) return;
    const allData = await getAllResultsFromDB(dbRef.current);
    if (allData.length === 0) { alert("無可供導出的紀錄"); return; }
    const headers = ["Timestamp", "Cycle", "Command", "Status", "ErrorCode", "ErrorMsg", "TagsFound", "EPCs", "UserData", "FWVersion"];
    const rows = allData.map(r => [
      r.timestamp, r.cycle, r.cmdType, r.status, r.errorCode, r.errorMsg, r.recordsFound, 
      r.epcList ? r.epcList.join(';') : '', r.userData || '', r.fwVersion || ''
    ]);
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `RFID_Stress_Test_${new Date().getTime()}.csv`;
    link.click(); URL.revokeObjectURL(url);
  };

  const stabilityRate = summaryStats.total > 0 ? Math.round((summaryStats.success / summaryStats.total) * 100) : 0;

  return (
    <div className="bg-slate-50 min-h-screen text-slate-700 font-sans flex flex-col h-[100dvh] overflow-hidden">
      <header className="bg-white border-b border-slate-200 px-5 h-16 flex items-center justify-between shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg shadow-indigo-100 flex-shrink-0"><Activity className="text-white w-6 h-6" /></div>
          <div className="flex flex-col">
            <h1 className="text-sm font-black text-slate-800 leading-none tracking-tighter uppercase">RFID Reliability</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isConnected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                {isConnected ? '● 連線中' : '○ 未連線'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 hidden sm:flex justify-center px-4">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-1.5 flex items-center gap-4 min-w-[200px] justify-center">
             <div className="flex flex-col items-center">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">穩定度</span>
                <span className={`text-base font-black tabular-nums ${stabilityRate >= 95 ? 'text-emerald-500' : 'text-rose-500'}`}>{stabilityRate}%</span>
             </div>
             <div className="w-px h-6 bg-slate-200"></div>
             <div className="flex flex-col items-center">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">成功率</span>
                <span className="text-base font-black tabular-nums text-slate-600">{summaryStats.success}/{summaryStats.total}</span>
             </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
           {!isConnected ? (
             <button onClick={connectSerial} className="h-10 px-4 bg-slate-900 text-white rounded-lg font-black text-xs flex items-center gap-2 active:scale-95 transition-all"><Link className="w-4 h-4" /> 連線</button>
           ) : (
             <button onClick={disconnectSerial} className="h-10 px-4 bg-rose-50 text-rose-600 border border-rose-100 rounded-lg font-black text-xs flex items-center gap-2 active:scale-95 transition-all"><Link2Off className="w-4 h-4" /> 斷開</button>
           )}
           <button onClick={() => { initialBaudRateRef.current = config.baudRate; setIsAdvConfigOpen(true); }} className="w-10 h-10 flex items-center justify-center bg-white rounded-lg border border-slate-200 text-slate-600"><Settings className="w-5 h-5" /></button>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative overflow-hidden">
        {activeTab === 'terminal' && (
          <div className="flex-1 flex flex-col h-full">
             <div className="bg-slate-900 mx-3 mt-3 mb-[85px] rounded-xl flex-1 flex flex-col overflow-hidden border border-slate-800 shadow-2xl">
                <div className="flex items-center justify-between px-4 py-3 bg-slate-800/50 border-b border-slate-800">
                   <div className="flex gap-2">
                      <button onClick={() => setLogView('trace')} className={`text-xs font-black px-4 py-2 rounded-lg transition-colors ${logView === 'trace' ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}>追蹤日誌</button>
                      <button onClick={() => setLogView('raw')} className={`text-xs font-black px-4 py-2 rounded-lg transition-colors ${logView === 'raw' ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}>原始數據</button>
                   </div>
                   <button onClick={() => logView === 'trace' ? setLogs([]) : setRawLogs([])} className="p-2 text-slate-500 hover:text-white transition-colors"><Trash2 className="w-5 h-5" /></button>
                </div>
                <div className="flex-1 p-4 font-mono text-sm overflow-y-auto custom-scrollbar leading-relaxed bg-[#0a0f18]">
                   {logView === 'trace' ? (
                     logs.map((l, i) => (
                       <div key={i} className="mb-1 flex gap-2">
                          <span className="text-white/20 shrink-0 text-xs">{l.timestamp}</span>
                          <span className={`${l.type === 'tx' ? 'text-indigo-400' : l.type === 'rx' ? 'text-emerald-400' : l.type === 'tag' ? 'text-amber-400 font-bold' : l.type === 'error' ? 'text-rose-400' : 'text-slate-400'} break-all`}>{l.msg}</span>
                       </div>
                     ))
                   ) : (
                     rawLogs.map((l, i) => (
                        <div key={i} className="mb-2 border-l-2 border-slate-800 pl-3">
                           <div className="flex items-center mb-1"><span className="text-white/20 text-[10px] mr-2">{l.timestamp}</span><span className={`px-2 rounded text-[9px] font-black ${l.type === 'tx' ? 'bg-indigo-900 text-indigo-400' : 'bg-emerald-900 text-emerald-400'}`}>{l.type === 'tx' ? 'TX' : 'RX'}</span></div>
                           <span className="text-slate-300 break-all text-xs tracking-widest">{l.data}</span>
                        </div>
                     ))
                   )}
                   <div ref={logEndRef} />
                </div>
             </div>

             <div className={`absolute bottom-0 inset-x-0 bg-white border-t border-slate-200 transition-all duration-300 z-40 ${isControlExpanded ? 'h-[360px]' : 'h-20'}`}>
                <button onClick={() => setIsControlExpanded(!isControlExpanded)} className="absolute -top-4 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded-full p-1 shadow-md z-50 transition-colors"><ChevronUp className={`w-5 h-5 text-slate-400 transition-transform ${isControlExpanded ? 'rotate-180' : ''}`} /></button>
                <div className="p-4 flex flex-col h-full">
                   <div className="flex items-center gap-3 mb-4 shrink-0 overflow-visible">
                      <div className="relative shrink-0 flex-1 sm:flex-initial">
                         <button onClick={(e) => { e.stopPropagation(); setIsCmdMenuOpen(!isCmdMenuOpen); }} className="flex items-center justify-between gap-2 px-4 h-11 bg-slate-900 text-white rounded-lg font-black text-xs shadow-md w-full">
                           <span className="truncate max-w-[120px] sm:max-w-none">
                             <span className="sm:hidden">{shortCommandLabels[config.commandType]}</span>
                             <span className="hidden sm:inline">{commandLabels[config.commandType]}</span>
                           </span>
                           <ChevronDown className="w-3 h-3 shrink-0" />
                         </button>
                         {isCmdMenuOpen && (
                           <div className="absolute bottom-full left-0 mb-3 w-[280px] bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] overflow-hidden">
                             {(['64H', '61H', '63H', '70H', '35H'] as CommandType[]).map(t => (
                               <button key={t} onClick={() => { setConfig({...config, commandType: t}); setIsCmdMenuOpen(false); }} className="w-full py-4 px-5 text-xs font-black text-left hover:bg-slate-50 border-b border-slate-50 last:border-0">{commandLabels[t]}</button>
                             ))}
                           </div>
                         )}
                      </div>
                      <div className="flex shrink-0 justify-end gap-2">
                         <button onClick={handleSingleTest} disabled={!isConnected || isTesting || isSingleTesting} className="h-11 px-3 sm:px-4 rounded-lg font-black text-xs flex items-center gap-2 bg-slate-100 text-slate-700 hover:bg-slate-200 active:scale-95 transition-all disabled:opacity-50">
                           <Play className="w-4 h-4" /> <span>單次</span>
                         </button>
                         <button onClick={isTesting ? () => stopRequestedRef.current = true : startTesting} disabled={!isConnected || isSingleTesting} className={`h-11 px-4 sm:px-6 rounded-lg font-black text-xs flex items-center gap-2 shadow-lg transition-all ${isTesting ? 'bg-rose-500 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 disabled:bg-slate-100'}`}>
                           {isTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} 
                           <span>
                             {isTesting ? (
                               <><span className="hidden sm:inline">停止測試</span><span className="sm:hidden">停止</span></>
                             ) : (
                               <><span className="hidden sm:inline">開始壓力測試</span><span className="sm:hidden text-sm">壓測</span></>
                             )}
                           </span>
                         </button>
                      </div>
                   </div>
                   <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 flex-1 overflow-y-auto pb-2 custom-scrollbar">
                      {[
                        { label: '總測試次數', key: 'totalCycles', type: 'number' },
                        { label: '回應逾時 (ms)', key: 'timeoutMs', type: 'number' },
                        { label: '標籤上限', key: 'maxRecords', type: 'number' },
                        { label: '射頻功率 (dbm)', key: 'power', type: 'number' }
                      ].map(item => (
                        <div key={item.key} className="bg-slate-50 p-3 rounded-lg border border-slate-100 flex flex-col">
                           <label className="text-[10px] font-black text-slate-400 uppercase mb-1">{item.label}</label>
                           <input type="number" value={(config as any)[item.key]} onChange={e => setConfig({...config, [item.key]: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm" />
                        </div>
                      ))}
                      
                      {/* 動態顯示 63H 指令專屬欄位 */}
                      {config.commandType === '63H' && (
                        <>
                           <div className="bg-indigo-50/50 p-3 rounded-lg border border-indigo-100 flex flex-col animate-in fade-in slide-in-from-top-2 duration-300">
                              <label className="text-[10px] font-black text-indigo-400 uppercase mb-1">起始位址 (Hex)</label>
                              <input 
                                type="text" 
                                value={config.userAddr} 
                                onChange={e => setConfig({...config, userAddr: e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').substring(0,4)})} 
                                className="w-full bg-transparent font-black text-indigo-600 outline-none text-sm" 
                                placeholder="0000"
                              />
                           </div>
                           <div className="bg-indigo-50/50 p-3 rounded-lg border border-indigo-100 flex flex-col animate-in fade-in slide-in-from-top-2 duration-400">
                              <label className="text-[10px] font-black text-indigo-400 uppercase mb-1">讀取長度 (Word)</label>
                              <input 
                                type="number" 
                                value={config.userLen} 
                                onChange={e => setConfig({...config, userLen: Math.max(1, parseInt(e.target.value) || 1)})} 
                                className="w-full bg-transparent font-black text-indigo-600 outline-none text-sm" 
                              />
                           </div>
                        </>
                      )}

                      {/* 動態顯示 70H 指令專屬欄位 */}
                      {config.commandType === '70H' && (
                        <>
                           <div className="bg-emerald-50/50 p-3 rounded-lg border border-emerald-100 flex flex-col animate-in fade-in slide-in-from-top-2 duration-300">
                              <label className="text-[10px] font-black text-emerald-400 uppercase mb-1">寫入位址 (Hex)</label>
                              <input 
                                type="text" 
                                value={config.writeAddr} 
                                onChange={e => setConfig({...config, writeAddr: e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').substring(0,4)})} 
                                className="w-full bg-transparent font-black text-emerald-600 outline-none text-sm" 
                                placeholder="0002"
                              />
                           </div>
                           <div className="bg-emerald-50/50 p-3 rounded-lg border border-emerald-100 flex flex-col animate-in fade-in slide-in-from-top-2 duration-400">
                              <label className="text-[10px] font-black text-emerald-400 uppercase mb-1">寫入長度 (Word)</label>
                              <input 
                                type="number" 
                                value={config.writeLen} 
                                onChange={e => setConfig({...config, writeLen: Math.max(1, Math.min(6, parseInt(e.target.value) || 1))})} 
                                className="w-full bg-transparent font-black text-emerald-600 outline-none text-sm" 
                              />
                           </div>
                           <div className="col-span-2 bg-emerald-50/50 p-3 rounded-lg border border-emerald-100 flex flex-col animate-in fade-in slide-in-from-top-2 duration-500">
                              <label className="text-[10px] font-black text-emerald-400 uppercase mb-1">寫入資料 (Hex)</label>
                              <input 
                                type="text" 
                                value={config.writeData} 
                                onChange={e => {
                                  const val = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '');
                                  setConfig({...config, writeData: val});
                                }} 
                                className="w-full bg-transparent font-black text-emerald-600 outline-none text-sm" 
                                placeholder="FFFF..."
                              />
                              <div className="text-[9px] text-emerald-400 mt-1 font-bold">目前長度: {config.writeData.length / 2} Byte (需為 {config.writeLen * 2} Byte)</div>
                           </div>
                        </>
                      )}
                   </div>
                </div>
             </div>
          </div>
        )}

        {activeTab === 'update' && (
          <div className="flex-1 p-6 flex flex-col items-center justify-center">
             <div className="w-full max-w-md bg-white p-8 rounded-3xl border border-slate-200 shadow-xl">
                <h3 className="text-lg font-black mb-6 flex items-center gap-3 uppercase tracking-widest"><Cpu className="text-indigo-600 w-5 h-5" /> 韌體更新</h3>
                <input type="file" accept=".bin" onChange={handleFileChange} className="hidden" id="bin-file" disabled={isUpdating} />
                <label htmlFor="bin-file" className={`block border-2 border-dashed p-10 rounded-2xl text-center transition-all ${selectedFile ? 'border-indigo-100 bg-indigo-50/20' : 'border-slate-100 hover:border-indigo-200'} cursor-pointer relative`}>
                   <FileUp className={`w-10 h-10 mx-auto mb-3 ${selectedFile ? 'text-indigo-500' : 'text-slate-300'}`} />
                   <span className="text-sm font-bold text-slate-600 block truncate">{selectedFile ? selectedFile.name : '選擇 .bin 檔案'}</span>
                   {fileVersion && <span className="mt-2 text-[10px] font-black bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full inline-block">版本: {fileVersion}</span>}
                </label>
                {(isUpdating || updateProgress > 0) && (
                  <div className="mt-6">
                     <div className="flex justify-between text-[10px] font-black mb-2 text-slate-400 uppercase tracking-widest"><span>{updateStatus}</span><span>{updateProgress}%</span></div>
                     <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{width:`${updateProgress}%`}}></div></div>
                  </div>
                )}
                <div className="flex gap-3 mt-8">
                  <button onClick={() => runFirmwareUpdate(isUpdatePaused)} disabled={!isConnected || !selectedFile || (isUpdating && !isUpdatePaused)} className="flex-1 h-12 rounded-xl bg-slate-900 text-white font-black text-sm active:scale-95 transition-all disabled:opacity-50">開始升級</button>
                  {isUpdating && <button onClick={() => setIsUpdatePaused(!isUpdatePaused)} className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">{isUpdatePaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}</button>}
                </div>
             </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex-1 p-4 overflow-y-auto space-y-3 custom-scrollbar bg-slate-50">
             <div className="flex justify-between items-center mb-2 px-2">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">歷史紀錄</span>
                  <span className="text-xs font-black text-slate-800">顯示最新 {results.length} / 總計 {summaryStats.total} 筆數據</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={exportToCSV} className="text-xs font-black text-indigo-600 flex items-center gap-1.5 px-3 py-2 bg-white border border-indigo-100 rounded-lg shadow-sm hover:bg-indigo-50 active:scale-95 transition-all"><Download className="w-3.5 h-3.5" /> 導出完整報表</button>
                  <button onClick={async () => { setResults([]); setSummaryStats({total:0,success:0,tagsFound:0}); if(dbRef.current) await clearDB(dbRef.current); }} className="text-xs font-black text-rose-500 px-3 py-2 hover:bg-rose-50 rounded-lg">全部清除</button>
                </div>
             </div>
             {results.length === 0 && (
               <div className="h-60 flex flex-col items-center justify-center text-slate-300">
                  <Database className="w-10 h-10 mb-2 opacity-10" />
                  <span className="text-xs font-bold uppercase tracking-widest opacity-50">尚無測試數據</span>
               </div>
             )}
             {results.map((r, i) => (
               <div key={i} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col hover:shadow-md transition-all group gap-3">
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-4">
                       <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-black text-xs ${r.status === 'Success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>#{r.cycle}</div>
                       <div>
                          <div className="text-xs font-black text-slate-800 uppercase tracking-tight">{commandLabels[r.cmdType]}</div>
                          <div className="text-[10px] text-slate-400 font-bold mt-0.5 tracking-tight">偵測標籤: {r.recordsFound} 筆</div>
                       </div>
                    </div>
                    <div className="text-right">
                       <div className={`text-[10px] font-black uppercase tracking-widest ${r.status === 'Success' ? 'text-emerald-500' : 'text-rose-500'}`}>{r.status === 'Success' ? '成功' : r.status === 'Failure' ? '失敗' : '逾時'}</div>
                       <div className="text-[10px] text-slate-300 font-mono mt-0.5">{r.errorCode}</div>
                    </div>
                  </div>
                  
                  {/* 顯示資料預覽區塊 */}
                  <div className="flex flex-wrap gap-2">
                    {r.cmdType === '63H' && r.userData && (
                      <div className="text-[10px] text-slate-500 font-mono break-all bg-slate-50 px-2 py-1 rounded border border-slate-100 flex items-center gap-1 max-w-full">
                        <Database className="w-3 h-3 shrink-0" /> <span className="truncate">Data: {r.userData}</span>
                      </div>
                    )}
                    {(r.cmdType === '64H' || r.cmdType === '61H') && r.epcList && r.epcList.length > 0 && (
                      <div className="text-[10px] text-indigo-500 font-mono break-all bg-indigo-50 px-2 py-1 rounded border border-indigo-100 flex items-center gap-1 max-w-full">
                        <Tag className="w-3 h-3 shrink-0" /> <span className="truncate">EPC: {r.epcList[0]}</span> {r.epcList.length > 1 && <span className="shrink-0 text-[8px] font-black bg-indigo-100 px-1 rounded">+{r.epcList.length - 1}</span>}
                      </div>
                    )}
                    {r.cmdType === '35H' && r.fwVersion && (
                      <div className="text-[10px] text-purple-500 font-mono break-all bg-purple-50 px-2 py-1 rounded border border-purple-100 flex items-center gap-1 max-w-full">
                        <Cpu className="w-3 h-3 shrink-0" /> <span className="truncate">FW: {r.fwVersion}</span>
                      </div>
                    )}
                  </div>
               </div>
             ))}
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 h-16 flex items-center justify-center shrink-0 z-50">
          <div className="flex w-full max-lg gap-2 p-1.5 bg-slate-100 rounded-xl mx-4 shadow-inner">
            <button onClick={() => setActiveTab('terminal')} className={`flex-1 py-2 rounded-lg text-xs font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'terminal' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Terminal className="w-4 h-4" /> 終端機</button>
            <button onClick={() => setActiveTab('update')} className={`flex-1 py-2 rounded-lg text-xs font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'update' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Cpu className="w-4 h-4" /> 韌體更新</button>
            <button onClick={() => setActiveTab('history')} className={`flex-1 py-2 rounded-lg text-xs font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'history' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Database className="w-4 h-4" /> 歷史紀錄</button>
          </div>
      </footer>

      {/* Advanced Config Modal */}
      <div className={`fixed inset-0 z-[100] transition-all duration-300 ${isAdvConfigOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>
         <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setIsAdvConfigOpen(false)}></div>
         <div className={`absolute bottom-0 inset-x-0 bg-white rounded-t-[32px] p-8 shadow-2xl transition-transform duration-500 transform ${isAdvConfigOpen ? 'translate-y-0' : 'translate-y-full'}`}>
            <div className="w-12 h-1 bg-slate-200 rounded-full mx-auto mb-6"></div>
            <h3 className="font-black text-slate-800 mb-6 flex justify-between items-center uppercase tracking-widest text-sm">進階參數設定 <button onClick={() => setIsAdvConfigOpen(false)}><X className="w-5 h-5 text-slate-400" /></button></h3>
            <div className="space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100"><label className="text-[10px] font-black text-slate-400 block mb-1 uppercase">波特率</label>
                    <select value={config.baudRate} onChange={e => setConfig({...config, baudRate: parseInt(e.target.value)})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm h-8 cursor-pointer">{[9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b} bps</option>)}</select>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100"><label className="text-[10px] font-black text-slate-400 block mb-1 uppercase">設備站號</label>
                    <input type="number" min="0" max="15" value={config.id} onChange={e => setConfig({...config, id: Math.max(0, Math.min(15, parseInt(e.target.value) || 0))})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm h-8" />
                  </div>
               </div>
               
               <div className="bg-slate-50 p-3 rounded-xl border border-slate-100"><label className="text-[10px] font-black text-slate-400 block mb-1 uppercase">測試間隔 (ms)</label>
                  <input type="number" value={config.intervalMs} onChange={e => setConfig({...config, intervalMs: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm h-8" />
               </div>
               <div className="flex items-center gap-3 px-1 py-2 cursor-pointer" onClick={() => setConfig({...config, stopOnError: !config.stopOnError})}>
                  <input type="checkbox" checked={config.stopOnError} readOnly className="w-5 h-5 rounded accent-indigo-600" /><span className="text-xs font-bold text-slate-600">偵測到異常回應時自動中止流程</span>
               </div>
            </div>
            <button onClick={handleSaveConfig} className="w-full h-14 bg-slate-900 text-white font-black rounded-xl mt-6 uppercase tracking-widest text-xs active:scale-95 transition-all">儲存參數</button>
         </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar { width: 3px; } .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 10px; }`}} />
    </div>
  );
};

export default App;
