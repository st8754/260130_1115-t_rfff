
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
  const [activeTab, setActiveTab] = useState<'terminal' | 'history' | 'update'>('terminal');
  const [logView, setLogView] = useState<'trace' | 'raw'>('trace');
  const [isControlExpanded, setIsControlExpanded] = useState(true);
  const [isAdvConfigOpen, setIsAdvConfigOpen] = useState(false);
  const [isCmdMenuOpen, setIsCmdMenuOpen] = useState(false);
  
  const [config, setConfig] = useState<TestConfig>({
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
      addLog(`${description} TX: ${uint8ArrayToHex(data).substring(0, 30)}...`, 'tx');
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
      addLog(`串口已連接`, 'system');
      startBackgroundRead(selectedPort);
    } catch (err: any) { addLog("連線失敗: " + err.message, 'error'); }
  };

  const disconnectSerial = async () => {
    if (isTesting || isUpdating) stopRequestedRef.current = true;
    isReadingRef.current = false;
    if (backgroundReaderRef.current) {
      try { await backgroundReaderRef.current.cancel(); } catch (e) {}
    }
    if (port) {
      try { await port.close(); addLog("串口已關閉", 'system'); } 
      catch (e: any) { addLog(`關閉異常: ${e.message}`, 'error'); } 
      finally { cleanupState(); }
    }
  };

  // 從二進位檔案中提取前 32 位元組，並擷取到 .bin 之前的字串
  const extractVersionFromFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer).slice(0, 32);
    // 轉換為字串
    const text = new TextDecoder().decode(data);
    // 尋找 .bin 的位置
    const binIndex = text.indexOf('.bin');
    let finalVersion = '';
    if (binIndex !== -1) {
      // 擷取 .bin 之前的內容
      finalVersion = text.substring(0, binIndex);
    } else {
      finalVersion = text;
    }
    // 清理字串：移除 null (0x00) 與前後空白
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
    setUpdateStatus('啟動更新...');
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
          setUpdateStatus('已暫停');
          await new Promise(r => setTimeout(r, 100));
        }
        if (stopRequestedRef.current || !isConnected) break;
        
        setUpdateStatus(`傳輸封包 ${i}/${totalP}`);
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
          if (ack && ack.errorCode === '0001') { confirmed = true; break; }
          await new Promise(r => setTimeout(r, 20));
        }
        if (stopRequestedRef.current) break;
        if (!confirmed) throw new Error(`封包 ${i} 逾時`);
        setUpdateProgress(Math.floor((i / totalP) * 100));
      }

      if (!stopRequestedRef.current) {
        setUpdateStatus('發送結束指令 (F2)...');
        masterBufferRef.current = new Uint8Array(0);
        await writeToSerial(buildF2HRequest(config.id), 'F2H');
        
        // 判斷 F2H 響應
        let f2Confirmed = false;
        let f2Start = Date.now();
        while (Date.now() - f2Start < 3000) {
          const pkts = scanAllPackets(masterBufferRef.current, 'F2');
          const ack = pkts.find(p => p.cmd === 0xF2);
          if (ack) {
            if (ack.errorCode === '0001') {
              f2Confirmed = true;
              break;
            } else {
              throw new Error(`結束指令失敗 (F2): ${ERROR_CODES[ack.errorCode] || ack.errorCode}`);
            }
          }
          await new Promise(r => setTimeout(r, 50));
        }
        if (!f2Confirmed) throw new Error('結束指令 (F2) 未獲應答');

        setUpdateStatus('更新成功，等待重啟 (2s)...');
        await new Promise(r => setTimeout(r, 2000));

        // 循環詢問 0x35 (版號), 最多 3 次, 每回合 1s 逾時
        let verifiedVersion = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (stopRequestedRef.current) break;
          setUpdateStatus(`驗證版號 (嘗試 ${attempt}/3)...`);
          masterBufferRef.current = new Uint8Array(0);
          await writeToSerial(build35HRequest(config.id), '35H (Verify)');
          
          let waitStart = Date.now();
          while (Date.now() - waitStart < 1000) {
            const pkts = scanAllPackets(masterBufferRef.current, '35H');
            const ack = pkts.find(p => p.cmd === 0x35);
            if (ack && ack.fwVersion) {
              verifiedVersion = ack.fwVersion.trim();
              break;
            }
            await new Promise(r => setTimeout(r, 50));
          }
          if (verifiedVersion) break;
        }

        if (!verifiedVersion) {
          throw new Error('讀取版號失敗 (三次重試皆逾時)');
        }

        addLog(`設備重啟完成，讀回版號: ${verifiedVersion}`, 'info');

        // 比對版號 (與檔案提取的 fileVersion 進行比對)
        if (fileVersion) {
          // 清理可能的 V 字元前綴進行寬鬆但準確的比對
          const cleanFile = fileVersion.toUpperCase().replace(/^V/, '');
          const cleanDevice = verifiedVersion.toUpperCase().replace(/^V/, '');
          
          if (cleanFile !== cleanDevice) {
            throw new Error(`版號驗證失敗！預期: ${fileVersion}, 實際: ${verifiedVersion}`);
          }
        }

        setUpdateStatus(`更新成功！版號: ${verifiedVersion}`);
        setTimeout(() => {
          setIsUpdating(false);
          setUpdateProgress(0);
        }, 3000);
      } else {
        setUpdateStatus('操作已中止');
      }
    } catch (err: any) {
      setUpdateStatus(`失敗: ${err.message}`);
      addLog(`更新異常: ${err.message}`, 'error');
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
          if (p.epc && !epcList.includes(p.epc)) epcList.push(p.epc);
          if (config.commandType === '64H' && p.status === 0x01) { isFinished = true; finalErrorCode = p.errorCode; }
          else if (config.commandType !== '64H') { isFinished = true; finalErrorCode = p.errorCode; }
        }
      });
      if (isFinished) break;
      await new Promise(r => setTimeout(r, 50));
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

  const startTesting = async () => {
    if (!isConnected) return;
    setIsTesting(true);
    stopRequestedRef.current = false;
    setResults([]); setLogs([]); setRawLogs([]);
    addLog(`開始壓力測試 [${config.commandType}]`, 'system');
    for (let i = 1; i <= config.totalCycles; i++) {
      if (stopRequestedRef.current || !isConnected) break;
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

  const totalCount = results.length;
  const successCount = results.filter(r => r.status === 'Success').length;
  const stabilityRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

  return (
    <div className="bg-slate-50 min-h-screen text-slate-700 font-sans flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-5 h-16 flex items-center justify-between shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg shadow-indigo-100 flex-shrink-0">
            <Activity className="text-white w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xs font-black text-slate-800 leading-none">RFID STABILITY PRO</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-[8px] font-bold px-2 py-0.5 rounded-full ${isConnected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                {isConnected ? '● ONLINE' : '○ OFFLINE'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 flex justify-center px-4">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-1.5 flex items-center gap-4 min-w-[160px] justify-center">
             {activeTab === 'update' && (isUpdating || updateProgress > 0) ? (
               <div className="flex flex-col items-center">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">更新進度</span>
                  <span className="text-sm font-black tabular-nums text-indigo-500">{updateProgress}%</span>
               </div>
             ) : (
               <>
                 <div className="flex flex-col items-center">
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">穩定性</span>
                    <span className={`text-sm font-black tabular-nums ${stabilityRate >= 95 ? 'text-emerald-500' : 'text-rose-500'}`}>{stabilityRate}%</span>
                 </div>
                 <div className="w-px h-6 bg-slate-200"></div>
                 <div className="flex flex-col items-center">
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">成功 / 總數</span>
                    <span className="text-sm font-black tabular-nums text-slate-600">{successCount} / {totalCount}</span>
                 </div>
               </>
             )}
          </div>
        </div>

        <div className="flex items-center gap-2">
           {!isConnected ? (
             <button onClick={connectSerial} className="h-9 px-4 bg-slate-900 text-white rounded-lg font-black text-[10px] flex items-center gap-2 active:scale-95 transition-all shadow-md"><Link className="w-3.5 h-3.5" /> CONNECT</button>
           ) : (
             <button onClick={disconnectSerial} className="h-9 px-4 bg-rose-50 text-rose-600 border border-rose-100 rounded-lg font-black text-[10px] flex items-center gap-2 active:scale-95 transition-all"><Link2Off className="w-3.5 h-3.5" /> DISCONNECT</button>
           )}
           <button onClick={() => setIsAdvConfigOpen(true)} className="w-9 h-9 flex items-center justify-center bg-white rounded-lg border border-slate-200 text-slate-600"><Settings className="w-4 h-4" /></button>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative overflow-hidden">
        {activeTab === 'terminal' && (
          <div className="flex-1 flex flex-col h-full">
             <div className="bg-slate-900 mx-3 mt-3 mb-[75px] rounded-xl flex-1 flex flex-col overflow-hidden border border-slate-800">
                <div className="flex items-center justify-between px-4 py-2 bg-slate-800/50 border-b border-slate-800">
                   <div className="flex gap-2">
                      <button onClick={() => setLogView('trace')} className={`text-[10px] font-black px-3 py-1 rounded ${logView === 'trace' ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}>TRACE</button>
                      <button onClick={() => setLogView('raw')} className={`text-[10px] font-black px-3 py-1 rounded ${logView === 'raw' ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}>HEX DATA</button>
                   </div>
                   <button onClick={() => logView === 'trace' ? setLogs([]) : setRawLogs([])} className="text-slate-500 hover:text-white"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="flex-1 p-4 font-mono text-[10px] overflow-y-auto custom-scrollbar leading-relaxed">
                   {logView === 'trace' ? (
                     logs.map((l, i) => (
                       <div key={i} className="mb-1 flex gap-2">
                          <span className="text-white/20 shrink-0">{l.timestamp}</span>
                          <span className={`${l.type === 'tx' ? 'text-indigo-400' : l.type === 'error' ? 'text-rose-400' : 'text-slate-400'} break-all`}>{l.msg}</span>
                       </div>
                     ))
                   ) : (
                     rawLogs.map((l, i) => (
                        <div key={i} className="mb-2">
                           <span className="text-white/20 text-[8px] mr-2">{l.timestamp}</span>
                           <span className={`px-1 rounded text-[7px] font-black mr-2 ${l.type === 'tx' ? 'bg-indigo-900 text-indigo-400' : 'bg-emerald-900 text-emerald-400'}`}>{l.type === 'tx' ? 'TX' : 'RX'}</span>
                           <span className="text-slate-300 break-all">{l.data}</span>
                        </div>
                     ))
                   )}
                   <div ref={logEndRef} />
                </div>
             </div>

             <div className={`absolute bottom-0 inset-x-0 bg-white border-t border-slate-200 transition-all duration-300 z-40 ${isControlExpanded ? 'h-72' : 'h-14'}`}>
                <button onClick={() => setIsControlExpanded(!isControlExpanded)} className="absolute -top-3 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded-full p-1 shadow-sm"><ChevronUp className={`w-4 h-4 text-slate-400 transition-transform ${isControlExpanded ? 'rotate-180' : ''}`} /></button>
                <div className="p-4 flex flex-col h-full">
                   <div className="flex items-center gap-3 mb-4">
                      <div className="relative shrink-0">
                         <button onClick={() => setIsCmdMenuOpen(!isCmdMenuOpen)} className="flex items-center gap-2 px-4 h-10 bg-slate-900 text-white rounded-lg font-black text-[11px] tracking-widest">{config.commandType} <ChevronDown className="w-3 h-3" /></button>
                         {isCmdMenuOpen && (
                           <div className="absolute bottom-full left-0 mb-2 w-28 bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden z-50">
                             {(['64H', '61H', '35H'] as CommandType[]).map(t => (
                               <button key={t} onClick={() => { setConfig({...config, commandType: t}); setIsCmdMenuOpen(false); }} className="w-full py-2 text-[10px] font-black hover:bg-slate-50">{t}</button>
                             ))}
                           </div>
                         )}
                      </div>
                      <div className="flex-1 flex justify-end gap-2">
                         <button onClick={isTesting ? () => stopRequestedRef.current = true : startTesting} disabled={!isConnected} className={`h-10 px-6 rounded-lg font-black text-xs flex items-center gap-2 shadow-lg transition-all ${isTesting ? 'bg-rose-500 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95'}`}>
                           {isTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} {isTesting ? 'STOP' : 'START TEST'}
                         </button>
                      </div>
                   </div>
                   <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1 overflow-y-auto">
                      <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                         <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">測試總次數</label>
                         <input type="number" value={config.totalCycles} onChange={e => setConfig({...config, totalCycles: parseInt(e.target.value) || 1})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm" />
                      </div>
                      <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                         <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">單次 Timeout (ms)</label>
                         <input type="number" value={config.timeoutMs} onChange={e => setConfig({...config, timeoutMs: parseInt(e.target.value) || 1000})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm" />
                      </div>
                      <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                         <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">收資料筆數</label>
                         <input type="number" value={config.maxRecords} onChange={e => setConfig({...config, maxRecords: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm" />
                      </div>
                      <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                         <label className="text-[9px] font-black text-slate-400 uppercase block mb-1">射頻功率 (64H)</label>
                         <input type="number" value={config.power} onChange={e => setConfig({...config, power: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none text-sm" />
                      </div>
                   </div>
                </div>
             </div>
          </div>
        )}

        {activeTab === 'update' && (
          <div className="flex-1 p-6 flex flex-col items-center justify-center">
             <div className="w-full max-w-md bg-white p-8 rounded-3xl border border-slate-200 shadow-xl">
                <h3 className="text-lg font-black mb-6 flex items-center gap-2 uppercase tracking-widest"><Cpu className="text-indigo-600" /> Firmware IAP</h3>
                <input type="file" accept=".bin" onChange={handleFileChange} className="hidden" id="bin-file" disabled={isUpdating && !isUpdatePaused} />
                <label htmlFor="bin-file" className={`block border-2 border-dashed p-8 rounded-2xl text-center transition-colors ${selectedFile ? 'border-indigo-100 bg-indigo-50/10' : 'border-slate-100 hover:border-indigo-200'} cursor-pointer relative overflow-hidden`}>
                   <FileUp className={`w-8 h-8 mx-auto mb-2 ${selectedFile ? 'text-indigo-500' : 'text-slate-300'}`} />
                   <span className="text-xs font-bold text-slate-600 block truncate">{selectedFile ? selectedFile.name : '點擊選擇 .bin 檔案'}</span>
                   {fileVersion && (
                     <div className="mt-2 flex justify-center">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-50 text-indigo-600 border border-indigo-100">
                          FILE v: {fileVersion}
                        </span>
                     </div>
                   )}
                </label>
                
                {(isUpdating || updateProgress > 0) && (
                  <div className="mt-6 bg-slate-50 p-4 rounded-xl border border-slate-100">
                     <div className="flex justify-between text-[10px] font-black mb-1">
                        <span className="text-slate-400 uppercase tracking-widest truncate max-w-[70%]">{updateStatus}</span>
                        <span className="text-indigo-600 shrink-0">{updateProgress}%</span>
                     </div>
                     <div className="h-2 bg-slate-200 rounded-full overflow-hidden shadow-inner">
                        <div className="h-full bg-indigo-600 transition-all duration-300" style={{width:`${updateProgress}%`}}></div>
                     </div>
                  </div>
                )}

                <div className="flex gap-2 mt-6">
                  <button 
                    onClick={() => runFirmwareUpdate(isUpdatePaused)} 
                    disabled={!isConnected || !selectedFile || (isUpdating && !isUpdatePaused)} 
                    className={`flex-1 h-12 rounded-xl font-black shadow-lg active:scale-95 transition-all text-xs tracking-widest ${(!isConnected || !selectedFile || (isUpdating && !isUpdatePaused)) ? 'bg-slate-100 text-slate-300' : 'bg-slate-900 text-white'}`}
                  >
                    {isUpdatePaused ? 'RESTART' : isUpdating ? 'UPGRADING...' : 'START UPGRADE'}
                  </button>

                  {isUpdating && (
                    <button 
                      onClick={() => setIsUpdatePaused(!isUpdatePaused)} 
                      className={`w-14 h-12 rounded-xl font-black shadow-lg flex items-center justify-center transition-all ${isUpdatePaused ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                    >
                      {isUpdatePaused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5 fill-current" />}
                    </button>
                  )}
                </div>
             </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex-1 p-4 overflow-y-auto space-y-2">
             <div className="flex justify-between items-center mb-4 px-2">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">歷史紀錄 ({results.length})</span>
                <button onClick={() => setResults([])} className="text-[10px] font-black text-rose-500 uppercase">Clear All</button>
             </div>
             {results.map((r, i) => (
               <div key={i} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-3">
                     <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs ${r.status === 'Success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>#{r.cycle}</div>
                     <div><div className="text-xs font-bold text-slate-800">{r.cmdType} Mode</div><div className="text-[9px] text-slate-400">{r.recordsFound} Tags found</div></div>
                  </div>
                  <div className="text-right"><div className={`text-[10px] font-black uppercase ${r.status === 'Success' ? 'text-emerald-600' : 'text-rose-600'}`}>{r.status}</div><div className="text-[8px] text-slate-300">{r.errorCode}</div></div>
               </div>
             ))}
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 h-16 flex items-center justify-center shrink-0 z-50">
          <div className="flex w-full max-w-sm gap-1 p-1 bg-slate-100 rounded-xl mx-4 shadow-inner">
            <button onClick={() => setActiveTab('terminal')} className={`flex-1 py-2 rounded-lg text-[10px] font-black flex items-center justify-center gap-2 ${activeTab === 'terminal' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Terminal className="w-4 h-4" /> TERMINAL</button>
            <button onClick={() => setActiveTab('update')} className={`flex-1 py-2 rounded-lg text-[10px] font-black flex items-center justify-center gap-2 ${activeTab === 'update' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Cpu className="w-4 h-4" /> UPDATE</button>
            <button onClick={() => setActiveTab('history')} className={`flex-1 py-2 rounded-lg text-[10px] font-black flex items-center justify-center gap-2 ${activeTab === 'history' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}><Database className="w-4 h-4" /> HISTORY</button>
          </div>
      </footer>

      <div className={`fixed inset-0 z-[100] transition-all duration-300 ${isAdvConfigOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>
         <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setIsAdvConfigOpen(false)}></div>
         <div className="absolute bottom-0 inset-x-0 bg-white rounded-t-3xl p-6 shadow-2xl transition-transform translate-y-0">
            <h3 className="font-black text-slate-800 mb-6 flex justify-between uppercase tracking-widest text-sm">Advanced Settings <X className="cursor-pointer" onClick={() => setIsAdvConfigOpen(false)} /></h3>
            <div className="space-y-4">
               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 block mb-1 uppercase tracking-widest">Baud Rate</label>
                    <select value={config.baudRate} onChange={e => setConfig({...config, baudRate: parseInt(e.target.value)})} className="w-full bg-transparent font-black text-slate-800 outline-none">
                        {[9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b} bps</option>)}
                    </select>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 block mb-1 uppercase tracking-widest">設備 ID (0-15)</label>
                    <input type="number" min="0" max="15" value={config.id} onChange={e => setConfig({...config, id: Math.max(0, Math.min(15, parseInt(e.target.value) || 0))})} className="w-full bg-transparent font-black text-slate-800 outline-none" />
                  </div>
               </div>
               <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                  <label className="text-[10px] font-black text-slate-400 block mb-1 uppercase tracking-widest">單次測試間隔 (MS)</label>
                  <input type="number" value={config.intervalMs} onChange={e => setConfig({...config, intervalMs: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-800 outline-none" />
               </div>
               <div className="flex items-center gap-3 px-2">
                  <input type="checkbox" checked={config.stopOnError} onChange={e => setConfig({...config, stopOnError: e.target.checked})} className="w-4 h-4 rounded accent-indigo-600" />
                  <span className="text-xs font-bold text-slate-600">異常時自動停止測試流程</span>
               </div>
            </div>
            <button onClick={() => setIsAdvConfigOpen(false)} className="w-full h-12 bg-slate-900 text-white font-black rounded-xl mt-8 shadow-lg uppercase tracking-widest text-xs">Close and Save</button>
         </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar { width: 3px; } .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }`}} />
    </div>
  );
};

export default App;
