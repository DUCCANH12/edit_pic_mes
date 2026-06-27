// api/setup.js — Đăng ký / kiểm tra / xoá webhook cho bot gộp
//
//   GET /api/setup?secret=YOUR_SECRET                 → đăng ký webhook
//   GET /api/setup?secret=YOUR_SECRET&action=info      → xem thông tin webhook hiện tại
//   GET /api/setup?secret=YOUR_SECRET&action=delete     → xoá webhook
//
// LƯU Ý QUAN TRỌNG: khác với script setup-webhook.mjs cũ của bot ảnh (chỉ khai
// allowed_updates = ['message','callback_query']), bot gộp BẮT BUỘC phải có
// 'channel_post' trong allowed_updates, nếu không Telegram sẽ không gửi các
// bài đăng trong channel tới webhook và phần xử lý ảnh/text trong channel sẽ
// không bao giờ được gọi tới.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SETUP_SECRET = process.env.SETUP_SECRET || 'changeme';

export default async function handler(req, res) {
  const { secret, action } = req.query;
  if (secret !== SETUP_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden — wrong secret' });
  }

  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/webhook`;

  try {
    if (action === 'delete') {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
      const data = await r.json();
      return res.status(200).json({ action: 'deleted', result: data });
    }

    if (action === 'info') {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const data = await r.json();
      return res.status(200).json(data);
    }

    // Đăng ký webhook — khai báo đủ allowed_updates cho cả 2 chức năng (ảnh + text)
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'channel_post', 'callback_query'],
        drop_pending_updates: true,
      }),
    });
    const data = await r.json();
    return res.status(200).json({ action: 'set', webhookUrl, result: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
