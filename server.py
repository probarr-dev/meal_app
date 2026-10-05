#!/usr/bin/env python3
"""Family meal planner. Python stdlib + SQLite only — no dependencies to rot."""

import base64
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request

import auth
import push
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


def migrate_adults_only(conn):
    if not conn.execute("SELECT 1 FROM config WHERE key='adults_only_seeded'").fetchone():
        conn.execute("UPDATE extra SET adults_only=1 WHERE aisle='Household'")
        conn.execute("INSERT OR IGNORE INTO config(key,value) VALUES ('adults_only_seeded','1')")


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
        # A "standing" meal — a parent's WFH lunch, a packed lunch for
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
        ("person", "emoji", "TEXT"),
        # Set (UTC "YYYY-MM-DD HH:MM:SS") while someone's on a short break from asking for extras.
        ("person", "extras_timeout_until", "TEXT"),
        ("extra", "adults_only", "INTEGER DEFAULT 0"),
        ("meal", "no_ingredients", "INTEGER DEFAULT 0"),
        ("price_product", "store", "TEXT DEFAULT 'aldi'"),
        # Set = this product prices one "counts as" receipt product (e.g. a cheaper loaf
        # bought as "Sliced Bread"), shown under that item's expandable row.
        ("price_product", "variant_code", "TEXT"),
        # NULL = every tab (the historical default, and every non-admin
        # today). Set = only these tabs show for that person.
        ("person", "allowed_tabs", "TEXT"),
        # "Pick one" extras (a shared breakfast: crêpes / pancakes / croissants):
        # comma-separated options; one line on the list, any option counts on a receipt.
        ("extra", "options", "TEXT"),
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
        # 'pantry' (default) = the cupboard-check phase, full list visible,
        # nothing hidden. 'shopping' = the trolley phase, entered by an
        # explicit tap once someone's actually heading out.
        ("week", "shopping_phase", "TEXT DEFAULT 'pantry'"),
        ("week", "shop_closed", "INTEGER DEFAULT 0"),
        ("week", "shop_total", "REAL"),
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
        PRIMARY KEY (week_id, person_id, meal_id))""")
    # Older databases allowed exactly one veto per person per week (key on
    # week+person). Rebuild once so the allowance can be a setting.
    pk = {r["name"]: r["pk"] for r in rows(conn.execute("PRAGMA table_info(veto)"))}
    if not pk.get("meal_id"):
        conn.execute("""CREATE TABLE veto_new (
            week_id   INTEGER NOT NULL REFERENCES week(id) ON DELETE CASCADE,
            person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
            dow       INTEGER NOT NULL,
            meal_id   INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
            PRIMARY KEY (week_id, person_id, meal_id))""")
        conn.execute("INSERT INTO veto_new SELECT week_id, person_id, dow, meal_id FROM veto")
        conn.execute("DROP TABLE veto")
        conn.execute("ALTER TABLE veto_new RENAME TO veto")

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


def seed_ideas(conn):
    """Draft meal ideas (ideas.json) that sit apart from the library until someone adds them.
    Each idea has a batch number; a batch is offered once, so dismissed ideas stay dismissed
    and new batches (added to the file later) appear on their own."""
    conn.execute("""CREATE TABLE IF NOT EXISTS meal_idea (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, tags TEXT DEFAULT '', meal_type TEXT DEFAULT 'proper',
        note TEXT DEFAULT '', ingredients TEXT NOT NULL DEFAULT '[]')""")
    row = conn.execute("SELECT value FROM config WHERE key='ideas_batch'").fetchone()
    done = int(row["value"]) if row else (1 if conn.execute(
        "SELECT 1 FROM config WHERE key='ideas_seeded'").fetchone() else 0)
    try:
        with open(os.path.join(HERE, "ideas.json"), encoding="utf-8") as f:
            ideas = json.load(f)["meals"]
    except (OSError, ValueError, KeyError):
        return
    top = max([m.get("batch", 1) for m in ideas] or [1])
    if top <= done:
        return
    have = {r["name"].lower() for r in conn.execute("SELECT name FROM meal")} | {
        r["name"].lower() for r in conn.execute("SELECT name FROM meal_idea")}
    for m in ideas:
        if m.get("batch", 1) > done and m["name"].lower() not in have:
            conn.execute("INSERT INTO meal_idea(name,tags,meal_type,note,ingredients) VALUES (?,?,?,?,?)",
                         (m["name"], m.get("tags", ""), m.get("meal_type", "proper"), m.get("note", ""),
                          json.dumps(m.get("ingredients", []))))
    conn.execute("""INSERT INTO config(key,value) VALUES ('ideas_batch',?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (str(top),))


def init_db():
    with db() as conn:
        conn.executescript(open(os.path.join(HERE, "schema.sql")).read())
        migrate(conn)
        seed_ideas(conn)
        migrate_adults_only(conn)
        push.migrate(conn)
        auth.migrate(conn)
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
    """Weeks that /api/bootstrap recreates the instant they're deleted (it would
    rebuild them before the page redrew, so deleting looked like it did nothing)."""
    return set(cycle(conn).values())


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


DATA_VERSION = 0
BUILD_ID = str(int(__import__("time").time()))


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


# ---------------------------------------------------------------- pricing
# Aldi's own website reads its product data from this public JSON API. It's
# unofficial: if it changes, links keep their last known price and only the
# search/refresh stops working.
ALDI_API = "https://api.aldi.co.uk"


ALDI_CACHE = {}  # in-memory front of the permanent search_cache table


def cache_get(key):
    if key in ALDI_CACHE:
        return ALDI_CACHE[key]
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS search_cache (k TEXT PRIMARY KEY, v TEXT, fetched_at TEXT)")
        r = c.execute("SELECT v FROM search_cache WHERE k=?", (key,)).fetchone()
    if r:
        ALDI_CACHE[key] = json.loads(r["v"])
        return ALDI_CACHE[key]
    return None


def cache_put(key, val):
    ALDI_CACHE[key] = val
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS search_cache (k TEXT PRIMARY KEY, v TEXT, fetched_at TEXT)")
        c.execute("INSERT OR REPLACE INTO search_cache VALUES (?,?,datetime('now'))", (key, json.dumps(val)))
        c.commit()


def cache_clear():
    ALDI_CACHE.clear()
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS search_cache (k TEXT PRIMARY KEY, v TEXT, fetched_at TEXT)")
        c.execute("DELETE FROM search_cache")
        c.commit()


def aldi_get(path):
    req = urllib.request.Request(ALDI_API + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.load(r)


def aldi_trim(p):
    cats = [c.get("name") for c in (p.get("categories") or []) if c.get("name")]
    return {"sku": p.get("sku"), "name": p.get("name") or "", "brand": p.get("brandName") or "",
            "size": p.get("sellingSize") or "", "price": ((p.get("price") or {}).get("amount") or 0) / 100,
            "category": " › ".join(cats[:2])}


def aldi_by_code(code):
    """Aldi products for a receipt product code (its sku is the code, zero-padded, plus a
    3-digit variant). [] = Aldi has no such product; None = couldn't reach Aldi (try later)."""
    found = []
    for suffix in ("001", "002", "003", "004", "005", "006"):
        sku = code.zfill(15) + suffix
        hit = cache_get("a:sku:" + sku)
        if hit is None:
            try:
                hit = [aldi_trim(aldi_get(f"/v2/products/{sku}?currency=GBP&serviceType=walk-in")["data"])]
            except urllib.error.HTTPError as e:
                if e.code != 404:  # only a real "no such product" is worth remembering
                    return None
                hit = []
            except Exception:
                return None
            cache_put("a:sku:" + sku, hit)
        found += hit
        if not hit and found:
            break  # variants run 001, 002...; the first gap ends them
    if not found:  # older products carry the code as the whole 18-digit sku
        try:
            found = [aldi_trim(aldi_get(f"/v2/products/{code.zfill(18)}?currency=GBP&serviceType=walk-in")["data"])]
        except Exception:
            found = []
    return found


def auto_link_receipt_products(db):
    """Receipt products that count as a list item: if Aldi knows the exact code, link it
    to that item's "counted as" row without anyone searching. Runs after each receipt is saved."""
    with db() as conn:
        receipt_tables(conn)
        have = {(r["item_key"], r["variant_code"]) for r in conn.execute(
            "SELECT item_key, variant_code FROM price_product WHERE variant_code IS NOT NULL")}
        skus = {}
        for r in conn.execute("SELECT item_key, sku FROM price_product WHERE COALESCE(store,'aldi')='aldi' AND variant_code IS NULL"):
            skus.setdefault(r["item_key"], set()).update({r["sku"].lstrip("0"), r["sku"].lstrip("0")[:6]})
        todo = [(r["item_key"], r["code"]) for r in conn.execute(
            """SELECT DISTINCT item_key, code FROM receipt_line
               WHERE item_key IS NOT NULL AND code IS NOT NULL AND code!='' AND kind!='treat'""")
            if (r["item_key"], r["code"]) not in have and r["code"].lstrip("0") not in skus.get(r["item_key"], ())]
        # Look everything up first: the lookup caches in its own connection, which would
        # block on this one once it has a write open.
        looked = [(key, code, aldi_by_code(code) or []) for key, code in todo]
        for key, code, products in looked:
            for p in products:
                if not conn.execute("SELECT 1 FROM price_product WHERE item_key=? AND sku=?", (key, p["sku"])).fetchone():
                    conn.execute("""INSERT INTO price_product(item_key,sku,name,brand,size,price,category,store,variant_code,checked_at)
                                    VALUES (?,?,?,?,?,?,?,'aldi',?,datetime('now'))""",
                                 (key, p["sku"], p["name"], p["brand"], p["size"], p["price"], p["category"], code))
        conn.commit()


def vetoes_allowed(conn):
    r = conn.execute("SELECT value FROM config WHERE key='vetoes_per_person'").fetchone()
    return int(r["value"]) if r else 1


def morrisons_enabled(conn):
    return (conn.execute("SELECT value FROM config WHERE key='morrisons_enabled'").fetchone()
            or {"value": "0"})["value"] == "1"


MORRISONS_LAST = 0.0


PACK_WORDS = {"twin": 2, "twinpack": 2, "double": 2, "triple": 3, "treble": 3}


def multipack_size(p):
    """'Twinpack Mushy Peas' sized 300g is 2 x 300g. Applied on read, so cached
    results are corrected too."""
    size = p.get("size") or ""
    if re.search(r"\d\s*x\s*\d", size, re.I):
        return p
    m = re.search(r"\b(twin|double|triple|treble)[\s-]?pack|\b(twinpack)\b", p.get("name", ""), re.I)
    if m and re.match(r"\d", size):
        return {**p, "size": f"{PACK_WORDS[(m.group(1) or m.group(2)).lower()]} x {size}"}
    return p


def morrisons_search(term):
    """Morrisons renders search results into the page itself; read the
    embedded product data. Only ever called when Morrisons is switched on."""
    return [multipack_size(p) for p in _morrisons_search(term)]


def _morrisons_search(term):
    hit = cache_get("m:" + term.lower())
    if hit is not None:
        return hit
    # Be polite: at most one live Morrisons page every 3 seconds.
    global MORRISONS_LAST
    wait = MORRISONS_LAST + 3 - __import__("time").time()
    if wait > 0:
        __import__("time").sleep(wait)
    MORRISONS_LAST = __import__("time").time()
    req = urllib.request.Request("https://groceries.morrisons.com/search?" + urllib.parse.urlencode({"q": term}),
                                 headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":  # ~8x smaller download (150KB vs 1.2MB)
            raw = __import__("gzip").decompress(raw)
        html = raw.decode("utf-8", "replace")
    m = re.search(r"window\.__INITIAL_STATE__=(\{.*?\})(?:;|\s*</script>)", html, re.S)
    if not m:
        # Not a results page (a bot check or error page served as 200). Treat it
        # like a block and don't cache it, or the empty answer sticks forever.
        raise urllib.error.HTTPError(req.full_url, 429, "No results page", None, None)
    ents = json.loads(m.group(1))["data"]["products"]["productEntities"]
    out = []
    for p in ents.values():
        try:
            # Sold weight = the size in the product name (what Aldi quotes); Morrisons' size
            # field is sometimes drained weight (beetroot "(340g)" vs 215g).
            nm = re.search(r"(\d+\s*x\s*)?\d+(?:\.\d+)?\s*(?:kg|g|ml|l|cl|pints?)\b\)?\s*$", p.get("name", ""), re.I)
            out.append({"sku": str(p["retailerProductId"]), "name": p.get("name", ""), "brand": p.get("brand") or "",
                        "size": nm.group(0).strip(" ()") if nm else (p.get("size") or {}).get("value", ""),
                        "price": float(((p.get("price") or {}).get("current") or {}).get("amount") or 0),
                        "category": " › ".join((p.get("categoryPath") or [])[:2]), "store": "morrisons"})
        except (KeyError, ValueError, TypeError):
            continue
    cache_put("m:" + term.lower(), out)
    return out


# ---- store comparison (rough, desktop-only) ----
STOP = {"morrisons", "aldi", "british", "the", "and", "with", "of", "in", "a", "fresh", "everyday", "essentials",
        "specially", "selected", "for", "farmers", "pack", "x", "each", "best", "savers", "market", "street",
        "kg", "g", "ml", "l", "cl", "pint", "pints", "pk", "multipack"}


def size_base(size):
    """'0.5 KG' / '500g' / '2 Pint' / '6 Each' -> (amount in g|ml|each, kind)."""
    txt = (size or "").lower()
    mult = 1
    mp = re.search(r"(\d+)\s*x\s*([\d.]+)", txt)
    if mp:
        mult, txt = int(mp.group(1)), txt[mp.start(2):]
    m = re.search(r"([\d.]+)\s*(kg|g|l|ml|cl|pint|pints|each|pk)?", txt)
    if not m:
        return None, None
    n, u = float(m.group(1)) * mult, (m.group(2) or "each")
    if u == "kg": return n * 1000, "g"
    if u == "g": return n, "g"
    if u == "l": return n * 1000, "ml"
    if u == "cl": return n * 10, "ml"
    if u == "ml": return n, "ml"
    if u in ("pint", "pints"): return n * 568, "ml"
    return n, "each"


def stem(w):
    """batter/battered, slice/sliced/slices, dipper/dippers -> one word."""
    for suf in ("ing", "ed", "es", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            w = w[:-len(suf)]
            break
    return w[:-1] if w.endswith("e") and len(w) > 3 else w


def name_tokens(name):
    words = re.sub(r"[^a-z ]", " ", (name or "").lower()).split()
    return {stem(w) for w in words if w not in STOP and len(w) > 1}


def match_score(a, b):
    ta, tb = name_tokens(a["name"]), name_tokens(b["name"])
    tok = len(ta & tb) / max(1, len(ta | tb))
    (na, ka), (nb, kb) = size_base(a["size"]), size_base(b["size"])
    size = 0.0
    if na and nb and ka == kb:
        size = min(na, nb) / max(na, nb)
    ca, cb = name_tokens(a.get("category", "")), name_tokens(b.get("category", ""))
    cat = len(ca & cb) / max(1, min(len(ca), len(cb))) if ca and cb else 0.5
    score = 0.6 * tok + 0.25 * size + 0.15 * cat
    # Own-label vs own-label: Aldi's basics compare with Morrisons' own range,
    # premium ("Specially Selected") with "The Best"; other brands lose a little.
    bn, name_b = (b.get("brand") or "").lower(), (b.get("name") or "").lower()
    premium_a = "specially selected" in (a.get("brand") or "").lower()
    premium_b = "the best" in name_b
    if tok >= 0.5:  # only a tie-breaker between genuinely similar products
        if bn == "morrisons" or name_b.startswith("morrisons"):
            score += 0.08 if premium_a == premium_b else -0.04
        else:
            score -= 0.05
    # The last real word is usually the product itself ("…sliced BEETROOT"); it must be there.
    head = [w for w in re.sub(r"[^a-z ]", " ", (a.get("name") or "").lower()).split() if w not in STOP and len(w) > 2]
    if head and not any(h in tb or h.rstrip("s") in tb for h in {head[-1], head[-1].rstrip("s")}):
        score -= 0.2
    return round(max(0, min(1, score)), 3)


def match_queries(name):
    """Several searches per item, most specific first; results get pooled."""
    words = [w for w in re.sub(r"[^a-z ]", " ", name.lower()).split() if w not in STOP and len(w) > 1]
    qs = [" ".join(words), " ".join(words[-2:]), " ".join(words[:2])]
    return [q for i, q in enumerate(qs) if q and q not in qs[:i]]


def unit_price(p):
    n, k = size_base(p.get("size"))
    if not n or not p.get("price"):
        return None, None
    return (round(p["price"] / n * 1000, 2), "kg" if k == "g" else "L") if k in ("g", "ml") else (round(p["price"] / n, 2), "each")


def item_key(name):
    # str.title(), except it wrongly capitalises after an apostrophe ("Aubree'S").
    return re.sub(r"'S\b", "'s", " ".join((name or "").strip().split()).title())


def packs_needed(amount, unit, size):
    """Whole packs to buy: what the till actually charges, not a per-meal share."""
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", size or "")
    amount = float(amount or 0)
    if not m or amount <= 0:
        return max(1, math.ceil(amount or 1))
    n, u = float(m.group(1)), m.group(2).upper()
    grams = {"KG": 1000, "G": 1}.get(u)
    mls = {"L": 1000, "ML": 1, "CL": 10}.get(u)
    if unit == "g" and grams:
        return max(1, math.ceil(amount / (n * grams) - 1e-9))
    if unit == "ml" and mls:
        return max(1, math.ceil(amount / (n * mls) - 1e-9))
    if unit == "unit" and u == "EACH" and n > 1:
        return max(1, math.ceil(amount / n - 1e-9))
    return max(1, math.ceil(amount - 1e-9))


def price_links(conn):
    out = {}
    for r in rows(conn.execute("SELECT * FROM price_product ORDER BY price")):
        out.setdefault(r["item_key"], []).append(r)
    return out


def pick_one_keys(conn):
    """Keys of extras with options (the shared Breakfast): their spend is food that gets eaten
    as part of the week's meals, so receipts count it under Meals, not Extras."""
    return {item_key(r["item"]) for r in conn.execute("SELECT item FROM extra WHERE COALESCE(options,'')!=''")}


def add_estimate(conn, groups):
    """Attach a price range per shopping item and a whole-shop estimate."""
    links = price_links(conn)
    receipt_tables(conn)
    paid = {}
    for r in conn.execute("""SELECT rl.item_key, rl.amount FROM receipt_line rl JOIN receipt rc ON rc.id=rl.receipt_id
                             WHERE rl.item_key IS NOT NULL ORDER BY rc.id DESC"""):
        if len(paid.setdefault(r["item_key"], [])) < 4:
            paid[r["item_key"]].append(r["amount"])
    weekly = {}  # pick-one extras: total spent per shop, newest 6 shops (all their lines added up)
    po = pick_one_keys(conn)
    if po:
        per = {}
        for r in conn.execute("""SELECT rl.item_key, rc.id rid, SUM(rl.amount) s FROM receipt_line rl
                                 JOIN receipt rc ON rc.id=rl.receipt_id WHERE rl.item_key IN (%s)
                                 GROUP BY rl.item_key, rc.id ORDER BY rc.id DESC""" % ",".join("?" * len(po)), tuple(po)):
            if len(per.setdefault(r["item_key"], [])) < 6:
                per[r["item_key"]].append(r["s"])
        weekly = per
    low = high = 0.0
    unpriced = []
    for g in groups:
        for i in g["items"]:
            prods = [p for p in links.get(i["key"], []) if not p["missing"]]
            if not prods and paid.get(i["key"]):
                prods = []  # no Aldi link, but receipts show what it cost
            elif not prods:
                if not i.get("pantryChecked"):
                    unpriced.append(i["item"])
                continue
            costs = [packs_needed(i["amount"], i["unit"], p["size"]) * p["price"] for p in prods]
            costs += paid.get(i["key"], [])  # what receipts say it actually cost lately
            if i["key"] in weekly:  # pick-one extra: what a week of it has cost, on average
                costs = [sum(weekly[i["key"]]) / len(weekly[i["key"]])]
            i["priceLow"], i["priceHigh"] = round(min(costs), 2), round(max(costs), 2)
            if not i.get("pantryChecked"):
                low += min(costs); high += max(costs)
    return {"low": round(low, 2), "high": round(high, 2), "unpriced": unpriced}


# ---------------------------------------------------------------- receipts
RECEIPT_ITEM = re.compile(r"^\s*(\d{4,8})\s+(.+?)\s+(-?\d+\.\d{2})\s*([AB])?\s*$")
RECEIPT_QTY = re.compile(r"^\s*(\d+)\s*[xX]\s+(\d+\.\d{2})\s*$")
RECEIPT_DISC = re.compile(r"(-\d+\.\d{2})\s*[AB]?\s*$")


RECEIPT_CODE = re.compile(r"^(\d{4,8})(?:\s+(.+))?$")
# A line total with its VAT letter ("1.79 B"); Live Text sometimes reads B as "฿" and
# "." as ",", and can glue two onto one line ("3.10 A1.15 A").
RECEIPT_PRICE = re.compile(r"(\d+[.,]\d{2})\s*[AB฿]")


def parse_receipt_columns(text, total=None):
    """Live Text often reads the receipt as two columns: every product line first,
    then every price at the end. Pair the Nth product with the Nth lettered price.
    Unlettered numbers are unit prices or the grand total, so they're skipped."""
    items, prices, last_plain, unit = [], [], None, None
    rows_ = [r.strip() for r in (text or "").splitlines() if r.strip()]
    i = 0
    while i < len(rows_):
        t = rows_[i]
        m = RECEIPT_CODE.match(t)
        if m and not RECEIPT_PRICE.search(t):
            name = m.group(2)
            if not name and i + 1 < len(rows_) and re.search(r"[A-Za-z]{2}", rows_[i + 1]) \
                    and not RECEIPT_CODE.match(rows_[i + 1]):
                name = rows_[i + 1]; i += 1
            items.append({"code": m.group(1), "text": (name or "").strip(), "qty": 1, "unit": unit})
            unit = None
        else:
            found = RECEIPT_PRICE.findall(t)
            if found:
                prices += [float(x.replace(",", ".")) for x in found]
            elif re.fullmatch(r"\d+[.,]\d{2}", t):
                last_plain = unit = float(t.replace(",", "."))  # a multi-buy's unit price, or the total
        i += 1
    if not items or len(items) != len(prices):
        return [], total
    lines = []
    for it, amt in zip(items, prices):
        u = it.pop("unit")
        # "5.05" just before "BEEF MINCE" and a line total of 10.10 means 2 x 5.05.
        if u and amt > u and abs(amt / u - round(amt / u)) < 0.01:
            it["qty"] = int(round(amt / u))
        lines.append({**it, "amount": amt})
    if total is None and last_plain is not None and abs(sum(prices) - last_plain) < 0.01:
        total = last_plain  # the unlettered grand total at the bottom
    return lines, total


def parse_receipt(text):
    """Aldi UK receipt text (e.g. pasted from iPhone Live Text) -> lines + totals."""
    lines, pending_qty, total, count = [], None, None, None
    for raw in (text or "").splitlines():
        t = raw.strip()
        if not t:
            continue
        flat = re.sub(r"\s+", "", t).lower()
        if flat.startswith("total"):
            m = re.search(r"(\d+\.\d{2})", t)
            if m and total is None:
                total = float(m.group(1))
            continue
        m = re.match(r"^(\d+)\s+items?\b", t, re.I)
        if m:
            count = int(m.group(1)); continue
        m = RECEIPT_QTY.match(t)
        if m:
            pending_qty = int(m.group(1)); continue
        m = RECEIPT_ITEM.match(t)
        if m:
            code, name, amt = m.group(1), m.group(2).strip(), float(m.group(3))
            if code.startswith("8000") or "DEPOSIT" in name.upper():
                lines.append({"code": code, "text": name, "qty": 1, "amount": amt, "deposit": True})
            else:
                lines.append({"code": code, "text": name, "qty": pending_qty or 1, "amount": amt})
            pending_qty = None
            continue
        m = RECEIPT_DISC.search(t)
        if m and lines:  # "30.0%  -0.30 A" reduces the line above
            lines[-1]["amount"] = round(lines[-1]["amount"] + float(m.group(1)), 2)
            lines[-1]["discount"] = True
    if not lines:
        lines, total = parse_receipt_columns(text, total)
    # identical consecutive lines are the same product bought twice: merge
    merged = []
    for ln in lines:
        if merged and merged[-1]["code"] == ln["code"] and not ln.get("deposit") and not merged[-1].get("discount"):
            merged[-1]["qty"] += ln["qty"]; merged[-1]["amount"] = round(merged[-1]["amount"] + ln["amount"], 2)
        else:
            merged.append(dict(ln))
    return merged, total, count


def receipt_tables(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS receipt (id INTEGER PRIMARY KEY, week_id INTEGER, total REAL,
                    created_at TEXT DEFAULT (datetime('now')))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS receipt_line (receipt_id INTEGER, code TEXT, text TEXT, qty INTEGER,
                    amount REAL, item_key TEXT, kind TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS receipt_code (code TEXT PRIMARY KEY, item_key TEXT, kind TEXT, name TEXT)""")


def classify_receipt(conn, week_id, lines):
    receipt_tables(conn)
    code_to_item = {}
    for r in rows(conn.execute("SELECT item_key, sku FROM price_product WHERE COALESCE(store,'aldi')='aldi'")):
        core = r["sku"].lstrip("0")
        code_to_item.setdefault(core, r["item_key"])
        if len(core) > 6:
            code_to_item.setdefault(core[:6], r["item_key"])  # variant codes: 387996004 -> 387996
    learned = {r["code"]: r for r in rows(conn.execute("SELECT * FROM receipt_code"))}
    groups = build_shopping(conn, week_id)
    on_list = {i["key"]: i for g in groups for i in g["items"]}
    meal_keys = {item_key(r["item"]) for r in rows(conn.execute(
        """SELECT mi.item FROM week_day wd JOIN meal_ingredient mi ON mi.meal_id IN (wd.meal_id, wd.lunch_meal_id)
           WHERE wd.week_id=?""", (week_id,)))}
    for ln in lines:
        if ln.get("deposit"):
            ln["kind"] = "extra"; ln["name"] = "Bottle deposit"; continue
        key = code_to_item.get(ln["code"].lstrip("0")) or (learned.get(ln["code"]) or {}).get("item_key")
        ln["item_key"] = key
        ln["name"] = key or (learned.get(ln["code"]) or {}).get("name") or ln["text"].title()
        if key and key in meal_keys:
            ln["kind"] = "meal"
        elif key and key in on_list:
            ln["kind"] = "meal" if key in pick_one_keys(conn) else "extra"
        elif ln["code"] in learned and learned[ln["code"]]["kind"]:
            ln["kind"] = learned[ln["code"]]["kind"]; ln["remembered"] = True
        else:
            ln["kind"] = "treat"; ln["undecided"] = True
        if not key:
            # A substitute (5% mince instead of the Angus one): suggest the list item
            # it most likely stands in for, by shared words ("beef", "minc").
            words = name_tokens(ln["text"])
            best, best_n = None, 0
            for k in set(on_list) | meal_keys:
                opts = " ".join((on_list.get(k) or {}).get("options") or [])  # "crêpes" -> Breakfast
                n = len(words & (name_tokens(k) | name_tokens(opts.replace("ê", "e"))))
                if n > best_n or (n == best_n and best and len(k) < len(best)):
                    best, best_n = k, n
            if best and best_n >= 1:  # only a suggestion; one tap to accept or ignore
                ln["suggest"] = best
    return lines


def receipt_list_items(conn, week_id):
    """This week's list, for the receipt's "Counts as…" picker: [(key, kind)]."""
    meal_keys = {item_key(r["item"]) for r in rows(conn.execute(
        """SELECT mi.item FROM week_day wd JOIN meal_ingredient mi ON mi.meal_id IN (wd.meal_id, wd.lunch_meal_id)
           WHERE wd.week_id=?""", (week_id,)))}
    keys = {i["key"] for g in build_shopping(conn, week_id) for i in g["items"]} | meal_keys
    out = []
    for g in build_shopping(conn, week_id):
        for i in g["items"]:
            for o in i.get("options") or []:  # "Breakfast — Crêpes" counts as that line
                out.append({"key": i["key"], "label": f"{i['key']} — {o}", "kind": "meal"})
    return out + [{"key": k, "kind": "meal" if k in meal_keys else "extra"} for k in sorted(keys)]


def log_extra(conn, person_id, item, week_id, action):
    conn.execute("INSERT INTO extra_log(person_id,item,week_id,action) VALUES (?,?,?,?)",
                 (person_id or None, item, week_id, action))


def points_mode(conn):
    """'all' = every healthy vote earns a point; 'chosen' = only votes for meals that made the week."""
    r = conn.execute("SELECT value FROM config WHERE key='points_mode'").fetchone()
    return r["value"] if r and r["value"] in ("all", "chosen") else "all"


def sync_healthy_points(conn):
    """Healthy-vote points: add any that are due under the current healthy tags and points rule.
    Switching the rule or tagging more meals healthy back-fills; nothing already earned is removed."""
    healthy = {t.strip() for t in ((conn.execute(
        "SELECT value FROM config WHERE key='healthy_tags'").fetchone() or {"value": ""})["value"] or "").split(",")
        if t.strip()}
    mode = points_mode(conn)
    if mode == "all":  # every vote counts as soon as it's cast
        votes = conn.execute("""
            SELECT v.person_id, v.week_id, v.meal_id, m.name, m.tags
            FROM meal_vote v
            JOIN meal m ON m.id=v.meal_id
            JOIN person p ON p.id=v.person_id AND p.role!='parent'""")
    else:
        votes = conn.execute("""
            SELECT v.person_id, v.week_id, v.meal_id, m.name, m.tags
            FROM meal_vote v
            JOIN week w ON w.id=v.week_id AND w.confirmed=1
            JOIN meal m ON m.id=v.meal_id
            JOIN person p ON p.id=v.person_id AND p.role!='parent'
            WHERE EXISTS (SELECT 1 FROM week_meal wm WHERE wm.week_id=v.week_id AND wm.meal_id=v.meal_id)
               OR EXISTS (SELECT 1 FROM week_day wd WHERE wd.week_id=v.week_id
                          AND v.meal_id IN (wd.meal_id, wd.lunch_meal_id))""")
    want = {}
    for r in rows(votes):
        if healthy & set((r["tags"] or "").split(",")):
            want[(r["person_id"], r["week_id"], r["meal_id"])] = r["name"]
    have = {(r["person_id"], r["week_id"], r["dow"]): (r["id"], r["tags"], r["confirmed"]) for r in rows(conn.execute(
        """SELECT l.id, l.person_id, l.week_id, l.dow, m.tags, COALESCE(w.confirmed, 1) confirmed FROM points_ledger l
           LEFT JOIN meal m ON m.id=l.dow LEFT JOIN week w ON w.id=l.week_id WHERE l.slot='poll'"""))}
    for k, name in want.items():
        if k not in have:
            conn.execute("""INSERT INTO points_ledger(person_id,week_id,dow,slot,delta,reason)
                            VALUES (?,?,?,'poll',1,?)""", (k[0], k[1], k[2], f"voted for {name}"))
    # Earned points stand: re-tagging a meal later doesn't take them back. The only point
    # that goes is one for a vote taken back while its week is still open for voting.
    for k, (rid, tags, confirmed) in have.items():
        if k not in want and not confirmed and not conn.execute(
                "SELECT 1 FROM meal_vote WHERE person_id=? AND week_id=? AND meal_id=?", k).fetchone():
            conn.execute("DELETE FROM points_ledger WHERE id=?", (rid,))
    conn.commit()


def shop_done(conn, week_id):
    """True when this week's list exists and every line of it is ticked off."""
    groups = build_shopping(conn, week_id)
    items = [i for g in groups for i in g["items"]]
    return bool(items) and all(i["checked"] for i in items)


def build_shopping(conn, week_id, store_id=None):
    """Aggregate every ingredient across the week, plus routine items and extras."""
    totals = {}  # item -> dict

    def add(item, amount, unit, aisle, tag=None, note=None, meal=None, src=None):
        # Different meals spell the same ingredient differently ("Grated
        # Cheese" vs "grated cheese") — normalise casing before grouping, or
        # they silently end up as two separate lines instead of summing.
        item = item_key(item)
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
        if src:  # who asked for how much: a meal's ingredient, or an extra
            cur = totals[key].setdefault("parts", {}).setdefault(src, [0, unit])
            cur[0] += amount
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
                add(ing["item"], ing["amount"], ing["unit"], ing["aisle"], meal=(mid, meal_names[mid]),
                    src=("meal", meal_names[mid]))

    # Standing meals (a WFH lunch, a packed lunch for work) — needed
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
                tag=r["person"] or "everyone", meal=(r["id"], r["name"]), src=("meal", r["name"]))

    options = {}
    for e in rows(conn.execute(
            """SELECT e.*, p.name AS person, COALESCE(we.qty, 1) AS qty FROM extra e
               LEFT JOIN person p ON p.id = e.person_id
               LEFT JOIN week_extra we ON we.extra_id = e.id AND we.week_id = ?
               WHERE e.recurring = 1
                  OR e.id IN (SELECT extra_id FROM week_extra WHERE week_id=?)""", (week_id, week_id))):
        # "everyone" not "household": the aisle list already has a Household
        # aisle, and having both meanings share a word is what made the two
        # dropdowns on the add-item row indistinguishable.
        add(e["item"], e["amount"] * e["qty"], e["unit"], e["aisle"], tag=e["person"] or "everyone",
            src=("extra", e["person"] or "everyone"))
        if e.get("options"):
            options[item_key(e["item"])] = [o.strip() for o in e["options"].split(",") if o.strip()]

    checked = {t["item"]: t["checked"]
               for t in rows(conn.execute("SELECT * FROM shop_tick WHERE week_id=?", (week_id,)))}
    pantry_checked = {t["item"]: t["checked"]
               for t in rows(conn.execute("SELECT * FROM pantry_tick WHERE week_id=?", (week_id,)))}

    by_aisle = {}
    for key, t in totals.items():
        t = {**t, "tags": sorted(t["tags"]), "key": key, "options": options.get(key),
             "qty": fmt_qty(t["amount"], t["unit"]), "checked": bool(checked.get(key, 0)),
             "pantryChecked": bool(pantry_checked.get(key, 0)),
             "meals": [{"id": mid, "name": name} for mid, name in sorted(t["meals"].items(), key=lambda x: x[1])],
             "parts": [{"kind": k[0], "name": k[1], "qty": fmt_qty(a, u)}
                       for k, (a, u) in sorted(t.get("parts", {}).items(), key=lambda x: (x[0][0] != "meal", x[0][1]))]}
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

def extras_need_push(conn):
    """Household setting: children must have notifications on before asking for extras."""
    row = conn.execute("SELECT value FROM config WHERE key='extras_need_push'").fetchone()
    return bool(row and row["value"] == "1")


FLOOD_NOTICES = [
    "You're requesting a lot at once 👀",
    "Are you sure you want all this stuff? 🤨",
    "You're just being silly now. One more and it all resets. 🙃",
]


def flood_settings(conn):
    """(limit, timeout_minutes). Limit = requests per person per week before a reset; 0 = off."""
    def get(k, d):
        r = conn.execute("SELECT value FROM config WHERE key=?", (k,)).fetchone()
        return int(r["value"]) if r else d
    return get("extras_flood_limit", 12), get("extras_flood_timeout_min", 15)


def extras_timeout_left(conn, person_id):
    """Minutes (rounded up) left of a short break from asking for extras, else 0."""
    r = conn.execute("""SELECT CAST((julianday(extras_timeout_until) - julianday('now')) * 1440 + 0.99 AS INTEGER) m
                        FROM person WHERE id=? AND extras_timeout_until > datetime('now')""", (person_id,)).fetchone()
    return max(1, r["m"]) if r else 0


def flood_check(conn, db, person_id, week_id):
    """After a new request: warn as someone piles them up, and at the limit wipe their
    requests for the week (and the history of them) and give them a short break.
    Items a parent already approved stay on the list. Returns {"level", "text"} or None."""
    limit, minutes = flood_settings(conn)
    if limit < 2:
        return None
    n = conn.execute("SELECT COUNT(*) c FROM extra_request WHERE person_id=? AND week_id=?",
                     (person_id, week_id)).fetchone()["c"]
    if n >= limit:
        conn.execute("DELETE FROM extra_request WHERE person_id=? AND week_id=?", (person_id, week_id))
        conn.execute("""DELETE FROM extra_log WHERE person_id=? AND week_id=? AND (action LIKE 'asked for%'
                        OR action LIKE 'cancelled ask%' OR action LIKE 'request %')""", (person_id, week_id))
        if minutes > 0:
            conn.execute("UPDATE person SET extras_timeout_until=datetime('now', ?) WHERE id=?",
                         (f"+{minutes} minutes", person_id))
        conn.commit()
        name = conn.execute("SELECT name FROM person WHERE id=?", (person_id,)).fetchone()["name"]
        push.notify(conn, db, push.people(conn, role="parent"), "extra_request", "Request limit hit",
                    f"{name} asked for {n} things this week, so their requests were reset"
                    + (f" and they're on a {minutes} minute break." if minutes > 0 else "."),
                    "/#/extras", extra={"tag": f"flood-{person_id}"})
        return {"level": 4, "text": "Your requests for this week have been fully reset."
                + (f" You're on a short break from asking, back in {minutes} minute{'s' if minutes != 1 else ''}. ⏳" if minutes > 0 else "")}
    marks = [-(-limit // 2), -(-limit * 3 // 4), limit - 1]  # roughly half, three-quarters, one short of the limit
    if sorted(set(marks)) == marks and marks[0] >= 1:
        for lvl, m in enumerate(marks):
            if n == m:
                return {"level": lvl + 1, "text": FLOOD_NOTICES[lvl]}
    return None


def extras_blocked(conn, me):
    return (me["role"] != "parent" and push.AVAILABLE and extras_need_push(conn)
            and not conn.execute("SELECT 1 FROM push_sub WHERE person_id=?", (me["id"],)).fetchone())


def cycle(conn, today=None):
    """THE week model. Every screen asks this one function, nothing else decides a week.

    The household's rhythm is vote -> plan -> shop (Friday) -> eat, and next week's
    vote overlaps this week's meals, so one calendar date maps to several weeks:
      thisWeekId      the calendar week containing today (the week being eaten)
      nextWeekId      the one after
      voteWeekId      what Vote/Finalise act on: this week while its meals are still
                      unplanned or its shop isn't done, then the first unplanned week after
      shopWeekId      the next shop not yet done (this week's, then next's, then the
                      following one): where Extras are added
      shopViewWeekId  what Shopping opens on: shopWeekId, never past next week, so a
                      shop you've just finished (and its receipt) stays in view
    """
    def row(wid):
        return conn.execute("SELECT start_date, confirmed, shop_closed FROM week WHERE id=?", (wid,)).fetchone()

    def after(wid):
        return ensure_week(conn, (date.fromisoformat(row(wid)["start_date"]) + timedelta(days=7)).isoformat())

    this_id = ensure_week(conn, week_start_of(conn, today or date.today()))
    next_id = after(this_id)
    t = row(this_id)
    vote_id = this_id
    if t["confirmed"] and t["shop_closed"]:
        vote_id = next_id
        for _ in range(52):
            if not row(vote_id)["confirmed"]:
                break
            vote_id = after(vote_id)
    shop_id = this_id
    for _ in range(52):
        if not row(shop_id)["shop_closed"]:
            break
        shop_id = after(shop_id)
    return {"thisWeekId": this_id, "nextWeekId": next_id, "voteWeekId": vote_id,
            "shopWeekId": shop_id, "shopViewWeekId": shop_id if shop_id in (this_id, next_id) else next_id}


def notify_extra_ask(conn, person_id, item, request_id):
    """Tell the parents when a child asks for something (parents' own adds are silent).
    Each request gets its own notification (unique tag) with Approve / Say no buttons."""
    who = conn.execute("SELECT name, role FROM person WHERE id=?", (person_id,)).fetchone()
    if who and who["role"] != "parent":
        push.notify(conn, db, push.people(conn, role="parent"), "extra_request",
                    f"{who['name']} asked for {item}", "Tap to see it, or approve straight from here.", "/#/extras",
                    extra={"tag": f"extra_request-{request_id}", "requestId": request_id})


READ_ONLY_POSTS = {"/api/receipt/summary", "/api/receipt/parse", "/api/compare/list"}

# Never sent to the browser or put in an export.
SECRET_PERSON_FIELDS = ("pw_hash", "failed_logins", "locked_until", "pin_hash", "pin_default", "link_token")


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
        with db() as conn:
            me = self.signed_in(conn)
            setup = not me and not conn.execute("SELECT 1 FROM person WHERE is_placeholder=0").fetchone()
        if not me:
            return self.send_json({"error": "signin", "setup": setup}, 401)
        self.me = me
        if u.path == "/api/meal-photo":
            with db() as conn:
                r = conn.execute("SELECT mime, data FROM meal_photo WHERE meal_id=?",
                                 (int(urllib.parse.parse_qs(u.query)["id"][0]),)).fetchone()
            if not r:
                self.send_response(404); self.end_headers(); return
            self.send_response(200)
            self.send_header("Content-Type", r["mime"])
            self.send_header("Content-Length", str(len(r["data"])))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers(); self.wfile.write(r["data"]); return
        if u.path == "/api/version":
            with db() as conn:
                pending = conn.execute(
                    "SELECT COUNT(*) c FROM extra_request WHERE status='pending'").fetchone()["c"]
            return self.send_json({"v": DATA_VERSION, "pending": pending, "build": BUILD_ID})
        q = urllib.parse.parse_qs(u.query)
        # Who you are comes from your sign-in, never from the request. Children
        # can only ever look as themselves; parents may look at anyone.
        for k in ("admin_id", "actor_id"):
            if k in q:
                q[k] = [str(me["id"])]
        if "person" in q and me["role"] != "parent":
            q["person"] = [str(me["id"])]
        if u.path.startswith("/api/push/"):
            q["person_id"] = [str(me["id"])]
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
        # JSON only: a plain cross-site form can't send this content type, so
        # another website can't make a signed-in browser post here (CSRF).
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json({"error": "Expected JSON."}, 415)
        try:
            body = self.read_json()
        except Exception:
            return self.send_json({"error": "That request wasn't valid JSON."}, 400)
        try:
            with db() as conn:
                if u.path in ("/api/login", "/api/setup"):
                    return self.auth_post(conn, u.path, body)
                me = self.signed_in(conn)
                if not me:
                    return self.send_json({"error": "signin"}, 401)
                self.me = me
                if u.path in ("/api/logout", "/api/password"):
                    return self.auth_post(conn, u.path, body)
                if me["pw_must_change"]:
                    return self.send_json({"error": "Choose a new password first."}, 403)
                # Identity comes from the sign-in, not the request body.
                for k in ("admin_id", "actor_id", "resolver_id", "by"):
                    if k in body:
                        body[k] = me["id"]
                if "person_id" in body and (me["role"] != "parent" or u.path.startswith("/api/push/")):
                    body["person_id"] = me["id"]
                global DATA_VERSION
                # Read-only POSTs mustn't tell open screens to reload: the receipt
                # summary bar did, so every screen reloaded, re-fetched, reloaded…
                if u.path not in READ_ONLY_POSTS:
                    DATA_VERSION += 1
                return self.api_post(conn, u.path, body)
        except (KeyError, ValueError, IndexError):
            return self.send_json({"error": "That request was missing something or malformed."}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def client_ip(self):
        # Behind a reverse proxy on the same machine, the proxy's header holds
        # the real address. Never trusted from anyone else.
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1"):
            fwd = self.headers.get("X-Real-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[0]
            ip = fwd.strip() or ip
        return ip

    def signed_in(self, conn):
        from http.cookies import SimpleCookie
        try:
            c = SimpleCookie(self.headers.get("Cookie") or "")
        except Exception:
            return None
        return auth.session_person(conn, c[auth.COOKIE].value if auth.COOKIE in c else None)

    def send_json_cookie(self, obj, cookie, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def auth_post(self, conn, path, b):
        if path == "/api/login":
            ip = self.client_ip()
            if not auth.ip_allowed(ip):
                return self.send_json({"error": "Too many attempts. Wait a few minutes."}, 429)
            row, err = auth.login(conn, b.get("username"), b.get("password"))
            if err:
                print(f"failed sign-in for {auth.clean_username(b.get('username'))!r} from {ip}", flush=True)
                return self.send_json({"error": err}, 401)
            token = auth.new_session(conn, row["id"])
            return self.send_json_cookie({"ok": True}, auth.cookie_header(token))

        if path == "/api/setup":
            # First run only: nobody exists yet, so the first person becomes
            # the admin parent. Refused for good once anyone real exists.
            if conn.execute("SELECT 1 FROM person WHERE is_placeholder=0").fetchone():
                return self.send_json({"error": "Already set up."}, 403)
            name = (b.get("name") or "").strip()[:30]
            prob = auth.password_problem(b.get("password"))
            if not name or prob:
                return self.send_json({"error": prob or "Needs a name."}, 400)
            cur = conn.execute("INSERT INTO person(name,role,is_admin,username) VALUES (?,?,1,?)",
                               (name, "parent", auth.unique_username(conn, b.get("username") or name)))
            auth.set_password(conn, cur.lastrowid, b["password"], False)
            token = auth.new_session(conn, cur.lastrowid)
            return self.send_json_cookie({"ok": True}, auth.cookie_header(token))

        if path == "/api/logout":
            from http.cookies import SimpleCookie
            c = SimpleCookie(self.headers.get("Cookie") or "")
            auth.end_session(conn, c[auth.COOKIE].value if auth.COOKIE in c else None)
            return self.send_json_cookie({"ok": True}, auth.cookie_header("", 0))

        if path == "/api/password":
            # Changing your own: needs the current one, unless you're on a
            # temporary password a parent just set (then you're already in).
            me = self.me
            if not me["pw_must_change"] and not auth.check_password(b.get("current") or "", me["pw_hash"] or ""):
                return self.send_json({"error": "Your current password isn't right."}, 400)
            prob = auth.password_problem(b.get("new"))
            if prob:
                return self.send_json({"error": prob}, 400)
            from http.cookies import SimpleCookie
            c = SimpleCookie(self.headers.get("Cookie") or "")
            auth.set_password(conn, me["id"], b["new"], False, keep_token=c[auth.COOKIE].value)
            return self.send_json({"ok": True})

    def api_get(self, conn, path, q):
        if path == "/api/bootstrap":
            ids = cycle(conn)
            this_id, next_id, vote_id = ids["thisWeekId"], ids["nextWeekId"], ids["voteWeekId"]
            shop_ids = {k: ids[k] for k in ("shopWeekId", "shopViewWeekId")}
            weeks = rows(conn.execute("SELECT * FROM week ORDER BY start_date DESC"))
            people = rows(conn.execute("SELECT * FROM person ORDER BY role DESC, id"))
            for p in people:
                p["energy"] = tdee(p)
                p["has_password"] = bool(p.get("pw_hash"))
                for k in SECRET_PERSON_FIELDS:
                    p.pop(k, None)
            aisles = [r["name"] for r in rows(conn.execute("SELECT name FROM aisle_order ORDER BY pos"))]
            return self.send_json({
                "weeks": weeks, "people": people, "aisles": aisles or AISLE_ORDER, "tags": TAGS,
                "thisWeekId": this_id, "nextWeekId": next_id, "voteWeekId": vote_id,
                # THE shop week, used by everything shopping-related: this week's until
                # its shop is marked done, then next week's (you shop Friday for the
                # week that starts Saturday).
                **shop_ids,
                # Once everything on this week's list is in the trolley, the
                # week in hand is finished with — anything added from then on
                # is for the next shop, not this one.
                "shopDone": shop_done(conn, this_id),
                "meId": self.me["id"],
                "mustChangePassword": bool(self.me["pw_must_change"]),
                "votingOpen": voting_open(conn, vote_id),
                "weekStartDow": get_week_start_dow(conn),
                "protectedWeekIds": sorted(protected_week_ids(conn)),
                "mealsTargetDefault": int((conn.execute(
                    "SELECT value FROM config WHERE key='meals_target_default'").fetchone() or {"value": "7"})["value"]),
                # Days already eaten are history: dimmed, and read-only unless
                # the household deliberately turns editing back on.
                "morrisonsEnabled": morrisons_enabled(conn),
                "vetoesPerPerson": vetoes_allowed(conn),
                "extrasNeedPush": extras_need_push(conn),
                "extrasFloodLimit": flood_settings(conn)[0], "extrasFloodTimeoutMin": flood_settings(conn)[1],
                "lastBackup": (conn.execute("SELECT value FROM config WHERE key='last_backup'").fetchone() or {"value": None})["value"],
                "allowHistoricEdits": (conn.execute(
                    "SELECT value FROM config WHERE key='allow_historic_edits'").fetchone()
                    or {"value": "0"})["value"] == "1",
            })

        if path == "/api/extra-request":
            # One request, for the approve box a notification opens.
            r = conn.execute("""SELECT er.id, er.item, er.amount, er.status, p.name AS person
                                FROM extra_request er JOIN person p ON p.id=er.person_id WHERE er.id=?""",
                             (int(q["id"][0]),)).fetchone()
            return self.send_json({"request": dict(r) if r else None})

        if path == "/api/push/state":
            pid = int(q.get("person_id", ["0"])[0] or 0)
            _, key = push.vapid_keys(conn)
            return self.send_json({
                "enabled": push.AVAILABLE, "key": key,
                "kinds": push.KINDS,
                "off": [r["kind"] for r in conn.execute("SELECT kind FROM push_off WHERE person_id=?", (pid,))],
                "reminderHour": push.reminder_hour(conn),
                "devices": conn.execute("SELECT COUNT(*) FROM push_sub WHERE person_id=?", (pid,)).fetchone()[0]})

        if path == "/api/week":
            wid = int(q["id"][0])
            viewer = q.get("person", [""])[0]
            return self.send_json(build_week(conn, wid, int(viewer) if viewer else None))

        if path == "/api/shopping":
            wid = int(q["id"][0])
            sid = q.get("store_id", [""])[0]
            phase = (conn.execute("SELECT shopping_phase FROM week WHERE id=?", (wid,)).fetchone()
                     or {"shopping_phase": "pantry"})["shopping_phase"]
            groups = build_shopping(conn, wid, int(sid) if sid else None)
            return self.send_json({"groups": groups, "phase": phase,
                                   "estimate": add_estimate(conn, groups)})

        if path == "/api/pricing/items":
            items, uses = {}, {}
            for r in rows(conn.execute("""SELECT mi.id, mi.item, mi.amount, mi.unit, m.name AS meal FROM meal_ingredient mi
                                          JOIN meal m ON m.id=mi.meal_id WHERE m.deleted_at IS NULL ORDER BY m.name""")):
                k = item_key(r["item"])
                items.setdefault(k, set()).add(r["meal"])
                uses.setdefault(k, []).append({"id": r["id"], "meal": r["meal"], "amount": r["amount"], "unit": r["unit"]})
            for r in rows(conn.execute("SELECT item FROM extra")):
                items.setdefault(item_key(r["item"]), set()).add("Extras")
            links = price_links(conn)
            receipt_tables(conn)
            # Receipt products that "count as" an item but aren't one of its linked Aldi products.
            skus = {}
            for r in conn.execute("SELECT item_key, sku FROM price_product WHERE COALESCE(store,'aldi')='aldi' AND variant_code IS NULL"):
                skus.setdefault(r["item_key"], set()).update({r["sku"].lstrip("0"), r["sku"].lstrip("0")[:6]})
            counted = {}
            for r in conn.execute("""SELECT item_key, code, text, qty, amount FROM receipt_line
                                     WHERE item_key IS NOT NULL AND code IS NOT NULL AND code!='' ORDER BY rowid"""):
                if r["code"].lstrip("0") in skus.get(r["item_key"], ()):
                    continue
                v = counted.setdefault(r["item_key"], {}).setdefault(
                    r["code"], {"name": (r["text"] or r["code"]).title(), "times": 0, "unit": []})
                v["times"] += 1
                v["unit"].append(round(r["amount"] / max(r["qty"] or 1, 1), 2))
            out = []
            for k in sorted(items):
                if not k:
                    continue
                prods = [p for p in links.get(k, []) if not p.get("variant_code")]
                live = [p["price"] for p in prods if not p["missing"]]
                variants = []
                for code, v in counted.get(k, {}).items():
                    vp = [p for p in links.get(k, []) if p.get("variant_code") == code]
                    prices = [p["price"] for p in vp if not p["missing"]] or v["unit"]
                    variants.append({"code": code, "name": v["name"], "times": v["times"], "paid": v["unit"],
                                     "products": vp, "low": min(prices), "high": max(prices)})
                allp = live + [x for v in variants for x in (v["low"], v["high"])]
                out.append({"key": k, "meals": sorted(items[k]), "products": prods, "uses": uses.get(k, []),
                            "variants": sorted(variants, key=lambda v: v["name"]),
                            "low": min(allp) if allp else None, "high": max(allp) if allp else None})
            last = conn.execute("SELECT MAX(checked_at) c FROM price_product").fetchone()["c"]
            return self.send_json({"items": out, "lastChecked": last})

        if path == "/api/compare/list":
            conn.execute("""CREATE TABLE IF NOT EXISTS store_match (
                aldi_sku TEXT, store TEXT, sku TEXT, name TEXT, size TEXT, price REAL, score REAL,
                rank INTEGER, checked_at TEXT, picked INTEGER DEFAULT 0, PRIMARY KEY (aldi_sku, store, rank))""")
            src = rows(conn.execute("""SELECT item_key, sku, name, size, price, category, brand FROM price_product
                                       WHERE COALESCE(store,'aldi')='aldi' AND missing=0 AND variant_code IS NULL GROUP BY item_key ORDER BY item_key"""))
            out = []
            for a in src:
                ms = rows(conn.execute("""SELECT sku, name, size, price, score, picked FROM store_match
                                          WHERE aldi_sku=? AND store='morrisons' ORDER BY rank""", (a["sku"],)))
                if not ms:
                    continue
                if not any(c["picked"] for c in ms):
                    for c in ms:
                        c["score"] = match_score(a, {**c, "brand": "Morrisons" if c["name"].lower().startswith("morrisons") else ""})
                    ms.sort(key=lambda c: -(c["score"] or 0))
                for c in ms:
                    c["unit"], c["unitOf"] = unit_price(c)
                au, auu = unit_price(a)
                out.append({"item": a["item_key"], "aldi": {**a, "unit": au, "unitOf": auu}, "matches": ms})
            return self.send_json({"rows": out, "total": len(src)})

        if path == "/api/pricing/search":
            term = (q.get("q", [""])[0] or "").strip()
            if not term:
                return self.send_json({"results": []})
            if q.get("store", ["aldi"])[0] == "morrisons":
                if not morrisons_enabled(conn):
                    return self.send_json({"error": "Morrisons prices are switched off in Settings."}, 403)
                try:
                    return self.send_json({"results": morrisons_search(term)[:24]})
                except Exception:
                    return self.send_json({"error": "Couldn't reach Morrisons just now."}, 502)
            if re.fullmatch(r"\d{4,9}", term):  # a receipt product code: look the product up directly
                found = aldi_by_code(term)
                if found is None:
                    return self.send_json({"error": "Couldn't reach Aldi just now."}, 502)
                return self.send_json({"results": found, "byCode": True})
            hit = cache_get("a:" + term.lower())
            if hit is not None:
                return self.send_json({"results": hit})
            try:
                d = aldi_get("/v3/product-search?" + urllib.parse.urlencode(
                    {"currency": "GBP", "serviceType": "walk-in", "q": term, "page[limit]": 24}))
            except Exception:
                return self.send_json({"error": "Couldn't reach Aldi just now."}, 502)
            res = [aldi_trim(p) for p in d.get("data", [])]
            cache_put("a:" + term.lower(), res)
            return self.send_json({"results": res})

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
            # "Family favourite": liked by more than half the household, at least
            # one parent among them, and not vetoed. Only pre-ticks the finalise
            # list; a parent still finalises, and a later veto clears it.
            household = conn.execute("SELECT COUNT(*) FROM person WHERE is_placeholder=0").fetchone()[0]
            likes = {}
            for r in conn.execute("""SELECT v.meal_id, p.role FROM meal_vote v JOIN person p ON p.id=v.person_id
                                     WHERE v.week_id=? AND p.is_placeholder=0""", (wid,)):
                n, par = likes.get(r["meal_id"], (0, False))
                likes[r["meal_id"]] = (n + 1, par or r["role"] == "parent")
            for t in tally:
                t["vetoed"] = t["id"] in vetoed
                t["chosen"] = t["id"] in chosen
                n, par = likes.get(t["id"], (0, False))
                t["favourite"] = n * 2 > household and par and not t["vetoed"]
            my_veto, my_vetoes = None, []
            mine = set()
            me_q = q.get("person", [""])[0]
            if me_q:
                my_vetoes = [r["meal_id"] for r in rows(conn.execute(
                    "SELECT meal_id FROM veto WHERE week_id=? AND person_id=?", (wid, int(me_q))))]
                my_veto = my_vetoes[0] if my_vetoes else None
                mine = {r["meal_id"] for r in rows(conn.execute(
                    "SELECT meal_id FROM meal_vote WHERE week_id=? AND person_id=?", (wid, int(me_q))))}
            for t in tally:
                t["mine"] = t["id"] in mine
            wk = conn.execute("SELECT meals_target FROM week WHERE id=?", (wid,)).fetchone()
            default_target = int((conn.execute(
                "SELECT value FROM config WHERE key='meals_target_default'").fetchone() or {"value": "7"})["value"])
            target = (wk["meals_target"] if wk and wk["meals_target"] else default_target)
            subbed = {r[0] for r in conn.execute("SELECT DISTINCT person_id FROM push_sub")}
            # Per person: picks used this week and whether they can be notified (parents' remind list).
            picks = [{"id": r["id"], "name": r["name"], "used": r["used"], "notifiable": r["id"] in subbed}
                     for r in conn.execute("""SELECT p.id, p.name, (SELECT COUNT(*) FROM meal_vote v
                                              WHERE v.week_id=? AND v.person_id=p.id) AS used
                                              FROM person p WHERE p.is_placeholder=0 ORDER BY p.id""", (wid,))]
            return self.send_json({"tally": tally, "my_veto": my_veto, "my_vetoes": my_vetoes,
                                   "vetoes_allowed": vetoes_allowed(conn), "target": target, "picks": picks})

        if path == "/api/week/pool":
            # Meals finalized onto this week's shortlist but not yet assigned
            # to a day, plus the separate hand-curated Lunch list.
            wid = int(q["id"][0])
            assigned = {m for r in rows(conn.execute(
                "SELECT meal_id, lunch_meal_id FROM week_day WHERE week_id=?", (wid,)))
                for m in (r["meal_id"], r["lunch_meal_id"]) if m}
            chosen = rows(conn.execute("""
                SELECT m.id, m.name FROM week_meal wm JOIN meal m ON m.id=wm.meal_id
                WHERE wm.week_id=? AND m.deleted_at IS NULL ORDER BY m.name""", (wid,)))
            pool = [m for m in chosen if m["id"] not in assigned]
            kids_lunch = rows(conn.execute("""
                SELECT id, name FROM meal
                WHERE deleted_at IS NULL AND meal_type LIKE '%kids_lunch%' ORDER BY name"""))
            return self.send_json({"pool": pool, "kidsLunch": kids_lunch})

        if path == "/api/backup":
            if not self.me["is_admin"]:
                return self.send_json({"error": "Admins only."}, 403)
            body = make_backup_bytes()
            conn.execute("""INSERT INTO config(key,value) VALUES ('last_backup',?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                         (json.dumps({"at": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                                      "by": self.me["name"]}),))
            conn.commit()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="mealplan-backup-{date.today().isoformat()}.db"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

        if path == "/api/ideas":
            if self.me["role"] != "parent":
                return self.send_json({"error": "Parents only."}, 403)
            ideas = rows(conn.execute("SELECT * FROM meal_idea ORDER BY name"))
            for i in ideas:
                i["ingredients"] = json.loads(i["ingredients"] or "[]")
            return self.send_json({"ideas": ideas})

        if path == "/api/export":
            if not self.me["is_admin"]:
                return self.send_json({"error": "Admins only."}, 403)
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
            tables = [t for t in tables if t not in ("session", "push_sub")]
            for t in tables:
                dump["_schema"][t] = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()["sql"]
                data = rows(conn.execute(f'SELECT * FROM "{t}"'))
                # PIN hashes are the one thing not worth putting in a file
                # that gets dropped on a shared Samba folder. Everything else
                # is recoverable household data; a PIN is re-set in seconds.
                if t == "person":
                    for r in data:
                        for k in SECRET_PERSON_FIELDS:
                            r.pop(k, None)
                if t == "config":
                    data = [r for r in data if r["key"] != "vapid_private"]
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
                       (SELECT COUNT(*) FROM meal_rating WHERE meal_id=m.id) AS rating_count,
                       EXISTS(SELECT 1 FROM meal_photo WHERE meal_id=m.id) AS has_photo
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
                       ORDER BY e.item COLLATE NOCASE""", (wid,)))
            else:
                extras = rows(conn.execute(
                    """SELECT e.*, p.name AS person,
                              (SELECT COUNT(DISTINCT we.week_id) FROM week_extra we
                                WHERE we.extra_id = e.id) AS prior_weeks
                       FROM extra e
                       LEFT JOIN person p ON p.id = e.person_id
                       ORDER BY e.item COLLATE NOCASE"""))
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
            kids = [dict(r) for r in conn.execute("""SELECT p.id, p.name, EXISTS(SELECT 1 FROM push_sub s
                    WHERE s.person_id=p.id) AS notifiable FROM person p
                    WHERE p.is_placeholder=0 AND p.role!='parent' ORDER BY p.id""")]
            my_devices = conn.execute("SELECT COUNT(*) FROM push_sub WHERE person_id=?", (self.me["id"],)).fetchone()[0]
            return self.send_json({"extras": extras, "requests": requests_, "kids": kids, "myDevices": my_devices,
                                   "needPush": extras_need_push(conn)})

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

        if path == "/api/extra-log":
            me_id = int(q.get("person", ["0"])[0] or 0)
            sql = """SELECT l.*, p.name AS person_name, w.start_date FROM extra_log l
                     LEFT JOIN person p ON p.id=l.person_id LEFT JOIN week w ON w.id=l.week_id"""
            if is_parent(conn, me_id):
                out = rows(conn.execute(sql + " ORDER BY l.id DESC LIMIT 300"))
            else:
                out = rows(conn.execute(sql + " WHERE l.person_id=? ORDER BY l.id DESC LIMIT 300", (me_id,)))
            return self.send_json({"log": out})

        if path == "/api/rewards":
            sync_healthy_points(conn)
            person = q.get("person", [""])[0]
            history = rows(conn.execute("""
                SELECT l.person_id, p.name AS person_name, l.delta, l.reason,
                       COALESCE(w.start_date, date(l.created_at)) AS when_date
                FROM points_ledger l JOIN person p ON p.id=l.person_id
                LEFT JOIN week w ON w.id=l.week_id
                ORDER BY when_date DESC, l.id DESC"""))
            balances = {r["person_id"]: r["bal"] for r in rows(conn.execute(
                "SELECT person_id, SUM(delta) bal FROM points_ledger GROUP BY person_id"))}
            earned = {r["person_id"]: r["e"] for r in rows(conn.execute(
                "SELECT person_id, SUM(delta) e FROM points_ledger WHERE delta>0 GROUP BY person_id"))}
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
                "earned": earned,
                "history": history,
                "myEarned": earned.get(int(person), 0) if person else 0,
                "healthyTags": [t for t in healthy_tags.split(",") if t],
                "pointsMode": points_mode(conn),
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
        if path in ("/api/extra", "/api/extra/set-qty", "/api/extra-request", "/api/extra-request/set") and b.get("week_id"):
            wk = conn.execute("SELECT shop_closed FROM week WHERE id=?", (b["week_id"],)).fetchone()
            if wk and wk["shop_closed"]:
                return self.send_json({"error": "That week's shop is marked done — nothing more can be added to it."}, 400)

        if path == "/api/week/shop-total":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            t = b.get("total")
            conn.execute("UPDATE week SET shop_total=? WHERE id=?",
                         (round(float(t), 2) if t not in (None, "") else None, b["week_id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/shop-close":
            conn.execute("UPDATE week SET shop_closed=? WHERE id=?", (1 if b.get("closed") else 0, b["week_id"]))
            conn.commit()
            # Locking the shop opens next week's vote. Announce it once per week
            # (person_id 0 marks the announcement; re-locking doesn't resend).
            wk = conn.execute("SELECT start_date, confirmed FROM week WHERE id=?", (b["week_id"],)).fetchone()
            if b.get("closed") and wk and wk["confirmed"]:
                nxt = ensure_week(conn, (date.fromisoformat(wk["start_date"]) + timedelta(days=7)).isoformat())
                if conn.execute("""INSERT OR IGNORE INTO push_sent(kind,week_id,person_id)
                                   VALUES ('voting_open',?,0)""", (nxt,)).rowcount:
                    conn.commit()
                    push.notify(conn, db, push.people(conn, exclude=b.get("actor_id")), "voting_open",
                                "Voting is open 🗳️", "Pick the meals you'd like next week.", "/#/vote")
            return self.send_json({"ok": True})

        if path == "/api/shop-tick":
            conn.execute("""INSERT INTO shop_tick(week_id,item,checked) VALUES (?,?,?)
                            ON CONFLICT(week_id,item) DO UPDATE SET checked=excluded.checked""",
                         (b["week_id"], b["item"], int(b["checked"])))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/pantry-tick":
            conn.execute("""INSERT INTO pantry_tick(week_id,item,checked) VALUES (?,?,?)
                            ON CONFLICT(week_id,item) DO UPDATE SET checked=excluded.checked""",
                         (b["week_id"], b["item"], int(b["checked"])))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/week/shopping-phase":
            # Deliberately no admin/parent gate — this only changes which view
            # you're looking at, not any data, so anyone heading out the door
            # can flip it. Reversible: switching back to 'pantry' loses
            # nothing, the pantry_tick marks are untouched either direction.
            phase = b.get("phase")
            if phase not in ("pantry", "shopping"):
                return self.send_json({"error": "Bad phase."}, 400)
            conn.execute("UPDATE week SET shopping_phase=? WHERE id=?", (phase, b["week_id"]))
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
            if "no_ingredients" in b:
                conn.execute("UPDATE meal SET no_ingredients=? WHERE id=?", (int(b["no_ingredients"]), mid))
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
            allowed = vetoes_allowed(conn)
            mine = [r["meal_id"] for r in rows(conn.execute(
                "SELECT meal_id FROM veto WHERE week_id=? AND person_id=?", (b["week_id"], b["person_id"])))]
            if b["meal_id"] in mine:
                conn.execute("DELETE FROM veto WHERE week_id=? AND person_id=? AND meal_id=?",
                             (b["week_id"], b["person_id"], b["meal_id"]))
                conn.commit()
                return self.send_json({"ok": True, "vetoed": False})
            if allowed == 0:
                return self.send_json({"error": "Vetoes are switched off."}, 400)
            if len(mine) >= allowed:
                return self.send_json({"error": f"That's all {allowed} of your vetoes — undo one first."}, 400)
            if conn.execute("SELECT 1 FROM meal_vote WHERE week_id=? AND meal_id=?",
                            (b["week_id"], b["meal_id"])).fetchone():
                return self.send_json({"error": "Someone's already voted for this one, so it can't be vetoed."}, 400)
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
            names = [r["name"] for r in conn.execute(
                f"SELECT name FROM meal WHERE id IN ({','.join('?' * len(meal_ids))})", meal_ids)]
            push.notify(conn, db, push.people(conn, exclude=b.get("actor_id")), "plan_final",
                        "The meals are set 🍽️", ", ".join(names[:6]) + (" and more" if len(names) > 6 else ""),
                        "/#/plan")
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

        if path in ("/api/idea/add", "/api/idea/dismiss"):
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            idea = conn.execute("SELECT * FROM meal_idea WHERE id=?", (b["id"],)).fetchone()
            if not idea:
                return self.send_json({"error": "That idea has already gone."}, 400)
            if path == "/api/idea/add":
                if conn.execute("SELECT 1 FROM meal WHERE name=? COLLATE NOCASE", (idea["name"],)).fetchone():
                    return self.send_json({"error": f"You already have a meal called {idea['name']}."}, 400)
                mid = conn.execute("INSERT INTO meal(name,note,tags,meal_type) VALUES (?,?,?,?)",
                                   (idea["name"], idea["note"], idea["tags"], idea["meal_type"])).lastrowid
                for i in json.loads(idea["ingredients"] or "[]"):
                    conn.execute("INSERT INTO meal_ingredient(meal_id,item,amount,unit,aisle) VALUES (?,?,?,?,?)",
                                 (mid, i["item"], i.get("amount") or 1, i.get("unit") or "unit", i.get("aisle") or "Cupboard"))
            conn.execute("DELETE FROM meal_idea WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/restore":
            if not self.me["is_admin"]:
                return self.send_json({"error": "Admins only."}, 403)
            try:
                keep = restore_from_bytes(base64.b64decode(b.get("data") or "", validate=True))
            except Exception as e:
                return self.send_json({"error": str(e) if isinstance(e, ValueError) else "That file couldn't be read."}, 400)
            return self.send_json({"ok": True, "kept": os.path.basename(keep)})

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
                if "options" in b:
                    conn.execute("UPDATE extra SET options=? WHERE id=?",
                                 (",".join(o.strip() for o in (b["options"] or "").split(",") if o.strip()) or None, b["id"]))
                conn.execute("""UPDATE extra SET item=?,aisle=?,person_id=?,recurring=?,amount=?,unit=?
                                WHERE id=?""",
                             (b["item"], b.get("aisle", "Household"), b.get("person_id"),
                              int(b.get("recurring", 0)), float(b.get("amount") or 1),
                              b.get("unit", "unit"), b["id"]))
                eid = b["id"]
                if "adults_only" in b:
                    conn.execute("UPDATE extra SET adults_only=? WHERE id=?", (int(b["adults_only"]), eid))
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
                if added_to_week:
                    log_extra(conn, b.get("by"), b["item"], b["week_id"], "added")
            conn.commit()
            return self.send_json({"id": eid, "addedToWeek": added_to_week,
                                   "alreadyOnList": bool(b.get("week_id")) and not added_to_week
                                                    and not int(b.get("recurring", 0))})

        if path in ("/api/extra-request", "/api/extra-request/set") and (left := extras_timeout_left(conn, self.me["id"])):
            return self.send_json({"error": f"You're on a short break from asking for extras. Try again in {left} minute{'s' if left != 1 else ''}."}, 403)

        if path == "/api/extra-request":
            if extras_blocked(conn, self.me):
                return self.send_json({"error": "Turn on notifications first (Settings → Notifications)."}, 403)
            # Anyone can ask — kids included. It never touches the real
            # shopping list on its own; a parent has to approve it first.
            item = (b.get("item") or "").strip()
            if not item:
                return self.send_json({"error": "Needs a name."}, 400)
            rid = conn.execute("""INSERT INTO extra_request(person_id,item,amount,unit,aisle,week_id)
                            VALUES (?,?,?,?,?,?)""",
                         (b["person_id"], item, float(b.get("amount") or 1),
                          b.get("unit") or "unit", b.get("aisle") or "Household", b["week_id"]))
            log_extra(conn, b["person_id"], item, b["week_id"], "asked for")
            conn.commit()
            notice = flood_check(conn, db, b["person_id"], b["week_id"])
            if not notice or notice["level"] < 4:  # a reset request is gone, so don't ping about it
                notify_extra_ask(conn, b["person_id"], item, rid.lastrowid)
            return self.send_json({"ok": True, "notice": notice})

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
                n = max(1, int(req["amount"] or 1)) if existing else 1
                conn.execute("""INSERT INTO week_extra(week_id,extra_id,qty) VALUES (?,?,?)
                                ON CONFLICT(week_id,extra_id) DO UPDATE SET qty=MAX(qty, excluded.qty)""",
                             (req["week_id"], eid, n))
                conn.execute("""UPDATE extra_request SET status='approved',
                                resolved_at=datetime('now'), resolved_by=? WHERE id=?""",
                             (b["resolver_id"], b["id"]))
                log_extra(conn, req["person_id"], req["item"], req["week_id"], "request approved")
            else:
                log_extra(conn, req["person_id"], req["item"], req["week_id"], "request declined")
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

        if path.startswith("/api/pricing/") and not is_parent(conn, b.get("actor_id")):
            return self.send_json({"error": "Only a parent can change prices."}, 403)

        if path == "/api/pricing/link":
            p = b["product"]
            if not conn.execute("SELECT 1 FROM price_product WHERE item_key=? AND sku=?",
                                (b["key"], p["sku"])).fetchone():
                conn.execute("""INSERT INTO price_product(item_key,sku,name,brand,size,price,category,store,variant_code,checked_at)
                                VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))""",
                             (b["key"], p["sku"], p["name"], p.get("brand", ""), p.get("size", ""),
                              float(p.get("price") or 0), p.get("category", ""), p.get("store") or "aldi",
                              b.get("variant") or None))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/compare/run":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Parents only."}, 403)
            if not morrisons_enabled(conn):
                return self.send_json({"error": "Switch on Morrisons prices in Settings first."}, 403)
            conn.execute("""CREATE TABLE IF NOT EXISTS store_match (
                aldi_sku TEXT, store TEXT, sku TEXT, name TEXT, size TEXT, price REAL, score REAL,
                rank INTEGER, checked_at TEXT, PRIMARY KEY (aldi_sku, store, rank))""")
            conn.commit()
            try:
                conn.execute("ALTER TABLE store_match ADD COLUMN picked INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass
            # Items searched with no match have no store_match rows; remember them
            # here too, or "skip already compared" keeps picking the same one.
            conn.execute("""CREATE TABLE IF NOT EXISTS compare_checked (
                aldi_sku TEXT, store TEXT, checked_at TEXT, PRIMARY KEY (aldi_sku, store))""")
            src = rows(conn.execute("""SELECT item_key, sku, name, size, price, category, brand FROM price_product
                                       WHERE COALESCE(store,'aldi')='aldi' AND missing=0
                                       AND (? = 0 OR (sku NOT IN (SELECT aldi_sku FROM store_match)
                                                      AND sku NOT IN (SELECT aldi_sku FROM compare_checked WHERE store='morrisons')))
                                       GROUP BY item_key ORDER BY item_key LIMIT ? OFFSET ?""",
                                    (1 if b.get("only_new") else 0, int(b.get("limit", 5)), int(b.get("offset", 0)))))
            out = []
            fresh = bool(b.get("fresh"))
            for a in src:
                picked = conn.execute("SELECT 1 FROM store_match WHERE aldi_sku=? AND store='morrisons' AND picked=1",
                                      (a["sku"],)).fetchone()
                saved = [] if (fresh and not picked) else rows(conn.execute(
                    "SELECT sku, name, size, price, score, picked FROM store_match WHERE aldi_sku=? AND store='morrisons' ORDER BY rank",
                    (a["sku"],)))
                if saved:
                    for c in saved:
                        c["unit"], c["unitOf"] = unit_price(c)
                    au, auu = unit_price(a)
                    out.append({"item": a["item_key"], "query": "saved", "aldi": {**a, "unit": au, "unitOf": auu}, "matches": saved})
                    continue
                qs = match_queries(a["name"]); q = " | ".join(qs)
                pool = {}
                try:
                    for one in qs:
                        for c in morrisons_search(one):
                            pool.setdefault(c["sku"], c)
                except Exception as e:
                    blocked = getattr(e, "code", None) in (403, 429)
                    out.append({"item": a["item_key"], "aldi": a,
                                "error": "Morrisons is refusing requests for now — try again later" if blocked else "Morrisons didn't answer"})
                    if blocked:
                        break
                    continue
                ranked = sorted(({**c, "score": match_score(a, c)} for c in pool.values()), key=lambda c: -c["score"])[:5]
                conn.execute("DELETE FROM store_match WHERE aldi_sku=? AND store='morrisons'", (a["sku"],))
                conn.execute("""INSERT OR REPLACE INTO compare_checked(aldi_sku,store,checked_at)
                                VALUES (?,'morrisons',datetime('now'))""", (a["sku"],))
                for i, c in enumerate(ranked):
                    conn.execute("""INSERT INTO store_match(aldi_sku,store,sku,name,size,price,score,rank,checked_at)
                                    VALUES (?,?,?,?,?,?,?,?,datetime('now'))""",
                                 (a["sku"], "morrisons", c["sku"], c["name"], c["size"], c["price"], c["score"], i))
                conn.commit()
                au, auu = unit_price(a)
                for c in ranked:
                    c["unit"], c["unitOf"] = unit_price(c)
                out.append({"item": a["item_key"], "query": q, "aldi": {**a, "unit": au, "unitOf": auu}, "matches": ranked})
            conn.commit()
            return self.send_json({"rows": out})

        if path == "/api/receipt/parse":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Parents only."}, 403)
            lines, total, count = parse_receipt(b.get("text", ""))
            if not lines:
                return self.send_json({"error": "Couldn't find any item lines. Paste the text straight from the receipt."}, 400)
            lines = classify_receipt(conn, b["week_id"], lines)
            s_ = round(sum(l["amount"] for l in lines), 2)
            n_ = sum(l["qty"] for l in lines if not l.get("deposit"))
            return self.send_json({"lines": lines, "total": total, "count": count, "sum": s_, "items": n_,
                                   "listItems": receipt_list_items(conn, b["week_id"])})

        if path == "/api/receipt/save":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Parents only."}, 403)
            receipt_tables(conn)
            wid, lines = b["week_id"], b["lines"]
            total = float(b.get("total") or sum(l["amount"] for l in lines))
            conn.execute("DELETE FROM receipt_line WHERE receipt_id IN (SELECT id FROM receipt WHERE week_id=?)", (wid,))
            conn.execute("DELETE FROM receipt WHERE week_id=?", (wid,))
            rid = conn.execute("INSERT INTO receipt(week_id,total) VALUES (?,?)", (wid, total)).lastrowid
            for l in lines:
                if l["kind"] == "regular" and l.get("decided") and not l.get("once") and not l.get("item_key"):
                    # Becomes a new regular item below: tie this line to it, so what was paid prices it.
                    l["item_key"] = item_key(l.get("name") or l["text"].title())
                conn.execute("INSERT INTO receipt_line VALUES (?,?,?,?,?,?,?)",
                             (rid, l["code"], l["text"], l["qty"], l["amount"], l.get("item_key"), l["kind"]))
                if l.get("decided") and not l.get("once"):  # remember the choice for this product next time
                    conn.execute("""INSERT INTO receipt_code(code,item_key,kind,name) VALUES (?,?,?,?)
                                    ON CONFLICT(code) DO UPDATE SET kind=excluded.kind,
                                    item_key=COALESCE(excluded.item_key, receipt_code.item_key), name=excluded.name""",
                                 (l["code"], l.get("item_key"), l["kind"] if l["kind"] != "regular" else "extra", l.get("name")))
                if l["kind"] == "regular" and l.get("decided") and not l.get("once"):
                    nm = l.get("name") or l["text"].title()
                    ex = conn.execute("SELECT id FROM extra WHERE item=? COLLATE NOCASE", (nm,)).fetchone()
                    if ex:
                        conn.execute("UPDATE extra SET recurring=1 WHERE id=?", (ex["id"],))
                    else:
                        conn.execute("INSERT INTO extra(item,aisle,recurring,amount,unit) VALUES (?,?,1,1,'unit')",
                                     (nm, "Cupboard"))
            conn.execute("UPDATE week SET shop_total=? WHERE id=?", (round(total, 2), wid))
            conn.commit()
            threading.Thread(target=auto_link_receipt_products, args=(db,), daemon=True).start()
            return self.send_json({"ok": True})

        if path == "/api/receipt/summary":
            receipt_tables(conn)
            r = conn.execute("SELECT id, total FROM receipt WHERE week_id=?", (b["week_id"],)).fetchone()
            if not r:
                return self.send_json({"summary": None})
            lines = rows(conn.execute("""SELECT text, qty, amount, item_key, kind FROM receipt_line
                                         WHERE receipt_id=? ORDER BY amount DESC""", (r["id"],)))
            po = pick_one_keys(conn)
            by = {}
            for l in lines:
                if l["item_key"] in po:
                    l["kind"] = "meal"  # breakfast counts with the meals, however it was saved
                by[l["kind"]] = round(by.get(l["kind"], 0) + l["amount"], 2)
            return self.send_json({"summary": {"total": r["total"], "by": by, "lines": lines}})

        if path == "/api/compare/pick":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Parents only."}, 403)
            p = b.get("product")
            if p and not conn.execute("SELECT 1 FROM store_match WHERE aldi_sku=? AND store='morrisons' AND sku=?",
                                      (b["aldi_sku"], b["sku"])).fetchone():
                conn.execute("""INSERT INTO store_match(aldi_sku,store,sku,name,size,price,score,rank,checked_at)
                                VALUES (?,?,?,?,?,?,?,?,datetime('now'))""",
                             (b["aldi_sku"], "morrisons", b["sku"], p["name"], p.get("size", ""), float(p.get("price") or 0), None, 999))
            if b.get("query"):  # what a person typed to find it: training data for better matching rules
                conn.execute("""CREATE TABLE IF NOT EXISTS manual_find (aldi_sku TEXT, store TEXT, query TEXT, sku TEXT,
                                name TEXT, created_at TEXT DEFAULT (datetime('now')))""")
                conn.execute("INSERT INTO manual_find(aldi_sku,store,query,sku,name) VALUES (?,?,?,?,?)",
                             (b["aldi_sku"], "morrisons", b["query"], b["sku"], (p or {}).get("name", "")))
            ms = rows(conn.execute("SELECT sku FROM store_match WHERE aldi_sku=? AND store='morrisons' ORDER BY rank", (b["aldi_sku"],)))
            order = [b["sku"]] + [m["sku"] for m in ms if m["sku"] != b["sku"]]
            conn.execute("UPDATE store_match SET rank=rank+100, picked=0 WHERE aldi_sku=? AND store='morrisons'", (b["aldi_sku"],))
            for i, sku in enumerate(order):
                conn.execute("UPDATE store_match SET rank=?, picked=? WHERE aldi_sku=? AND store='morrisons' AND sku=?",
                             (i, 1 if i == 0 else 0, b["aldi_sku"], sku))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/pricing/ingredient":
            conn.execute("UPDATE meal_ingredient SET amount=?, unit=? WHERE id=?",
                         (float(b["amount"]), b["unit"], b["id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/pricing/merge":
            # Fold one item name into another everywhere it's used: meal
            # ingredients, extras (combining week lists), and Aldi links.
            src, dst = item_key(b["from"]), item_key(b["to"])
            if not src or not dst or src == dst:
                return self.send_json({"error": "Pick two different items."}, 400)
            n = 0
            for r in rows(conn.execute("SELECT id, item FROM meal_ingredient")):
                if item_key(r["item"]) == src:
                    conn.execute("UPDATE meal_ingredient SET item=? WHERE id=?", (dst, r["id"])); n += 1
            target = next((r for r in rows(conn.execute("SELECT id, item FROM extra")) if item_key(r["item"]) == dst), None)
            for r in rows(conn.execute("SELECT id, item FROM extra")):
                if item_key(r["item"]) != src:
                    continue
                if target:
                    conn.execute("""INSERT OR IGNORE INTO week_extra(week_id,extra_id,qty)
                                    SELECT week_id, ?, qty FROM week_extra WHERE extra_id=?""", (target["id"], r["id"]))
                    conn.execute("DELETE FROM week_extra WHERE extra_id=?", (r["id"],))
                    conn.execute("DELETE FROM extra WHERE id=?", (r["id"],))
                else:
                    conn.execute("UPDATE extra SET item=? WHERE id=?", (dst, r["id"]))
                n += 1
            conn.execute("UPDATE OR IGNORE price_product SET item_key=? WHERE item_key=?", (dst, src))
            conn.execute("DELETE FROM price_product WHERE item_key=?", (src,))
            conn.commit()
            return self.send_json({"ok": True, "changed": n})

        if path == "/api/pricing/unlink":
            conn.execute("DELETE FROM price_product WHERE id=?", (b["id"],))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/pricing/refresh":
            cache_clear()
            changed, missing, failed = [], [], 0
            skus = [r["sku"] for r in rows(conn.execute(
                "SELECT DISTINCT sku FROM price_product WHERE COALESCE(store,'aldi')='aldi'"))]
            if morrisons_enabled(conn):
                for r in rows(conn.execute("SELECT id, sku, name, price FROM price_product WHERE store='morrisons'")):
                    try:
                        hit = next((x for x in morrisons_search(r["name"]) if x["sku"] == r["sku"]), None)
                    except Exception:
                        failed += 1
                        continue
                    if not hit:
                        conn.execute("UPDATE price_product SET missing=1, checked_at=datetime('now') WHERE id=?", (r["id"],))
                        missing.append(r["sku"]); continue
                    if abs((r["price"] or 0) - hit["price"]) > 0.001:
                        changed.append({"name": r["name"], "old": r["price"], "new": hit["price"]})
                    conn.execute("UPDATE price_product SET price=?, size=?, missing=0, checked_at=datetime('now') WHERE id=?",
                                 (hit["price"], hit["size"], r["id"]))
            for sku in skus:
                try:
                    d = aldi_get(f"/v2/products/{urllib.parse.quote(sku)}?currency=GBP&serviceType=walk-in")["data"]
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        conn.execute("UPDATE price_product SET missing=1, checked_at=datetime('now') WHERE sku=?", (sku,))
                        missing.append(sku)
                    else:
                        failed += 1
                    continue
                except Exception:
                    failed += 1
                    continue
                t = aldi_trim(d)
                for r in rows(conn.execute("SELECT id, name, price FROM price_product WHERE sku=?", (sku,))):
                    if abs((r["price"] or 0) - t["price"]) > 0.001:
                        changed.append({"name": r["name"], "old": r["price"], "new": t["price"]})
                conn.execute("""UPDATE price_product SET price=?, size=?, name=?, missing=0,
                                checked_at=datetime('now') WHERE sku=?""",
                             (t["price"], t["size"], t["name"], sku))
            conn.commit()
            names = {r["sku"]: r["name"] for r in rows(conn.execute("SELECT sku, name FROM price_product"))}
            return self.send_json({"checked": len(skus), "changed": changed,
                                   "missing": [names.get(s, s) for s in missing], "failed": failed})

        if path == "/api/extra-request/set":
            if extras_blocked(conn, self.me):
                return self.send_json({"error": "Turn on notifications first (Settings → Notifications)."}, 403)
            # Kids use the same +/- as parents, but it only ever changes their
            # own pending request (max 3) — a parent still approves it.
            ex = conn.execute("SELECT * FROM extra WHERE id=?", (b["extra_id"],)).fetchone()
            if not ex:
                return self.send_json({"error": "Not a real item."}, 400)
            qty = max(0, min(3, int(b.get("qty", 0))))
            pend = conn.execute("""SELECT id FROM extra_request WHERE person_id=? AND week_id=?
                                   AND item=? COLLATE NOCASE AND status='pending'""",
                                (b["person_id"], b["week_id"], ex["item"])).fetchone()
            if pend and qty == 0:
                conn.execute("DELETE FROM extra_request WHERE id=?", (pend["id"],))
            elif pend:
                conn.execute("UPDATE extra_request SET amount=? WHERE id=?", (qty, pend["id"]))
            elif qty:
                rid = conn.execute("""INSERT INTO extra_request(person_id,item,amount,unit,aisle,week_id)
                                VALUES (?,?,?,?,?,?)""",
                             (b["person_id"], ex["item"], qty, ex["unit"], ex["aisle"], b["week_id"]))
            log_extra(conn, b["person_id"], ex["item"], b["week_id"], f"asked for {qty}" if qty else "cancelled ask")
            conn.commit()
            notice = None
            if qty and not pend:  # a new ask, not +/- on one that's already waiting
                notice = flood_check(conn, db, b["person_id"], b["week_id"])
                if not notice or notice["level"] < 4:
                    notify_extra_ask(conn, b["person_id"], ex["item"], rid.lastrowid)
            return self.send_json({"ok": True, "qty": 0 if notice and notice["level"] == 4 else qty, "notice": notice})

        if path == "/api/extra/set-qty":
            if not is_parent(conn, b.get("by")):
                return self.send_json({"error": "Ask a grown-up — use the ask button instead."}, 403)
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
            name = (conn.execute("SELECT item FROM extra WHERE id=?", (eid,)).fetchone() or {"item": "?"})["item"]
            log_extra(conn, b.get("by"), name, wid, f"set to {qty}" if qty > 0 else "removed")
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
            OWN_FIELDS = ("theme", "color", "emoji")
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

                if b.get("emoji"):
                    b["emoji"] = str(b["emoji"])[:16]
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
                if not admin:
                    return self.send_json({"error": "Only the household admin can add people."}, 403)
                cur = conn.execute("INSERT INTO person(name,role,is_admin,username) VALUES (?,?,0,?)",
                                   (b["name"], b.get("role", "child"), auth.unique_username(conn, b["name"])))
                pid = cur.lastrowid
            conn.commit()
            p = conn.execute("SELECT * FROM person WHERE id=?", (pid,)).fetchone()
            pd = dict(p)
            pd["has_password"] = bool(pd.get("pw_hash"))
            for k in SECRET_PERSON_FIELDS:
                pd.pop(k, None)
            return self.send_json({"person": pd, "energy": tdee(p)})

        if path == "/api/push/subscribe":
            sub = b.get("sub") or {}
            keys = sub.get("keys") or {}
            if not (sub.get("endpoint") and keys.get("p256dh") and keys.get("auth")):
                return self.send_json({"error": "Bad subscription."}, 400)
            conn.execute("""INSERT INTO push_sub(endpoint,person_id,p256dh,auth) VALUES (?,?,?,?)
                            ON CONFLICT(endpoint) DO UPDATE SET person_id=excluded.person_id,
                            p256dh=excluded.p256dh, auth=excluded.auth""",
                         (sub["endpoint"], b["person_id"], keys["p256dh"], keys["auth"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/push/unsubscribe":
            conn.execute("DELETE FROM push_sub WHERE endpoint=?", (b.get("endpoint"),))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/push/prefs":
            conn.execute("DELETE FROM push_off WHERE person_id=?", (b["person_id"],))
            for k in b.get("off", []):
                if k in push.KINDS:
                    conn.execute("INSERT INTO push_off(person_id,kind) VALUES (?,?)", (b["person_id"], k))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/push/remind":
            # A parent's "nudge now": one person (target_id), or everyone (but them)
            # with no vote in that week yet.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            if b.get("target_id"):
                todo = rows(conn.execute("SELECT id, name FROM person WHERE id=?", (int(b["target_id"]),)))
            else:
                todo = rows(conn.execute("""
                    SELECT p.id, p.name FROM person p WHERE p.is_placeholder=0 AND p.id!=?
                    AND NOT EXISTS (SELECT 1 FROM meal_vote v WHERE v.week_id=? AND v.person_id=p.id)""",
                    (self.me["id"], b["week_id"])))
            subbed = {r["person_id"] for r in conn.execute("SELECT DISTINCT person_id FROM push_sub")}
            push.notify(conn, db, [t["id"] for t in todo], "voting_reminder", "Don't forget to vote 🗳️",
                        "Pick the meals you'd like next week.", "/#/vote")
            return self.send_json({"ok": True,
                                   "names": [t["name"] for t in todo if t["id"] in subbed],
                                   "unreachable": [t["name"] for t in todo if t["id"] not in subbed]})

        if path == "/api/push/nudge-extras":
            # "Anything you want from the shop?" Parents can press it as often as they like;
            # not a kind anyone can switch off, so it always gets through.
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            tid = int(b["target_id"])
            who = conn.execute("SELECT name FROM person WHERE id=?", (tid,)).fetchone()
            n = push.notify(conn, db, [tid], "extras_nudge", "Anything you want from the shop? 🛒",
                            "Add your extras now so they're on the list.", "/#/extras",
                            extra={"tag": f"extras_nudge-{int(__import__('time').time())}"})
            return self.send_json({"ok": True, "name": who["name"] if who else "", "devices": n})

        if path == "/api/push/test":
            n = push.notify(conn, db, [b["person_id"]], "test", "It works 🎉",
                            "Notifications are on for this device.", "/#/settings")
            return self.send_json({"ok": True, "devices": n})

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
            if "vetoes_per_person" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('vetoes_per_person',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             (str(max(0, min(10, int(b["vetoes_per_person"])))),))
            if "morrisons_enabled" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('morrisons_enabled',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             ("1" if int(b["morrisons_enabled"]) else "0",))
            if "push_reminder_hour" in b:
                h = int(b["push_reminder_hour"])
                conn.execute("""INSERT INTO config(key,value) VALUES ('push_reminder_hour',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             (str(h if 0 <= h <= 23 else -1),))
            if "extras_need_push" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('extras_need_push',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             ("1" if int(b["extras_need_push"]) else "0",))
            for k, hi in (("extras_flood_limit", 99), ("extras_flood_timeout_min", 240)):
                if k in b:
                    conn.execute("""INSERT INTO config(key,value) VALUES (?,?)
                                    ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                                 (k, str(max(0, min(hi, int(b[k]))))))
            if "allow_historic_edits" in b:
                conn.execute("""INSERT INTO config(key,value) VALUES ('allow_historic_edits',?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                             ("1" if int(b["allow_historic_edits"]) else "0",))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/redemption/grant":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can redeem rewards."}, 403)
            bal = conn.execute("SELECT COALESCE(SUM(delta),0) b FROM points_ledger WHERE person_id=?",
                               (b["person_id"],)).fetchone()["b"]
            reward = conn.execute("SELECT * FROM reward WHERE id=?", (b["reward_id"],)).fetchone()
            if not reward:
                return self.send_json({"error": "Not a real reward."}, 400)
            if bal < reward["points_cost"]:
                return self.send_json({"error": f"Needs {reward['points_cost']} points, only has {bal}."}, 400)
            conn.execute("""INSERT INTO redemption(person_id,reward_id,status,budget_gbp,note,resolved_at,resolved_by)
                            VALUES (?,?,'approved',?,?,datetime('now'),?)""",
                         (b["person_id"], b["reward_id"], b.get("budget_gbp"), b.get("note", ""), b["actor_id"]))
            conn.execute("INSERT INTO points_ledger(person_id,delta,reason) VALUES (?,?,?)",
                         (b["person_id"], -reward["points_cost"],
                          f"redeemed: {reward['name']}" + (f" — {b['note']}" if b.get("note") else "")))
            if b.get("swap_week_id") and b.get("swap_meal_id") is not None and b.get("swap_dow") is not None:
                conn.execute("INSERT OR IGNORE INTO week_day(week_id,dow) VALUES (?,?)",
                             (b["swap_week_id"], b["swap_dow"]))
                conn.execute("UPDATE week_day SET meal_id=? WHERE week_id=? AND dow=?",
                             (b["swap_meal_id"], b["swap_week_id"], b["swap_dow"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/redemption/request":
            return self.send_json({"error": "Ask a parent — they redeem rewards now."}, 403)
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

        if path == "/api/config/points-mode":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            conn.execute("""INSERT INTO config(key,value) VALUES ('points_mode',?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                         ("chosen" if b.get("mode") == "chosen" else "all",))
            sync_healthy_points(conn)  # past weeks follow the new rule straight away
            return self.send_json({"ok": True})

        if path == "/api/config/healthy-tags":
            if not is_admin(conn, b.get("admin_id")):
                return self.send_json({"error": "Admins only."}, 403)
            conn.execute("""INSERT INTO config(key,value) VALUES ('healthy_tags',?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                         (",".join(b.get("tags", [])),))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/meal-photo":
            if not is_parent(conn, b.get("actor_id")):
                return self.send_json({"error": "Only a parent can change meal photos."}, 403)
            if not b.get("data"):
                conn.execute("DELETE FROM meal_photo WHERE meal_id=?", (b["meal_id"],))
            else:
                head, data = b["data"].split(",", 1)
                mime = head[5:].split(";")[0]
                if mime not in ("image/jpeg", "image/png", "image/webp"):
                    return self.send_json({"error": "That isn't a photo."}, 400)
                conn.execute("INSERT OR REPLACE INTO meal_photo(meal_id,mime,data) VALUES (?,?,?)",
                             (b["meal_id"], mime, base64.b64decode(data)))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person/reset-votes":
            # A quick undo for the real risk of shared PINs: a sibling logs
            # in as someone else and votes spitefully to wind them up, or
            # worse, vetoes something out of pure mischief (a veto blocks the
            # whole household, not just that one person's own picks). Clears
            # both, for the currently-open vote week only — not a general
            # history editor, just a fast "put it back how it was."
            if not is_parent(conn, b.get("admin_id")):
                return self.send_json({"error": "Only a parent can do that."}, 403)
            conn.execute("DELETE FROM meal_vote WHERE week_id=? AND person_id=?",
                         (b["week_id"], b["id"]))
            conn.execute("DELETE FROM veto WHERE week_id=? AND person_id=?",
                         (b["week_id"], b["id"]))
            conn.commit()
            return self.send_json({"ok": True})

        if path == "/api/person/set-password":
            # A temporary password they must change at next sign-in. Parents
            # can do it for children, the admin for anyone.
            target = conn.execute("SELECT * FROM person WHERE id=?", (b["id"],)).fetchone()
            if not target:
                return self.send_json({"error": "No such person."}, 404)
            if not (self.me["is_admin"] or (self.me["role"] == "parent" and target["role"] != "parent")):
                return self.send_json({"error": "You can't set that person's password."}, 403)
            prob = auth.password_problem(b.get("password"))
            if prob:
                return self.send_json({"error": prob}, 400)
            auth.set_password(conn, target["id"], b["password"], target["id"] != self.me["id"])
            return self.send_json({"ok": True, "username": target["username"]})

        if path == "/api/person/username":
            if not self.me["is_admin"]:
                return self.send_json({"error": "Admins only."}, 403)
            u = auth.clean_username(b.get("username"))
            if not u:
                return self.send_json({"error": "Letters and numbers only."}, 400)
            if conn.execute("SELECT 1 FROM person WHERE username=? AND id!=?", (u, b["id"])).fetchone():
                return self.send_json({"error": "Someone already has that username."}, 400)
            conn.execute("UPDATE person SET username=? WHERE id=?", (u, b["id"]))
            conn.commit()
            return self.send_json({"ok": True, "username": u})

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


def make_backup_bytes():
    """A complete, consistent copy of the database (everything: passwords, sign-ins, push keys),
    taken with SQLite's own backup so it's safe while the app is running."""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "backup.db")
        src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(path)
        try:
            src.backup(dst)
        finally:
            dst.close(); src.close()
        with open(path, "rb") as f:
            return f.read()


def restore_from_bytes(data):
    """Replace the whole database with a backup made by make_backup_bytes().
    Checks it first, and keeps a copy of what it replaces beside the database."""
    import tempfile, time as _t
    if not data.startswith(b"SQLite format 3\x00"):
        raise ValueError("That isn't a Meal Planner backup file.")
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "restore.db")
        with open(path, "wb") as f:
            f.write(data)
        chk = sqlite3.connect(path)
        try:
            if chk.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("That backup file is damaged.")
            names = {r[0] for r in chk.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"person", "week", "meal"} <= names:
                raise ValueError("That isn't a Meal Planner backup file.")
            keep = os.path.join(os.path.dirname(DB_PATH), f"before-restore-{_t.strftime('%Y%m%d-%H%M%S')}.db")
            cur = sqlite3.connect(DB_PATH)
            try:
                with sqlite3.connect(keep) as kc:
                    cur.backup(kc)
                cur.close(); cur = sqlite3.connect(DB_PATH, timeout=30)
                chk.backup(cur)  # overwrite the live database in place
            finally:
                cur.close()
        finally:
            chk.close()
    init_db()  # an older backup gets brought up to date
    return keep


def cli_set_password(username):
    """Recovery / first-time setup from the server's own shell:
    python3 server.py set-password <username>"""
    import getpass, secrets
    with db() as conn:
        row = conn.execute("SELECT id, name FROM person WHERE username=?",
                           (auth.clean_username(username),)).fetchone()
        if not row:
            names = ", ".join(r["username"] for r in conn.execute(
                "SELECT username FROM person WHERE username IS NOT NULL ORDER BY id"))
            raise SystemExit(f"No user {username!r}. Usernames: {names}")
        pw = getpass.getpass("New password (blank = generate a temporary one): ")
        temporary = not pw
        if temporary:
            pw = secrets.token_urlsafe(9)
            print(f"Temporary password for {row['name']}: {pw}  (they'll choose their own at sign-in)")
        elif auth.password_problem(pw):
            raise SystemExit(auth.password_problem(pw))
        auth.set_password(conn, row["id"], pw, must_change=temporary)
        print("Done. Existing sign-ins for that person have been ended.")


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 3 and sys.argv[1] == "restore":
        init_db()
        with open(sys.argv[2], "rb") as f:
            print(f"Restored. The previous database was kept as {restore_from_bytes(f.read())}")
        raise SystemExit
    if len(sys.argv) >= 3 and sys.argv[1] == "set-password":
        init_db()
        cli_set_password(sys.argv[2])
        raise SystemExit
    init_db()
    push.reminder_loop(db)
    print(f"meal planner on http://0.0.0.0:{PORT}  (db: {DB_PATH})"
          + ("" if push.AVAILABLE else "  [push off: pip install cryptography to enable]"))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
