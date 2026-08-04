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

export { extractSchemaFromQuery, getQueryTypes };
