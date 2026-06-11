-- ════════════════════════════════════════════════════════════
--  GRACE CHURCH MEDIA — Schema for Aiven defaultdb
--  Run this in TablePlus connected to defaultdb
-- ════════════════════════════════════════════════════════════

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  role          ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  password_hash VARCHAR(255) NOT NULL,
  avatar_url    VARCHAR(500),
  is_active     TINYINT(1) DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Media table
CREATE TABLE IF NOT EXISTS media (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  type          ENUM('video', 'photo', 'audio') NOT NULL,
  file_path     VARCHAR(500),
  title         VARCHAR(200),
  thumbnail_url VARCHAR(500),
  status        ENUM('pending', 'uploading', 'uploaded', 'failed') DEFAULT 'pending',
  uploaded_by   INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Media metadata table
CREATE TABLE IF NOT EXISTS media_metadata (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  media_id      INT NOT NULL UNIQUE,
  event_name    VARCHAR(200),
  location      VARCHAR(200),
  description   TEXT,
  participants  TEXT,
  sermon_topic  VARCHAR(200),
  speaker_name  VARCHAR(150),
  service_date  DATE,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

-- Uploads tracking table
CREATE TABLE IF NOT EXISTS uploads (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  media_id         INT NOT NULL,
  platform         ENUM('telegram', 'youtube') NOT NULL,
  upload_status    ENUM('pending', 'in_progress', 'success', 'failed') DEFAULT 'pending',
  telegram_msg_id  VARCHAR(100),
  youtube_link     VARCHAR(500),
  youtube_video_id VARCHAR(100),
  retry_count      INT DEFAULT 0,
  error_message    TEXT,
  upload_date      DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

-- Activity logs table
CREATE TABLE IF NOT EXISTS logs (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  action    VARCHAR(200) NOT NULL,
  user_id   INT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  details   TEXT,
  ip_addr   VARCHAR(50),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Refresh tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  token      VARCHAR(512) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Verify all tables
SHOW TABLES;
