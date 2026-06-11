const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('../utils/logger');

const previewRoot = path.join(process.cwd(), 'uploads_tmp', 'previews');
if (!fs.existsSync(previewRoot)) {
  fs.mkdirSync(previewRoot, { recursive: true });
}

function getPreviewPath(mediaId, sourcePath) {
  const baseName = path.basename(sourcePath, path.extname(sourcePath || ''));
  return path.join(previewRoot, `preview_${mediaId}_${baseName}.jpg`);
}

async function generatePhotoPreview({ mediaId, sourcePath }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Preview source photo not found: ${sourcePath}`);
  }

  const outputPath = getPreviewPath(mediaId, sourcePath);

  await sharp(sourcePath)
    .rotate()
    .resize({
      width: 720,
      height: 720,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({
      quality: 42,
      mozjpeg: true,
    })
    .toFile(outputPath);

  logger.info(`PHOTO_PREVIEW | Generated preview for media:${mediaId}`);
  return outputPath;
}

async function ensurePhotoPreview({ mediaId, sourcePath, existingPreviewPath }) {
  if (existingPreviewPath && fs.existsSync(existingPreviewPath)) {
    return existingPreviewPath;
  }
  return generatePhotoPreview({ mediaId, sourcePath });
}

module.exports = {
  ensurePhotoPreview,
  generatePhotoPreview,
};
