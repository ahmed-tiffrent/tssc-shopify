#!/usr/bin/env python3
"""Build a non-destructive Soply raw-material stock reconciliation from TSSC's XLSX.

This does not attempt a Soply import. Soply's own import template is required so
the final file uses the app's exact column names and identifiers.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


SOURCE = Path("/Users/mac/Downloads/Film weights in stock.xlsx")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "soply-import"

AVAILABLE_20 = {
    "marmalade", "rose tea", "sunshine", "comet", "artichoke", "sea serpent",
    "blue lagoon", "aegean", "admiral", "lavender", "peony", "lipstick",
    "chestnut", "dark chocolate", "jet black", "spacesuit", "nostalgia", "blush",
    "sandcastle", "asparagus", "sea foam", "fresh air", "hello sailor", "midnight",
    "iris", "seashell", "pink petal", "carnation", "geranium", "chilli pepper",
    "claret", "russet", "black liquorice", "rocket man", "snow white",
    "clear rainbow", "disco dancer", "fluoro canary", "fluoro tangerine",
    "fluoro flamingo", "silver lining", "sugar + spice", "double denim", "sea star",
}

AVAILABLE_100 = {
    "sunshine", "comet", "pale peridot", "racing green", "silver lilac", "lipstick",
    "jet black", "gunmetal", "dark silver", "asparagus", "forest", "aqua green",
    "pale heather", "seashell", "carnation", "geranium", "black liquorice",
    "slate grey", "crystal clear", "bobby dazzler",
}

# These catalogue colours have confirmed zero starting stock, so they do not
# appear in the stock workbook. Their chart codes are still needed for the
# Shopify/Soply SKU relationship.
FALLBACK_COLOUR_CODES = {
    ("black liquorice", 20): "M-12",
    ("sunshine", 20): "S-21",
}

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def xlsx_rows(path: Path) -> list[tuple[int, dict[str, str]]]:
    with ZipFile(path) as archive:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = [
            "".join(node.text or "" for node in item.iter(f"{{{NS['m']}}}t"))
            for item in shared_root.findall("m:si", NS)
        ]
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))

    output = []
    for row in sheet.findall(".//m:row", NS):
        values: dict[str, str] = {}
        for cell in row.findall("m:c", NS):
            column = re.match(r"[A-Z]+", cell.attrib["r"]).group(0)
            value_node = cell.find("m:v", NS)
            value = "" if value_node is None else (value_node.text or "")
            if cell.attrib.get("t") == "s" and value:
                value = shared[int(value)]
            values[column] = value
        output.append((int(row.attrib["r"]), values))
    return output


def normalise_colour(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower()).replace("geramium", "geranium")


def material_sku(code: str, content: int) -> str:
    return f"{code.strip().upper()}-R{content}-RPET"


def main() -> None:
    aggregate_kg: dict[tuple[str, int], float] = defaultdict(float)
    codes: dict[tuple[str, int], str] = {}
    notes: dict[tuple[str, int], list[str]] = defaultdict(list)

    for row_number, row in xlsx_rows(SOURCE):
        if row_number < 4 or not row.get("A") or not row.get("B") or not row.get("C"):
            continue
        colour = normalise_colour(row["A"])
        try:
            content = int(float(row["C"]))
            net_kg = float(row.get("F") or 0)
        except ValueError:
            continue
        if content not in (20, 100):
            continue
        key = (colour, content)
        aggregate_kg[key] += net_kg
        codes[key] = row["B"].strip()
        if row.get("G", "").strip():
            notes[key].append(f"row {row_number}: {row['G'].strip()}")
        if row.get("H", "").strip():
            notes[key].append(
                f"row {row_number}: alternate value {row['H'].strip()} kg"
                + (f" ({row.get('I', '').strip()})" if row.get("I", "").strip() else "")
            )

    expected = {(colour, 20) for colour in AVAILABLE_20} | {
        (colour, 100) for colour in AVAILABLE_100
    }
    rows = []
    for key in sorted(expected | set(aggregate_kg), key=lambda item: (item[1], item[0])):
        colour, content = key
        source_kg = aggregate_kg.get(key)
        status = "READY"
        recommended_g = round(max(0, source_kg or 0) * 1000)
        row_notes = list(notes.get(key, []))

        if key not in expected:
            status = "OMIT_UNLINKED"
            row_notes.append("Colour/content pair is not available in the current product catalogue.")
        elif source_kg is None:
            status = "READY_ZERO_STOCK"
            row_notes.append("Confirmed starting quantity: 0 g because the colour has no stock entry.")
        elif source_kg < 0:
            status = "CORRECTED_TO_ZERO"
            row_notes.append("Negative calculated stock cannot be imported; proposed quantity is 0 g.")
        elif colour == "spacesuit" and content == 20:
            row_notes.append("Confirmed: use 1.85 kg from the 'in stock on roll minus card inner' column; ignore the alternate 1.96 kg note.")

        code = codes.get(key, FALLBACK_COLOUR_CODES.get(key, ""))
        rows.append(
            {
                "status": status,
                "material_name": f"{code + ' ' if code else ''}{colour} {content}% rPET".strip(),
                "material_sku": material_sku(code, content) if code else "",
                "colour": colour,
                "colour_code": code,
                "recycled_content_percent": content,
                "source_stock_kg": "" if source_kg is None else f"{source_kg:.3f}",
                "proposed_stock_g": recommended_g,
                "notes": "; ".join(row_notes),
            }
        )

    OUTPUT_DIR.mkdir(exist_ok=True)
    csv_path = OUTPUT_DIR / "raw-material-stock-review.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    resolved_statuses = {"READY", "READY_ZERO_STOCK", "CORRECTED_TO_ZERO"}
    issue_rows = [row for row in rows if row["status"] not in resolved_statuses]
    report_path = OUTPUT_DIR / "README.md"
    report = [
        "# Soply inventory import preparation\n",
        "This folder is a non-destructive reconciliation, not a Soply import. Soply's downloaded import template and exported BOM recipes are still required.\n",
        f"- Catalogue material records expected: {len(expected)}",
        f"- Stock rows ready without a decision: {len(rows) - len(issue_rows)}",
        f"- Records requiring review: {len(issue_rows)}\n",
        "## Remaining review items\n",
    ]
    report.extend(
        f"- **{row['material_name']}** — `{row['status']}`: {row['notes']}"
        for row in issue_rows
    )
    report.extend(
        [
            "\n## Confirmed import rules\n",
            "- Aggregate batches into one raw material per colour and recycled-content percentage.",
            "- Use grams as the Soply base unit.",
            "- Use the workbook's conservative 10% production-loss allowance for product usage.",
            "- Do not link Seconds until a deterministic raw-material rule exists.",
            "- Confirmed: replace the On The Spool products' weight options with a Length option containing 50 yards and 100 yards, then use the corresponding production recipes.",
        ]
    )
    report_path.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(csv_path)
    print(report_path)


if __name__ == "__main__":
    main()
