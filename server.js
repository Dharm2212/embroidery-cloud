require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mqtt = require("mqtt");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Static route to allow machines to download binary files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ================= DATABASE & AUTO-INIT ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

// Ensures tables exist on startup to prevent "object not found" errors
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS machines (
        machine_uid TEXT PRIMARY KEY, 
        status TEXT DEFAULT 'OFFLINE', 
        last_seen TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS machine_logs (
        id SERIAL PRIMARY KEY, 
        machine_uid TEXT, 
        message TEXT, 
        level TEXT, 
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS "files" (
        id SERIAL PRIMARY KEY, 
        file_version INTEGER NOT NULL, 
        file_size INTEGER NOT NULL, 
        checksum TEXT NOT NULL, 
        file_path TEXT NOT NULL, 
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database Schema Verified");
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  }
};
initDB();

/* ================= MQTT CLIENT ================= */
const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 5000
});

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("machine/+/status");
  mqttClient.subscribe("machine/+/logs");
});

mqttClient.on("message", async (topic, message) => {
  const parts = topic.split("/");
  const deviceId = parts[1];
  const type = parts[2];
  const msg = message.toString();

  try {
    // Register machine if it doesn't exist
    await pool.query(
      "INSERT INTO machines (machine_uid) VALUES ($1) ON CONFLICT (machine_uid) DO NOTHING",
      [deviceId]
    );

    // Log the incoming message
    await pool.query(
      "INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1, $2, $3)",
      [deviceId, msg, "INFO"]
    );

    // Update status if topic matches
    if (type === "status") {
      await pool.query(
        "UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2",
        [msg, deviceId]
      );
    }
  } catch (err) {
    console.error("MQTT Processing Error:", err.message);
  }
});

/* ================= FILE STORAGE (MULTER) ================= */
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    // Unique naming to prevent overwriting existing files
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

/* ================= API ROUTES ================= */

// 1. Upload Firmware & Broadcast Update
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const buffer = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

    // COALESCE handles new databases where MAX is NULL
    const verRes = await pool.query('SELECT COALESCE(MAX(file_version), 0) + 1 AS next FROM "files"');
    const version = verRes.rows[0].next;

    // Save to database using exact column names from your schema
    await pool.query(
      'INSERT INTO "files" (file_version, file_size, checksum, file_path) VALUES ($1, $2, $3, $4)',
      [version, req.file.size, checksum, req.file.filename]
    );

    // Broadcast update info to all machines
    const updatePayload = JSON.stringify({
      version,
      size: req.file.size,
      checksum,
      url: `/uploads/${req.file.filename}`
    });
    mqttClient.publish("machine/all/update", updatePayload, { qos: 1 });

    res.json({ success: true, version });
  } catch (err) {
    console.error("Upload Error:", err.message);
    res.status(500).json({ error: "Server upload failed", details: err.message });
  }
});

// 2. Fetch Version History
app.get("/api/versions", async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM "files" ORDER BY file_version DESC LIMIT 5');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Fetch Machine List
app.get("/api/machines", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM machines ORDER BY last_seen DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Fetch Logs for specific machine
app.get("/api/logs/:machine", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM machine_logs WHERE machine_uid=$1 ORDER BY created_at DESC LIMIT 50",
      [req.params.machine]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Industrial Dashboard Backend running on port ${PORT}`);
});