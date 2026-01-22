/*
 * EasyVent WhatsApp Bot – 5 שרתים מקבילים עם חיווי READY אמיתי + סטטוס ב-Firebase + /health
 * whatsapp-web.js 1.28+, firebase-admin 13+, Node 18+
 *
 * ✅ שינוי מרכזי: lastSeen מתעדכן רק פעם ב-3 שעות (או בכוח באירועים חשובים),
 *    ולא בכל update קטן של state/count.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const http = require('http');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // macOS
const SERVER_ID = process.env.SERVER_ID || 'server1';
const DAILY_LIMIT = 50;

const HEALTH_PORT =
  Number(process.env.HEALTH_PORT || 0) ||
  (3100 + (Number(String(SERVER_ID).replace('server', '')) || 1));

function log(msg) {
  console.log(`[${SERVER_ID} ${new Date().toISOString()}] ${msg}`);
}

// --- תופסי קריסות כדי שתראה למה זה נופל ---
process.on('uncaughtException', (err) => {
  console.error(`[${SERVER_ID}] 💥 uncaughtException:`, err);
});
process.on('unhandledRejection', (err) => {
  console.error(`[${SERVER_ID}] 💥 unhandledRejection:`, err);
});

// ---------- Firebase ----------
const serviceAccount = require(path.join(__dirname, 'firebase-config.json'));

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://maarechet-automations-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const whatsappRef = db.ref('whatsapp');
const serverRef = db.ref(`servers/${SERVER_ID}`);

// ---------- lastSeen policy ----------
const LAST_SEEN_EVERY_MS = 3 * 60 * 60 * 1000; // 3 שעות
let lastSeenWrittenAt = 0;

// מעדכן סטטוסים/שדות "רגילים" בלי לגעת ב-lastSeen
async function updateServer(patch) {
  try {
    await serverRef.update({
      ...patch,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    console.error(`[${SERVER_ID}] updateServer failed: ${e.message}`);
  }
}

// מעדכן lastSeen בלבד (עם throttling)
async function touchLastSeen(force = false) {
  try {
    const now = Date.now();
    if (!force && lastSeenWrittenAt && now - lastSeenWrittenAt < LAST_SEEN_EVERY_MS) return;

    lastSeenWrittenAt = now;

    await serverRef.update({
      lastSeen: new Date().toISOString(),
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    console.error(`[${SERVER_ID}] touchLastSeen failed: ${e.message}`);
  }
}

// ---------- Health server (לבדיקת "השרת חי") ----------
let waState = 'booting';
let waReady = false;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        serverId: SERVER_ID,
        waState,
        waReady,
        time: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

healthServer.listen(HEALTH_PORT, () => {
  log(`🩺 health endpoint: http://localhost:${HEALTH_PORT}/health`);
});

// ---------- WhatsApp ----------
log('🔧 מאתחל WhatsApp client...');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: SERVER_ID }),
  puppeteer: {
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// סטטוס התחלה (בלי lastSeen כל רגע)
(async () => {
  await touchLastSeen(true);
  await updateServer({ status: 'booting', state: 'booting' });
})();

// ---------- Events ----------
client.on('qr', async (qr) => {
  qrcode.generate(qr, { small: true });
  waState = 'qr';
  waReady = false;

  log('📸 QR נוצר — סרוק בוואטסאפ > מכשירים מקושרים');
  if (process.send) process.send({ type: 'QR' });

  await touchLastSeen(true);
  await updateServer({ status: 'qr', state: 'qr' });
});

client.on('authenticated', async () => {
  waState = 'authenticated';
  log('🔐 AUTHENTICATED (נסגר עניין ההתחברות)');

  await touchLastSeen(true);
  await updateServer({ status: 'authenticated', state: 'authenticated' });
});

client.on('auth_failure', async (msg) => {
  waState = 'auth_failure';
  waReady = false;

  log(`❌ AUTH FAILURE: ${msg}`);
  if (process.send) process.send({ type: 'AUTH_FAILURE', error: msg });

  await touchLastSeen(true);
  await updateServer({ status: 'auth_failure', state: 'auth_failure', error: String(msg) });
});

client.on('loading_screen', (percent, message) => {
  waState = `loading_${percent}`;
  log(`⏳ loading: ${percent}% ${message || ''}`.trim());
});

// ⚠️ כאן אסור לעדכן lastSeen
client.on('change_state', async (state) => {
  waState = `state_${state}`;
  log(`🔁 WA state: ${state}`);

  await updateServer({ state: String(state) });
});

client.on('disconnected', async (reason) => {
  waState = 'disconnected';
  waReady = false;

  log(`⚠️ DISCONNECTED: ${reason}`);
  if (process.send) process.send({ type: 'DISCONNECTED', reason });

  await touchLastSeen(true);
  await updateServer({ status: 'disconnected', state: 'disconnected', reason: String(reason) });
});

// ---------- READY ----------
client.on('ready', async () => {
  waState = 'ready';
  waReady = true;

  log('✅ READY! הבוט מחובר ומוכן');
  if (process.send) process.send({ type: 'READY', serverId: SERVER_ID });

  await touchLastSeen(true);
  await updateServer({ status: 'online', state: 'ready', readyAt: new Date().toISOString() });

  // טען/אפס מונה יומי
  const today = new Date().toISOString().slice(0, 10);
  const snap = await serverRef.get();
  let sentCount = 0;

  if (snap.exists() && snap.val().date === today) {
    sentCount = Number(snap.val().count || 0);
  } else {
    sentCount = 0;
    await updateServer({ date: today, count: 0 });
  }

  // ✅ "סבב" lastSeen פעם ב-3 שעות בלבד
  const heartbeat = setInterval(async () => {
    await touchLastSeen(false); // מוגן throttling
    await updateServer({ status: waReady ? 'online' : 'booting', state: waState });
  }, LAST_SEEN_EVERY_MS);

  // מאזינים לשינויים
  const handleNode = async (userSnap) => {
    const userUid = userSnap.key;
    const userEvents = userSnap.val();
    if (!userEvents) return;

    for (const eventId of Object.keys(userEvents)) {
      const eventNode = userEvents[eventId] || {};

      for (const msgId of Object.keys(eventNode)) {
        const msgObj = eventNode[msgId];
        if (!msgObj) continue;

        const now = new Date();
        const schedTime = new Date(msgObj.scheduleMessage || 0);

        // תיקון: מקבל גם typo "peending"
        const statusVal = String(msgObj.status || '').toLowerCase();
        const isPending = statusVal === 'pending' || statusVal === 'peending';

        const readyToSend = msgObj.sms === 'no' && isPending && now >= schedTime;
        if (!readyToSend) continue;

        if (sentCount >= DAILY_LIMIT) {
          log(`🚫 הגיע למכסה היומית ${DAILY_LIMIT}`);
          return;
        }

        const msgRef = db.ref(`whatsapp/${userUid}/${eventId}/${msgId}`);

        // נעילה אטומית: מאפשר גם pending וגם peending
        const lockRes = await msgRef.transaction((current) => {
          if (!current) return;
          const st = String(current.status || '').toLowerCase();
          if (st !== 'pending' && st !== 'peending') return; // כבר מטופל
          return { ...current, status: 'sending', server: SERVER_ID };
        });

        if (!lockRes.committed) {
          log(`🔒 דילוג – הודעה כבר בתהליך / לא pending (${msgObj.formattedContacts})`);
          continue;
        }

        try {
          await new Promise((r) => setTimeout(r, 1200));
          const jid = `${msgObj.formattedContacts}@c.us`;

          if (msgObj.imageUrl) {
            const media = await MessageMedia.fromUrl(msgObj.imageUrl, { unsafeMime: true });
            await client.sendMessage(jid, media, { caption: msgObj.message || '' });
          } else {
            await client.sendMessage(jid, msgObj.message || '');
          }

          log(`📤 נשלחה הודעה ל-${msgObj.formattedContacts}`);

          await msgRef.update({
            status: 'sent',
            sentAt: new Date().toISOString(),
            server: SERVER_ID,
          });

          sentCount += 1;

          // ⚠️ עדכון מונה/תאריך בלי לגעת ב-lastSeen
          await updateServer({ date: today, count: sentCount });
        } catch (err) {
          log(`❌ שגיאה בשליחה ל-${msgObj.formattedContacts}: ${err.message}`);

          // מחזיר ל-pending כדי ששרת אחר יוכל לנסות
          await msgRef.update({ status: 'pending', lastError: String(err.message || err) });
        }
      }
    }
  };

  whatsappRef.on('child_added', handleNode);
  whatsappRef.on('child_changed', handleNode);

  // כיבוי מסודר
  async function gracefulShutdown() {
    clearInterval(heartbeat);

    log('🧯 כיבוי מסודר...');
    await touchLastSeen(true);
    await updateServer({ status: 'offline', state: 'offline' });

    try {
      whatsappRef.off('child_added', handleNode);
    } catch {}
    try {
      whatsappRef.off('child_changed', handleNode);
    } catch {}

    try {
      await client.destroy();
    } catch {}
    try {
      healthServer.close();
    } catch {}

    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  process.on('message', (m) => {
    if (m && m.type === 'SHUTDOWN') gracefulShutdown();
  });
});

client.initialize();
