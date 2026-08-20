# Sample data

Two ways to get a populated dashboard without connecting anything real.

## 1. The mock provider (recommended)

```bash
npm run demo
```

Deterministic synthetic usage across four providers, three clients and four interfaces, with
weekday seasonality, a mild upward trend, genuinely idle days and a bimodal daily rhythm — so the
time-pattern and trend views have something real-shaped to show. Same seed, same output.

Every record carries `metadata.demo = true` and `machine: "demo-machine"`, and the dashboard shows
a persistent **DEMO DATA** banner while any of it is in scope. Clear it with:

```bash
tokenflow provider remove mock && tokenflow refresh --full
```

## 2. The generic importer (exercises a different code path)

`sample-usage.csv` is a tiny hand-written export in the shape a third-party console tends to
produce. Importing it exercises the mapping layer rather than the generator:

```bash
tokenflow import examples/demo-data/sample-usage.csv --dry-run    # see the inferred mapping
tokenflow import examples/demo-data/sample-usage.csv
```

Things it deliberately contains:

- an **empty** `cached_tokens` cell — must import as `null` (not available), never `0`
- a model with no configured price (`glm-4.6`) — must import with `estimated_cost: null`
- a quoted field containing a comma
- three vendors, so provider classification has something to do
- a `client` column, so interface classification has a real surface signal
