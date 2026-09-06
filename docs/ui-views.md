# Dashboard views and server routes

Add a tab to the dashboard, and an API endpoint to serve it, without editing
`src/ui/app.js` or `src/server/server.js`.

Two registries do this:

| Registry | File | Adds |
| --- | --- | --- |
| Views | `src/ui/views/index.js` | a tab in the dashboard |
| Routes | `src/server/routes/index.js` | an endpoint on the local server |

`src/ui/views/live.js` is the worked example. Read it next to this page.

## Add a view in four steps

1. Write `src/ui/views/<name>.js` with the exports below.
2. Write `src/ui/styles/<name>.css` if the tab needs styles of its own.
3. Import the module in `src/ui/views/index.js` and add it to `VIEWS`.
4. Run the dashboard and open `#tab=<your id>`.

Nothing else changes. app.js merges your tab into the tab bar, links your
stylesheet in development, inlines it into the offline snapshot, and routes the
deep link to you.

## The view module

```js
import { el } from '../charts.js';

export const id = 'burn';            // required, unique
export const label = 'Burn rate';    // required, the tab caption
export const order = 45;             // required, position in the tab bar
export const css = './styles/burn.css';  // optional, relative to src/ui/

export function view(ctx) {          // required, returns one element
  return el('div', { class: 'grid' }, [ctx.sectionTitle('Burn rate')]);
}

export function onEnter(ctx) {}      // optional, the tab became active
export function onLeave(ctx) {}      // optional, the tab stopped being active
```

**`id`** must not collide with a built-in tab or another view. app.js drops a
module with a duplicate or missing id, logs to the console, and keeps every
other tab working.

**`order`** places the tab. The built-in tabs hold these numbers:

| Order | Tab | | Order | Tab |
| --- | --- | --- | --- | --- |
| 10 | Overview | | 95 | Cache health (registered) |
| 20 | Receipts | | 100 | Cost |
| 25 | Session anatomy (registered) | | 105 | What-if (registered) |
| 30 | Live (registered) | | 110 | Productivity |
| 40 | Providers | | 115 | Rhythm (registered) |
| 50 | Models | | 120 | Compare |
| 60 | Interfaces | | 125 | Compare branches (registered) |
| 70 | Time patterns | | 130 | Data explorer |
| 80 | Peaks | | 135 | Annotations (registered) |
| 90 | Efficiency | | 140 | Data health |

They are spaced by 10, so pick a number between two of them. Ties break on id.

**`view(ctx)`** returns one `HTMLElement`. It runs on every render, which means
on every filter change, every theme change, and every tab entry. Keep it a pure
function of `ctx` and cheap. If it throws, app.js shows a banner in that tab
only and logs the error, so a broken view costs its own tab and nothing else.

**`onEnter` / `onLeave`** fire when the active tab changes, including on the
first paint and on a deep link. Use them for work that should happen once per
visit rather than once per render.

**Never import `src/ui/app.js`.** Everything you may use arrives in `ctx`. The
offline snapshot bundler needs an acyclic module graph, and a view that imports
app.js makes it cyclic. Importing `../charts.js`, `../../core/units.js`, or any
other leaf module is fine.

## The ViewContext

app.js builds a fresh `ctx` for every render. `bundle`, `view` and `filters` are
getters over live state, so a `ctx` you keep in a closure never goes stale.

### State

| Field | What it is |
| --- | --- |
| `S` | the whole dashboard state. Read freely. Write only fields you own. |
| `bundle` | the aggregate bundle the page loaded. |
| `view` | the computed analytics view for the current filters. This is what most tabs read. |
| `filters` | the active filter object, the same object as `S.filters`. |
| `snapshot` | `true` when the page is a saved offline file. |

### Building the page

| Helper | Use |
| --- | --- |
| `el(tag, attrs, kids)` | build an element. `text:` sets textContent, never HTML. |
| `card(title, hint, body, actions)` | the standard card. |
| `chartCard(id, title, hint, renderChart, tableSpec, extraActions)` | a chart with its table twin. Every chart needs one. |
| `btn(label, onClick, cls, id)` | a button. |
| `kpi(label, value, sub, opt)` | a KPI tile. |
| `deltaChip(change, opt)` | the up/down/flat change chip. |
| `sectionTitle(text)` | a section heading. |
| `emptyCard(text, detail)` | the empty state. |
| `openModal(title, body, foot)` / `closeModal()` | the shared dialog. |
| `drillTo(key, value)` | filter to one value and repaint. |
| `charts` | everything in `src/ui/charts.js` as a namespace. |

### Formatting

`ctx.fmt` holds the formatters from `src/core/units.js`, the same ones the CLI
uses: `compact`, `int`, `usd`, `pct`, `signedPct`, `shortDate`, `longDate`,
`hourLabel`, `hourWindow`, `relativeTime`, `humanDuration`, `countdown`, `DOW`.

Use them. A number formatted by hand will disagree with `tokenflow status`
sooner or later.

### Doing things

| Helper | Behaviour |
| --- | --- |
| `fetchJson(path, opt)` | resolves to the parsed JSON. In a snapshot it resolves to `null` instead of throwing. In the live dashboard it still rejects on an HTTP error, so catch it. |
| `schedule(fn, ms)` | an interval app.js clears for you. See the lifetimes below. |
| `rerender(opt)` | recompute the analytics view, then repaint. Pass `{ recompute: false }` to repaint only. |

`schedule` has two lifetimes, and which one you get depends on where you call it:

* Called from `onEnter`, the interval runs until the tab is left.
* Called from `view()`, the interval is replaced on the next render. That is
  deliberate: `view()` runs again on every filter change, and a single-lifetime
  timer would stack a duplicate each time.

Both are cleared when the tab is left. You never call `clearInterval` yourself.

**Register `ctx.schedule` synchronously in `onEnter`, before any `await`.** app.js decides which
interval belongs to which tab visit at the moment `onEnter` is called, not when it eventually
finishes, so a call made after an `await` may register against a tab the user has already left.
`src/ui/views/live.js` is the one registered view that polls, and it calls `ctx.schedule` as the
very first thing its synchronous (non-`async`) `onEnter` does, before starting its own fetch.
`cache.js` and `anatomy.js` also keep `onEnter` synchronous, though neither calls `schedule`;
`annotations.js`'s `onEnter` is `async` but never calls `schedule` either, so the ordering hazard
does not apply to it. A view that needs both `async` work and a recurring poll should call
`ctx.schedule` before its first `await`, not after a fetch resolves.

## Working offline

Half the value of this dashboard is the saved HTML file. `tokenflow export
--html` writes one self-contained page that opens from `file://` with no server
and no network. Your view is inside it, so it must work there.

The rule is simple: **anything that needs the server must be optional.**

`ctx.snapshot` tells you which world you are in. Follow the Data explorer
(`viewExplorer` and `loadExplorer` in app.js), which is the reference pattern:

```js
let rows = [];

export async function onEnter(ctx) {
  if (ctx.snapshot) {
    // Read what the exporter embedded. Never call the API.
    rows = (window.__TOKENFLOW_RECORDS__ || []).slice(0, 50);
  } else {
    const res = await ctx.fetchJson('/api/records?limit=50');
    rows = res.rows;
  }
  ctx.rerender({ recompute: false });
}
```

Three things fall out of that:

* **Branch on `ctx.snapshot` before the call, not in a `catch`.** A snapshot has
  no server. Trying and failing is slow and noisy.
* **Hide controls that cannot work.** The Live view drops its "Manage limits"
  button in a snapshot, because saving writes to the API. Live also hides the
  whole "Real-time engine" card, because a file has no watcher.
* **Everything in `ctx.bundle` and `ctx.view` is already there.** The exporter
  embeds the bundle, so any tab computed purely from it works offline with no
  extra effort.

If a whole tab is meaningless offline, render `ctx.emptyCard()` with a sentence
saying why. Do not render a dead control.

## CSS

**One file per view, at `src/ui/styles/<view>.css`.** Name it after the view.
Set `css: './styles/<view>.css'` in the module. Do not add rules to
`src/ui/styles.css`.

* In development app.js injects one `<link>` per view, once, before the data
  loads.
* In a snapshot `src/export/html-snapshot.js` inlines `styles.css` first, then
  every file in `src/ui/styles/` in name order.

Both paths pick your file up automatically. There is no list to update.

**Use the token variables only.** They come from the generated block at the top
of `src/ui/styles.css`, which is built from `design/tokens.yaml`. No raw hex, no
`rgb()` literals. Colours carry meaning across three skins and two modes, and a
literal breaks in five of the six combinations.

* surfaces: `--surface-1`, `--surface-2`, `--border`, `--hairline`
* text: `--text-primary`, `--text-muted`
* data series: `--series-1` to `--series-8`, `--seq-1` to `--seq-7`
* status only: `--good`, `--warning`, `--critical`

Status colours mark status. A chart series never uses one.

Keep motion at 300ms or less, and ease out.

Prefix your class names with the view id if there is any chance of a clash. All
view stylesheets load together, in every mode, so `.row` will find someone
else's `.row`.

## Server routes

`src/server/routes/index.js` exports `ROUTES`. Push an entry and the local
server serves it:

```js
export const ROUTES = [
  {
    method: 'GET',
    path: '/api/burn',
    handler: (req, res, url, ctx) => ctx.json({ rate: 42 }),
  },
];
```

`path` is matched exactly. `method` is matched case insensitively. There is no
pattern syntax: use a query string, which `url.searchParams` already parsed for
you. The handler owns the response from the moment it is called, and nothing
after it runs.

On disk, a route module exports either one `Route` object or an array named
`<NAME>_ROUTES`, and `src/server/routes/index.js` spreads it into `ROUTES`:

```js
// src/server/routes/index.js
import { ANNOTATIONS_ROUTES } from './annotations.js';
import { SESSION_ROUTE } from './session.js';

export const ROUTES = [...ANNOTATIONS_ROUTES, SESSION_ROUTE];
```

### A worked example: `GET /api/session`

`src/server/routes/session.js` is the reference a request-level route follows. It backs the
Session anatomy tab, which needs one session's turn-by-turn records — the one thing the bundle
never carries, because request-level data is too large to ship on every page load.

```js
// GET /api/session?id=<sessionId>
export const SESSION_ROUTE = {
  method: 'GET',
  path: '/api/session',
  handler: (req, res, url, ctx) => {
    const id = url.searchParams.get('id');
    if (!id) return ctx.json({ error: 'id is required' }, 400);
    // ...find the session's date range, scan only the months it touches,
    // slim each record to an allow-listed shape, then:
    ctx.json({ id, session, months, scanned, total, returned, cap, truncated, records });
  },
};
```

Three things worth copying: the response body is an **allow-list** of fields (`slim()` in
`session.js` names each one explicitly, so a metadata field added upstream later cannot leak in by
default); the record count is **capped** (`RECORD_CAP`, 5000) and the cap, the true total and
whether it was hit all travel in the body rather than silently truncating; and the store scan is
**narrowed** to only the months the session's own date range touches, never the whole store.

### Handler ctx

| Field | What it does |
| --- | --- |
| `json(body, code)` | send JSON, default 200. |
| `send(code, type, body)` | send anything else. |
| `sendFile(file)` | stream a file from disk. |
| `readBody()` | resolves to the request body as text. |
| `config` | the loaded config. Read lazily and cached for this request. |
| `paths` | the resolved store paths. Same. |
| `buildBundle()` | the aggregate bundle the UI loads. |
| `queryRecords(query)` | the record query behind `/api/records`. |
| `root` | the repository root. |
| `host`, `port` | what the server actually bound, correct even for port 0. |

Throwing from a handler is safe. The server logs it and answers 500.

### Rules

* **Do not take a built-in path.** Registered routes are dispatched first, so a
  clash would silently shadow `/api/bundle` or `/api/config` and break the whole
  page. The server prints a warning at startup if you do. Reserved: `/`,
  `/index.html`, everything under `/src/`, and `/api/bundle`, `/api/health`,
  `/api/ping`, `/api/providers`, `/api/records`, `/api/live`, `/api/geo`,
  `/api/config`, `/api/export.csv`, `/api/refresh`, `/api/pricing`,
  `/api/prefs`.
* **Anything that changes state must be POST.** The server applies its
  same-origin and token check to every non-GET request, before dispatch.
  Registered GET routes get exactly what inline GET routes get, which is
  loopback binding and nothing more. A GET that mutates is unprotected.
* **Stay local.** No outbound network calls, no telemetry, and never read prompt
  or code content. These hold everywhere in this product and a route is not an
  exception.
* **A route is never the only way to get the data.** The snapshot has no server.
  If your tab needs a route to say anything at all, it is a tab that does not
  work offline, so make it degrade as described above.

## Checklist before you hand a view over

* [ ] `id`, `label`, `order`, `view` exported. `id` unique.
* [ ] Module added to `VIEWS` in `src/ui/views/index.js`.
* [ ] No import of `src/ui/app.js`.
* [ ] Styles in `src/ui/styles/<view>.css`, token variables only.
* [ ] Every chart has a table twin through `chartCard`.
* [ ] Opens correctly from `#tab=<id>`.
* [ ] `tokenflow export --html`, then open the file from `file://`. The tab
      renders, with no console errors.
* [ ] `npm run lint` and `node --test test/<yours>.test.js` pass.
