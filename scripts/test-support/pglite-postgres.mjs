// Substitute transport only. Use the installed Postgres.js builder/serializer
// so invalid helper placement fails here exactly as it does against Supabase.
import postgres from "postgres";
const { stringify } = await import(new URL("types.js", import.meta.resolve("postgres")));

export function pglitePostgres(pg) {
  const compiler = postgres({ prepare: false });
  function sql(strings, ...values) {
    if (!Array.isArray(strings) || !Object.hasOwn(strings, "raw")) {
      return compiler(strings, ...values);
    }
    const parameters = [];
    const query = stringify({ strings, args: values }, strings[0], values[0], parameters, [], {
      transform: { column: {}, undefined: undefined },
    });
    return pg.query(query, parameters.map(value => value instanceof Date ? value.toISOString() : value)).then((result) => result.rows);
  }
  sql.begin = async (options, callback) => {
    if (typeof options === "function") { callback = options; options = ""; }
    await pg.exec(`BEGIN ${options}`);
    try {
      const result = await callback(sql);
      await pg.exec("COMMIT");
      return result;
    } catch (error) {
      await pg.exec("ROLLBACK");
      throw error;
    }
  };
  let savepoint = 0;
  sql.savepoint = async (callback) => {
    const name = `test_savepoint_${++savepoint}`;
    await pg.exec(`SAVEPOINT ${name}`);
    try {
      const result = await callback(sql);
      await pg.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await pg.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  };
  return sql;
}
