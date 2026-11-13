-- db/schema_v2.sql — финальная форма (A2): все таблицы v2 с user_id

CREATE TABLE IF NOT EXISTS texts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('reading','listening','dialogue') NOT NULL,
  title VARCHAR(200) NOT NULL,
  body LONGTEXT NOT NULL,
  speakers LONGTEXT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  source ENUM('ai','pasted') NOT NULL DEFAULT 'ai',
  target_card_ids LONGTEXT NULL,
  questions LONGTEXT NULL,
  glossary LONGTEXT NULL,
  word_count INT NOT NULL DEFAULT 0,
  provider VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_kind (user_id, kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS text_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  text_id INT NOT NULL,
  mode ENUM('read','listen','dictation') NOT NULL,
  answers LONGTEXT NULL,
  correct INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  plays_used TINYINT NOT NULL DEFAULT 0,
  seconds INT NOT NULL DEFAULT 0,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_text (user_id, text_id), KEY idx_user_day (user_id, local_day),
  CONSTRAINT fk_att_text FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS translation_sets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('ru_de','de_ru','transform','basket') NOT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NULL,
  focus VARCHAR(50) NULL,
  items LONGTEXT NOT NULL,
  target_card_ids LONGTEXT NULL,
  provider VARCHAR(30) NULL,
  answers LONGTEXT NULL,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_at DATETIME NULL,
  KEY idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  task_type VARCHAR(30) NOT NULL,
  topic VARCHAR(80) NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  prompt_ru TEXT NULL,
  prompt_de TEXT NULL,
  key_points LONGTEXT NULL,
  model_text LONGTEXT NULL,
  hint_card_ids LONGTEXT NULL,
  min_words INT NULL,
  provider VARCHAR(30) NULL,
  attempt_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  task_id INT NULL,
  task_type VARCHAR(30) NOT NULL,
  prompt TEXT NOT NULL,
  text TEXT NOT NULL,
  words INT NOT NULL DEFAULT 0,
  seconds INT NOT NULL DEFAULT 0,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_day (user_id, local_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('shadow','free') NOT NULL,
  prompt TEXT NOT NULL,
  expected TEXT NULL,
  transcript TEXT NOT NULL,
  engine VARCHAR(20) NOT NULL,
  duration_s INT NOT NULL DEFAULT 0,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_day (user_id, local_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS number_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  category ENUM('cardinal','year','date','time','price','phone','percent','decimal') NOT NULL,
  level TINYINT NOT NULL DEFAULT 1,
  expected VARCHAR(60) NOT NULL,
  answer VARCHAR(60) NOT NULL,
  correct TINYINT(1) NOT NULL,
  pattern VARCHAR(30) NULL,
  response_ms INT NULL,
  plays TINYINT NOT NULL DEFAULT 1,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_day (user_id, local_day), KEY idx_user_cat (user_id, category, local_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS exam_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  taken_on DATE NOT NULL,
  skill ENUM('lesen','hoeren','schreiben','sprechen','gesamt') NOT NULL,
  points DECIMAL(5,1) NOT NULL,
  max_points DECIMAL(5,1) NOT NULL DEFAULT 100,
  source VARCHAR(100) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_taken (user_id, taken_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('reading','listening','dictation_text','numbers','translation','speaking','writing','lookup') NOT NULL,
  ref_id INT NULL,
  seconds INT NOT NULL DEFAULT 0,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_day_kind (user_id, local_day, kind)
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
