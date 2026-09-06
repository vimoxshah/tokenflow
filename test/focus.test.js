/**
 * FOCUS-shaped export: receipt rows, daily-sync rows, the CSV writer's
 * escaping, and the estimate marker every row must carry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  focusRowsFromReceipts, focusRowsFromDaily, toCsv, vendorFromModel,
  FOCUS_COLUMNS, ESTIMATE_NOTE,
} from '../src/export/focus.js';

/** A receipt.v1-shaped fixture; override anything. */
function receiptFixture(o = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-05T00:00:00.000Z',
    toolVersion: '1.3.0',
    repo: 'tokenflow',
    branch: 'feat/x',
    headSha: 'abc1234',
    window: { first: '2026-08-01T10:00:00.000Z', last: '2026-08-03T09:00:00.000Z' },
    costUsd: 12.5,
    contextShare: 0.4,
    turns: 7,
    sessions: 2,
    subagentTurns: 1,
    models: [{ model: 'Claude Opus 5', costUsd: 12.5, share: 1 }],
    coverage: 1,
    largestPromptTokens: 250_000,
    changedLines: 400,
    pr: { number: 42, mergedAt: '2026-08-03T00:00:00Z' },
    longLived: false,
    costPer100Lines: 3.125,
    notes: ['Estimated locally by TokenFlow.'],
    ticket: null,
    verdict: null,
    ...o,
  };
}

// -------------------------------------------------------- vendorFromModel ---

test('vendorFromModel: recognizes known model families and falls back to the raw string otherwise', () => {
  assert.equal(vendorFromModel('Claude Opus 5'), 'Anthropic');
  assert.equal(vendorFromModel('gpt-5-codex'), 'OpenAI');
  assert.equal(vendorFromModel('gemini-2.5-pro'), 'Google');
  assert.equal(vendorFromModel('Mystery Model 9000'), 'Mystery Model 9000');
  assert.equal(vendorFromModel(null), null);
  assert.equal(vendorFromModel(undefined), null);
  assert.equal(vendorFromModel(''), null);
});

// -------------------------------------------------------- focusRowsFromReceipts ---

test('focusRowsFromReceipts: one row per receipt, every FOCUS column present', () => {
  const rows = focusRowsFromReceipts([receiptFixture(), receiptFixture({ branch: 'feat/y' })]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const col of FOCUS_COLUMNS) assert.ok(col in row, `row is missing FOCUS column "${col}"`);
  }
});

test('focusRowsFromReceipts: maps cost, window, resource, and service columns from the receipt', () => {
  const [row] = focusRowsFromReceipts([receiptFixture()]);
  assert.equal(row.BilledCost, 12.5);
  assert.equal(row.EffectiveCost, 12.5);
  assert.equal(row.ListCost, 12.5);
  assert.equal(row.ContractedCost, 12.5);
  assert.equal(row.BillingCurrency, 'USD');
  assert.equal(row.ChargeCategory, 'Usage');
  assert.equal(row.PricingCategory, 'Standard');
  assert.equal(row.ChargeDescription, ESTIMATE_NOTE);
  assert.equal(row.ChargePeriodStart, '2026-08-01T10:00:00.000Z');
  assert.equal(row.ChargePeriodEnd, '2026-08-03T09:00:00.000Z');
  assert.equal(row.ConsumedQuantity, 7, 'documented deviation: turns, not a token total (see focus.js and docs/focus-export.md)');
  assert.equal(row.ConsumedUnit, 'turns');
  assert.equal(row.ProviderName, 'Anthropic');
  assert.equal(row.ServiceName, 'Coding agent tokens');
  assert.equal(row.ServiceCategory, 'AI and Machine Learning');
  assert.equal(row.ResourceId, 'tokenflow#feat/x');
  assert.equal(row.ResourceName, 'feat/x');
  assert.equal(row.ResourceType, 'branch');
});

test('focusRowsFromReceipts: Tags is a JSON object string carrying repo, branch, headSha, toolVersion, and an estimate marker', () => {
  const [row] = focusRowsFromReceipts([receiptFixture()]);
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.repo, 'tokenflow');
  assert.equal(tags.branch, 'feat/x');
  assert.equal(tags.headSha, 'abc1234');
  assert.equal(tags.toolVersion, '1.3.0');
  assert.equal(tags.costBasis, 'estimated');
});

test('focusRowsFromReceipts: a ticket carries its key into Tags; absent when the receipt has no ticket', () => {
  const withTicket = receiptFixture({ ticket: { system: 'jira', key: 'ENG-123', url: 'https://x/ENG-123' } });
  const [rowWithTicket] = focusRowsFromReceipts([withTicket]);
  assert.equal(JSON.parse(rowWithTicket.Tags).ticket, 'ENG-123');

  const [rowNoTicket] = focusRowsFromReceipts([receiptFixture()]);
  assert.equal('ticket' in JSON.parse(rowNoTicket.Tags), false);
});

test('every row carries an estimate marker (ChargeDescription and Tags.costBasis), never silently omitted', () => {
  const [row] = focusRowsFromReceipts([receiptFixture()]);
  assert.match(row.ChargeDescription, /estimate/i);
  assert.equal(JSON.parse(row.Tags).costBasis, 'estimated');
});

test('focusRowsFromReceipts: a receipt with no priced turns and no window emits a row with empty cells, never a skipped row or an invented 0', () => {
  const noCost = receiptFixture({ costUsd: null, window: null, turns: 0 });
  const rows = focusRowsFromReceipts([noCost]);
  assert.equal(rows.length, 1, 'a row is still produced');
  assert.equal(rows[0].BilledCost, null);
  assert.equal(rows[0].ChargePeriodStart, null);
  assert.equal(rows[0].ChargePeriodEnd, null);
  assert.equal(rows[0].ConsumedQuantity, 0);
});

test('focusRowsFromReceipts: an empty/undefined receipts array yields no rows', () => {
  assert.deepEqual(focusRowsFromReceipts([]), []);
  assert.deepEqual(focusRowsFromReceipts(undefined), []);
});

// -------------------------------------------------------- focusRowsFromDaily ---

/** A daily sync-ledger fixture (src/core/sync.js's <machineId>.jsonl line shape); override anything. */
function dailyFixture(o = {}) {
  return {
    machineId: 'm-abc123', machineName: 'MacBook Pro', date: '2026-08-20',
    inputTokens: 40_000, outputTokens: 10_000, requests: 12, estCostUsd: 3.4567,
    ...o,
  };
}

test('focusRowsFromDaily: one row per machine-day, every FOCUS column present', () => {
  const rows = focusRowsFromDaily([dailyFixture(), dailyFixture({ date: '2026-08-21' })]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const col of FOCUS_COLUMNS) assert.ok(col in row, `row is missing FOCUS column "${col}"`);
  }
});

test('focusRowsFromDaily: maps tokens, cost, and the machine resource, and spans the whole calendar day', () => {
  const [row] = focusRowsFromDaily([dailyFixture()]);
  assert.equal(row.BilledCost, 3.4567);
  assert.equal(row.EffectiveCost, 3.4567);
  assert.equal(row.ConsumedQuantity, 50_000);
  assert.equal(row.ConsumedUnit, 'tokens');
  assert.equal(row.ChargePeriodStart, '2026-08-20T00:00:00.000Z');
  assert.equal(row.ChargePeriodEnd, '2026-08-21T00:00:00.000Z');
  assert.equal(row.ResourceId, 'machine:MacBook Pro');
  assert.equal(row.ResourceName, 'MacBook Pro');
  assert.equal(row.ResourceType, 'machine');
  assert.equal(row.ProviderName, null, 'no per-model detail survives into the daily sync ledger');
});

test('focusRowsFromDaily: falls back to machineId when machineName is absent; developer reaches Tags only when set', () => {
  const anon = focusRowsFromDaily([dailyFixture({ machineName: undefined })]);
  assert.equal(anon[0].ResourceId, 'machine:m-abc123');
  assert.equal('developer' in JSON.parse(anon[0].Tags), false);

  const named = focusRowsFromDaily([dailyFixture({ developer: 'Vimox' })]);
  assert.equal(JSON.parse(named[0].Tags).developer, 'Vimox');
});

test('focusRowsFromDaily: missing token counts stay null, never an invented 0', () => {
  const rows = focusRowsFromDaily([dailyFixture({ inputTokens: undefined, outputTokens: undefined })]);
  assert.equal(rows[0].ConsumedQuantity, null);
});

// -------------------------------------------------------------------- toCsv ---

test('toCsv: header row is the FOCUS_COLUMNS list, in order', () => {
  const csv = toCsv(focusRowsFromReceipts([receiptFixture()]));
  const header = csv.split('\n')[0];
  assert.equal(header, FOCUS_COLUMNS.join(','));
});

/** Minimal quote-aware CSV line splitter, for asserting field COUNT survives internal commas/quotes. */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

test('toCsv: escapes a comma and a double quote inside a field (Tags is a JSON string, so it always has both)', () => {
  const csv = toCsv(focusRowsFromReceipts([receiptFixture()]));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2, 'header + one data row');
  const dataLine = lines[1];
  const tagsColIndex = FOCUS_COLUMNS.indexOf('Tags');
  assert.ok(tagsColIndex >= 0);
  // A JSON object serialized into one CSV cell must appear as a single
  // double-quoted field with its own quotes doubled — never split across
  // extra columns by an un-escaped comma.
  assert.match(dataLine, /"\{""repo"":""tokenflow"".*\}"/);
  // Despite the Tags cell containing several commas and many quotes of its
  // own, a quote-aware split still recovers exactly one field per column —
  // proof the escaping round-trips, not just that it "looks" quoted.
  const fields = splitCsvLine(dataLine);
  assert.equal(fields.length, FOCUS_COLUMNS.length);
  assert.deepEqual(JSON.parse(fields[tagsColIndex]), {
    repo: 'tokenflow', branch: 'feat/x', headSha: 'abc1234', toolVersion: '1.3.0', costBasis: 'estimated',
  });
});

test('toCsv: a value containing a comma and a quote is escaped correctly even outside Tags', () => {
  const weird = receiptFixture({ branch: 'feat/x, say "hi"' });
  const csv = toCsv(focusRowsFromReceipts([weird]));
  const dataLine = csv.trim().split('\n')[1];
  assert.match(dataLine, /"feat\/x, say ""hi"""/);
});

test('toCsv: an empty rows array still writes the header', () => {
  const csv = toCsv([]);
  assert.equal(csv, FOCUS_COLUMNS.join(',') + '\n');
});
