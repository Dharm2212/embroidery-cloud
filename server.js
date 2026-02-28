require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mqtt = require("mqtt");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= MQTT SETUP ================= */

const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS
});

mqttClient.on("connect", () => {
  console.log("MQTT Connected");
});

/* ================= FILE STORAGE ================= */

const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    cb(null, "machine_file.bin");
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }
});

/* ================= INIT TABLE ================= */

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.files (
      id SERIAL PRIMARY KEY,
      file_name VARCHAR(255),
      file_version INT DEFAULT 1,
      file_size INT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );
  `);
})();

/* ================= FILE UPLOAD ================= */

app.post("/api/upload-file", upload.single("file"), async (req, res) => {

  try {

    const stats = fs.statSync(path.join(uploadPath, "machine_file.bin"));
    const fileSize = stats.size;

    const versionCheck = await pool.query(
      "SELECT file_version FROM public.files ORDER BY id DESC LIMIT 1"
    );

    let newVersion = 1;
    if (versionCheck.rows.length > 0)
      newVersion = versionCheck.rows[0].file_version + 1;

    await pool.query(
      "INSERT INTO public.files (file_name, file_version, file_size) VALUES ($1,$2,$3)",
      ["machine_file.bin", newVersion, fileSize]
    );

    /* ===== MQTT PUBLISH UPDATE ===== */

    const updateMessage = JSON.stringify({
      version: newVersion,
      size: fileSize,
      url: "https://embroidery-cloud.onrender.com/api/download-file"
    });

    mqttClient.publish("machine/MACHINE_01/update", updateMessage);

    res.json({ success: true, version: newVersion });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ================= FILE DOWNLOAD ================= */

app.get("/api/download-file", (req, res) => {
  const filePath = path.join(uploadPath, "machine_file.bin");

  if (!fs.existsSync(filePath))
    return res.status(404).send("No file");

  res.download(filePath);
});

/* ================= SERVER START ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});