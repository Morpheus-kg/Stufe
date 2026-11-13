-- db/schema.sql — финальная форма (A2): свежая установка уже содержит user_id везде
-- Глобальные таблицы (без user_id): ai_cache, schema_migrations, users

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  password_hash VARCHAR(255) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  token_version INT NOT NULL DEFAULT 0,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  ai_mode ENUM('shared','own','off') NOT NULL DEFAULT 'shared',
  last_login_at DATETIME NULL,
  last_active_day DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  term VARCHAR(255) NOT NULL,
  article ENUM('der','die','das') NULL,
  plural VARCHAR(255) NULL,
  pos ENUM('noun','verb','adj','adv','phrase','idiom','collocation') NOT NULL DEFAULT 'phrase',
  translation VARCHAR(500) NOT NULL,
  grammar TEXT NULL,
  rektion VARCHAR(100) NULL,
  example TEXT NULL,
  example_translation TEXT NULL,
  example_cloze TEXT NULL,
  cloze_answer VARCHAR(255) NULL,
  examples_json LONGTEXT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  source VARCHAR(255) NULL,
  source_batch VARCHAR(36) NULL,
  check_flag TINYINT(1) NOT NULL DEFAULT 0,
  enriched TINYINT(1) NOT NULL DEFAULT 0,
  enrich_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  enrich_next_at DATETIME NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  dedupe_key VARCHAR(300) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_dedupe (user_id, dedupe_key),
  KEY idx_user_pos (user_id, pos),
  KEY idx_user_topic (user_id, topic),
  KEY idx_user_enriched (user_id, enriched),
  KEY idx_enrich_queue (enriched, active, enrich_next_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_state (
  card_id INT NOT NULL,
  mode ENUM('ru_de','cloze','article','dictation') NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  state TINYINT NOT NULL DEFAULT 0,
  due DATETIME NOT NULL,
  stability DOUBLE NOT NULL DEFAULT 0,
  difficulty DOUBLE NOT NULL DEFAULT 0,
  elapsed_days INT NOT NULL DEFAULT 0,
  scheduled_days INT NOT NULL DEFAULT 0,
  learning_steps INT NOT NULL DEFAULT 0,
  reps INT NOT NULL DEFAULT 0,
  lapses INT NOT NULL DEFAULT 0,
  last_review DATETIME NULL,
  PRIMARY KEY (card_id, mode),
  KEY idx_user_due (user_id, due),
  CONSTRAINT fk_state_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  client_uuid CHAR(36) NOT NULL,
  card_id INT NOT NULL,
  mode ENUM('ru_de','cloze','article','dictation') NOT NULL,
  rating TINYINT NOT NULL,
  correct TINYINT(1) NOT NULL,
  response_ms INT NULL,
  user_answer TEXT NULL,
  hints_used TINYINT NOT NULL DEFAULT 0,
  answered_at DATETIME NOT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_uuid (user_id, client_uuid),
  KEY idx_user_day (user_id, local_day),
  KEY idx_user_card (user_id, card_id, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sentences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  card_id INT NULL,
  text TEXT NOT NULL,
  corrected TEXT NOT NULL,
  errors LONGTEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  provider VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staging_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  batch_id VARCHAR(36) NOT NULL,
  term VARCHAR(255) NOT NULL,
  article ENUM('der','die','das') NULL,
  plural VARCHAR(255) NULL,
  pos ENUM('noun','verb','adj','adv','phrase','idiom','collocation') NOT NULL DEFAULT 'phrase',
  translation VARCHAR(500) NOT NULL,
  grammar TEXT NULL,
  example TEXT NULL,
  example_translation TEXT NULL,
  example_cloze TEXT NULL,
  cloze_answer VARCHAR(255) NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  check_flag TINYINT(1) NOT NULL DEFAULT 0,
  dedupe_key VARCHAR(300) NOT NULL,
  status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  reason VARCHAR(255) NULL,
  provider VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_status (user_id, status),
  KEY idx_user_dedupe (user_id, dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key CHAR(64) PRIMARY KEY,
  feature VARCHAR(30) NOT NULL,
  response MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_usage (
  day DATE NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  provider VARCHAR(30) NOT NULL,
  feature VARCHAR(30) NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  failures INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, provider, feature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  user_id INT UNSIGNED NOT NULL,
  key_name VARCHAR(50) NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_stats (
  user_id INT UNSIGNED NOT NULL,
  day DATE NOT NULL,
  reviews INT NOT NULL DEFAULT 0,
  correct INT NOT NULL DEFAULT 0,
  new_cards INT NOT NULL DEFAULT 0,
  active_seconds INT NOT NULL DEFAULT 0,
  ext_audio_min INT NOT NULL DEFAULT 0,
  ext_speaking_min INT NOT NULL DEFAULT 0,
  ext_reading_min INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  filename VARCHAR(255) NULL,
  total INT NOT NULL, added INT NOT NULL, merged INT NOT NULL, flagged INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_keys (
  user_id INT UNSIGNED NOT NULL,
  provider VARCHAR(20) NOT NULL,
  ciphertext VARBINARY(512) NOT NULL,
  iv VARBINARY(12) NOT NULL,
  tag VARBINARY(16) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS speaking_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  topic VARCHAR(120) NOT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  persona VARCHAR(255) NOT NULL,
  target_card_ids TEXT NULL,
  turns_json LONGTEXT NOT NULL,
  feedback_json LONGTEXT NULL,
  score SMALLINT NULL,
  status ENUM('active','finished') NOT NULL DEFAULT 'active',
  local_day CHAR(10) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_speaking_sessions_user (user_id, local_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_error_profile (
  user_id INT UNSIGNED NOT NULL,
  category VARCHAR(40) NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 1,
  last_example VARCHAR(500) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, category),
  KEY idx_error_profile_hits (user_id, hits)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tts_cache (
  cache_key CHAR(64) PRIMARY KEY,
  voice VARCHAR(64) NOT NULL,
  mime VARCHAR(32) NOT NULL DEFAULT 'audio/mpeg',
  audio LONGBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
