/**
 * Data retention: deletes visitor analytics data older than a cutoff date.
 *
 * Fork-only module (not part of upstream Umami). It is invoked by the Vercel Cron route
 * `src/app/(cron)/api/cron/retention/route.ts` and only touches tables holding time-based
 * visitor data. Configuration tables (website, user, team, report, segment, board, link,
 * pixel, share, annotation, api_key, ...) are never touched.
 *
 * Everything except `runRetention`'s database executor is pure, so it can be unit tested
 * without a database.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const DEFAULT_RETENTION_MONTHS = 14;
export const MAX_RETENTION_MONTHS = 1200;
export const DEFAULT_BATCH_SIZE = 5000;

/** Tables this job deletes from, in the order they are processed. */
export const RETENTION_TABLES = [
  'event_data',
  'revenue',
  'website_event',
  'heatmap_event',
  'session_replay',
  'session_replay_saved',
  'error_event',
  'error_issue',
  'session_data',
  'session_link',
  'session',
] as const;

export type RetentionTable = (typeof RETENTION_TABLES)[number];
export type RetentionCounts = Record<RetentionTable, number>;

export type RetentionMonthsResult =
  | { ok: true; months: number; error?: undefined }
  | { ok: false; months?: undefined; error: string };

/**
 * Parses RETENTION_MONTHS. Unset/empty falls back to the default (14). Anything else must be
 * a whole number between 1 and MAX_RETENTION_MONTHS; invalid values are rejected instead of
 * silently falling back, because a typo (e.g. "24x") must never shorten retention and delete
 * data irreversibly.
 */
export function parseRetentionMonths(value: string | undefined | null): RetentionMonthsResult {
  const raw = value?.trim();

  if (!raw) {
    return { ok: true, months: DEFAULT_RETENTION_MONTHS };
  }

  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `RETENTION_MONTHS must be a whole number, got "${raw}".` };
  }

  const months = Number(raw);

  if (months < 1 || months > MAX_RETENTION_MONTHS) {
    return {
      ok: false,
      error: `RETENTION_MONTHS must be between 1 and ${MAX_RETENTION_MONTHS}, got ${months}.`,
    };
  }

  return { ok: true, months };
}

/**
 * Cutoff = 00:00:00 UTC of the same calendar day `months` months before `now` (UTC).
 * If that month is shorter, the day is clamped (e.g. 31 May - 3 months = 28/29 Feb).
 * Starting at midnight keeps the cutoff stable for the whole UTC day, so repeated runs on
 * the same day are idempotent. Rows with `created_at < cutoff` are deleted.
 */
export function getRetentionCutoff(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const day = now.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTargetMonth)));
}

/**
 * Checks `Authorization: Bearer <CRON_SECRET>` as sent by Vercel Cron.
 * Returns false when no secret is configured. Both values are hashed first so the
 * comparison is constant-time and does not leak the secret's length.
 */
export function isAuthorizedCronRequest(
  authorization: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret?.trim() || !authorization) {
    return false;
  }

  const actual = createHash('sha256').update(authorization).digest();
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();

  return timingSafeEqual(actual, expected);
}

/** Parses `?dryRun=1` / `?dryRun=true`. */
export function isDryRun(url: string): boolean {
  const value = new URL(url).searchParams.get('dryRun')?.toLowerCase();

  return value === '1' || value === 'true';
}

/**
 * Minimal SQL executor. Uses Umami's `{{name}}` / `{{name::type}}` parameter syntax
 * (see `executeRawQuery` in src/lib/prisma.ts).
 */
export type RetentionQuery = (sql: string, params?: Record<string, any>) => Promise<any[]>;

export interface RetentionOptions {
  query: RetentionQuery;
  cutoff: Date;
  dryRun?: boolean;
  batchSize?: number;
  /** Epoch ms after which no new batch is started. */
  deadline: number;
  now?: () => number;
}

export interface RetentionResult {
  dryRun: boolean;
  cutoff: string;
  /** True when every step ran to completion; false when the time budget ran out. */
  done: boolean;
  /** Steps that did not finish (picked up again on the next run). */
  pending: string[];
  /** Rows deleted per table, or rows that would be deleted in a dry run. */
  rows: RetentionCounts;
}

interface StepContext {
  query: RetentionQuery;
  params: { cutoff: string; limit: number };
  batchSize: number;
  hasTime: () => boolean;
  add: (table: RetentionTable, count: unknown) => void;
}

interface Step {
  name: string;
  run: (ctx: StepContext) => Promise<boolean>;
  count: (ctx: StepContext) => Promise<void>;
}

const CUTOFF = '{{cutoff::timestamptz}}';
const LIMIT = '{{limit::int}}';

/** Runs batches until one deletes fewer rows than the batch size or time runs out. */
async function drain(ctx: StepContext, batch: () => Promise<number>): Promise<boolean> {
  while (ctx.hasTime()) {
    if ((await batch()) < ctx.batchSize) {
      return true;
    }
  }

  return false;
}

async function single(ctx: StepContext, sql: string, params: Record<string, any> = ctx.params) {
  const [row] = await ctx.query(sql, params);

  return row ?? {};
}

/**
 * Batch delete over a table with its own `created_at` index:
 * select up to `limit` primary keys, delete exactly those rows.
 */
function globalStep(table: RetentionTable, pk: string, where = ''): Step {
  const condition = `created_at < ${CUTOFF}${where ? ` and ${where}` : ''}`;

  return {
    name: table,
    run: ctx =>
      drain(ctx, async () => {
        const { count } = await single(
          ctx,
          `with batch as (
            select ${pk} from ${table} t where ${condition} limit ${LIMIT}
          ), deleted as (
            delete from ${table} t using batch where t.${pk} = batch.${pk} returning 1
          )
          select count(*)::int as count from deleted`,
        );
        ctx.add(table, count);
        return Number(count ?? 0);
      }),
    count: async () => {},
  };
}

/**
 * Batch delete for tables that only have a (website_id, created_at) index. Iterates the
 * website ids present in the table (index skip scan, so data of deleted websites is
 * included) and deletes per website, which keeps every batch on the composite index.
 */
function perWebsiteStep(table: RetentionTable, pk: string[]): Step {
  const pkList = pk.join(', ');
  const pkMatch = pk.map(column => `t.${column} = batch.${column}`).join(' and ');

  return {
    name: table,
    run: async ctx => {
      const websites = await ctx.query(
        `with recursive ids as (
          (select website_id from ${table} order by website_id limit 1)
          union all
          select (
            select t.website_id from ${table} t
            where t.website_id > ids.website_id
            order by t.website_id limit 1
          )
          from ids where ids.website_id is not null
        )
        select website_id::text as website_id from ids where website_id is not null`,
      );

      for (const { website_id: websiteId } of websites) {
        const finished = await drain(ctx, async () => {
          const { count } = await single(
            ctx,
            `with batch as (
              select ${pkList} from ${table}
              where website_id = {{websiteId::uuid}} and created_at < ${CUTOFF}
              limit ${LIMIT}
            ), deleted as (
              delete from ${table} t using batch where ${pkMatch} returning 1
            )
            select count(*)::int as count from deleted`,
            { ...ctx.params, websiteId },
          );
          ctx.add(table, count);
          return Number(count ?? 0);
        });

        if (!finished) {
          return false;
        }
      }

      return true;
    },
    count: async () => {},
  };
}

/** Dry-run helper: `select count(*) from <table> where created_at < cutoff [and ...]`. */
function countOlder(table: RetentionTable, where = '') {
  return async (ctx: StepContext) => {
    const { count } = await single(
      ctx,
      `select count(*)::bigint as count from ${table} t
      where t.created_at < ${CUTOFF}${where ? ` and ${where}` : ''}`,
    );
    ctx.add(table, count);
  };
}

// A session is removed only once it is older than the cutoff AND nothing newer refers to
// it any more. See the PR description / docs for why this is anchored on events.
const SESSION_IS_UNREFERENCED = `
  not exists (select 1 from website_event e where e.session_id = s.session_id)
  and not exists (select 1 from revenue r where r.session_id = s.session_id)`;

// Dry run: older events have not been deleted yet, so simulate the state after deletion.
const SESSION_WOULD_BE_UNREFERENCED = `
  not exists (
    select 1 from website_event e
    where e.session_id = s.session_id and e.created_at >= ${CUTOFF}
  )
  and not exists (
    select 1 from revenue r
    where r.session_id = s.session_id and r.created_at >= ${CUTOFF}
  )`;

const STEPS: Step[] = [
  // 1. event_data before website_event (event_data.website_event_id -> website_event).
  //    event_data.created_at is copied from its event, so this removes the bulk.
  { ...globalStep('event_data', 'event_data_id'), count: countOlder('event_data') },

  // 2. revenue before website_event / session (revenue.event_id, revenue.session_id).
  { ...perWebsiteStep('revenue', ['revenue_id']), count: countOlder('revenue') },

  // 3. website_event, together with any event_data still attached to the deleted events
  //    (in the same statement, so no event_data can be orphaned).
  {
    name: 'website_event',
    run: ctx =>
      drain(ctx, async () => {
        const row = await single(
          ctx,
          `with batch as (
            select event_id from website_event where created_at < ${CUTOFF} limit ${LIMIT}
          ), deleted_data as (
            delete from event_data d using batch where d.website_event_id = batch.event_id
            returning 1
          ), deleted as (
            delete from website_event e using batch where e.event_id = batch.event_id
            returning 1
          )
          select
            (select count(*) from deleted)::int as count,
            (select count(*) from deleted_data)::int as event_data`,
        );
        ctx.add('website_event', row.count);
        ctx.add('event_data', row.event_data);
        return Number(row.count ?? 0);
      }),
    count: countOlder('website_event'),
  },

  // 4. Heatmap, replay and error tracking data (independent of website_event).
  { ...perWebsiteStep('heatmap_event', ['heatmap_event_id']), count: countOlder('heatmap_event') },
  { ...perWebsiteStep('session_replay', ['replay_id']), count: countOlder('session_replay') },

  // 5. Saved replays (bookmarks to a visit's recording) whose recording is gone.
  {
    ...globalStep(
      'session_replay_saved',
      'saved_replay_id',
      `not exists (
        select 1 from session_replay r
        where r.website_id = t.website_id and r.visit_id = t.visit_id
      )`,
    ),
    count: countOlder(
      'session_replay_saved',
      `not exists (
        select 1 from session_replay r
        where r.website_id = t.website_id and r.visit_id = t.visit_id
          and r.created_at >= ${CUTOFF}
      )`,
    ),
  },

  {
    ...perWebsiteStep('error_event', ['website_id', 'event_id']),
    count: countOlder('error_event'),
  },

  // 6. Error issues (groupings) that have no remaining occurrences.
  {
    ...globalStep(
      'error_issue',
      'issue_id',
      `not exists (
        select 1 from error_event e
        where e.website_id = t.website_id and e.issue_id = t.issue_id
      )`,
    ),
    count: countOlder(
      'error_issue',
      `not exists (
        select 1 from error_event e
        where e.website_id = t.website_id and e.issue_id = t.issue_id
          and e.created_at >= ${CUTOFF}
      )`,
    ),
  },

  // 7. Sessions + their session_data / session_link, in one statement per batch.
  {
    name: 'session',
    run: ctx =>
      drain(ctx, async () => {
        const row = await single(
          ctx,
          `with batch as (
            select s.session_id, s.website_id from session s
            where s.created_at < ${CUTOFF} and ${SESSION_IS_UNREFERENCED}
            limit ${LIMIT}
          ), deleted_data as (
            delete from session_data d using batch where d.session_id = batch.session_id
            returning 1
          ), deleted_links as (
            delete from session_link l using batch
            where l.website_id = batch.website_id and l.session_id = batch.session_id
            returning 1
          ), deleted as (
            delete from session s using batch where s.session_id = batch.session_id
            returning 1
          )
          select
            (select count(*) from deleted)::int as count,
            (select count(*) from deleted_data)::int as session_data,
            (select count(*) from deleted_links)::int as session_link`,
        );
        ctx.add('session', row.count);
        ctx.add('session_data', row.session_data);
        ctx.add('session_link', row.session_link);
        return Number(row.count ?? 0);
      }),
    count: async ctx => {
      const row = await single(
        ctx,
        `with doomed as (
          select s.session_id, s.website_id from session s
          where s.created_at < ${CUTOFF} and ${SESSION_WOULD_BE_UNREFERENCED}
        )
        select
          (select count(*) from doomed)::bigint as count,
          (select count(*) from session_data d join doomed on d.session_id = doomed.session_id)::bigint
            as session_data,
          (select count(*) from session_link l join doomed
            on l.website_id = doomed.website_id and l.session_id = doomed.session_id)::bigint
            as session_link`,
      );
      ctx.add('session', row.count);
      ctx.add('session_data', row.session_data);
      ctx.add('session_link', row.session_link);
    },
  },

  // 8. Old session_data whose session no longer exists (orphans from earlier versions).
  {
    ...globalStep(
      'session_data',
      'session_data_id',
      'not exists (select 1 from session s where s.session_id = t.session_id)',
    ),
    name: 'session_data_orphans',
    count: countOlder(
      'session_data',
      'not exists (select 1 from session s where s.session_id = t.session_id)',
    ),
  },
];

export function emptyCounts(): RetentionCounts {
  return Object.fromEntries(RETENTION_TABLES.map(table => [table, 0])) as RetentionCounts;
}

/**
 * Runs all retention steps in order. A step only starts after every previous step has
 * finished, so dependent rows are always removed before the rows they refer to. When the
 * deadline is reached no new batch is started; the next run continues where this one
 * stopped (all deletes are idempotent and keyed on the cutoff).
 */
export async function runRetention(options: RetentionOptions): Promise<RetentionResult> {
  const {
    query,
    cutoff,
    dryRun = false,
    batchSize = DEFAULT_BATCH_SIZE,
    deadline,
    now = Date.now,
  } = options;

  const rows = emptyCounts();
  const ctx: StepContext = {
    query,
    params: { cutoff: cutoff.toISOString(), limit: batchSize },
    batchSize,
    hasTime: () => now() < deadline,
    add: (table, count) => {
      rows[table] += Number(count ?? 0);
    },
  };

  const pending: string[] = [];

  for (const step of STEPS) {
    if (pending.length || !ctx.hasTime()) {
      pending.push(step.name);
      continue;
    }

    if (dryRun) {
      await step.count(ctx);
    } else if (!(await step.run(ctx))) {
      pending.push(step.name);
    }
  }

  return {
    dryRun,
    cutoff: cutoff.toISOString(),
    done: pending.length === 0,
    pending,
    rows,
  };
}

/** Step names in execution order (exported for tests and documentation). */
export const RETENTION_STEPS = STEPS.map(step => step.name);
