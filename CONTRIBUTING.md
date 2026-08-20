# Contributing

Thanks for looking. This project has an unusual set of constraints, and they are the reason it
works — please read this section before opening a PR.

## The five invariants

These are not style preferences. A change that breaks one of them makes the dashboard lie, which
is worse than a dashboard that is missing a feature.

1. **Missing is not zero.** Every token field is `number | null`. `null` means the source did not
   report it; `0` means the source reported zero. They are different facts and they stay
   different all the way through: schema → cube (`naIn`/`naOut`/…) → UI badge → CSV empty cell.
   Never write `?? 0` on a token field.
2. **Measured and estimated never mix.** A cost from a gateway's billing log is evidence. A cost
   from a price table is arithmetic. They are separate fields, separate KPIs, separately labelled.
3. **A streamed usage block is a snapshot, not an increment.** Several tools re-report a running
   total per chunk. Summing them inflates by 3–45×. Adapters take the maximum of a monotonic run
   per logical unit — there are regression tests for exactly this, do not "simplify" them.
4. **Tokens are not productivity.** The Productivity tab shows *activity proxies* and labels
   correlations as correlations. No feature may imply that spending more tokens is doing more work.
5. **Nothing leaves the machine.** No network calls in ingest, analytics, or the UI. The server
   binds to loopback. Prompts, conversations and source code are never read into the store —
   only counts, identifiers and timestamps.

There is a sixth, softer one: **no runtime dependencies**. Node 22.5+ gives us `node:sqlite`,
`node:test` and everything else we need. A PR that adds a dependency needs a very good story.

## Getting set up

```bash
git clone <repo> && cd tokenflow
npm run demo -- --no-serve   # synthetic data, no real logs needed
npm start                    # refresh + snapshot + open the dashboard
npm test && npm run lint
```

There is no build step and no `npm install` (there is nothing to install). The browser imports
the same ES modules the CLI runs.

## Writing an adapter

An adapter is ~80 lines and lives in `src/providers/<id>/index.js`. It parses; the engine does
classification, timezones, pricing, dedup, shard writes and rollups. See
[`docs/creating-provider.md`](docs/creating-provider.md) for the full walkthrough, and
`src/providers/mock/` for the simplest complete example.

Every adapter PR needs:

- a **fixture** in `test/fixtures/` — a handful of redacted lines, not a real transcript
- a test that asserts the normalized records, including **one record with a missing field** that
  must come out `null`
- `detect()` returning a useful `detail` string when the source is absent (it is shown in the UI)

## Tests

```bash
npm test                       # 101 tests, no network, no fixtures larger than a few KB
node --test test/store.test.js  # one file
```

Tests that encode a *bug we already fixed* are the most valuable thing in the suite. If you fix
something subtle, leave a test with a comment explaining what went wrong.

## Reporting an issue

Please do not paste raw session logs, prompts, or code. `tokenflow doctor` plus a description is
almost always enough.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
