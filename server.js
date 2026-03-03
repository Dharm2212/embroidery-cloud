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
// Serve the uploads folder so machines can download files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ================= DATABASE & AUTO-INIT ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS machines (machine_uid TEXT PRIMARY KEY, status TEXT, last_seen TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS machine_logs (id SERIAL PRIMARY KEY, machine_uid TEXT, message TEXT, level TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS files (id SERIAL PRIMARY KEY, file_version INTEGER, file_size INTEGER, checksum TEXT, file_path TEXT, created_at TIMESTAMP DEFAULT NOW());
    `);
    console.log("✅ Database Verified");
  } catch (err) { console.error("❌ DB Init Error:", err.message); }
};
initDB();

/* ================= MQTT MONITOR ================= */
const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER, password: process.env.MQTT_PASS
});

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("machine/+/status");
  mqttClient.subscribe("machine/+/logs");
});

mqttClient.on("message", async (topic, message) => {
  const [ , deviceId, type] = topic.split("/");
  const msg = message.toString();
  try {
    await pool.query("INSERT INTO machines (machine_uid) VALUES ($1) ON CONFLICT DO NOTHING", [deviceId]);
    await pool.query("INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1, $2, $3)", [deviceId, msg, "INFO"]);
    if (type === "status") {
      await pool.query("UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2", [msg, deviceId]);
    }
  } catch (err) { console.error("MQTT DB Error:", err.message); }
});

/* ================= FILE STORAGE ================= */
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

/* ================= API ROUTES ================= */

// 1. Upload & Broadcast
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const buffer = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
    
    const verRes = await pool.query("SELECT COALESCE(MAX(file_version), 0) + 1 AS next FROM files");
    const version = verRes.rows[0].next;

    await pool.query(
      "INSERT INTO files (file_version, file_size, checksum, file_path) VALUES ($1, $2, $3, $4)",
      [version, req.file.size, checksum, req.file.filename]
    );

    // Notify machines
    const updateInfo = { version, size: req.file.size, checksum, file: req.file.filename };
    mqttClient.publish("machine/all/update", JSON.stringify(updateInfo), { qos: 1 });

    res.json({ success: true, version });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Machine Data
app.get("/api/machines", async (req, res) => {
  const result = await pool.query("SELECT * FROM machines ORDER BY last_seen DESC");
  res.json(result.rows);
});

// 3. Version History
app.get("/api/versions", async (req, res) => {
  const result = await pool.query("SELECT * FROM files ORDER BY file_version DESC LIMIT 5");
  res.json(result.rows);
});

// 4. Logs
app.get("/api/logs/:machine", async (req, res) => {
  const result = await pool.query("SELECT * FROM machine_logs WHERE machine_uid=$1 ORDER BY created_at DESC LIMIT 50", [req.params.machine]);
  res.json(result.rows);
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server Ready"));