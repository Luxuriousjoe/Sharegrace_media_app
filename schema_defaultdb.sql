-- PostgreSQL schema for Share Grace Family Church backend
-- Run this against your Render PostgreSQL database.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  role VARCHAR(40) NOT NULL DEFAULT 'user',
  family VARCHAR(120) NOT NULL DEFAULT 'None',
  department VARCHAR(120) NOT NULL DEFAULT 'None',
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  can_upload_media BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_users BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_timely_reflections BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_home_banners BOOLEAN NOT NULL DEFAULT FALSE,
  first_login_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_login_ip VARCHAR(50),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS family VARCHAR(120) NOT NULL DEFAULT 'None';

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS department VARCHAR(120) NOT NULL DEFAULT 'None';

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS can_upload_media BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS can_manage_users BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS can_manage_timely_reflections BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS can_manage_home_banners BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

INSERT INTO users (
  name,
  email,
  role,
  family,
  department,
  password_hash,
  is_active,
  can_upload_media,
  can_manage_users,
  can_manage_timely_reflections,
  can_manage_home_banners,
  onboarding_completed,
  onboarding_completed_at
)
VALUES (
  'Share Grace Admin',
  'admin@sharegrace.com',
  'admin',
  'None',
  'None',
  'admin1233',
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  family = EXCLUDED.family,
  department = EXCLUDED.department,
  password_hash = EXCLUDED.password_hash,
  is_active = TRUE,
  can_upload_media = TRUE,
  can_manage_users = TRUE,
  can_manage_timely_reflections = TRUE,
  can_manage_home_banners = TRUE,
  onboarding_completed = TRUE,
  onboarding_completed_at = COALESCE(users.onboarding_completed_at, NOW()),
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL CHECK (type IN ('video', 'photo', 'audio')),
  file_path TEXT,
  storage_provider VARCHAR(40) NOT NULL DEFAULT 'local',
  drive_file_id TEXT,
  drive_web_view_link TEXT,
  drive_download_url TEXT,
  thumbnail_drive_file_id TEXT,
  preview_drive_file_id TEXT,
  title VARCHAR(200),
  thumbnail_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed')),
  uploaded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preview_file_path TEXT,
  preview_upload_status VARCHAR(20),
  preview_telegram_msg_id VARCHAR(100),
  preview_telegram_file_id TEXT,
  preview_telegram_file_unique_id TEXT,
  preview_telegram_file_path TEXT,
  preview_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(40) NOT NULL DEFAULT 'local';

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS drive_file_id TEXT;

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS drive_web_view_link TEXT;

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS drive_download_url TEXT;

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS thumbnail_drive_file_id TEXT;

ALTER TABLE IF EXISTS media
  ADD COLUMN IF NOT EXISTS preview_drive_file_id TEXT;

CREATE TABLE IF NOT EXISTS media_metadata (
  id BIGSERIAL PRIMARY KEY,
  media_id BIGINT NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  event_name VARCHAR(200),
  location VARCHAR(200),
  description TEXT,
  participants TEXT,
  sermon_topic VARCHAR(200),
  speaker_name VARCHAR(150),
  service_date DATE,
  content_category VARCHAR(80),
  upload_to_telegram BOOLEAN NOT NULL DEFAULT FALSE,
  upload_to_youtube BOOLEAN NOT NULL DEFAULT FALSE,
  youtube_schedule_at TIMESTAMPTZ,
  featured_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  featured_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  featured_until TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  video_orientation VARCHAR(40),
  video_aspect_ratio NUMERIC(6, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS uploads (
  id BIGSERIAL PRIMARY KEY,
  media_id BIGINT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('telegram', 'youtube')),
  upload_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (upload_status IN ('pending', 'in_progress', 'success', 'failed')),
  telegram_msg_id VARCHAR(100),
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  telegram_file_path TEXT,
  youtube_link TEXT,
  youtube_video_id VARCHAR(100),
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  upload_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (media_id, platform)
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  action VARCHAR(200) NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details TEXT,
  ip_addr VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  device_token TEXT NOT NULL UNIQUE,
  platform VARCHAR(40) NOT NULL DEFAULT 'android',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_care_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  full_name VARCHAR(150) NOT NULL,
  whatsapp_number VARCHAR(50) NOT NULL,
  issue_message TEXT NOT NULL,
  is_attended BOOLEAN NOT NULL DEFAULT FALSE,
  attended_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  attended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS home_header_banners (
  id BIGSERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  telegram_msg_id VARCHAR(100),
  telegram_file_id TEXT,
  telegram_file_path TEXT,
  telegram_file_unique_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_ads (
  id BIGSERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  ad_label VARCHAR(100),
  headline VARCHAR(200),
  subheadline VARCHAR(200),
  event_date DATE NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  telegram_msg_id VARCHAR(100),
  telegram_file_id TEXT,
  telegram_file_path TEXT,
  telegram_file_unique_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS timely_reflections (
  id BIGSERIAL PRIMARY KEY,
  topic VARCHAR(200) NOT NULL,
  main_article TEXT,
  reference_text TEXT,
  confession TEXT,
  further_study TEXT,
  reflection_date DATE,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_channel_videos (
  id BIGSERIAL PRIMARY KEY,
  video_id VARCHAR(100) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  published_at TIMESTAMPTZ,
  duration VARCHAR(40),
  view_count INTEGER NOT NULL DEFAULT 0,
  youtube_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saved_videos (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id BIGINT REFERENCES media(id) ON DELETE CASCADE,
  video_id VARCHAR(100),
  title TEXT,
  thumbnail_url TEXT,
  youtube_url TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS saved_videos_user_media_video_unique
  ON saved_videos (user_id, COALESCE(media_id, -1), COALESCE(video_id, ''));

CREATE TABLE IF NOT EXISTS app_releases (
  id BIGSERIAL PRIMARY KEY,
  version_name VARCHAR(50) NOT NULL,
  version_code VARCHAR(50) NOT NULL,
  release_notes TEXT,
  is_force_update BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  download_url TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS media_set_updated_at ON media;
CREATE TRIGGER media_set_updated_at
BEFORE UPDATE ON media
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS uploads_set_updated_at ON uploads;
CREATE TRIGGER uploads_set_updated_at
BEFORE UPDATE ON uploads
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS timely_reflections_set_updated_at ON timely_reflections;
CREATE TRIGGER timely_reflections_set_updated_at
BEFORE UPDATE ON timely_reflections
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS youtube_channel_videos_set_updated_at ON youtube_channel_videos;
CREATE TRIGGER youtube_channel_videos_set_updated_at
BEFORE UPDATE ON youtube_channel_videos
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS app_releases_set_updated_at ON app_releases;
CREATE TRIGGER app_releases_set_updated_at
BEFORE UPDATE ON app_releases
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS device_tokens_set_updated_at ON device_tokens;
CREATE TRIGGER device_tokens_set_updated_at
BEFORE UPDATE ON device_tokens
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
