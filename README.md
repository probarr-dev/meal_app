# Family Meal Planner

A self-hosted weekly meal planner for a family. Everyone votes on dinners from their own phone,
parents turn the winners into a plan, and the app builds the shopping list, checks the cupboards
first, and estimates what the shop will cost from real supermarket prices. Kids earn points for
voting healthy, which a parent can swap for a treat.

**Python standard library + SQLite. No pip packages, no npm, no build step, no cloud, no AI.**
One file of server code, one of JavaScript, one of CSS — nothing to rot.

<p>
  <img src="docs/screens/01-vote.png" width="24%" alt="Voting on meals">
  <img src="docs/screens/02-plan.png" width="24%" alt="The week's plan">
  <img src="docs/screens/03-shopping.png" width="24%" alt="Shopping list with price estimate">
  <img src="docs/screens/06-notepad.png" width="24%" alt="Notepad theme">
</p>

## How a week works

1. **Vote.** Everyone ticks the meals they want (7 picks each). Parents' votes outrank any number
   of children's votes; children's votes decide the order among meals the parents agree on. Each
   person gets one **veto** — but not on a meal someone has already voted for.
2. **Plan.** A parent finalises the winners and drops each onto a day, lunch or dinner.
3. **Cupboard check.** Before leaving the house, tick off what you've already got.
4. **Shop.** The list is grouped by aisle in your store's order, with a price range per item and
   for the whole shop. It keeps working with no signal and syncs ticks when you're back online.
5. **Lock the list.** Marks the shop done, records what it actually cost, and opens voting for
   next week.

## Features

| | |
|---|---|
| **Voting** | Parent-weighted ranking, one veto each, live "picks left" counter, magic vote links |
| **Plan** | Timeline of the week, lunch and dinner per day, one ⋯ menu per day to change, move or clear |
| **Shopping** | Aisle-ordered, per-store aisle order, cupboard check, offline ticks, lock when done |
| **Extras** | Non-meal items (milk, bin bags). Kids can ask for up to 3 of anything — a parent approves |
| **Prices** | Link each ingredient to one or more Aldi UK products → a price range, whole packs, refreshed on demand |
| **Rewards** | 1 point per healthy meal a child voted for that made the list; parents redeem treats, or swap a day's dinner for a takeaway |
| **Family** | PINs per person, page access per person, per-person themes (plain, fun, notepad), live sync between phones |
| **History** | Past weeks, full points history, and who asked for which extras |

<p>
  <img src="docs/screens/04-extras.png" width="24%" alt="Extras as a child sees them">
  <img src="docs/screens/05-rewards.png" width="24%" alt="Rewards and points history">
</p>
<img src="docs/screens/07-prices-desktop.png" width="98%" alt="Desktop prices page">

## Run it

```bash
python3 seed.py     # first time only: a starter meal library
python3 server.py   # http://localhost:8080
```

The first visit runs a short setup: add yourself, then everyone else from **Settings → Family**.
Use `MEALPLAN_DB=/path/to/mealplan.db` and `PORT=8080` to move the database or port.

Or in Docker:

```bash
docker compose up -d
```

Add it to your phone's home screen for a full-screen app with a bottom tab bar.

## Privacy and the network

- Designed for a home LAN (or a VPN back to it). There's no HTTPS and no real login system — PINs
  are there to stop siblings voting as each other, not to secure it on the open internet.
  **Don't expose it directly to the internet.**
- The server makes **no outbound requests** except to `api.aldi.co.uk`, and only when a parent
  searches for a product or presses *Refresh prices*. Prices are stored locally. That API is Aldi's
  own undocumented one and may change without notice; if it does, prices simply stop updating.

## Data and upgrades

Everything lives in one SQLite file (WAL mode). Schema changes are additive and applied
automatically on start — tables and columns are only ever added, so older versions keep working
against a newer database. Take a copy while it's running with:

```bash
sqlite3 data/mealplan.db ".backup 'mealplan-backup.db'"
```

Settings also has a one-click JSON export of everything except PINs.

*Screenshots use a made-up demo family.*
