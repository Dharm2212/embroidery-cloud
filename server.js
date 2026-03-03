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

/* ================= DATABASE ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

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
    // Register machine if new
    await pool.query(
      "INSERT INTO machines (machine_uid) VALUES ($1) ON CONFLICT (machine_uid) DO NOTHING",
      [deviceId]
    );

    // Log the message
    await pool.query(
      "INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1, $2, $3)",
      [deviceId, msg, "INFO"]
    );

    // Update status if it's a status topic
    if (type === "status") {
      await pool.query(
        "UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2",
        [msg, deviceId]
      );
    }
    console.log(`📩 ${topic} → ${msg}`);
  } catch (err) {
    console.error("DB Error during MQTT processing:", err.message);
  }
});

/* ================= FILE STORAGE ================= */
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    // Keep original extension but use a timestamp to prevent collisions
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/* ================= ROUTES ================= */

// Get all machines
app.get("/api/machines", async (req, res) => {
  try {
    const machines = await pool.query("SELECT * FROM machines ORDER BY last_seen DESC");
    res.json(machines.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs for specific machine
app.get("/api/logs/:machine", async (req, res) => {
  try {
    const logs = await pool.query(
      "SELECT * FROM machine_logs WHERE machine_uid=$1 ORDER BY created_at DESC LIMIT 50",
      [req.params.machine]
    );
    res.json(logs.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single Unified Upload Route
// Unified Upload Route - Replacing the two duplicates
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
    const fileSize = req.file.size;

    // 1. Get Version Safely
    const versionRes = await pool.query("SELECT MAX(file_version) AS max_v FROM files");
    const nextVersion = (versionRes.rows[0].max_v || 0) + 1;

    // 2. Insert into DB (Make sure column names match Step 1)
    await pool.query(
      "INSERT INTO files (file_version, file_size, checksum, file_path) VALUES ($1, $2, $3, $4)",
      [nextVersion, fileSize, checksum, req.file.filename]
    );

    // 3. MQTT Broadcast
    const payload = JSON.stringify({ 
        version: nextVersion, 
        size: fileSize, 
        checksum: checksum,
        downloadUrl: `/uploads/${req.file.filename}` 
    });
    
    mqttClient.publish("machine/all/update", payload);

    res.json({ success: true, version: nextVersion });

  } catch (err) {
    // This will print the EXACT error to your terminal (e.g., "column file_path does not exist")
    console.error("DETAILED UPLOAD ERROR:", err.message);
    res.status(500).json({ error: "Server error during upload", details: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("🔥 Industrial Server Running"));