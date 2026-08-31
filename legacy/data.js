// Weekly meal plan + protein targets.
// This file is the single source of truth — the shopping list and all
// protein maths are derived from it. Edit here, nothing else.

const CONFIG = {
  targetMin: 130,
  targetMax: 150,
  familySize: 5,
};

// Which aisle each item lives in, so the shopping list is walk-the-store order.
const AISLES = ["Meat & Fish", "Fresh Produce", "Dairy & Chilled", "Bakery", "Frozen", "Cupboard"];

const AISLE_OF = {
  "Chicken breast fillets": "Meat & Fish",
  "5% beef mince": "Meat & Fish",
  "Beef burgers": "Meat & Fish",
  "Bacon": "Meat & Fish",
  "Salmon fillets": "Meat & Fish",
  "Cooked prawns": "Meat & Fish",

  "Tomatoes": "Fresh Produce",
  "Lettuce": "Fresh Produce",
  "Cucumber": "Fresh Produce",
  "Beetroot": "Fresh Produce",
  "Beansprouts": "Fresh Produce",
  "Stir-fry veg": "Fresh Produce",

  "Eggs": "Dairy & Chilled",
  "Grated cheese": "Dairy & Chilled",
  "Cheese slices": "Dairy & Chilled",
  "Mozzarella": "Dairy & Chilled",
  "Coleslaw": "Dairy & Chilled",
  "Protein pudding": "Dairy & Chilled",
  "Fresh noodles": "Dairy & Chilled",

  "Naan bread": "Bakery",
  "Brioche buns": "Bakery",
  "Sliced bread": "Bakery",

  "Chicken nuggets": "Frozen",
  "Fries": "Frozen",

  "Basmati rice": "Cupboard",
  "Spaghetti": "Cupboard",
  "Popadoms": "Cupboard",
  "Korma sauce": "Cupboard",
  "Bolognese sauce": "Cupboard",
  "Pad Thai kit": "Cupboard",
  "BBQ sauce": "Cupboard",
  "Marie Rose sauce": "Cupboard",
  "Tinned tuna": "Cupboard",
  "Whey protein": "Cupboard",
};

// Daily routine. Base items are assumed eaten unless you untick them;
// shakes are opt-in top-ups.
const ROUTINE = {
  preGym:  { key: "preGym",  label: "Egg-in-a-basket (2 eggs)", when: "pre-gym",  protein: 15, trainingOnly: true,  defaultOn: true },
  omelette:{ key: "omelette",label: "3-egg omelette + tomato",  when: "11am",     protein: 19, trainingOnly: false, defaultOn: true },
  postGym: { key: "postGym", label: "Whey shake",               when: "post-gym", protein: 24, trainingOnly: true,  defaultOn: true },
  shake1:  { key: "shake1",  label: "Top-up shake",             when: "flexible", protein: 24, trainingOnly: false, defaultOn: false },
  shake2:  { key: "shake2",  label: "Top-up shake",             when: "flexible", protein: 24, trainingOnly: false, defaultOn: false },
};

// carb: "swap" = bread/pasta on the table, take the rice/potato option instead.
//       "ok"   = nothing that triggers the bloating.
const WEEK = [
  {
    day: "Monday", short: "Mon",
    meal: "Chicken Curry",
    carb: "swap",
    carbNote: "Naan → have extra basmati rice instead.",
    plate: [
      { label: "200g chicken breast", protein: 46 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "Chicken breast fillets", amount: 900, unit: "g" },
      { item: "Basmati rice", amount: 500, unit: "g" },
      { item: "Korma sauce", amount: 1, unit: "pack" },
      { item: "Naan bread", amount: 1, unit: "pack" },
      { item: "Popadoms", amount: 1, unit: "pack" },
    ],
  },
  {
    day: "Tuesday", short: "Tue",
    meal: "Burgers",
    carb: "swap",
    carbNote: "Brioche bun → go bunless, have the extra patty instead.",
    plate: [
      { label: "2 beef burgers (no bun)", protein: 40 },
      { label: "1 cheese slice", protein: 5 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "Beef burgers", amount: 2, unit: "pack" },
      { item: "Brioche buns", amount: 1, unit: "pack" },
      { item: "Cheese slices", amount: 1, unit: "pack" },
      { item: "Chicken nuggets", amount: 1, unit: "bag" },
      { item: "Fries", amount: 1, unit: "bag" },
      { item: "Tomatoes", amount: 4, unit: "unit" },
      { item: "Lettuce", amount: 1, unit: "unit" },
      { item: "Cucumber", amount: 1, unit: "unit" },
    ],
  },
  {
    day: "Wednesday", short: "Wed",
    meal: "Spag Bol",
    carb: "swap",
    carbNote: "Spaghetti is the worst one for you → have the sauce over rice.",
    plate: [
      { label: "200g 5% mince", protein: 40 },
      { label: "30g grated cheese", protein: 7 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "5% beef mince", amount: 1000, unit: "g" },
      { item: "Bolognese sauce", amount: 1, unit: "jar" },
      { item: "Spaghetti", amount: 1, unit: "pack" },
      { item: "Grated cheese", amount: 250, unit: "g" },
      { item: "Basmati rice", amount: 250, unit: "g" },
    ],
  },
  {
    day: "Thursday", short: "Thu",
    meal: "Pad Thai",
    carb: "ok",
    carbNote: "Rice noodles — fine for you.",
    plate: [
      { label: "200g chicken breast", protein: 46 },
    ],
    boost: { label: "Tin of tuna on the side", protein: 24, buy: "Tinned tuna" },
    shopping: [
      { item: "Chicken breast fillets", amount: 800, unit: "g" },
      { item: "Pad Thai kit", amount: 1, unit: "pack" },
      { item: "Beansprouts", amount: 1, unit: "pack" },
      { item: "Stir-fry veg", amount: 1, unit: "pack" },
    ],
  },
  {
    day: "Friday", short: "Fri",
    meal: "Stir Fry",
    carb: "swap",
    carbNote: "Fresh noodles are wheat → have rice on your plate.",
    plate: [
      { label: "200g chicken breast", protein: 46 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "Chicken breast fillets", amount: 800, unit: "g" },
      { item: "Fresh noodles", amount: 2, unit: "pack" },
      { item: "Stir-fry veg", amount: 2, unit: "pack" },
      { item: "Basmati rice", amount: 250, unit: "g" },
    ],
  },
  {
    day: "Saturday", short: "Sat",
    meal: "Hunters Chicken",
    carb: "ok",
    carbNote: "Fries are potato — fine.",
    plate: [
      { label: "200g chicken breast", protein: 46 },
      { label: "2 rashers bacon", protein: 10 },
      { label: "1 cheese slice", protein: 7 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "Chicken breast fillets", amount: 800, unit: "g" },
      { item: "Bacon", amount: 1, unit: "pack" },
      { item: "BBQ sauce", amount: 1, unit: "bottle" },
      { item: "Fries", amount: 1, unit: "bag" },
    ],
  },
  {
    day: "Sunday", short: "Sun",
    meal: "Salmon Salad",
    carb: "ok",
    carbNote: "No bread or pasta — your easiest day.",
    plate: [
      { label: "150g salmon", protein: 31 },
      { label: "50g mozzarella", protein: 9 },
      { label: "2 boiled eggs", protein: 13 },
    ],
    boost: { label: "Aldi protein pudding", protein: 20, buy: "Protein pudding" },
    shopping: [
      { item: "Salmon fillets", amount: 2, unit: "pack" },
      { item: "Cooked prawns", amount: 1, unit: "pack" },
      { item: "Marie Rose sauce", amount: 1, unit: "jar" },
      { item: "Mozzarella", amount: 1, unit: "pack" },
      { item: "Coleslaw", amount: 1, unit: "tub" },
      { item: "Beetroot", amount: 1, unit: "pack" },
      { item: "Lettuce", amount: 1, unit: "unit" },
      { item: "Cucumber", amount: 1, unit: "unit" },
      { item: "Tomatoes", amount: 4, unit: "unit" },
    ],
  },
];

// Pack sizes, shown as a hint so you know how many to grab off the shelf.
const PACK_HINT = {
  "Eggs": "boxes of 15",
  "Chicken breast fillets": "1kg packs",
  "5% beef mince": "500g packs",
  "Tinned tuna": "sold in 4-packs",
  "Whey protein": "1kg tub ≈ 33 shakes",
};
