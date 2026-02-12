const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BOT_SECRET = process.env.BOT_SECRET;
const SESSION_PATH = './auth_info';

let socketInstance = null;

// ---------- Baileys Core ----------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

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
      });
    } catch (err) {
      console.error('❌ Forward ke Netlify gagal:', err.message);
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
    const imageBuffer = await axios.get(imageUrl, { responseType: 'arraybuffer' }).then(r => r.data);
    await socketInstance.sendMessage(`${to}@s.whatsapp.net`, {
      image: imageBuffer,
      caption,
    });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start ----------
startBot().then(sock => {
  socketInstance = sock;
  app.listen(PORT, () => {
    console.log(`🚀 Bot HTTP API running on port ${PORT}`);
  });
});
