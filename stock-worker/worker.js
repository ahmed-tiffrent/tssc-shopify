import {
  createEtsySyncSchema,
  importEtsyMappings,
  manageEtsySections,
  scheduleEtsySectionRebuild,
  processEtsyQueueMessage,
  queueEtsyAvailabilityReconciliation,
  queueEtsyInventorySync,
  queueEtsyProductSync,
  retryEtsySync,
  rotateEtsyToken,
} from './etsy-sync.js';

/**
 * TSSC Punchinella stock automation
 *
 * When Shopify creates a fulfilment, this Worker converts the fulfilled
 * sequin SKU(s) into centimetres of Punchinella produced. It retains partial
 * 3-metre lengths in D1 and adds complete sale units to the exact customer-
 * facing Punchinella variant (shape + colour + recycled content).
 *
 * Never put credentials in this file. Configure Shopify and Etsy credentials
 * as encrypted Cloudflare secrets, plus a random SETUP_KEY for protected setup
 * and catalogue-mapping operations.
 */

const API_VERSION = '2026-07';
const LOCATION_NAME = 'Shop location';
const PUNCHINELLA_PACK_CM = 300;
const BULK_TRACKING_PAGE_SIZE = 50;

const PUNCH_SHAPE_CODES = new Map([
  ['3mm circle | center hole | flat', 'CC03'],
  ['4mm circle | center hole | flat', 'CC04'],
  ['5mm circle | center hole | flat', 'CC05'],
  ['6mm circle | center hole | flat', 'CC06'],
  ['7mm circle | center hole | flat', 'CC07'],
  ['8mm circle | center hole | flat', 'CC08'],
  ['5mm circle | side hole | flat', 'CS05'],
  ['8mm circle | side hole | flat', 'CS08'],
  ['10mm circle | side hole | flat', 'CS10'],
  ['12mm circle | side hole | flat', 'CS12'],
  ['15mm circle | side hole | flat', 'CS15'],
  ['20mm circle | side hole | flat', 'CS20'],
  ['30mm circle | side hole | flat', 'CS30'],
  ['5mm on the spool circle | center hole | cupped', 'SPCU05'],
  ['3mm on the spool circle | center hole | cupped', 'SPCU03'],
  ['5mm on the spool circle | side hole | flat', 'SPCS05'],
  ['5mm on the spool circle | center hole | flat', 'SPCC05'],
  ['3mm on the spool circle | center hole | flat', 'SPCC03'],
  ['10*18mm oval', 'OV1018'],
  ['12*35mm teardrop', 'TD1235'],
  ['10*30mm pointed oval', 'PO1030'],
  ['20mm triangle', 'TR20'],
  ['20mm square', 'SQ20'],
  ['10mm square', 'SQ10'],
  ['5mm square', 'SQ05'],
  ['5mm circle | center hole | cupped', 'CU05'],
]);

// Values taken from “Stock take 1kg of film into sequins (1).xlsx”.
// sequinYieldG is the 10%-loss-adjusted sequin output in column E; punchG is
// the Punchinella output in column F, per 1kg of film.
const LOOSE_RECIPES = {
  CC03: { sequinYieldG: 523.6363636, punchG: 305 },
  CC04: { sequinYieldG: 566.3636364, punchG: 270 },
  CC05: { sequinYieldG: 605.4545455, punchG: 272 },
  CC06: { sequinYieldG: 632.7272727, punchG: 250 },
  CC07: { sequinYieldG: 648.1818182, punchG: 231 },
  CC08: { sequinYieldG: 655.4545455, punchG: 237 },
  CU05: { sequinYieldG: 515.4545455, punchG: 374 },
  CS05: { sequinYieldG: 605.4545455, punchG: 272 },
  CS08: { sequinYieldG: 655.4545455, punchG: 237 },
  CS10: { sequinYieldG: 680, punchG: 221 },
  CS12: { sequinYieldG: 623.6363636, punchG: 272 },
  CS15: { sequinYieldG: 635.4545455, punchG: 272 },
  CS20: { sequinYieldG: 649.0909091, punchG: 270 },
  CS30: { sequinYieldG: 640.9090909, punchG: 282 },
  SQ05: { sequinYieldG: 618.1818182, punchG: 268 },
  SQ10: { sequinYieldG: 709.0909091, punchG: 192 },
  SQ20: { sequinYieldG: 681.8181818, punchG: 223 },
  TR20: { sequinYieldG: 636.3636364, punchG: 268 },
  PO1030: { sequinYieldG: 535.4545455, punchG: 382 },
  TD1235: { sequinYieldG: 596.3636364, punchG: 316 },
  OV1018: { sequinYieldG: 646.3636364, punchG: 261 },
};

// The workbook does not list a 3mm cupped recipe. The store owner confirmed
// that SPCU03 uses the 3mm centre-hole Punchinella yield: 305g per kg.
const SPOOL_TO_PUNCH_RECIPE = {
  SPCC03: { punchG: 305 },
  SPCU03: { punchG: 305 },
  SPCC05: { punchG: 272 },
  SPCU05: { punchG: 374 },
  SPCS05: { punchG: 272 },
};

const FILM_GRAMS_PER_METRE = {
  'A-04': 34.43, // Bobby dazzler
  'A-02': 28.48, // Clear rainbow
  'A-03': 27.55, // Disco dancer
};
const DEFAULT_FILM_GRAMS_PER_METRE = 27;

function filmGramsPerMetre(colourCode) {
  return FILM_GRAMS_PER_METRE[colourCode] ?? DEFAULT_FILM_GRAMS_PER_METRE;
}

/**
 * Returns the exact centimetres made by one sale of a normal sequin SKU.
 * It returns null for Punchinella, Seconds, malformed, or otherwise excluded
 * SKUs. This is deliberately an allow-list: unknown products never create
 * stock by accident.
 */
export function punchinellaOutputForSequinSku(value) {
  const sku = String(value ?? '').trim();
  const match = sku.match(/^TSSC-([A-Z0-9]+)-([A-Z]+-\d+)-R(20|100)-([A-Z0-9]+)$/);
  if (!match) return null;

  const [, shapeCode, colourCode, recycledContent, packCode] = match;
  const gramPerMetre = filmGramsPerMetre(colourCode);
  let filmUsedG;
  let punchG;

  if (LOOSE_RECIPES[shapeCode]) {
    const packG = Number(packCode);
    if (!Number.isFinite(packG) || packG <= 0) return null;
    filmUsedG = (packG * 1000) / LOOSE_RECIPES[shapeCode].sequinYieldG;
    punchG = LOOSE_RECIPES[shapeCode].punchG;
  } else if (SPOOL_TO_PUNCH_RECIPE[shapeCode]) {
    const yards = Number(packCode.replace(/Y$/i, ''));
    if (![50, 100].includes(yards)) return null;
    // The spool recipe includes the 10% film allowance, matching the existing
    // film BOM used by Soply.
    filmUsedG = yards * 0.9144 * 1.1 * gramPerMetre;
    punchG = SPOOL_TO_PUNCH_RECIPE[shapeCode].punchG;
  } else {
    return null;
  }

  return {
    targetKey: `${shapeCode}|${colourCode}|R${recycledContent}`,
    targetSkuPrefix: `TSSC-PU-${colourCode}-R${recycledContent}-`,
    shapeCode,
    colourCode,
    recycledContent,
    centimetres: (filmUsedG * punchG * 100) / (1000 * gramPerMetre),
  };
}

export function shapeCodeFromPunchOption(value) {
  const normalized = String(value ?? '')
    .replace(/\s*\|\s*(?:20|100)%\s+Recycled\s+Plastic\s*$/i, '')
    .trim()
    .toLowerCase();
  return PUNCH_SHAPE_CODES.get(normalized) ?? null;
}

export function punchinellaStockBreakdown(centimetres) {
  const totalCm = Number(centimetres);
  if (!Number.isInteger(totalCm) || totalCm < 0) {
    throw new Error('Stock must be a whole number of centimetres, zero or greater.');
  }
  return {
    totalCm,
    packs: Math.floor(totalCm / PUNCHINELLA_PACK_CM),
    remainderCm: totalCm % PUNCHINELLA_PACK_CM,
  };
}

function outputFromTargetKey(value) {
  const match = String(value ?? '').match(/^([A-Z0-9]+)\|([A-Z]+-\d+)\|R(20|100)$/);
  if (!match || !LOOSE_RECIPES[match[1]] && !SPOOL_TO_PUNCH_RECIPE[match[1]]) {
    throw new Error('Choose a valid Punchinella variant.');
  }
  const [, shapeCode, colourCode, recycledContent] = match;
  return {
    targetKey: `${shapeCode}|${colourCode}|R${recycledContent}`,
    targetSkuPrefix: `TSSC-PU-${colourCode}-R${recycledContent}-`,
    shapeCode,
    colourCode,
    recycledContent,
  };
}

function targetFromPunchVariant(variant) {
  const skuMatch = String(variant?.sku ?? '').match(/^TSSC-PU-([A-Z]+-\d+)-R(20|100)-/);
  if (!skuMatch || !/^Punchinella\s*\|\s*3 Metres\s*\|/i.test(variant?.product?.title ?? '')) return null;

  const shapeOption = variant.selectedOptions?.find((option) => shapeCodeFromPunchOption(option.value));
  const shapeCode = shapeOption ? shapeCodeFromPunchOption(shapeOption.value) : null;
  if (!shapeCode) return null;

  const colourOption = variant.selectedOptions?.find((option) => /colou?r/i.test(option.name ?? ''));
  const [, colourCode, recycledContent] = skuMatch;
  return {
    targetKey: `${shapeCode}|${colourCode}|R${recycledContent}`,
    shapeCode,
    colourCode,
    recycledContent,
    shapeLabel: String(shapeOption.value).replace(/\s*\|\s*(?:20|100)%\s+Recycled\s+Plastic\s*$/i, ''),
    colourLabel: colourOption?.value ?? colourCode,
    variantSku: variant.sku,
    inventoryItemId: variant.inventoryItem?.id ?? null,
    available: variant.inventoryItem?.inventoryLevel?.quantities?.find((quantity) => quantity.name === 'available')?.quantity ?? 0,
  };
}

// This intentionally covers customer-facing TSSC variants only. It includes
// normal sequin products and the actual TSSC-PU Punchinella variants, but
// keeps Seconds and the old hidden test product outside the bulk action.
export function isManagedTsscInventoryVariant(variant) {
  const sku = String(variant?.sku ?? '').trim();
  const title = String(variant?.product?.title ?? '').trim();
  return sku.startsWith('TSSC-')
    && !/\bseconds?\b/i.test(title)
    && !/^internal\s+punchinella\s+stock$/i.test(title);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function stockDashboard() {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Punchinella stock | TSSC</title>
<style>
  :root { color-scheme: light; --ink:#32151d; --wine:#962648; --paper:#fffdfb; --line:#e5dce0; --muted:#685f62; }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:#f5f0f1; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { width:min(920px,calc(100% - 32px)); margin:48px auto; }
  .eyebrow { margin:0 0 8px; color:var(--wine); font-size:.78rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  h1 { margin:0; font-family:Georgia,serif; font-size:clamp(2rem,5vw,3.5rem); font-weight:400; line-height:1.05; }
  .intro { max-width:680px; margin:16px 0 30px; color:var(--muted); font-size:1.05rem; line-height:1.55; }
  .panel { padding:clamp(20px,4vw,36px); border:1px solid var(--line); background:var(--paper); box-shadow:0 14px 40px rgb(50 21 29 / 8%); }
  form { margin:0; }
  .access { display:flex; flex-wrap:wrap; gap:12px; align-items:end; }
  .access label { flex:1 1 250px; }
  label { display:grid; gap:8px; color:var(--ink); font-size:.9rem; font-weight:700; }
  input,select { width:100%; min-height:46px; padding:10px 12px; border:1px solid #b9acb0; border-radius:2px; color:var(--ink); background:#fff; font:inherit; }
  input:focus-visible,select:focus-visible,button:focus-visible { outline:3px solid var(--wine); outline-offset:3px; }
  button { min-height:46px; padding:10px 18px; border:1px solid var(--wine); color:#fff; background:var(--wine); font:inherit; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.55; cursor:wait; }
  .hint { margin:10px 0 0; color:var(--muted); font-size:.86rem; line-height:1.45; }
  #stock { margin-top:28px; }
  .fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .stock-entry { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:end; margin-top:24px; }
  .stock-entry button { white-space:nowrap; }
  .summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; margin:24px 0; border:1px solid var(--line); background:var(--line); }
  .summary div { min-height:104px; padding:18px; background:var(--paper); }
  .summary span { display:block; color:var(--muted); font-size:.82rem; }
  .summary strong { display:block; margin-top:7px; font-family:Georgia,serif; font-size:1.7rem; font-weight:400; }
  .status { min-height:1.5em; margin:18px 0 0; color:var(--muted); line-height:1.45; }
  .status[data-tone="error"] { color:#9d1c2d; font-weight:700; }
  .status[data-tone="success"] { color:#246b48; font-weight:700; }
  .table-section { margin-top:40px; padding-top:28px; border-top:1px solid var(--line); }
  .table-heading { margin:0; font-family:Georgia,serif; font-size:1.8rem; font-weight:400; }
  .table-toolbar { display:flex; flex-wrap:wrap; align-items:end; justify-content:space-between; gap:16px; margin-top:18px; }
  .group-by { display:flex; width:auto; align-items:center; gap:10px; white-space:nowrap; }
  .group-by select { width:auto; min-height:42px; }
  .search { margin-top:18px; }
  .table-wrap { margin-top:16px; overflow-x:auto; border:1px solid var(--line); -webkit-overflow-scrolling:touch; }
  table { width:100%; min-width:710px; border-collapse:collapse; background:#fff; text-align:left; }
  caption { padding:12px 16px; color:var(--muted); text-align:left; font-size:.86rem; }
  th,td { padding:14px 16px; border-top:1px solid var(--line); vertical-align:middle; }
  th { border-top:0; color:var(--muted); background:#faf7f8; font-size:.76rem; letter-spacing:.06em; text-transform:uppercase; }
  td { font-size:.92rem; }
  td[data-number] { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .table-group th { padding:11px 16px; color:var(--wine); border-top:1px solid var(--line); background:#f7eef1; font-size:.84rem; letter-spacing:.04em; text-align:left; text-transform:none; }
  .table-group-toggle { display:flex; width:100%; min-height:32px; padding:0; align-items:center; justify-content:space-between; border:0; color:inherit; background:transparent; font:inherit; font-weight:700; text-align:left; }
  .table-group-toggle::after { content:'⌄'; font-size:1.3rem; line-height:1; transition:transform 150ms ease; }
  .table-group-toggle[aria-expanded="false"]::after { transform:rotate(-90deg); }
  .table-filters { display:grid; grid-template-columns:minmax(0,1fr) minmax(190px,240px); gap:16px; margin-top:18px; }
  .manage { min-height:38px; padding:7px 10px; border:1px solid var(--wine); color:var(--wine); background:transparent; font-size:.82rem; }
  .manage:hover { color:#fff; background:var(--wine); }
  .empty { padding:20px; color:var(--muted); text-align:center; }
  dialog { width:min(560px,calc(100% - 32px)); max-width:none; padding:0; border:0; background:transparent; color:var(--ink); }
  dialog::backdrop { background:rgb(27 10 17 / 72%); }
  .modal-card { position:relative; padding:clamp(24px,5vw,40px); background:var(--paper); box-shadow:0 18px 56px rgb(20 7 12 / 32%); }
  .modal-close { position:absolute; top:14px; right:14px; display:grid; width:40px; min-height:40px; padding:0; place-items:center; border:1px solid var(--line); border-radius:50%; color:var(--ink); background:#fff; font-size:1.5rem; font-weight:400; }
  .modal-title { margin:0 48px 8px 0; font-family:Georgia,serif; font-size:clamp(1.8rem,5vw,2.5rem); font-weight:400; }
  .modal-target { margin:0 0 24px; color:var(--muted); line-height:1.5; }
  .modal-summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; margin:20px 0; border:1px solid var(--line); background:var(--line); }
  .modal-summary div { padding:14px; background:#fff; }
  .modal-summary span { display:block; color:var(--muted); font-size:.8rem; }
  .modal-summary strong { display:block; margin-top:5px; font-family:Georgia,serif; font-size:1.35rem; font-weight:400; }
  .modal-actions { display:flex; justify-content:flex-end; gap:12px; margin-top:20px; }
  .modal-actions .cancel { color:var(--wine); background:transparent; }
  .visually-hidden:not(:focus,:active) { position:absolute; width:1px; height:1px; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  [hidden] { display:none !important; }
  @media (max-width:800px) { .fields { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:640px) { main { width:min(100% - 24px,920px); margin:24px auto; } .fields,.summary,.stock-entry,.table-filters,.modal-summary { grid-template-columns:1fr; } .table-toolbar { align-items:stretch; } .group-by { justify-content:space-between; } .stock-entry button { width:100%; } .table-wrap { margin-right:-4px; } th,td { padding:12px; } .modal-actions { flex-direction:column-reverse; } .modal-actions button { width:100%; } }
</style></head>
<body><main>
  <p class="eyebrow">TSSC internal tool</p><h1>Punchinella stock</h1>
  <p class="intro">Set total physical stock for one exact shape, colour, and recycled-content combination. The Worker converts every 300 cm into one Shopify product and keeps the balance as a remainder.</p>
  <section class="panel" aria-labelledby="access-title">
    <form id="access" class="access"><label id="access-title">Setup key<input id="key" type="password" autocomplete="current-password" required></label><button>Open stock manager</button></form>
    <p class="hint">Your key is kept for this browser tab session so it survives refreshes, then clears when the tab is closed.</p>
    <p id="status" class="status" role="status" aria-live="polite"></p>
    <section id="stock" hidden aria-labelledby="stock-title">
      <h2 id="stock-title" tabindex="-1">Set exact stock</h2>
      <div class="fields"><label>Shape<select id="shape"></select></label><label>Colour<select id="colour"></select></label><label>Recycled content<select id="content"></select></label></div>
      <form id="set-stock" class="stock-entry"><label>Total physical stock (cm)<input id="centimetres" type="number" inputmode="numeric" min="0" step="1" required></label><button>Set stock in Shopify</button></form>
      <div class="summary" aria-live="polite"><div><span>Shopify availability</span><strong id="packs">—</strong></div><div><span>Remainder in D1</span><strong id="remainder">—</strong></div><div><span>Total physical stock</span><strong id="total">—</strong></div></div>
      <p class="hint">“Set stock” replaces the Shopify available quantity for this exact Punchinella variant. It does not change normal sequin or Soply inventory.</p>
      <section class="table-section" aria-labelledby="availability-title"><h2 id="availability-title" class="table-heading">All Punchinella availability</h2>
        <div class="table-toolbar"><label class="group-by">Group by<select id="group-by"><option value="colour">Colour</option><option value="shape">Shape</option><option value="material">Material</option><option value="none">No grouping</option></select></label></div>
        <div class="table-filters"><label class="search">Search shape, colour, material or SKU<input id="search" type="search" autocomplete="off" placeholder="e.g. Oval, Comet or S-17"></label><label>Shopify availability<select id="availability-filter"><option value="all">All variants</option><option value="available">Available to buy</option><option value="unavailable">Unavailable</option></select></label></div>
        <div class="table-wrap" tabindex="0" aria-label="All Punchinella availability table"><table><caption id="table-count">Loading availability…</caption><thead><tr><th scope="col">Shape</th><th scope="col">Colour</th><th scope="col">Material</th><th scope="col">Shopify</th><th scope="col">Remainder</th><th scope="col">Total</th><th scope="col"><span class="visually-hidden">Manage</span></th></tr></thead><tbody id="availability-body"></tbody></table></div>
      </section>
    </section>
    <dialog id="manage-dialog" aria-labelledby="manage-title"><div class="modal-card"><button id="manage-close" class="modal-close" type="button" aria-label="Close stock editor">×</button><h2 id="manage-title" class="modal-title">Manage stock</h2><p id="manage-target" class="modal-target"></p><form id="modal-set-stock"><label>Total physical stock (cm)<input id="modal-centimetres" type="number" inputmode="numeric" min="0" step="1" required></label><div class="modal-summary" aria-live="polite"><div><span>Shopify availability</span><strong id="modal-packs">—</strong></div><div><span>Remainder in D1</span><strong id="modal-remainder">—</strong></div></div><p class="hint">This will set Shopify availability for this exact variant and store the balance in D1.</p><div class="modal-actions"><button id="manage-cancel" class="cancel" type="button">Cancel</button><button>Set stock in Shopify</button></div></form></div></dialog>
  </section>
</main><script>
(() => {
  const byId = (id) => document.getElementById(id);
  const keyInput = byId('key'); const status = byId('status'); const stock = byId('stock');
  const shape = byId('shape'); const colour = byId('colour'); const content = byId('content'); const centimetres = byId('centimetres');
  const packs = byId('packs'); const remainder = byId('remainder'); const total = byId('total');
  const search = byId('search'); const groupBy = byId('group-by'); const availabilityFilter = byId('availability-filter'); const availabilityBody = byId('availability-body'); const tableCount = byId('table-count');
  const manageDialog = byId('manage-dialog'); const manageTarget = byId('manage-target'); const modalCentimetres = byId('modal-centimetres'); const modalPacks = byId('modal-packs'); const modalRemainder = byId('modal-remainder');
  const KEY_STORAGE = 'tssc-punchinella-setup-key';
  let key = ''; let catalog = []; let packCm = 300; let managedTarget = null; const collapsedGroups = new Set(); const knownGroups = new Set();
  const say = (message, tone) => { status.textContent = message; status.dataset.tone = tone || ''; };
  const request = async (path, body) => {
    const response = await fetch(path, { method:'POST', headers:{ 'content-type':'application/json', 'x-setup-key':key }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 404) sessionStorage.removeItem(KEY_STORAGE); throw new Error(data.error || 'Request failed. Check the setup key and try again.'); }
    return data;
  };
  const optionValues = (items) => [...new Set(items)].sort((a,b) => String(a).localeCompare(String(b)));
  const setOptions = (select, values, selected) => { select.replaceChildren(...values.map((value) => new Option(value, value, false, value === selected))); };
  const currentTarget = () => catalog.find((item) => item.shapeLabel === shape.value && item.colourLabel === colour.value && item.recycledContent === String(content.value).replace('%',''));
  const renderSummary = () => {
    const item = currentTarget(); const amount = Number(centimetres.value);
    if (!item || !Number.isInteger(amount) || amount < 0) { packs.textContent='—'; remainder.textContent='—'; total.textContent='—'; return; }
    const packCount = Math.floor(amount / packCm); const left = amount % packCm;
    packs.textContent = packCount + (packCount === 1 ? ' product' : ' products');
    remainder.textContent = left + ' cm'; total.textContent = amount + ' cm';
  };
  const chooseTarget = (resetStock) => { const item = currentTarget(); if (!item) return; if (resetStock) centimetres.value = item.totalCm; renderSummary(); };
  const renderModalSummary = () => {
    const amount = Number(modalCentimetres.value);
    if (!managedTarget || !Number.isInteger(amount) || amount < 0) { modalPacks.textContent = '—'; modalRemainder.textContent = '—'; return; }
    const packCount = Math.floor(amount / packCm); const left = amount % packCm;
    modalPacks.textContent = packCount + (packCount === 1 ? ' product' : ' products'); modalRemainder.textContent = left + ' cm';
  };
  const openManageDialog = (item) => {
    managedTarget = item; manageTarget.textContent = item.shapeLabel + ' · ' + item.colourLabel + ' · ' + item.recycledContent + '% recycled'; modalCentimetres.value = item.totalCm; renderModalSummary();
    if (!manageDialog.open) manageDialog.showModal();
  };
  const cell = (value, number) => { const element = document.createElement('td'); element.textContent = value; if (number) element.dataset.number = ''; return element; };
  const renderAvailability = () => {
    const term = search.value.trim().toLowerCase(); const availability = availabilityFilter.value; const grouping = groupBy.value;
    const visible = catalog.filter((item) => {
      const matchesSearch = !term || [item.shapeLabel,item.colourLabel,item.recycledContent + '%',item.variantSku,item.colourCode].join(' ').toLowerCase().includes(term);
      const matchesAvailability = availability === 'all' || (availability === 'available' ? item.availablePacks > 0 : item.availablePacks === 0);
      return matchesSearch && matchesAvailability;
    });
    const groupLabel = (item) => grouping === 'shape' ? item.shapeLabel : grouping === 'material' ? item.recycledContent + '% recycled' : item.colourLabel;
    visible.sort((first, second) => (groupLabel(first) + '|' + first.colourLabel + '|' + first.recycledContent + '|' + first.shapeLabel).localeCompare(groupLabel(second) + '|' + second.colourLabel + '|' + second.recycledContent + '|' + second.shapeLabel));
    availabilityBody.replaceChildren();
    tableCount.textContent = visible.length + ' of ' + catalog.length + ' exact Punchinella variants';
    if (!visible.length) { const row = document.createElement('tr'); const empty = document.createElement('td'); empty.colSpan = 7; empty.className = 'empty'; empty.textContent = 'No Punchinella variants match that search.'; row.append(empty); availabilityBody.append(row); return; }
    const grouped = new Map();
    visible.forEach((item) => { const label = grouping === 'none' ? '' : groupLabel(item); if (!grouped.has(label)) grouped.set(label, []); grouped.get(label).push(item); });
    grouped.forEach((items, label) => {
      const groupKey = grouping + ':' + label;
      if (grouping !== 'none' && !knownGroups.has(groupKey)) { knownGroups.add(groupKey); collapsedGroups.add(groupKey); }
      const isCollapsed = grouping !== 'none' && collapsedGroups.has(groupKey);
      if (grouping !== 'none') { const group = document.createElement('tr'); group.className = 'table-group'; const heading = document.createElement('th'); heading.scope = 'rowgroup'; heading.colSpan = 7; const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'table-group-toggle'; toggle.textContent = label + ' (' + items.length + ')'; toggle.setAttribute('aria-expanded', String(!isCollapsed)); toggle.setAttribute('aria-label', (isCollapsed ? 'Expand ' : 'Collapse ') + label + ', ' + items.length + ' variants'); toggle.addEventListener('click', () => { if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey); else collapsedGroups.add(groupKey); renderAvailability(); }); heading.append(toggle); group.append(heading); availabilityBody.append(group); }
      if (isCollapsed) return;
      items.forEach((item) => {
      const row = document.createElement('tr');
      row.append(cell(item.shapeLabel), cell(item.colourLabel), cell(item.recycledContent + '% recycled'), cell(item.availablePacks + (item.availablePacks === 1 ? ' product' : ' products'), true), cell(item.remainderCm + ' cm', true), cell(item.totalCm + ' cm', true));
      const action = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'manage'; button.textContent = 'Manage'; button.setAttribute('aria-label', 'Manage ' + item.shapeLabel + ', ' + item.colourLabel + ', ' + item.recycledContent + '% recycled'); button.addEventListener('click', () => openManageDialog(item)); action.append(button); row.append(action); availabilityBody.append(row);
      });
    });
  };
  const refreshFilters = () => {
    const selectedShape = shape.value; const selectedColour = colour.value; const selectedContent = content.value;
    const shapes = optionValues(catalog.map((item) => item.shapeLabel)); setOptions(shape, shapes, shapes.includes(selectedShape) ? selectedShape : shapes[0]);
    const colours = optionValues(catalog.filter((item) => item.shapeLabel === shape.value).map((item) => item.colourLabel)); setOptions(colour, colours, colours.includes(selectedColour) ? selectedColour : colours[0]);
    const contents = optionValues(catalog.filter((item) => item.shapeLabel === shape.value && item.colourLabel === colour.value).map((item) => item.recycledContent + '%')); setOptions(content, contents, contents.includes(selectedContent) ? selectedContent : contents[0]);
    chooseTarget(true);
  };
  const loadStockManager = async () => {
    say('Loading Punchinella variants…');
    collapsedGroups.clear(); knownGroups.clear();
    try { const data = await request('/admin/stock/catalog'); catalog = data.targets || []; packCm = data.pack_cm || 300; if (!catalog.length) throw new Error('No exact Punchinella variants were found.'); stock.hidden = false; refreshFilters(); renderAvailability(); say('Stock manager ready.'); }
    catch (error) { say(error.message, 'error'); }
  };
  byId('access').addEventListener('submit', async (event) => {
    event.preventDefault(); key = keyInput.value; if (!key) return; sessionStorage.setItem(KEY_STORAGE, key); await loadStockManager();
  });
  shape.addEventListener('change', () => refreshFilters());
  colour.addEventListener('change', () => refreshFilters());
  content.addEventListener('change', () => chooseTarget(true));
  centimetres.addEventListener('input', renderSummary);
  search.addEventListener('input', renderAvailability);
  groupBy.addEventListener('change', renderAvailability);
  availabilityFilter.addEventListener('change', renderAvailability);
  byId('set-stock').addEventListener('submit', async (event) => {
    event.preventDefault(); const item = currentTarget(); const amount = Number(centimetres.value);
    if (!item || !Number.isInteger(amount) || amount < 0) { say('Enter a whole number of centimetres, zero or greater.', 'error'); return; }
    const plannedPacks = Math.floor(amount / packCm); const plannedRemainder = amount % packCm;
    if (!window.confirm('Set ' + item.shapeLabel + ', ' + item.colourLabel + ', ' + item.recycledContent + '% to ' + amount + ' cm? Shopify available quantity will become ' + plannedPacks + ' and the remainder will be ' + plannedRemainder + ' cm.')) return;
    const button = event.currentTarget.querySelector('button'); button.disabled = true; say('Updating Shopify…');
    try { const data = await request('/admin/stock/set', { target_key:item.targetKey, centimetres:amount }); item.availablePacks = data.shopify_available_packs; item.remainderCm = data.remainder_cm; item.totalCm = data.total_cm; centimetres.value = data.total_cm; renderSummary(); renderAvailability(); say('Saved. Shopify now has ' + data.shopify_available_packs + ' available product' + (data.shopify_available_packs === 1 ? '' : 's') + ' and D1 has ' + data.remainder_cm + ' cm remaining.', 'success'); }
    catch (error) { say(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  modalCentimetres.addEventListener('input', renderModalSummary);
  byId('manage-close').addEventListener('click', () => manageDialog.close());
  byId('manage-cancel').addEventListener('click', () => manageDialog.close());
  manageDialog.addEventListener('click', (event) => { if (event.target === manageDialog) manageDialog.close(); });
  byId('modal-set-stock').addEventListener('submit', async (event) => {
    event.preventDefault(); const item = managedTarget; const amount = Number(modalCentimetres.value);
    if (!item || !Number.isInteger(amount) || amount < 0) { say('Enter a whole number of centimetres, zero or greater.', 'error'); return; }
    const plannedPacks = Math.floor(amount / packCm); const plannedRemainder = amount % packCm;
    if (!window.confirm('Set ' + item.shapeLabel + ', ' + item.colourLabel + ', ' + item.recycledContent + '% to ' + amount + ' cm? Shopify available quantity will become ' + plannedPacks + ' and the remainder will be ' + plannedRemainder + ' cm.')) return;
    const button = event.currentTarget.querySelector('button:not(.cancel)'); button.disabled = true; say('Updating Shopify…');
    try { const data = await request('/admin/stock/set', { target_key:item.targetKey, centimetres:amount }); item.availablePacks = data.shopify_available_packs; item.remainderCm = data.remainder_cm; item.totalCm = data.total_cm; if (currentTarget() === item) { centimetres.value = data.total_cm; renderSummary(); } renderAvailability(); manageDialog.close(); say('Saved. Shopify now has ' + data.shopify_available_packs + ' available product' + (data.shopify_available_packs === 1 ? '' : 's') + ' and D1 has ' + data.remainder_cm + ' cm remaining.', 'success'); }
    catch (error) { say(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  const savedKey = sessionStorage.getItem(KEY_STORAGE);
  if (savedKey) { key = savedKey; keyInput.value = savedKey; loadStockManager(); }
})();
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'x-frame-options':'DENY', 'referrer-policy':'same-origin' } });
}

async function verifyShopifyWebhook(request, rawBody, secret) {
  const signature = request.headers.get('x-shopify-hmac-sha256');
  if (!signature || !secret) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signatureBytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(rawBody));
}

async function accessToken(env) {
  const response = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`Shopify token request failed: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function adminGraphql(env, query, variables = {}) {
  const token = await accessToken(env);
  const response = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(`Shopify GraphQL request failed: ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function createSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS punch_targets (
      target_key TEXT PRIMARY KEY,
      variant_sku TEXT NOT NULL UNIQUE,
      inventory_item_id TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS production_remainders (
      target_key TEXT PRIMARY KEY,
      centimetres REAL NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS processed_fulfillments (
      fulfillment_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`),
  ]);
  await createEtsySyncSchema(db);
}

async function setting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setSetting(db, key, value) {
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}

async function setup(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) {
    return text('Not found', 404);
  }

  await createSchema(env.DB);
  const lookup = await adminGraphql(env, `
    query PunchinellaSetup {
      locations(first: 50) { nodes { id name isActive } }
    }
  `);

  const activeLocations = lookup.locations.nodes.filter((location) => location.isActive);
  const location = activeLocations.find((item) => item.name === LOCATION_NAME) ?? (activeLocations.length === 1 ? activeLocations[0] : null);
  if (!location) {
    throw new Error(`Could not select the “${LOCATION_NAME}” location. Keep that location active, or leave only one active inventory location during setup.`);
  }

  await setSetting(env.DB, 'location_id', location.id);

  let webhookId = await setting(env.DB, 'fulfillment_webhook_id');
  if (!webhookId) {
    const callbackUrl = new URL('/webhooks/fulfillments/create', request.url).toString();
    const created = await adminGraphql(env, `
      mutation CreateFulfillmentWebhook($callbackUrl: URL!) {
        webhookSubscriptionCreate(
          topic: FULFILLMENTS_CREATE
          webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
        ) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }
    `, { callbackUrl });
    const result = created.webhookSubscriptionCreate;
    if (result.userErrors.length) throw new Error(`Webhook setup failed: ${JSON.stringify(result.userErrors)}`);
    webhookId = result.webhookSubscription.id;
    await setSetting(env.DB, 'fulfillment_webhook_id', webhookId);
  }

  let productWebhookId = await setting(env.DB, 'product_update_webhook_id');
  if (!productWebhookId) {
    const callbackUrl = new URL('/webhooks/products/update', request.url).toString();
    const created = await adminGraphql(env, `
      mutation CreateProductUpdateWebhook($callbackUrl: URL!) {
        webhookSubscriptionCreate(
          topic: PRODUCTS_UPDATE
          webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
        ) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }
    `, { callbackUrl });
    const result = created.webhookSubscriptionCreate;
    if (result.userErrors.length) throw new Error(`Product webhook setup failed: ${JSON.stringify(result.userErrors)}`);
    productWebhookId = result.webhookSubscription.id;
    await setSetting(env.DB, 'product_update_webhook_id', productWebhookId);
  }

  let inventoryWebhookId = await setting(env.DB, 'inventory_update_webhook_id');
  if (!inventoryWebhookId) {
    const callbackUrl = new URL('/webhooks/inventory-levels/update', request.url).toString();
    const created = await adminGraphql(env, `
      mutation CreateInventoryUpdateWebhook($callbackUrl: URL!) {
        webhookSubscriptionCreate(
          topic: INVENTORY_LEVELS_UPDATE
          webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
        ) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }
    `, { callbackUrl });
    const result = created.webhookSubscriptionCreate;
    if (result.userErrors.length) throw new Error(`Inventory webhook setup failed: ${JSON.stringify(result.userErrors)}`);
    inventoryWebhookId = result.webhookSubscription.id;
    await setSetting(env.DB, 'inventory_update_webhook_id', inventoryWebhookId);
  }

  return json({
    ready: true,
    inventory_model: 'exact Punchinella shape + colour + recycled content',
    punchinella_pack_cm: PUNCHINELLA_PACK_CM,
    location: location.name,
    webhook_id: webhookId,
    product_update_webhook_id: productWebhookId,
    inventory_update_webhook_id: inventoryWebhookId,
    etsy_sync: true,
  });
}

function graphqlAliases(operation, items, render, includeLocationId = false) {
  const declarations = [
    ...(includeLocationId ? ['$locationId: ID!'] : []),
    ...items.map((_, index) => `$id${index}: ID!`),
  ].join(', ');
  const fields = items.map((item, index) => render(item, index)).join('\n');
  return `mutation ${operation}(${declarations}) {\n${fields}\n}`;
}

function mutationErrors(data, prefix) {
  const errors = [];
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('item') || !value?.userErrors?.length) continue;
    errors.push(...value.userErrors.map((error) => `${key}: ${error.message}`));
  }
  if (errors.length) throw new Error(`${prefix}: ${errors.join('; ')}`);
}

async function enableTrackingPage(request, env) {
  if (!env.SETUP_KEY || request.headers.get('x-setup-key') !== env.SETUP_KEY) {
    return text('Not found', 404);
  }

  await createSchema(env.DB);
  const locationId = await setting(env.DB, 'location_id');
  if (!locationId) throw new Error('Worker setup has not selected an inventory location. Run /setup first.');

  // The first terminal call includes `after=`. Shopify requires null, not an
  // empty cursor string, for the first page.
  const after = new URL(request.url).searchParams.get('after') || null;
  const variants = await adminGraphql(env, `
    query ManagedTsscVariants($after: String, $locationId: ID!) {
      productVariants(first: ${BULK_TRACKING_PAGE_SIZE}, after: $after, query: "sku:TSSC-*") {
        nodes {
          sku
          product { title }
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) { id }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { after, locationId });

  const all = variants.productVariants.nodes;
  const managed = all.filter(isManagedTsscInventoryVariant);
  const toTrack = managed.filter((variant) => !variant.inventoryItem.tracked);
  const toActivate = managed.filter((variant) => !variant.inventoryItem.inventoryLevel);

  if (toTrack.length) {
    const trackResult = await adminGraphql(env, graphqlAliases(
      'TrackTsscInventory',
      toTrack,
      (variant, index) => `item${index}: inventoryItemUpdate(id: $id${index}, input: { tracked: true }) { userErrors { message } }`,
    ), Object.fromEntries(toTrack.map((variant, index) => [`id${index}`, variant.inventoryItem.id])));
    mutationErrors(trackResult, 'Could not enable inventory tracking');
  }

  if (toActivate.length) {
    const activateResult = await adminGraphql(env, graphqlAliases(
      'ActivateTsscInventoryAtShopLocation',
      toActivate,
      (variant, index) => `item${index}: inventoryBulkToggleActivation(
        inventoryItemId: $id${index}
        inventoryItemUpdates: [{ locationId: $locationId, activate: true }]
      ) { userErrors { message } }`,
      true,
    ), { locationId, ...Object.fromEntries(toActivate.map((variant, index) => [`id${index}`, variant.inventoryItem.id])) });
    mutationErrors(activateResult, 'Could not activate Shop location');
  }

  return json({
    processed: all.length,
    managed_variants: managed.length,
    tracking_enabled: toTrack.length,
    shop_location_activated: toActivate.length,
    skipped: all.length - managed.length,
    done: !variants.productVariants.pageInfo.hasNextPage,
    next_cursor: variants.productVariants.pageInfo.hasNextPage
      ? variants.productVariants.pageInfo.endCursor
      : null,
  });
}

async function findPunchTarget(env, output, locationId) {
  const cached = await env.DB.prepare(`SELECT target_key, variant_sku, inventory_item_id
    FROM punch_targets WHERE target_key = ?`).bind(output.targetKey).first();
  if (cached) return cached;

  const lookup = await adminGraphql(env, `
    query FindExactPunchinellaVariant($query: String!, $locationId: ID!) {
      productVariants(first: 100, query: $query) {
        nodes {
          sku
          selectedOptions { name value }
          product { title }
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) { id }
          }
        }
      }
    }
  `, { query: `sku:${output.targetSkuPrefix}*`, locationId });

  const matches = lookup.productVariants.nodes.filter((variant) => {
    if (!variant.sku?.startsWith(output.targetSkuPrefix)) return false;
    if (!/^Punchinella\s*\|\s*3 Metres\s*\|/i.test(variant.product?.title ?? '')) return false;
    return variant.selectedOptions.some((option) => shapeCodeFromPunchOption(option.value) === output.shapeCode);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one exact Punchinella target for ${output.targetKey}; found ${matches.length}.`);
  }

  const variant = matches[0];
  await env.DB.prepare(`INSERT INTO punch_targets (target_key, variant_sku, inventory_item_id)
    VALUES (?, ?, ?)
    ON CONFLICT(target_key) DO UPDATE SET
      variant_sku = excluded.variant_sku,
      inventory_item_id = excluded.inventory_item_id`)
    .bind(output.targetKey, variant.sku, variant.inventoryItem.id).run();
  return {
    target_key: output.targetKey,
    variant_sku: variant.sku,
    inventory_item_id: variant.inventoryItem.id,
    tracked: variant.inventoryItem.tracked,
    inventory_level_id: variant.inventoryItem.inventoryLevel?.id ?? null,
  };
}

async function readInventoryItem(env, inventoryItemId, locationId) {
  const data = await adminGraphql(env, `
    query ReadPunchinellaInventoryItem($id: ID!, $locationId: ID!) {
      node(id: $id) {
        ... on InventoryItem {
          id
          tracked
          inventoryLevel(locationId: $locationId) {
            id
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  `, { id: inventoryItemId, locationId });
  return data.node;
}

async function ensureInventoryLevel(env, target, locationId) {
  let item = await readInventoryItem(env, target.inventory_item_id, locationId);
  if (!item) throw new Error(`Inventory item not found for ${target.variant_sku}.`);

  if (!item.tracked) {
    const updated = await adminGraphql(env, `
      mutation TrackPunchinellaInventory($id: ID!) {
        inventoryItemUpdate(id: $id, input: { tracked: true }) {
          inventoryItem { id tracked }
          userErrors { field message }
        }
      }
    `, { id: target.inventory_item_id });
    const result = updated.inventoryItemUpdate;
    if (result.userErrors.length) throw new Error(`Could not enable inventory tracking for ${target.variant_sku}: ${JSON.stringify(result.userErrors)}`);
    item = await readInventoryItem(env, target.inventory_item_id, locationId);
  }

  if (!item.inventoryLevel) {
    const activated = await adminGraphql(env, `
      mutation ActivatePunchinellaInventory($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: 0)
          @idempotent(key: $idempotencyKey) {
          inventoryLevel { id }
          userErrors { field message }
        }
      }
    `, {
      inventoryItemId: target.inventory_item_id,
      locationId,
      idempotencyKey: `tssc-activate-${target.variant_sku}`,
    });
    const result = activated.inventoryActivate;
    if (result.userErrors.length) throw new Error(`Could not stock ${target.variant_sku} at the selected location: ${JSON.stringify(result.userErrors)}`);
    item = await readInventoryItem(env, target.inventory_item_id, locationId);
  }

  const available = item.inventoryLevel?.quantities?.find((quantity) => quantity.name === 'available')?.quantity;
  if (!Number.isInteger(available)) throw new Error(`No available inventory quantity for ${target.variant_sku}.`);
  return available;
}

function hasAdminAccess(request, env) {
  return Boolean(env.SETUP_KEY) && request.headers.get('x-setup-key') === env.SETUP_KEY;
}

async function requireAdmin(request, env) {
  if (!hasAdminAccess(request, env)) return false;
  await createSchema(env.DB);
  return true;
}

async function selectedLocationId(db) {
  const locationId = await setting(db, 'location_id');
  if (!locationId) throw new Error('Worker setup has not selected an inventory location. Run /setup first.');
  return locationId;
}

async function listPunchinellaTargets(env, locationId) {
  const targets = new Map();
  let after = null;

  do {
    const data = await adminGraphql(env, `
      query PunchinellaStockCatalog($after: String, $locationId: ID!) {
        productVariants(first: 250, after: $after, query: "sku:TSSC-PU-*") {
          nodes {
            sku
            selectedOptions { name value }
            product { title }
            inventoryItem {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after, locationId });

    for (const variant of data.productVariants.nodes) {
      const target = targetFromPunchVariant(variant);
      if (!target) continue;
      if (targets.has(target.targetKey)) {
        throw new Error(`More than one Shopify Punchinella variant matches ${target.targetKey}.`);
      }
      targets.set(target.targetKey, target);
    }
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);

  return [...targets.values()].sort((first, second) =>
    `${first.shapeLabel}|${first.colourLabel}|${first.recycledContent}`.localeCompare(
      `${second.shapeLabel}|${second.colourLabel}|${second.recycledContent}`,
    ));
}

async function stockCatalog(request, env) {
  if (!await requireAdmin(request, env)) return text('Not found', 404);
  const locationId = await selectedLocationId(env.DB);
  const [targets, remainders] = await Promise.all([
    listPunchinellaTargets(env, locationId),
    env.DB.prepare('SELECT target_key, centimetres FROM production_remainders').all(),
  ]);
  const remainderByKey = new Map(remainders.results.map((row) => [row.target_key, Number(row.centimetres ?? 0)]));

  return json({
    location: LOCATION_NAME,
    pack_cm: PUNCHINELLA_PACK_CM,
    targets: targets.map((target) => {
      const remainderCm = remainderByKey.get(target.targetKey) ?? 0;
      const availablePacks = Number(target.available ?? 0);
      return {
        ...target,
        availablePacks,
        remainderCm,
        totalCm: availablePacks * PUNCHINELLA_PACK_CM + remainderCm,
      };
    }),
  });
}

async function setManualPunchinellaStock(request, env) {
  if (!await requireAdmin(request, env)) return text('Not found', 404);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send a JSON body.' }, 400);
  }

  let breakdown;
  let output;
  try {
    output = outputFromTargetKey(body.target_key);
    breakdown = punchinellaStockBreakdown(body.centimetres);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const locationId = await selectedLocationId(env.DB);
  const target = await findPunchTarget(env, output, locationId);
  const availableBefore = await ensureInventoryLevel(env, target, locationId);
  const delta = breakdown.packs - availableBefore;
  let adjustmentId = null;

  if (delta !== 0) {
    const adjusted = await adminGraphql(env, `
      mutation SetManualPunchinellaStock($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup { id }
          userErrors { field message code }
        }
      }
    `, {
      idempotencyKey: `tssc-punchinella-manual-${output.targetKey}-${Date.now()}`,
      input: {
        reason: 'correction',
        name: 'available',
        referenceDocumentUri: new URL(`/admin/stock/${encodeURIComponent(output.targetKey)}`, request.url).toString(),
        changes: [{
          inventoryItemId: target.inventory_item_id,
          locationId,
          changeFromQuantity: availableBefore,
          delta,
        }],
      },
    });
    const result = adjusted.inventoryAdjustQuantities;
    if (result.userErrors.length) throw new Error(`Inventory adjustment failed: ${JSON.stringify(result.userErrors)}`);
    adjustmentId = result.inventoryAdjustmentGroup?.id ?? null;
  }

  await env.DB.prepare(`INSERT INTO production_remainders (target_key, centimetres)
    VALUES (?, ?)
    ON CONFLICT(target_key) DO UPDATE SET centimetres = excluded.centimetres`)
    .bind(output.targetKey, breakdown.remainderCm).run();

  console.log(`Punchinella manual stock set ${output.targetKey}: ${breakdown.totalCm}cm (${breakdown.packs} packs + ${breakdown.remainderCm}cm)`);
  return json({
    complete: true,
    target_key: output.targetKey,
    total_cm: breakdown.totalCm,
    shopify_available_packs: breakdown.packs,
    remainder_cm: breakdown.remainderCm,
    previous_shopify_available_packs: availableBefore,
    adjustment_id: adjustmentId,
  });
}

async function processFulfillment(request, env) {
  const rawBody = await request.text();
  if (!await verifyShopifyWebhook(request, rawBody, env.SHOPIFY_CLIENT_SECRET)) {
    return text('Invalid webhook signature', 401);
  }
  await createSchema(env.DB);
  const fulfillment = JSON.parse(rawBody);
  const fulfillmentId = String(fulfillment.id ?? '');
  if (!fulfillmentId) return text('Fulfillment ID missing', 400);

  const reserved = await env.DB.prepare(`INSERT OR IGNORE INTO processed_fulfillments
    (fulfillment_id, status, created_at) VALUES (?, 'processing', ?)`)
    .bind(fulfillmentId, new Date().toISOString()).run();
  if (reserved.meta.changes === 0) return json({ duplicate: true, fulfillment_id: fulfillmentId });

  try {
    const increments = new Map();
    for (const line of fulfillment.line_items ?? []) {
      const output = punchinellaOutputForSequinSku(line.sku);
      const quantity = Number(line.quantity ?? 0);
      if (!output || !Number.isFinite(quantity) || quantity <= 0) continue;
      const existing = increments.get(output.targetKey);
      increments.set(output.targetKey, {
        ...output,
        centimetres: (existing?.centimetres ?? 0) + output.centimetres * quantity,
      });
    }

    if (increments.size === 0) {
      await env.DB.prepare(`UPDATE processed_fulfillments SET status = 'skipped', completed_at = ? WHERE fulfillment_id = ?`)
        .bind(new Date().toISOString(), fulfillmentId).run();
      return json({ skipped: true, fulfillment_id: fulfillmentId });
    }

    const locationId = await setting(env.DB, 'location_id');
    if (!locationId) throw new Error('Worker setup has not selected an inventory location. Run /setup first.');

    const plans = [];
    for (const output of increments.values()) {
      const target = await findPunchTarget(env, output, locationId);
      const remainderRow = await env.DB.prepare(`SELECT centimetres FROM production_remainders
        WHERE target_key = ?`).bind(output.targetKey).first();
      const previousRemainderCm = Number(remainderRow?.centimetres ?? 0);
      // Aggregate matching lines within the fulfilment, then round once to the
      // centimetre—the same precision used by the original stock model.
      const producedCm = Math.round(output.centimetres);
      const accumulatedCm = previousRemainderCm + producedCm;
      const wholePacks = Math.floor(accumulatedCm / PUNCHINELLA_PACK_CM);
      const nextRemainderCm = accumulatedCm - wholePacks * PUNCHINELLA_PACK_CM;
      plans.push({ output, target, producedCm, previousRemainderCm, nextRemainderCm, wholePacks });
    }

    // Shopify API 2026-07 requires the current expected quantity with each
    // adjustment. This compare-and-swap prevents an adjustment from overwriting
    // a concurrent customer sale or another inventory change.
    const changes = [];
    for (const plan of plans.filter((item) => item.wholePacks > 0)) {
      const available = await ensureInventoryLevel(env, plan.target, locationId);
      changes.push({
        inventoryItemId: plan.target.inventory_item_id,
        locationId,
        changeFromQuantity: available,
        delta: plan.wholePacks,
      });
    }

    let adjustmentId = null;
    if (changes.length) {
      const adjusted = await adminGraphql(env, `
        mutation AddProducedPunchinella($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
          inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id createdAt referenceDocumentUri changes { name delta } }
            userErrors { field message code }
          }
        }
      `, {
        idempotencyKey: `tssc-punchinella-exact-fulfillment-${fulfillmentId}`,
        input: {
          reason: 'correction',
          name: 'available',
          referenceDocumentUri: new URL(`/fulfillments/${fulfillmentId}`, request.url).toString(),
          changes,
        },
      });
      const result = adjusted.inventoryAdjustQuantities;
      if (result.userErrors.length) throw new Error(`Inventory adjustment failed: ${JSON.stringify(result.userErrors)}`);
      adjustmentId = result.inventoryAdjustmentGroup?.id ?? null;
    }

    const details = plans.map((plan) => ({
      target_key: plan.output.targetKey,
      variant_sku: plan.target.variant_sku,
      produced_cm: plan.producedCm,
      added_three_metre_units: plan.wholePacks,
      remainder_cm: plan.nextRemainderCm,
    }));
    await env.DB.batch([
      ...plans.map((plan) => env.DB.prepare(`INSERT INTO production_remainders (target_key, centimetres)
        VALUES (?, ?)
        ON CONFLICT(target_key) DO UPDATE SET centimetres = excluded.centimetres`)
        .bind(plan.output.targetKey, plan.nextRemainderCm)),
      env.DB.prepare(`UPDATE processed_fulfillments
        SET status = 'complete', details = ?, completed_at = ? WHERE fulfillment_id = ?`)
        .bind(JSON.stringify({ details, adjustment_id: adjustmentId }), new Date().toISOString(), fulfillmentId),
    ]);
    console.log(`Punchinella fulfilment processed ${fulfillmentId}: ${JSON.stringify(details)}`);
    return json({ complete: true, fulfillment_id: fulfillmentId, details });
  } catch (error) {
    // Permit Shopify to redeliver an event after a genuine failure. Shopify's
    // idempotency key protects the inventory mutation from a duplicate retry.
    await env.DB.prepare('DELETE FROM processed_fulfillments WHERE fulfillment_id = ?').bind(fulfillmentId).run();
    console.error(
      `Punchinella fulfilment processing failed ${fulfillmentId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return text('Temporary processing failure', 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        return json({ service: 'TSSC Punchinella stock automation', status: 'online' });
      }
      if (request.method === 'GET' && url.pathname === '/admin') return stockDashboard();
      if (request.method === 'POST' && url.pathname === '/setup') return setup(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/enable-tracking') return enableTrackingPage(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/stock/catalog') return stockCatalog(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/stock/set') return setManualPunchinellaStock(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/etsy/import') return importEtsyMappings(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/etsy/sections') return manageEtsySections(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/etsy/sections/schedule') return scheduleEtsySectionRebuild(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/etsy/availability') return queueEtsyAvailabilityReconciliation(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/etsy/sync') {
        return retryEtsySync(request, env, ctx, (query, variables) => adminGraphql(env, query, variables));
      }
      if (request.method === 'POST' && url.pathname === '/admin/etsy/rotate-token') return rotateEtsyToken(request, env);
      if (request.method === 'POST' && url.pathname === '/webhooks/fulfillments/create') return processFulfillment(request, env);
      if (request.method === 'POST' && url.pathname === '/webhooks/products/update') {
        return queueEtsyProductSync(
          request,
          env,
          ctx,
          verifyShopifyWebhook,
          (query, variables) => adminGraphql(env, query, variables),
        );
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/inventory-levels/update') {
        return queueEtsyInventorySync(
          request,
          env,
          ctx,
          verifyShopifyWebhook,
          (query, variables) => adminGraphql(env, query, variables),
        );
      }
      return text('Not found', 404);
    } catch (error) {
      console.error('Unhandled worker error', error);
      return text('Internal error', 500);
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processEtsyQueueMessage(
          env,
          (query, variables) => adminGraphql(env, query, variables),
          message.body,
        );
        message.ack();
      } catch (error) {
        console.error('Queued Etsy sync failed', error);
        message.retry({ delaySeconds: Math.min(43_200, Math.max(60, Number(error?.retryAfter || 60))) });
      }
    }
  },
};
