const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "albumfoto2025";
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
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic|heif|webp)$/i.test(file.mimetype) ||
               /^video\/(mp4|quicktime|x-msvideo|webm)$/i.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error("Formato non supportato"));
  },
});

const app = express();

app.use("/foto", express.static(UPLOAD_DIR));

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/upload", upload.array("foto", 60), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Nessuna foto ricevuta" });
  }
  res.json({ ok: true, count: req.files.length });
});

app.post("/api/login", express.json(), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Password errata" });
});

app.get("/api/photos", (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => /\.(jpe?g|png|heic|heif|webp|mp4|mov|avi|webm)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, f));
        return { name: f, size: stat.size, created: stat.birthtimeMs };
      })
      .sort((a, b) => b.created - a.created);
    res.json({ photos: files });
  } catch (e) {
    res.json({ photos: [] });
  }
});

app.get("/api/download/:filename", (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  const file = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "File non trovato" });
  res.download(file);
});

app.get("/api/zip", (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.(jpe?g|png|heic|heif|webp)$/i.test(f));
  if (files.length === 0) return res.status(404).json({ error: "Nessuna foto" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=album-foto.zip");
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", err => res.status(500).json({ error: err.message }));
  archive.pipe(res);
  files.forEach(f => archive.file(path.join(UPLOAD_DIR, f), { name: f }));
  archive.finalize();
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File troppo grande (max 100MB)" });
  }
  res.status(400).json({ error: err.message || "Errore durante il caricamento" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Album Foto in ascolto su http://localhost:${PORT}`);
});
