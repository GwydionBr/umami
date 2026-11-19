/**
 * Vercel Cron: deletes analytics data older than RETENTION_MONTHS (default 14).
 *
 * Fork-only route. It lives in the `(cron)` route group instead of `src/app/api` so it is
 * served at /api/cron/retention without being picked up by Umami's OpenAPI generator
 * (which scans `src/app/api/**` only) and therefore stays out of the public API docs and
 * the generated API client.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (sent automatically by Vercel Cron).
 * Query: `?dryRun=1` only counts the rows that would be deleted.
 */
import {
  getRetentionCutoff,
  isAuthorizedCronRequest,
  isDryRun,
  parseRetentionMonths,
  runRetention,
} from '@/lib/retention';

export const dynamic = 'force-dynamic';

// Hobby and Pro compatible (Fluid Compute). The job stops starting new batches well before.
export const maxDuration = 300;

const TIME_BUDGET_MS = 240_000;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const retention = parseRetentionMonths(process.env.RETENTION_MONTHS);

  if (!retention.ok) {
    console.error(`[retention] ${retention.error}`);
    return Response.json({ ok: false, error: retention.error }, { status: 500 });
  }

  const dryRun = isDryRun(request.url);
  const cutoff = getRetentionCutoff(new Date(startedAt), retention.months);

  // Only the relational (PostgreSQL) store is handled. With ClickHouse the event data lives
  // in ClickHouse and would need its own TTL, so the job is skipped instead of half-running.
  const { isRelationalOnly } = await import('@/lib/db');

  if (!isRelationalOnly()) {
    return Response.json({
      ok: true,
      skipped: 'Only PostgreSQL without ClickHouse is supported.',
      retentionMonths: retention.months,
      cutoff: cutoff.toISOString(),
    });
  }

  try {
    const { default: prisma } = await import('@/lib/prisma');

    const result = await runRetention({
      query: (sql, params = {}) => prisma.writeRawQuery(sql, params, 'retention'),
      cutoff,
      dryRun,
      deadline: startedAt + TIME_BUDGET_MS,
    });

    const body = {
      ok: true,
      dryRun,
      retentionMonths: retention.months,
      cutoff: result.cutoff,
      done: result.done,
      pending: result.pending,
      durationMs: Date.now() - startedAt,
      [dryRun ? 'wouldDelete' : 'deleted']: result.rows,
    };

    console.log(`[retention] ${JSON.stringify(body)}`);

    return Response.json(body);
  } catch (error) {
    console.error('[retention] failed', error);

    return Response.json(
      {
        ok: false,
        // Details only go to the function logs, never into the response.
        error: 'Retention job failed, see function logs.',
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}
