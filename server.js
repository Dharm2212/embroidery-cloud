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
  ssl: { rejectUnauthorized: false }
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
  mqttClient.subscribe("machine/+/progress");
  mqttClient.subscribe("machine/+/ack");
  mqttClient.subscribe("machine/+/error");
});

mqttClient.on("error", (err) => {
  console.error("❌ MQTT Error:", err.message);
});

/* ================= MQTT MONITOR ================= */

mqttClient.on("message", async (topic, message) => {
  const deviceId = topic.split("/")[1];
  const msg = message.toString();

  try {

    await pool.query(`
      INSERT INTO machines (machine_uid)
      VALUES ($1)
      ON CONFLICT (machine_uid) DO NOTHING
    `, [deviceId]);

    await pool.query(
      "INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1,$2,$3)",
      [deviceId, msg, "INFO"]
    );

    if (topic.includes("status")) {
      await pool.query(
        "UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2",
        [msg, deviceId]
      );
    }

    console.log(`📩 ${topic} → ${msg}`);

  } catch (err) {
    console.error("DB Error:", err.message);
  }
});

/* ================= FILE STORAGE ================= */

const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => cb(null, "machine_file.bin")
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }
});

/* ================= ROUTES ================= */

// Root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload file
app.post("/api/upload-file", upload.single("file"), async (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({ error: "No file selected" });
    }

    const filePath = path.join(uploadPath, "machine_file.bin");

    const buffer = fs.readFileSync(filePath);
    const checksum = crypto.createHash("sha256")
                           .update(buffer)
                           .digest("hex");

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    const last = await pool.query(
      "SELECT file_version FROM files ORDER BY id DESC LIMIT 1"
    );

    const version = last.rows.length
      ? last.rows[0].file_version + 1
      : 1;

    await pool.query(
      "INSERT INTO files (file_version,file_size,checksum) VALUES ($1,$2,$3)",
      [version, fileSize, checksum]
    );

    mqttClient.publish(
      "machine/MACHINE_01/update",
      JSON.stringify({ version, size: fileSize, checksum })
    );

    console.log("🚀 Update Published");

    res.json({ success: true, version });

  } catch (err) {
    console.error("Upload Error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Download file
app.post("/api/upload-file", upload.single("file"), async (req, res) => {

  try {

    console.log("Upload request received");

    if (!req.file) {
      console.log("No file in request");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.join(uploadPath, "machine_file.bin");

    console.log("Reading file...");
    const buffer = fs.readFileSync(filePath);

    const checksum = crypto.createHash("sha256")
                           .update(buffer)
                           .digest("hex");

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    console.log("File size:", fileSize);

    const last = await pool.query(
      "SELECT file_version FROM files ORDER BY id DESC LIMIT 1"
    );

    const version = last.rows.length
      ? last.rows[0].file_version + 1
      : 1;

    console.log("New version:", version);

    await pool.query(
      "INSERT INTO files (file_version,file_size,checksum) VALUES ($1,$2,$3)",
      [version, fileSize, checksum]
    );

    mqttClient.publish(
      "machine/MACHINE_01/update",
      JSON.stringify({ version, size: fileSize, checksum })
    );

    console.log("MQTT Published");

    res.json({ success: true, version });

  } catch (err) {

    console.error("FULL UPLOAD ERROR:");
    console.error(err);
    console.error(err.stack);

    res.status(500).json({
      error: "Upload failed",
      details: err.message
    });
  }
});
// Logs
app.get("/api/logs/:machine", async (req, res) => {
  const logs = await pool.query(
    "SELECT * FROM machine_logs WHERE machine_uid=$1 ORDER BY created_at DESC LIMIT 100",
    [req.params.machine]
  );
  res.json(logs.rows);
});

// Machines list
app.get("/api/machines", async (req, res) => {
  const machines = await pool.query(
    "SELECT * FROM machines ORDER BY last_seen DESC"
  );
  res.json(machines.rows);
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🔥 Industrial Server Running")
);