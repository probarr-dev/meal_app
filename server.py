#!/usr/bin/env python3
"""Family meal planner. Python stdlib + SQLite only — no dependencies to rot."""

import hashlib
import json
import math
import os
import re
import sqlite3
import urllib.parse
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("MEALPLAN_DB", os.path.join(HERE, "data", "mealplan.db"))
PORT = int(os.environ.get("PORT", "8080"))

AISLE_ORDER = ["Meat & Fish", "Fresh Produce", "Dairy & Chilled", "Bakery",
               "Frozen", "Cupboard", "Household", "Snacks"]

# Deliberately few. Tags only earn their place if they actually narrow a
# 50-meal list — see README for why these six and not more.
TAGS = ["Kids' favourite", "Healthy", "Low carb", "Quick", "Batch cook", "Treat"]


def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL lets the family read while someone else is writing. Without it,
    # two phones saving at once gives "database is locked".
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def migrate(conn):
    """Additive, idempotent. Safe to run on every boot."""
    def cols(table):
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}

    add = [
        ("person", "role", "TEXT DEFAULT 'parent'"),
        ("person", "sex", "TEXT DEFAULT 'male'"),
        ("person", "weight_kg", "REAL"),
        ("person", "height_cm", "REAL"),
        ("person", "age", "REAL"),
        ("person", "activity", "REAL DEFAULT 1.4"),
        ("person", "surplus", "REAL DEFAULT 250"),
        # Everyone gets plain meal planning. The nutrition layer is opt-in,
        # per person, from their own settings.
        ("person", "show_macros", "INTEGER DEFAULT 0"),
        ("person", "show_routine", "INTEGER DEFAULT 0"),
        ("person", "show_training", "INTEGER DEFAULT 0"),
        ("person", "show_calories", "INTEGER DEFAULT 0"),
        ("person", "show_carbnote", "INTEGER DEFAULT 0"),
        ("meal", "tags", "TEXT DEFAULT ''"),
        ("meal", "deleted_at", "TEXT"),
        ("meal", "draft", "INTEGER DEFAULT 0"),
        # A "standing" meal — Martin's WFH lunch, the wife's packed lunch for
        # work — needed every week regardless of whether it's on the family's
        # cooked-dinner plan at all. Extras couldn't hold this: it's several
        # ingredients as one unit, not a single flat line. recurring=1 means
        # its ingredients land on every week's shopping list automatically;
        # person_id (nullable) is whose need it is, same idea as extra.person_id.
        ("meal", "recurring", "INTEGER DEFAULT 0"),
        ("meal", "person_id", "INTEGER REFERENCES person(id)"),
        # Lunches are their own menu — beans on toast, a sandwich, an omelette —
        # not the family dinner recipes. Existing meals default to dinner.
        ("meal", "meal_type", "TEXT DEFAULT 'proper'"),
        ("routine_item", "deleted_at", "TEXT"),
        ("extra", "use_count", "INTEGER DEFAULT 0"),
        # Household admin: can edit the fixed routine, week-start day, and
        # other people's PINs. Everyone else can plan/vote but not reconfigure.
        ("person", "is_admin", "INTEGER DEFAULT 0"),
        ("person", "pin_hash", "TEXT"),
        # A private, shareable link that logs straight in as this person, no
        # PIN prompt — the token itself is the credential, same trust level
        # as a PIN (this app's whole auth model is "soft deterrent", not real
        # security). Meant for a parent to text directly to that person:
        # "vote now" with a link that just works, instead of pick-name-then-PIN.
        ("person", "link_token", "TEXT"),
        # 1 = still on the auto-set default (day+month of birth) — nag them
        # to pick a real one at login until they actually change it.
        ("person", "pin_default", "INTEGER DEFAULT 0"),
        ("person", "theme", "TEXT DEFAULT 'classic'"),
        # Closes voting for that week the moment a parent confirms attendance
        # — replaces the old fixed Friday-5pm deadline entirely.
        ("week", "confirmed", "INTEGER DEFAULT 0"),
        ("person", "color", "TEXT"),
        # NULL = every tab (the historical default, and every non-admin
        # today). Set = only these tabs show for that person.
        ("person", "allowed_tabs", "TEXT"),
        # A non-real "person" that ships with the example meal library so
        # seed content can have a "who's it for" without hardcoding an
        # actual name — never shown at login or in Settings' Family list,
        # only as an option on meals/extras.
        ("person", "is_placeholder", "INTEGER DEFAULT 0"),
        # A second, optional meal slot per day — now specifically for Kids
        # Lunches (holiday weeks), sourced from meals tagged 'kids_lunch'
        # rather than the general library.
        ("week_day", "lunch_meal_id", "INTEGER REFERENCES meal(id)"),
        # How many meals this particular week needs choosing — defaults to
        # the household-wide setting (config: meals_target_default) but can
        # be bumped per week (e.g. more meals in a school holiday week).
        ("week", "meals_target", "INTEGER"),
        # How many of an extra to get this particular week — "2 juice"
        # instead of the household default of 1 — without changing what
        # future weeks default to.
        ("week_extra", "qty", "INTEGER DEFAULT 1"),
    ]
    for table, col, decl in add:
        if col not in cols(table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")

    # Votes are per *day* — wanting burgers is meaningless without saying when.
    # meal_request's PK can't take a new column in SQLite, so this supersedes it.
    conn.execute("""CREATE TABLE IF NOT EXISTS vote (
        week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        dow       INTEGER NOT NULL,
        meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        PRIMARY KEY (week_id, dow, meal_id, person_id))""")
    if conn.execute("SELECT COUNT(*) c FROM meal_request").fetchone()["c"]:
        conn.execute("""INSERT OR IGNORE INTO vote(week_id,dow,meal_id,person_id)
                        SELECT week_id, 0, meal_id, person_id FROM meal_request""")
        conn.execute("DELETE FROM meal_request")

    # Voting now needs a lunch/dinner dimension too. SQLite can't ALTER a
    # primary key, so rebuild the table if 'slot' isn't already part of it —
    # a plain ALTER ADD COLUMN would leave the old PK still missing slot,
    # which would silently block voting the same meal for both slots.
    vote_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='vote'").fetchone()["sql"]
    if "slot" not in vote_sql:
        conn.execute("""CREATE TABLE vote_new (
            week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
            dow       INTEGER NOT NULL,
            slot      TEXT NOT NULL DEFAULT 'dinner',
            meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
            person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
            PRIMARY KEY (week_id, dow, slot, meal_id, person_id))""")
        conn.execute("""INSERT INTO vote_new(week_id,dow,slot,meal_id,person_id)
                        SELECT week_id,dow,'dinner',meal_id,person_id FROM vote""")
        conn.execute("DROP TABLE vote")
        conn.execute("ALTER TABLE vote_new RENAME TO vote")

    conn.execute("""CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL)""")
    conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('week_start_dow','5')")

    # One veto per person per week, enforced by the primary key.
    # User-orderable aisle sequence — lets the shopping list match how you
    # actually walk a particular store, not a fixed guess.
    # Routine items get real ingredients (any item, any quantity) instead of
    # the old hardcoded eggs/shakes counters — "2 eggs" was a start, but
    # "bread and butter" needs the same flexibility a meal's ingredients have.
    conn.execute("""CREATE TABLE IF NOT EXISTS routine_item_ingredient (
        id INTEGER PRIMARY KEY, routine_item_id INTEGER NOT NULL REFERENCES routine_item(id) ON DELETE CASCADE,
        item TEXT NOT NULL, amount REAL NOT NULL, unit TEXT NOT NULL, aisle TEXT DEFAULT 'Cupboard')""")
    if not conn.execute("SELECT 1 FROM routine_item_ingredient LIMIT 1").fetchone():
        for r in rows(conn.execute("SELECT * FROM routine_item")):
            if r["eggs"]:
                conn.execute("""INSERT INTO routine_item_ingredient(routine_item_id,item,amount,unit,aisle)
                                VALUES (?,?,?,?,?)""", (r["id"], "Eggs", r["eggs"], "unit", "Dairy & Chilled"))
            if r["shakes"]:
                conn.execute("""INSERT INTO routine_item_ingredient(routine_item_id,item,amount,unit,aisle)
                                VALUES (?,?,?,?,?)""", (r["id"], "Whey protein", r["shakes"], "shake", "Cupboard"))
        # The egg-in-a-basket needs bread too, not just eggs — the concrete
        # example that prompted this change.
        basket = conn.execute("SELECT id FROM routine_item WHERE key='preGym'").fetchone()
        if basket:
            conn.execute("""INSERT INTO routine_item_ingredient(routine_item_id,item,amount,unit,aisle)
                            VALUES (?,'Sliced bread',2,'unit','Bakery'), (?,'Butter',1,'pack','Dairy & Chilled')""",
                         (basket["id"], basket["id"]))

    conn.execute("""CREATE TABLE IF NOT EXISTS aisle_order (
        name TEXT PRIMARY KEY, pos INTEGER NOT NULL)""")
    if not conn.execute("SELECT 1 FROM aisle_order LIMIT 1").fetchone():
        for i, a in enumerate(AISLE_ORDER):
            conn.execute("INSERT INTO aisle_order(name,pos) VALUES (?,?)", (a, i))

    # Different stores have their aisles in a different physical order —
    # what was one global list is now per-store, so the list actually
    # matches the walk from the door for whichever shop you're doing this
    # week, not just one fixed guess.
    conn.execute("""CREATE TABLE IF NOT EXISTS store (
        id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort INTEGER DEFAULT 0)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS store_aisle_order (
        store_id INTEGER NOT NULL REFERENCES store(id) ON DELETE CASCADE,
        name TEXT NOT NULL, pos INTEGER NOT NULL,
        PRIMARY KEY (store_id, name))""")
    if not conn.execute("SELECT 1 FROM store LIMIT 1").fetchone():
        # Carry the one existing (global) order over as the first store,
        # named after whatever's already configured, rather than starting
        # everyone's aisle order over from scratch.
        cur = conn.execute("INSERT INTO store(name,sort) VALUES ('My Store',0)")
        sid = cur.lastrowid
        for r in rows(conn.execute("SELECT name, pos FROM aisle_order ORDER BY pos")):
            conn.execute("INSERT INTO store_aisle_order(store_id,name,pos) VALUES (?,?,?)",
                         (sid, r["name"], r["pos"]))

    # Who's actually eating a given day — absence of a row means "in" by
    # default, so this only needs touching when someone's away or skipping.
    # Voting still always produces exactly one meal per day; this just stops
    # someone who won't be there from swinging what everyone else gets.
    conn.execute("""CREATE TABLE IF NOT EXISTS attendance (
        week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        dow INTEGER NOT NULL,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        in_attendance INTEGER NOT NULL,
        PRIMARY KEY (week_id, dow, person_id))""")

    # Rewards: kids bank points for healthy choices, redeem them for a
    # parent-approved treat with a budget cap the parent sets — the point is
    # they learn "choose well consistently → afford a treat", not that any
    # vote can be redeemed for an unlimited restaurant bill.
    conn.execute("""CREATE TABLE IF NOT EXISTS reward (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, points_cost INTEGER NOT NULL,
        suggested_budget_gbp REAL, active INTEGER DEFAULT 1)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS points_ledger (
        id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        week_id INTEGER, dow INTEGER, slot TEXT, delta INTEGER NOT NULL,
        reason TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(person_id, week_id, dow, slot))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS redemption (
        id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        reward_id INTEGER NOT NULL REFERENCES reward(id),
        status TEXT NOT NULL DEFAULT 'pending',
        budget_gbp REAL, note TEXT DEFAULT '',
        requested_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, resolved_by INTEGER)""")
    if not conn.execute("SELECT 1 FROM reward LIMIT 1").fetchone():
        conn.execute("""INSERT INTO reward(name,points_cost,suggested_budget_gbp) VALUES
            ('Takeaway of my choice', 20, 15),
            ('Restaurant of my choice', 40, 30),
            ('Choose a treat at the shop', 8, 5)""")
    conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('healthy_tags', 'Healthy')")

    conn.execute("""CREATE TABLE IF NOT EXISTS veto (
        week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        dow       INTEGER NOT NULL,
        meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
        PRIMARY KEY (week_id, person_id))""")

    # The per-day/slot vote grid turned out to be too fiddly for real use —
    # people ended up "voting" for several different meals in the same slot
    # just by tapping around. Replaced with one flat weekly poll: like a meal
    # or don't, no day attached. `week_meal` is the finalized shortlist a
    # parent ticks from the poll results; day assignment happens separately
    # on the Plan page, entirely by hand.
    conn.execute("""CREATE TABLE IF NOT EXISTS meal_vote (
        week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        PRIMARY KEY (week_id, meal_id, person_id))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS week_meal (
        week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        meal_id INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
        PRIMARY KEY (week_id, meal_id))""")
    # One-time carry-over from the old per-day/slot vote table: a person's
    # distinct per-day picks collapse into "liked this meal" in the new flat
    # poll. Old data is left in place untouched, just no longer read from.
    if not conn.execute("SELECT 1 FROM config WHERE key='meal_vote_migrated'").fetchone():
        conn.execute("""INSERT OR IGNORE INTO meal_vote(week_id, meal_id, person_id)
                        SELECT DISTINCT week_id, meal_id, person_id FROM vote""")
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('meal_vote_migrated','1')")
    conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('meals_target_default','7')")

    # Renamed from dinner/lunch — these are grouping labels, not fixed time
    # slots. A "light" meal can go in either the lunch or dinner spot on a
    # given day, same for "proper"; nothing is locked to one or the other.
    conn.execute("UPDATE meal SET meal_type='proper' WHERE meal_type='dinner'")
    conn.execute("UPDATE meal SET meal_type='light' WHERE meal_type='lunch'")

    # Gated on a one-time flag, NOT on "does a light meal exist". meal_type is a
    # comma-joined list ('light,kids_lunch'), so the old exact-match test
    # `WHERE meal_type='light'` went false as soon as a parent ticked a second
    # box on the last plain-'light' meal — and this block then tried to re-INSERT
    # five starter meals whose names are still in the library. meal.name is
    # UNIQUE, so that raised IntegrityError out of migrate() → init_db() → exit
    # before binding the port, and systemd's Restart=always turned it into a
    # permanent crash loop. INSERT OR IGNORE below is the second line of defence.
    # Gated on a one-time flag, NOT on "does a light meal exist". meal_type is a
    # comma-joined list ('light,kids_lunch'), so the old exact-match test
    # `WHERE meal_type='light'` went false the moment a parent ticked a second
    # box on the last plain-'light' meal — and this block then re-INSERTed five
    # starter meals whose names were still in the library. meal.name is UNIQUE,
    # so that raised IntegrityError out of migrate() → init_db() → the process
    # exited before binding the port, and systemd's Restart=always turned it
    # into a permanent crash loop.
    if not conn.execute("SELECT 1 FROM config WHERE key='light_meals_seeded'").fetchone():
        if conn.execute("SELECT COUNT(*) c FROM meal").fetchone()["c"]:
            # An established library doesn't want a starter set dropped into
            # it — just record that seeding is done and never look again.
            pass
        else:
            starters = [
                ("Beans on Toast", "Bread", "Baked beans", [
                    ("Sliced bread", 1, "loaf", "Bakery"), ("Baked beans", 2, "tin", "Cupboard")]),
                ("Ham Sandwich", "Bread", "", [
                    ("Sliced bread", 1, "loaf", "Bakery"), ("Ham", 1, "pack", "Meat & Fish"),
                    ("Butter", 1, "pack", "Dairy & Chilled")]),
                ("Omelette", "OK", "", [
                    ("Eggs", 6, "unit", "Dairy & Chilled"), ("Cheese slices", 1, "pack", "Dairy & Chilled")]),
                ("Jacket Potato", "OK", "", [
                    ("Potatoes", 4, "unit", "Fresh Produce"), ("Cheese slices", 1, "pack", "Dairy & Chilled"),
                    ("Baked beans", 1, "tin", "Cupboard")]),
                ("Soup & a Roll", "Bread", "", [
                    ("Soup", 2, "tin", "Cupboard"), ("Bread rolls", 1, "pack", "Bakery")]),
            ]
            for name, carb, note, ingredients in starters:
                # OR IGNORE is the second line of defence: even on a "fresh"
                # database, a name collision must never be fatal.
                cur = conn.execute(
                    "INSERT OR IGNORE INTO meal(name,carb_flag,note,meal_type) VALUES (?,?,?,'light')",
                    (name, "swap" if carb == "Bread" else "ok", note))
                if not cur.rowcount:
                    continue
                for item, amount, unit, aisle in ingredients:
                    conn.execute("""INSERT INTO meal_ingredient(meal_id,item,amount,unit,aisle)
                                    VALUES (?,?,?,?,?)""", (cur.lastrowid, item, amount, unit, aisle))
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('light_meals_seeded','1')")

    # The person whose macros are tracked keeps the full view.
    conn.execute("""UPDATE person SET show_macros=1, show_routine=1, show_training=1,
                    show_calories=1, show_carbnote=1
                    WHERE tracked=1 AND show_macros=0 AND show_routine=0 AND show_training=0""")

    # Someone has to be able to open the admin screen the first time. If no
    # one is marked admin yet, the earliest parent gets it — adjustable
    # afterwards from Settings by any existing admin.
    if not conn.execute(
            "SELECT 1 FROM person WHERE is_admin=1 AND is_placeholder=0").fetchone():
        first_parent = conn.execute(
            "SELECT id FROM person WHERE role='parent' AND is_placeholder=0 "
            "ORDER BY id LIMIT 1").fetchone()
        if first_parent:
            conn.execute("UPDATE person SET is_admin=1 WHERE id=?", (first_parent["id"],))

    # Kids get the fun theme by default; parents keep the plain one. Only
    # applied once — otherwise a kid who switches back to classic would get
    # silently reverted to fun on every server restart.
    if not conn.execute("SELECT 1 FROM config WHERE key='theme_defaults_applied'").fetchone():
        conn.execute("UPDATE person SET theme='fun' WHERE role!='parent'")
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('theme_defaults_applied','1')")

    # Everyone starts on the same generic PIN, marked as a default so the
    # login prompt keeps nagging until it's actually changed — only set if
    # they don't already have a real PIN, and only once ever per household.
    DEFAULT_PIN = "0000"
    if not conn.execute("SELECT 1 FROM config WHERE key='default_pins_applied'").fetchone():
        for row in conn.execute("SELECT id, pin_hash FROM person").fetchall():
            if not row["pin_hash"]:
                conn.execute("UPDATE person SET pin_hash=?, pin_default=1 WHERE id=?",
                             (hash_pin(DEFAULT_PIN), row["id"]))
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('default_pins_applied','1')")

    # Every person needs a link_token to have a shareable vote link at all —
    # backfilled here rather than only on first use, so it's ready the moment
    # a parent opens Settings, and idempotent (never touches one that exists).
    for row in rows(conn.execute("SELECT id FROM person WHERE link_token IS NULL")):
        conn.execute("UPDATE person SET link_token=? WHERE id=?", (os.urandom(16).hex(), row["id"]))

    # Anonymous per-meal rating — separate from the weekly poll on purpose.
    # The poll's vote tally deliberately shows who voted for what; this is
    # the opposite: a lasting "is this generally a hit" signal that nobody
    # has to worry will read as a personal verdict on whoever cooked it.
    conn.execute("""CREATE TABLE IF NOT EXISTS meal_rating (
        meal_id INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        stars INTEGER NOT NULL,
        PRIMARY KEY (meal_id, person_id))""")

    # Anyone can ask for something to go on the list — toothpaste, a random
    # craving — without it landing on the real shopping list unreviewed.
    # Mirrors the reward `redemption` table's shape/pattern deliberately: a
    # request, a status, who resolved it. Approving one creates/bumps a real
    # `extra` the same way /api/extra already does; denying just resolves it.
    conn.execute("""CREATE TABLE IF NOT EXISTS extra_request (
        id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        item TEXT NOT NULL, amount REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT 'unit',
        aisle TEXT NOT NULL DEFAULT 'Household', week_id INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, resolved_by INTEGER)""")

    # "Takeaway" / "Eating out" — a real day-plan option with deliberately no
    # ingredients, so it needs to be exempt from the "still needs ingredients"
    # nag that every other empty meal correctly gets. Seeded once; never
    # touched again even if renamed or deleted.
    if not conn.execute("SELECT 1 FROM config WHERE key='takeaway_seeded'").fetchone():
        for name in ("Takeaway", "Eating Out"):
            conn.execute("INSERT OR IGNORE INTO meal(name,meal_type) VALUES (?,'takeaway')", (name,))
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('takeaway_seeded','1')")
    conn.commit()


def init_db():
    with db() as conn:
        conn.executescript(open(os.path.join(HERE, "schema.sql")).read())
        migrate(conn)
        conn.commit()


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def get_week_start_dow(conn):
    """Which weekday a week begins on. 0=Mon..6=Sun, Python's date.weekday(). A
    setting, not a constant — this household shops Friday night for a
    Saturday-starting week, but that's not universal."""
    row = conn.execute("SELECT value FROM config WHERE key='week_start_dow'").fetchone()
    return int(row["value"]) if row else 5  # default Saturday


def week_start_of(conn, d: date) -> str:
    start_dow = get_week_start_dow(conn)
    delta = (d.weekday() - start_dow) % 7
    return (d - timedelta(days=delta)).isoformat()


def default_store_id(conn):
    row = conn.execute("SELECT id FROM store ORDER BY sort, id LIMIT 1").fetchone()
    return row["id"] if row else None


def store_aisle_order(conn, store_id):
    """This store's aisle order, falling back to the global default list for
    any aisle it hasn't been told about yet (a brand-new store, or a new
    aisle that's shown up since)."""
    order = [r["name"] for r in rows(conn.execute(
        "SELECT name FROM store_aisle_order WHERE store_id=? ORDER BY pos", (store_id,)))] if store_id else []
    if not order:
        order = [r["name"] for r in rows(conn.execute("SELECT name FROM aisle_order ORDER BY pos"))]
    return order or AISLE_ORDER


def protected_week_ids(conn):
    """Weeks that /api/bootstrap recreates the instant they're deleted.

    Deleting one appeared to do nothing: the DELETE succeeded, then the UI's
    own boot() call rebuilt the row via ensure_week() before the page redrew.
    Mirrors bootstrap's logic exactly, but never creates anything.
    """
    active = conn.execute("SELECT value FROM config WHERE key='active_week_id'").fetchone()
    arow = conn.execute("SELECT start_date FROM week WHERE id=?",
                        (active["value"],)).fetchone() if active else None
    this_start = date.fromisoformat(
        arow["start_date"] if arow else week_start_of(conn, date.today()))

    ids = set()
    def note(d):
        r = conn.execute("SELECT id, confirmed FROM week WHERE start_date=?", (d.isoformat(),)).fetchone()
        if r:
            ids.add(r["id"])
        return r

    note(this_start)
    nxt = this_start + timedelta(days=7)
    note(nxt)
    # bootstrap walks forward from next week to the first unconfirmed one
    d = nxt
    for _ in range(52):
        r = note(d)
        if not r or not r["confirmed"]:
            break
        d += timedelta(days=7)
    return ids


def voting_open(conn, week_id):
    """Voting stays open until a parent deliberately confirms the week's
    attendance — not a fixed clock time. Confirming is the close event."""
    row = conn.execute("SELECT confirmed FROM week WHERE id=?", (week_id,)).fetchone()
    return not (row and row["confirmed"])


def is_parent(conn, person_id):
    row = conn.execute("SELECT role FROM person WHERE id=?", (person_id,)).fetchone()
    return bool(row and row["role"] == "parent")


def is_admin(conn, person_id):
    if not person_id:
        return False
    row = conn.execute("SELECT is_admin FROM person WHERE id=?", (person_id,)).fetchone()
    return bool(row and row["is_admin"])


def hash_pin(pin, salt=None):
    salt = salt or os.urandom(8).hex()
    h = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 100_000).hex()
    return f"{salt}${h}"


def check_pin(pin, stored):
    if not stored or "$" not in stored:
        return False
    salt, _ = stored.split("$", 1)
    return hash_pin(pin, salt) == stored


def ensure_week(conn, start_date):
    row = conn.execute("SELECT id FROM week WHERE start_date=?", (start_date,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO week(start_date) VALUES (?)", (start_date,))
    for dow in range(7):
        conn.execute("INSERT INTO week_day(week_id,dow) VALUES (?,?)", (cur.lastrowid, dow))
    conn.commit()
    return cur.lastrowid


# ---------------------------------------------------------------- shopping

# Blind "+s" gave "2 loafs" and "2 bunchs" on the printed list.
PLURALS = {"loaf": "loaves", "bunch": "bunches", "box": "boxes", "punnet": "punnets"}


def fmt_qty(amount, unit):
    if unit == "g":
        return f"{amount / 1000:g}kg" if amount >= 1000 else f"{amount:g}g"
    if unit == "ml":
        return f"{amount / 1000:g}L" if amount >= 1000 else f"{amount:g}ml"
    # Everything else is a countable thing off a shelf. Half a meal's worth of
    # a pack is still a whole pack in the trolley, so round up — "0.75 packs
    # carrots" is not something you can pick up.
    amount = math.ceil(amount - 1e-9)
    if unit == "unit":
        return f"× {amount:g}"
    if amount == 1:
        return f"{amount:g} {unit}"
    return f"{amount:g} {PLURALS.get(unit, unit + 's')}"


def shop_done(conn, week_id):
    """True when this week's list exists and every line of it is ticked off."""
    groups = build_shopping(conn, week_id)
    items = [i for g in groups for i in g["items"]]
    return bool(items) and all(i["checked"] for i in items)


def build_shopping(conn, week_id, store_id=None):
    """Aggregate every ingredient across the week, plus routine items and extras."""
    totals = {}  # item -> dict

    def add(item, amount, unit, aisle, tag=None, note=None, meal=None):
        # Different meals spell the same ingredient differently ("Grated
        # Cheese" vs "grated cheese") — normalise casing before grouping, or
        # they silently end up as two separate lines instead of summing.
        item = " ".join(item.strip().split()).title()
        key = item
        if key not in totals:
            totals[key] = {"item": item, "amount": 0, "unit": unit,
                           "aisle": aisle, "tags": set(), "note": note, "meals": {}}
        # Mixed units for one item would silently corrupt the total; keep them
        # apart — EXCEPT that 'unit' carries no dimension, it just means "one of
        # these". A meal asking for "1 bottle BBQ sauce" and a household extra
        # asking for "1 BBQ sauce" are the same purchase, and splitting them
        # into two lines means buying two. Fold 'unit' into the specific one.
        if totals[key]["unit"] != unit:
            if unit == "unit":
                unit = totals[key]["unit"]
            elif totals[key]["unit"] == "unit":
                totals[key]["unit"] = unit
            else:
                key = f"{item} ({unit})"
                if key not in totals:
                    totals[key] = {"item": item, "amount": 0, "unit": unit,
                                   "aisle": aisle, "tags": set(), "note": note, "meals": {}}
        totals[key]["amount"] += amount
        if tag:
            totals[key]["tags"].add(tag)
        if note:
            totals[key]["note"] = note
        if meal:
            totals[key]["meals"][meal[0]] = meal[1]

    # This is a meal planner, not a daily-intake tracker — only what's
    # actually on the plan (dinner/lunch) and extras go on the list.
    # The old fixed-routine (breakfast/shakes) and per-portion macro
    # tracking are gone; nothing implicit gets added behind the scenes.
    days = rows(conn.execute(
        """SELECT dow, meal_id, lunch_meal_id FROM week_day
           WHERE week_id=? AND (meal_id IS NOT NULL OR lunch_meal_id IS NOT NULL)""", (week_id,)))

    meal_names = {}
    assigned_meal_ids = set()
    for d in days:
        for mid in (d["meal_id"], d["lunch_meal_id"]):
            if not mid:
                continue
            assigned_meal_ids.add(mid)
            if mid not in meal_names:
                meal_names[mid] = conn.execute("SELECT name FROM meal WHERE id=?", (mid,)).fetchone()["name"]
            for ing in rows(conn.execute(
                    "SELECT * FROM meal_ingredient WHERE meal_id=?", (mid,))):
                add(ing["item"], ing["amount"], ing["unit"], ing["aisle"], meal=(mid, meal_names[mid]))

    # Standing meals (Martin's WFH lunch, a packed lunch for work) — needed
    # every week whether or not they're plotted on a day. Skip any that
    # happen to ALSO be assigned to a day above, so it isn't counted twice.
    for r in rows(conn.execute("""
            SELECT m.id, m.name, p.name AS person FROM meal m
            LEFT JOIN person p ON p.id = m.person_id
            WHERE m.recurring = 1 AND m.deleted_at IS NULL""")):
        if r["id"] in assigned_meal_ids:
            continue
        for ing in rows(conn.execute(
                "SELECT * FROM meal_ingredient WHERE meal_id=?", (r["id"],))):
            add(ing["item"], ing["amount"], ing["unit"], ing["aisle"],
                tag=r["person"] or "everyone", meal=(r["id"], r["name"]))

    for e in rows(conn.execute(
            """SELECT e.*, p.name AS person, COALESCE(we.qty, 1) AS qty FROM extra e
               LEFT JOIN person p ON p.id = e.person_id
               LEFT JOIN week_extra we ON we.extra_id = e.id AND we.week_id = ?
               WHERE e.recurring = 1
                  OR e.id IN (SELECT extra_id FROM week_extra WHERE week_id=?)""", (week_id, week_id))):
        # "everyone" not "household": the aisle list already has a Household
        # aisle, and having both meanings share a word is what made the two
        # dropdowns on the add-item row indistinguishable.
        add(e["item"], e["amount"] * e["qty"], e["unit"], e["aisle"], tag=e["person"] or "everyone")

    checked = {t["item"]: t["checked"]
               for t in rows(conn.execute("SELECT * FROM shop_tick WHERE week_id=?", (week_id,)))}

    by_aisle = {}
    for key, t in totals.items():
        t = {**t, "tags": sorted(t["tags"]), "key": key,
             "qty": fmt_qty(t["amount"], t["unit"]), "checked": bool(checked.get(key, 0)),
             "meals": [{"id": mid, "name": name} for mid, name in sorted(t["meals"].items(), key=lambda x: x[1])]}
        by_aisle.setdefault(t["aisle"], []).append(t)

    order = store_aisle_order(conn, store_id or default_store_id(conn))
    out = []
    for aisle in order + sorted(set(by_aisle) - set(order)):
        if aisle in by_aisle:
            out.append({"aisle": aisle, "items": sorted(by_aisle[aisle], key=lambda i: i["item"])})
    return out


# ---------------------------------------------------------------- week view

def tdee(p):
    """Mifflin-St Jeor + activity factor. Returns None until stats are entered —
    better an honest blank than a made-up target."""
    if not (p and p["weight_kg"] and p["height_cm"] and p["age"]):
        return None
    bmr = 10 * p["weight_kg"] + 6.25 * p["height_cm"] - 5 * p["age"]
    bmr += 5 if (p["sex"] or "male") == "male" else -161
    maintenance = bmr * (p["activity"] or 1.4)
    return {
        "bmr": round(bmr),
        "maintenance": round(maintenance),
        "target": round(maintenance + (p["surplus"] or 0)),
        "surplus": p["surplus"] or 0,
    }


def build_week(conn, week_id, viewer_id=None):
    """The week's plan: which meal (and optional Lunch) is on for each day."""
    wk = conn.execute("SELECT * FROM week WHERE id=?", (week_id,)).fetchone()
    if not wk:
        return None

    days_by_dow = {d["dow"]: d for d in rows(conn.execute(
        "SELECT * FROM week_day WHERE week_id=?", (week_id,)))}

    out_days = []
    for dow in range(7):
        wd = days_by_dow.get(dow, {})
        meal = None
        if wd.get("meal_id"):
            meal = dict(conn.execute("SELECT * FROM meal WHERE id=?", (wd["meal_id"],)).fetchone())
        lunch = None
        if wd.get("lunch_meal_id"):
            lunch = dict(conn.execute("SELECT * FROM meal WHERE id=?", (wd["lunch_meal_id"],)).fetchone())
        out_days.append({"dow": dow, "meal": meal, "lunch": lunch})

    return {"week": dict(wk), "days": out_days}


# ---------------------------------------------------------------- http

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, "static"), **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # Static files (app.js/style.css/index.html) were being cached by some
        # mobile browsers indefinitely with no cache-busting, so a deploy could
        # silently not show up on a phone even after a manual refresh.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    # -- helpers
    def send_json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or "{}")

    # -- routing
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = urllib.parse.parse_qs(u.query)
        try:
            with db() as conn:
                return self.api_get(conn, u.path, q)
        # A missing or non-numeric ?id= is a bad request, not a server fault.
        # It used to surface the raw Python text ("invalid literal for int()
        # with base 10") in the app's error box, which tells nobody anything.
        except (KeyError, ValueError, IndexError):
            return self.send_json({"error": "That request was missing something or malformed."}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = self.read_json()
        except Exception:
            return self.send_json({"error": "That request wasn't valid JSON."}, 400)
        try:
            with db() as conn:
                return self.api_post(conn, u.path, body)
        except (KeyError, ValueError, IndexError):
            return self.send_json({"error": "That request was missing something or malformed."}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def api_get(self, conn, path, q):
        if path == "/api/bootstrap":
            # "This week" is normally just whichever calendar week contains
            # today — but the household actually shops Friday evening or
            # Saturday morning once that week's food is eaten, not strictly
            # on the calendar boundary. A parent can nudge "this week"
            # forward a little early by hand (see /api/week/advance).
            #
            # That pin must not outlive its week, though — a household that
            # forgets to tap it again just sat frozen on an already-elapsed
            # week indefinitely (confirmed real: kids saw last Saturday's
            # takeaway day still showing days later and thought it was
            # happening again). A pin more than 7 days stale is treated as
            # forgotten, not deliberate, and the calendar takes back over.
            active_row = conn.execute("SELECT value FROM config WHERE key='active_week_id'").fetchone()
            active_week = conn.execute("SELECT start_date FROM week WHERE id=?",
                                       (active_row["value"],)).fetchone() if active_row else None
            this_start = this_id = None
            if active_week:
                pinned_start = date.fromisoformat(active_week["start_date"])
                if date.today() < pinned_start + timedelta(days=7):
                    this_start = active_week["start_date"]
                    this_id = int(active_row["value"])
            if this_start is None:
                this_start = week_start_of(conn, date.today())
                this_id = ensure_week(conn, this_start)
            next_start = (date.fromisoformat(this_start) + timedelta(days=7)).isoformat()
            next_id = ensure_week(conn, next_start)
            # Voting is next week by default — but a parent can pin it to any
            # week (vote_week_override), for exactly the case where real time
            # has moved past a week whose voting isn't actually finished. The
            # "this week" pin has a 7-day staleness expiry so it can't get
            # stuck forever; that expiry is judged against the PINNED WEEK's
            # own date, so a fresh press can be born "stale" the moment real
            # time reaches that week. The vote override deliberately has no
            # such expiry — a parent setting it right now is never stale by
            # definition — but it clears itself the moment that week is
            # confirmed, so it can't outlive its own reason for existing.
            vote_id = next_id
            override_row = conn.execute(
                "SELECT value FROM config WHERE key='vote_week_override'").fetchone()
            if override_row:
                ov_id = int(override_row["value"])
                # A Row never equals a plain tuple, so comparing the fetched
                # row itself to (0,) is always False — read the column, not
                # the row.
                ov_week = conn.execute("SELECT confirmed FROM week WHERE id=?", (ov_id,)).fetchone()
                if ov_week and ov_week["confirmed"] == 0:
                    vote_id = ov_id
                else:
                    conn.execute("DELETE FROM config WHERE key='vote_week_override'")
            weeks = rows(conn.execute("SELECT * FROM week ORDER BY start_date DESC"))
            people = rows(conn.execute("SELECT * FROM person ORDER BY role DESC, id"))
            for p in people:
                p["energy"] = tdee(p)
                p["has_pin"] = bool(p.pop("pin_hash", None))
                # The token IS the credential for the magic vote link — if
                # this ever went out in the normal people list, anyone logged
                # in as anyone could read it out of devtools and vote as
                # someone else. It's only ever handed out via the dedicated,
                # parent-gated /api/person/link endpoint below.
                p.pop("link_token", None)
            aisles = [r["name"] for r in rows(conn.execute("SELECT name FROM aisle_order ORDER BY pos"))]
            return self.send_json({
                "weeks": weeks, "people": people, "aisles": aisles or AISLE_ORDER, "tags": TAGS,
                "thisWeekId": this_id, "nextWeekId": next_id, "voteWeekId": vote_id,
                # Once everything on this week's list is in the trolley, the
                # week in hand is finished with — anything added from then on
                # is for the next shop, not this one.
                "shopDone": shop_done(conn, this_id),
                # A fresh clone: nothing but the placeholder "Family" person
                # exists yet. The client shows the setup wizard instead of
                # the normal login gate until this flips false.
                "needsSetup": not any(not p["is_placeholder"] for p in people),
                "votingOpen": voting_open(conn, vote_id),
                "weekStartDow": get_week_start_dow(conn),
                "protectedWeekIds": sorted(protected_week_ids(conn)),
                "mealsTargetDefault": int((conn.execute(
                    "SELECT value FROM config WHERE key='meals_target_default'").fetchone() or {"value": "7"})["value"]),
                # Days already eaten are history: dimmed, and read-only unless
                # the household deliberately turns editing back on.
                "allowHistoricEdits": (conn.execute(
                    "SELECT value FROM config WHERE key='allow_historic_edits'").fetchone()
                    or {"value": "0"})["value"] == "1",
            })

        if path == "/api/person/by-token":
            # Deliberately no auth beyond the token itself — knowing it IS the
            # credential, same trust level as this app's PINs. Never leaks
            # which tokens are valid (a miss just looks identical to a typo).
            token = q.get("t", [""])[0]
            row = conn.execute("SELECT id, name FROM person WHERE link_token=?", (token,)).fetchone()
            if not row:
                return self.send_json({"error": "Not a valid link."}, 404)
            return self.send_json({"id": row["id"], "name": row["name"]})

        if path == "/api/person/link":
            # A parent fetching another person's link to share it — not the
            # person themselves needing it, so this is parent-gated rather
            # than self-or-admin like the PIN endpoints are.
            admin_id = q.get("admin_id", [""])[0]
            if not is_parent(conn, int(admin_id) if admin_id else None):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            row = conn.execute("SELECT link_token FROM person WHERE id=?", (int(q["id"][0]),)).fetchone()
            if not row:
                return self.send_json({"error": "No such person."}, 404)
            return self.send_json({"token": row["link_token"]})

        if path == "/api/week":
            wid = int(q["id"][0])
            viewer = q.get("person", [""])[0]
            return self.send_json(build_week(conn, wid, int(viewer) if viewer else None))

        if path == "/api/shopping":
            wid = int(q["id"][0])
            sid = q.get("store_id", [""])[0]
            return self.send_json({"groups": build_shopping(conn, wid, int(sid) if sid else None)})

        if path == "/api/poll":
            # The new flat weekly poll — one like per person per meal, no
            # day or slot attached at all.
            wid = int(q["id"][0])
            tally = rows(conn.execute("""
                SELECT m.id, m.name, m.tags, m.draft, m.meal_type,
                       SUM(CASE WHEN p.role='parent' THEN 1 ELSE 0 END) AS parent_votes,
                       SUM(CASE WHEN p.role!='parent' THEN 1 ELSE 0 END) AS child_votes,
                       COUNT(*) AS total,
                       GROUP_CONCAT(p.name) AS voters
                FROM meal_vote v
                JOIN person p ON p.id = v.person_id
                JOIN meal m ON m.id = v.meal_id
                WHERE v.week_id=? AND m.deleted_at IS NULL
                GROUP BY m.id
                ORDER BY parent_votes DESC, child_votes DESC, m.name""", (wid,)))
            vetoed = {r["meal_id"] for r in rows(conn.execute(
                "SELECT meal_id FROM veto WHERE week_id=?", (wid,)))}
            chosen = {r["meal_id"] for r in rows(conn.execute(
                "SELECT meal_id FROM week_meal WHERE week_id=?", (wid,)))}
            # tally starts from an INNER JOIN on meal_vote, so a meal with zero
            # votes is simply absent from it — including one that's vetoed but
            # nobody (or nobody any more) has liked. Left unpatched, unliking
            # your own vote on a vetoed meal made it vanish from tally, and the
            # client's zero-vote fallback hardcodes vetoed:false — so the red
            # flag disappeared the instant the vote count hit zero, and came
            # back only because re-liking put a row back in the join. Backfill
            # any vetoed or chosen meal that isn't already present.
            present = {t["id"] for t in tally}
            missing = (vetoed | chosen) - present
            if missing:
                extra = rows(conn.execute(
                    f"SELECT id, name, tags, draft, meal_type FROM meal "
                    f"WHERE id IN ({','.join('?' * len(missing))}) AND deleted_at IS NULL",
                    tuple(missing)))
                for e in extra:
                    e["parent_votes"] = 0
                    e["child_votes"] = 0
                    e["total"] = 0
                    e["voters"] = ""
                tally.extend(extra)
            for t in tally:
                t["vetoed"] = t["id"] in vetoed
                t["chosen"] = t["id"] in chosen
            my_veto = None
            mine = set()
            me_q = q.get("person", [""])[0]
            if me_q:
                r = conn.execute("SELECT meal_id FROM veto WHERE week_id=? AND person_id=?",
                                 (wid, int(me_q))).fetchone()
                if r:
                    my_veto = r["meal_id"]
                mine = {r["meal_id"] for r in rows(conn.execute(
                    "SELECT meal_id FROM meal_vote WHERE week_id=? AND person_id=?", (wid, int(me_q))))}
            for t in tally:
                t["mine"] = t["id"] in mine
            wk = conn.execute("SELECT meals_target FROM week WHERE id=?", (wid,)).fetchone()
            default_target = int((conn.execute(
                "SELECT value FROM config WHERE key='meals_target_default'").fetchone() or {"value": "7"})["value"])
            target = (wk["meals_target"] if wk and wk["meals_target"] else default_target)
            return self.send_json({"tally": tally, "my_veto": my_veto, "target": target})

        if path == "/api/week/pool":
            # Meals finalized onto this week's shortlist but not yet assigned
            # to a day, plus the separate hand-curated Lunch list.
            wid = int(q["id"][0])
            assigned = {r["meal_id"] for r in rows(conn.execute(
                "SELECT meal_id FROM week_day WHERE week_id=? AND meal_id IS NOT NULL", (wid,)))}
            chosen = rows(conn.execute("""
                SELECT m.id, m.name FROM week_meal wm JOIN meal m ON m.id=wm.meal_id
                WHERE wm.week_id=? AND m.deleted_at IS NULL ORDER BY m.name""", (wid,)))
            pool = [m for m in chosen if m["id"] not in assigned]
            kids_lunch = rows(conn.execute("""
                SELECT id, name FROM meal
                WHERE deleted_at IS NULL AND meal_type LIKE '%kids_lunch%' ORDER BY name"""))
            return self.send_json({"pool": pool, "kidsLunch": kids_lunch})

        if path == "/api/export":
            # Every table, discovered at runtime rather than a hand-kept list.
            # The old fixed list had silently fallen ~15 tables behind the
            # schema — it was missing the poll (meal_vote), the shortlist
            # (week_meal), vetoes, stores and their aisle orders, all config,
            # and every reward/points/redemption row. With no backups running,
            # this file IS the recovery path, so it must not be able to drift
            # out of date again.
            dump = {"_exported": date.today().isoformat(), "_schema": {}}
            tables = [r["name"] for r in rows(conn.execute(
                """SELECT name FROM sqlite_master WHERE type='table'
                   AND name NOT LIKE 'sqlite_%' ORDER BY name"""))]
            for t in tables:
                dump["_schema"][t] = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()["sql"]
                data = rows(conn.execute(f'SELECT * FROM "{t}"'))
                # PIN hashes are the one thing not worth putting in a file
                # that gets dropped on a shared Samba folder. Everything else
                # is recoverable household data; a PIN is re-set in seconds.
                if t == "person":
                    for r in data:
                        r.pop("pin_hash", None)
                dump[t] = data
            body = json.dumps(dump, indent=1, default=str).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition",
                             f'attachment; filename="mealplan-{date.today().isoformat()}.json"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

        if path == "/api/meals":
            viewer = q.get("person", [""])[0]
            out = rows(conn.execute("""
                SELECT m.*, (SELECT COUNT(*) FROM week_day wd WHERE wd.meal_id=m.id) AS times_used,
                       (SELECT ROUND(AVG(stars), 1) FROM meal_rating WHERE meal_id=m.id) AS rating_avg,
                       (SELECT COUNT(*) FROM meal_rating WHERE meal_id=m.id) AS rating_count
                FROM meal m WHERE m.deleted_at IS NULL ORDER BY m.name"""))
            for m in out:
                m["ingredients"] = rows(conn.execute(
                    "SELECT * FROM meal_ingredient WHERE meal_id=? ORDER BY id", (m["id"],)))
                m["portions"] = rows(conn.execute(
                    "SELECT * FROM meal_portion WHERE meal_id=? ORDER BY optional, id", (m["id"],)))
                # Only ever your own rating — never anyone else's, that's the
                # whole point of it being anonymous. A join keyed to a single
                # viewer, not a list of everyone's stars.
                m["my_rating"] = None
                if viewer:
                    r = conn.execute("SELECT stars FROM meal_rating WHERE meal_id=? AND person_id=?",
                                     (m["id"], int(viewer))).fetchone()
                    m["my_rating"] = r["stars"] if r else None
            return self.send_json({"meals": out})

        if path == "/api/extras":
            # Ordered by how many PREVIOUS weeks this item was actually bought
            # in — deliberately excluding the week being viewed. use_count used
            # to drive this, but it increments the instant you add or bump
            # something, so the list reshuffled under your thumb while you were
            # still adding to it: you'd tap +, everything would jump, and the
            # next tap landed on the wrong row. Excluding the current week means
            # the order cannot move while you're working on that week's shop.
            wid = q.get("week_id", [""])[0]
            if wid:
                extras = rows(conn.execute(
                    """SELECT e.*, p.name AS person,
                              (SELECT COUNT(DISTINCT we.week_id) FROM week_extra we
                                WHERE we.extra_id = e.id AND we.week_id <> ?) AS prior_weeks
                       FROM extra e
                       LEFT JOIN person p ON p.id = e.person_id
                       ORDER BY e.recurring DESC, prior_weeks DESC, e.item COLLATE NOCASE""", (wid,)))
            else:
                extras = rows(conn.execute(
                    """SELECT e.*, p.name AS person,
                              (SELECT COUNT(DISTINCT we.week_id) FROM week_extra we
                                WHERE we.extra_id = e.id) AS prior_weeks
                       FROM extra e
                       LEFT JOIN person p ON p.id = e.person_id
                       ORDER BY e.recurring DESC, prior_weeks DESC, e.item COLLATE NOCASE"""))
            if wid:
                this_week = {r["extra_id"]: r["qty"] for r in rows(conn.execute(
                    "SELECT extra_id, qty FROM week_extra WHERE week_id=?", (wid,)))}
                for e in extras:
                    e["active"] = bool(e["recurring"]) or e["id"] in this_week
                    e["qty"] = this_week.get(e["id"], 1)
            # Piggybacks on the same fetch the Shopping page already makes —
            # no extra round trip for the parent-approval queue to show up.
            requests_ = rows(conn.execute("""
                SELECT er.*, p.name AS person FROM extra_request er
                JOIN person p ON p.id = er.person_id
                WHERE er.week_id=? AND er.status='pending'
                ORDER BY er.requested_at""", (wid,))) if wid else []
            return self.send_json({"extras": extras, "requests": requests_})

        if path == "/api/stores":
            return self.send_json({"stores": rows(conn.execute(
                "SELECT id, name FROM store ORDER BY sort, id"))})

        if path == "/api/ingredient-names":
            # Every distinct ingredient already typed somewhere, for
            # autocomplete when adding a new one — cuts down on "Grated
            # Cheese" vs "grated cheese" style spelling drift at the source,
            # not just papering over it when the shopping list totals up.
            # Extras are in here too, not just meal ingredients — "Bleach" and
            # "Mozzarella" need the same protection against a near-miss retype
            # as anything in a recipe does.
            names = {r["item"].strip().title() for r in rows(
                conn.execute("SELECT DISTINCT item FROM meal_ingredient")) if r["item"].strip()}
            names |= {r["item"].strip().title() for r in rows(
                conn.execute("SELECT DISTINCT item FROM extra")) if r["item"].strip()}
            # Also hand back the aisle each ingredient normally lives in, so
            # typing "Butter" on the shopping page can put it in Dairy &
            # Chilled instead of leaving it in the Household default. Items
            # filed in the wrong aisle quietly defeat the per-store ordering,
            # which is the whole point of that feature.
            aisles = {}
            for r in rows(conn.execute(
                    """SELECT item, aisle, COUNT(*) n FROM meal_ingredient
                       WHERE TRIM(item) <> '' GROUP BY LOWER(TRIM(item)), aisle
                       ORDER BY n""")):
                aisles[r["item"].strip().title()] = r["aisle"]  # most common wins (last)
            for r in rows(conn.execute(
                    "SELECT item, aisle FROM extra WHERE TRIM(item) <> ''")):
                aisles.setdefault(r["item"].strip().title(), r["aisle"])
            return self.send_json({"names": sorted(names), "aisleFor": aisles})

        if path == "/api/rewards":
            person = q.get("person", [""])[0]
            balances = {r["person_id"]: r["bal"] for r in rows(conn.execute(
                "SELECT person_id, SUM(delta) bal FROM points_ledger GROUP BY person_id"))}
            catalog = rows(conn.execute("SELECT * FROM reward WHERE active=1 ORDER BY points_cost"))
            requests = rows(conn.execute("""
                SELECT rd.*, p.name AS person_name, r.name AS reward_name, r.points_cost
                FROM redemption rd JOIN person p ON p.id=rd.person_id JOIN reward r ON r.id=rd.reward_id
                ORDER BY rd.requested_at DESC"""))
            healthy_tags = (conn.execute(
                "SELECT value FROM config WHERE key='healthy_tags'").fetchone() or {"value": ""})["value"]
            return self.send_json({
                "balances": balances, "catalog": catalog, "requests": requests,
                "myBalance": balances.get(int(person), 0) if person else 0,
                "healthyTags": [t for t in healthy_tags.split(",") if t],
            })

        if path == "/api/history":
            out = rows(conn.execute("SELECT * FROM week ORDER BY start_date DESC"))
            for w in out:
                w["meals"] = rows(conn.execute("""
                    SELECT wd.dow, m.name FROM week_day wd
                    JOIN meal m ON m.id = wd.meal_id
                    WHERE wd.week_id=? ORDER BY wd.dow""", (w["id"],)))
            return self.send_json({"weeks": out})

        return self.send_json({"error": "not found"}, 404)

    def api_post(self, conn, path, b):
        if path == "/api/shop-tick":
            conn.execute("""INSERT INTO shop_tick(week_id,item,checked) VALUES (?,?,?)
                            ON CONFLICT(week_id,item) DO UPDATE SET checked=excluded.checked""",
                         (b["week_id"], b["item"], int(b["checked"])))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/day":
            if not is_parent(conn, b.get("person_id")):
                return self.send_json({"error": "Only a parent can assign meals to days."}, 403)
            conn.execute("""INSERT OR IGNORE INTO week_day(week_id,dow) VALUES (?,?)""",
                         (b["week_id"], b["dow"]))
            # Only touch fields actually sent — lets "clear the lunch dropdown"
            # (send lunch_meal_id: null) work without also wiping the dinner.
            if "meal_id" in b:
                conn.execute("UPDATE week_day SET meal_id=? WHERE week_id=? AND dow=?",
                             (b["meal_id"], b["week_id"], b["dow"]))
            if "lunch_meal_id" in b:
                conn.execute("UPDATE week_day SET lunch_meal_id=? WHERE week_id=? AND dow=?",
                             (b["lunch_meal_id"], b["week_id"], b["dow"]))
            conn.commit()
            return self.send_json(build_week(conn, b["week_id"], b.get("person_id")))

        if path == "/api/week/delete":
            # Admin only — mainly for cleaning up weeks left mismatched after
            # changing the week-start-day setting.
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            # Refuse rather than silently no-op: this used to report success,
            # then bootstrap immediately rebuilt the week and it looked like
            # the delete had simply been ignored.
            if int(b["id"]) in protected_week_ids(conn):
                return self.send_json(
                    {"error": "That's the current, next or voting week — it's created "
                              "automatically, so deleting it won't stick. Move \"this week\" "
                              "forward from the Plan page first, or pick a different week."}, 400)
            conn.execute("DELETE FROM week WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/new":
            start = b.get("start_date") or week_start_of(conn, date.today() + timedelta(days=7))
            existing = conn.execute("SELECT id FROM week WHERE start_date=?", (start,)).fetchone()
            if existing:
                return self.send_json({"id": existing["id"], "existed": True})
            cur = conn.execute("INSERT INTO week(start_date) VALUES (?)", (start,))
            wid = cur.lastrowid
            copy_from = b.get("copy_from")
            for dow in range(7):
                meal_id = None
                if copy_from:
                    r = conn.execute("SELECT meal_id FROM week_day WHERE week_id=? AND dow=?",
                                     (copy_from, dow)).fetchone()
                    meal_id = r["meal_id"] if r else None
                conn.execute("INSERT INTO week_day(week_id,dow,meal_id) VALUES (?,?,?)",
                             (wid, dow, meal_id))
            conn.commit()
            return self.send_json({"id": wid})

        if path == "/api/meal":
            # Parents only — a child editing meals could quietly retag "Ice
            # Cream" as Healthy and game the points/rewards system.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can edit the meal library."}, 403)
            # Comma-separated, same pattern as tags — a meal can be suitable
            # for more than one occasion (e.g. "proper,light" covers both).
            mtype = b.get("meal_type") or "proper"
            if b.get("id"):
                # Only write the columns the client actually sent. carb_flag and
                # note no longer have inputs in the meal editor, so the old
                # unconditional UPDATE re-applied their defaults ('ok' and '')
                # on every save — silently blanking any note and clearing the
                # bread/pasta 'swap' marker the moment a parent edited a tag.
                # Same rule the ingredients/portions handling below already uses.
                cols_ = {"name": b["name"], "tags": b.get("tags", ""), "meal_type": mtype}
                for optional in ("carb_flag", "note"):
                    if optional in b:
                        cols_[optional] = b[optional]
                if "recurring" in b:
                    cols_["recurring"] = int(b["recurring"])
                    cols_["person_id"] = b.get("person_id") or None
                sets = ", ".join(f"{k}=?" for k in cols_)
                conn.execute(f"UPDATE meal SET {sets} WHERE id=?", (*cols_.values(), b["id"]))
                mid = b["id"]
                # Only replace ingredients/portions if actually sent — a save
                # that only touches the name/tags must not wipe the rest.
                # (This exact bug hit a real meal's data earlier in testing.)
                if "ingredients" in b:
                    conn.execute("DELETE FROM meal_ingredient WHERE meal_id=?", (mid,))
                    # A suggested meal starts as a bare-name draft with no
                    # ingredients; once someone actually fills them in via the
                    # editor, it's no longer a draft. Only clear on an actual
                    # non-empty save, so re-saving with an empty list doesn't
                    # silently mark it "done" with nothing in it.
                    if any(i.get("item") for i in b["ingredients"]):
                        conn.execute("UPDATE meal SET draft=0 WHERE id=?", (mid,))
                if "portions" in b:
                    conn.execute("DELETE FROM meal_portion WHERE meal_id=?", (mid,))
            else:
                cur = conn.execute(
                    "INSERT INTO meal(name,carb_flag,note,tags,meal_type,recurring,person_id) VALUES (?,?,?,?,?,?,?)",
                    (b["name"], b.get("carb_flag", "ok"), b.get("note", ""), b.get("tags", ""), mtype,
                     int(b.get("recurring") or 0), b.get("person_id") or None))
                mid = cur.lastrowid
            for i in b.get("ingredients", []):
                if not i.get("item"):
                    continue
                conn.execute("""INSERT INTO meal_ingredient(meal_id,item,amount,unit,aisle)
                                VALUES (?,?,?,?,?)""",
                             (mid, i["item"], float(i.get("amount") or 1),
                              i.get("unit") or "unit", i.get("aisle") or "Cupboard"))
            for p in b.get("portions", []):
                if not p.get("label"):
                    continue
                conn.execute("""INSERT INTO meal_portion
                                (meal_id,label,kcal,protein,carbs,fat,optional)
                                VALUES (?,?,?,?,?,?,?)""",
                             (mid, p["label"], float(p.get("kcal") or 0), float(p.get("protein") or 0),
                              float(p.get("carbs") or 0), float(p.get("fat") or 0),
                              int(p.get("optional") or 0)))
            conn.commit()
            return self.send_json({"id": mid})

        if path == "/api/poll-vote":
            # The new flat poll: a simple like/unlike toggle, no exclusivity —
            # liking several meals is the whole point now.
            if not voting_open(conn, b["week_id"]):
                return self.send_json({"error": "Voting's closed — the plan for this week has been confirmed."}, 400)
            key = (b["week_id"], b["meal_id"], b["person_id"])
            if conn.execute("SELECT 1 FROM meal_vote WHERE week_id=? AND meal_id=? AND person_id=?",
                            key).fetchone():
                conn.execute("DELETE FROM meal_vote WHERE week_id=? AND meal_id=? AND person_id=?", key)
            else:
                conn.execute("INSERT INTO meal_vote(week_id,meal_id,person_id) VALUES (?,?,?)", key)
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/poll-suggest":
            name = (b.get("name") or "").strip()
            if not name:
                return self.send_json({"error": "needs a name"}, 400)
            existing = conn.execute("SELECT id FROM meal WHERE name=? COLLATE NOCASE", (name,)).fetchone()
            if existing:
                mid = existing["id"]
                conn.execute("UPDATE meal SET deleted_at=NULL WHERE id=?", (mid,))
            else:
                cur = conn.execute("INSERT INTO meal(name,draft,note) VALUES (?,1,?)",
                                   (name, "Suggested — needs ingredients."))
                mid = cur.lastrowid
            conn.execute("INSERT OR IGNORE INTO meal_vote(week_id,meal_id,person_id) VALUES (?,?,?)",
                         (b["week_id"], mid, b["person_id"]))
            conn.commit()
            return self.send_json({"id": mid, "existed": bool(existing)})

        if path == "/api/poll-veto":
            existing = conn.execute("SELECT meal_id FROM veto WHERE week_id=? AND person_id=?",
                                    (b["week_id"], b["person_id"])).fetchone()
            if existing and existing["meal_id"] == b["meal_id"]:
                conn.execute("DELETE FROM veto WHERE week_id=? AND person_id=?",
                             (b["week_id"], b["person_id"]))
                conn.commit()
                return self.send_json({"ok": True, "vetoed": False})
            if existing:
                return self.send_json({"error": "Only one veto per week — undo your other one first."}, 400)
            conn.execute("INSERT INTO veto(week_id,person_id,dow,meal_id) VALUES (?,?,0,?)",
                         (b["week_id"], b["person_id"], b["meal_id"]))
            conn.commit()
            return self.send_json({"ok": True, "vetoed": True})

        if path == "/api/week/finalize":
            # A parent ticks which polled meals make this week's shortlist.
            # Ticking IS the close-voting action — one step, not two.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can finalise the week."}, 403)
            wid = b["week_id"]
            meal_ids = [int(m) for m in b.get("meal_ids", [])]
            # Finalising with nothing ticked used to close voting anyway,
            # leaving a locked week with an empty shortlist and no way back —
            # exactly how one week ended up stranded. Refuse instead.
            if not meal_ids:
                return self.send_json(
                    {"error": "Tick at least one meal before finalising — "
                              "this closes voting for the week."}, 400)
            # The tick list is the whole truth: anything unticked comes off the
            # shortlist. Previously this only ever INSERTed, so unticking a meal
            # and pressing Finalise again silently left it on the list.
            # Meals already assigned to a day are kept regardless — pulling one
            # out from under the plan would blank that day without warning.
            assigned = {r["meal_id"] for r in rows(conn.execute(
                "SELECT meal_id FROM week_day WHERE week_id=? AND meal_id IS NOT NULL", (wid,)))}
            for r in rows(conn.execute("SELECT meal_id FROM week_meal WHERE week_id=?", (wid,))):
                if r["meal_id"] not in meal_ids and r["meal_id"] not in assigned:
                    conn.execute("DELETE FROM week_meal WHERE week_id=? AND meal_id=?",
                                 (wid, r["meal_id"]))
            healthy_tags = {t.strip() for t in
                (conn.execute("SELECT value FROM config WHERE key='healthy_tags'").fetchone()["value"] or "")
                .split(",") if t.strip()}
            for mid in meal_ids:
                conn.execute("INSERT OR IGNORE INTO week_meal(week_id,meal_id) VALUES (?,?)", (wid, mid))
                meal = conn.execute("SELECT name, tags FROM meal WHERE id=?", (mid,)).fetchone()
                if meal and healthy_tags & set((meal["tags"] or "").split(",")):
                    # Point per child who voted for a chosen healthy meal.
                    # points_ledger's uniqueness is keyed on (dow, slot), so
                    # the meal id and a fixed marker stand in for those here —
                    # there's no day/slot dimension left to key on instead.
                    for w in rows(conn.execute("""
                            SELECT v.person_id FROM meal_vote v JOIN person p ON p.id=v.person_id
                            WHERE v.week_id=? AND v.meal_id=? AND p.role!='parent'""", (wid, mid))):
                        conn.execute("""INSERT OR IGNORE INTO points_ledger
                            (person_id,week_id,dow,slot,delta,reason) VALUES (?,?,?,?,1,?)""",
                            (w["person_id"], wid, mid, "poll", f"voted for {meal['name']}"))
            if b.get("meals_target"):
                conn.execute("UPDATE week SET meals_target=? WHERE id=?", (int(b["meals_target"]), wid))
            conn.execute("UPDATE week SET confirmed=1 WHERE id=?", (wid,))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/swap-days":
            # Plans move around after the shop: you don't fancy Wednesday's
            # meal, or the chicken turns out to expire before the day it was
            # planned for. Swapping is the honest operation — the other day's
            # meal has to go somewhere, and dropping it silently would lose it.
            # Lunch deliberately stays put: it tracks the day (school,
            # holiday, who's in), not whatever dinner happens to be on.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can move meals around."}, 403)
            wid, a, z = b["week_id"], int(b["dow_a"]), int(b["dow_b"])
            if a == z:
                return self.send_json({"error": "That's the same day."}, 400)
            get = lambda d: (conn.execute(
                "SELECT meal_id FROM week_day WHERE week_id=? AND dow=?", (wid, d)).fetchone() or {"meal_id": None})["meal_id"]
            ma, mz = get(a), get(z)
            for d in (a, z):
                conn.execute("INSERT OR IGNORE INTO week_day(week_id,dow) VALUES (?,?)", (wid, d))
            conn.execute("UPDATE week_day SET meal_id=? WHERE week_id=? AND dow=?", (mz, wid, a))
            conn.execute("UPDATE week_day SET meal_id=? WHERE week_id=? AND dow=?", (ma, wid, z))
            conn.commit()
            return self.send_json(build_week(conn, wid, b.get("actor_id")))

        if path == "/api/week/drop-meal":
            # Plans change — a chosen meal turns out not needed this week
            # (eating out, whatever). Takes it off the shortlist without
            # touching anyone's votes, so it's just tickable again later if
            # it comes back into play.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            conn.execute("DELETE FROM week_meal WHERE week_id=? AND meal_id=?", (b["week_id"], b["meal_id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/vote-target":
            # Manual override for which week Vote points at — the escape
            # hatch for "we're voting late and the calendar's already moved
            # on". Pass week_id: null to clear it and go back to automatic.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            if b.get("week_id"):
                conn.execute("""INSERT INTO config(key,value) VALUES ('vote_week_override',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             (str(int(b["week_id"])),))
            else:
                conn.execute("DELETE FROM config WHERE key='vote_week_override'")
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/advance":
            # Pins "this week" forward to whichever week the parent's just
            # shopped for — decoupled from today's actual date, since the
            # weekly shop happens Friday evening/Saturday morning, not
            # necessarily right on the calendar boundary.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            conn.execute("""INSERT INTO config(key,value) VALUES ('active_week_id',?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (str(b["week_id"]),))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/unconfirm":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            conn.execute("UPDATE week SET confirmed=0 WHERE id=?", (b["week_id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/meal/delete":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can edit the meal library."}, 403)
            # Soft delete: weeks that used it keep their history, and it can come back.
            conn.execute("UPDATE meal SET deleted_at=datetime('now') WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/meal/restore":
            # Kept deliberately even though nothing calls it yet: with no
            # backups running, an un-delete is worth having reachable.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can edit the meal library."}, 403)
            conn.execute("UPDATE meal SET deleted_at=NULL WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/extra":
            if b.get("id"):
                conn.execute("""UPDATE extra SET item=?,aisle=?,person_id=?,recurring=?,amount=?,unit=?
                                WHERE id=?""",
                             (b["item"], b.get("aisle", "Household"), b.get("person_id"),
                              int(b.get("recurring", 0)), float(b.get("amount") or 1),
                              b.get("unit", "unit"), b["id"]))
                eid = b["id"]
            else:
                # Same item typed again just bumps frequency rather than
                # duplicating the row — that's what the maintained list sorts by.
                existing = conn.execute("SELECT id FROM extra WHERE item=? COLLATE NOCASE",
                                        (b["item"],)).fetchone()
                if existing:
                    eid = existing["id"]
                    conn.execute("UPDATE extra SET use_count = use_count + 1 WHERE id=?", (eid,))
                else:
                    cur = conn.execute(
                        """INSERT INTO extra(item,aisle,person_id,recurring,amount,unit,use_count)
                           VALUES (?,?,?,?,?,?,1)""",
                        (b["item"], b.get("aisle", "Household"), b.get("person_id"),
                         int(b.get("recurring", 0)), float(b.get("amount") or 1),
                         b.get("unit", "unit")))
                    eid = cur.lastrowid
            # Say whether this actually put something on the week's list. The
            # INSERT OR IGNORE quietly does nothing when the item is already
            # there, which looked identical to a working add from the client's
            # side — press it five times, get five silent no-ops.
            added_to_week = False
            if b.get("week_id") and not int(b.get("recurring", 0)):
                cur = conn.execute("INSERT OR IGNORE INTO week_extra(week_id,extra_id) VALUES (?,?)",
                                   (b["week_id"], eid))
                added_to_week = cur.rowcount > 0
            conn.commit()
            return self.send_json({"id": eid, "addedToWeek": added_to_week,
                                   "alreadyOnList": bool(b.get("week_id")) and not added_to_week
                                                    and not int(b.get("recurring", 0))})

        if path == "/api/extra-request":
            # Anyone can ask — kids included. It never touches the real
            # shopping list on its own; a parent has to approve it first.
            item = (b.get("item") or "").strip()
            if not item:
                return self.send_json({"error": "Needs a name."}, 400)
            conn.execute("""INSERT INTO extra_request(person_id,item,amount,unit,aisle,week_id)
                            VALUES (?,?,?,?,?,?)""",
                         (b["person_id"], item, float(b.get("amount") or 1),
                          b.get("unit") or "unit", b.get("aisle") or "Household", b["week_id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/extra-request/resolve":
            if not is_parent(conn, b.get("resolver_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            req = conn.execute("SELECT * FROM extra_request WHERE id=?", (b["id"],)).fetchone()
            if not req or req["status"] != "pending":
                return self.send_json({"error": "Already resolved."}, 400)
            if b["decision"] == "approve":
                # Same "match by name, else create, then attach to this week"
                # logic /api/extra itself uses — approving a request should
                # behave exactly like a parent had typed it in themselves.
                existing = conn.execute("SELECT id FROM extra WHERE item=? COLLATE NOCASE",
                                        (req["item"],)).fetchone()
                if existing:
                    eid = existing["id"]
                    conn.execute("UPDATE extra SET use_count = use_count + 1 WHERE id=?", (eid,))
                else:
                    cur = conn.execute(
                        """INSERT INTO extra(item,aisle,amount,unit,use_count) VALUES (?,?,?,?,1)""",
                        (req["item"], req["aisle"], req["amount"], req["unit"]))
                    eid = cur.lastrowid
                conn.execute("INSERT OR IGNORE INTO week_extra(week_id,extra_id) VALUES (?,?)",
                             (req["week_id"], eid))
                conn.execute("""UPDATE extra_request SET status='approved',
                                resolved_at=datetime('now'), resolved_by=? WHERE id=?""",
                             (b["resolver_id"], b["id"]))
            else:
                conn.execute("""UPDATE extra_request SET status='denied',
                                resolved_at=datetime('now'), resolved_by=? WHERE id=?""",
                             (b["resolver_id"], b["id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/meal/rate":
            stars = int(b.get("stars") or 0)
            if not 1 <= stars <= 5:
                return self.send_json({"error": "Rating must be 1-5."}, 400)
            conn.execute("""INSERT INTO meal_rating(meal_id,person_id,stars) VALUES (?,?,?)
                            ON CONFLICT(meal_id,person_id) DO UPDATE SET stars=excluded.stars""",
                         (b["meal_id"], b["person_id"], stars))
            conn.commit()
            avg = conn.execute("SELECT ROUND(AVG(stars),1) a, COUNT(*) c FROM meal_rating WHERE meal_id=?",
                               (b["meal_id"],)).fetchone()
            return self.send_json({"ok": True, "rating_avg": avg["a"], "rating_count": avg["c"]})

        if path == "/api/store":
            # Naming/adding shops is a household-config change, same bar as
            # renaming the week-start day — admin only.
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            name = (b.get("name") or "").strip()
            if not name:
                return self.send_json({"error": "Needs a name."}, 400)
            if b.get("id"):
                conn.execute("UPDATE store SET name=? WHERE id=?", (name, b["id"]))
                sid = b["id"]
            else:
                cur = conn.execute("INSERT INTO store(name) VALUES (?)", (name,))
                sid = cur.lastrowid
            conn.commit()
            return self.send_json({"id": sid})

        if path == "/api/store/delete":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            if conn.execute("SELECT COUNT(*) c FROM store").fetchone()["c"] <= 1:
                return self.send_json({"error": "Can't delete the last store."}, 400)
            conn.execute("DELETE FROM store WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/store/aisles/reorder":
            # Reordering your own walk through a shop is a normal weekly
            # task, not a config change — any parent, not just the admin.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            sid = b["store_id"]
            for i, name in enumerate(b["order"]):
                conn.execute("""INSERT INTO store_aisle_order(store_id,name,pos) VALUES (?,?,?)
                                ON CONFLICT(store_id,name) DO UPDATE SET pos=excluded.pos""", (sid, name, i))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/extra/set-qty":
            # The +/- stepper: how many of this item this particular week —
            # "2 juice" instead of the household default of 1 — without
            # touching what future weeks default to. 0 or below removes it
            # the same way remove-week does.
            wid, eid, qty = b["week_id"], b["id"], int(b["qty"])
            if qty <= 0:
                conn.execute("DELETE FROM week_extra WHERE week_id=? AND extra_id=?", (wid, eid))
                conn.execute("UPDATE extra SET recurring=0 WHERE id=?", (eid,))
            else:
                conn.execute("""INSERT INTO week_extra(week_id,extra_id,qty) VALUES (?,?,?)
                                ON CONFLICT(week_id,extra_id) DO UPDATE SET qty=excluded.qty""",
                             (wid, eid, qty))
                conn.execute("UPDATE extra SET use_count = use_count + 1 WHERE id=?", (eid,))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/extra/delete":
            # Permanently deletes it from the maintained library — the
            # frequency list forgets it existed. Rarely what you want; the
            # stepper's "0" on the weekly list just takes it off this week.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            conn.execute("DELETE FROM extra WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person":
            # Cosmetic, per-person preferences. Safe for anyone to set on
            # themselves, and for an admin to set on someone else (a kid
            # without Settings access still gets a colour picked for them).
            OWN_FIELDS = ("theme", "color")
            # Everything that changes what someone is allowed to DO. The UI
            # already hides these behind the admin check; without the same
            # check here, a POST straight to the API could set role='parent'
            # on yourself and walk past every is_parent() gate in the app —
            # which is exactly the sibling meddling the PINs exist to deter.
            ADMIN_FIELDS = ("name", "role", "is_admin", "allowed_tabs")

            admin = is_admin(conn, b.get("admin_id"))
            if b.get("id"):
                target = conn.execute("SELECT id FROM person WHERE id=?", (b["id"],)).fetchone()
                if not target:
                    return self.send_json({"error": "No such person."}, 404)
                if any(f in b for f in ADMIN_FIELDS) and not admin:
                    # A plain self-edit sends name along for convenience; only
                    # complain if it would actually change something.
                    changing = [f for f in ADMIN_FIELDS if f in b and str(b[f] or "") != str(
                        (conn.execute(f"SELECT {f} FROM person WHERE id=?", (b["id"],)).fetchone()[f]) or "")]
                    if changing:
                        return self.send_json(
                            {"error": "Only the household admin can change that."}, 403)
                if b.get("id") != b.get("actor_id") and not admin and any(f in b for f in OWN_FIELDS):
                    return self.send_json({"error": "That's someone else's setting."}, 403)

                if admin and "is_admin" in b:
                    # Don't let the last admin demote themselves — there'd be
                    # nobody left who can put it back.
                    if not int(b["is_admin"]) and conn.execute(
                            "SELECT COUNT(*) c FROM person WHERE is_admin=1").fetchone()["c"] <= 1:
                        return self.send_json(
                            {"error": "That's the only admin — promote someone else first."}, 400)
                    conn.execute("UPDATE person SET is_admin=? WHERE id=?",
                                 (int(b["is_admin"]), b["id"]))
                if admin and "allowed_tabs" in b:
                    conn.execute("UPDATE person SET allowed_tabs=? WHERE id=?",
                                 (b["allowed_tabs"] or None, b["id"]))

                editable = OWN_FIELDS + (ADMIN_FIELDS if admin else ())
                sets = ", ".join(f"{f}=?" for f in editable if f in b and f != "is_admin"
                                 and f != "allowed_tabs")
                vals = [b[f] for f in editable if f in b and f != "is_admin" and f != "allowed_tabs"]
                if sets:
                    conn.execute(f"UPDATE person SET {sets} WHERE id=?", (*vals, b["id"]))
                pid = b["id"]
            else:
                # A brand-new install has no admin to authorise the very first
                # real person — the household's own setup wizard is the one
                # legitimate case where this is allowed through anyway, and
                # that first person becomes admin+parent on the spot so
                # there's someone who can add everyone else normally from
                # then on. Guarded on the actual DB state, not a client flag,
                # so it can't be replayed once a real person already exists.
                first_ever = conn.execute(
                    "SELECT COUNT(*) c FROM person WHERE is_placeholder=0").fetchone()["c"] == 0
                if not admin and not first_ever:
                    return self.send_json({"error": "Only the household admin can add people."}, 403)
                role = "parent" if first_ever else b.get("role", "child")
                cur = conn.execute("INSERT INTO person(name,role,is_admin) VALUES (?,?,?)",
                                   (b["name"], role, 1 if first_ever else 0))
                pid = cur.lastrowid
            conn.commit()
            p = conn.execute("SELECT * FROM person WHERE id=?", (pid,)).fetchone()
            pd = dict(p)
            pd["has_pin"] = bool(pd.pop("pin_hash", None))
            pd.pop("link_token", None)
            return self.send_json({"person": pd, "energy": tdee(p)})

        if path == "/api/config":
            # Household-wide variables — admin only. Client-asserted admin_id
            # isn't bulletproof without real login sessions, but combined with
            # PINs it stops casual "oops I changed a setting" and sibling meddling.
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            # Each key is written only when sent, so a caller changing one setting
            # can't clobber another with a stale copy of its value.
            if "week_start_dow" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('week_start_dow',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             (str(int(b["week_start_dow"])),))
            if "meals_target_default" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('meals_target_default',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             (str(int(b["meals_target_default"])),))
            if "allow_historic_edits" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('allow_historic_edits',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             ("1" if int(b["allow_historic_edits"]) else "0",))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/redemption/request":
            bal = conn.execute("SELECT SUM(delta) b FROM points_ledger WHERE person_id=?",
                               (b["person_id"],)).fetchone()["b"] or 0
            reward = conn.execute("SELECT * FROM reward WHERE id=?", (b["reward_id"],)).fetchone()
            if not reward:
                return self.send_json({"error": "Not a real reward."}, 400)
            if bal < reward["points_cost"]:
                return self.send_json({"error": f"Needs {reward['points_cost']} points, only has {bal}."}, 400)
            conn.execute("""INSERT INTO redemption(person_id,reward_id,note) VALUES (?,?,?)""",
                         (b["person_id"], b["reward_id"], b.get("note", "")))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/redemption/resolve":
            # Any parent can approve or deny (not just the admin) — sets the
            # real budget even if the reward has a suggested figure, since
            # "Miller & Carter" vs "McDonald's" is the parent's call, not the child's.
            person = conn.execute("SELECT role FROM person WHERE id=?", (b.get("resolver_id"),)).fetchone()
            if not person or person["role"] != "parent":
                return self.send_json({"error": "Only a parent can approve or deny."}, 403)
            rd = conn.execute("SELECT * FROM redemption WHERE id=?", (b["id"],)).fetchone()
            if not rd or rd["status"] != "pending":
                return self.send_json({"error": "Already resolved."}, 400)
            if b["decision"] == "approve":
                reward = conn.execute("SELECT * FROM reward WHERE id=?", (rd["reward_id"],)).fetchone()
                conn.execute("""INSERT INTO points_ledger(person_id,delta,reason) VALUES (?,?,?)""",
                             (rd["person_id"], -reward["points_cost"], f"redeemed: {reward['name']}"))
                conn.execute("""UPDATE redemption SET status='approved', budget_gbp=?,
                                resolved_at=datetime('now'), resolved_by=? WHERE id=?""",
                             (b.get("budget_gbp"), b["resolver_id"], b["id"]))
            else:
                conn.execute("""UPDATE redemption SET status='denied',
                                resolved_at=datetime('now'), resolved_by=? WHERE id=?""",
                             (b["resolver_id"], b["id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/reward/save":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            if b.get("id"):
                conn.execute("""UPDATE reward SET name=?, points_cost=?, suggested_budget_gbp=?, active=?
                                WHERE id=?""",
                             (b["name"], int(b["points_cost"]), b.get("suggested_budget_gbp"),
                              int(b.get("active", 1)), b["id"]))
            else:
                conn.execute("""INSERT INTO reward(name,points_cost,suggested_budget_gbp)
                                VALUES (?,?,?)""",
                             (b["name"], int(b["points_cost"]), b.get("suggested_budget_gbp")))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/config/healthy-tags":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            conn.execute("""INSERT INTO config(key,value) VALUES ('healthy_tags',?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                         (",".join(b.get("tags", [])),))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person/set-pin":
            # Anyone can set their own PIN; an admin can reset anyone's
            # (for a kid who forgets theirs) by supplying admin_id instead.
            target = b["id"]
            if target != b.get("by") and not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Can't set someone else's PIN."}, 403)
            pin = re.sub(r"\D", "", str(b.get("pin", "")))
            if len(pin) != 4:
                return self.send_json({"error": "PIN must be 4 digits."}, 400)
            conn.execute("UPDATE person SET pin_hash=?, pin_default=0 WHERE id=?", (hash_pin(pin), target))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person/clear-pin":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            conn.execute("UPDATE person SET pin_hash=NULL WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person/link/regenerate":
            # Same bar as fetching one — a parent shared it once, might need
            # to kill it and reissue (link went to the wrong chat, whatever).
            if not is_parent(conn, b.get("admin_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            token = os.urandom(16).hex()
            conn.execute("UPDATE person SET link_token=? WHERE id=?", (token, b["id"]))
            conn.commit()
            return self.send_json({"token": token})

        if path == "/api/person/verify-pin":
            row = conn.execute("SELECT pin_hash, pin_default FROM person WHERE id=?", (b["id"],)).fetchone()
            ok = not row["pin_hash"] or check_pin(str(b.get("pin", "")), row["pin_hash"])
            return self.send_json({"ok": ok, "pin_default": bool(row["pin_default"]) if ok else False})

        if path == "/api/person/delete":
            # This is the single most destructive call in the app: person rows
            # cascade into votes, vetoes, attendance, redemptions and the whole
            # points_ledger, and none of it is soft-deleted or recoverable.
            # It had no check of any kind — the UI hid the button behind the
            # admin test, but a bare POST deleted anyone.
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            target = conn.execute("SELECT is_admin FROM person WHERE id=?", (b["id"],)).fetchone()
            if not target:
                return self.send_json({"error": "No such person."}, 404)
            if target["is_admin"] and conn.execute(
                    "SELECT COUNT(*) c FROM person WHERE is_admin=1").fetchone()["c"] <= 1:
                return self.send_json(
                    {"error": "That's the only admin — promote someone else first."}, 400)
            points = conn.execute("SELECT COALESCE(SUM(delta),0) b FROM points_ledger WHERE person_id=?",
                                  (b["id"],)).fetchone()["b"]
            if points and not b.get("confirm_points"):
                return self.send_json(
                    {"error": f"They still have {points} reward points banked. "
                              "Deleting them wipes those permanently — confirm to go ahead.",
                     "needs_confirm": True, "points": points}, 409)
            conn.execute("DELETE FROM person WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        return self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    init_db()
    print(f"meal planner on http://0.0.0.0:{PORT}  (db: {DB_PATH})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
