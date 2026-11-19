import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GET } from './route';

const { writeRawQuery, isRelationalOnly } = vi.hoisted(() => ({
  writeRawQuery: vi.fn(),
  isRelationalOnly: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: { writeRawQuery } }));
vi.mock('@/lib/db', () => ({ isRelationalOnly }));

const SECRET = 'test-cron-secret';
const URL = 'http://localhost/api/cron/retention';

const request = (authorization?: string, url = URL) =>
  new Request(url, { headers: authorization ? { authorization } : {} });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('RETENTION_MONTHS', '');
  writeRawQuery
    .mockReset()
    .mockImplementation(async (sql: string) =>
      sql.includes('with recursive ids') ? [] : [{ count: 0 }],
    );
  isRelationalOnly.mockReset().mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('401 without CRON_SECRET configured', async () => {
  vi.stubEnv('CRON_SECRET', '');

  const response = await GET(request('Bearer '));

  expect(response.status).toBe(401);
  expect(writeRawQuery).not.toHaveBeenCalled();
});

test('401 without or with a wrong authorization header', async () => {
  expect((await GET(request())).status).toBe(401);
  expect((await GET(request('Bearer wrong'))).status).toBe(401);
  expect((await GET(request(SECRET))).status).toBe(401);
  expect(writeRawQuery).not.toHaveBeenCalled();
});

test('500 and no deletes for an invalid RETENTION_MONTHS', async () => {
  vi.stubEnv('RETENTION_MONTHS', '0');

  const response = await GET(request(`Bearer ${SECRET}`));

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ ok: false });
  expect(writeRawQuery).not.toHaveBeenCalled();
});

test('runs with the default of 14 months and reports deleted rows', async () => {
  const response = await GET(request(`Bearer ${SECRET}`));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ ok: true, dryRun: false, retentionMonths: 14, done: true });
  expect(body.deleted).toMatchObject({ website_event: 0, session: 0 });
  expect(typeof body.durationMs).toBe('number');
  expect(writeRawQuery).toHaveBeenCalled();
});

test('dryRun=1 returns counts and never deletes', async () => {
  vi.stubEnv('RETENTION_MONTHS', '6');

  const response = await GET(request(`Bearer ${SECRET}`, `${URL}?dryRun=1`));
  const body = await response.json();

  expect(body).toMatchObject({ ok: true, dryRun: true, retentionMonths: 6 });
  expect(body.wouldDelete).toBeDefined();
  expect(body.deleted).toBeUndefined();

  for (const [sql] of writeRawQuery.mock.calls) {
    expect(sql).not.toMatch(/delete from/i);
  }
});

test('skips when ClickHouse is configured', async () => {
  isRelationalOnly.mockReturnValue(false);

  const response = await GET(request(`Bearer ${SECRET}`));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, skipped: expect.any(String) });
  expect(writeRawQuery).not.toHaveBeenCalled();
});

test('500 with a generic message when the database fails', async () => {
  writeRawQuery.mockRejectedValue(new Error('connection to secret-host failed'));

  const response = await GET(request(`Bearer ${SECRET}`));
  const body = await response.json();

  expect(response.status).toBe(500);
  expect(JSON.stringify(body)).not.toContain('secret-host');
});
