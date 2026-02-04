
import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, Settings, Database, Terminal, RefreshCw, Cpu, Tag, Zap, CirclePlay, Trash2, X, ChevronUp, ChevronDown, Link, Link2Off, FileUp, CheckCircle2, AlertTriangle, Pause, Play
} from 'lucide-react';
import { TestConfig, TestResult, ERROR_CODES, CommandType } from './types';
import { 
  build64HRequest, build61HRequest, build35HRequest, uint8ArrayToHex, scanAllPackets, DecodedPacket,
  buildF0HRequest, buildF1HRequest, buildF2HRequest
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
  
  // 從 localStorage 初始化設定，若無則使用預設值
  const [config, setConfig] = useState<TestConfig>(() => {
    const saved = localStorage.getItem('rfid_tester_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved config", e);
      }
    }
    return {
      commandType: '64H',
      totalCycles: 10,
      timeoutMs: 3000,
      intervalMs: 100, 
      maxRecords: 10,
      id: 1, 
      channel: 0, 
      power: 33,
      baudRate: 38400,
      stopOnError: false,
    };
  });
  
  const [results, setResults] = useState<ExtendedTestResult[]>([]);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [rawLogs, setRawLogs] = useState<RawLogEntry[]>([]);
  
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);

  // Update States
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
  
  // 用於偵測波特率是否變動
  const initialBaudRateRef = useRef<number>(config.baudRate);

  useEffect(() => {
    updatePausedRef.current = isUpdatePaused;
  }, [isUpdatePaused]);

  const getFullTimestamp = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  };

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
    if (serial) {
      serial.addEventListener('disconnect', onDisconnect);
    }
    return () => {
      if (serial) {
        serial.removeEventListener('disconnect', onDisconnect);
      }
    };
  }, [port]);

  const cleanupState = () => {
    setIsConnected(false);
    setIsTesting(false);
    setIsSingleTesting(false);
    setIsUpdating(false);
    setIsUpdatePaused(false);
    setPort(null);
    isReadingRef.current = false;
    backgroundReaderRef.current = null;
  };

  const addLog = (msg: string, type: 'tx' | 'rx' | 'system' | 'error' | 'info' | 'tag' = 'info') => {
    const timestamp = getFullTimestamp();
    setLogs(prev => [...prev, { timestamp, type, msg }].slice(-300));
  };

  const addRawLog = (data: Uint8Array, type: 'tx' | 'rx') => {
    const timestamp = getFullTimestamp();
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
    } catch (err: any) {
      addLog(`寫入失敗: ${err.message}`, 'error');
    }
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
    } catch (err: any) {
      if (err.name === 'NetworkError' || err.message.includes('lost')) cleanupState();
    } finally {
      try { if (backgroundReaderRef.current === reader) reader.releaseLock(); } catch (e) {}
      isReadingRef.current = false;
      backgroundReaderRef.current = null;
    }
  };

  const connectSerial = async () => {
    const serial = (navigator as any).serial;
    if (!serial) { alert("瀏覽器不支援 Web Serial"); return; }
    try {
      const selectedPort = await serial.requestPort();
      await selectedPort.open({ baudRate: config.baudRate });
      setPort(selectedPort);
      setIsConnected(true);
      addLog(`串口已連接成功 (Baud: ${config.baudRate})`, 'system');
      startBackgroundRead(selectedPort);
    } catch (err: any) { addLog("連線失敗: " + err.message, 'error'); }
  };

  const disconnectSerial = async () => {
    if (isTesting || isUpdating || isSingleTesting) stopRequestedRef.current = true;
    isReadingRef.current = false;
    if (backgroundReaderRef.current) {
      try { await backgroundReaderRef.current.cancel(); } catch (e) {}
    }
    if (port) {
      try { await port.close(); addLog("串口已正常關閉", 'system'); } 
      catch (e: any) { addLog(`關閉異常: ${e.message}`, 'error'); } 
      finally { cleanupState(); }
    }
  };

  // 儲存設定並處理自動重連邏輯
  const handleSaveConfig = async () => {
    const baudChanged = config.baudRate !== initialBaudRateRef.current;
    
    // 持久化到本地快取
    localStorage.setItem('rfid_tester_config', JSON.stringify(config));
    
    setIsAdvConfigOpen(false);
    
    if (isConnected && baudChanged) {
      addLog(`偵測到波特率變更 (${initialBaudRateRef.current} -> ${config.baudRate})，正在執行自動重連...`, 'system');
      await disconnectSerial();
      // 在同一個使用者點擊事件鏈中觸發重連
      await connectSerial();
    } else if (!isConnected) {
      addLog(`通訊參數已儲存，將於下次連線時生效`, 'info');
    }
  };

  const extractVersionFromFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer).slice(0, 32);
    const text = new TextDecoder().decode(data);
    const binIndex = text.indexOf('.bin');
    let finalVersion = '';
    if (binIndex !== -1) {
      finalVersion = text.substring(0, binIndex);
    } else {
      finalVersion = text;
    }
    finalVersion = finalVersion.replace(/\0/g, '').trim();
    setFileVersion(finalVersion || '格式錯誤');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    if (file) {
      extractVersionFromFile(file);
    } else {
      setFileVersion('');
    }
  };

  const runFirmwareUpdate = async (isRestart = false) => {
    if (!isConnected || !selectedFile) return;
    
    if (isRestart) {
      stopRequestedRef.current = true;
      await new Promise(r => setTimeout(r, 200));
    }

    setIsUpdating(true);
    setIsUpdatePaused(false);
    setUpdateStatus('啟動韌體更新流程...');
    setUpdateProgress(0);
    stopRequestedRef.current = false;

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const fileData = new Uint8Array(arrayBuffer);
      const pageSize = 512;
      const totalP = Math.ceil(fileData.length / pageSize);

      await writeToSerial(buildF0HRequest(config.id), 'F0H');
      await new Promise(r => setTimeout(r, 1000));

      for (let i = 1; i <= totalP; i++) {
        while (updatePausedRef.current && !stopRequestedRef.current) {
          setUpdateStatus('韌體更新已暫停');
          await new Promise(r => setTimeout(r, 100));
        }
        if (stopRequestedRef.current || !isConnected) break;
        
        setUpdateStatus(`正在傳輸封包 ${i}/${totalP}`);
        const chunk = new Uint8Array(pageSize).fill(0x00);
        chunk.set(fileData.slice((i - 1) * pageSize, i * pageSize));
        
        masterBufferRef.current = new Uint8Array(0);
        await writeToSerial(buildF1HRequest(config.id, i, chunk), `F1H Pkt:${i}`);
        
        let confirmed = false;
        let start = Date.now();
        while (Date.now() - start < 3000) {
          if (stopRequestedRef.current) break;
          const pkts = scanAllPackets(masterBufferRef.current, 'F1');
          const ack = pkts.find(p => p.cmd === 0xF1 && (p.currentPacketNum === i || p.currentPacketNum === i - 1));
          if (ack && ack.errorCode === '0001') { 
            confirmed = true; 
            addLog(`[RX] F1H 封包 ${i} 寫入確認成功`, 'rx');
            break; 
          }
          await new Promise(r => setTimeout(r, 20));
        }
        if (stopRequestedRef.current) break;
        if (!confirmed) throw new Error(`封包 ${i} 寫入逾時`);
        setUpdateProgress(Math.floor((i / totalP) * 100));
      }

      if (!stopRequestedRef.current) {
        setUpdateStatus('發送結束指令 (F2)...');
        masterBufferRef.current = new Uint8Array(0);
        await writeToSerial(buildF2HRequest(config.id), 'F2H');
        
        let f2Confirmed = false;
        let f2Start = Date.now();
        while (Date.now() - f2Start < 3000) {
          const pkts = scanAllPackets(masterBufferRef.current, 'F2');
          const ack = pkts.find(p => p.cmd === 0xF2);
          if (ack) {
            if (ack.errorCode === '0001') {
              f2Confirmed = true;
              addLog(`[RX] F2H 更新完成確認成功`, 'rx');
              break;
            } else {
              addLog(`[RX] F2H 更新失敗: ${ERROR_CODES[ack.errorCode] || ack.errorCode}`, 'error');
              throw new Error(`結束指令失敗 (F2): ${ERROR_CODES[ack.errorCode] || ack.errorCode}`);
            }
          }
          await new Promise(r => setTimeout(r, 50));
        }
        if (!f2Confirmed) throw new Error('結束指令 (F2) 未獲應答');

        setUpdateStatus('更新成功，等待重啟 (2s)...');
        await new Promise(r => setTimeout(r, 2000));

        let verifiedVersion = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (stopRequestedRef.current) break;
          setUpdateStatus(`驗證新版號 (嘗試 ${attempt}/3)...`);
          masterBufferRef.current = new Uint8Array(0);
          await writeToSerial(build35HRequest(config.id), '35H (驗證)');
          
          let waitStart = Date.now();
          while (Date.now() - waitStart < 1000) {
            const pkts = scanAllPackets(masterBufferRef.current, '35H');
            const ack = pkts.find(p => p.cmd === 0x35);
            if (ack && ack.fwVersion) {
              verifiedVersion = ack.fwVersion.trim();
              addLog(`[RX] 35H 驗證成功: 版本 ${verifiedVersion}`, 'rx');
              break;
            }
            await new Promise(r => setTimeout(r, 50));
          }
          if (verifiedVersion) break;
        }

        if (!verifiedVersion) {
          throw new Error('讀取新版號失敗 (重試逾時)');
        }

        addLog(`設備重啟完成，目前版號: ${verifiedVersion}`, 'info');

        if (fileVersion) {
          const cleanFile = fileVersion.toUpperCase().replace(/^V/, '');
          const cleanDevice = verifiedVersion.toUpperCase().replace(/^V/, '');
          if (cleanFile !== cleanDevice) {
            throw new Error(`版號比對失敗！預期: ${fileVersion}, 實際: ${verifiedVersion}`);
          }
        }

        setUpdateStatus(`更新成功！版號: ${verifiedVersion}`);
        setTimeout(() => {
          setIsUpdating(false);
          setUpdateProgress(0);
        }, 3000);
      } else {
        setUpdateStatus('更新操作已中止');
      }
    } catch (err: any) {
      setUpdateStatus(`異常失敗: ${err.message}`);
      addLog(`更新過程異常: ${err.message}`, 'error');
      setIsUpdating(false);
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
    
    await writeToSerial(txBuffer, config.commandType);
    const startTime = Date.now();
    const deadline = startTime + config.timeoutMs + 500; 
    let isFinished = false;
    let finalErrorCode = 'N/A';
    let epcList: string[] = [];
    let processedRaw = new Set<string>();

    while (Date.now() < deadline && !stopRequestedRef.current && isConnected) {
      const packets = scanAllPackets(masterBufferRef.current, config.commandType);
      packets.forEach(p => {
        if (!processedRaw.has(p.raw)) {
          processedRaw.add(p.raw);

          // --- TRACE 視窗 RX 語意化回顯邏輯 ---
          if (p.cmd === 0x35) {
            addLog(`[RX] 35H 回應: 韌體版本 ${p.fwVersion} (狀態: ${ERROR_CODES[p.errorCode] || p.errorCode})`, 'rx');
            isFinished = true;
            finalErrorCode = p.errorCode;
          } else if (p.cmd === 0x61) {
            if (p.epc) {
                addLog(`[RX] 61H 偵測標籤: ${p.epc}`, 'tag');
                if (!epcList.includes(p.epc)) epcList.push(p.epc);
            }
            if (p.errorCode !== 'N/A') {
                addLog(`[RX] 61H 讀取結束: ${ERROR_CODES[p.errorCode] || p.errorCode}`, 'rx');
                isFinished = true;
                finalErrorCode = p.errorCode;
            }
          } else if (p.cmd === 0x64) {
            if (p.status === 0x01) {
              addLog(`[RX] 64H 任務終止: 累計找到 ${p.count} 筆, 狀態: ${ERROR_CODES[p.errorCode] || p.errorCode}`, 'rx');
              isFinished = true;
              finalErrorCode = p.errorCode;
            } else if (p.status === 0x00) {
              if (p.epc) {
                addLog(`[RX] 64H 偵測標籤: ${p.epc}`, 'tag');
                if (!epcList.includes(p.epc)) epcList.push(p.epc);
              }
            }
          }
        }
      });
      if (isFinished) break;
      await new Promise(r => setTimeout(r, 50));
    }

    if (!isFinished && !stopRequestedRef.current && isConnected) {
      addLog(`[RX] ${config.commandType} 指令逾時 (無任何應答封包)`, 'error');
    }

    const isSuccess = isFinished && (finalErrorCode === '0001' || finalErrorCode === '0000');
    return {
      timestamp: new Date().toISOString(),
      cycle, status: isSuccess ? 'Success' : (isFinished ? 'Failure' : 'Timeout'),
      errorCode: finalErrorCode, errorMsg: ERROR_CODES[finalErrorCode] || '逾時',
      rawTx: uint8ArrayToHex(txBuffer), rawRx: uint8ArrayToHex(masterBufferRef.current),
      recordsFound: epcList.length, cmdType: config.commandType, epcList,
      configTimeout: config.timeoutMs, configPower: config.power, configMaxRecords: config.maxRecords
    };
  };

  const handleSingleTest = async () => {
    if (!isConnected || isTesting || isSingleTesting) return;
    setIsSingleTesting(true);
    addLog(`執行 [${config.commandType}] 單次診斷測試`, 'system');
    const res = await runSingleTest(0);
    if (res) {
      setResults(prev => [res, ...prev]);
    }
    setIsSingleTesting(false);
  };

  const startTesting = async () => {
    if (!isConnected) return;
    setIsTesting(true);
    stopRequestedRef.current = false;
    setResults([]); setLogs([]); setRawLogs([]);
    addLog(`啟動 [${config.commandType}] 壓力測試流程 (共 ${config.totalCycles} 次)`, 'system');
    for (let i = 1; i <= config.totalCycles; i++) {
      if (stopRequestedRef.current || !isConnected) break;
      setCurrentCycle(i);
      const res = await runSingleTest(i);
      if (res) {
        setResults(prev => [res, ...prev]);
        if (config.stopOnError && res.status !== 'Success') {
            addLog(`偵測到測試失敗且啟動自動停止機制`, 'error');
            break;
        }
      }
      if (config.intervalMs > 0 && i < config.totalCycles) await new Promise(r => setTimeout(r, config.intervalMs));
    }
    setIsTesting(false);
    addLog(`壓力測試流程結束`, 'system');
  };

  const totalCount = results.length;
  const successCount = results.filter(r => r.status === 'Success').length;
  const stabilityRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

  return (
    <div className="bg-slate-50 min-h-screen text-slate-700 font-sans flex flex-col h-[100dvh] overflow-hidden">
      <header className="bg-white border-b border-slate-200 px-5 h-16 flex items-center justify-between shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg shadow-indigo-100 flex-shrink-0">
            <Activity className="text-white w-6 h-6" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-sm font-black text-slate-800 leading-none">RFID PRO</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isConnected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                {isConnected ? '● 已連線 (ONLINE)' : '○ 未連線 (OFFLINE)'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 hidden sm:flex justify-center px-4">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-1.5 flex items-center gap-4 min-w-[160px] justify-center">
             {activeTab === 'update' && (isUpdating || updateProgress > 0) ? (
               <div className="flex flex-col items-center">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">更新進度</span>
                  <span className="text-base font-black tabular-nums text-indigo-500">{updateProgress}%</span>
               </div>
             ) : (
               <>
                 <div className="flex flex-col items-center">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-widest">通訊穩定度</span>
                    <span className={`text-base font-black tabular-nums ${stabilityRate >= 95 ? 'text-emerald-500' : 'text-rose-500'}`}>{stabilityRate}%</span>
                 </div>
                 <div className="w-px h-6 bg-slate-200"></div>
                 <div className="flex flex-col items-center">
                    <span className="text-xs font-black text-slate-400 uppercase tracking-widest">成功率</span>
                    <span className="text-base font-black tabular-nums text-slate-600">{successCount}/{totalCount}</span>
                 </div>
               </>
             )}
          </div>
        </div>

        <div className="flex items-center gap-2">
           {!isConnected ? (
             <button onClick={connectSerial} className="h-12 px-4 bg-slate-900 text-white rounded-xl font-black text-sm flex items-center gap-2 active:scale-95 transition-all shadow-md"><Link className="w-4 h-4" /> 連線設備</button>
           ) : (
             <button onClick={disconnectSerial} className="h-12 px-4 bg-rose-50 text-rose-600 border border-rose-100 rounded-xl font-black text-sm flex items-center gap-2 active:scale-95 transition-all"><Link2Off className="w-4 h-4" /> 斷開</button>
           )}
           <button onClick={() => { initialBaudRateRef.current = config.baudRate; setIsAdvConfigOpen(true); }} className="w-12 h-12 flex items-center justify-center bg-white rounded-xl border border-slate-200 text-slate-600"><Settings className="w-5 h-5" /></button>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative overflow-hidden">
        {activeTab === 'terminal' && (
          <div className="flex-1 flex flex-col h-full">
             <div className="sm:hidden px-3 pt-3 flex gap-2">
                <div className="flex-1 bg-white p-3 rounded-xl border border-slate-200 flex justify-between items-center">
                   <span className="text-xs font-black text-slate-400 uppercase tracking-widest">穩定度</span>
                   <span className={`text-base font-black ${stabilityRate >= 95 ? 'text-emerald-500' : 'text-rose-500'}`}>{stabilityRate}%</span>
                </div>
                <div className="flex-1 bg-white p-3 rounded-xl border border-slate-200 flex justify-between items-center">
                   <span className="text-xs font-black text-slate-400 uppercase tracking-widest">成功/總數</span>
                   <span className="text-base font-black text-slate-600">{successCount}/{totalCount}</span>
                </div>
             </div>

             <div className="bg-slate-900 mx-3 mt-3 mb-[85px] rounded-xl flex-1 flex flex-col overflow-hidden border border-slate-800 shadow-2xl">
                <div className="flex items-center justify-between px-4 py-3 bg-slate-800/50 border-b border-slate-800">
                   <div className="flex gap-2">
                      <button onClick={() => setLogView('trace')} className={`text-xs font-black px-4 py-2 rounded-lg transition-colors ${logView === 'trace' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>追蹤日誌 (TRACE)</button>
                      <button onClick={() => setLogView('raw')} className={`text-xs font-black px-4 py-2 rounded-lg transition-colors ${logView === 'raw' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>原始數據 (HEX)</button>
                   </div>
                   <button onClick={() => logView === 'trace' ? setLogs([]) : setRawLogs([])} className="p-2 text-slate-500 hover:text-white transition-colors" title="清除視窗"><Trash2 className="w-5 h-5" /></button>
                </div>
                <div className="flex-1 p-4 font-mono text-sm sm:text-base overflow-y-auto custom-scrollbar leading-relaxed bg-[#0a0f18]">
                   {logView === 'trace' ? (
                     logs.map((l, i) => (
                       <div key={i} className="mb-1.5 flex gap-2">
                          <span className="text-white/20 shrink-0 text-xs sm:text-sm">{l.timestamp}</span>
                          <span className={`${l.type === 'tx' ? 'text-indigo-400' : l.type === 'rx' ? 'text-emerald-400' : l.type === 'tag' ? 'text-amber-400 font-bold' : l.type === 'error' ? 'text-rose-400' : 'text-slate-400'} break-all`}>{l.msg}</span>
                       </div>
                     ))
                   ) : (
                     rawLogs.map((l, i) => (
                        <div key={i} className="mb-2.5 border-l-2 border-slate-800 pl-3">
                           <div className="flex items-center mb-1">
                              <span className="text-white/20 text-xs mr-2">{l.timestamp}</span>
                              <span className={`px-2 rounded text-[10px] font-black ${l.type === 'tx' ? 'bg-indigo-900 text-indigo-400' : 'bg-emerald-900 text-emerald-400'}`}>{l.type === 'tx' ? 'TX (發送)' : 'RX (接收)'}</span>
                           </div>
                           <span className="text-slate-300 break-all text-xs sm:text-sm tracking-widest">{l.data}</span>
                        </div>
                     ))
                   )}
                   <div ref={logEndRef} />
                </div>
             </div>

             <div className={`absolute bottom-0 inset-x-0 bg-white border-t border-slate-200 transition-all duration-300 z-40 ${isControlExpanded ? 'h-[360px]' : 'h-20'}`}>
                <button onClick={() => setIsControlExpanded(!isControlExpanded)} className="absolute -top-4 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded-full p-1.5 shadow-md z-50 touch-manipulation hover:bg-slate-50 transition-colors"><ChevronUp className={`w-5 h-5 text-slate-400 transition-transform ${isControlExpanded ? 'rotate-180' : ''}`} /></button>
                <div className="p-4 flex flex-col h-full overflow-visible">
                   <div className="flex items-center gap-3 mb-4 shrink-0 overflow-visible">
                      <div className="relative shrink-0">
                         <button onClick={() => setIsCmdMenuOpen(!isCmdMenuOpen)} className="flex items-center gap-2 px-5 h-12 bg-slate-900 text-white rounded-xl font-black text-base tracking-widest shadow-md hover:bg-slate-800 transition-colors">{config.commandType} <ChevronDown className="w-4 h-4" /></button>
                         {isCmdMenuOpen && (
                           <div className="absolute bottom-full left-0 mb-3 w-32 bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden z-[100] animate-in fade-in slide-in-from-bottom-2">
                             {(['64H', '61H', '35H'] as CommandType[]).map(t => (
                               <button key={t} onClick={() => { setConfig({...config, commandType: t}); setIsCmdMenuOpen(false); }} className="w-full py-4 text-base font-black hover:bg-slate-50 border-b border-slate-50 last:border-0">{t}</button>
                             ))}
                           </div>
                         )}
                      </div>
                      <div className="flex-1 flex justify-end gap-2">
                         <button 
                            onClick={handleSingleTest} 
                            disabled={!isConnected || isTesting || isSingleTesting} 
                            className={`h-12 px-4 rounded-xl font-black text-base flex items-center gap-2 shadow-md transition-all ${(!isConnected || isTesting || isSingleTesting) ? 'bg-slate-50 text-slate-300' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 active:scale-95'}`}
                         >
                            <Play className={`w-5 h-5 ${isSingleTesting ? 'animate-pulse' : ''}`} /> {isSingleTesting ? '執行中...' : '單次測試'}
                         </button>
                         <button onClick={isTesting ? () => stopRequestedRef.current = true : startTesting} disabled={!isConnected || isSingleTesting} className={`h-12 px-6 rounded-xl font-black text-base flex items-center gap-2 shadow-lg transition-all ${isTesting ? 'bg-rose-500 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 disabled:bg-slate-100 disabled:text-slate-300'}`}>
                           {isTesting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />} {isTesting ? '停止測試' : '開始壓力測試'}
                         </button>
                      </div>
                   </div>
                   <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-1 overflow-y-auto pb-4 custom-scrollbar">
                      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 flex flex-col group focus-within:border-indigo-200 transition-colors">
                         <label className="text-xs font-black text-slate-400 uppercase block mb-1.5 tracking-wider">總測試次數 (Cycles)</label>
                         <input type="number" value={config.totalCycles} onChange={e => setConfig({...config, totalCycles: parseInt(e.target.value) || 1})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base" />
                      </div>
                      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 flex flex-col group focus-within:border-indigo-200 transition-colors">
                         <label className="text-xs font-black text-slate-400 uppercase block mb-1.5 tracking-wider">回應逾時 (Timeout ms)</label>
                         <input type="number" value={config.timeoutMs} onChange={e => setConfig({...config, timeoutMs: parseInt(e.target.value) || 1000})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base" />
                      </div>
                      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 flex flex-col group focus-within:border-indigo-200 transition-colors">
                         <label className="text-xs font-black text-slate-400 uppercase block mb-1.5 tracking-wider">標籤筆數限制 (Max)</label>
                         <input type="number" value={config.maxRecords} onChange={e => setConfig({...config, maxRecords: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base" />
                      </div>
                      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 flex flex-col group focus-within:border-indigo-200 transition-colors">
                         <label className="text-xs font-black text-slate-400 uppercase block mb-1.5 tracking-wider">RF 射頻功率 (dbm)</label>
                         <input type="number" value={config.power} onChange={e => setConfig({...config, power: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base" />
                      </div>
                   </div>
                </div>
             </div>
          </div>
        )}

        {activeTab === 'update' && (
          <div className="flex-1 p-6 flex flex-col items-center justify-center">
             <div className="w-full max-w-md bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-xl">
                <h3 className="text-xl font-black mb-6 flex items-center gap-3 uppercase tracking-widest text-slate-800"><Cpu className="text-indigo-600 w-6 h-6" /> 韌體更新 (IAP)</h3>
                <input type="file" accept=".bin" onChange={handleFileChange} className="hidden" id="bin-file" disabled={isUpdating && !isUpdatePaused} />
                <label htmlFor="bin-file" className={`block border-2 border-dashed p-10 rounded-2xl text-center transition-all ${selectedFile ? 'border-indigo-100 bg-indigo-50/20' : 'border-slate-100 hover:border-indigo-200'} cursor-pointer relative overflow-hidden`}>
                   <FileUp className={`w-10 h-10 mx-auto mb-3 ${selectedFile ? 'text-indigo-500' : 'text-slate-300'}`} />
                   <span className="text-base font-bold text-slate-600 block truncate">{selectedFile ? selectedFile.name : '點擊選擇 .bin 韌體檔案'}</span>
                   {fileVersion && (
                     <div className="mt-4 flex justify-center">
                        <span className="inline-flex items-center px-4 py-1.5 rounded-full text-sm font-black bg-indigo-50 text-indigo-600 border border-indigo-100">
                          檔案版本: {fileVersion}
                        </span>
                     </div>
                   )}
                </label>
                
                {(isUpdating || updateProgress > 0) && (
                  <div className="mt-8 bg-slate-50 p-5 rounded-2xl border border-slate-100 animate-in fade-in">
                     <div className="flex justify-between text-xs font-black mb-2">
                        <span className="text-slate-400 uppercase tracking-widest truncate max-w-[70%]">{updateStatus}</span>
                        <span className="text-indigo-600 shrink-0 text-base">{updateProgress}%</span>
                     </div>
                     <div className="h-3 bg-slate-200 rounded-full overflow-hidden shadow-inner">
                        <div className="h-full bg-indigo-600 transition-all duration-300" style={{width:`${updateProgress}%`}}></div>
                     </div>
                  </div>
                )}

                <div className="flex gap-3 mt-8">
                  <button 
                    onClick={() => runFirmwareUpdate(isUpdatePaused)} 
                    disabled={!isConnected || !selectedFile || (isUpdating && !isUpdatePaused)} 
                    className={`flex-1 h-14 rounded-2xl font-black shadow-lg active:scale-95 transition-all text-base tracking-widest ${(!isConnected || !selectedFile || (isUpdating && !isUpdatePaused)) ? 'bg-slate-100 text-slate-300' : 'bg-slate-900 text-white hover:bg-slate-800'}`}
                  >
                    {isUpdatePaused ? '重新啟動' : isUpdating ? '正在寫入...' : '開始升級'}
                  </button>

                  {isUpdating && (
                    <button 
                      onClick={() => setIsUpdatePaused(!isUpdatePaused)} 
                      className={`w-16 h-14 rounded-2xl font-black shadow-lg flex items-center justify-center transition-all ${isUpdatePaused ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                    >
                      {isUpdatePaused ? <Play className="w-6 h-6 fill-current" /> : <Pause className="w-6 h-6 fill-current" />}
                    </button>
                  )}
                </div>
             </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex-1 p-4 overflow-y-auto space-y-3 custom-scrollbar">
             <div className="flex justify-between items-center mb-2 px-2">
                <span className="text-xs font-black text-slate-400 uppercase tracking-widest">測試歷史紀錄 ({results.length})</span>
                <button onClick={() => setResults([])} className="text-sm font-black text-rose-500 uppercase px-2 py-1 hover:bg-rose-50 rounded-lg transition-colors">全部清除</button>
             </div>
             {results.length === 0 && (
               <div className="h-40 flex flex-col items-center justify-center text-slate-300">
                  <Database className="w-12 h-12 mb-2 opacity-20" />
                  <span className="text-sm font-bold">尚無測試數據</span>
               </div>
             )}
             {results.map((r, i) => (
               <div key={i} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
                  <div className="flex items-center gap-4">
                     <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm ${r.status === 'Success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>#{r.cycle}</div>
                     <div>
                        <div className="text-base font-black text-slate-800">{r.cmdType} 指令模式</div>
                        <div className="text-sm text-slate-400 font-bold">{r.recordsFound} 筆標籤偵測成功</div>
                     </div>
                  </div>
                  <div className="text-right">
                     <div className={`text-sm font-black uppercase ${r.status === 'Success' ? 'text-emerald-600' : 'text-rose-600'}`}>{r.status === 'Success' ? '成功' : r.status === 'Failure' ? '失敗' : '逾時'}</div>
                     <div className="text-xs text-slate-300 font-mono tracking-tighter">{r.errorCode}</div>
                  </div>
               </div>
             ))}
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 h-16 flex items-center justify-center shrink-0 z-50">
          <div className="flex w-full max-w-lg gap-2 p-1.5 bg-slate-100 rounded-2xl mx-4 shadow-inner">
            <button onClick={() => setActiveTab('terminal')} className={`flex-1 py-2.5 rounded-xl text-xs sm:text-sm font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'terminal' ? 'bg-white shadow-md text-indigo-600 scale-105' : 'text-slate-400 hover:text-slate-600'}`}><Terminal className="w-5 h-5" /> 終端機</button>
            <button onClick={() => setActiveTab('update')} className={`flex-1 py-2.5 rounded-xl text-xs sm:text-sm font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'update' ? 'bg-white shadow-md text-indigo-600 scale-105' : 'text-slate-400 hover:text-slate-600'}`}><Cpu className="w-5 h-5" /> 韌體更新</button>
            <button onClick={() => setActiveTab('history')} className={`flex-1 py-2.5 rounded-xl text-xs sm:text-sm font-black flex items-center justify-center gap-2 transition-all ${activeTab === 'history' ? 'bg-white shadow-md text-indigo-600 scale-105' : 'text-slate-400 hover:text-slate-600'}`}><Database className="w-5 h-5" /> 歷史紀錄</button>
          </div>
      </footer>

      {/* Advanced Config Modal */}
      <div className={`fixed inset-0 z-[100] transition-all duration-300 ${isAdvConfigOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>
         <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" onClick={() => setIsAdvConfigOpen(false)}></div>
         <div className={`absolute bottom-0 inset-x-0 bg-white rounded-t-[40px] p-8 shadow-2xl transition-transform duration-500 transform ${isAdvConfigOpen ? 'translate-y-0' : 'translate-y-full'}`}>
            <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-8"></div>
            <h3 className="font-black text-slate-800 mb-8 flex justify-between items-center uppercase tracking-widest text-lg">通訊進階參數設定 <button onClick={() => setIsAdvConfigOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><X className="w-6 h-6 text-slate-400" /></button></h3>
            <div className="space-y-6">
               <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 focus-within:border-indigo-200 transition-colors">
                    <label className="text-xs font-black text-slate-400 block mb-1.5 uppercase tracking-widest">通訊波特率 (Baud Rate)</label>
                    <select value={config.baudRate} onChange={e => setConfig({...config, baudRate: parseInt(e.target.value)})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base h-10 cursor-pointer">
                        {[9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b} bps</option>)}
                    </select>
                    <p className="text-[10px] text-slate-400 mt-1 font-bold">* 連線中修改波特率將觸發自動重新連線</p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 focus-within:border-indigo-200 transition-colors">
                    <label className="text-xs font-black text-slate-400 block mb-1.5 uppercase tracking-widest">設備站號 (Address ID 0-15)</label>
                    <input type="number" min="0" max="15" value={config.id} onChange={e => setConfig({...config, id: Math.max(0, Math.min(15, parseInt(e.target.value) || 0))})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base h-10" />
                  </div>
               </div>
               <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 focus-within:border-indigo-200 transition-colors">
                  <label className="text-xs font-black text-slate-400 block mb-1.5 uppercase tracking-widest">壓力測試間隔 (Interval ms)</label>
                  <input type="number" value={config.intervalMs} onChange={e => setConfig({...config, intervalMs: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-base h-10" />
               </div>
               <div className="flex items-center gap-4 px-2 py-2 group cursor-pointer" onClick={() => setConfig({...config, stopOnError: !config.stopOnError})}>
                  <input type="checkbox" id="stop-on-err" checked={config.stopOnError} onChange={e => {}} className="w-6 h-6 rounded-lg accent-indigo-600 cursor-pointer" />
                  <label htmlFor="stop-on-err" className="text-base font-bold text-slate-600 cursor-pointer select-none">發生異常回應時自動中止壓力測試流程</label>
               </div>
            </div>
            <button onClick={handleSaveConfig} className="w-full h-16 bg-slate-900 text-white font-black rounded-2xl mt-8 shadow-xl uppercase tracking-widest text-base active:scale-95 transition-all hover:bg-slate-800">儲存並回主畫面</button>
         </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar { width: 4px; } .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }`}} />
    </div>
  );
};

export default App;
