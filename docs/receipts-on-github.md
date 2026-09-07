# Receipts on GitHub: comment, budget, merge gate

The [GitHub Action](../action/README.md) reads the receipt a pushed commit already carries
as a git note (`refs/notes/tokenflow`, written by `tokenflow hooks install`'s pre-push hook),
posts or updates it as one pull request comment, and can fail the job when the receipt is
over a budget you declare. A failed job is a status check, and a status check is what a
branch protection rule or a repository ruleset can require before a merge - that is the whole
mechanism this page documents, at three levels: one repository, an organization, and the
GitHub Marketplace listing itself.

**What leaves your machine:** the action reads the git note already in your checkout and the
policy file already in your checkout, and talks to the GitHub REST API to read/post/patch one
PR comment. It writes the job's outputs and step summary to files on the runner, not over the
network. Nothing else leaves - it never reads prompt or code content, and it makes no other
network call.

## Per-repository install

1. Everyone who pushes to the pull request needs the receipt-writing hook installed once:

   ```bash
   tokenflow hooks install
   ```

   A push from someone without the hook carries no note, so the action logs one line and
   exits 0 for that push - a missing receipt is never itself a merge blocker.

2. Add the workflow (`.github/workflows/tokenflow-receipt.yml`):

   ```yaml
   name: TokenFlow receipt

   on:
     pull_request:

   permissions:
     contents: read
     pull-requests: write

   jobs:
     receipt:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0   # notes live outside the default shallow fetch
         - uses: vimoxshah/tokenflow@v1.3.4
           with:
             max-usd: '50'
             max-usd-per-100-lines: '5'
   ```

   Leave `max-usd` / `max-usd-per-100-lines` unset to read the same caps from a committed
   policy file instead (below) - useful when different repositories in an organization need
   different caps but should all run the same workflow file.

3. Require the check: **Settings > Branches > Branch protection rules** (or **Rulesets** for
   a repository-level ruleset) for the target branch, turn on **Require status checks to pass
   before merging**, and add `receipt` - that is this workflow's job name (see
   [action/README.md](../action/README.md) for the full input/output reference).

With this in place, a pull request whose head commit carries an over-budget receipt fails the
`receipt` check and cannot merge while the branch protection rule requires it - that is the
merge gate.

## Declaring the cap in a committed policy file instead of the workflow

`.tokenflow/policy.yaml` already exists in this codebase for `guard`'s per-repository
thresholds (see [guard-codex.md](guard-codex.md)); the action reads a sibling `receipt:` key
from the same file, so one committed file can hold both:

```yaml
# <repo root>/.tokenflow/policy.yaml
guard:
  maxCostUsd: 50
receipt:
  maxCostUsd: 50
  maxCostPer100Lines: 5
```

The action reads `receipt.maxCostUsd` and `receipt.maxCostPer100Lines` only when the matching
workflow input (`max-usd` / `max-usd-per-100-lines`) is left empty; a workflow input always
wins over the policy file for that one cap. A missing policy file, a malformed one, or a value
that is not a positive number all mean no cap from that source - never a crash. The path is
read relative to the checkout, so it must be `git checkout`ed before this action's step runs
(the usual `actions/checkout@v4` step above already does that).

A cap is exceeded only when the measured value is strictly greater than it; equal to the cap
counts as within budget. `costPer100Lines` is `null` on every receipt the pre-push hook writes,
because it is only populated by `tokenflow receipt --gh` once a pull request exists to scale
against, so a `max-usd-per-100-lines` cap on a hook-written receipt reports "not evaluated",
not a false pass or fail.

## Org-wide install

Whether an organization-level ruleset can require this same status check across every
repository, without repeating the branch protection rule per repository, depends on the
plan:

- **Repository rulesets** (an alternative to branch protection for the "require status
  checks" rule used in step 3 above) are available on **public** repositories under GitHub's
  Free plan; on **private or internal** repositories they require GitHub Pro, Team, or GitHub
  Enterprise Cloud.
- **Organization-level** rulesets - the ones that apply to many repositories at once, rather
  than being configured per repository - are documented as configurable "at the organization
  or enterprise level"; GitHub's own plan-gating docs for rulesets in general point to Team
  (private/internal repos) or GitHub Enterprise Cloud, the same floor as the repository-level
  case above, and did not additionally single out the "workflows" rule as needing a higher
  plan. That said, this was not exhaustively confirmed against every plan combination, so
  verify it against your organization's actual plan before relying on it, and use the
  per-repository fallback below if it does not apply.
- The workflow file the ruleset points at must live in a repository whose visibility is at
  least as open as every repository it is required against (a public workflow can be
  required anywhere in the organization; an internal or private one only on repositories of
  matching or narrower visibility), and access to it must be explicitly granted from outside
  its own repository when that visibility differs.

**Fallback available on every plan:** per-repository branch protection (not an
organization-level ruleset) requiring the status check by job name, exactly as in step 3
above, repeated once per repository. It is more to set up across many repositories, but it
depends on no plan beyond what running Actions itself already requires.

## Publishing to the GitHub Marketplace

The Marketplace requires the action's metadata file at the **repository root**, so this repo
keeps two: `/action.yml` at the root (what a Marketplace listing and a plain
`uses: <owner>/<repo>@<ref>` resolve to) and `action/action.yml` (what `uses: ./action`
resolves to, for dogfooding this repo's own checkout). The two are kept in sync by hand;
`test/action.test.js` parses both and asserts they match except for `runs.main`, which is
`action/index.js` at the root and `index.js` under `action/`.

Publishing itself happens from a GitHub release, not from a command: on the repository's
**Releases** page, drafting a new release offers a "Publish this Action to the GitHub
Marketplace" checkbox (visible once `action.yml`/`action.yaml` is present at the root and the
repository is public) - checking it and publishing the release is what lists the version on
the Marketplace. There is no separate CLI step; the release **is** the publish action.
