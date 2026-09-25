/**
 * Wraps a D1 binding so a failed query logs where it came from before the
 * error propagates. Runner-facing RPC rejections are otherwise invisible in
 * Worker logs, which is how failures such as D1's subrequest-depth limit went
 * undiagnosed.
 *
 * Only the SQL text (a constant in this codebase), the error message and the
 * Gardener call-site frames are logged. Bound values are never logged: `bind`
 * is re-wrapped but deliberately not routed through `logFailure`, because
 * D1's synchronous bind type error embeds the offending value.
 */
export function instrumentD1(db: D1Database, scope: string): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();

  const wrapStatement = (statement: D1PreparedStatement, sql: string, site: Error): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(value.apply(target, values) as D1PreparedStatement, sql, site);
        }
        if (property === "first" || property === "run" || property === "all" || property === "raw") {
          return (...args: unknown[]) => logFailure(
            Promise.resolve(value.apply(target, args)),
            { scope, operation: property, sql, site },
          );
        }
        return value.bind(target);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };

  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "prepare" && typeof value === "function") {
        return (sql: string) => wrapStatement(value.call(target, sql) as D1PreparedStatement, sql, new Error());
      }
      if (property === "batch" && typeof value === "function") {
        return (statements: D1PreparedStatement[]) => {
          const site = new Error();
          const unwrapped = statements.map((statement) => originals.get(statement) ?? statement);
          return logFailure(
            Promise.resolve(value.call(target, unwrapped)),
            { scope, operation: "batch", sql: unwrapped.map(statementSql).join(" ; "), site },
          );
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface FailureContext {
  scope: string;
  operation: string;
  sql: string;
  /** Captured where the query was prepared; formatted only if it fails. */
  site: Error;
}

async function logFailure<T>(promise: Promise<T>, context: FailureContext): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    console.error("gardener d1 query failed", {
      scope: context.scope,
      operation: context.operation,
      sql: context.sql.replace(/\s+/g, " ").slice(0, context.operation === "batch" ? 400 : 120),
      site: formatSite(context.site),
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    throw error;
  }
}

/** workerd keeps the SQL on a public `statement` field; test shims may not. */
function statementSql(statement: D1PreparedStatement): string {
  const sql = (statement as unknown as { statement?: unknown }).statement;
  return typeof sql === "string" ? sql : "?";
}

/**
 * The caller's stack, innermost first, up to 8 frames subject to the runtime's
 * stack-trace limit. Frames are skipped by position, not by file, because the
 * deployed Worker is a single bundle: line 0 is the message, then the wrapper
 * that created the capture.
 */
function formatSite(site: Error): string {
  return (site.stack ?? "")
    .split("\n")
    .slice(2)
    .map((line) => line.trim().replace(/^at /, ""))
    .slice(0, 8)
    .map((line) => line.replace(/\(.*[\\/]/, "(").slice(0, 120))
    .join(" <- ");
}
