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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= MQTT ================= */

const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS
});

mqttClient.on("connect", () => {
  console.log("MQTT Connected");
  mqttClient.subscribe("machine/+/status");
  mqttClient.subscribe("machine/+/progress");
  mqttClient.subscribe("machine/+/ack");
  mqttClient.subscribe("machine/+/error");
});

/* ========== MQTT MONITOR ========== */

mqttClient.on("message", async (topic, message) => {
  const deviceId = topic.split("/")[1];

  await pool.query(
    "INSERT INTO machine_logs (machine_uid, message, level) VALUES ($1,$2,$3)",
    [deviceId, message.toString(), "INFO"]
  );

  if (topic.includes("status")) {
    await pool.query(
      "UPDATE machines SET last_seen=NOW(), status=$1 WHERE machine_uid=$2",
      [message.toString(), deviceId]
    );
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

// Upload
app.post("/api/upload-file", upload.single("file"), async (req, res) => {

  const filePath = path.join(uploadPath, "machine_file.bin");

  const fileBuffer = fs.readFileSync(filePath);
  const checksum = crypto.createHash("sha256")
                         .update(fileBuffer)
                         .digest("hex");

  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  const last = await pool.query(
    "SELECT file_version FROM files ORDER BY id DESC LIMIT 1"
  );

  const version = last.rows.length ? last.rows[0].file_version + 1 : 1;

  await pool.query(
    "INSERT INTO files (file_version,file_size,checksum) VALUES ($1,$2,$3)",
    [version, fileSize, checksum]
  );

  mqttClient.publish("machine/MACHINE_01/update", JSON.stringify({
    version,
    size: fileSize,
    checksum
  }));

  res.json({ success: true, version });
});

// Download
app.get("/api/download-file", (req, res) => {
  const filePath = path.join(uploadPath, "machine_file.bin");

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("No file uploaded");
  }

  res.download(filePath);
});

// Debug
app.get("/api/logs/:machine", async (req, res) => {
  const logs = await pool.query(
    "SELECT * FROM machine_logs WHERE machine_uid=$1 ORDER BY created_at DESC LIMIT 50",
    [req.params.machine]
  );
  res.json(logs.rows);
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Industrial Server Running")
);