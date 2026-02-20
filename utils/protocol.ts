
import { CommandType } from '../types';

/**
 * Calculates XOR CRC (SOF to Data).
 */
export const calculateXOR = (data: Uint8Array): number => {
  return data.reduce((acc, byte) => acc ^ byte, 0);
};

export const uint8ArrayToHex = (data: Uint8Array): string => {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
};

export const hexToAscii = (hexStr: string): string => {
  const hex = hexStr.replace(/\s/g, '');
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
};

/**
 * 計算 Checksum 1: 每一位元組的加總 (16-bit)
 */
export const calculateCS1 = (data: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]) & 0xFFFF;
  }
  return sum;
};

/**
 * 計算 Checksum 2: 每兩個位元組的 XOR (16-bit)
 */
export const calculateCS2 = (data: Uint8Array): number => {
  let xor = 0;
  for (let i = 0; i < data.length; i += 2) {
    const word = (data[i] << 8) | (i + 1 < data.length ? data[i + 1] : 0x00);
    xor = (xor ^ word) & 0xFFFF;
  }
  return xor;
};

export interface DecodedPacket {
  cmd: number;
  status?: number;
  id: number;
  count?: number;
  errorCode: string;
  epc?: string;
  userData?: string;
  fwVersion?: string;
  updateCount?: number;
  currentPacketNum?: number;
  raw: string;
}

/**
 * Build 64H (Read EPC Data Advance)
 */
export const build64HRequest = (id: number, antenna: number, power: number, timeoutMs: number, maxRecords: number): Uint8Array => {
  const packet = new Uint8Array(17);
  packet[0] = 0x80; 
  packet[1] = 0x00; 
  packet[2] = 0x0E; 
  packet[3] = 0x64; 
  packet[4] = id & 0xFF;
  packet[5] = antenna & 0xFF;
  packet[6] = (power >> 8) & 0xFF; packet[7] = power & 0xFF;
  packet[8] = (timeoutMs >> 24) & 0xFF; packet[9] = (timeoutMs >> 16) & 0xFF;
  packet[10] = (timeoutMs >> 8) & 0xFF; packet[11] = timeoutMs & 0xFF;
  const count = maxRecords > 0 ? maxRecords : 0xFFFFFFFF;
  packet[12] = (count >> 24) & 0xFF; packet[13] = (count >> 16) & 0xFF;
  packet[14] = (count >> 8) & 0xFF; packet[15] = count & 0xFF;
  packet[16] = calculateXOR(packet.slice(0, 16));
  return packet;
};

/**
 * Build 61H (Read EPC Data Auto Power)
 */
export const build61HRequest = (id: number, antenna: number): Uint8Array => {
  const packet = new Uint8Array(7);
  packet[0] = 0x80;
  packet[1] = 0x00;
  packet[2] = 0x04;
  packet[3] = 0x61;
  packet[4] = id & 0xFF;
  packet[5] = antenna & 0xFF;
  packet[6] = calculateXOR(packet.slice(0, 6));
  return packet;
};

/**
 * Build 63H (Read User Memory Data With Auto Power)
 */
export const build63HRequest = (id: number, antenna: number, addrHex: string, lenWord: number): Uint8Array => {
  const packet = new Uint8Array(10);
  packet[0] = 0x80;
  packet[1] = 0x00;
  packet[2] = 0x07;
  packet[3] = 0x63;
  packet[4] = id & 0xFF;
  packet[5] = antenna & 0xFF;
  
  // Data-Addr (2 Bytes)
  const addr = parseInt(addrHex, 16) || 0;
  packet[6] = (addr >> 8) & 0xFF;
  packet[7] = addr & 0xFF;
  
  // Data-Len (1 Byte, Unit: Word)
  packet[8] = lenWord & 0xFF;
  
  packet[9] = calculateXOR(packet.slice(0, 9));
  return packet;
};

/**
 * Build 35H (Read FW Version)
 */
export const build35HRequest = (id: number): Uint8Array => {
  const packet = new Uint8Array(6);
  packet[0] = 0x80;
  packet[1] = 0x00;
  packet[2] = 0x03;
  packet[3] = 0x35;
  packet[4] = id & 0xFF;
  packet[5] = calculateXOR(packet.slice(0, 5));
  return packet;
};

/**
 * Build F0H (Enter Update Mode)
 */
export const buildF0HRequest = (id: number): Uint8Array => {
  const packet = new Uint8Array(6);
  packet[0] = 0x80;
  packet[1] = 0x00;
  packet[2] = 0x03;
  packet[3] = 0xF0;
  packet[4] = id & 0xFF;
  packet[5] = calculateXOR(packet.slice(0, 5));
  return packet;
};

/**
 * Build F1H (Transmit Update Packet)
 */
export const buildF1HRequest = (id: number, count: number, data512: Uint8Array): Uint8Array => {
  const packet = new Uint8Array(520);
  packet[0] = 0x80;
  packet[1] = 0x02;
  packet[2] = 0x05;
  packet[3] = 0xF1;
  packet[4] = id & 0xFF;
  packet[5] = (count >> 8) & 0xFF;
  packet[6] = count & 0xFF;
  packet.set(data512, 7);
  packet[519] = calculateXOR(packet.slice(0, 519));
  return packet;
};

/**
 * Build F2H (Start FW Update)
 */
export const buildF2HRequest = (id: number): Uint8Array => {
  const packet = new Uint8Array(6);
  packet[0] = 0x80;
  packet[1] = 0x00;
  packet[2] = 0x03;
  packet[3] = 0xF2;
  packet[4] = id & 0xFF;
  packet[5] = calculateXOR(packet.slice(0, 5));
  return packet;
};

/**
 * Build 70H (Write Tag Data)
 */
export const build70HRequest = (id: number, antenna: number, power: number, addrHex: string, lenWord: number, dataHex: string): Uint8Array => {
  const dataBytes = dataHex.replace(/\s/g, '').match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [];
  const n = dataBytes.length;
  const packetLen = 22 + n; // CMD(1) + Data(20+N) + CRC(1)
  const packet = new Uint8Array(3 + packetLen);
  
  packet[0] = 0x80;
  packet[1] = (packetLen >> 8) & 0xFF;
  packet[2] = packetLen & 0xFF;
  packet[3] = 0x70;
  packet[4] = id & 0xFF;
  packet[5] = antenna & 0xFF;
  packet[6] = 0x01; // Write Data Type: EPC Data
  packet[7] = power & 0xFF;
  packet[8] = 0xFF; // Set Target Tag EPC Data Length (First found)
  
  // Target Tag EPC Data (12 Bytes 0x00)
  for (let i = 0; i < 12; i++) {
    packet[9 + i] = 0x00;
  }
  
  // Addr (2 Bytes)
  const addr = parseInt(addrHex, 16) || 0;
  packet[21] = (addr >> 8) & 0xFF;
  packet[22] = addr & 0xFF;
  
  // Len (1 Byte)
  packet[23] = lenWord & 0xFF;
  
  // Write Data (N Bytes)
  for (let i = 0; i < n; i++) {
    packet[24 + i] = dataBytes[i];
  }
  
  packet[packet.length - 1] = calculateXOR(packet.slice(0, packet.length - 1));
  return packet;
};

/**
 * 通用響應解析器
 */
export const scanAllPackets = (buffer: Uint8Array, expectedCmd: CommandType | 'F0' | 'F1' | 'F2'): DecodedPacket[] => {
  const foundPackets: DecodedPacket[] = [];
  let i = 0;

  while (i < buffer.length) {
    if (buffer[i] === 0x08) {
      if (i + 3 <= buffer.length) {
        const dataLen = (buffer[i + 1] << 8) | buffer[i + 2];
        const potentialEnd = i + dataLen + 3; 

        if (potentialEnd <= buffer.length) {
          const packet = buffer.slice(i, potentialEnd);
          const cmd = packet[3];
          
          let decoded: DecodedPacket = {
            cmd, id: packet[4], errorCode: 'N/A', raw: uint8ArrayToHex(packet)
          };

          if (cmd === 0x64) {
            const status = packet[6];
            decoded.status = status;
            if (status === 0x01) { 
              if (packet.length >= 14) {
                const countIdx = 7;
                decoded.count = ((packet[countIdx] << 24) | (packet[countIdx+1] << 16) | (packet[countIdx+2] << 8) | packet[countIdx+3]) >>> 0;
                decoded.errorCode = uint8ArrayToHex(packet.slice(11, 13)).replace(/\s/g, '');
              }
            } else if (status === 0x00) { 
              const countIdx = packet.length - 7;
              const errorIdx = packet.length - 3;
              decoded.count = ((packet[countIdx] << 24) | (packet[countIdx+1] << 16) | (packet[countIdx+2] << 8) | packet[countIdx+3]) >>> 0;
              decoded.errorCode = uint8ArrayToHex(packet.slice(errorIdx, errorIdx + 2)).replace(/\s/g, '');
              const epcLen = packet.length - 17;
              if (epcLen > 0) decoded.epc = uint8ArrayToHex(packet.slice(9, 9 + epcLen));
            }
          } 
          else if (cmd === 0x61) { 
            if (packet.length >= 7) {
                decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
                if (packet.length > 10) decoded.epc = uint8ArrayToHex(packet.slice(9, packet.length - 3));
            }
          }
          else if (cmd === 0x63) {
            if (packet.length >= 9) {
                // Error Code 位於封包末尾倒數第 3, 2 個 Byte (CRC 之前)
                decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
                // User Memory Data 從 index 9 開始到 Error Code 之前
                if (packet.length > 12) {
                    decoded.userData = uint8ArrayToHex(packet.slice(9, packet.length - 3));
                }
            }
          }
          else if (cmd === 0x70) {
            if (packet.length >= 9) {
              decoded.errorCode = uint8ArrayToHex(packet.slice(6, 8)).replace(/\s/g, '');
            }
          }
          else if (cmd === 0x35) {
            decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
            const fwHex = uint8ArrayToHex(packet.slice(5, packet.length - 3));
            decoded.fwVersion = hexToAscii(fwHex);
          }
          else if (cmd === 0xF0) {
            decoded.errorCode = '0001';
            if (packet.length >= 10) {
              decoded.updateCount = ((packet[5] << 24) | (packet[6] << 16) | (packet[7] << 8) | packet[8]) >>> 0;
            }
          }
          else if (cmd === 0xF1) {
            if (packet.length >= 9) {
              decoded.currentPacketNum = (packet[5] << 8) | packet[6];
              decoded.errorCode = uint8ArrayToHex(packet.slice(7, 9)).replace(/\s/g, '');
            }
          }
          else if (cmd === 0xF2) {
            if (packet.length >= 8) {
              decoded.errorCode = uint8ArrayToHex(packet.slice(5, 7)).replace(/\s/g, '');
            }
          }

          foundPackets.push(decoded);
          i += packet.length;
          continue;
        }
      }
    }
    i++;
  }
  return foundPackets;
};
