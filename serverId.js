// serverId.js
// יוצר/שומר serverId קבוע מקומית + מקצה serverN אוטומטי בפיירבייס (transaction)

const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_ID_FILE = path.join(__dirname, ".server_id.json");

function readSavedId() {
  try {
    if (!fs.existsSync(SERVER_ID_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SERVER_ID_FILE, "utf8"));
    return j?.serverId || null;
  } catch {
    return null;
  }
}

function saveId(serverId) {
  try {
    fs.writeFileSync(SERVER_ID_FILE, JSON.stringify({ serverId }, null, 2));
  } catch {}
}

function makeRandomId() {
  const host = os.hostname().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "host";
  const rnd = Math.random().toString(36).slice(2, 8);
  return `server_${host}_${rnd}`.toLowerCase();
}

/**
 * מקצה server1/server2/... בצורה בטוחה באמצעות Transaction
 * דורש הרשאות כתיבה ל: /servers_meta/next
 */
async function allocateSequentialServerId(adminDb, { prefix = "server", start = 1 } = {}) {
  const ref = adminDb.ref("servers_meta/next");

  const res = await ref.transaction((current) => {
    if (current === null || current === undefined) return start;
    if (typeof current !== "number") return start;
    return current + 1;
  });

  if (!res.committed) throw new Error("allocateSequentialServerId: transaction not committed");

  const n = res.snapshot.val();
  return `${prefix}${n}`;
}

/**
 * מחזיר serverId קבוע:
 * 1) אם יש env SERVER_ID — משתמש בו (לא חובה יותר)
 * 2) אם שמור מקומית — משתמש בו
 * 3) אחרת: מקצה serverN דרך transaction
 * 4) אם נכשל — עושה random
 */
async function getOrCreateServerId(adminDb) {
  const envId = process.env.SERVER_ID?.trim();
  if (envId) {
    saveId(envId);
    return envId;
  }

  const saved = readSavedId();
  if (saved) return saved;

  try {
    const seqId = await allocateSequentialServerId(adminDb, { prefix: "server", start: 1 });
    saveId(seqId);
    return seqId;
  } catch (e) {
    const rid = makeRandomId();
    saveId(rid);
    return rid;
  }
}

module.exports = { getOrCreateServerId };
