import { describe, expect, test } from 'vitest';
import { pgConnection, scheduledSlot } from './service';

describe('backup helpers', () => {
  test('pg_dump gets the URL as given, minus its password, which goes in the environment', () => {
    const { args, env } = pgConnection('postgres://octi:p%40ss@[::1]:5433/my=db?sslmode=require&sslrootcert=/ca.pem');
    expect(args).toEqual(['--dbname=postgres://octi@[::1]:5433/my=db?sslmode=require&sslrootcert=/ca.pem']);
    expect(env.PGPASSWORD).toBe('p@ss');
    expect(args.join(' ')).not.toContain('p%40ss');
  });

  test('the daily slot is today\'s hour, or yesterday\'s before it', () => {
    expect(scheduledSlot(new Date(2026, 9, 25, 1, 0), 3)).toEqual(new Date(2026, 9, 24, 3, 0));
    expect(scheduledSlot(new Date(2026, 9, 25, 3, 0), 3)).toEqual(new Date(2026, 9, 25, 3, 0));
    expect(scheduledSlot(new Date(2026, 9, 25, 23, 59), 3)).toEqual(new Date(2026, 9, 25, 3, 0));
  });
});
