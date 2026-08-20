## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

## Checklist

- [ ] `npm run lint` and `npm test` pass
- [ ] No new runtime dependencies (this project ships with zero, on purpose)
- [ ] Missing values stay `null` — nothing coerces "not reported" into `0`
- [ ] No new number is presented as measured unless it came from a source
- [ ] Nothing leaves the machine: no network calls in the ingest or analytics path
- [ ] If this adds/changes an adapter: a fixture under `test/fixtures/` and a test that
      asserts the normalized output, including at least one missing-field case
- [ ] Docs updated (`docs/`, `README.md`, or `skills/tokenflow/SKILL.md`)
