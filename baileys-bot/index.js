const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BOT_SECRET = process.env.BOT_SECRET;

// 🔥 Gunakan environment variable untuk auth folder, default ke ./auth_info
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';

let socketInstance = null;

// ---------- Baileys Core ----------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    // Hapus printQRInTerminal – kita pakai event sendiri
  });

  // Simpan credentials setiap ada update
  sock.ev.on('creds.update', saveCreds);

  // ----- Handle koneksi dan QR Code -----
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n🔐 Scan QR code ini dengan nomor WhatsApp sekunder:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        '❌ Koneksi tertutup. Reconnect:',
        shouldReconnect ? 'YA' : 'TIDAK (logout)'
      );
      if (shouldReconnect) {
        startBot(); // reconnect otomatis
      }
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');
    }
  });

  // ----- Handle pesan masuk -----
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    // Kirim ke Netlify Function
    try {
      await axios.post(WEBHOOK_URL, {
        sender,
        text,
        timestamp: msg.messageTimestamp,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Token': BOT_SECRET,
        },
        timeout: 5000, // timeout 5 detik
      });
    } catch (err) {
      console.error('❌ Gagal forward ke Netlify:', err.message);
    }
  });

  return sock;
}

// ---------- HTTP API untuk menerima perintah dari PHP ----------
app.post('/send-text', async (req, res) => {
  const { to, text } = req.body;
  const token = req.headers['x-bot-token'];

  if (token !== BOT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!socketInstance) return res.status(503).json({ error: 'Bot not ready' });

  try {
    await socketInstance.sendMessage(`${to}@s.whatsapp.net`, { text });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-image', async (req, res) => {
  const { to, imageUrl, caption } = req.body;
  const token = req.headers['x-bot-token'];

  if (token !== BOT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!socketInstance) return res.status(503).json({ error: 'Bot not ready' });

  try {
    const imageBuffer = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    }).then(r => r.data);
    await socketInstance.sendMessage(`${to}@s.whatsapp.net`, {
      image: imageBuffer,
      caption,
    });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ (Opsional) Route sederhana untuk cek status
app.get('/', (req, res) => {
  res.send('🤖 Bot WhatsApp QRIS berjalan!');
});

// ---------- Start ----------
startBot().then(sock => {
  socketInstance = sock;
  app.listen(PORT, () => {
    console.log(`🚀 Bot HTTP API running on port ${PORT}`);
  });
});
