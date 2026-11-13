// Серверная нейросетевая озвучка немецкого (Edge Neural TTS: de-DE-KatjaNeural и de-DE-ConradNeural) с кэшированием в tts_cache
import crypto from 'node:crypto';
import tls from 'node:tls';
import { query } from './db.js';

export const VOICES = {
  female: 'de-DE-KatjaNeural',
  male: 'de-DE-ConradNeural',
  alt_female: 'de-DE-AmalaNeural',
  alt_male: 'de-DE-KillianNeural',
};

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_HOST = 'speech.platform.bing.com';
const EDGE_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH = 11644473600;

function generateSecMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  const strToHash = `${Math.round(ticks * 1e7)}${TRUSTED_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function resolveVoice(roleOrVoice = 'female') {
  const s = String(roleOrVoice || '').trim();
  if (Object.values(VOICES).includes(s)) return s;
  const low = s.toLowerCase();
  if (low === 'male' || low === 'm' || low === 'a' || low === 'conrad') return VOICES.male;
  if (low === 'alt_male' || low === 'killian') return VOICES.alt_male;
  if (low === 'alt_female' || low === 'amala') return VOICES.alt_female;
  return VOICES.female;
}

export function rateToPercent(rate = 1.0) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return '+0%';
  const clamped = Math.min(1.5, Math.max(0.5, r));
  const pct = Math.round((clamped - 1.0) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

export function ttsCacheKey(text, voice, ratePct) {
  return crypto
    .createHash('sha256')
    .update(`v1|${voice}|${ratePct}|${String(text).trim()}`)
    .digest('hex');
}

function makeWsFrame(opcode, payloadBuf) {
  const maskKey = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    maskKey.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    maskKey.copy(header, 10);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payloadBuf[i] ^ maskKey[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * Низкоуровневый синтез через WebSocket Edge Neural TTS (без внешних npm-зависимостей).
 */
export function synthesizeEdgeRaw(text, { voice = VOICES.female, ratePct = '+0%', timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID().replace(/-/g, '');
    const secGec = generateSecMsGec();
    const wsKey = crypto.randomBytes(16).toString('base64');
    const pathWithQuery = `${EDGE_PATH}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secGec}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${reqId}`;

    let settled = false;
    const audioChunks = [];
    let rxBuf = Buffer.alloc(0);
    let handshakeDone = false;

    const socket = tls.connect({ host: EDGE_HOST, port: 443, servername: EDGE_HOST });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error('edge-tts timeout'));
      }
    }, timeoutMs);

    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(buf);
    };

    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      if (!settled) {
        if (audioChunks.length > 0) finish(null, Buffer.concat(audioChunks));
        else finish(new Error('edge-tts closed without audio'));
      }
    });

    socket.on('secureConnect', () => {
      const reqHeaders = [
        `GET ${pathWithQuery} HTTP/1.1`,
        `Host: ${EDGE_HOST}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        '',
        '',
      ].join('\r\n');
      socket.write(reqHeaders);
    });

    function sendWsText(str) {
      socket.write(makeWsFrame(0x01, Buffer.from(str, 'utf8')));
    }

    function sendSsmlRequest() {
      const configMsg = [
        `X-Timestamp:${new Date().toISOString()}`,
        'Content-Type:application/json; charset=utf-8',
        'Path:speech.config',
        '',
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        }),
      ].join('\r\n');
      sendWsText(configMsg);

      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='de-DE'><voice name='${voice}'><prosody pitch='+0Hz' rate='${ratePct}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      const ssmlMsg = [
        `X-RequestId:${reqId}`,
        'Content-Type:application/ssml+xml',
        `X-Timestamp:${new Date().toISOString()}Z`,
        'Path:ssml',
        '',
        ssml,
      ].join('\r\n');
      sendWsText(ssmlMsg);
    }

    function processFrames() {
      while (rxBuf.length >= 2) {
        const byte0 = rxBuf[0];
        const byte1 = rxBuf[1];
        const opcode = byte0 & 0x0f;
        const isMasked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (rxBuf.length < 4) return;
          payloadLen = rxBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuf.length < 10) return;
          payloadLen = Number(rxBuf.readBigUInt64BE(2));
          offset = 10;
        }
        if (isMasked) offset += 4;
        if (rxBuf.length < offset + payloadLen) return;
        const payload = rxBuf.subarray(offset, offset + payloadLen);
        rxBuf = rxBuf.subarray(offset + payloadLen);

        if (opcode === 0x01) {
          // Текстовый фрейм: проверяем Path:turn.end
          const txt = payload.toString('utf8');
          if (txt.includes('Path:turn.end')) {
            if (audioChunks.length > 0) finish(null, Buffer.concat(audioChunks));
            else finish(new Error('edge-tts empty audio'));
            return;
          }
        } else if (opcode === 0x02 && payload.length > 2) {
          // Бинарный фрейм: первые 2 байта — длина заголовка, далее заголовки и MP3-данные
          const headerLen = payload.readUInt16BE(0);
          if (payload.length > 2 + headerLen) {
            const headerStr = payload.subarray(2, 2 + headerLen).toString('utf8');
            if (headerStr.includes('Path:audio')) {
              audioChunks.push(Buffer.from(payload.subarray(2 + headerLen)));
            }
          }
        } else if (opcode === 0x08) {
          if (audioChunks.length > 0) finish(null, Buffer.concat(audioChunks));
          else finish(new Error('edge-tts ws closed'));
          return;
        }
      }
    }

    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      if (!handshakeDone) {
        const sep = rxBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = rxBuf.subarray(0, sep).toString('utf8');
        rxBuf = rxBuf.subarray(sep + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          finish(new Error(`edge-tts handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;
        sendSsmlRequest();
      }
      processFrames();
    });
  });
}

/**
 * Синтезирует немецкую речь с кэшированием в таблице tts_cache.
 */
export async function synthesizeSpeech(text, { role = 'female', rate = 1.0, db = query } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!clean) throw new Error('empty text');
  const voice = resolveVoice(role);
  const ratePct = rateToPercent(rate);
  const cacheKey = ttsCacheKey(clean, voice, ratePct);

  try {
    const rows = await db(
      'SELECT audio, mime FROM tts_cache WHERE cache_key = ? LIMIT 1 /* scope-ok: global tts cache */',
      [cacheKey],
    );
    if (rows?.[0]?.audio) {
      return { audio: Buffer.from(rows[0].audio), mime: rows[0].mime || 'audio/mpeg', voice, cached: true };
    }
  } catch { /* таблица может ещё не существовать в тестах */ }

  const audio = await synthesizeEdgeRaw(clean, { voice, ratePct });
  try {
    await db(
      'INSERT IGNORE INTO tts_cache (cache_key, voice, mime, audio) VALUES (?, ?, ?, ?) /* scope-ok: global tts cache */',
      [cacheKey, voice, 'audio/mpeg', audio],
    );
  } catch { /* ignore */ }
  return { audio, mime: 'audio/mpeg', voice, cached: false };
}

