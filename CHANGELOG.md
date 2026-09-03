# Changelog

All notable changes to TokenFlow are recorded here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.1 — 2026-09-03

A reliability release. Five defects had combined to leave the app paused, the
dashboard unreachable, the stop button inert, one day's token total inflated by
37 billion — and the alert that would have caught it ranked out of sight.

### Fixed

- **The watcher refused to start after a reboot.** The lock file held a bare
  PID, and PID numbers restart and get reused at every boot, so a lock that
  outlived a restart kept naming a live process — just not ours. One left at
  pid 810 was inherited by `mobilerepaird`; `kill(810, 0)` went on succeeding
  and every `tokenflow watch` refused to start, from the launch agent and the
  menu bar's play button alike. The data went stale behind a phantom. The lock
  now records the boot its PID was issued by, so a pidfile from an earlier boot
  is stale by construction. A watcher that fails to start now reports why
  instead of failing silently.
- **The Dashboard button opened a closed port.** It opened
  `http://127.0.0.1:<port>` whether or not anything was serving. It now starts
  the server when none is running, shows progress while the data bundle builds,
  and reports a failure. `tokenflow dashboard` also binds the port from
  `config.yaml` rather than a hardcoded default, and a second invocation opens
  the window instead of failing on a busy port.
- **The stop button never stopped anything.** A `KeepAlive: true` launch agent
  restarts the job after *any* exit, including the clean one a deliberate stop
  produces — measured at about two seconds. The supported agent uses
  `KeepAlive: { SuccessfulExit: false }`: a crash comes back, a stop stays
  stopped.
- **The Hermes adapter invented usage that never happened.**
  `session_model_usage` is keyed on six columns and the adapter's bookkeeping
  key used four, omitting `billing_base_url` and `billing_mode`. Two real rows
  differing only in billing mode shared one entry, each computed its delta
  against the other's totals, and every refresh cycle re-emitted the difference
  under a fresh id. Five colliding sessions turned one day into 39.9B tokens —
  a figure that grew with the number of refresh cycles rather than with usage.
  The key is now the table's whole primary key, and the tail is a high-water
  mark, so a total that comes back lower can never manufacture usage.
- **The alert that caught it was buried.** That corruption was detected the day
  it began: 240× the 60-day median, a modified z-score of 170.9, severity high.
  Severity saturates at "high" around z=6 and the list then sorted by date, so
  the outlier ranked third behind two request spikes of z=6.5 and z=11.2 from
  later in the week — and the menu bar shows the top two. Anomalies of a
  different order now outrank recency; ordinary alerts still read newest-first.

### Added

- `tokenflow watch --install-agent` — keeps the watcher running across reboots,
  supervised by launchd. `--uninstall-agent` removes it. Installing replaces any
  other agent that runs a watcher, because two of them fight over the same lock
  for ever. `tokenflow watch --status` now reports the agent's state and warns
  about conflicts.
- `tokenflow reset --source <id> --yes` — forget one source and re-read it from
  scratch on the next refresh, leaving every other source untouched. This is the
  repair path for a store holding data from an adapter that has since been
  fixed.

### Changed

- `tokenflow setup` now installs the watcher agent on macOS, so live data works
  without hand-rolling a LaunchAgent. `--no-agent` opts out, and the install is
  announced rather than silent. On other platforms it prints the systemd/cron
  equivalent instead.
- A dead watcher no longer leaves its identity in the status file, so a paused
  TokenFlow cannot report itself as live.

### Repairing an affected store

A store that ingested the inflated Hermes records keeps them until it is told
to re-read the source:

```sh
tokenflow reset --source hermes --yes
tokenflow refresh
```

The Hermes database still holds the truth, so nothing is lost. On the corpus
this was found on, the re-read reconciled exactly — 1,568 source rows to 1,568
records, every token field matching — and the affected day fell from 39.9B to
2.35B, with usage returning to the days it actually happened on.
