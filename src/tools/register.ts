/**
 * Modern MCP tool registration (SDK 1.x high-level API).
 *
 * Registers every tool through McpServer.registerTool with:
 *  - Zod input schemas (validated by the SDK before the handler runs)
 *  - title + annotations (readOnlyHint / destructiveHint / idempotentHint)
 *  - outputSchema + structuredContent on every tool
 *  - progress notifications + client cancellation for long-running tools
 *  - optional elicitation (human confirmation) before destructive actions
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
  type ToolContext,
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

// Tools that ask for human confirmation (via elicitation) before running,
// when the client supports it. Disable with MYSQL_ELICIT_CONFIRM=false.
const CONFIRM_BEFORE_RUN: Record<string, (args: any) => string> = {
  mysql_kill_process: (args) =>
    `KILL ${args.mode === "query" ? "QUERY " : ""}${args.processId}`,
  mysql_alter_table: (args) =>
    `ALTER TABLE ${args.database ? `${args.database}.` : ""}${args.table} ${String(args.alterStatement).substring(0, 120)}`,
  mysql_alter_procedure: (args) =>
    `Recrear (DROP + CREATE) el procedure ${args.database ? `${args.database}.` : ""}${args.procedureName}`,
};

/**
 * Ask the user to confirm a destructive action via elicitation.
 * Returns true (confirmed), false (rejected) or null (client does not
 * support elicitation / disabled → proceed as before).
 */
async function confirmDestructiveAction(
  server: McpServer,
  summary: string,
): Promise<boolean | null> {
  if (process.env.MYSQL_ELICIT_CONFIRM === "false") {
    return null;
  }
  try {
    const capabilities = server.server.getClientCapabilities();
    if (!capabilities?.elicitation) {
      return null;
    }
    const result = await server.server.elicitInput({
      mode: "form",
      message: `Confirmación requerida antes de ejecutar una operación destructiva:\n${summary}`,
      requestedSchema: {
        type: "object",
        properties: {
          confirmar: {
            type: "boolean",
            title: "¿Ejecutar la operación?",
            description: summary,
          },
        },
        required: ["confirmar"],
      },
    });
    return result.action === "accept" && (result.content as any)?.confirmar === true;
  } catch (error) {
    log("error", "Elicitation failed, proceeding without confirmation:", error);
    return null;
  }
}

// Build the ToolContext (progress + cancellation) from the request extra
function buildToolContext(extra: any): ToolContext {
  const progressToken = extra?._meta?.progressToken;
  return {
    signal: extra?.signal,
    reportProgress:
      progressToken !== undefined && typeof extra?.sendNotification === "function"
        ? async (progress: number, total: number, message?: string) => {
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, total, message },
              });
            } catch {
              // progress is best-effort
            }
          }
        : undefined,
  };
}

// Attach structuredContent from the tool's primary JSON payload. Clients
// validate structuredContent against the declared outputSchema with
// additionalProperties:false, so undeclared top-level keys are moved under
// the declared `extra` field instead of failing validation.
function withStructuredContent(
  result: ToolResult,
  allowedKeys: Set<string>,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    content: result.content,
    isError: result.isError,
  };

  if (!result.isError) {
    const text = result.content[0]?.text ?? "";
    let structured: Record<string, unknown> = { message: text };
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        structured = { items: parsed };
      } else if (parsed && typeof parsed === "object") {
        structured = {};
        const extra: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (allowedKeys.has(key)) {
            structured[key] = value;
          } else {
            extra[key] = value;
          }
        }
        if (Object.keys(extra).length > 0) {
          structured.extra = extra;
        }
      }
    } catch {
      // Plain-text payload (status messages, SQL scripts, CSV, mermaid)
    }
    response.structuredContent = structured;
  }

  return response;
}

// Register one tool backed by the handleAdditionalTool dispatcher
function registerDispatchedTool(
  server: McpServer,
  name: string,
  title: string,
  inputSchema: Record<string, z.ZodType> | undefined,
  outputSchema: Record<string, z.ZodType>,
  annotations: Record<string, boolean>,
) {
  const mergedOutputSchema: Record<string, z.ZodType> = {
    ...outputSchema,
    // Catch-alls: plain-text results (message), array results (items) and
    // undeclared top-level keys (extra) always validate
    message: z.string().optional(),
    items: z.array(z.unknown()).optional(),
    extra: z.unknown().optional(),
  };
  const allowedKeys = new Set(Object.keys(mergedOutputSchema));

  server.registerTool(
    name,
    {
      title,
      description: descriptions[name] || title,
      ...(inputSchema ? { inputSchema } : {}),
      outputSchema: mergedOutputSchema,
      annotations,
    },
    async (args: Record<string, any>, extra: any) => {
      const startTime = performance.now();
      try {
        // Human confirmation for destructive tools (when supported)
        const summaryBuilder = CONFIRM_BEFORE_RUN[name];
        if (summaryBuilder) {
          const confirmed = await confirmDestructiveAction(
            server,
            summaryBuilder(args ?? {}),
          );
          if (confirmed === false) {
            return {
              content: [
                {
                  type: "text",
                  text: "Operación cancelada: el usuario rechazó la confirmación.",
                },
              ],
              isError: true,
            } as any;
          }
        }

        const context = buildToolContext(extra);
        const result = await handleAdditionalTool(name, args ?? {}, context);
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
        return withStructuredContent(result, allowedKeys) as any;
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
  // mysql_query — primary tool
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
        allowFullTableWrite: z
          .boolean()
          .optional()
          .describe(
            "Required (true) to run UPDATE/DELETE without a WHERE clause. Default false: full-table writes are blocked as a safety guard.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "If true, write statements run inside a transaction that is ROLLED BACK: you get the real affectedRows without applying any change. Ideal to preview UPDATE/DELETE scope.",
          ),
      },
      outputSchema: {
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Result rows for read queries"),
        columns: z
          .array(z.object({ name: z.string(), type: z.string() }))
          .optional()
          .describe(
            "Column metadata: how to interpret each value (DECIMAL arrives as string, etc.)",
          ),
        rowCount: z.number().optional().describe("Total rows produced"),
        returnedRows: z.number().optional().describe("Rows actually returned"),
        truncated: z
          .boolean()
          .optional()
          .describe("True when rows were cut off by maxRows"),
        warnings: z
          .array(z.unknown())
          .optional()
          .describe("MySQL warnings (truncation, coercion...)"),
        operation: z
          .string()
          .optional()
          .describe("insert | update | delete | ddl | other (write queries)"),
        schema: z.string().nullable().optional(),
        affectedRows: z.number().optional(),
        changedRows: z.number().optional(),
        insertId: z.number().optional(),
        durationMs: z.number().optional(),
        dryRun: z
          .boolean()
          .optional()
          .describe("True when the write was rolled back (preview mode)"),
        message: z.string().optional(),
        result: z.unknown().optional(),
        error: z
          .object({
            message: z.string().optional(),
            code: z.string().optional(),
            errno: z.number().optional(),
            sqlState: z.string().optional(),
            hint: z.string().optional(),
          })
          .optional()
          .describe("Machine-readable error info (code + actionable hint)"),
      },
      annotations: {
        readOnlyHint: options.isReadOnly,
        destructiveHint: !options.isReadOnly,
        idempotentHint: options.isReadOnly,
        openWorldHint: false,
      },
    },
    async ({ sql, params, maxRows, allowFullTableWrite, dryRun }) => {
      const startTime = performance.now();
      try {
        const result = await executeReadOnlyQuery<{
          content: Array<{ type: string; text: string }>;
          structured?: Record<string, unknown>;
          isError: boolean;
        }>(sql, {
          maxRows: maxRows ?? 500,
          params,
          allowFullTableWrite,
          dryRun,
        });
        const duration = performance.now() - startTime;

        const rowCount =
          typeof result.structured?.rowCount === "number"
            ? (result.structured.rowCount as number)
            : 0;
        addToQueryHistory(sql, duration, rowCount, !result.isError);

        // structuredContent also on errors: the SDK skips output validation
        // when isError, and the machine-readable error code helps the model
        return {
          content: result.content,
          isError: result.isError,
          structuredContent:
            result.structured ?? { message: result.content[0]?.text ?? "" },
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
          "Output format: 'traditional' (default), 'json' (structured, best for automated analysis), or 'tree' (MySQL only)",
        ),
      analyze: z
        .boolean()
        .optional()
        .describe(
          "If true, also runs EXPLAIN ANALYZE / MariaDB ANALYZE (SELECT only — it actually executes the query) to compare estimated vs real rows. Default: false.",
        ),
    },
    {
      engine: z.string().optional(),
      explainPlan: z.unknown().optional(),
      format: z.string().optional(),
      suggestions: z.array(z.string()).optional(),
      issues: z
        .array(
          z.object({
            severity: z.string(),
            table: z.string().nullable(),
            issue: z.string(),
            suggestion: z.string(),
          }),
        )
        .optional()
        .describe("Ranked issues extracted from the JSON plan"),
      analyzeResult: z.unknown().optional(),
      analyzeNote: z.string().optional(),
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
      includeSampleRows: z
        .boolean()
        .optional()
        .describe("If true, includes up to 3 recent sample rows. Default: false."),
    },
    {
      table: z.string().optional(),
      database: z.string().optional(),
      columns: z.unknown().optional(),
      indexes: z.unknown().optional(),
      foreignKeys: z.unknown().optional(),
      referencedBy: z
        .unknown()
        .optional()
        .describe("Tables that reference this one (reverse FKs)"),
      triggers: z.unknown().optional(),
      checkConstraints: z.unknown().optional(),
      sampleRows: z.unknown().optional(),
      tableStats: z.unknown().optional(),
      createStatement: z.string().nullable().optional(),
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
      maxTables: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum tables to document in this call (pagination for large databases).",
        ),
      offsetTables: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "How many tables (alphabetical order) to skip before documenting. Combine with maxTables to page.",
        ),
    },
    {
      database: z.string().optional(),
      versionInfo: z.unknown().optional(),
      schemaHash: z
        .string()
        .optional()
        .describe("Stable hash of the structure: compare between calls to detect schema drift"),
      totalTablesInDatabase: z.number().optional(),
      totalTables: z.number().optional(),
      pagination: z.unknown().optional(),
      generatedAt: z.string().optional(),
      tables: z.unknown().optional(),
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
    {
      totalViews: z.number().optional(),
      views: z.unknown().optional(),
      viewName: z.string().optional(),
      database: z.string().optional(),
      columns: z.unknown().optional(),
      definition: z.string().nullable().optional(),
      isUpdatable: z.string().nullable().optional(),
      checkOption: z.string().nullable().optional(),
      definer: z.string().nullable().optional(),
      securityType: z.string().nullable().optional(),
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
    {
      database: z.string().optional(),
      routineName: z.string().optional(),
      requestedRoutineType: z.string().optional(),
      resolvedRoutineType: z.string().optional(),
      versionInfo: z.unknown().optional(),
      searchStrategy: z.unknown().optional(),
      routineAnalysis: z
        .unknown()
        .optional()
        .describe("Tables the routine touches + dynamic SQL detection"),
      summary: z.unknown().optional(),
      references: z.unknown().optional(),
      warnings: z.array(z.string()).optional(),
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
      format: z
        .enum(["json", "mermaid"])
        .optional()
        .describe(
          "'json' (default, relationship graph) or 'mermaid' (erDiagram ready to render/reason over)",
        ),
    },
    {
      totalRelationships: z.number().optional(),
      tables: z.number().optional(),
      relationships: z.unknown().optional(),
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
    {
      summary: z.unknown().optional(),
      tables: z.unknown().optional(),
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
    {
      analyzedTables: z.number().optional(),
      tablesWithSuggestions: z.number().optional(),
      priorityGuide: z.unknown().optional(),
      unusedIndexes: z
        .unknown()
        .optional()
        .describe("Real usage data from sys.schema_unused_indexes when available"),
      suggestions: z.unknown().optional(),
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
        .describe("If true, shows full query text (default: false, truncated to 120 chars)"),
      user: z.string().optional().describe("Filter by MySQL user"),
      db: z.string().optional().describe("Filter by database"),
      minTime: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Only processes running at least this many seconds"),
    },
    {
      analysis: z.unknown().optional(),
      innodbTransactions: z
        .unknown()
        .optional()
        .describe("Long-running InnoDB transactions (lock diagnosis)"),
      processes: z.unknown().optional(),
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
      onlyErrors: z
        .boolean()
        .optional()
        .describe("If true, returns only failed queries"),
      clear: z
        .boolean()
        .optional()
        .describe("If true, clears the history instead of returning it"),
    },
    {
      stats: z
        .unknown()
        .optional()
        .describe("Aggregates: totals, error count, slowest queries"),
      entries: z.unknown().optional(),
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
    {
      summary: z.unknown().optional(),
      tablesOnlyInSource: z.unknown().optional(),
      tablesOnlyInTarget: z.unknown().optional(),
      columnDifferences: z.unknown().optional(),
      indexDifferences: z.unknown().optional(),
      tableOptionDifferences: z.unknown().optional(),
      objectDifferences: z
        .unknown()
        .optional()
        .describe("Routines/views/triggers compared by definition hash"),
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
    {
      scope: z.string().optional(),
      totalVariables: z.number().optional(),
      filter: z.string().optional(),
      variables: z.unknown().optional(),
    },
    { ...READ_ONLY, idempotentHint: false },
  );

  // ==========================================================================
  // Export & data tools
  // ==========================================================================
  registerDispatchedTool(
    server,
    "mysql_export_data",
    "Export table data",
    {
      table: z.string().describe("Name of the table to export data from"),
      format: z
        .enum(["json", "csv", "sql"])
        .optional()
        .describe("'json' (default), 'csv', or 'sql' (INSERT statements ready to replay)"),
      database: z.string().optional().describe("Database name"),
      columns: z
        .array(z.string())
        .optional()
        .describe("Columns to export (default: all). Avoids SELECT * on wide tables."),
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
      outputFile: z
        .string()
        .optional()
        .describe(
          "If provided, writes the export to this file path and returns a summary instead of dumping the data into the conversation.",
        ),
    },
    {
      table: z.string().optional(),
      format: z.string().optional(),
      rowsExported: z.number().optional(),
      outputFile: z.string().optional(),
      sizeBytes: z.number().optional(),
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
    {
      database: z.string().optional(),
      outputDir: z.string().optional(),
      schemaFile: z.string().optional(),
      versionInfo: z.unknown().optional(),
      proceduresDir: z.string().optional(),
      functionsDir: z.string().optional(),
      viewsDir: z.string().optional(),
      triggersDir: z.string().optional(),
      eventsDir: z.string().optional(),
      includeSampleRows: z.boolean().optional(),
      tables: z.number().optional(),
      views: z.number().optional(),
      routines: z.number().optional(),
      triggers: z.number().optional(),
      events: z.number().optional(),
    },
    WRITES_DATA,
  );

  registerDispatchedTool(
    server,
    "mysql_sync_migration",
    "Sync two schemas (diff script)",
    {
      sourceDb: z.string().describe("Source database (desired state)"),
      targetDb: z.string().describe("Target database (will be modified to match)"),
    },
    {},
    READ_ONLY,
  );

  registerDispatchedTool(
    server,
    "mysql_generate_migration_files",
    "Generate migration files (one per table)",
    {
      database: z
        .string()
        .optional()
        .describe("Base de datos origen. Opcional si MYSQL_DB está configurada."),
      outputDir: z
        .string()
        .optional()
        .describe(
          "Carpeta destino. Opcional si MYSQL_SCHEMA_EXPORT_DIR está configurada (usa <dir>/migrations).",
        ),
      datePrefix: z
        .string()
        .regex(/^\d{4}_\d{2}_\d{2}$/)
        .optional()
        .describe("Prefijo de fecha de los archivos (YYYY_MM_DD). Default: hoy."),
      startSequence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Número de secuencia inicial (default 1 → 000001)."),
      ifNotExists: z
        .boolean()
        .optional()
        .describe("Usar CREATE TABLE IF NOT EXISTS para migraciones re-ejecutables. Default: true."),
      includeViews: z.boolean().optional().describe("Generar vistas. Default: true."),
      includeRoutines: z
        .boolean()
        .optional()
        .describe("Generar functions y procedures. Default: true."),
      includeTriggers: z.boolean().optional().describe("Generar triggers. Default: true."),
      includeEvents: z.boolean().optional().describe("Generar events. Default: true."),
      stripDefiner: z
        .boolean()
        .optional()
        .describe("Eliminar cláusulas DEFINER (portabilidad entre servidores). Default: true."),
      stripAutoIncrement: z
        .boolean()
        .optional()
        .describe("Eliminar el contador AUTO_INCREMENT=N del DDL. Default: true."),
    },
    {
      database: z.string().optional(),
      outputDir: z.string().optional(),
      totalFiles: z.number().optional(),
      tables: z.number().optional(),
      deferredForeignKeys: z
        .number()
        .optional()
        .describe("FKs movidas al archivo final add_foreign_keys (ciclos / otras bases)"),
      functions: z.number().optional(),
      procedures: z.number().optional(),
      views: z.number().optional(),
      triggers: z.number().optional(),
      events: z.number().optional(),
      circularDependencies: z.array(z.string()).optional(),
      executionOrder: z
        .array(
          z.object({
            file: z.string(),
            objectType: z.string(),
            name: z.string(),
          }),
        )
        .optional()
        .describe("Archivos generados en el orden exacto de ejecución"),
      warnings: z.array(z.string()).optional(),
    },
    WRITES_DATA,
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
        .describe(
          "One value per IN/INOUT parameter, in declared order. The real signature is validated before executing; OUT parameters are detected and returned automatically.",
        ),
      outParams: z
        .array(z.string())
        .optional()
        .describe(
          "Only needed when the procedure signature is not readable from information_schema: names for OUT variables appended after the IN params.",
        ),
      database: z.string().optional().describe("Database where the procedure exists"),
    },
    {},
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
    {},
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
    {},
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
    {},
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
    {},
    DESTRUCTIVE,
  );
}
