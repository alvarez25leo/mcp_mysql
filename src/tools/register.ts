/**
 * Modern MCP tool registration (SDK 1.x high-level API).
 *
 * Registers every tool through McpServer.registerTool with:
 *  - Zod input schemas (validated by the SDK before the handler runs)
 *  - title + annotations (readOnlyHint / destructiveHint / idempotentHint)
 *  - structuredContent so clients and models get machine-readable results
 *  - outputSchema for mysql_query (the primary tool)
 *
 * Descriptions are reused from additionalToolDefinitions in ./index.js so
 * there is a single source of truth for tool documentation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { performance } from "perf_hooks";
import { log } from "../utils/index.js";
import { executeReadOnlyQuery } from "../db/index.js";
import {
  additionalToolDefinitions,
  handleAdditionalTool,
  addToQueryHistory,
} from "./index.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

const descriptions: Record<string, string> = Object.fromEntries(
  additionalToolDefinitions.map((definition: any) => [
    definition.name,
    definition.description,
  ]),
);

// Shared annotation presets
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITES_DATA = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

// Attach structuredContent by parsing the primary JSON text payload. Arrays
// are wrapped in { items } because structuredContent must be an object.
function withStructuredContent(result: ToolResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    content: result.content,
    isError: result.isError,
  };

  if (!result.isError && result.content[0]?.text) {
    try {
      const parsed = JSON.parse(result.content[0].text);
      if (Array.isArray(parsed)) {
        response.structuredContent = { items: parsed };
      } else if (parsed && typeof parsed === "object") {
        response.structuredContent = parsed;
      }
    } catch {
      // Payload is plain text (status messages, SQL scripts, CSV) — fine.
    }
  }

  return response;
}

// Register one tool backed by the handleAdditionalTool dispatcher
function registerDispatchedTool(
  server: McpServer,
  name: string,
  title: string,
  inputSchema: Record<string, z.ZodType> | undefined,
  annotations: Record<string, boolean>,
) {
  server.registerTool(
    name,
    {
      title,
      description: descriptions[name] || title,
      ...(inputSchema ? { inputSchema } : {}),
      annotations,
    },
    async (args: Record<string, any>) => {
      const startTime = performance.now();
      try {
        const result = await handleAdditionalTool(name, args ?? {});
        const duration = performance.now() - startTime;
        if (result === null) {
          throw new Error(`Tool '${name}' is not implemented`);
        }
        addToQueryHistory(
          `[TOOL] ${name}: ${JSON.stringify(args ?? {}).substring(0, 200)}`,
          duration,
          0,
          !result.isError,
        );
        return withStructuredContent(result) as any;
      } catch (error) {
        const duration = performance.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        addToQueryHistory(`[ERROR] ${name}`, duration, 0, false, message);
        log("error", `Error in tool ${name}:`, error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        } as any;
      }
    },
  );
}

export function registerAllTools(
  server: McpServer,
  options: { mysqlQueryDescription: string; isReadOnly: boolean },
) {
  // ==========================================================================
  // mysql_query — primary tool, with outputSchema + structuredContent
  // ==========================================================================
  server.registerTool(
    "mysql_query",
    {
      title: "Run SQL query",
      description: options.mysqlQueryDescription,
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe(
            "The SQL query to execute. Can be any valid MySQL statement: SELECT (read data), INSERT/UPDATE/DELETE (modify data, requires permissions), CREATE/ALTER/DROP (DDL operations, requires permissions), CALL (stored procedures), SHOW (metadata queries), etc. Prefer ? placeholders with 'params' for values.",
          ),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe(
            "Values for ? placeholders in the SQL (prepared statement). Safer than concatenating values into the SQL string.",
          ),
        maxRows: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe(
            "Maximum number of rows to return (default 500). Larger result sets are truncated with a notice; use LIMIT/OFFSET to page through data.",
          ),
      },
      outputSchema: {
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Result rows for read queries"),
        rowCount: z.number().optional().describe("Total rows produced"),
        returnedRows: z.number().optional().describe("Rows actually returned"),
        truncated: z
          .boolean()
          .optional()
          .describe("True when rows were cut off by maxRows"),
        operation: z
          .string()
          .optional()
          .describe("insert | update | delete | ddl | other (write queries)"),
        schema: z.string().nullable().optional(),
        affectedRows: z.number().optional(),
        changedRows: z.number().optional(),
        insertId: z.number().optional(),
        durationMs: z.number().optional(),
        message: z.string().optional(),
        result: z.unknown().optional(),
      },
      annotations: {
        readOnlyHint: options.isReadOnly,
        destructiveHint: !options.isReadOnly,
        idempotentHint: options.isReadOnly,
        openWorldHint: false,
      },
    },
    async ({ sql, params, maxRows }) => {
      const startTime = performance.now();
      try {
        const result = await executeReadOnlyQuery<{
          content: Array<{ type: string; text: string }>;
          structured?: Record<string, unknown>;
          isError: boolean;
        }>(sql, { maxRows: maxRows ?? 500, params });
        const duration = performance.now() - startTime;

        const rowCount =
          typeof result.structured?.rowCount === "number"
            ? (result.structured.rowCount as number)
            : 0;
        addToQueryHistory(sql, duration, rowCount, !result.isError);

        return {
          content: result.content,
          isError: result.isError,
          ...(!result.isError && result.structured
            ? { structuredContent: result.structured }
            : {}),
        } as any;
      } catch (error) {
        const duration = performance.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        addToQueryHistory(sql, duration, 0, false, message);
        log("error", "Error in mysql_query:", error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        } as any;
      }
    },
  );

  // ==========================================================================
  // Inspection & analysis tools (read-only)
  // ==========================================================================
  registerDispatchedTool(
    server,
    "mysql_explain",
    "Explain query plan",
    {
      sql: z
        .string()
        .describe("The SQL query to analyze (SELECT, UPDATE, DELETE, or INSERT)"),
      format: z
        .enum(["traditional", "json", "tree"])
        .optional()
        .describe(
          "Output format: 'traditional' (default), 'json' (structured, best for automated analysis), or 'tree'",
        ),
      analyze: z
        .boolean()
        .optional()
        .describe(
          "If true, also runs EXPLAIN ANALYZE (SELECT only — it actually executes the query). Default: false.",
        ),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_describe",
    "Describe table",
    {
      table: z.string().describe("Name of the table to describe"),
      database: z
        .string()
        .optional()
        .describe("Database name (optional, uses current database if not specified)"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_data_dictionary",
    "Data dictionary",
    {
      database: z
        .string()
        .optional()
        .describe("Database name to inspect. Optional if MYSQL_DB is configured."),
      table: z
        .string()
        .optional()
        .describe("Specific table to document. If omitted, documents all base tables."),
      format: z
        .enum(["json", "markdown"])
        .optional()
        .describe("Output format: 'json' (structured) or 'markdown' (readable)"),
      sampleRowsLimit: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("Sample rows per table (default 3, 0 disables samples)"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_show_views",
    "List / describe views",
    {
      database: z.string().optional().describe("Database to search views in"),
      viewName: z
        .string()
        .optional()
        .describe("Specific view to describe (omit to list all views)"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_routine_impact",
    "Routine impact analysis",
    {
      routineName: z
        .string()
        .describe("Nombre de la function o stored procedure a buscar"),
      database: z
        .string()
        .optional()
        .describe("Base de datos donde buscar. Opcional si MYSQL_DB está configurado."),
      routineType: z
        .enum(["auto", "procedure", "function"])
        .optional()
        .describe("Tipo de routine. 'auto' lo infiere. Default: auto."),
      includeSnippets: z
        .boolean()
        .optional()
        .describe("Incluir snippet del uso detectado. Default: true."),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_foreign_keys",
    "Foreign key graph",
    {
      database: z.string().optional().describe("Database name to search in"),
      table: z
        .string()
        .optional()
        .describe("Specific table to show relationships for"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_table_stats",
    "Table statistics",
    {
      database: z.string().optional().describe("Database name to analyze"),
      table: z.string().optional().describe("Specific table to get statistics for"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_index_suggestions",
    "Index suggestions",
    {
      database: z
        .string()
        .optional()
        .describe("Database to analyze (all databases if omitted)"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_process_list",
    "Process list",
    {
      full: z
        .boolean()
        .optional()
        .describe("If true, shows full query text (default: false)"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_query_history",
    "Query history",
    {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Number of most recent queries to return (default 50)"),
      clear: z
        .boolean()
        .optional()
        .describe("If true, clears the history instead of returning it"),
    },
    { ...READ_ONLY, idempotentHint: false },
  );

  registerDispatchedTool(
    server,
    "mysql_compare_schemas",
    "Compare schemas",
    {
      sourceDb: z.string().describe("Source database name (reference schema)"),
      targetDb: z.string().describe("Target database name to compare against"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_variables",
    "Show / set variables",
    {
      action: z
        .enum(["show", "set"])
        .optional()
        .describe("'show' (default) or 'set' (requires ALLOW_ADMIN_OPERATION=true)"),
      scope: z
        .enum(["global", "session"])
        .optional()
        .describe("Variable scope. Note: 'session' changes do not persist across pooled connections."),
      filter: z.string().optional().describe("Filter variables by name pattern"),
      variable: z.string().optional().describe("Variable name (required for set)"),
      value: z.string().optional().describe("New value (required for set)"),
    },
    { ...READ_ONLY, idempotentHint: false },
  );

  // ==========================================================================
  // Export & data tools
  // ==========================================================================
  registerDispatchedTool(
    server,
    "mysql_backup",
    "Export table data",
    {
      table: z.string().describe("Name of the table to export data from"),
      format: z
        .enum(["json", "csv"])
        .optional()
        .describe("'json' (default) or 'csv'"),
      database: z.string().optional().describe("Database name"),
      whereClause: z
        .string()
        .optional()
        .describe("WHERE conditions without the 'WHERE' keyword"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of rows to export"),
    },
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_export_schema",
    "Export schema to disk",
    {
      database: z
        .string()
        .optional()
        .describe("Database to export. Optional if MYSQL_DB is configured."),
      outputDir: z
        .string()
        .optional()
        .describe(
          "Folder where schema.sql and procedures/, functions/, views/, triggers/, events/ are created. Optional if MYSQL_SCHEMA_EXPORT_DIR is configured.",
        ),
      outputPath: z
        .string()
        .optional()
        .describe("Backward-compatible alias of outputDir"),
      includeDatabaseStatement: z
        .boolean()
        .optional()
        .describe("Include CREATE DATABASE / USE at the top. Default: true."),
    },
    WRITES_DATA,
  );

  registerDispatchedTool(
    server,
    "mysql_generate_migration",
    "Generate migration SQL",
    {
      sourceDb: z.string().describe("Source database (desired state)"),
      targetDb: z.string().describe("Target database (will be modified to match)"),
    },
    READ_ONLY,
  );

  // ==========================================================================
  // SQL logic execution (write / destructive)
  // ==========================================================================
  registerDispatchedTool(
    server,
    "mysql_call_procedure",
    "Call stored procedure",
    {
      procedureName: z.string().describe("Name of the stored procedure to execute"),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("IN parameter values in the order defined by the procedure"),
      outParams: z
        .array(z.string())
        .optional()
        .describe(
          "Names for OUT/INOUT parameters, appended after the IN params as @name variables and returned after the call. Example: ['total', 'status']",
        ),
      database: z.string().optional().describe("Database where the procedure exists"),
    },
    WRITES_DATA,
  );

  registerDispatchedTool(
    server,
    "mysql_create_procedure",
    "Create stored procedure",
    {
      procedureName: z.string().describe("Name of the procedure to create"),
      procedureBody: z
        .string()
        .describe("SQL statements inside BEGIN...END block"),
      database: z.string().optional().describe("Database where to create it"),
      parameters: z
        .string()
        .optional()
        .describe("Parameters definition, e.g. 'IN user_id INT, OUT total INT'"),
      characteristics: z
        .object({
          comment: z.string().optional(),
          language: z.literal("SQL").optional(),
          deterministic: z.boolean().optional(),
          containsSql: z
            .enum(["CONTAINS SQL", "NO SQL", "READS SQL DATA", "MODIFIES SQL DATA"])
            .optional(),
          sqlSecurity: z.enum(["DEFINER", "INVOKER"]).optional(),
        })
        .optional()
        .describe("Optional procedure characteristics"),
    },
    WRITES_DATA,
  );

  registerDispatchedTool(
    server,
    "mysql_alter_procedure",
    "Alter stored procedure",
    {
      procedureName: z.string().describe("Name of the existing procedure to modify"),
      procedureBody: z.string().describe("Updated SQL statements inside BEGIN...END"),
      database: z.string().optional().describe("Database where the procedure exists"),
      parameters: z.string().optional().describe("Updated parameters definition"),
      characteristics: z
        .object({
          comment: z.string().optional(),
          language: z.literal("SQL").optional(),
          deterministic: z.boolean().optional(),
          containsSql: z
            .enum(["CONTAINS SQL", "NO SQL", "READS SQL DATA", "MODIFIES SQL DATA"])
            .optional(),
          sqlSecurity: z.enum(["DEFINER", "INVOKER"]).optional(),
        })
        .optional(),
      ifExists: z
        .boolean()
        .optional()
        .describe("Use DROP PROCEDURE IF EXISTS to avoid errors when missing"),
    },
    DESTRUCTIVE,
  );

  registerDispatchedTool(
    server,
    "mysql_alter_table",
    "Alter table",
    {
      table: z.string().describe("Name of the table to modify"),
      alterStatement: z
        .string()
        .describe(
          "Operation without the 'ALTER TABLE name' prefix, e.g. 'ADD COLUMN name VARCHAR(100) NOT NULL'",
        ),
      database: z.string().optional().describe("Database where the table exists"),
    },
    DESTRUCTIVE,
  );

  // ==========================================================================
  // Administration (gated by ALLOW_ADMIN_OPERATION)
  // ==========================================================================
  registerDispatchedTool(
    server,
    "mysql_kill_process",
    "Kill process",
    {
      processId: z
        .number()
        .int()
        .positive()
        .describe("Process ID to kill (from mysql_process_list)"),
      mode: z
        .enum(["connection", "query"])
        .optional()
        .describe(
          "'connection' (default) terminates the whole connection; 'query' aborts only the running statement",
        ),
    },
    DESTRUCTIVE,
  );
}
