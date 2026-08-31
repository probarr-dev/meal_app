#!/usr/bin/env python3
"""Seed the DB with the current meal library. Safe to re-run: skips if people exist."""

import sys
from datetime import date

from server import db, init_db, week_start_of

# name, tracked, role, protein_min, protein_max
# kcal target is deliberately NOT seeded — it's calculated from real body stats
# entered in Settings, rather than guessed here.
PEOPLE = [
    ("Martin", 1, "parent", 130, 150),
    ("Ethan",  0, "child",  None, None),
    ("Aubree", 0, "child",  None, None),
    ("Gabby",  0, "child",  None, None),
]

ROUTINE = [
    # key, label, when, kcal, P, C, F, training_only, default_on, sort, eggs, shakes
    ("preGym",   "Egg-in-a-basket (2 eggs)", "pre-gym",  250, 15, 16, 14, 1, 1, 10, 2, 0),
    ("omelette", "3-egg omelette + tomato",  "11am",     240, 19,  3, 17, 0, 1, 20, 3, 0),
    ("postGym",  "Whey shake",               "post-gym", 120, 24,  3,  2, 1, 1, 30, 0, 1),
    # Third eating occasion. Oats-based deliberately — tolerated, unlike bread/pasta.
    ("afternoon", "Oats, whey, peanut butter + banana", "~4pm", 800, 45, 85, 22, 0, 1, 60, 0, 1),
    ("shake1",   "Top-up shake",             "flexible", 120, 24,  3,  2, 0, 0, 90, 0, 1),
    ("shake2",   "Top-up shake",             "flexible", 120, 24,  3,  2, 0, 0, 91, 0, 1),
]

PUDDING = ("Aldi protein pudding", 180, 20, 12, 5, 1)

MEALS = [
    {
        "name": "Chicken Curry", "carb_flag": "swap",
        "note": "Naan → have extra basmati rice instead.",
        "ingredients": [
            ("Chicken breast fillets", 900, "g", "Meat & Fish"),
            ("Basmati rice", 500, "g", "Cupboard"),
            ("Korma sauce", 1, "pack", "Cupboard"),
            ("Naan bread", 1, "pack", "Bakery"),
            ("Popadoms", 1, "pack", "Cupboard"),
        ],
        "portions": [
            ("200g chicken breast", 230, 46, 0, 5, 0),
            ("250g basmati rice", 325, 5, 70, 1, 0),
            PUDDING,
        ],
    },
    {
        "name": "Burgers", "carb_flag": "swap",
        "note": "Brioche bun → go bunless, have the extra patty instead.",
        "ingredients": [
            ("Beef burgers", 2, "pack", "Meat & Fish"),
            ("Brioche buns", 1, "pack", "Bakery"),
            ("Cheese slices", 1, "pack", "Dairy & Chilled"),
            ("Chicken nuggets", 1, "bag", "Frozen"),
            ("Fries", 1, "bag", "Frozen"),
            ("Tomatoes", 4, "unit", "Fresh Produce"),
            ("Lettuce", 1, "unit", "Fresh Produce"),
            ("Cucumber", 1, "unit", "Fresh Produce"),
        ],
        "portions": [
            ("2 beef burgers (no bun)", 560, 40, 2, 44, 0),
            ("1 cheese slice", 60, 5, 1, 5, 0),
            ("150g fries", 250, 4, 35, 10, 0),
            PUDDING,
        ],
    },
    {
        "name": "Spag Bol", "carb_flag": "swap",
        "note": "Spaghetti is the worst one for you → have the sauce over rice.",
        "ingredients": [
            ("5% beef mince", 1000, "g", "Meat & Fish"),
            ("Bolognese sauce", 1, "jar", "Cupboard"),
            ("Spaghetti", 1, "pack", "Cupboard"),
            ("Grated cheese", 250, "g", "Dairy & Chilled"),
            ("Basmati rice", 250, "g", "Cupboard"),
        ],
        "portions": [
            ("200g 5% mince", 250, 40, 0, 10, 0),
            ("30g grated cheese", 120, 7, 1, 10, 0),
            ("250g basmati rice", 325, 5, 70, 1, 0),
            PUDDING,
        ],
    },
    {
        "name": "Pad Thai", "carb_flag": "ok",
        "note": "Rice noodles — fine for you.",
        "ingredients": [
            ("Chicken breast fillets", 800, "g", "Meat & Fish"),
            ("Pad Thai kit", 1, "pack", "Cupboard"),
            ("Beansprouts", 1, "pack", "Fresh Produce"),
            ("Stir-fry veg", 1, "pack", "Fresh Produce"),
        ],
        "portions": [
            ("200g chicken breast", 230, 46, 0, 5, 0),
            ("Rice noodles + sauce", 400, 8, 65, 10, 0),
            ("Tin of tuna on the side", 110, 24, 0, 1, 1),
        ],
    },
    {
        "name": "Stir Fry", "carb_flag": "swap",
        "note": "Fresh noodles are wheat → have rice on your plate.",
        "ingredients": [
            ("Chicken breast fillets", 800, "g", "Meat & Fish"),
            ("Fresh noodles", 2, "pack", "Dairy & Chilled"),
            ("Stir-fry veg", 2, "pack", "Fresh Produce"),
            ("Basmati rice", 250, "g", "Cupboard"),
        ],
        "portions": [
            ("200g chicken breast", 230, 46, 0, 5, 0),
            ("250g basmati rice", 325, 5, 70, 1, 0),
            ("Stir-fry veg + sauce", 120, 3, 15, 5, 0),
            PUDDING,
        ],
    },
    {
        "name": "Hunters Chicken", "carb_flag": "ok",
        "note": "Fries are potato — fine.",
        "ingredients": [
            ("Chicken breast fillets", 800, "g", "Meat & Fish"),
            ("Bacon", 1, "pack", "Meat & Fish"),
            ("BBQ sauce", 1, "bottle", "Cupboard"),
            ("Fries", 1, "bag", "Frozen"),
        ],
        "portions": [
            ("200g chicken breast", 230, 46, 0, 5, 0),
            ("2 rashers bacon", 120, 10, 0, 9, 0),
            ("1 cheese slice", 90, 7, 1, 7, 0),
            ("BBQ sauce", 45, 0, 11, 0, 0),
            ("150g fries", 250, 4, 35, 10, 0),
            PUDDING,
        ],
    },
    {
        "name": "Salmon Salad", "carb_flag": "ok",
        "note": "No bread or pasta — your easiest day.",
        "ingredients": [
            ("Salmon fillets", 2, "pack", "Meat & Fish"),
            ("Cooked prawns", 1, "pack", "Meat & Fish"),
            ("Marie Rose sauce", 1, "jar", "Cupboard"),
            ("Mozzarella", 1, "pack", "Dairy & Chilled"),
            ("Coleslaw", 1, "tub", "Dairy & Chilled"),
            ("Beetroot", 1, "pack", "Fresh Produce"),
            ("Lettuce", 1, "unit", "Fresh Produce"),
            ("Cucumber", 1, "unit", "Fresh Produce"),
            ("Tomatoes", 4, "unit", "Fresh Produce"),
        ],
        "portions": [
            ("150g salmon", 280, 31, 0, 17, 0),
            ("50g mozzarella", 125, 9, 1, 9, 0),
            ("2 boiled eggs", 155, 13, 1, 11, 0),
            ("Salad + coleslaw", 150, 3, 10, 10, 0),
            PUDDING,
        ],
    },
]

# Illustrative: household staples and a per-person request, so the pattern is obvious.
EXTRAS = [
    ("Bleach", "Household", None, 1, 1, "unit"),
    ("Washing powder", "Household", None, 1, 1, "unit"),
    ("Bin bags", "Household", None, 1, 1, "pack"),
    ("Crisps (multipack)", "Snacks", "Aubree", 0, 1, "pack"),
]


def main():
    init_db()
    with db() as conn:
        # Keyed on person, not meal: init_db() seeds a handful of starter
        # meals itself, so a meal count is never zero on a fresh database and
        # this guard used to skip the entire seed — leaving no people at all,
        # which makes the login gate impossible to get past.
        if conn.execute("SELECT COUNT(*) c FROM person").fetchone()["c"]:
            print("household already set up — nothing to do")
            return

        for name, tracked, role, pmin, pmax in PEOPLE:
            conn.execute("""INSERT OR IGNORE INTO person(name,tracked,role,protein_min,protein_max)
                            VALUES (?,?,?,?,?)""", (name, tracked, role, pmin, pmax))

        for r in ROUTINE:
            conn.execute("""INSERT OR IGNORE INTO routine_item
                (key,label,when_txt,kcal,protein,carbs,fat,training_only,default_on,sort,eggs,shakes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", r)

        meal_ids = {}
        for m in MEALS:
            cur = conn.execute("INSERT INTO meal(name,carb_flag,note) VALUES (?,?,?)",
                               (m["name"], m["carb_flag"], m["note"]))
            mid = cur.lastrowid
            meal_ids[m["name"]] = mid
            for item, amount, unit, aisle in m["ingredients"]:
                conn.execute("""INSERT INTO meal_ingredient(meal_id,item,amount,unit,aisle)
                                VALUES (?,?,?,?,?)""", (mid, item, amount, unit, aisle))
            for label, kcal, p, c, f, opt in m["portions"]:
                conn.execute("""INSERT INTO meal_portion(meal_id,label,kcal,protein,carbs,fat,optional)
                                VALUES (?,?,?,?,?,?,?)""", (mid, label, kcal, p, c, f, opt))

        for item, aisle, person, recurring, amount, unit in EXTRAS:
            pid = None
            if person:
                row = conn.execute("SELECT id FROM person WHERE name=?", (person,)).fetchone()
                pid = row["id"] if row else None
            conn.execute("""INSERT INTO extra(item,aisle,person_id,recurring,amount,unit)
                            VALUES (?,?,?,?,?,?)""", (item, aisle, pid, recurring, amount, unit))

        start = week_start_of(conn, date.today())
        cur = conn.execute("INSERT INTO week(start_date) VALUES (?)", (start,))
        wid = cur.lastrowid
        for dow, m in enumerate(MEALS):
            conn.execute("INSERT INTO week_day(week_id,dow,meal_id) VALUES (?,?,?)",
                         (wid, dow, meal_ids[m["name"]]))
        conn.commit()
        print(f"seeded {len(MEALS)} meals, {len(PEOPLE)} people, week starting {start}")


if __name__ == "__main__":
    sys.exit(main())
