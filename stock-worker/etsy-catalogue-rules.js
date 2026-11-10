export const ETSY_CRAFT_TYPE_PROPERTY_ID = 47626759760;
export const ETSY_CRAFT_TYPE_VALUE_IDS = [559, 562, 743];
export const ETSY_CRAFT_TYPE_VALUES = ["Hat making & hair crafts", "Kids' crafts", 'Sewing'];
export const ETSY_PRIMARY_COLOUR_PROPERTY_ID = 200;

export const ETSY_COLOUR_VALUE_IDS = {
  Beige: 1213,
  Black: 1,
  Blue: 2,
  Bronze: 1216,
  Brown: 3,
  Clear: 1219,
  Copper: 1218,
  Gold: 1214,
  Gray: 5,
  Green: 4,
  Orange: 6,
  Pink: 7,
  Purple: 8,
  Rainbow: 1220,
  Red: 9,
  'Rose gold': 1217,
  Silver: 1215,
  White: 10,
  Yellow: 11,
};

// Broad colour families used for Etsy search attributes, titles, tags and
// materials. These mirror the visible Shopify swatches. When a swatch spans
// two families, the first/dominant family is deliberately used.
const COLOUR_CATEGORIES = {
  'Admiral': 'Blue',
  'Aegean': 'Blue',
  'Aqua green': 'Green',
  'Artichoke': 'Green',
  'Asparagus': 'Green',
  'Black liquorice': 'Black',
  'Blue lagoon': 'Blue',
  'Blush': 'Pink',
  'Bobby dazzler': 'Rainbow',
  'Carnation': 'Pink',
  'Chestnut': 'Brown',
  'Chilli pepper': 'Red',
  'Claret': 'Red',
  'Clear rainbow': 'Rainbow',
  'Comet': 'Gold',
  'Crystal clear': 'Clear',
  'Dark chocolate': 'Brown',
  'Dark silver': 'Silver',
  'Disco dancer': 'Silver',
  'Double denim': 'Blue',
  'Fluoro canary': 'Yellow',
  'Fluoro flamingo': 'Pink',
  'Fluoro tangerine': 'Orange',
  'Forest': 'Green',
  'Fresh air': 'Blue',
  'Geranium': 'Pink',
  'Gunmetal': 'Gray',
  'Hello sailor': 'Blue',
  'Iris': 'Purple',
  'Jet black': 'Black',
  'Lavender': 'Purple',
  'Lipstick': 'Red',
  'Marmalade': 'Orange',
  'Midnight': 'Blue',
  'Nostalgia': 'Brown',
  'Pale heather': 'Purple',
  'Pale peridot': 'Green',
  'Peony': 'Pink',
  'Pink lemonade': 'Pink',
  'Pink petal': 'Pink',
  'Racing green': 'Green',
  'Rocket man': 'Silver',
  'Rose tea': 'Copper',
  'Russet': 'Brown',
  'Sandcastle': 'Beige',
  'Sea foam': 'Green',
  'Sea serpent': 'Blue',
  'Sea star': 'Copper',
  'Seashell': 'Pink',
  'Silver lilac': 'Purple',
  'Silver lining': 'Silver',
  'Slate grey': 'Gray',
  'Snow white': 'White',
  'Spacesuit': 'Gray',
  'Sugar + spice': 'Beige',
  'Sunshine': 'Yellow',
};

export const ETSY_SECTION_DEFINITIONS = [
  { key: 'centre_3_8', title: '3-8mm Centre-Hole Flat' },
  { key: 'cupped_circles', title: 'Cupped Circle Sequins' },
  { key: '5mm_side', title: '5mm Side-Hole Flat' },
  { key: '8mm_side', title: '8mm Side-Hole Flat' },
  { key: '10mm_side', title: '10mm Side-Hole Flat' },
  { key: '12mm_side', title: '12mm Side-Hole Flat' },
  { key: '15mm_side', title: '15mm Side-Hole Flat' },
  { key: '20mm_side', title: '20mm Side-Hole Flat' },
  { key: '30mm_side', title: '30mm Side-Hole Flat' },
  { key: 'squares', title: 'Square Sequins' },
  { key: 'teardrops', title: 'Teardrop Sequins' },
  { key: 'ovals', title: 'Oval Sequins' },
  { key: 'pointed_ovals', title: 'Pointed Oval Sequins' },
  { key: 'triangles', title: 'Triangle Sequins' },
  { key: 'spools', title: 'Sequin Spools' },
  { key: 'punchinella', title: 'Punchinella' },
  { key: 'seconds', title: 'Seconds' },
  { key: 'masters', title: 'All Master Products' },
];

export function canonicalCatalogueValue(value) {
  return String(value || '').normalize('NFKD').replace(/[’']/g, '').replace(/\+/g, ' and ')
    .replace(/&/g, ' and ').toLocaleLowerCase('en-GB').replace(/centre/g, 'center')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function colourCategoryFor(colour) {
  const first = String(colour || '').split('/')[0].trim();
  if (!first) return null;
  const exact = Object.entries(COLOUR_CATEGORIES).find(([name]) => canonicalCatalogueValue(name) === canonicalCatalogueValue(first));
  return exact?.[1] || first;
}

export function etsySectionKeyFor(productTitle, role = 'colour') {
  const value = String(productTitle || '');
  if (/^Seconds$/i.test(value)) return 'seconds';
  if (/^Punchinella\b/i.test(value)) return 'punchinella';
  if (role === 'master') return 'masters';
  if (/On The Spool/i.test(value)) return 'spools';
  if (/\bCupped\b/i.test(value)) return 'cupped_circles';
  if (/\bPointed Oval\b/i.test(value)) return 'pointed_ovals';
  if (/\bTeardrop\b/i.test(value)) return 'teardrops';
  if (/\bTriangle\b/i.test(value)) return 'triangles';
  if (/\bOval\b/i.test(value)) return 'ovals';
  if (/\bSquare\b/i.test(value)) return 'squares';
  const circle = value.match(/(\d+)mm\s+Circle\s*\|\s*(Cent(?:re|er)|Side)\s+Hole/i);
  if (!circle) return null;
  if (/^cent/i.test(circle[2]) && Number(circle[1]) >= 3 && Number(circle[1]) <= 8) return 'centre_3_8';
  return `${circle[1]}mm_${/^cent/i.test(circle[2]) ? 'centre' : 'side'}`;
}

export function etsyTargetTitle(productTitle, role, colour, listingTitle = null) {
  if (listingTitle && /^Punchinella\b/i.test(productTitle)) {
    return `All colours sequins | ${listingTitle}`.slice(0, 140);
  }
  if (/^Seconds$/i.test(productTitle)) return 'Seconds';
  if (role === 'master') return `All colours sequins | ${productTitle}`.slice(0, 140);
  const category = colourCategoryFor(colour);
  return `${category} sequins | ${productTitle} | ${colour}`.slice(0, 140);
}

export function addCatalogueSearchTerms(values, role, colour) {
  const category = role === 'master' ? 'All colours' : colourCategoryFor(colour);
  return [category, category ? `${category} sequins` : null, ...values].filter(Boolean);
}
