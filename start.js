/**
 * EasyVent WhatsApp Bot (start.js) — CLEAN BOOT + AUTO SERVER_ID
 * ✅ 5 שרתים מקבילים (Auto allocate server1/server2/… אם אין ENV)
 * ✅ נעילה אטומית להודעות + Lease כדי למנוע stuck על sending
 * ✅ retries עם backoff (status=error + retryAt)
 * ✅ dailyLimit per-server מה-Firebase (servers/{serverId}/dailyLimit)
 * ✅ סטטיסטיקות זמן: שעה / 12 שעות / יום / שבוע / חודש / שנה
 * ✅ Process Lock כדי שלא ירוצו 2 תהליכים על אותו SERVER_ID
 * ✅ processLock heartbeat פעם ב-2 שעות + onDisconnect remove
 * ✅ lastSeen פעם ב-2 שעות
 * ✅ health server עולה רק אחרי processLock
 *
 * whatsapp-web.js 1.28+, firebase-admin 13+, Node 18+
 */

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const admin = require("firebase-admin");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { getOrCreateServerId } = require("./serverId");

// ================== ENV / CONFIG ==================
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DEFAULT_DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 50);
const HEADLESS =
  process.env.HEADLESS
    ? String(process.env.HEADLESS).toLowerCase() !== "false"
    : true; // ברירת מחדל: בלי חלון דפדפן

// כמה זמן הודעה יכולה להיות "sending" לפני ששרת אחר יכול להשתלט
const LOCK_LEASE_MS = 2 * 60 * 1000; // 2 דקות

// backoff לריטריי
const RETRY_BASE_MS = 30 * 1000; // 30 שניות
const RETRY_MAX_MS = 15 * 60 * 1000; // 15 דקות
const MAX_ATTEMPTS = 6;

// Process lock heartbeat (לא לחפור - פעם ב-2 שעות)
const PROC_HEARTBEAT_MS = 2 * 60 * 60 * 1000; // 2 שעות
const PROC_STALE_MS = PROC_HEARTBEAT_MS + 10 * 60 * 1000; // 2h + 10m

// ================== FIREBASE (ADMIN) ==================
const serviceAccount = require(path.join(__dirname, "firebase-config.json"));

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://maarechet-automations-default-rtdb.firebaseio.com",
  });
}

// ================== HELPERS ==================
function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function sanitizePhone(s) {
  const str = String(s || "");
  return str.replace(/[^\d]/g, "");
}

function parseSchedule(s) {
  if (!s) return new Date(0);
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function calcBackoffMs(attempts) {
  const pow = Math.max(0, attempts - 1);
  const ms = RETRY_BASE_MS * Math.pow(2, pow);
  return Math.min(RETRY_MAX_MS, ms);
}

function normalizeBool(v, def = true) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return def;
}

function normalizeNumber(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad2(weekNo)}`;
}

function timeKeys(date = new Date()) {
  const isoDay = date.toISOString().slice(0, 10);
  const hour = pad2(date.getHours());
  const half = date.getHours() < 12 ? "H1" : "H2";
  const month = date.toISOString().slice(0, 7);
  const year = date.toISOString().slice(0, 4);
  const week = isoWeekKey(date);
  return { isoDay, hour, half, month, year, week };
}

// ================== CHROME SINGLETON CLEANUP ==================
function cleanupChromeSingletonLocks(SERVER_ID, log) {
  // LocalAuth יוצר: .wwebjs_auth/session-${SERVER_ID}
  const sessionDir = path.join(__dirname, ".wwebjs_auth", `session-${SERVER_ID}`);
  const files = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

  try {
    if (!fs.existsSync(sessionDir)) return;

    for (const f of files) {
      const p = path.join(sessionDir, f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        log(`🧹 removed leftover ${f} from ${sessionDir}`);
      }
    }
  } catch (e) {
    log(`⚠️ cleanupChromeSingletonLocks skipped: ${e.message}`);
  }
}

// ================== MAIN BOOT ==================
(async () => {
  const db = admin.database();

  // ✅ SERVER_ID: אם יש ENV – נשתמש בו, אחרת אוטומטי (server1/server2/…)
let SERVER_ID = process.env.SERVER_ID;

if (!SERVER_ID) {
  console.error("❌ Missing SERVER_ID. Run like: SERVER_ID=server1 node start.js");
  process.exit(1);
}

SERVER_ID = String(SERVER_ID).trim().toLowerCase();


  // log אחרי שיש לנו SERVER_ID
  function log(msg) {
    console.log(`[${SERVER_ID} ${new Date().toISOString()}] ${msg}`);
  }

  // תופסי קריסות (אחרי שה־SERVER_ID קיים)
  process.on("uncaughtException", (err) => {
    console.error(`[${SERVER_ID}] 💥 uncaughtException:`, err);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[${SERVER_ID}] 💥 unhandledRejection:`, err);
  });

  // HEALTH_PORT לפי המספר שבשרת (או override מה-ENV)
  const n = Number(String(SERVER_ID).replace("server", "")) || 1;
function stablePortFromId(id, base = 3100, range = 2000) {
  let h = 0;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return base + (Math.abs(h) % range);
}

// במקום החישוב הישן:
const HEALTH_PORT =
  Number(process.env.HEALTH_PORT || 0) || stablePortFromId(SERVER_ID);

  // refs
  const whatsappRef = db.ref("whatsapp");
  const serverRef = db.ref(`servers/${SERVER_ID}`);
  const processLockRef = db.ref(`servers/${SERVER_ID}/processLock`);
const cmdRef = db.ref(`serverCommands/${SERVER_ID}`);
let cmdBusy = false;

function rmSessionDir() {
  const sessionDir = path.join(__dirname, ".wwebjs_auth", `session-${SERVER_ID}`);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    log(`🧹 removed session dir: ${sessionDir}`);
  } catch (e) {
    log(`⚠️ session dir cleanup skipped: ${e.message}`);
  }
}

async function restartClient(reason = "restart") {
  log(`♻️ restartClient: ${reason}`);

  try { if (client) await client.destroy(); } catch {}
  client = null;

  cleanupChromeSingletonLocks(SERVER_ID, log);

  waState = "booting";
  waReady = false;
  await updateServer({ status: "booting", state: "restarting" }, { touchUpdatedAt: true }).catch(() => {});

  setupWhatsAppClient();
  client.initialize();
}

async function handleCommand(cmd) {
  const action = String(cmd?.action || "").toLowerCase();
  if (!action) return;

  // כדי לא להריץ פעמיים אם יש ספייקים
  if (cmdBusy) return;
  cmdBusy = true;

  try {
    if (action === "delete") {
      log("🗑️ command: delete (logout + cleanup + remove)");

      await updateServer({ status: "deleting", state: "logout_and_cleanup" }, { touchUpdatedAt: true }).catch(() => {});

      try { if (client) await client.logout(); } catch {}
      try { if (client) await client.destroy(); } catch {}

      rmSessionDir();

      // מוחק מה-DB (רק בסוף!)
      await serverRef.remove().catch(() => {});
      await cmdRef.remove().catch(() => {});

      log("✅ deleted. exiting process");
      process.exit(0);
    }

    if (action === "ensure_running" || action === "start") {
      log(`🧠 command: ${action}`);

      // אם כבר מחובר ורץ – רק ננקה פקודה
      if (client && waReady) {
        await cmdRef.remove().catch(() => {});
        return;
      }

      // אם יש תהליך אבל הדפדפן/סשן קרס → restart
      await restartClient(action);
      await cmdRef.remove().catch(() => {});
      return;
    }

    // default: נקה פקודות לא מוכרות
    await cmdRef.remove().catch(() => {});
  } finally {
    cmdBusy = false;
  }
}

// מאזינים לפקודות (אחרי שיש ProcessLock)
function startCommandListener() {
  cmdRef.on("value", async (snap) => {
    if (!snap.exists()) return;
    const cmd = snap.val();
    await handleCommand(cmd);
  });
}

  // ================== PROCESS LOCK ==================
  let procHeartbeatTimer = null;

  async function acquireProcessLockOrExit() {
    const now = Date.now();
    const host = os.hostname();
    const pid = process.pid;

    const tx = await processLockRef.transaction((cur) => {
      if (cur && cur.heartbeatAt && now - Number(cur.heartbeatAt) < PROC_STALE_MS) {
        if (cur.pid === pid && cur.host === host) return { ...cur };
        return; // abort
      }

      return {
        pid,
        host,
        startedAt: new Date().toISOString(),
        heartbeatAt: now,
      };
    });

    if (!tx.committed) {
      console.error(`[${SERVER_ID}] ❌ Process lock תפוס כבר ע"י תהליך אחר. סוגר כדי למנוע כפילות.`);
      process.exit(1);
    }

    log(`🔒 processLock acquired (pid=${pid} host=${host})`);

    try {
      await processLockRef.onDisconnect().remove();
    } catch {}

    procHeartbeatTimer = setInterval(async () => {
      try {
        await processLockRef.update({ heartbeatAt: Date.now() });
      } catch {}
    }, PROC_HEARTBEAT_MS);
  }

  async function releaseProcessLock() {
    try {
      if (procHeartbeatTimer) clearInterval(procHeartbeatTimer);
      procHeartbeatTimer = null;
      await processLockRef.remove();
      log("🔓 processLock released");
    } catch {}
  }

  // ================== HEALTH SERVER (AFTER LOCK) ==================
  let healthServer = null;
  let waState = "booting";
  let waReady = false;

  function startHealthServer() {
    healthServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
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
      res.end("Not Found");
    });

    healthServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[${SERVER_ID}] ❌ HEALTH_PORT ${HEALTH_PORT} תפוס. סגור תהליך ישן או שנה HEALTH_PORT.`);
        process.exit(1);
      }
      console.error(`[${SERVER_ID}] healthServer error:`, err);
      process.exit(1);
    });

    healthServer.listen(HEALTH_PORT, () => {
      log(`🩺 health endpoint: http://localhost:${HEALTH_PORT}/health`);
    });
  }

  // ================== SERVER CONFIG WATCHERS ==================
  let serverEnabled = true;
  let dailyLimit = DEFAULT_DAILY_LIMIT;
let sendDelayMs = 3000; // ברירת מחדל 3 שניות

  async function initServerConfigWatchers() {
    const snap = await serverRef.once("value");
    const val = snap.exists() ? snap.val() : {};

    serverEnabled = normalizeBool(val.enabled, true);
    dailyLimit = normalizeNumber(val.dailyLimit, DEFAULT_DAILY_LIMIT);

    log(`⚙️ enabled = ${serverEnabled}`);
    log(`⚙️ dailyLimit = ${dailyLimit}`);

    if (!("dailyLimit" in (val || {}))) {
      await serverRef.update({ dailyLimit: DEFAULT_DAILY_LIMIT }).catch(() => {});
      log(`📝 dailyLimit לא היה קיים — נכתב ברירת מחדל: ${DEFAULT_DAILY_LIMIT}`);
    }

    serverRef.child("enabled").on("value", (s) => {
      serverEnabled = normalizeBool(s.val(), true);
      log(`🟢 enabled updated => ${serverEnabled}`);
    });

    serverRef.child("dailyLimit").on("value", (s) => {
      dailyLimit = normalizeNumber(s.val(), DEFAULT_DAILY_LIMIT);
      log(`🔢 dailyLimit updated => ${dailyLimit}`);
    });
  }
serverRef.child("sendDelayMs").on("value", (s) => {
  const n = Number(s.val());
  sendDelayMs = Number.isFinite(n) && n >= 0 ? n : 3000;
  log(`⏱️ sendDelayMs updated => ${sendDelayMs}`);
});

  // ================== DAILY COUNT ==================
  let today = dayKey(new Date());
  let sentCount = 0;

  async function loadOrResetDailyCount() {
    const snap = await serverRef.once("value");
    const v = snap.exists() ? snap.val() : {};

    const currentDate = dayKey(new Date());
    today = currentDate;

    if (v && v.date === currentDate) {
      sentCount = Number(v.count || 0);
    } else {
      sentCount = 0;
      await serverRef.update({ date: currentDate, count: 0 }).catch(() => {});
    }

    log(`📊 daily count loaded => date=${today} count=${sentCount}`);
  }

  async function incrementDailyCount() {
    const currentDate = dayKey(new Date());

    if (today !== currentDate) {
      today = currentDate;
      sentCount = 0;
      await serverRef.update({ date: today, count: 0 }).catch(() => {});
    }

    const countRef = serverRef.child("count");
    const tx = await countRef.transaction((cur) => {
      const n = Number(cur || 0);
      return n + 1;
    });

    if (tx.committed) {
      sentCount = Number(tx.snapshot.val() || 0);
    }
    return sentCount;
  }

  // ================== STATS ==================
  async function incNumber(ref, by = 1) {
    await ref.transaction((cur) => {
      const n = Number(cur || 0);
      return n + by;
    });
  }

  async function writeSentStats(serverId, when = new Date()) {
    const { isoDay, hour, half, month, year, week } = timeKeys(when);

    const serverStatsBase = db.ref(`servers/${serverId}/stats`);
    const globalBase = db.ref(`stats/global`);

    const hourKey = `${isoDay}__${hour}`;
    const halfKey = `${isoDay}__${half}`;

    await Promise.all([
      incNumber(serverStatsBase.child(`days/${isoDay}/sent`), 1),
      incNumber(serverStatsBase.child(`hours/${hourKey}/sent`), 1),
      incNumber(serverStatsBase.child(`halfDays/${halfKey}/sent`), 1),
      incNumber(serverStatsBase.child(`weeks/${week}/sent`), 1),
      incNumber(serverStatsBase.child(`months/${month}/sent`), 1),
      incNumber(serverStatsBase.child(`years/${year}/sent`), 1),

      incNumber(globalBase.child(`days/${isoDay}/sent`), 1),
      incNumber(globalBase.child(`hours/${hourKey}/sent`), 1),
      incNumber(globalBase.child(`halfDays/${halfKey}/sent`), 1),
      incNumber(globalBase.child(`weeks/${week}/sent`), 1),
      incNumber(globalBase.child(`months/${month}/sent`), 1),
      incNumber(globalBase.child(`years/${year}/sent`), 1),
    ]);
  }

  // ================== SERVER STATUS UPDATE ==================
  let lastSeenTimer = null;
  let lastServerStatus = { status: undefined, state: undefined };

  async function updateServer(patch = {}, { touchUpdatedAt = false } = {}) {
    try {
      const nextStatus =
        typeof patch.status !== "undefined" ? patch.status : lastServerStatus.status;
      const nextState =
        typeof patch.state !== "undefined" ? patch.state : lastServerStatus.state;

      const statusChanged =
        nextStatus !== lastServerStatus.status || nextState !== lastServerStatus.state;

      const hasNonStatus = Object.keys(patch).some((k) => !["status", "state"].includes(k));

      if (!statusChanged && !hasNonStatus) return;

      lastServerStatus.status = nextStatus;
      lastServerStatus.state = nextState;

      const payload = { ...patch };
      if (touchUpdatedAt) payload.updatedAt = admin.database.ServerValue.TIMESTAMP;

      await serverRef.update(payload);
    } catch (e) {
      console.error(`[${SERVER_ID}] updateServer failed: ${e.message}`);
    }
  }

  async function touchLastSeen(extraPatch = {}) {
    try {
      await serverRef.update({
        ...extraPatch,
        lastSeen: new Date().toISOString(),
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });
    } catch (e) {
      console.error(`[${SERVER_ID}] touchLastSeen failed: ${e.message}`);
    }
  }

  function startLastSeenLoop() {
    touchLastSeen({ status: "online", state: waState }).catch(() => {});
    lastSeenTimer = setInterval(() => {
      touchLastSeen({ status: "online", state: waState }).catch(() => {});
    }, 2 * 60 * 60 * 1000); // כל שעתיים
  }

  function stopLastSeenLoop() {
    if (lastSeenTimer) clearInterval(lastSeenTimer);
    lastSeenTimer = null;
  }

  // ================== MESSAGE ELIGIBILITY ==================
  function isEligibleNow(msgObj) {
    const st = String(msgObj.status || "").toLowerCase();
    const now = Date.now();

    if (st === "pending" || st === "peending") return true;

    if (st === "error") {
      const retryAt = Number(msgObj.retryAt || 0);
      return now >= retryAt;
    }

    if (st === "sending" || st === "processing") {
      const leaseUntil = Number(msgObj.leaseUntil || 0);
      if (leaseUntil && now > leaseUntil) return true;
    }

    return false;
  }

  // ================== WHATSAPP ==================
  let client = null;

  function setupWhatsAppClient() {
    log("🔧 מאתחל WhatsApp client...");

client = new Client({
  authStrategy: new LocalAuth({ clientId: SERVER_ID }),
  puppeteer: {
    executablePath: CHROME_PATH,
    headless: HEADLESS, // ✅ נשלט ע"י ENV
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});


    client.on("qr", (qr) => {
      qrcode.generate(qr, { small: true });
      waState = "qr";
      waReady = false;

      log("📸 QR נוצר — סרוק בוואטסאפ > מכשירים מקושרים");

      updateServer({ status: "qr", state: "qr" }, { touchUpdatedAt: true }).catch(() => {});

      serverRef
        .update({
          qr,
          qrAt: new Date().toISOString(),
          status: "qr",
          state: "qr",
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        })
        .catch(() => {});
    });

    client.on("authenticated", () => {
      waState = "authenticated";
      log("🔐 AUTHENTICATED");
      updateServer({ status: "authenticated", state: "authenticated" }, { touchUpdatedAt: true }).catch(
        () => {}
      );
    });

    client.on("auth_failure", (msg) => {
      waState = "auth_failure";
      waReady = false;
      log(`❌ AUTH FAILURE: ${msg}`);
      updateServer(
        { status: "auth_failure", state: "auth_failure", error: String(msg) },
        { touchUpdatedAt: true }
      ).catch(() => {});
    });

    client.on("loading_screen", (percent, message) => {
      waState = `loading_${percent}`;
      log(`⏳ loading: ${percent}% ${message || ""}`.trim());
      updateServer({ state: waState }, { touchUpdatedAt: false }).catch(() => {});
    });

    client.on("change_state", (state) => {
      waState = `state_${state}`;
      log(`🔁 WA state: ${state}`);
      updateServer({ state: waState }, { touchUpdatedAt: false }).catch(() => {});
    });

    client.on("disconnected", (reason) => {
      waState = "disconnected";
      waReady = false;
      stopLastSeenLoop();

      log(`⚠️ DISCONNECTED: ${reason}`);
      updateServer(
        { status: "disconnected", state: "disconnected", reason: String(reason) },
        { touchUpdatedAt: true }
      ).catch(() => {});
    });

    // ================== MAIN SEND LOOP ==================
    let processing = false;
    let rerun = false;

    async function processUserNode(userSnap) {
      const userUid = userSnap.key;
      const userEvents = userSnap.val();
      if (!userEvents) return;

      if (!serverEnabled) {
        await updateServer({ status: "disabled", state: waState }, { touchUpdatedAt: false });
        return;
      }

      if (today !== dayKey(new Date())) {
        await loadOrResetDailyCount();
      }

      for (const eventId of Object.keys(userEvents)) {
        const eventNode = userEvents[eventId] || {};

        for (const msgId of Object.keys(eventNode)) {
          const msgObj = eventNode[msgId];
          if (!msgObj) continue;

          if (String(msgObj.sms || "").toLowerCase() !== "no") continue;

          const sched = parseSchedule(msgObj.scheduleMessage);
          if (Date.now() < sched.getTime()) continue;

          if (!isEligibleNow(msgObj)) continue;

          if (sentCount >= dailyLimit) {
            log(`🚫 הגיע למכסה היומית של השרת (${sentCount}/${dailyLimit})`);
            return;
          }

          const msgRef = db.ref(`whatsapp/${userUid}/${eventId}/${msgId}`);

          const lockRes = await msgRef.transaction((current) => {
            if (!current) return;

            const now = Date.now();
            const st = String(current.status || "").toLowerCase();

            if (st === "sent") return;
            if (st === "failed") return;

            const eligible = isEligibleNow(current);
            if (!eligible) return;

            const attempts = Number(current.attempts || 0) + 1;

            if (attempts > MAX_ATTEMPTS) {
              return {
                ...current,
                status: "failed",
                failedAt: new Date().toISOString(),
                lastError: current.lastError || "Max attempts reached",
                attempts,
              };
            }

            return {
              ...current,
              status: "sending",
              lockedBy: SERVER_ID,
              lockedAt: now,
              leaseUntil: now + LOCK_LEASE_MS,
              attempts,
              server: SERVER_ID,
            };
          });

          if (!lockRes.committed) continue;

          if (!serverEnabled) {
            await msgRef.update({
              status: "pending",
              lockedBy: null,
              lockedAt: null,
              leaseUntil: null,
              server: SERVER_ID,
              lastError: "Server disabled while processing",
            });
            return;
          }

          if (sentCount >= dailyLimit) {
            await msgRef.update({
              status: "pending",
              lockedBy: null,
              lockedAt: null,
              leaseUntil: null,
              server: SERVER_ID,
              lastError: `Daily limit reached (${dailyLimit})`,
            });
            log(`🚫 אחרי נעילה התברר שהגענו למכסה (${sentCount}/${dailyLimit})`);
            return;
          }

          try {
await new Promise((r) => setTimeout(r, Math.max(900, sendDelayMs)));

            const phone = sanitizePhone(msgObj.formattedContacts);
            const jid = `${phone}@c.us`;

            let waMessageId = null;

            if (msgObj.imageUrl) {
              const media = await MessageMedia.fromUrl(msgObj.imageUrl, { unsafeMime: true });
              const sent = await client.sendMessage(jid, media, { caption: msgObj.message || "" });
              waMessageId = sent?.id?._serialized || null;
            } else {
              const sent = await client.sendMessage(jid, msgObj.message || "");
              waMessageId = sent?.id?._serialized || null;
            }

            log(`📤 נשלחה הודעה ל-${phone}`);

            await msgRef.update({
              status: "sent",
              sentAt: new Date().toISOString(),
              server: SERVER_ID,
              waMessageId,
              leaseUntil: null,
            });

            await serverRef.update({
              lastSentAt: new Date().toISOString(),
              lastSentMsgId: msgId,
              lastSentTo: phone,
            });

            const newCount = await incrementDailyCount();
            await writeSentStats(SERVER_ID, new Date());

            log(`✅ count=${newCount}/${dailyLimit} (server ${SERVER_ID})`);
          } catch (err) {
            const msg = String(err?.message || err);
            const attemptsNow = Number(lockRes.snapshot.val()?.attempts || msgObj.attempts || 1);
            const backoff = calcBackoffMs(attemptsNow);
            const retryAt = Date.now() + backoff;

            log(`❌ שגיאה בשליחה ל-${msgObj.formattedContacts}: ${msg}`);
            log(`⏳ retry in ${Math.round(backoff / 1000)}s (attempt ${attemptsNow}/${MAX_ATTEMPTS})`);

            await msgRef.update({
              status: attemptsNow >= MAX_ATTEMPTS ? "failed" : "error",
              lastError: msg,
              retryAt: attemptsNow >= MAX_ATTEMPTS ? null : retryAt,
              leaseUntil: null,
              server: SERVER_ID,
            });

            if (msg.toLowerCase().includes("session closed")) {
              waState = "session_closed";
              waReady = false;
              await updateServer(
                { status: "offline", state: "session_closed", reason: msg },
                { touchUpdatedAt: true }
              );
            }
          }
        }
      }
    }

    async function handleNode(userSnap) {
      if (processing) {
        rerun = true;
        return;
      }

      processing = true;
      rerun = false;

      try {
        await processUserNode(userSnap);
      } finally {
        processing = false;
        if (rerun) {
          rerun = false;
          try {
            const snap = await whatsappRef.child(userSnap.key).once("value");
            if (snap.exists()) await handleNode(snap);
          } catch {}
        }
      }
    }

    client.on("ready", async () => {
      waState = "ready";
      waReady = true;

      log("✅ READY! הבוט מחובר ומוכן");

      await serverRef
        .update({
          qr: null,
          qrAt: null,
          status: "online",
          state: "ready",
          readyAt: new Date().toISOString(),
          updatedAt: admin.database.ServerValue.TIMESTAMP,
        })
        .catch(() => {});

      await updateServer({ status: "online", state: "ready", readyAt: new Date().toISOString() }, { touchUpdatedAt: true });

      startLastSeenLoop();

      whatsappRef.on("child_added", handleNode);
      whatsappRef.on("child_changed", handleNode);

      async function gracefulShutdown() {
        log("🧯 כיבוי מסודר...");

        try {
          whatsappRef.off("child_added", handleNode);
          whatsappRef.off("child_changed", handleNode);
        } catch {}

        stopLastSeenLoop();

        await updateServer({ status: "offline", state: "offline" }, { touchUpdatedAt: true }).catch(() => {});
        await releaseProcessLock();

        try { await client.destroy(); } catch {}
        try { if (healthServer) healthServer.close(); } catch {}

        process.exit(0);
      }

      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);
    });
  }

  // ================== EARLY SHUTDOWN (always release processLock) ==================
  let shuttingDown = false;

  function installEarlyShutdownHandlers() {
    async function shutdown(reason = "shutdown") {
      if (shuttingDown) return;
      shuttingDown = true;

      try { log(`🧯 shutdown: ${reason}`); } catch {}

      try { stopLastSeenLoop(); } catch {}
      try { await updateServer({ status: "offline", state: "offline", reason }, { touchUpdatedAt: true }); } catch {}
      try { await releaseProcessLock(); } catch {}
      try { if (healthServer) healthServer.close(); } catch {}
      try { if (client) await client.destroy(); } catch {}

      process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));

    process.on("uncaughtException", async (err) => {
      console.error(`[${SERVER_ID}] 💥 uncaughtException:`, err);
      await shutdown("uncaughtException");
    });

    process.on("unhandledRejection", async (err) => {
      console.error(`[${SERVER_ID}] 💥 unhandledRejection:`, err);
      await shutdown("unhandledRejection");
    });
  }

  // ================== BOOT SEQUENCE ==================
  // 1) lock
  await acquireProcessLockOrExit();
  installEarlyShutdownHandlers();
startCommandListener();

  // 2) register server base (פעם אחת)
  await serverRef.update({
    enabled: true,
    status: "booting",
    state: "starting",
    dailyLimit: DEFAULT_DAILY_LIMIT,
    date: dayKey(new Date()),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    lastSeen: new Date().toISOString(),
  });

  // 3) cleanup chrome leftovers
  cleanupChromeSingletonLocks(SERVER_ID, log);

  // 4) health server
  startHealthServer();

  // 5) watchers + counters
  await initServerConfigWatchers();
  await loadOrResetDailyCount();

  // 6) starting status
  await touchLastSeen({ status: "booting", state: "booting" }).catch(() => {});
  await updateServer({ status: "booting", state: "booting" }, { touchUpdatedAt: true }).catch(() => {});

  // 7) whatsapp
  setupWhatsAppClient();
  client.initialize();
})();
