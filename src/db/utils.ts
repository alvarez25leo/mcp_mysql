import { isMultiDbMode } from "./../config/index.js";
import { log } from "./../utils/index.js";
import SqlParser, { AST } from "node-sql-parser";

const { Parser } = SqlParser;
const parser = new Parser();

// Extract schema from SQL query
function extractSchemaFromQuery(sql: string): string | null {
  // Default schema from environment
  const defaultSchema = process.env.MYSQL_DB || null;

  // If we have a default schema and not in multi-DB mode, return it
  if (defaultSchema && !isMultiDbMode) {
    return defaultSchema;
  }

  // Try to extract schema from query

  // Case 1: USE database statement
  const useMatch = sql.match(/\bUSE\s+`?([a-zA-Z0-9_]+)`?/i);
  if (useMatch && useMatch[1]) {
    return useMatch[1];
  }

  // Case 2: database.table notation. Anchored to the keywords that precede a
  // table reference, so column aliases like `u.id` are not mistaken for a
  // schema name.
  const dbTableMatch = sql.match(
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|CALL|PROCEDURE|FUNCTION|VIEW|TRIGGER|EVENT)\s+`?([a-zA-Z0-9_]+)`?\.`?[a-zA-Z0-9_]+`?/i,
  );
  if (dbTableMatch && dbTableMatch[1]) {
    return dbTableMatch[1];
  }

  // Return default if we couldn't find a schema in the query
  return defaultSchema;
}

// Fallback classification when node-sql-parser cannot handle a statement
// (SHOW, CALL, SET, EXPLAIN, engine-specific syntax, etc.). Classifies by the
// first meaningful keyword so valid queries never fail just because the
// parser is incomplete. Unknown keywords are treated as writes ("unknown")
// so the permission layer stays conservative.
function classifyByFirstKeyword(statement: string): string {
  const keyword = statement
    .replace(/^\s*\(+/, "")
    .trim()
    .split(/[\s(]+/)[0]
    ?.toLowerCase();

  switch (keyword) {
    case "select":
    case "show":
    case "describe":
    case "desc":
    case "explain":
    case "analyze":
    case "with":
    case "use":
    case "help":
    case "checksum":
      return "select";
    case "insert":
    case "replace":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "create":
      return "create";
    case "alter":
      return "alter";
    case "drop":
      return "drop";
    case "truncate":
      return "truncate";
    case "rename":
      return "alter";
    case "call":
      return "call";
    default:
      return "unknown";
  }
}

async function getQueryTypes(query: string): Promise<string[]> {
  try {
    log("info", "Parsing SQL query: ", query);
    // Parse into AST or array of ASTs - only specify the database type
    const astOrArray: AST | AST[] = parser.astify(query, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    // Map each statement to its lowercased type (e.g., 'select', 'update', 'insert', 'delete', etc.)
    return statements.map((stmt) => stmt.type?.toLowerCase() ?? "unknown");
  } catch (err: any) {
    // node-sql-parser does not cover the full MySQL grammar (SHOW, CALL, SET,
    // EXPLAIN, ...). Fall back to keyword classification instead of failing
    // valid statements. Writes still hit the READ ONLY transaction guard.
    log(
      "info",
      `sqlParser could not parse query, using keyword fallback: ${err.message}`,
    );
    const statements = query
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    if (statements.length === 0) {
      return ["unknown"];
    }

    return statements.map(classifyByFirstKeyword);
  }
}

/**
 * Detect UPDATE/DELETE statements without a WHERE clause (full-table writes).
 * Uses the SQL AST when possible; falls back to a keyword heuristic when the
 * parser cannot handle the statement. Returns the offending statement types.
 */
function detectFullTableWrites(sql: string): string[] {
  try {
    const astOrArray: AST | AST[] = parser.astify(sql, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];
    const offenders: string[] = [];
    for (const stmt of statements) {
      const type = stmt.type?.toLowerCase();
      if ((type === "update" || type === "delete") && !(stmt as any).where) {
        offenders.push(type);
      }
    }
    return offenders;
  } catch {
    // Parser fallback: keyword scan per statement
    const offenders: string[] = [];
    for (const statement of sql.split(";")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      const keyword = trimmed.split(/[\s(]+/)[0]?.toLowerCase();
      if (
        (keyword === "update" || keyword === "delete") &&
        !/\bWHERE\b/i.test(trimmed)
      ) {
        offenders.push(keyword);
      }
    }
    return offenders;
  }
}

/**
 * Split a SQL script into individual statements, honoring string literals
 * (' " `), escapes, and comments (-- # &#47;* *&#47;). Routine DDL
 * (CREATE/ALTER PROCEDURE|FUNCTION|TRIGGER|EVENT) is returned as a single
 * statement because its body contains internal semicolons.
 */
function splitSqlStatements(sql: string): string[] {
  if (
    /\b(CREATE|ALTER)\s+(DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(
      sql,
    )
  ) {
    const single = sql.trim();
    return single ? [single] : [];
  }

  type State =
    | "none"
    | "single"
    | "double"
    | "backtick"
    | "lineComment"
    | "blockComment";

  const statements: string[] = [];
  let current = "";
  let state: State = "none";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    switch (state) {
      case "none":
        if (ch === "'") {
          state = "single";
          current += ch;
        } else if (ch === '"') {
          state = "double";
          current += ch;
        } else if (ch === "`") {
          state = "backtick";
          current += ch;
        } else if (ch === "#") {
          state = "lineComment";
          current += ch;
        } else if (
          ch === "-" &&
          next === "-" &&
          (sql[i + 2] === undefined || /\s/.test(sql[i + 2]))
        ) {
          state = "lineComment";
          current += ch;
        } else if (ch === "/" && next === "*") {
          state = "blockComment";
          current += ch;
        } else if (ch === ";") {
          statements.push(current);
          current = "";
        } else {
          current += ch;
        }
        break;
      case "single":
      case "double": {
        const quote = state === "single" ? "'" : '"';
        current += ch;
        if (ch === "\\" && next !== undefined) {
          current += next;
          i++;
        } else if (ch === quote) {
          if (next === quote) {
            current += next;
            i++;
          } else {
            state = "none";
          }
        }
        break;
      }
      case "backtick":
        current += ch;
        if (ch === "`") {
          if (next === "`") {
            current += next;
            i++;
          } else {
            state = "none";
          }
        }
        break;
      case "lineComment":
        current += ch;
        if (ch === "\n") {
          state = "none";
        }
        break;
      case "blockComment":
        current += ch;
        if (ch === "*" && next === "/") {
          current += next;
          i++;
          state = "none";
        }
        break;
    }
  }
  statements.push(current);

  // Drop empty and comment-only fragments (MySQL rejects empty queries)
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => {
      if (statement.length === 0) return false;
      const withoutComments = statement
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\n)\s*(--[^\n]*|#[^\n]*)/g, "")
        .trim();
      return withoutComments.length > 0;
    });
}

export {
  extractSchemaFromQuery,
  getQueryTypes,
  detectFullTableWrites,
  splitSqlStatements,
};
