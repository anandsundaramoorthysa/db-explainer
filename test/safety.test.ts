import { describe, it, expect } from 'vitest';
import { guardReadOnly, stripLiterals } from '../src/db/sqlGuard';
import { maskSample, maskValue, sampleToText } from '../src/ai/mask';
import { DbEngine } from '../src/types';

const ok = (sql: string, engine: DbEngine = 'mysql') => guardReadOnly(sql, engine);

describe('guardReadOnly accepts normal read queries', () => {
  it.each([
    ['plain select', 'SELECT id, name FROM customers WHERE id = 3'],
    ['trailing semicolon', 'SELECT 1;'],
    ['join and group by', 'SELECT c.id, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id HAVING COUNT(*) > 1 ORDER BY 2 DESC'],
    ['cte', 'WITH recent AS (SELECT * FROM orders WHERE placed_at > NOW() - INTERVAL 7 DAY) SELECT COUNT(*) FROM recent'],
    ['explain select', 'EXPLAIN SELECT * FROM orders'],
    ['comments', 'SELECT 1 -- DROP TABLE x\n/* DELETE FROM y */'],
    ['keywords inside strings', "SELECT 'drop table users; delete from t' AS note"],
    ['keywords inside quoted names', 'SELECT `update`, `delete` FROM `insert`'],
    ['column names that contain keywords', 'SELECT update_date, created_at, deleted, into_stock, grants FROM t'],
    ['replace function', "SELECT REPLACE(name, 'a', 'b') FROM t"],
    ['union', 'SELECT id FROM a UNION ALL SELECT id FROM b'],
  ])('%s', (_label, sql) => {
    expect(ok(sql).ok).toBe(true);
  });

  it('removes the trailing semicolon', () => {
    expect(ok('SELECT 1;;  ')).toEqual({ ok: true, sql: 'SELECT 1' });
  });
});

describe('guardReadOnly refuses anything that could change or leak data', () => {
  it.each([
    ['insert', "INSERT INTO t VALUES (1)"],
    ['update', 'UPDATE t SET a = 1'],
    ['delete', 'DELETE FROM t'],
    ['drop', 'DROP TABLE t'],
    ['two statements', 'SELECT 1; DROP TABLE t'],
    ['two statements, second hidden after comment', 'SELECT 1; -- ok\nDELETE FROM t'],
    ['select into', 'SELECT * INTO backup FROM t'],
    ['into outfile', "SELECT * FROM t INTO OUTFILE '/tmp/x'"],
    ['for update', 'SELECT * FROM t FOR UPDATE'],
    ['lock in share mode', 'SELECT * FROM t LOCK IN SHARE MODE'],
    ['mysql executable comment', 'SELECT 1 /*!50000 UNION SELECT 2 */'],
    ['unterminated string', "SELECT 'abc"],
    ['explain of a write', 'EXPLAIN DELETE FROM t'],
    ['stored procedure', 'CALL cleanup()'],
    ['exec', 'EXEC sp_who'],
    ['xp_cmdshell inside select', "SELECT xp_cmdshell('dir')"],
    ['data-modifying cte', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'],
    ['sequence side effect', "SELECT nextval('seq')"],
    ['file read', "SELECT pg_read_file('/etc/passwd')"],
    ['empty', '   '],
    ['not a query', 'SET autocommit = 0'],
  ])('%s', (_label, sql) => {
    const r = ok(sql, sql.includes('pg_') || sql.includes('nextval') || sql.includes('RETURNING') ? 'postgres' : 'mysql');
    expect(r.ok).toBe(false);
  });

  it('gives a reason the developer can understand', () => {
    expect(ok('DROP TABLE t')).toEqual({ ok: false, reason: 'Only SELECT queries can be run, not DROP.' });
    expect(ok('SELECT 1; SELECT 2')).toEqual({ ok: false, reason: 'Only one statement can be run at a time.' });
  });

  it('understands the quoting of each engine', () => {
    expect(guardReadOnly('SELECT [update], [delete] FROM [drop]', 'mssql').ok).toBe(true);
    expect(guardReadOnly('SELECT "update" FROM "delete"', 'postgres').ok).toBe(true);
    expect(guardReadOnly("SELECT $$ drop table x; $$", 'postgres').ok).toBe(true);
    expect(guardReadOnly("SELECT 'it''s; fine' AS a", 'sqlite').ok).toBe(true);
    // In MySQL this can be read two ways depending on the server mode, so it is refused.
    expect(guardReadOnly("SELECT 'a\\' ; DROP TABLE t; --'", 'mysql').ok).toBe(false);
    // Other engines treat the backslash as a normal character, so the string ends and the second statement is caught.
    expect(guardReadOnly("SELECT 'a\\' ; DROP TABLE t; --'", 'postgres').ok).toBe(false);
    // A doubled backslash is an ordinary escaped backslash.
    expect(guardReadOnly("SELECT 'a\\\\b' AS path", 'mysql').ok).toBe(true);
  });

  it('strips literals without keeping their content', () => {
    expect(stripLiterals("SELECT 'drop' , `delete` -- x", 'mysql')).toBe("SELECT '' , _q_  ");
  });
});

describe('masking rows before they go to the AI', () => {
  const columns = ['id', 'full_name', 'email', 'phone', 'notes', 'order_total'];
  const rows = [
    [1, 'Asha Kumar', 'asha@example.com', '9876543210', 'call asha@example.com or 9876543210123', 120.5],
    [2, 'Bala Raj', 'bala@example.com', null, 'ok', 99],
    [3, 'C', 'c@x.io', '1', 'x', 1],
  ];

  it('hides sensitive columns completely and scrubs the rest', () => {
    const s = maskSample(columns, rows, 2);
    expect(s.maskedColumns).toEqual(['email', 'phone']);
    expect(s.rows[0]).toEqual(['1', 'Asha Kumar', '[hidden]', '[hidden]', 'call [email] or [number]', '120.5']);
    expect(s.sentRows).toBe(2);
    expect(s.totalRows).toBe(3);
  });

  it('never leaks a value it was told to hide', () => {
    const text = sampleToText(maskSample(columns, rows, 5));
    expect(text).not.toMatch(/asha@example|9876543210|bala@example/);
  });

  it('hides tokens and card-like numbers in free text', () => {
    expect(maskValue('key abcdefghijklmnopqrstuvwxyz0123456789ABCD and 4111 1111 1111 1111')).toBe('key [token] and [number]');
  });

  it('formats dates, nulls and objects', () => {
    const s = maskSample(['d', 'n', 'o'], [[new Date('2026-01-02T03:04:05Z'), null, { a: 1 }]], 5);
    expect(s.rows[0]).toEqual(['2026-01-02T03:04:05.000Z', 'NULL', '{"a":1}']);
  });
});
