import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_RETENTION_MONTHS,
  getRetentionCutoff,
  isAuthorizedCronRequest,
  isDryRun,
  parseRetentionMonths,
  RETENTION_STEPS,
  type RetentionQuery,
  runRetention,
} from './retention';

describe('parseRetentionMonths', () => {
  test.each([undefined, null, '', '   '])('falls back to the default for %j', value => {
    expect(parseRetentionMonths(value)).toEqual({ ok: true, months: DEFAULT_RETENTION_MONTHS });
  });

  test.each([
    ['1', 1],
    ['14', 14],
    [' 6 ', 6],
    ['1200', 1200],
  ])('accepts %j', (value, months) => {
    expect(parseRetentionMonths(value)).toEqual({ ok: true, months });
  });

  test.each(['0', '-1', '14.5', '1e2', 'abc', '24x', '1201'])('rejects %j', value => {
    expect(parseRetentionMonths(value)).toMatchObject({ ok: false });
  });

  test('default is 14 months', () => {
    expect(DEFAULT_RETENTION_MONTHS).toBe(14);
  });
});

describe('getRetentionCutoff', () => {
  const cutoff = (now: string, months: number) =>
    getRetentionCutoff(new Date(now), months).toISOString();

  test('subtracts calendar months and starts at UTC midnight', () => {
    expect(cutoff('2026-11-20T17:45:12.000Z', 14)).toBe('2025-09-20T00:00:00.000Z');
  });

  test('wraps across years', () => {
    expect(cutoff('2026-01-15T03:15:00.000Z', 14)).toBe('2024-11-15T00:00:00.000Z');
    expect(cutoff('2026-03-01T00:00:00.000Z', 3)).toBe('2025-12-01T00:00:00.000Z');
  });

  test('clamps to the last day of shorter months', () => {
    expect(cutoff('2026-05-31T12:00:00.000Z', 3)).toBe('2026-02-28T00:00:00.000Z');
    expect(cutoff('2028-05-31T12:00:00.000Z', 3)).toBe('2028-02-29T00:00:00.000Z');
    expect(cutoff('2026-12-31T12:00:00.000Z', 14)).toBe('2025-10-31T00:00:00.000Z');
  });

  test('uses the UTC date, not the local one', () => {
    // 23:30 in New York is already the next day in UTC.
    expect(cutoff('2026-11-20T23:30:00-05:00', 1)).toBe('2026-10-21T00:00:00.000Z');
  });

  test('is stable during the whole UTC day', () => {
    expect(cutoff('2026-11-20T00:00:00.000Z', 14)).toBe(cutoff('2026-11-20T23:59:59.999Z', 14));
  });
});

describe('isAuthorizedCronRequest', () => {
  const secret = 'a'.repeat(64);

  test('accepts the exact bearer header', () => {
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, secret)).toBe(true);
  });

  test.each([undefined, '', '   '])('rejects everything when CRON_SECRET is %j', value => {
    expect(isAuthorizedCronRequest('Bearer ', value)).toBe(false);
    expect(isAuthorizedCronRequest('Bearer undefined', value)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${value}`, value)).toBe(false);
  });

  test.each([
    null,
    '',
    secret,
    `bearer ${secret}`,
    `Bearer ${secret} `,
    `Bearer ${secret.slice(1)}`,
    `Basic ${secret}`,
  ])('rejects %j', header => {
    expect(isAuthorizedCronRequest(header, secret)).toBe(false);
  });
});

describe('isDryRun', () => {
  test.each([
    ['http://x/api/cron/retention?dryRun=1', true],
    ['http://x/api/cron/retention?dryRun=true', true],
    ['http://x/api/cron/retention?dryRun=0', false],
    ['http://x/api/cron/retention', false],
  ])('%s -> %s', (url, expected) => {
    expect(isDryRun(url)).toBe(expected);
  });
});

/** Fake executor: answers website-id listings with `websites`, deletes with `count`. */
function fakeDb(respond: (sql: string, call: number) => Record<string, any> = () => ({})) {
  const statements: string[] = [];
  const query: RetentionQuery = vi.fn(async (sql: string) => {
    statements.push(sql);

    if (sql.includes('with recursive ids')) {
      return [{ website_id: '00000000-0000-0000-0000-000000000001' }];
    }

    return [{ count: 0, ...respond(sql, statements.length) }];
  });

  const deletedTables = () =>
    statements.flatMap(sql => [...sql.matchAll(/delete from (\w+)/g)].map(match => match[1]));

  return { query, statements, deletedTables };
}

const cutoff = new Date('2025-09-20T00:00:00.000Z');
const farFuture = Number.MAX_SAFE_INTEGER;

describe('runRetention', () => {
  test('deletes dependent data before the rows it refers to', async () => {
    const db = fakeDb();
    const result = await runRetention({ query: db.query, cutoff, deadline: farFuture });

    expect(result).toMatchObject({ done: true, pending: [], cutoff: cutoff.toISOString() });

    const order = [...new Set(db.deletedTables())];
    const expectBefore = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));

    expectBefore('event_data', 'website_event');
    expectBefore('revenue', 'website_event');
    expectBefore('website_event', 'session');
    expectBefore('session_replay', 'session_replay_saved');
    expectBefore('error_event', 'error_issue');
    expectBefore('session_data', 'session');
    expectBefore('session_link', 'session');
    expect(RETENTION_STEPS.at(-1)).toBe('session_data_orphans');
  });

  test('never touches configuration tables', async () => {
    const db = fakeDb();
    await runRetention({ query: db.query, cutoff, deadline: farFuture });

    const config = ['website', 'user', 'team', 'team_user', 'report', 'segment', 'board'];
    const extra = ['link', 'pixel', 'share', 'annotation', 'api_key', 'app_setting'];

    for (const table of [...config, ...extra]) {
      expect(db.deletedTables()).not.toContain(table);
    }
  });

  test('passes the cutoff and batch size as parameters', async () => {
    const db = fakeDb();
    await runRetention({ query: db.query, cutoff, batchSize: 1234, deadline: farFuture });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('{{cutoff::timestamptz}}'),
      expect.objectContaining({ cutoff: '2025-09-20T00:00:00.000Z', limit: 1234 }),
    );
  });

  test('repeats a batch until fewer rows than the batch size are deleted', async () => {
    let eventDataBatches = 0;
    const db = fakeDb(sql => {
      if (sql.includes('select event_data_id from event_data')) {
        eventDataBatches += 1;
        return { count: eventDataBatches < 3 ? 10 : 4 };
      }
      return {};
    });

    const result = await runRetention({
      query: db.query,
      cutoff,
      batchSize: 10,
      deadline: farFuture,
    });

    expect(eventDataBatches).toBe(3);
    expect(result.rows.event_data).toBe(24);
    expect(result.done).toBe(true);
  });

  test('sums rows deleted alongside events and sessions', async () => {
    const db = fakeDb(sql => {
      if (sql.includes('select event_id from website_event')) {
        return { count: 3, event_data: 2 };
      }
      if (sql.includes('select s.session_id, s.website_id from session s')) {
        return { count: 5, session_data: 7, session_link: 1 };
      }
      return {};
    });

    const result = await runRetention({ query: db.query, cutoff, deadline: farFuture });

    expect(result.rows).toMatchObject({
      website_event: 3,
      event_data: 2,
      session: 5,
      session_data: 7,
      session_link: 1,
    });
  });

  test('stops starting batches at the deadline and reports pending steps', async () => {
    let now = 0;
    const db = fakeDb(sql => {
      if (sql.includes('select event_id from website_event')) {
        now += 100; // every batch "takes" 100ms and is always full
        return { count: 10 };
      }
      return {};
    });

    const result = await runRetention({
      query: db.query,
      cutoff,
      batchSize: 10,
      deadline: 250,
      now: () => now,
    });

    expect(result.done).toBe(false);
    expect(result.rows.website_event).toBe(30);
    expect(result.pending[0]).toBe('website_event');
    expect(result.pending).toContain('session');
    expect(db.deletedTables()).not.toContain('session');
  });

  test('does nothing when called after the deadline', async () => {
    const db = fakeDb();
    const result = await runRetention({ query: db.query, cutoff, deadline: 0, now: () => 1 });

    expect(result.done).toBe(false);
    expect(result.pending).toEqual(RETENTION_STEPS);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('dry run only counts', async () => {
    const db = fakeDb(() => ({ count: 2, session_data: 1, session_link: 1 }));
    const result = await runRetention({
      query: db.query,
      cutoff,
      dryRun: true,
      deadline: farFuture,
    });

    expect(result.dryRun).toBe(true);
    expect(result.done).toBe(true);
    expect(db.deletedTables()).toEqual([]);
    expect(db.statements.every(sql => /^\s*(select|with)/i.test(sql))).toBe(true);
    expect(result.rows.website_event).toBe(2);
    expect(result.rows.session_data).toBe(1 + 2); // data of doomed sessions + orphans
  });
});
