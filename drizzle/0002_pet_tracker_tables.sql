DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '犬',
  breed TEXT NOT NULL DEFAULT '',
  age_years INTEGER,
  birth_date TEXT,
  weight TEXT,
  vet_name TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  date_done TEXT,
  date_next TEXT,
  detail TEXT,
  status TEXT,
  amount TEXT,
  memo TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
