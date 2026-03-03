require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

/* ================= CREATE UPLOAD FOLDER ================= */
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

/* ================= MULTER SETUP ================= */
const storage = multer.diskStorage({
  destination: uploadPath,
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [".txt", ".csv", ".bin"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .txt, .csv, .bin files allowed"));
    }
  }
});

/* ================= ROUTES ================= */

// Home
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  res.json({
    success: true,
    filename: req.file.filename,
    size: req.file.size
  });
});

// List files
app.get("/files", (req, res) => {
  fs.readdir(uploadPath, (err, files) => {
    if (err) {
      return res.status(500).json({ success: false });
    }
    res.json({ success: true, files });
  });
});

// Download file
app.get("/download/:filename", (req, res) => {
  const file = path.join(uploadPath, req.params.filename);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ success: false, message: "File not found" });
  }

  res.download(file);
});

/* ================= ERROR HANDLER ================= */
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(400).json({ success: false, message: err.message });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});