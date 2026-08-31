-- Family meal planner. SQLite: one file, trivial to back up.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS person (
  id           INTEGER PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  tracked      INTEGER DEFAULT 0,   -- 1 = show macros for this person
  kcal_target  REAL,
  protein_min  REAL,
  protein_max  REAL
);

-- The reusable meal library. Grows every week.
CREATE TABLE IF NOT EXISTS meal (
  id         INTEGER PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  carb_flag  TEXT DEFAULT 'ok',     -- 'ok' | 'swap'
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meal_ingredient (
  id      INTEGER PRIMARY KEY,
  meal_id INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  item    TEXT NOT NULL,
  amount  REAL NOT NULL,
  unit    TEXT NOT NULL,
  aisle   TEXT DEFAULT 'Cupboard'
);

-- What the tracked person actually puts on their plate, with macros.
CREATE TABLE IF NOT EXISTS meal_portion (
  id       INTEGER PRIMARY KEY,
  meal_id  INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  kcal     REAL DEFAULT 0,
  protein  REAL DEFAULT 0,
  carbs    REAL DEFAULT 0,
  fat      REAL DEFAULT 0,
  optional INTEGER DEFAULT 0        -- 1 = a "boost", off by default
);

-- Fixed daily routine (omelette, shakes...). Editable, not hard-coded.
CREATE TABLE IF NOT EXISTS routine_item (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  label         TEXT NOT NULL,
  when_txt      TEXT DEFAULT '',
  kcal          REAL DEFAULT 0,
  protein       REAL DEFAULT 0,
  carbs         REAL DEFAULT 0,
  fat           REAL DEFAULT 0,
  training_only INTEGER DEFAULT 0,
  default_on    INTEGER DEFAULT 1,
  sort          INTEGER DEFAULT 0,
  eggs          REAL DEFAULT 0,     -- drives the shopping list
  shakes        REAL DEFAULT 0
);

-- A planned week. History lives here.
CREATE TABLE IF NOT EXISTS week (
  id         INTEGER PRIMARY KEY,
  start_date TEXT UNIQUE NOT NULL,  -- Monday, ISO date
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS week_day (
  week_id  INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
  dow      INTEGER NOT NULL,        -- 0=Mon .. 6=Sun
  meal_id  INTEGER REFERENCES meal(id) ON DELETE SET NULL,
  training INTEGER DEFAULT 0,
  PRIMARY KEY (week_id, dow)
);

CREATE TABLE IF NOT EXISTS tick (
  week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
  dow     INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  checked INTEGER NOT NULL,
  PRIMARY KEY (week_id, dow, row_key)
);

-- Non-meal shopping: household goods and per-person requests.
CREATE TABLE IF NOT EXISTS extra (
  id        INTEGER PRIMARY KEY,
  item      TEXT NOT NULL,
  aisle     TEXT DEFAULT 'Household',
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  recurring INTEGER DEFAULT 0,      -- 1 = auto-add to every new week
  amount    REAL DEFAULT 1,
  unit      TEXT DEFAULT 'unit'
);

CREATE TABLE IF NOT EXISTS week_extra (
  week_id  INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
  extra_id INTEGER NOT NULL REFERENCES extra(id) ON DELETE CASCADE,
  PRIMARY KEY (week_id, extra_id)
);

CREATE TABLE IF NOT EXISTS shop_tick (
  week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
  item    TEXT NOT NULL,
  checked INTEGER NOT NULL,
  PRIMARY KEY (week_id, item)
);

-- Family picks: who wants which meal next week.
CREATE TABLE IF NOT EXISTS meal_request (
  week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
  meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (week_id, meal_id, person_id)
);
