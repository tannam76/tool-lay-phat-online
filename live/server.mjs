// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch { } }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  autoChant: true, chantEveryMin: 3,
  scene: 'hall',                     // hall | outside | courtyard | bamboo
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s) { const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t: 'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity() { if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
const NUM_SKINS = {
  '1': 'man',
  '2': 'woman',
  '3': 'granny',
  '4': 'monk',
  '5': 'nun',
  '6': 'child',
  '7': 'master'
};

function skinFromText(t) {
  if (!t) return null;
  const raw = String(t).trim();

  // 1. Phím số nhanh: 1, 2, 3... hoặc !1, #1, /1, đổi 1, chọn 2, số 3, nv 4...
  const singleNum = raw.match(/^[!/#]?[0]*([1-7])$/);
  if (singleNum) return NUM_SKINS[singleNum[1]];

  const numCmd = raw.match(/(?:đổi|doi|chọn|chon|số|so|nv|nhân vật|nhan vat)\s*([1-7])(?:$|[\s\.,!])/i);
  if (numCmd) return NUM_SKINS[numCmd[1]];

  // 2. Lệnh tiền tố: !nam, !nu, /nam, /nu, #nam, #nu...
  const cmdMatch = raw.match(/^([!/#])([a-zA-ZÀ-ỹ0-9_]+)/i);
  if (cmdMatch) {
    const cmd = cmdMatch[2].toLowerCase().normalize('NFC');
    if (['nam', 'man', 'trai', 'anh'].includes(cmd)) return 'man';
    if (['nu', 'nữ', 'woman', 'gai', 'gái', 'chi', 'chị'].includes(cmd)) return 'woman';
    if (['ba', 'bà', 'aonau', 'áo nâu', 'cu', 'cụ', 'granny'].includes(cmd)) return 'granny';
    if (['tieu', 'tiểu', 'chutieu', 'chú tiểu', 'be', 'bé', 'child'].includes(cmd)) return 'child';
    if (['su', 'sư', 'thay', 'thầy', 'suthay', 'sư thầy', 'monk'].includes(cmd)) return 'monk';
    if (['ni', 'nico', 'ni cô', 'suco', 'sư cô', 'nun'].includes(cmd)) return 'nun';
    if (['caotang', 'cao tăng', 'truti', 'trụ trì', 'master'].includes(cmd)) return 'master';
  }

  // Chuẩn hóa văn bản
  let s = ' ' + raw.toLowerCase().normalize('NFC') + ' ';
  // Thay thế cụm 'nam mô' / 'nam mo' bằng từ khác để từ 'nam' trong 'nam mô' không bị nhận nhầm thành nhân vật Nam
  s = s.replace(/\s+nam\s*m[oô]\s+/gi, ' niệm ');
  const w = s.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return null;

  const pad = ' ' + w + ' ';
  const hasWord = (...words) => words.some(k => pad.includes(' ' + k + ' '));
  const hasAny = (...phrases) => phrases.some(k => pad.includes(k));

  // Kiểm tra ý định đổi nhân vật
  const isIntent = hasAny('đổi', 'doi', 'chọn', 'chon', 'chuyển', 'chuyen', 'sang', 'qua', 'thành', 'thanh', 'làm', 'lam', 'muốn', 'muon', 'xin', 'nhân vật', 'nhan vat', 'nv', 'hình', 'hinh', 'avatar', 'lấy', 'lay', 'cho mình', 'cho em', 'cho con', 'em là', 'mình là', 'con là', 'tôi là');
  const isShort = w.split(' ').length <= 3;

  // Cao tăng / Trụ trì
  if (hasAny('cao tăng', 'cao tang', 'đại sư', 'dai su', 'trụ trì', 'tru tri')) {
    return 'master';
  }

  // Sư cô / Ni cô (kiểm tra trước Sư thầy)
  if (hasAny('ni cô', 'ni co', 'sư cô', 'su co', 'cô ni', 'co ni') || hasWord('ni')) {
    if (isIntent || isShort) return 'nun';
  }

  // Sư thầy / Thầy chùa
  if (hasAny('sư thầy', 'su thay', 'thầy chùa', 'thay chua') || (hasWord('sư', 'su', 'thầy', 'thay') && !hasAny('sư cô', 'su co'))) {
    if (isIntent || isShort) return 'monk';
  }

  // Chú tiểu
  if (hasAny('chú tiểu', 'chu tieu', 'tiểu đồng', 'tieu dong') || hasWord('tiểu', 'tieu', 'bé', 'be')) {
    if (isIntent || isShort) return 'child';
  }

  // Bà áo nâu / Cụ bà
  if (hasAny('áo nâu', 'ao nau', 'bà cụ', 'ba cu', 'cụ bà', 'cu ba') || hasWord('bà', 'ba', 'cụ', 'cu')) {
    if (isIntent || isShort) return 'granny';
  }

  // Nữ
  if (hasAny('nữ áo lam', 'nu ao lam', 'bạn nữ', 'ban nu', 'con gái', 'con gai', 'phái nữ', 'phai nu') || hasWord('nữ', 'nu', 'chị', 'chi', 'gái', 'gai')) {
    if (isIntent || isShort) return 'woman';
  }

  // Nam (chỉ khi không phải 'nam mô' - 'nam mô' đã được chuyển thành 'niệm')
  if (hasAny('nam áo lam', 'nam ao lam', 'bạn nam', 'ban nam', 'con trai', 'phái nam', 'phai nam') || hasWord('nam', 'trai', 'anh')) {
    if (isIntent || isShort) return 'man';
  }

  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v) { return { id: v.id, name: v.name, skin: v.skin, avatar: v.avatar || '', coins: v.coins, demo: !!v.demo }; }
function snapshot() { return { t: 'state', settings, viewers: [...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState }; }

function seat(id, name, opts = {}) {
  id = String(id || name || 'user_' + Math.random().toString(36).slice(2, 7)).trim();
  let v = viewers.get(id);
  if (v) {
    v.lastAt = Date.now();
    if (name) v.name = String(name).slice(0, 18);
    if (opts.avatar) v.avatar = opts.avatar;
    return { v, isNew: false };
  }
  if (viewers.size >= 100) {                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a, b) => a.lastAt - b.lastAt)[0]
      || [...viewers.values()].sort((a, b) => a.coins - b.coins || a.lastAt - b.lastAt)[0];
    if (!quiet) return { v: null, isNew: false };
    viewers.delete(quiet.id); broadcast({ t: 'leave', id: quiet.id });
  }
  v = {
    id, name: String(name || id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
    avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo
  };
  viewers.set(id, v);
  broadcast({ t: 'join', v: pub(v), cap: capacity() });
  return { v, isNew: true };
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar) {
  id = String(id || name || 'user_' + Math.random().toString(36).slice(2, 7)).trim();
  name = String(name || id).slice(0, 18);
  text = String(text || '').slice(0, 120);
  const want = skinFromText(text);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!isNew && want && want !== v.skin) {
    v.skin = want;
    broadcast({ t: 'skin', id: v.id, skin: want });
    addLog(`🔄 ${v.name} đổi nhân vật: ${want}`);
  }
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t: 'chat', id: v.id, name: v.name, text, skin: v.skin });
}

function onGift(id, name, giftName, count, diamonds, avatar) {
  id = String(id || name || 'user_' + Math.random().toString(36).slice(2, 7)).trim();
  name = String(name || id).slice(0, 18);
  giftName = String(giftName || 'quà').trim().toLowerCase() === 'rose'
    ? 'hoa'
    : String(giftName || 'quà').slice(0, 30);
  count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const line = `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm dâng ${giftName}${count > 1 ? ', ' + count + ' lần' : ''}. ${prayer}.`;
  broadcast({ t: 'gift', id: v.id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag: 'gift', id: v.id });
}

function pickPrayer() {
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
    'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s) { return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }
function say(text, meta = {}) { if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }

async function synthesizeAudio(text, options, maxRetries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let tts = null;
    try {
      tts = new MsEdgeTTS();
      await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(esc(text), options);
      const chunks = [];
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        audioStream.on('data', c => chunks.push(c));
        audioStream.once('end', done);
        audioStream.once('close', done);
        audioStream.once('error', err => {
          if (!settled) {
            settled = true;
            // Nếu đã nhận đủ dữ liệu âm thanh (> 4KB) ở lần cuối cùng nhưng bị đóng bất ngờ, vẫn giữ được âm thanh
            if (chunks.length > 0 && Buffer.concat(chunks).length > 4096 && attempt === maxRetries) {
              resolve();
            } else {
              reject(err);
            }
          }
        });
      });
      try { tts.close(); } catch { }
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) return buf;
      throw new Error('Không nhận được dữ liệu âm thanh');
    } catch (e) {
      lastErr = e;
      try { tts?.close(); } catch { }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }
  throw lastErr;
}

async function pumpTTS() {
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    const options = {
      pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`,
      rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%`
    };
    const audioBuf = await synthesizeAudio(text, options, 3);
    fs.writeFileSync(path.join(TTS_DIR, file), audioBuf);
    broadcast({ t: 'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch { } }
  } catch (e) { addLog('TTS lỗi: ' + (e?.message || e)); }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
  'Chú Đại Bi (1/6): Nam mô hắc ra đát na đa ra dạ da. Nam mô a rị da. Bà lô yết đế thước bát ra da. Bồ đề tát đỏa bà da. Ma ha tát đỏa bà da. Ma ha ca lô ni ca da. Án, tát bàn ra phạt duệ, số đát na đát tỏa.',
  'Chú Đại Bi (2/6): Nam mô tất kiết lật đỏa y mông a rị da. Bà lô kiết đế thất Phật ra lăng đà bà. Nam mô na ra cẩn trì hê rị. Ma ha bàn đa sa mế. Tát bà a tha đậu du bằng. A thệ dựng. Tát bà tát đa, na ma bà tát đa. Na ma bà dà, ma phạt đạt đậu. Đát điệt tha.',
  'Chú Đại Bi (3/6): Án a bà lô hê, lô ca đế, ca ra đế, di hê rị. Ma ha bồ đề tát đỏa. Tát bà tát bà, ma ra ma ra. Ma hê ma hê rị đà dựng. Cu lô cu lô yết mông. Độ lô độ lô phạt xà da đế. Ma ha phạt xà da đế. Đà ra đà ra, địa rị ni, thất phật ra da.',
  'Chú Đại Bi (4/6): Giá ra giá ra, mạ mạ phạt ma ra, mục đế lệ. Y hê y hê, thất na thất na. A ra sâm phật ra xá lợi, phạt sa phạt sâm, phật ra xá da. Hô lô hô lô ma ra, hô lô hô lô hê rị. Ta ra ta ra, tất rị tất rị, tô rô tô rô. Bồ đề dạ bồ đề dạ, bồ đà dạ bồ đà dạ.',
  'Chú Đại Bi (5/6): Di đế rị dạ, na ra cẩn trì, địa rị sắc ni na, ba dạ ma na, ta bà ha. Tất đà dạ, ta bà ha. Ma ha tất đà dạ, ta bà ha. Tất đà du nghệ, thất bàn ra dạ, ta bà ha. Na ra cẩn trì, ta bà ha. Ma ra na ra, ta bà ha. Tất ra tăng a mục khê da, ta bà ha. Ta bà ma ha a tất đà dạ, ta bà ha.',
  'Chú Đại Bi (6/6): Giả kiết ra a tất đà dạ, ta bà ha. Ba đà ma yết tất đà dạ, ta bà ha. Na ra cẩn trì bàn dà ra dạ, ta bà ha. Ma bà lợi thắng yết ra dạ, ta bà ha. Nam mô hắc ra đát na đa ra dạ da. Nam mô a rị da. Bà lô yết đế thước bàn ra dạ, ta bà ha. Án tất điện đô, mạn đa ra, bạt đà dạ, ta bà ha.',
  'Bát Nhã Tâm Kinh: Sắc bất dị không, không bất dị sắc; sắc tức thị không, không tức thị sắc. Thọ, tưởng, hành, thức diệc phục như thị.',
  'Bát Nhã Tâm Kinh: Yết đế yết đế, ba la yết đế, ba la tăng yết đế, bồ đề tát bà ha.',
  'Nam mô Quán Thế Âm Bồ Tát. Nguyện học hạnh lắng nghe, nuôi dưỡng lòng từ bi, giúp muôn loài vơi khổ.',
];
let chantIdx = 0, chantTimer = null;
function chant() { const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t: 'chant', text }); say(text, { tag: 'chant' }); }
function scheduleChant() { clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
let isConnectingTikTok = false;
async function connectTikTok(uniqueId) {
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  if (isConnectingTikTok) return;
  isConnectingTikTok = true;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t: 'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, processInitialData: false });
    const av = u => u?.profilePictureUrl || u?.profilePicture?.url?.[0] || u?.profilePicture?.urlList?.[0] || u?.avatarThumb?.urlList?.[0] || u?.avatarThumb?.url?.[0] || u?.avatarMedium?.urlList?.[0] || u?.avatarLarge?.urlList?.[0] || '';
    const nm = u => String(u?.nickname || u?.displayId || u?.uniqueId || 'ẩn danh').trim();
    const uid = u => String(u?.userId || u?.idStr || (u?.id ? String(u.id) : '') || u?.uniqueId || u?.displayId || u?.secUid || u?.nickname || '').trim();
    conn.on(WebcastEvent.CHAT, d => {
      const u = d?.user || d || {};
      const text = d?.content || d?.comment || d?.text || '';
      onChat(uid(u), nm(u), text, av(u));
    });
    conn.on(WebcastEvent.GIFT, d => {
      const u = d?.user || d || {};
      const type = d?.gift?.type ?? d?.giftDetails?.giftType ?? d?.extendedGiftInfo?.type;
      if (type === 1 && !d?.repeatEnd) return;                       // streak still running
      const gname = d?.gift?.name || d?.gift?.describe || d?.giftDetails?.giftName || d?.extendedGiftInfo?.name || 'quà';
      const dia = d?.gift?.diamondCount ?? d?.diamondCount ?? d?.giftDetails?.diamondCount ?? d?.extendedGiftInfo?.diamond_count ?? 1;
      onGift(uid(u), nm(u), gname, d?.repeatCount || 1, dia, av(u));
      addLog(`🎁 ${nm(u)} tặng ${gname} x${d?.repeatCount || 1}`);
    });
    conn.on(WebcastEvent.MEMBER, d => {
      if (settings.joinOnEnter) {
        const u = d?.user || d || {};
        seat(uid(u), nm(u), { avatar: av(u) });
      }
    });
    conn.on(WebcastEvent.LIKE, d => {
      const u = d?.user || d || {};
      broadcast({ t: 'like', id: uid(u), n: d?.likeCount || d?.count || 1 });
    });
    conn.on(ControlEvent.DISCONNECTED, () => { tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t: 'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  } finally {
    isConnectingTikTok = false;
  }
  broadcast({ t: 'tiktok', ...tiktokState });
}
async function disconnectTikTok() { if (tiktok) { try { await tiktok.disconnect(); } catch { } tiktok = null; } tiktokState = { status: 'idle', uniqueId: '', error: '' }; broadcast({ t: 'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh', 'Minh Tâm', 'Thiện Đức', 'Huệ An', 'Tịnh Nhã', 'Quảng Trí', 'Chơn Như', 'Pháp Hỷ', 'Nguyên Thanh', 'Tâm Đăng', 'Diệu Liên', 'Trí Hải', 'Phước Lộc', 'Hạnh Nguyện', 'Như Ý', 'Bảo Châu', 'Thanh Lương', 'Từ Tâm', 'An Lạc', 'Giác Hoa', 'Tuệ Minh', 'Liên Hương', 'Thu Hà', 'Ngọc Lan', 'Đức Anh', 'Hải Đăng', 'Mai Anh', 'Phương Thảo', 'Trung Kiên', 'Quang Huy', 'Bảo Ngọc', 'Diệu Linh'];
function fillDemo(n) {
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++) {
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man', 'woman', 'woman', 'man', 'granny', 'monk', 'nun', 'child'][i % 8] });
  }
}
function clearSeats() { viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m) {
  switch (m.cmd) {
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t: 'bell' }); break;
    case 'mo': broadcast({ t: 'mo1' }); break;
    case 'unmute': broadcast({ t: 'unmute' }); break;
    case 'reload': broadcast({ t: 'reload' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag: 'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t: 'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  scene: v => ['hall', 'outside', 'courtyard', 'bamboo', 'dawn', 'moon', 'lotus', 'sunset'].includes(String(v)) ? String(v) : 'hall',
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o) { for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace) {
  clearInterval(botTimer); botTimer = null;
  if (on) {
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) {
      const name = DEMO_NAMES[(i + 7) % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
      seat('bot_' + i, name, { demo: true });
    }
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t: 'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t: 'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t: 'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath) {
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  }
});
function broadcast(msg, only) { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t: 'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Server listening on ${url}`);
  addLog(`🌐 Live server ready at ${url}`);
});
