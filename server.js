const express = require("express");
const multer = require("multer");
const multerS3 = require("multer-s3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const archiver = require("archiver");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "albumfoto2025";
const UPLOAD_DIR = path.join(__dirname, "uploads");

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined;
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL || undefined;
const USE_S3 = !!S3_BUCKET;

const s3Client = USE_S3 ? new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: !!S3_ENDPOINT,
}) : null;

if (!USE_S3 && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function genFilename(file) {
  const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

const multerOpts = {
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic|heif|webp)$/i.test(file.mimetype) ||
               /^video\/(mp4|quicktime|x-msvideo|webm)$/i.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error("Formato non supportato"));
  },
};

let upload;
if (USE_S3) {
  upload = multer(Object.assign({}, multerOpts, {
    storage: multerS3({
      s3: s3Client,
      bucket: S3_BUCKET,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        cb(null, `photos/${genFilename(file)}`);
      },
    }),
  }));
} else {
  upload = multer(Object.assign({}, multerOpts, {
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => cb(null, genFilename(file)),
    }),
  }));
}

const app = express();

if (!USE_S3) {
  app.use("/foto", express.static(UPLOAD_DIR));
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/upload", upload.array("foto", 300), (req, res) => {
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

app.get("/api/photos", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  try {
    if (USE_S3) {
      const list = await s3Client.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: "photos/",
      }));
      const items = (list.Contents || [])
        .filter(o => /\.(jpe?g|png|heic|heif|webp|mp4|mov|avi|webm)$/i.test(o.Key));
      const files = [];
      for (const o of items) {
        const name = o.Key.replace("photos/", "");
        const key = o.Key;
        const url = S3_PUBLIC_URL
          ? `${S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`
          : await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: 3600 });
        files.push({ name, key, size: o.Size, created: new Date(o.LastModified).getTime(), url });
      }
      files.sort((a, b) => b.created - a.created);
      res.json({ photos: files });
    } else {
      const files = fs.readdirSync(UPLOAD_DIR)
        .filter(f => /\.(jpe?g|png|heic|heif|webp|mp4|mov|avi|webm)$/i.test(f))
        .map(f => {
          const stat = fs.statSync(path.join(UPLOAD_DIR, f));
          return { name: f, size: stat.size, created: stat.birthtimeMs, url: "/foto/" + f };
        })
        .sort((a, b) => b.created - a.created);
      res.json({ photos: files });
    }
  } catch (e) {
    res.json({ photos: [] });
  }
});

app.get("/api/download/:filename", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  try {
    if (USE_S3) {
      const key = `photos/${req.params.filename}`;
      const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
      const response = await s3Client.send(command);
      res.setHeader("Content-Type", response.ContentType);
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`);
      response.Body.pipe(res);
    } else {
      const file = path.join(UPLOAD_DIR, req.params.filename);
      if (!fs.existsSync(file)) return res.status(404).json({ error: "File non trovato" });
      res.download(file);
    }
  } catch (e) {
    res.status(404).json({ error: "File non trovato" });
  }
});

app.delete("/api/photos/:filename", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  try {
    if (USE_S3) {
      const key = `photos/${req.params.filename}`;
      await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    } else {
      const file = path.join(UPLOAD_DIR, req.params.filename);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Errore durante l'eliminazione" });
  }
});

app.get("/api/zip", async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  try {
    if (USE_S3) {
      const list = await s3Client.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: "photos/",
      }));
      const files = (list.Contents || [])
        .filter(o => /\.(jpe?g|png|heic|heif|webp)$/i.test(o.Key));
      if (files.length === 0) return res.status(404).json({ error: "Nessuna foto" });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", "attachment; filename=album-foto.zip");
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", err => res.status(500).json({ error: err.message }));
      archive.pipe(res);

      for (const obj of files) {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
        archive.append(response.Body, { name: obj.Key.replace("photos/", "") });
      }
      archive.finalize();
    } else {
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
    }
  } catch (e) {
    res.status(500).json({ error: "Errore durante la creazione dello ZIP" });
  }
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
  console.log(`Album Foto in ascolto su http://localhost:${PORT}${USE_S3 ? " (S3: " + S3_BUCKET + ")" : " (locale)"}`);
});
