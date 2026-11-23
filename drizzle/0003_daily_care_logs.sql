CREATE TABLE daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  log_date TEXT NOT NULL,
  log_time TEXT,
  category TEXT NOT NULL DEFAULT 'うんち',
  stool_hardness TEXT,
  stool_color TEXT,
  stool_amount TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
