const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic|heif|webp)$/i.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error("Formato non supportato"));
  },
});

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/foto", express.static(UPLOAD_DIR));

app.post("/upload", upload.array("foto", 30), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Nessuna foto ricevuta" });
  }
  res.json({ ok: true, count: req.files.length });
});

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Foto troppo grande (max 25MB)" });
  }
  res.status(400).json({ error: err.message || "Errore durante il caricamento" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Album Foto in ascolto su http://localhost:${PORT}`);
});
