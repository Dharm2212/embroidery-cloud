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

/* ================= MQTT ================= */

const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS
});

mqttClient.on("connect", () => {
  console.log("MQTT Connected");
});

/* ================= FILE STORAGE ================= */

const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    cb(null, "machine_file.bin"); // always overwrite
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB max
});

/* ================= ROUTES ================= */

// ROOT
app.get("/", (req, res) => {
  res.send("Embroidery IoT Server Running 🚀");
});

// VERSION CHECK
app.get("/api/file-version", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT file_version FROM public.files ORDER BY id DESC LIMIT 1"
    );

    if (result.rows.length === 0)
      return res.json({ version: 0 });

    res.json({ version: result.rows[0].file_version });

  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

// DOWNLOAD FILE
app.get("/api/download-file", (req, res) => {
  const filePath = path.join(uploadPath, "machine_file.bin");

  if (!fs.existsSync(filePath))
    return res.status(404).send("No file");

  res.download(filePath);
});

// UPLOAD FILE
app.post("/api/upload-file", upload.single("file"), async (req, res) => {

  try {

    const filePath = path.join(uploadPath, "machine_file.bin");

    if (!fs.existsSync(filePath))
      return res.status(400).json({ error: "File missing" });

    const stats = fs.statSync(filePath);
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

    // MQTT notify
    const message = JSON.stringify({
      version: newVersion,
      size: fileSize,
      url: process.env.BASE_URL + "/api/download-file"
    });

    mqttClient.publish("machine/MACHINE_01/update", message);

    res.json({ success: true, version: newVersion });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ================= START SERVER ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});