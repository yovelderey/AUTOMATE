/**
 * bot-agent.js
 * רץ תמיד ברקע על המחשב שמריץ את הבוטים.
 * מקבל פקודות מה-Firebase ומפעיל start.js עם SERVER_ID שנבחר ב-UI
 */

const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const serviceAccount = require(path.join(__dirname, "firebase-config.json"));

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://maarechet-automations-default-rtdb.firebaseio.com",
  });
}

const db = admin.database();
const host = os.hostname();

// מחזיק תהליכים פעילים בזיכרון (למניעת כפילות)
const running = new Map();

/**
 * מפעיל start.js כ-process נפרד עם SERVER_ID
 */
function startBot(serverId) {
  if (running.has(serverId)) return;

  const child = spawn(process.execPath, ["start.js"], {
    cwd: __dirname,
    env: { ...process.env, SERVER_ID: serverId },
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  running.set(serverId, child.pid);

  // רושם ב-Firebase שה-process עלה
  db.ref(`servers/${serverId}/runner`).set({
    pid: child.pid,
    host,
    startedAt: admin.database.ServerValue.TIMESTAMP,
  }).catch(() => {});

  console.log(`✅ Started bot ${serverId} (pid=${child.pid})`);
}

/**
 * מאזין לפקודות:
 * serverCommands/{serverId} = { action: "start" | "stop", ... }
 */
function listenCommands() {
  const cmdsRef = db.ref("serverCommands");

  cmdsRef.on("child_added", async (snap) => {
    const serverId = snap.key;
    const cmd = snap.val();
    if (!cmd || !cmd.action) return;

    try {
      if (cmd.action === "start") {
        startBot(serverId);

        // מאשר ביצוע ומוחק פקודה
        await db.ref(`servers/${serverId}/lastCommand`).set({
          action: "start",
          by: cmd.by || "ui",
          at: admin.database.ServerValue.TIMESTAMP,
        });
        await snap.ref.remove();
      }
    } catch (e) {
      console.error("❌ command failed:", e?.message || e);
      // אפשר להשאיר פקודה או לכתוב error
    }
  });

  console.log("👂 bot-agent listening on /serverCommands");
}

listenCommands();
