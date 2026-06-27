// api/webhook.js — Bot Telegram GỘP: SnapFrame (chỉnh ảnh) + BotEditMes (chỉnh text)
//
// QUY TẮC THỨ TỰ: Với 1 update có CẢ ảnh và text/caption, ẢNH luôn được xử lý
// XONG trước, sau đó mới xử lý đến TEXT/CAPTION. Xem handleMessage() và
// handleChannelPost() ở Phần 4 — đó là nơi áp dụng thứ tự BƯỚC 1 (ảnh) →
// BƯỚC 2 (text).
//
// Toàn bộ logic xử lý ảnh (sharp, gradient, shadow...) và logic xử lý text
// (strip https, wrap <code>, bold dòng trigger, fallback khi quá dài...) được
// giữ NGUYÊN 100% so với 2 bot gốc — chỉ gộp lại 1 nơi và chạy tuần tự.

import sharp from 'sharp';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const EDIT_MARKER = '\u200b'; // Zero-width space — dấu hiệu bài đã được bot sửa text

const ALLOWED_IDS = new Set([
  1400175163,
  -1001578007378,
  -1002109878033,
]);

function isAllowed(id) {
  return ALLOWED_IDS.has(id);
}

// ════════════════════════════════════════════════════════════════════════
// PHẦN 1: CHỈNH ẢNH (nguyên bản từ SnapFrame bot)
// ════════════════════════════════════════════════════════════════════════

const GRADIENTS = [
  { name: 'Purple Dream', colors: ['#667eea', '#764ba2'] },
  { name: 'Pink Flamingo', colors: ['#f093fb', '#f5576c'] },
  { name: 'Ocean Blue', colors: ['#5eeff1', '#3598fb'] },
  { name: 'Lavender', colors: ['#a18cd1', '#fbc2eb'] },
  { name: 'Peach', colors: ['#ffecd2', '#fcb69f'] },
  { name: 'Dark Slate', colors: ['#0f172a', '#334155'] },
  { name: 'Cyber', colors: ['#00dbde', '#fc00ff'] },
  { name: 'Sunset', colors: ['#f6d365', '#fda085'] },
  { name: 'Mint', colors: ['#84fab0', '#8fd3f4'] },
  { name: 'Soft Sky', colors: ['#e0c3fc', '#8ec5fc'] },
];

const userSettings = new Map();

function getSettings(userId) {
  return userSettings.get(userId) || {
    padding: 60,
    borderRadius: 20,
    backgroundType: 'gradient',
    gradientIndex: 0,
    solidColor: '#ffffff',
    showWindowBar: false,
  };
}

function setSettings(userId, patch) {
  userSettings.set(userId, { ...getSettings(userId), ...patch });
}

async function downloadImage(fileId) {
  const res = await fetch(`${API}/getFile?file_id=${fileId}`);
  const { result } = await res.json();
  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${result.file_path}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

// Tạo shadow thực sự bằng sharp native blur (librsvg không support feGaussianBlur)
async function makeShadow(canvasW, canvasH, imgX, imgY, imgW, imgH, borderRadius, blurSigma, opacity) {
  const shapeSvg = Buffer.from(
    `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}"
            rx="${borderRadius}" ry="${borderRadius}"
            fill="rgba(0,0,0,${opacity})"/>
    </svg>`
  );

  return sharp(shapeSvg)
    .blur(blurSigma)
    .png()
    .toBuffer();
}

async function processImage(buffer, settings) {
  const { padding, borderRadius, backgroundType, gradientIndex, solidColor, showWindowBar } = settings;
  const gradient = GRADIENTS[gradientIndex % GRADIENTS.length];

  const meta = await sharp(buffer).metadata();
  let { width, height } = meta;

  const MAX_SIZE = 2000;
  let resizeOpts = {};
  if (width > MAX_SIZE || height > MAX_SIZE) {
    resizeOpts = { width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true };
  }

  const imgBuffer = Object.keys(resizeOpts).length
    ? await sharp(buffer).resize(resizeOpts).png().toBuffer()
    : await sharp(buffer).png().toBuffer();

  const imgMeta = await sharp(imgBuffer).metadata();
  width = imgMeta.width;
  height = imgMeta.height;

  const barHeight = showWindowBar ? 36 : 0;
  const innerHeight = height + barHeight;

  // Rounded mask
  const mask = Buffer.from(
    `<svg width="${width}" height="${innerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${innerHeight}" rx="${borderRadius}" ry="${borderRadius}" fill="white"/>
    </svg>`
  );

  // Window bar
  const windowBarSvg = showWindowBar
    ? Buffer.from(
        `<svg width="${width}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${width}" height="${barHeight}" fill="#f5f5f5"/>
          <rect x="0" y="${barHeight - 1}" width="${width}" height="1" fill="#e4e4e7"/>
          <circle cx="16" cy="${barHeight / 2}" r="5.5" fill="#ff5f57"/>
          <circle cx="32" cy="${barHeight / 2}" r="5.5" fill="#febc2e"/>
          <circle cx="48" cy="${barHeight / 2}" r="5.5" fill="#28c840"/>
        </svg>`
      )
    : null;

  const composites = [];
  if (windowBarSvg) composites.push({ input: windowBarSvg, top: 0, left: 0 });
  composites.push({ input: imgBuffer, top: barHeight, left: 0 });

  const framedContent = await sharp({
    create: { width, height: innerHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  // Apply rounded corners
  const roundedContent = await sharp(framedContent)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const canvasW = width + padding * 2;
  const canvasH = innerHeight + padding * 2;
  const shadowOffset = Math.round(padding * 0); // gôc 0.12

  // ─── Shadow layer 1: ambient (rộng, mờ) ─────────────────────────────────
  const ambientBlur = Math.max(4, Math.round(padding * 0.45)); // gốc 0.45
  const ambientShadow = await makeShadow(
    canvasW, canvasH,
    padding, padding + shadowOffset,
    width, innerHeight,
    borderRadius,
    ambientBlur,
    0.5 // gốc 0.5
  );

  // ─── Shadow layer 2: key (hẹp, sắc, dịch thêm xuống) ────────────────────
  const keyBlur = Math.max(2, Math.round(padding * 0.12)); // gốc 0.12
  const keyShadow = await makeShadow(
    canvasW, canvasH,
    padding + 2, padding + shadowOffset + 6, // gốc padding + 2, padding + shadowOffset + 6,
    width, innerHeight,
    borderRadius,
    keyBlur,
    0.35 // gốc 0.35
  );

  // ─── Background ──────────────────────────────────────────────────────────
  let bgSvg;
  if (backgroundType === 'gradient') {
    const [c1, c2] = gradient.colors;
    bgSvg = `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="100%" stop-color="${c2}"/>
        </linearGradient>
        <radialGradient id="hl" cx="30%" cy="15%" r="60%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.18)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>
      <rect width="${canvasW}" height="${canvasH}" fill="url(#g)"/>
      <rect width="${canvasW}" height="${canvasH}" fill="url(#hl)"/>
    </svg>`;
  } else {
    bgSvg = `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${canvasW}" height="${canvasH}" fill="${solidColor}"/>
    </svg>`;
  }

  // ─── Thin white border overlay (tạo cảm giác "lift") ─────────────────────
  const borderSvg = Buffer.from(
    `<svg width="${width}" height="${innerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${width - 1}" height="${innerHeight - 1}"
            rx="${borderRadius}" ry="${borderRadius}"
            fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
    </svg>`
  );

  // ─── Composite: bg → ambient shadow → key shadow → ảnh → border ─────────
  const result = await sharp(Buffer.from(bgSvg))
    .composite([
      { input: ambientShadow, blend: 'over' },
      { input: keyShadow, blend: 'over' },
      { input: roundedContent, left: padding, top: padding },
      { input: borderSvg, left: padding, top: padding },
    ])
    .png()
    .toBuffer();

  return result;
}

function buildSettingsKeyboard(userId) {
  const s = getSettings(userId);
  const grad = GRADIENTS[s.gradientIndex % GRADIENTS.length];

  return {
    inline_keyboard: [
      [
        { text: s.backgroundType === 'gradient' ? '🎨 Gradient ✓' : '🎨 Gradient', callback_data: 'bg:gradient' },
        { text: s.backgroundType === 'solid' ? '🟦 Solid ✓' : '🟦 Solid', callback_data: 'bg:solid' },
      ],
      [
        { text: '◀ Gradient', callback_data: 'grad:prev' },
        { text: `${grad.name}`, callback_data: 'grad:info' },
        { text: 'Gradient ▶', callback_data: 'grad:next' },
      ],
      [
        { text: `Padding: ${s.padding}px`, callback_data: 'pad:info' },
        { text: '➖', callback_data: 'pad:down' },
        { text: '➕', callback_data: 'pad:up' },
      ],
      [
        { text: `Radius: ${s.borderRadius}px`, callback_data: 'rad:info' },
        { text: '➖', callback_data: 'rad:down' },
        { text: '➕', callback_data: 'rad:up' },
      ],
      [
        {
          text: s.showWindowBar ? '🪟 Window Bar: ON' : '🪟 Window Bar: OFF',
          callback_data: 'win:toggle',
        },
      ],
      [{ text: '✅ Done', callback_data: 'settings:close' }],
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════
// PHẦN 2: CHỈNH TEXT (nguyên bản từ BotEditMes)
// ════════════════════════════════════════════════════════════════════════

const EXCLUDED_WORDS = new Set([
  'SHOPEE', 'LAZADA', 'TIKI', 'SENDO', 'GRAB', 'GOJEK', 'GOVIET',
  'MOMO', 'ZALOPAY', 'VNPAY', 'VNPT', 'VIETTEL', 'MOBIFONE',
  'CHUÂN', 'BỊ', 'SĂN', 'CÁC', 'BỘ', 'SỐ', 'NHÀ',
  'VOUCHER', 'FLASH', 'SALE', 'DEAL', 'FREE', 'SHIP', 'HOT', 'NEW',
  'VIP', 'APP', 'BOT', 'API', 'URL', 'SMS', 'OTP', 'PIN', 'ATM',
  'SIM', 'TOP', 'UY', 'TÍN', 'GIÁ', 'TỐT', 'MÃ', 'CODE',
  'GOM', 'ORDER', 'NOTE', 'LIVE', 'POST', 'LINK', 'PAGE',
  'GROUP', 'ADMIN', 'MOD', 'JOIN', 'CHAT', 'NEWS', 'OPEN',
  'FORM', 'USER', 'PASS', 'BUY', 'PAY', 'FAST',
  'MAX', 'MIN', 'GET', 'SET', 'ADD', 'YES', 'NO',
  'NOW', 'OFF', 'TAG', 'VND', 'USD', 'EUR',
  'KHO', 'HANG', 'MOI', 'CU', 'LIKE', 'SUB', 'VIEW',
  'TET', 'BLACK', 'FRIDAY', 'MEGA', 'SUPER', 'PLUS',
  'LIST', 'BACK',
]);

// Dùng trong inlineWrapCodes để skip token URL (rộng, tránh wrap nhầm)
function isUrl(token) {
  if (/^https?:\/\//i.test(token)) return true;
  if (/^www\./i.test(token)) return true;
  if (/[\w\-]+\.(com|vn|net|org|io|co|app|top|shop|info|biz|me|link|page|site|store|click|ly|gl)(\/\S*)?$/i.test(token)) return true;
  if (/[\/:]/.test(token)) return true;
  return false;
}

// Dùng trong boldLine — chặt hơn, không nhầm "25/4", "0h:", "300k/0đ"
function isRealUrl(token) {
  if (/^https?:\/\//i.test(token)) return true;
  if (/^www\./i.test(token)) return true;
  if (/^[\w\-]+\.[\w\-]+\.(com|vn|net|org|io|co|app|top|shop|info|biz|me|link|page|site|store|click|ly|gl)(\/\S*)?$/i.test(token)) return true;
  if (/^[\w\-]+\.(com|vn|net|org|io|co|app|top|shop|info|biz|me|link|page|site|store|click|ly|gl)(\/\S*)?$/i.test(token)) return true;
  return false;
}

function isCode(word) {
  const cleaned = word.replace(/^[^A-Z0-9a-z]+|[^A-Z0-9a-z]+$/gi, '');
  if (!cleaned) return false;
  if (/[./\\]/.test(cleaned)) return false;
  if (!/[A-Z]{2}/.test(cleaned)) return false;
  if (!/^[A-Z0-9]+$/.test(cleaned)) return false;
  if (cleaned.length < 3 || cleaned.length > 20) return false;
  if (EXCLUDED_WORDS.has(cleaned)) return false;
  if (/^\d+$/.test(cleaned)) return false;
  return true;
}

function stripHttps(text) {
  return text.replace(/https?:\/\//gi, '');
}

function inlineWrapCodes(text) {
  return text.replace(/(\S+)/g, (token) => {
    if (isUrl(token)) return token;
    const match = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][^\s]*)([^A-Za-z0-9]*)$/);
    if (!match) return token;
    const [, prefix, core, suffix] = match;
    if (isCode(core)) return `${prefix}<code>${core}</code>${suffix}`;
    return token;
  });
}

const BOLD_TRIGGER_EMOJIS = ['📌', '🔥', '⚡️', '⚡'];

function isBoldTriggerLine(line) {
  const trimmed = line.trimStart();
  if (/^\d+[.)]\s/.test(trimmed)) return true;
  for (const emoji of BOLD_TRIGGER_EMOJIS) {
    if (trimmed.startsWith(emoji)) return true;
  }
  return false;
}

function boldLine(line) {
  const tokens = line.split(/(\s+)/);
  let firstUrlIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].trim();
    if (!t) continue;
    const stripped = t.replace(/<[^>]+>/g, '');
    if (isRealUrl(stripped)) { firstUrlIndex = i; break; }
  }
  if (firstUrlIndex === -1) return `<b>${line}</b>`;
  const beforeText = tokens.slice(0, firstUrlIndex).join('').trimEnd();
  const rest = line.slice(beforeText.length);
  if (!beforeText.trim()) return line;
  return `<b>${beforeText}</b>${rest}`;
}

function applyLineBolding(text) {
  return text.split('\n').map(line =>
    isBoldTriggerLine(line) ? boldLine(line) : line
  ).join('\n');
}

// ─── Giới hạn ký tự của Telegram — KHÁC NHAU giữa text thường và caption ──
//
//  - Tin nhắn text thường (editMessageText):    tối đa 4096 ký tự
//  - Caption của ảnh/video/file (editMessageCaption): tối đa CHỈ 1024 ký tự
//
// Bug cũ: code dùng chung 1 mốc 4096 cho cả 2 trường hợp. Với caption dài
// 1024–4096 ký tự (sau khi bold + wrap code), code tưởng "vẫn ổn" rồi gọi
// editMessageCaption, nhưng Telegram âm thầm từ chối (chỉ log warning, không
// ai thấy) → đúng hiện tượng "tin dài thì không sửa, tách ngắn ra thì sửa
// được".

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

// ─── Pipeline với fallback khi quá dài ───────────────────────────────────
//
//  Level 1 (full):     stripHttps → inlineWrapCodes → applyLineBolding
//  Level 2 (no code):  stripHttps → applyLineBolding          (bỏ <code>)
//  Level 3 (minimal):  stripHttps                              (bỏ cả bold)
//
// Lý do cần fallback: mỗi <code>token</code> thêm 13 ký tự,
// tin dài nhiều mã AFF có thể đẩy tổng vượt giới hạn của Telegram.

function buildFinal(text, limit) {
  // Level 1 — full
  let result = applyLineBolding(inlineWrapCodes(stripHttps(text)));
  if ((result + EDIT_MARKER).length <= limit) return result;

  // Level 2 — bỏ bold, giữ <code> + strip https
  console.warn('Fallback level 2: bỏ bold, giữ <code> + strip https');
  result = inlineWrapCodes(stripHttps(text));
  if ((result + EDIT_MARKER).length <= limit) return result;

  // Level 3 — chỉ strip https
  console.warn('Fallback level 3: chỉ strip https');
  result = stripHttps(text);
  if ((result + EDIT_MARKER).length <= limit) return result;

  return null;
}

function hasMedia(message) {
  return !!(
    message.photo || message.video || message.document ||
    message.animation || message.audio || message.voice || message.sticker
  );
}

// ════════════════════════════════════════════════════════════════════════
// PHẦN 3: GỌI TELEGRAM API (dùng chung cho cả 2 chức năng)
// ════════════════════════════════════════════════════════════════════════

async function callAPI(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return callAPI('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function sendTyping(chatId) {
  return callAPI('sendChatAction', { chat_id: chatId, action: 'upload_photo' });
}

async function sendPhoto(chatId, buffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'snapframe.png');
  if (caption) form.append('caption', caption);
  await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
}

async function editMessageText(chatId, messageId, newText) {
  const data = await callAPI('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  if (!data.ok) console.warn('editMessageText failed:', data.description);
  return data;
}

async function editMessageCaption(chatId, messageId, newCaption) {
  const data = await callAPI('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption: newCaption,
    parse_mode: 'HTML',
  });
  if (!data.ok) console.warn('editMessageCaption failed:', data.description);
  return data;
}

// ════════════════════════════════════════════════════════════════════════
// PHẦN 4: XỬ LÝ TỪNG LOẠI UPDATE — ĐÂY LÀ NƠI QUYẾT ĐỊNH THỨ TỰ ẢNH → TEXT
// ════════════════════════════════════════════════════════════════════════

// ── Callback query (nút bấm trong /settings) — chỉ liên quan đến chỉnh ảnh ──
async function handleCallbackQuery(callback_query) {
  const { id, from, message, data } = callback_query;
  const userId = from.id;
  const chatId = message.chat.id;
  const msgId = message.message_id;
  const s = getSettings(userId);

  if (data === 'bg:gradient') setSettings(userId, { backgroundType: 'gradient' });
  else if (data === 'bg:solid') setSettings(userId, { backgroundType: 'solid' });
  else if (data === 'grad:next') setSettings(userId, { gradientIndex: (s.gradientIndex + 1) % GRADIENTS.length });
  else if (data === 'grad:prev') setSettings(userId, { gradientIndex: (s.gradientIndex - 1 + GRADIENTS.length) % GRADIENTS.length });
  else if (data === 'pad:up') setSettings(userId, { padding: Math.min(s.padding + 10, 120) });
  else if (data === 'pad:down') setSettings(userId, { padding: Math.max(s.padding - 10, 10) });
  else if (data === 'rad:up') setSettings(userId, { borderRadius: Math.min(s.borderRadius + 4, 48) });
  else if (data === 'rad:down') setSettings(userId, { borderRadius: Math.max(s.borderRadius - 4, 0) });
  else if (data === 'win:toggle') setSettings(userId, { showWindowBar: !s.showWindowBar });
  else if (data === 'settings:close') {
    await callAPI('answerCallbackQuery', { callback_query_id: id });
    await callAPI('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: '✅ Đã lưu cài đặt! Gửi ảnh để áp dụng.',
    });
    return;
  }

  await callAPI('answerCallbackQuery', { callback_query_id: id });
  await callAPI('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: msgId,
    reply_markup: buildSettingsKeyboard(userId),
  });
}

// ── Gửi lại ảnh đã framed cho tin nhắn riêng/nhóm (reply bằng ảnh mới) ──────
async function handleImageReply(chatId, userId, message) {
  await sendTyping(chatId);
  try {
    let fileId;
    if (message.photo) {
      fileId = message.photo[message.photo.length - 1].file_id;
    } else {
      fileId = message.document.file_id;
    }

    const imgBuffer = await downloadImage(fileId);
    const settings = getSettings(userId);
    const processed = await processImage(imgBuffer, settings);

    const grad = GRADIENTS[settings.gradientIndex % GRADIENTS.length];
    const bgLabel = settings.backgroundType === 'gradient' ? grad.name : 'Solid';

    await sendPhoto(chatId, processed, `✨ Framed! — ${bgLabel} • ${settings.padding}px padding • r${settings.borderRadius}`);
  } catch (err) {
    console.error('Processing error:', err);
    await sendMessage(chatId, '❌ Có lỗi xử lý ảnh. Thử lại nhé!\n\n<code>' + err.message + '</code>');
  }
}

// Sửa text/caption TẠI CHỖ của 1 message/post (logic của BotEditMes).
// Hàm này luôn được gọi SAU phần xử lý ảnh (nếu có ảnh trong cùng update).
async function tryEditMessageInPlace(message) {
  const isMediaMessage = hasMedia(message);
  const rawText = message.text || message.caption || '';
  if (!rawText) return;

  // Bỏ HẾT ký tự EDIT_MARKER trong text trước khi xử lý (kể cả khi nó xuất
  // hiện không phải do bot vừa sửa, mà do người dùng copy lại 1 tin ĐÃ được
  // bot sửa trước đó để làm mẫu cho tin mới — ký tự ẩn này vẫn dính theo dù
  // nội dung hiển thị đã khác). Trước đây code chỉ cần thấy CÓ ký tự này là
  // bỏ qua toàn bộ tin → đúng nguyên nhân khiến tin "đã đổi nội dung nhưng
  // vẫn bị bỏ qua, không sửa, mà cũng không gọi API gì cả" (chạy ~27ms, 0
  // outgoing request). Giờ thay vì bỏ qua hẳn, ta lọc sạch ký tự ẩn rồi so
  // sánh nội dung THẬT — vẫn giữ nguyên tác dụng chống tự-sửa-lặp-vô-hạn
  // (nếu nội dung sau khi lọc không đổi gì thêm thì vẫn return ở dòng dưới).
  const text = rawText.split(EDIT_MARKER).join('');

  // Caption (ảnh/video/file) giới hạn 1024 ký tự, text thường giới hạn 4096
  const limit = isMediaMessage ? CAPTION_LIMIT : TEXT_LIMIT;
  const wrapped = buildFinal(text, limit);
  if (wrapped === null) {
    console.warn(`Tin quá dài kể cả sau fallback (limit=${limit}), bỏ qua:`, text.length);
    return;
  }
  if (wrapped === text) return; // Không có gì thay đổi

  const final = wrapped + EDIT_MARKER;

  if (isMediaMessage) {
    // Giữ delay 3.5s như bot gốc (để UI Telegram ổn định trước khi sửa caption).
    // Khác với trước đây, delay này KHÔNG còn phải "chạy đua" với bot ảnh nữa,
    // vì bước ảnh ở handleMessage/handleChannelPost đã await xong trước khi
    // tới đây — thứ tự ảnh → text được đảm bảo chắc chắn, không phải may rủi.
    await new Promise(r => setTimeout(r, 3500));
    await editMessageCaption(message.chat.id, message.message_id, final);
  } else {
    await editMessageText(message.chat.id, message.message_id, final);
  }
}

// ── Tin nhắn riêng / nhóm (update.message) ──────────────────────────────
async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.trim();

  if (text === '/start') {
    await sendMessage(
      chatId,
      `👋 Xin chào! Mình là <b>SnapFrame Bot</b> 🖼

Gửi cho mình một ảnh bất kỳ, mình sẽ tự động:
• Bo tròn góc ảnh
• Thêm nền màu/gradient đẹp
• Thêm shadow

<b>Lệnh:</b>
/settings — Chỉnh style (gradient, padding, radius...)
/help — Hướng dẫn chi tiết`
    );
  } else if (text === '/settings') {
    const s = getSettings(userId);
    const grad = GRADIENTS[s.gradientIndex % GRADIENTS.length];
    await callAPI('sendMessage', {
      chat_id: chatId,
      text: `⚙️ <b>Cài đặt hiện tại:</b>\n\nNền: ${s.backgroundType === 'gradient' ? `Gradient - ${grad.name}` : `Solid - ${s.solidColor}`}\nPadding: ${s.padding}px\nRadius: ${s.borderRadius}px\nWindow Bar: ${s.showWindowBar ? 'Bật' : 'Tắt'}`,
      parse_mode: 'HTML',
      reply_markup: buildSettingsKeyboard(userId),
    });
  } else if (text === '/help') {
    await sendMessage(
      chatId,
      `📖 <b>Hướng dẫn dùng SnapFrame Bot</b>

1. Gửi ảnh bất kỳ → bot trả về ảnh đã được framed
2. Dùng /settings để tùy chỉnh style trước khi gửi ảnh

<b>Tùy chỉnh có:</b>
• <b>Background:</b> Gradient (10 màu) hoặc Solid
• <b>Padding:</b> Khoảng cách viền (10–120px)
• <b>Radius:</b> Bo tròn góc (0–48px)
• <b>Window Bar:</b> Thêm thanh macOS giả

<i>Mẹo: Gửi ảnh screenshot sẽ trông rất đẹp! 🎨</i>`
    );
  } else if (message.photo || message.document?.mime_type?.startsWith('image/')) {
    // BƯỚC 1: xử lý ẢNH trước — gửi trả ảnh đã framed
    await handleImageReply(chatId, userId, message);
  } else if (text && !text.startsWith('/')) {
    await sendMessage(chatId, '📸 Gửi ảnh cho mình nhé! Dùng /settings để tùy chỉnh style.');
  }

  // BƯỚC 2: sửa TEXT tại chỗ — luôn chạy sau bước ảnh ở trên (nếu có).
  // Lưu ý: việc sửa text-tại-chỗ chỉ thực sự có tác dụng khi bot có quyền
  // edit message đó (đúng như hành vi gốc của BotEditMes — với tin nhắn do
  // chính người dùng gửi trong chat riêng, Telegram có thể từ chối lệnh edit,
  // hàm sẽ chỉ log cảnh báo và không làm gì thêm, không ảnh hưởng bước 1).
  await tryEditMessageInPlace(message);
}

// ── Channel post (update.channel_post) ───────────────────────────────────

// Thay ảnh trong channel post bằng bản đã framed, giữ nguyên caption gốc
// (caption sẽ được PHẦN TEXT chỉnh tiếp ở bước sau).
async function processChannelImage(post) {
  const chatId = post.chat.id;
  const msgId = post.message_id;

  try {
    let fileId;
    if (post.photo) {
      fileId = post.photo[post.photo.length - 1].file_id;
    } else {
      fileId = post.document.file_id;
    }

    const imgBuffer = await downloadImage(fileId);
    const processed = await processImage(imgBuffer, {
      padding: 30,
      borderRadius: 20,
      backgroundType: 'solid',
      gradientIndex: 0,
      solidColor: '#ffffff',
      showWindowBar: false,
    });

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('message_id', String(msgId));
    const mediaJson = { type: 'photo', media: 'attach://photo' };
    if (post.caption) {
      mediaJson.caption = post.caption;
      if (post.caption_entities) mediaJson.caption_entities = post.caption_entities;
    }
    form.append('media', JSON.stringify(mediaJson));
    form.append('photo', new Blob([processed], { type: 'image/png' }), 'framed.png');

    await fetch(`${API}/editMessageMedia`, { method: 'POST', body: form });
  } catch (err) {
    console.error('Channel post image error:', err);
  }
}

async function handleChannelPost(post) {
  const hasImage = !!(post.photo || post.document?.mime_type?.startsWith('image/'));

  // BƯỚC 1: xử lý ẢNH trước (nếu post có ảnh) — chờ xong hoàn toàn rồi mới qua bước 2
  if (hasImage) {
    await processChannelImage(post);
  }

  // BƯỚC 2: xử lý TEXT/CAPTION sau — luôn chạy, kể cả khi post không có ảnh
  // (post text thuần thì chỉ có bước này, giống hệt BotEditMes gốc).
  await tryEditMessageInPlace(post);
}

// ════════════════════════════════════════════════════════════════════════
// PHẦN 5: HANDLER CHÍNH
// ════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, status: 'Bot is running 🤖' });
  }
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;

  const incomingId = update.message?.chat.id
    || update.callback_query?.message.chat.id
    || update.channel_post?.chat.id;

  if (!incomingId || !isAllowed(incomingId)) {
    return res.status(200).json({ ok: true });
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.channel_post) {
      await handleChannelPost(update.channel_post);
    } else if (update.message) {
      await handleMessage(update.message);
    }
    // Không xử lý edited_message / edited_channel_post để tránh vòng lặp
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  return res.status(200).json({ ok: true });
}
