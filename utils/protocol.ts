
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

export interface DecodedPacket {
  cmd: number;
  status?: number;
  id: number;
  count?: number;
  errorCode: string;
  epc?: string;
  fwVersion?: string;
  raw: string;
}

/**
 * Build 64H (Read EPC Data Advance)
 * Request: SOF(1)+LEN(2)+CMD(1)+ID(1)+ANT(1)+PWR(2)+TMO(4)+CNT(4)+CRC(1) = 17 bytes
 */
export const build64HRequest = (id: number, antenna: number, power: number, timeoutMs: number, maxRecords: number): Uint8Array => {
  const packet = new Uint8Array(17);
  packet[0] = 0x80; 
  packet[1] = 0x00; 
  packet[2] = 0x0E; // CMD(1) + Data(12) + CRC(1) = 14
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
 * 通用響應解析器 (符合 64H 文件結構)
 */
export const scanAllPackets = (buffer: Uint8Array, expectedCmd: CommandType): DecodedPacket[] => {
  const foundPackets: DecodedPacket[] = [];
  let i = 0;

  while (i < buffer.length) {
    if (buffer[i] === 0x08) { // Response SOF
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
            // Byte 6 是 Status (0x00: 進行中, 0x01: 結束)
            const status = packet[6];
            decoded.status = status;

            if (status === 0x01) { 
              // 結束封包 (14 bytes): [08][00 0B][64][ID][ANT][01][COUNT:4][ERR:2][CRC]
              if (packet.length >= 14) {
                const countIdx = 7;
                decoded.count = ((packet[countIdx] << 24) | (packet[countIdx+1] << 16) | (packet[countIdx+2] << 8) | packet[countIdx+3]) >>> 0;
                decoded.errorCode = uint8ArrayToHex(packet.slice(11, 13)).replace(/\s/g, '');
              }
            } else if (status === 0x00) { 
              // 資料封包 (變長): [08][LEN][64][ID][ANT][00][RSSI:2][EPC:N][PWR:1][COUNT:4][ERR:2][CRC]
              // 固定欄位共 17 bytes (不含 EPC)
              const epcLen = packet.length - 17;
              if (epcLen > 0) {
                decoded.epc = uint8ArrayToHex(packet.slice(9, 9 + epcLen));
              }
              const countIdx = packet.length - 7;
              const errorIdx = packet.length - 3;
              decoded.count = ((packet[countIdx] << 24) | (packet[countIdx+1] << 16) | (packet[countIdx+2] << 8) | packet[countIdx+3]) >>> 0;
              decoded.errorCode = uint8ArrayToHex(packet.slice(errorIdx, errorIdx + 2)).replace(/\s/g, '');
            }
          } 
          else if (cmd === 0x61) { 
            if (packet.length >= 7) {
                decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
                if (packet.length > 10) {
                    decoded.epc = uint8ArrayToHex(packet.slice(9, packet.length - 3));
                }
            }
          }
          else if (cmd === 0x35) {
            decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
            const fwHex = uint8ArrayToHex(packet.slice(5, packet.length - 3));
            decoded.fwVersion = hexToAscii(fwHex);
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
