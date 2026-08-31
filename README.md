# Family Meal Planner

Self-hosted weekly meal planner + shopping list, with macro tracking for one
person while everyone else just gets fed.

Python stdlib + SQLite. No pip dependencies, no npm, nothing to rot.

## Run locally

```bash
python3 seed.py     # first time only — loads the starting meal library
python3 server.py   # http://localhost:8080
```

## Self-hosting

Runs anywhere Python 3 does — a Raspberry Pi, an LXC, a spare machine on your
LAN. `Dockerfile` / `docker-compose.yml` are included if you'd rather run it
in a container:

```bash
docker compose up -d
```

There's no auth in front of the server beyond each person's own PIN, and no
HTTPS — it's designed to sit on a private LAN, not be exposed to the internet
directly. Put it behind your own reverse proxy if you need remote access.

## The four views

| View | What it's for |
|---|---|
| **Plan** | The week. Pick a meal per day, tick what you actually ate, see macros. |
| **Shopping** | Everything aggregated into one Aldi run, grouped by aisle. Print or copy. |
| **Meals** | The reusable library. Add a meal once, it's available forever. |
| **History** | Every past week. Copy an old one as the starting point for a new one. |

## How it fits together

A **meal** has two independent parts:

- **Ingredients** — the family shop. Quantities for *everyone*, including the
  larger portion for the tracked person. This is what the shopping list sums.
- **My plate** — only what the tracked person eats, with kcal/protein/carbs/fat.
  This is what the macro tracking counts. Nobody else's macros are tracked,
  because nobody else cares.

Mark a plate item **optional** to make it a "boost" — off by default, there to
close a gap when you need it.

**Extras** are non-meal shopping: household goods and per-person requests.
Mark one *recurring* and it lands on every new week automatically (bleach,
washing powder); leave it off for one-offs (crisps someone asked for).

## Food lookups

The meal editor can search **Open Food Facts** for macros — it has UK barcode
coverage including Aldi own-brand, unlike USDA's database. MyFitnessPal has no
public API, so it isn't an option.

Two deliberate choices, given this runs on a privacy-focused network:

- Lookups are **manual only**. Nothing is sent anywhere unless you press Search.
- Results are **cached in SQLite**, so a repeat lookup for the same item never
  leaves your network again.

If a product isn't found, type the macros in by hand — the fields are always there.

## Voting

Each person picks who they are (top-right). No passwords — it's a LAN app for one
household and passwords for children are friction with no threat model behind them.

- **Anonymous**: `person_id` is stored only to stop double-voting and to weight
  parent vs child. It is never returned by the API — verified, no name appears in
  any `/api/votes` response.
- **Parents decide**: ranking is strictly lexicographic — *any* parent vote
  outranks *any* number of children's votes. Children's votes only order meals
  the parents agree on. Three kids voting Burgers loses to one parent voting
  Salmon Salad.

One honest limit: in a small household, vote *counts* can still leak inference
(if only one parent exists and a meal shows a parent vote, you know who). Names
are never shown, but perfect anonymity isn't achievable at this family size.

## Verifying macros

Every macro seeded into the library was **estimated, not measured**. Meals show
`⚠ N unverified macros` until checked. **Verify macros** walks each plate item in
turn: search the real product, give your portion in grams, and it recalculates —
or type the numbers in if Open Food Facts doesn't have it. Verified items survive
later edits to the meal.

## Backups

Everything lives in `data/mealplan.db`. It's a single SQLite file, so the
restic-over-SSH plan already sketched for CT101 covers it — just include this
path. A consistent copy while the server is running:

```bash
sqlite3 data/mealplan.db ".backup '/tmp/mealplan-backup.db'"
```

## Editing the plan itself

There's no config file to edit any more — the meal library, routine, people and
targets all live in the database and are editable from the UI (routine items and
per-person targets are in the `routine_item` / `person` tables if you want to
change them directly for now).

`legacy/` holds the original single-file version this replaced.
