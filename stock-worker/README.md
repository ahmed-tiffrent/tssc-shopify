# TSSC Punchinella Stock Worker

This Worker adds Punchinella stock after each normal sequin fulfilment and
keeps the Etsy catalogue synchronized one way from Shopify. Stock
is kept separately for every exact shape, colour, and recycled-content
combination. It does **not** create stock for Punchinella or Seconds.

## Before deployment

The Cloudflare Worker must have a D1 binding named `DB` and the
`tssc-etsy-sync` Queue bound as `ETSY_SYNC_QUEUE`. Create seven secrets
in Cloudflare under the Worker **Settings → Variables and Secrets**:

| Name | Value |
| --- | --- |
| `SHOPIFY_SHOP` | `the-sustainable-sequin-company.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Shopify Dev Dashboard app Client ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify Dev Dashboard app Client secret |
| `SETUP_KEY` | A new long random passphrase, used only for the `/setup` request |
| `ETSY_KEYSTRING` | Etsy seller app keystring |
| `ETSY_SHARED_SECRET` | Etsy seller app shared secret |
| `ETSY_REFRESH_TOKEN` | Current Etsy OAuth refresh token |

Never store any of these values in source control or send them in chat.

## Deploy through the Cloudflare dashboard

1. Cloudflare → Workers & Pages → `tssc-punchinella-stock` → **Edit code**.
2. Replace the default Worker code with `worker.js`, add `etsy-sync.js` beside
   it, and keep the `./etsy-sync.js` import at the top of `worker.js`.
3. Click **Deploy**.
4. Add the seven secrets above. The two Shopify credential values are located in
   Shopify Dev Dashboard → TSSC Punchinella Stock → **App settings**.
5. From a terminal, run the following (substituting your secret locally):

   ```sh
   curl -X POST 'https://tssc-punchinella-stock.mrtiffrent.workers.dev/setup' \
     -H 'X-Setup-Key: YOUR_SETUP_KEY'
   ```

   A successful response reports `ready: true`, the exact-variant inventory
   model, and `location: "Shop location"`. It also creates the Shopify
   `fulfillments/create`, `products/update`, and `inventory_levels/update`
   webhooks.

## Shopify → Etsy catalogue sync

The product and inventory webhooks map each Shopify product to its Etsy master listing
and all of its colour listings. It updates titles, descriptions, tags,
materials, prices, quantities, variation choices, listing availability,
product images, the matching colour-specific image, and the size diagram.
Inventory events are debounced in 15-second windows so a Shopify bulk stock
update does not create a burst of duplicate Etsy writes.
Both webhook types enqueue durable jobs; Cloudflare retries a temporary Etsy
or Shopify API failure up to five times instead of relying on the webhook's
short response window.
Seconds and Punchinella continue to omit the size diagram. Etsy-only products
are deliberately outside the mapping and are never modified.

After the Etsy migration completes, build the protected D1 import payload:

```sh
node scripts/etsy-build-worker-import.mjs --enable-sync
```

Then import it after deployment with the current `SETUP_KEY`:

```sh
curl -X POST 'https://tssc-punchinella-stock.mrtiffrent.workers.dev/admin/etsy/import' \
  -H 'Content-Type: application/json' \
  -H 'X-Setup-Key: YOUR_SETUP_KEY' \
  --data-binary '@soply-import/etsy-worker-import.json'
```

The Worker rotates Etsy refresh tokens into D1, so subsequent webhook runs do
not depend on manually copying every rotated token back into Cloudflare.

### Etsy shop sections

The synchronizer keeps the shop within Etsy's 20 custom-section limit. The
sections follow the product guide: six centre-hole flat circle sizes, cupped
circles, seven side-hole flat circle sizes, Squares, Ovals, Other Shapes,
Spools, Punchinella, and Seconds. The 20% and 100% recycled versions share the
same size-and-shape section, and every spool product shares the Spools section.
Punchinella is represented by two master listings, matching Shopify: one for
100% recycled plastic and one for 20% recycled plastic. Etsy permits at most
400 inventory combinations per listing, so each Punchinella listing publishes
the complete matrix around the colours and product types that currently have
Shopify stock. New combinations are added automatically when Shopify stock
becomes available. A product with no available combinations stays unavailable
instead of publishing artificial stock. Seconds remains one master listing.

Sections are customer-facing navigation only. Sales and catalogue updates are
linked by the stored Etsy listing ID, Shopify product ID, listing role, colour,
SKU, and variation data—not by a section title. This lets recycled-content and
quantity variants remain distinct and correctly synchronized even when they
share one Etsy section. Shopify-linked listings retain their classified section
when the one-way Shopify → Etsy product synchronizer updates them. Etsy-only
listings remain preserved and outside catalogue synchronization.

Listing publication follows Shopify's numeric inventory: any managed master or
colour listing with at least one positive-stock Shopify variant is active on
Etsy; listings whose matching variants all have zero stock remain inactive or
draft. A protected, queue-based availability reconciliation can audit the full
catalogue without rewriting listing content, and is paced below Etsy's
per-second API limit.

## What the Worker does

- verifies Shopify's signed fulfilment webhook;
- skips Punchinella and Seconds because their SKUs are not recognised by its
  sequin-only recipe allow-list;
- converts each fulfilled loose/sequin-spool SKU to the resulting Punchinella
  centimetres, using the workbook values;
- resolves the exact customer-facing Punchinella variant by shape, colour, and
  recycled content;
- retains incomplete 3-metre lengths in D1 and adds one Shopify inventory unit
  to that exact variant for every complete 300 cm produced;
- enables Shopify inventory tracking and activates the exact Punchinella
  variant at `Shop location` when it first has a complete sale unit; and
- saves every fulfilment ID in D1 and uses Shopify's idempotency directive, so
  a duplicate delivery cannot increase stock twice.

The old hidden `Internal Punchinella Stock` product and the 64 colour-only
Soply materials are not used by this version. Disable their stock syncing and
remove their Punchinella product usages before enabling this Worker, otherwise
Soply can overwrite the exact Shopify variant quantities.

## One-time bulk inventory activation

If your customer-facing variants were created with Shopify inventory tracking
off, use the protected endpoint below after deploying this Worker version. It
enables tracking and activates `Shop location` for customer-facing variants
whose SKU starts `TSSC-`. It includes normal sequins and real Punchinella, and
excludes product titles containing `Seconds` plus the old internal test stock.

It processes up to 50 variants per call. Run this single command in Terminal;
it repeats until every page has been processed:

```sh
read -s "TSSC_SETUP_KEY?Paste SETUP_KEY, then press Return: "
echo
TSSC_CURSOR=''
while :; do
  TSSC_RESPONSE=$(curl -sS -X POST -G "https://tssc-punchinella-stock.mrtiffrent.workers.dev/admin/enable-tracking" \
    --data-urlencode "after=$TSSC_CURSOR" \
    -H "X-Setup-Key: $TSSC_SETUP_KEY") || break
  echo "$TSSC_RESPONSE"
  TSSC_CURSOR=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.stdout.write(x.next_cursor||"")})' <<< "$TSSC_RESPONSE") || break
  [ -n "$TSSC_CURSOR" ] || break
done
unset TSSC_SETUP_KEY TSSC_CURSOR TSSC_RESPONSE
```

After it finishes, refresh/recalculate in Soply so the calculated normal
sequin quantities are written to Shopify. Do not bulk-enter quantities in
Shopify; Soply remains the source of truth for those products.

The 3mm cupped spool uses the confirmed 3mm centre-hole Punchinella yield of
305g per kilogram of film.

## Manual Punchinella stock manager

After deploying the current `worker.js`, open:

```text
https://tssc-punchinella-stock.mrtiffrent.workers.dev/admin
```

Enter the existing `SETUP_KEY`. The page keeps it only in browser memory for
that session. Choose the exact **shape**, **colour**, and **recycled content**,
then enter the total physical Punchinella stock in centimetres.

Below the editor, the **All Punchinella availability** table groups variants by
colour and lists each exact variant's Shopify products, D1 remainder, and
combined centimetre total. Use its search field to find a shape, colour,
material, colour code, or SKU, and its **Shopify availability** filter to show
all, available-to-buy, or unavailable variants. The **Manage** button loads a
row into a focused stock-editing pop-up. Group sections start closed; expand a
colour (or another selected group) to view its variants.

For example, setting an exact target to **700 cm** results in:

- Shopify available quantity: **2** customer-facing 3-metre products;
- D1 remainder: **100 cm**; and
- total physical stock shown in the manager: **700 cm**.

“Set stock” is intentional: it makes Shopify's available quantity exactly
match the requested total rather than adding to the existing quantity. It only
affects the selected exact Punchinella variant. It does not change normal
sequins, Seconds, or Soply raw-material stock.
