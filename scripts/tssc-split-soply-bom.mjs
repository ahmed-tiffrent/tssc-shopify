import fs from 'node:fs';
import path from 'node:path';

const inputPath = path.resolve('soply-import/soply-bom-import.csv');
const stockPath = path.resolve('soply-import/soply-raw-materials-to-create.csv');
const outputDir = path.resolve('soply-import/bom-batches');
const rowsPerFile = 250;
const [header, ...sourceRows] = fs.readFileSync(inputPath, 'utf8').trim().split(/\r?\n/);
// This row is imported separately as the pre-flight test; do not import it twice.
const rows = sourceRows.filter((row) => !row.startsWith('TSSC-OV1018-S-05-R20-0005,'));
const [stockHeader, ...stockRows] = fs.readFileSync(stockPath, 'utf8').trim().split(/\r?\n/);
const stockBySku = new Map(stockRows.map((row) => {
  const [sku] = row.split(',');
  return [sku, row];
}));

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (let start = 0, batch = 1; start < rows.length; start += rowsPerFile, batch += 1) {
  const contents = [header, ...rows.slice(start, start + rowsPerFile)].join('\n') + '\n';
  const filename = `soply-bom-batch-${String(batch).padStart(2, '0')}.csv`;
  fs.writeFileSync(path.join(outputDir, filename), contents);

  const usedSkus = [...new Set(rows.slice(start, start + rowsPerFile).map((row) => row.split(',')[3]))];
  const stockContents = [stockHeader, ...usedSkus.map((sku) => stockBySku.get(sku)).filter(Boolean)].join('\n') + '\n';
  const stockFilename = `soply-bom-batch-${String(batch).padStart(2, '0')}-starting-stock.csv`;
  fs.writeFileSync(path.join(outputDir, stockFilename), stockContents);
}

fs.writeFileSync(
  path.join(outputDir, 'README.md'),
  `Upload these ${Math.ceil(rows.length / rowsPerFile)} CSV files one at a time in Soply's Import BOM Recipes screen. Each contains at most ${rowsPerFile} BOM rows.\n`
);
