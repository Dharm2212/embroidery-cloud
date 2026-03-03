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

// Allow file downloads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

// Auto create tables if not exist
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

    console.log("✅ Database Ready");
  } catch (err) {
    console.error("DB Init Error:", err.message);
  }
};
initDB();

/* ================= MQTT ================= */

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
    await pool.query(
      "INSERT INTO machines (machine_uid) VALUES ($1) ON CONFLICT (machine_uid) DO NOTHING",
      [deviceId]
    );

    await pool.query(
      "INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1, $2, $3)",
      [deviceId, msg, "INFO"]
    );

    if (type === "status") {
      await pool.query(
        "UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2",
        [msg, deviceId]
      );
    }

  } catch (err) {
    console.error("MQTT Error:", err.message);
  }
});

/* ================= FILE UPLOAD ================= */

const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* ================= ROUTES ================= */

// Upload firmware
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const buffer = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

    const verRes = await pool.query(
      'SELECT COALESCE(MAX(file_version), 0) + 1 AS next FROM "files"'
    );

    const version = verRes.rows[0].next;

    await pool.query(
      'INSERT INTO "files" (file_version, file_size, checksum, file_path) VALUES ($1, $2, $3, $4)',
      [version, req.file.size, checksum, req.file.filename]
    );

    const updatePayload = JSON.stringify({
      version,
      size: req.file.size,
      checksum,
      url: `/uploads/${req.file.filename}`
    });

    mqttClient.publish("machine/all/update", updatePayload, { qos: 1 });

    res.json({ success: true, version });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest firmware
app.get("/api/latest-version", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM "files" ORDER BY file_version DESC LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: "No firmware available" });
    }

    const latest = result.rows[0];

    res.json({
      success: true,
      version: latest.file_version,
      size: latest.file_size,
      checksum: latest.checksum,
      url: `/uploads/${latest.file_path}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Version history
app.get("/api/versions", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM "files" ORDER BY file_version DESC LIMIT 5'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Machines list
app.get("/api/machines", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM machines ORDER BY last_seen DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logs per machine
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

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});