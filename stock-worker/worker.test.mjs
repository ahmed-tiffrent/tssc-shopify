import assert from 'node:assert/strict';
import test from 'node:test';

import {
  punchinellaOutputForSequinSku,
  punchinellaStockBreakdown,
  shapeCodeFromPunchOption,
  isManagedTsscInventoryVariant,
} from './worker.js';

test('maps the reported Sunshine oval order to the exact shape/colour/content target', () => {
  const output = punchinellaOutputForSequinSku('TSSC-OV1018-S-21-R100-0100');
  assert.equal(output.targetKey, 'OV1018|S-21|R100');
  assert.equal(output.targetSkuPrefix, 'TSSC-PU-S-21-R100-');
  assert.equal(output.shapeCode, 'OV1018');
  assert.equal(Math.round(output.centimetres), 150);
});

test('recognises the exact Punchinella oval option', () => {
  assert.equal(
    shapeCodeFromPunchOption('10*18mm Oval | 100% Recycled Plastic'),
    'OV1018',
  );
});

test('keeps spool styles distinct', () => {
  assert.equal(
    shapeCodeFromPunchOption('3mm On The Spool Circle | Center Hole | Cupped | 20% Recycled Plastic'),
    'SPCU03',
  );
  assert.equal(
    shapeCodeFromPunchOption('3mm On The Spool Circle | Center Hole | Flat | 20% Recycled Plastic'),
    'SPCC03',
  );
});

test('does not produce Punchinella from Punchinella or Seconds SKUs', () => {
  assert.equal(punchinellaOutputForSequinSku('TSSC-PU-S-21-R100-57142897639748'), null);
  assert.equal(punchinellaOutputForSequinSku('SECONDS-EXAMPLE'), null);
});

test('splits a manually entered Punchinella total into Shopify packs and a D1 remainder', () => {
  assert.deepEqual(punchinellaStockBreakdown(700), {
    totalCm: 700,
    packs: 2,
    remainderCm: 100,
  });
  assert.throws(() => punchinellaStockBreakdown(700.5), /whole number/);
});

test('bulk tracking includes customer-facing TSSC variants but excludes Seconds and old test stock', () => {
  assert.equal(isManagedTsscInventoryVariant({
    sku: 'TSSC-OV1018-S-21-R100-0100',
    product: { title: '10*18mm Oval | 100% Recycled Plastic' },
  }), true);
  assert.equal(isManagedTsscInventoryVariant({
    sku: 'TSSC-PU-S-21-R100-57142897639748',
    product: { title: 'Punchinella | 3 Metres | 100% Recycled Plastic' },
  }), true);
  assert.equal(isManagedTsscInventoryVariant({
    sku: 'TSSC-SECONDS-001',
    product: { title: 'Seconds Sequins' },
  }), false);
  assert.equal(isManagedTsscInventoryVariant({
    sku: 'PUNCH-S-21-R100',
    product: { title: 'Internal Punchinella Stock' },
  }), false);
});
