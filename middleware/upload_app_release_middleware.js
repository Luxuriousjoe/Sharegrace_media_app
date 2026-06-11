const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(process.cwd(), 'uploads_tmp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ext || '.apk';
    const safeName = `app-release-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, safeName);
  },
});

function fileFilter(_, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const looksLikeApk =
    ext === '.apk' ||
    mime === 'application/vnd.android.package-archive' ||
    mime === 'application/octet-stream';

  if (!looksLikeApk) {
    const err = new Error('Only APK files are allowed for app release uploads');
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

const uploadAppRelease = multer({
  storage,
  fileFilter,
});

module.exports = uploadAppRelease;
