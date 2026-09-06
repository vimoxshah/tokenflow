# Tickets: cost per ticket

Every branch receipt (`tokenflow receipt`, the Receipts tab, the Compare branches tab) is
attributed to a branch. This page is about the layer above a branch: the ticket, task or issue
that branch was for, read from a key in the branch name or in the title of the pull request it
shipped in.

```
tokenflow tickets
```

groups every branch receipt that names the same ticket, across every repository and every
branch, and reports the total spend per ticket.

---

## What is matched

TokenFlow looks for a ticket key in two places, in this order:

1. The branch name.
2. If the branch name has no key, the title of the pull request it merged in (when a pull
   request is known: see [receipts-on-github.md](receipts-on-github.md) / `tokenflow receipt --gh`).

A branch with no key in either place is not guessed at. It stays in the **unattributed** bucket,
same as a receipt with no branch at all.

Three shapes are recognized:

| System | Shape | Example |
| --- | --- | --- |
| Jira / Linear | letters, a dash, two or more digits | `ENG-1234` |
| GitHub | `#123`, `gh-123`, `issue-123` or `issues/123` | `#123` |
| Custom | whatever regex you configure | n/a |

Jira and Linear share the exact same shape (a project prefix, a dash, a number), so which one a
match is labelled depends on `tickets.system` in your config. With no system configured, a
letters-dash-digits key is reported as `other` rather than guessed as Jira or Linear; a
GitHub-style reference (`#123`, `gh-123`, `issue-123`, `issues/123`) is unambiguous on its own
and is always labelled `github`, configured or not. The four GitHub spellings are treated as the
same ticket (`gh-123` and `issue-123` both become `#123`), so a repo that mixes conventions still
rolls up correctly.

**The two-or-more-digit rule, and why it exists.** A bare "letters, dash, digits" shape also
matches common technical terms that are not tickets at all. `UTF-8` is the standing example.
Requiring at least two digits in the number rules out `UTF-8` (and any single-digit ticket 1
through 9, which is the cost of the rule: an early ticket numbered under 10 will not be found).
It does **not** rule out every such term. `UTF-16` and `ISO-8859` still match, because they
happen to have two-or-more-digit suffixes too. This is a structural, best-effort filter, not a
list of known words; a real two-letter-or-more, two-digit-or-more project key can always look
like an unrelated acronym, and an unrelated acronym can always look like a project key.

## Config

```yaml
tickets:
  system: jira        # jira | linear | github | other | null (null = detect; see above)
  baseUrl: null        # e.g. https://acme.atlassian.net, https://linear.app/acme, https://github.com/acme/repo
  pattern: null         # a custom regex; wins over the built-in shapes when set
```

- `system` tells TokenFlow which built-in shape to look for, and how to label a match. Leave it
  `null` to auto-detect (see above).
- `baseUrl` builds a link to the ticket, when set:
  - Jira: `<baseUrl>/browse/<KEY>`
  - Linear: `<baseUrl>/issue/<KEY>`
  - GitHub: `<baseUrl>/issues/<n>`
  - No `baseUrl`, or `system: other`: no link, just the key.
- `pattern` is a regular expression (a string, not a `/…/` literal) tried instead of the built-in
  shapes. With one capture group, the group is the key; with none, the whole match is the key.

## The CLI

```
tokenflow tickets                every ticket, most expensive first
tokenflow tickets --top 10       narrow the printed table
tokenflow tickets --csv          one row per ticket, as CSV
tokenflow tickets --json         the full result as JSON
```

Uses the same records, price book and repository resolver as `tokenflow receipt`, so a ticket's
cost here always agrees with its branches' costs on the Receipts tab.

## The dashboard tab

**Tickets** (after Compare branches) shows:

- A KPI row: share of spend attributed to a ticket, ticket count, median ticket cost, the most
  expensive ticket, and the unattributed total.
- A bar chart of the top tickets by cost, with its table twin.
- A table of every ticket: key (linked to the tracker when a URL can be built), cost, turns,
  sessions, branch count, and last activity.

It reads `ctx.bundle.receipts` directly rather than the filtered view, the same as Compare
branches: a ticket's cost spans every branch that names it, not just what the current date range
shows. It needs no network call, so it renders the same in the live dashboard and in a saved
offline snapshot (`tokenflow export --html`).

## The honesty note

A ticket key in a branch name (or a PR title) is a convention, not a fact TokenFlow can verify.
Nothing here reads an issue tracker, so:

- A branch that never mentioned its ticket in its name stays unattributed here, even when a
  human looking at it would know exactly which ticket it was for.
- A key found in text is trusted as-is. TokenFlow never checks that the ticket actually exists,
  what it is titled, or who it is assigned to.
- The "share of total" figures divide against the same total the Receipts tab shows
  (`receipts.totals.cost`); a ticket's turn and session counts are summed from its branches, so a
  session that moved across two branches naming the same ticket is counted on both.
