const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BOT_SECRET = process.env.BOT_SECRET;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const BOT_PHONE = process.env.BOT_PHONE || '6283171692835';

// 🌐 PROXY – Aktifkan dengan setting environment variable PROXY_URL
// Contoh format:
// - HTTP:  http://user:pass@ip:port
// - SOCKS: socks5://user:pass@ip:port
const PROXY_URL = process.env.PROXY_URL || null;

let socketInstance = null;

// Fungsi untuk mendapatkan agent proxy
function getProxyAgent() {
  if (!PROXY_URL) return null;
  if (PROXY_URL.startsWith('socks')) {
    return new SocksProxyAgent(PROXY_URL);
  }
  return new HttpsProxyAgent(PROXY_URL);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  // Konfigurasi socket dengan proxy (jika ada)
  const sock = makeWASocket({
    auth: state,
    agent: getProxyAgent(), // 👈 KONEKSI VIA PROXY
  });

  // 🔐 Pairing Code
  if (!sock.authState.creds.registered) {
    console.log(`\n📱 Meminta Pairing Code untuk: ${BOT_PHONE}`);
    if (PROXY_URL) {
      console.log(`🌐 Menggunakan proxy: ${PROXY_URL.replace(/:[^:]*@/, ':****@')}`);
    }
    try {
      const code = await sock.requestPairingCode(BOT_PHONE);
      console.log('\n🔐 PAIRING CODE ANDA:');
      console.log('=================================');
      console.log(`      ${code}      `);
      console.log('=================================');
      console.log('\nBuka WhatsApp > Perangkat tertaut > Hubungkan perangkat');
      console.log('Masukkan kode di atas dalam waktu 5 menit.\n');
    } catch (err) {
      console.error('❌ Gagal meminta Pairing Code:', err.message);
      console.log('⏳ Mencoba ulang dalam 10 detik...');
      setTimeout(startBot, 10000);
      return;
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n🔳 QR Code (cadangan):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        '❌ Koneksi tertutup. Reconnect:',
        shouldReconnect ? 'YA' : 'TIDAK (logout)'
      );
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');
    }
  });

  // ---------- Handle pesan masuk ----------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

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
        timeout: 5000,
      });
    } catch (err) {
      console.error('❌ Gagal forward ke Netlify:', err.message);
    }
  });

  return sock;
}

// ---------- HTTP API ----------
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

app.get('/', (req, res) => {
  res.send('🤖 Bot WhatsApp QRIS dengan Proxy!');
});

startBot().then(sock => {
  socketInstance = sock;
  app.listen(PORT, () => {
    console.log(`🚀 Bot HTTP API running on port ${PORT}`);
  });
});
