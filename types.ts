
export type CommandType = '64H' | '61H' | '35H';

export interface TestConfig {
  commandType: CommandType;
  totalCycles: number;
  timeoutMs: number;
  intervalMs: number;
  maxRecords: number;
  id: number;
  channel: number;
  power: number;
  baudRate: number;
  stopOnError: boolean;
}

export interface TestResult {
  timestamp: string;
  cycle: number;
  status: 'Success' | 'Failure' | 'Timeout';
  errorCode: string;
  errorMsg: string;
  rawTx: string;
  rawRx: string;
  recordsFound: number;
  cmdType: CommandType;
}

export const ERROR_CODES: Record<string, string> = {
  '0001': '成功 (Success)',
  '0000': '成功 (Success)',
  '0002': '格式 CRC 錯誤',
  '0003': '格式 CMD 錯誤',
  '0004': '格式 LEN 錯誤',
  '0005': '格式 SOF 錯誤',
  '0101': '命令操作失敗',
  '0102': '操作逾時',
  '2002': '韌體機種不符合',
  '4001': '資料寫入內部 Flash 失敗',
  '4002': '資料讀取內部 Flash 失敗',
  '4003': '資料寫入外部 Flash 失敗',
  '4004': '資料讀取外部 Flash 失敗',
  '4005': '外部 Flash 初始化錯誤',
  '8001': '更新資料 CheckSum 1 錯誤',
  '8002': '更新資料 CheckSum 2 錯誤',
  '8003': '更新資料 CheckSum 1 與 CheckSum 2 錯誤',
  'FFFF': '其它錯誤'
};
