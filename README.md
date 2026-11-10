# The Sustainable Sequin Company: Shopify and stock tools

Code from my internship at The Sustainable Sequin Company (TSSC), a recycled sequin maker in Lewes, UK, shared with the founder's permission. It covers the custom parts of their Shopify theme, a stock worker that removes a manual inventory step, and the scripts used to clean up products, pricing, shipping and sales channels. Written with AI-assisted coding.

## What's here

**`stock-worker/`**: a Cloudflare Worker that works out how much Punchinella (the sequin waste sold by length) each fulfilled sequin order produces and adds it to stock. Stock is tracked separately for each exact shape, colour and recycled-content combination in a D1 database. It also keeps the Etsy catalogue in sync one way from Shopify through a queue. Tests are in `worker.test.mjs`.

**`scripts/`**: one-off Node.js and Python scripts that:
- export products and reconcile Shopify against Etsy before migrating listings
- audit the Google Merchant Center feed and shipping settings and summarise product issues
- apply the retail price list, market pricing, shipping profiles and customs data
- build bills of materials and reconcile raw-material stock for the Soply stock system

**`theme/`**: 49 custom sections, blocks and snippets (all prefixed `tssc-`) built on Shopify's Tinker theme. They include the sustainability stats, sequins guide, material switcher, wishlist, reviews and structured data for search.

## Tech

- JavaScript and Node.js, Python
- Cloudflare Workers, D1 and Queues
- Shopify Admin API, Etsy API, Google Merchant API
- Shopify Liquid

## Notes

The worker needs Shopify and Etsy credentials stored as Cloudflare secrets. Setup steps are in [stock-worker/README.md](stock-worker/README.md). No keys, customer data or store exports are included. The Tinker base theme belongs to Shopify and is not included.

---

Ahmed Amine Tiffrent · [Portfolio](https://www.aminetiffrent.com/portfolio)
