/**
 * Additional MySQL Tools for MCP Server
 * Provides extended functionality for database analysis, optimization, and management
 */

import { executeQuery, executeReadOnlyQuery, getPool } from "../db/index.js";
import { isDDLAllowedForSchema } from "../db/permissions.js";
import { ALLOW_ADMIN_OPERATION } from "../config/index.js";
import {
  log,
  escapeId,
  findSimilarNames,
  formatMysqlError,
  describeMysqlError,
} from "../utils/index.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

/**
 * Execution context threaded from the MCP layer into long-running tools:
 * progress notifications and client-side cancellation.
 */
export interface ToolContext {
  reportProgress?: (
    progress: number,
    total: number,
    message?: string,
  ) => Promise<void> | void;
  signal?: AbortSignal;
}

function throwIfAborted(context?: ToolContext): void {
  if (context?.signal?.aborted) {
    throw new Error("Operación cancelada por el cliente");
  }
}

// "Did you mean" helpers — turn not-found errors into immediate corrections
async function suggestSimilarTables(
  table: string,
  database?: string,
): Promise<string[]> {
  try {
    const rows = database
      ? await executeQuery<any[]>(
          `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
          [database],
        )
      : await executeQuery<any[]>(
          `SELECT TABLE_NAME as name FROM information_schema.TABLES
           WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')`,
        );
    return findSimilarNames(table, rows.map((row) => String(row.name)));
  } catch {
    return [];
  }
}

async function suggestSimilarRoutines(
  routine: string,
  database?: string,
): Promise<string[]> {
  try {
    const rows = database
      ? await executeQuery<any[]>(
          `SELECT ROUTINE_NAME as name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
          [database],
        )
      : await executeQuery<any[]>(
          `SELECT ROUTINE_NAME as name FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')`,
        );
    return findSimilarNames(routine, rows.map((row) => String(row.name)));
  } catch {
    return [];
  }
}

function didYouMean(suggestions: string[]): string {
  return suggestions.length > 0
    ? `\n¿Querías decir?: ${suggestions.join(", ")}`
    : "";
}

// Standard error result shared by permission gates
function permissionError(message: string): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// Resolve the schema a DDL-like tool call targets, for permission checks
function resolveSchema(database?: string): string | null {
  return database || process.env.MYSQL_DB || null;
}

// Query history storage (in-memory for session)
const queryHistory: Array<{
  id: number;
  sql: string;
  executedAt: Date;
  duration: number;
  rowCount: number;
  success: boolean;
  error?: string;
}> = [];

let queryIdCounter = 0;
const ROUTINE_DELIMITER = "$$";
let databaseVersionCache:
  | {
      version: string;
      versionComment: string;
      engine: "MariaDB" | "MySQL" | "Unknown";
      fullLabel: string;
    }
  | undefined;

/**
 * Add a query to the history
 */
export function addToQueryHistory(
  sql: string,
  duration: number,
  rowCount: number,
  success: boolean,
  error?: string,
): void {
  queryHistory.push({
    id: ++queryIdCounter,
    sql: sql.substring(0, 1000), // Limit SQL length
    executedAt: new Date(),
    duration,
    rowCount,
    success,
    error,
  });

  // Keep only last 100 queries
  if (queryHistory.length > 100) {
    queryHistory.shift();
  }
}

/**
 * Get query history
 */
export function getQueryHistory(
  limit: number = 50,
  onlyErrors: boolean = false,
): typeof queryHistory {
  const source = onlyErrors
    ? queryHistory.filter((entry) => !entry.success)
    : queryHistory;
  return source.slice(-limit);
}

/**
 * Aggregated session stats: lets the model self-review its own querying
 */
export function getQueryHistoryStats() {
  const total = queryHistory.length;
  const errors = queryHistory.filter((entry) => !entry.success).length;
  const avgDuration =
    total > 0
      ? queryHistory.reduce((sum, entry) => sum + entry.duration, 0) / total
      : 0;
  const slowestQueries = [...queryHistory]
    .sort((left, right) => right.duration - left.duration)
    .slice(0, 5)
    .map((entry) => ({
      sql: entry.sql.substring(0, 120),
      durationMs: Number(entry.duration.toFixed(2)),
      success: entry.success,
    }));
  return {
    totalQueries: total,
    errorCount: errors,
    avgDurationMs: Number(avgDuration.toFixed(2)),
    slowestQueries,
  };
}

/**
 * Clear query history
 */
export function clearQueryHistory(): void {
  queryHistory.length = 0;
  queryIdCounter = 0;
}

function stripTrailingSqlTerminator(statement: string): string {
  return statement.trim().replace(/[;\s]+$/g, "");
}

function buildDelimitedSqlBlock(
  statements: string[],
  delimiter: string = ROUTINE_DELIMITER,
): string {
  return [
    `DELIMITER ${delimiter}`,
    ...statements
      .filter((statement) => statement.trim().length > 0)
      .map(
        (statement) => `${stripTrailingSqlTerminator(statement)}${delimiter}`,
      ),
    "DELIMITER ;",
  ].join("\n\n");
}

async function getDatabaseVersionInfo(): Promise<{
  version: string;
  versionComment: string;
  engine: "MariaDB" | "MySQL" | "Unknown";
  fullLabel: string;
}> {
  if (databaseVersionCache) {
    return databaseVersionCache;
  }

  const result = await executeQuery<any[]>(
    `SELECT VERSION() AS version, @@version_comment AS versionComment`,
  );
  const row = result[0] || {};
  const version = String(row.version || "").trim();
  const versionComment = String(row.versionComment || "").trim();
  const fingerprint = `${version} ${versionComment}`.toLowerCase();
  const engine = fingerprint.includes("mariadb")
    ? "MariaDB"
    : fingerprint.length > 0
      ? "MySQL"
      : "Unknown";

  databaseVersionCache = {
    version,
    versionComment,
    engine,
    fullLabel: [engine, version, versionComment ? `(${versionComment})` : ""]
      .filter(Boolean)
      .join(" ")
      .trim(),
  };

  return databaseVersionCache;
}

function buildSqlVersionHeader(versionInfo: { fullLabel: string }): string {
  return `-- VERSION: ${versionInfo.fullLabel}`;
}

function prependSqlHeader(content: string, header: string): string {
  return [header, "", content.trimEnd()].join("\n");
}

// ============================================================================
// TOOL: mysql_explain - Analyze query execution plans
// ============================================================================

// Extract column names referenced in an attached_condition of a JSON plan
// (e.g. "((`db`.`t`.`status` = 'x') and (`db`.`t`.`type` = 2))")
function extractConditionColumns(condition: unknown): string[] {
  if (typeof condition !== "string") return [];
  const columns = new Set<string>();
  const qualified = condition.matchAll(
    /`[a-zA-Z0-9_]+`\.`[a-zA-Z0-9_]+`\.`([a-zA-Z0-9_]+)`/g,
  );
  for (const match of qualified) {
    columns.add(match[1]);
  }
  if (columns.size === 0) {
    const simple = condition.matchAll(/`([a-zA-Z0-9_]+)`/g);
    for (const match of simple) {
      columns.add(match[1]);
    }
  }
  return Array.from(columns).slice(0, 4);
}

// Walk an EXPLAIN FORMAT=JSON plan and collect ranked issues
function collectJsonPlanIssues(
  node: any,
  issues: Array<{
    severity: "critical" | "warning" | "info";
    table: string | null;
    issue: string;
    suggestion: string;
  }>,
): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) collectJsonPlanIssues(child, issues);
    return;
  }

  if (node.access_type === "ALL") {
    const rowsExamined = node.rows_examined_per_scan ?? node.rows ?? null;
    const conditionColumns = extractConditionColumns(node.attached_condition);
    issues.push({
      severity:
        typeof rowsExamined === "number" && rowsExamined > 10000
          ? "critical"
          : "warning",
      table: node.table_name ?? null,
      issue: `Full table scan${rowsExamined ? ` (~${rowsExamined} filas examinadas por pasada)` : ""}`,
      suggestion:
        conditionColumns.length > 0
          ? `Considera un índice compuesto sobre (${conditionColumns.join(", ")}) según las condiciones del WHERE`
          : "Considera añadir un índice para las columnas usadas en el WHERE/JOIN",
    });
  }

  if (node.access_type === "index" && node.using_index !== true) {
    issues.push({
      severity: "info",
      table: node.table_name ?? null,
      issue: "Escaneo completo de índice con acceso a filas",
      suggestion:
        "Un índice cubriente (que incluya las columnas del SELECT) evitaría leer la tabla",
    });
  }

  if (node.using_filesort === true) {
    issues.push({
      severity: "warning",
      table: node.table_name ?? null,
      issue: "Using filesort (ordenación sin índice)",
      suggestion: "Considera un índice que cubra las columnas del ORDER BY",
    });
  }

  if (node.using_temporary_table === true) {
    issues.push({
      severity: "warning",
      table: node.table_name ?? null,
      issue: "Using temporary table",
      suggestion:
        "GROUP BY/DISTINCT sin índice adecuado; revisa índices sobre las columnas agrupadas",
    });
  }

  for (const key of Object.keys(node)) {
    if (key === "attached_condition") continue;
    collectJsonPlanIssues(node[key], issues);
  }
}

export async function mysqlExplain(
  sql: string,
  format: "traditional" | "json" | "tree" = "traditional",
  analyze: boolean = false,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // Validate that it's a SELECT, UPDATE, DELETE, or INSERT query
    const normalizedSql = sql.trim().toUpperCase();
    if (
      !normalizedSql.startsWith("SELECT") &&
      !normalizedSql.startsWith("UPDATE") &&
      !normalizedSql.startsWith("DELETE") &&
      !normalizedSql.startsWith("INSERT")
    ) {
      return {
        content: [
          {
            type: "text",
            text: "Error: EXPLAIN only works with SELECT, UPDATE, DELETE, or INSERT queries",
          },
        ],
        isError: true,
      };
    }

    const versionInfo = await getDatabaseVersionInfo().catch(() => null);
    const isMariaDb = versionInfo?.engine === "MariaDB";

    // MariaDB does not support FORMAT=TREE; fall back to traditional
    let effectiveFormat = format;
    if (isMariaDb && format === "tree") {
      effectiveFormat = "traditional";
    }

    let explainSql: string;
    switch (effectiveFormat) {
      case "json":
        explainSql = `EXPLAIN FORMAT=JSON ${sql}`;
        break;
      case "tree":
        explainSql = `EXPLAIN FORMAT=TREE ${sql}`;
        break;
      default:
        explainSql = `EXPLAIN ${sql}`;
    }

    const result = await executeQuery<any[]>(explainSql);

    // EXPLAIN ANALYZE actually EXECUTES the statement, so it is opt-in and
    // restricted to SELECT: running it on UPDATE/DELETE would apply the write
    // and bypass the permission layer. MariaDB uses ANALYZE FORMAT=JSON,
    // which reports estimated (rows) vs actual (r_rows) per step.
    const analyzeSql = isMariaDb
      ? `ANALYZE FORMAT=JSON ${sql}`
      : `EXPLAIN ANALYZE ${sql}`;
    const analyzeResult =
      analyze && normalizedSql.startsWith("SELECT")
        ? await executeQuery<any[]>(analyzeSql).catch(() => null)
        : null;

    let response = {
      engine: versionInfo?.fullLabel || "unknown",
      explainPlan: result,
      format: effectiveFormat,
      suggestions: [] as string[],
      issues: [] as Array<{
        severity: "critical" | "warning" | "info";
        table: string | null;
        issue: string;
        suggestion: string;
      }>,
    };

    // Always fetch the JSON plan for structured issue analysis (cheap; it
    // does not execute the query)
    const jsonPlanResult =
      effectiveFormat === "json"
        ? result
        : await executeQuery<any[]>(`EXPLAIN FORMAT=JSON ${sql}`).catch(
            () => null,
          );

    if (jsonPlanResult) {
      const planRaw =
        jsonPlanResult[0]?.EXPLAIN ??
        jsonPlanResult[0]?.[Object.keys(jsonPlanResult[0] || {})[0]];
      try {
        const plan =
          typeof planRaw === "string" ? JSON.parse(planRaw) : planRaw;
        collectJsonPlanIssues(plan, response.issues);
      } catch {
        // JSON plan analysis is best-effort
      }
    }

    // Analyze the plan and provide suggestions
    if (format === "traditional" && Array.isArray(result)) {
      for (const row of result) {
        // MySQL EXPLAIN traditional format uses uppercase column names
        const type = row.type || row.Type;
        const table = row.table || row.Table;
        const key = row.key || row.Key;
        const possibleKeys = row.possible_keys || row.Possible_keys;
        const rows = row.rows || row.Rows;
        const extra = row.Extra || row.EXTRA;

        if (type === "ALL") {
          response.suggestions.push(
            `⚠️ Full table scan detected on '${table}'. Consider adding an index.`,
          );
        }
        if (type === "index" && rows && rows > 1000) {
          response.suggestions.push(
            `⚠️ Index scan on '${table}' returning ${rows} rows. Consider optimizing the query.`,
          );
        }
        if (!key && possibleKeys) {
          response.suggestions.push(
            `💡 Possible keys available but not used on '${table}': ${possibleKeys}`,
          );
        }
        if (extra && typeof extra === "string") {
          if (extra.includes("Using filesort")) {
            response.suggestions.push(
              `⚠️ Using filesort on '${table}'. Consider adding an index for ORDER BY columns.`,
            );
          }
          if (extra.includes("Using temporary")) {
            response.suggestions.push(
              `⚠️ Using temporary table on '${table}'. This may impact performance.`,
            );
          }
        }
      }
    }

    if (analyzeResult) {
      response = {
        ...response,
        analyzeResult,
        analyzeNote: isMariaDb
          ? "ANALYZE FORMAT=JSON: compara 'rows' (estimado) con 'r_rows' (real). Desviaciones grandes indican estadísticas desactualizadas (ejecuta ANALYZE TABLE)."
          : "EXPLAIN ANALYZE: compara los valores estimados (rows=N) con los reales (actual ... rows=N). Desviaciones grandes indican estadísticas desactualizadas (ejecuta ANALYZE TABLE).",
      } as any;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_explain:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_describe - Describe table structure
// ============================================================================

export async function mysqlDescribe(
  table: string,
  database?: string,
  includeSampleRows: boolean = false,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullTableName = database
      ? `${escapeId(database)}.${escapeId(table)}`
      : escapeId(table);

    // Get table structure
    const columns = await executeQuery<any[]>(`DESCRIBE ${fullTableName}`);

    // Get indexes
    const indexes = await executeQuery<any[]>(
      `SHOW INDEX FROM ${fullTableName}`,
    );

    // Get create table statement
    const createTable = await executeQuery<any[]>(
      `SHOW CREATE TABLE ${fullTableName}`,
    );

    // Get table status via information_schema (parameterized — SHOW TABLE
    // STATUS LIKE cannot take placeholders and was injectable)
    const statusQuery = `
      SELECT
        ENGINE as Engine,
        TABLE_ROWS as \`Rows\`,
        DATA_LENGTH as Data_length,
        INDEX_LENGTH as Index_length,
        AUTO_INCREMENT as Auto_increment,
        CREATE_TIME as Create_time,
        UPDATE_TIME as Update_time,
        TABLE_COLLATION as Collation
      FROM information_schema.TABLES
      WHERE TABLE_NAME = ?
        AND TABLE_SCHEMA = ${database ? "?" : "DATABASE()"}
      LIMIT 1`;
    const statusParams = database ? [table, database] : [table];
    const status = await executeQuery<any[]>(statusQuery, statusParams);

    // Get foreign keys
    const fkQuery = `
      SELECT 
        CONSTRAINT_NAME as constraintName,
        COLUMN_NAME as columnName,
        REFERENCED_TABLE_SCHEMA as referencedSchema,
        REFERENCED_TABLE_NAME as referencedTable,
        REFERENCED_COLUMN_NAME as referencedColumn
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_NAME = ? 
        ${database ? "AND TABLE_SCHEMA = ?" : ""}
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `;
    const fkParams = database ? [table, database] : [table];
    const foreignKeys = await executeQuery<any[]>(fkQuery, fkParams);

    // Reverse FKs: who references this table (critical to predict cascade
    // effects before UPDATE/DELETE)
    const referencedByQuery = `
      SELECT
        TABLE_SCHEMA as fromSchema,
        TABLE_NAME as fromTable,
        COLUMN_NAME as fromColumn,
        CONSTRAINT_NAME as constraintName,
        REFERENCED_COLUMN_NAME as toColumn
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_NAME = ?
        ${database ? "AND REFERENCED_TABLE_SCHEMA = ?" : ""}
    `;
    const referencedBy = await executeQuery<any[]>(
      referencedByQuery,
      database ? [table, database] : [table],
    );

    // Triggers attached to this table
    const triggersQuery = `
      SELECT
        TRIGGER_NAME as name,
        ACTION_TIMING as timing,
        EVENT_MANIPULATION as event
      FROM information_schema.TRIGGERS
      WHERE EVENT_OBJECT_TABLE = ?
        ${database ? "AND EVENT_OBJECT_SCHEMA = ?" : ""}
    `;
    const triggers = await executeQuery<any[]>(
      triggersQuery,
      database ? [table, database] : [table],
    ).catch(() => []);

    // CHECK constraints (MySQL 8.0.16+ / MariaDB 10.2+; best-effort)
    const checkConstraints = await executeQuery<any[]>(
      `SELECT cc.CONSTRAINT_NAME as name, cc.CHECK_CLAUSE as checkClause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       WHERE tc.TABLE_NAME = ?
         ${database ? "AND tc.TABLE_SCHEMA = ?" : ""}
         AND tc.CONSTRAINT_TYPE = 'CHECK'`,
      database ? [table, database] : [table],
    ).catch(() => []);

    // Optional sample rows (resolve current database when not provided)
    let sampleRows: any[] = [];
    if (includeSampleRows) {
      let targetDb = database;
      if (!targetDb) {
        const dbRow = await executeQuery<any[]>(`SELECT DATABASE() as db`);
        targetDb = dbRow[0]?.db || undefined;
      }
      if (targetDb) {
        sampleRows = await getTableSampleRows(targetDb, table, 3);
      }
    }

    const response = {
      table: table,
      database: database || "current",
      columns: columns,
      indexes: indexes.reduce((acc: any[], idx: any) => {
        const existing = acc.find((i) => i.keyName === idx.Key_name);
        if (existing) {
          existing.columns.push(idx.Column_name);
        } else {
          acc.push({
            keyName: idx.Key_name,
            unique: idx.Non_unique === 0,
            columns: [idx.Column_name],
            type: idx.Index_type,
          });
        }
        return acc;
      }, []),
      foreignKeys: foreignKeys,
      referencedBy,
      triggers,
      checkConstraints,
      ...(includeSampleRows ? { sampleRows } : {}),
      tableStats: status[0]
        ? {
            engine: status[0].Engine,
            rowCount: status[0].Rows,
            dataLength: status[0].Data_length,
            indexLength: status[0].Index_length,
            autoIncrement: status[0].Auto_increment,
            createTime: status[0].Create_time,
            updateTime: status[0].Update_time,
            collation: status[0].Collation,
          }
        : null,
      createStatement: createTable[0]?.["Create Table"] || null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_describe:", error);
    const info = describeMysqlError(error);
    const suggestions =
      info.code === "ER_NO_SUCH_TABLE"
        ? await suggestSimilarTables(table, database)
        : [];
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}${didYouMean(suggestions)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_data_dictionary - Generate AI-friendly table documentation
// ============================================================================

export async function mysqlDataDictionary(
  database?: string,
  table?: string,
  format: "json" | "markdown" = "json",
  sampleRowsLimit: number = 3,
  maxTables?: number,
  offsetTables: number = 0,
  context?: ToolContext,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    const versionInfo = await getDatabaseVersionInfo();
    if (!targetDatabase) {
      return {
        content: [
          {
            type: "text",
            text: "Error: database is required when MYSQL_DB is not configured",
          },
        ],
        isError: true,
      };
    }

    const allTables = await executeQuery<any[]>(
      `SELECT
         TABLE_NAME as tableName,
         TABLE_COMMENT as tableComment,
         ENGINE as engine,
         TABLE_ROWS as estimatedRows,
         CREATE_TIME as createTime,
         UPDATE_TIME as updateTime
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE = 'BASE TABLE'
         ${table ? "AND TABLE_NAME = ?" : ""}
       ORDER BY TABLE_NAME`,
      table ? [targetDatabase, table] : [targetDatabase],
    );

    if (table && allTables.length === 0) {
      const suggestions = await suggestSimilarTables(table, targetDatabase);
      return {
        content: [
          {
            type: "text",
            text: `Error: la tabla '${table}' no existe en '${targetDatabase}'.${didYouMean(suggestions)}`,
          },
        ],
        isError: true,
      };
    }

    // Deterministic pagination for large databases
    const safeOffset =
      Number.isInteger(offsetTables) && offsetTables > 0 ? offsetTables : 0;
    const safeMax =
      maxTables !== undefined && Number.isInteger(maxTables) && maxTables > 0
        ? maxTables
        : undefined;
    const tables =
      safeMax !== undefined || safeOffset > 0
        ? allTables.slice(safeOffset, safeMax ? safeOffset + safeMax : undefined)
        : allTables;

    const dictionaryTables = [];
    let processed = 0;

    for (const tableRow of tables) {
      const tableName = tableRow.tableName;
      throwIfAborted(context);
      processed++;
      await context?.reportProgress?.(
        processed,
        tables.length,
        `Documentando ${tableName}`,
      );

      const columns = await executeQuery<any[]>(
        `SELECT
           COLUMN_NAME as name,
           DATA_TYPE as dataType,
           COLUMN_TYPE as columnType,
           IS_NULLABLE as isNullable,
           COLUMN_DEFAULT as defaultValue,
           COLUMN_KEY as columnKey,
           EXTRA as extra,
           COLUMN_COMMENT as comment,
           ORDINAL_POSITION as ordinalPosition
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [targetDatabase, tableName],
      );

      const indexesRaw = await executeQuery<any[]>(
        `SHOW INDEX FROM \`${targetDatabase}\`.\`${tableName}\``,
      );

      const foreignKeys = await executeQuery<any[]>(
        `SELECT
           kcu.CONSTRAINT_NAME as constraintName,
           kcu.COLUMN_NAME as columnName,
           kcu.REFERENCED_TABLE_SCHEMA as referencedSchema,
           kcu.REFERENCED_TABLE_NAME as referencedTable,
           kcu.REFERENCED_COLUMN_NAME as referencedColumn,
           rc.UPDATE_RULE as onUpdate,
           rc.DELETE_RULE as onDelete
         FROM information_schema.KEY_COLUMN_USAGE kcu
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
          AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
         WHERE kcu.TABLE_SCHEMA = ?
           AND kcu.TABLE_NAME = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.ORDINAL_POSITION`,
        [targetDatabase, tableName],
      );

      const sampleRows =
        sampleRowsLimit > 0
          ? await getTableSampleRows(targetDatabase, tableName, sampleRowsLimit)
          : [];

      const indexes = indexesRaw.reduce((acc: any[], idx: any) => {
        const existing = acc.find((i) => i.keyName === idx.Key_name);
        if (existing) {
          existing.columns.push(idx.Column_name);
          existing.cardinality = idx.Cardinality ?? existing.cardinality;
        } else {
          acc.push({
            keyName: idx.Key_name,
            unique: idx.Non_unique === 0,
            indexType: idx.Index_type,
            columns: [idx.Column_name],
            // Index cardinality from statistics: free selectivity signal
            cardinality: idx.Cardinality ?? null,
          });
        }
        return acc;
      }, []);

      // Expose ENUM/SET allowed values explicitly so the model writes valid
      // WHERE clauses without guessing
      for (const column of columns) {
        const columnType = String(column.columnType || "");
        if (/^(enum|set)\(/i.test(columnType)) {
          const valuesMatch = columnType.match(/^\w+\((.*)\)$/);
          if (valuesMatch) {
            column.allowedValues = valuesMatch[1]
              .split(",")
              .map((value: string) =>
                value.trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'"),
              );
          }
        }
      }

      const primaryKey = columns
        .filter((column) => column.columnKey === "PRI")
        .map((column) => column.name);

      dictionaryTables.push({
        table: tableName,
        database: targetDatabase,
        comment: tableRow.tableComment || null,
        engine: tableRow.engine || null,
        estimatedRows: tableRow.estimatedRows ?? null,
        createTime: tableRow.createTime || null,
        updateTime: tableRow.updateTime || null,
        inferredPurpose: inferTablePurpose(tableName, columns, foreignKeys),
        primaryKey,
        columns,
        indexes,
        foreignKeys,
        sampleRows,
      });
    }

    // Stable hash of the structural definition: lets the model detect schema
    // drift between calls without re-reading everything
    const schemaHash = createHash("md5")
      .update(
        JSON.stringify(
          dictionaryTables.map((entry) => ({
            table: entry.table,
            columns: entry.columns.map((column: any) => ({
              name: column.name,
              type: column.columnType,
              nullable: column.isNullable,
              key: column.columnKey,
            })),
          })),
        ),
      )
      .digest("hex");

    const payload = {
      database: targetDatabase,
      versionInfo,
      schemaHash,
      totalTablesInDatabase: allTables.length,
      totalTables: dictionaryTables.length,
      ...(safeOffset > 0 || safeMax !== undefined
        ? {
            pagination: {
              offsetTables: safeOffset,
              maxTables: safeMax ?? null,
              hasMore: safeOffset + tables.length < allTables.length,
            },
          }
        : {}),
      generatedAt: new Date().toISOString(),
      tables: dictionaryTables,
    };

    const text =
      format === "markdown"
        ? renderDataDictionaryMarkdown(payload)
        : JSON.stringify(payload, null, 2);

    return {
      content: [{ type: "text", text }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_data_dictionary:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function inferTablePurpose(
  tableName: string,
  columns: any[],
  foreignKeys: any[],
): string {
  const normalizedTableName = tableName.toLowerCase();
  const columnNames = columns.map((column) =>
    String(column.name).toLowerCase(),
  );
  const hints: string[] = [];

  if (normalizedTableName.includes("user"))
    hints.push("stores user identities or profiles");
  if (
    normalizedTableName.includes("role") ||
    normalizedTableName.includes("permission")
  )
    hints.push("models authorization or access control");
  if (
    normalizedTableName.includes("log") ||
    normalizedTableName.includes("audit")
  )
    hints.push("captures audit trail or operational events");
  if (
    normalizedTableName.includes("config") ||
    normalizedTableName.includes("setting")
  )
    hints.push("stores configuration values");
  if (
    normalizedTableName.includes("session") ||
    normalizedTableName.includes("token")
  )
    hints.push("tracks sessions or authentication tokens");
  if (
    normalizedTableName.includes("order") ||
    normalizedTableName.includes("invoice")
  )
    hints.push("stores transactional or billing records");
  if (
    normalizedTableName.includes("detail") ||
    normalizedTableName.includes("item")
  )
    hints.push("acts as line-item detail for a parent entity");
  if (
    normalizedTableName.includes("catalog") ||
    normalizedTableName.includes("product")
  )
    hints.push("stores product or catalog information");
  if (
    normalizedTableName.includes("message") ||
    normalizedTableName.includes("notification")
  )
    hints.push("stores messages, alerts, or notifications");

  if (columnNames.includes("status"))
    hints.push("contains lifecycle or workflow state");
  if (columnNames.includes("created_at") || columnNames.includes("updated_at"))
    hints.push("tracks creation/update timestamps");
  if (columnNames.includes("deleted_at")) hints.push("supports soft deletion");
  if (columnNames.includes("email"))
    hints.push("contains contact or identity data");
  if (columnNames.includes("password") || columnNames.includes("password_hash"))
    hints.push("contains authentication-related data");

  if (foreignKeys.length >= 2)
    hints.push("links multiple business entities through foreign keys");
  else if (foreignKeys.length === 1)
    hints.push("references another core entity");

  if (hints.length === 0) {
    return "general-purpose application table; infer exact role from business naming and sample rows";
  }

  return hints.slice(0, 3).join("; ");
}

function renderDataDictionaryMarkdown(payload: any): string {
  const lines: string[] = [];

  lines.push(`# MySQL Data Dictionary`);
  lines.push("");
  lines.push(`- Database: \`${payload.database}\``);
  lines.push(`- Engine: \`${payload.versionInfo?.engine || "Unknown"}\``);
  lines.push(`- Version: \`${payload.versionInfo?.fullLabel || "Unknown"}\``);
  lines.push(`- Generated at: \`${payload.generatedAt}\``);
  lines.push(`- Total tables: ${payload.totalTables}`);
  lines.push("");

  for (const table of payload.tables) {
    lines.push(`## ${table.table}`);
    lines.push("");
    lines.push(`- Purpose: ${table.inferredPurpose}`);
    lines.push(`- Engine: ${table.engine || "unknown"}`);
    lines.push(`- Estimated rows: ${table.estimatedRows ?? "unknown"}`);
    lines.push(
      `- Primary key: ${table.primaryKey.length > 0 ? table.primaryKey.map((key: string) => `\`${key}\``).join(", ") : "none"}`,
    );
    if (table.comment) {
      lines.push(`- Comment: ${table.comment}`);
    }
    lines.push("");

    lines.push(`### Columns`);
    lines.push("");
    lines.push(`| Name | Type | Null | Key | Default | Extra | Comment |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    for (const column of table.columns) {
      lines.push(
        `| \`${column.name}\` | \`${column.columnType}\` | ${column.isNullable} | ${column.columnKey || ""} | ${column.defaultValue ?? ""} | ${column.extra || ""} | ${column.comment || ""} |`,
      );
    }
    lines.push("");

    lines.push(`### Indexes`);
    lines.push("");
    if (table.indexes.length === 0) {
      lines.push(`No indexes found.`);
    } else {
      for (const index of table.indexes) {
        lines.push(
          `- \`${index.keyName}\` (${index.unique ? "unique" : "non-unique"}, ${index.indexType}): ${index.columns.map((column: string) => `\`${column}\``).join(", ")}`,
        );
      }
    }
    lines.push("");

    lines.push(`### Foreign Keys`);
    lines.push("");
    if (table.foreignKeys.length === 0) {
      lines.push(`No foreign keys found.`);
    } else {
      for (const fk of table.foreignKeys) {
        lines.push(
          `- \`${fk.columnName}\` -> \`${fk.referencedSchema}.${fk.referencedTable}.${fk.referencedColumn}\` (${fk.onUpdate || "?"}/${fk.onDelete || "?"})`,
        );
      }
    }
    lines.push("");

    lines.push(`### Sample Rows`);
    lines.push("");
    if (table.sampleRows.length === 0) {
      lines.push(`No sample rows available.`);
    } else {
      lines.push("```json");
      lines.push(JSON.stringify(table.sampleRows, null, 2));
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// TOOL: mysql_backup - Export table data to JSON/CSV
// ============================================================================

export async function mysqlBackup(
  table: string,
  format: "json" | "csv" | "sql" = "json",
  database?: string,
  whereClause?: string,
  limit?: number,
  columns?: string[],
  outputFile?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullTableName = database
      ? `${escapeId(database)}.${escapeId(table)}`
      : escapeId(table);

    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      return {
        content: [
          { type: "text", text: "Error: limit must be a non-negative integer" },
        ],
        isError: true,
      };
    }

    const selectClause =
      columns && columns.length > 0
        ? columns.map((column) => escapeId(column)).join(", ")
        : "*";

    let sql = `SELECT ${selectClause} FROM ${fullTableName}`;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const rows = await executeQuery<any[]>(sql);

    let output: string;
    if (format === "sql") {
      // INSERT statements ready to replay
      if (rows.length === 0) {
        output = `-- No rows found in ${table}`;
      } else {
        const columnNames = Object.keys(rows[0]);
        const escapeSqlValue = (value: any): string => {
          if (value === null || value === undefined) return "NULL";
          if (typeof value === "number") return String(value);
          if (typeof value === "boolean") return value ? "1" : "0";
          if (value instanceof Date) {
            return `'${value.toISOString().slice(0, 19).replace("T", " ")}'`;
          }
          return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
        };
        output = rows
          .map(
            (row) =>
              `INSERT INTO ${fullTableName} (${columnNames.map((name) => escapeId(name)).join(", ")}) VALUES (${columnNames.map((name) => escapeSqlValue(row[name])).join(", ")});`,
          )
          .join("\n");
      }
    } else if (format === "csv") {
      if (rows.length === 0) {
        output = "";
      } else {
        const headers = Object.keys(rows[0]);
        const csvRows = [
          headers.join(","),
          ...rows.map((row) =>
            headers
              .map((h) => {
                const val = row[h];
                if (val === null) return "";
                if (
                  typeof val === "string" &&
                  (val.includes(",") || val.includes('"') || val.includes("\n"))
                ) {
                  return `"${val.replace(/"/g, '""')}"`;
                }
                return String(val);
              })
              .join(","),
          ),
        ];
        output = csvRows.join("\n");
      }
    } else {
      output = JSON.stringify(rows, null, 2);
    }

    // Write to disk instead of flooding the model context with data
    if (outputFile) {
      const resolvedPath = path.resolve(outputFile);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, output, "utf8");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                table,
                format,
                rowsExported: rows.length,
                outputFile: resolvedPath,
                sizeBytes: Buffer.byteLength(output, "utf8"),
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        { type: "text", text: output },
        {
          type: "text",
          text: `\n--- Exported ${rows.length} rows from ${table} as ${format.toUpperCase()} ---`,
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_backup:", error);
    const info = describeMysqlError(error);
    const suggestions =
      info.code === "ER_NO_SUCH_TABLE"
        ? await suggestSimilarTables(table, database)
        : [];
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}${didYouMean(suggestions)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_export_schema - Export full database schema to SQL file
// ============================================================================

export async function mysqlExportSchema(
  database?: string,
  outputDir?: string,
  includeDatabaseStatement: boolean = true,
  context?: ToolContext,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    const versionInfo = await getDatabaseVersionInfo();
    if (!targetDatabase) {
      return {
        content: [
          {
            type: "text",
            text: "Error: database is required when MYSQL_DB is not configured",
          },
        ],
        isError: true,
      };
    }

    const configuredOutputDir =
      process.env.MYSQL_SCHEMA_EXPORT_DIR ||
      process.env.MYSQL_SCHEMA_EXPORT_PATH;
    const finalOutputDir = outputDir || configuredOutputDir;
    if (!finalOutputDir) {
      return {
        content: [
          {
            type: "text",
            text: "Error: outputDir is required or set MYSQL_SCHEMA_EXPORT_DIR",
          },
        ],
        isError: true,
      };
    }

    const includeSampleRows =
      process.env.MYSQL_SCHEMA_EXPORT_INCLUDE_SAMPLE_ROWS === "true";
    const resolvedOutputDir = path.resolve(finalOutputDir);
    const schemaStatements: string[] = [];
    const proceduresDir = path.join(resolvedOutputDir, "procedures");
    const functionsDir = path.join(resolvedOutputDir, "functions");
    const viewsDir = path.join(resolvedOutputDir, "views");
    const triggersDir = path.join(resolvedOutputDir, "triggers");
    const eventsDir = path.join(resolvedOutputDir, "events");

    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    fs.mkdirSync(proceduresDir, { recursive: true });
    fs.mkdirSync(functionsDir, { recursive: true });
    fs.mkdirSync(viewsDir, { recursive: true });
    fs.mkdirSync(triggersDir, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });

    schemaStatements.push(buildSqlVersionHeader(versionInfo));

    if (includeDatabaseStatement) {
      const createDatabaseResult = await executeQuery<any[]>(
        `SHOW CREATE DATABASE \`${targetDatabase}\``,
      );
      const createDatabaseStatement =
        createDatabaseResult[0]?.["Create Database"] ||
        createDatabaseResult[0]?.["CREATE DATABASE"];

      if (createDatabaseStatement) {
        schemaStatements.push(`${createDatabaseStatement};`);
      }

      schemaStatements.push(`USE \`${targetDatabase}\`;`);
    }

    const tables = await executeQuery<any[]>(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [targetDatabase],
    );

    let exportedCount = 0;
    for (const table of tables) {
      throwIfAborted(context);
      await context?.reportProgress?.(
        ++exportedCount,
        tables.length,
        `Exportando tabla ${table.TABLE_NAME}`,
      );
      const createTableResult = await executeQuery<any[]>(
        `SHOW CREATE TABLE \`${targetDatabase}\`.\`${table.TABLE_NAME}\``,
      );
      const createTableStatement =
        createTableResult[0]?.["Create Table"] ||
        createTableResult[0]?.["CREATE TABLE"];

      if (createTableStatement) {
        schemaStatements.push(`DROP TABLE IF EXISTS \`${table.TABLE_NAME}\`;`);
        schemaStatements.push(`${createTableStatement};`);

        if (includeSampleRows) {
          const sampleRows = await getTableSampleRows(
            targetDatabase,
            table.TABLE_NAME,
          );
          if (sampleRows.length > 0) {
            schemaStatements.push(
              [
                `-- SAMPLE_ROWS ${table.TABLE_NAME} (up to 3 latest rows)`,
                ...sampleRows.map((row) => `-- ${JSON.stringify(row)}`),
              ].join("\n"),
            );
          } else {
            schemaStatements.push(
              `-- SAMPLE_ROWS ${table.TABLE_NAME} (no rows found or unable to infer ordering)`,
            );
          }
        }
      }
    }

    const views = await executeQuery<any[]>(
      `SELECT TABLE_NAME
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [targetDatabase],
    );

    let viewCount = 0;
    for (const view of views) {
      throwIfAborted(context);
      await context?.reportProgress?.(
        ++viewCount,
        views.length,
        `Exportando vista ${view.TABLE_NAME}`,
      );
      const createViewResult = await executeQuery<any[]>(
        `SHOW CREATE VIEW \`${targetDatabase}\`.\`${view.TABLE_NAME}\``,
      );
      const createViewStatement =
        createViewResult[0]?.["Create View"] ||
        createViewResult[0]?.["CREATE VIEW"];

      if (createViewStatement) {
        const viewFilePath = path.join(viewsDir, `${view.TABLE_NAME}.sql`);
        const viewSql = prependSqlHeader(
          [
            includeDatabaseStatement ? `USE \`${targetDatabase}\`;` : "",
            `DROP VIEW IF EXISTS \`${view.TABLE_NAME}\`;`,
            `${createViewStatement};`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          buildSqlVersionHeader(versionInfo),
        );

        fs.writeFileSync(viewFilePath, `${viewSql}\n`, "utf8");
      }
    }

    const routines = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
       ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [targetDatabase],
    );

    let routineCount = 0;
    for (const routine of routines) {
      throwIfAborted(context);
      await context?.reportProgress?.(
        ++routineCount,
        routines.length,
        `Exportando rutina ${routine.ROUTINE_NAME}`,
      );
      if (routine.ROUTINE_TYPE === "PROCEDURE") {
        const createProcedureResult = await executeQuery<any[]>(
          `SHOW CREATE PROCEDURE \`${targetDatabase}\`.\`${routine.ROUTINE_NAME}\``,
        );
        const createProcedureStatement =
          createProcedureResult[0]?.["Create Procedure"];

        if (createProcedureStatement) {
          const procedureFilePath = path.join(
            proceduresDir,
            `${routine.ROUTINE_NAME}.sql`,
          );
          const procedureSql = prependSqlHeader(
            buildDelimitedSqlBlock([
              includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
              `DROP PROCEDURE IF EXISTS \`${routine.ROUTINE_NAME}\``,
              createProcedureStatement,
            ]),
            buildSqlVersionHeader(versionInfo),
          );

          fs.writeFileSync(procedureFilePath, `${procedureSql}\n`, "utf8");
        }
      } else if (routine.ROUTINE_TYPE === "FUNCTION") {
        const createFunctionResult = await executeQuery<any[]>(
          `SHOW CREATE FUNCTION \`${targetDatabase}\`.\`${routine.ROUTINE_NAME}\``,
        );
        const createFunctionStatement =
          createFunctionResult[0]?.["Create Function"];

        if (createFunctionStatement) {
          const functionFilePath = path.join(
            functionsDir,
            `${routine.ROUTINE_NAME}.sql`,
          );
          const functionSql = prependSqlHeader(
            buildDelimitedSqlBlock([
              includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
              `DROP FUNCTION IF EXISTS \`${routine.ROUTINE_NAME}\``,
              createFunctionStatement,
            ]),
            buildSqlVersionHeader(versionInfo),
          );

          fs.writeFileSync(functionFilePath, `${functionSql}\n`, "utf8");
        }
      }
    }

    const triggers = await executeQuery<any[]>(
      `SELECT TRIGGER_NAME
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
       ORDER BY TRIGGER_NAME`,
      [targetDatabase],
    );

    for (const trigger of triggers) {
      const createTriggerResult = await executeQuery<any[]>(
        `SHOW CREATE TRIGGER \`${targetDatabase}\`.\`${trigger.TRIGGER_NAME}\``,
      );
      const createTriggerStatement =
        createTriggerResult[0]?.["SQL Original Statement"] ||
        createTriggerResult[0]?.["Create Trigger"];

      if (createTriggerStatement) {
        const triggerFilePath = path.join(
          triggersDir,
          `${trigger.TRIGGER_NAME}.sql`,
        );
        const triggerSql = prependSqlHeader(
          buildDelimitedSqlBlock([
            includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
            `DROP TRIGGER IF EXISTS \`${trigger.TRIGGER_NAME}\``,
            createTriggerStatement,
          ]),
          buildSqlVersionHeader(versionInfo),
        );

        fs.writeFileSync(triggerFilePath, `${triggerSql}\n`, "utf8");
        schemaStatements.push(
          buildDelimitedSqlBlock([
            `DROP TRIGGER IF EXISTS \`${trigger.TRIGGER_NAME}\``,
            createTriggerStatement,
          ]),
        );
      }
    }

    const events = await executeQuery<any[]>(
      `SELECT EVENT_NAME
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ?
       ORDER BY EVENT_NAME`,
      [targetDatabase],
    );

    for (const event of events) {
      const createEventResult = await executeQuery<any[]>(
        `SHOW CREATE EVENT \`${targetDatabase}\`.\`${event.EVENT_NAME}\``,
      );
      const createEventStatement = createEventResult[0]?.["Create Event"];

      if (createEventStatement) {
        const eventFilePath = path.join(eventsDir, `${event.EVENT_NAME}.sql`);
        const eventSql = prependSqlHeader(
          buildDelimitedSqlBlock([
            includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
            `DROP EVENT IF EXISTS \`${event.EVENT_NAME}\``,
            createEventStatement,
          ]),
          buildSqlVersionHeader(versionInfo),
        );

        fs.writeFileSync(eventFilePath, `${eventSql}\n`, "utf8");
        schemaStatements.push(
          buildDelimitedSqlBlock([
            `DROP EVENT IF EXISTS \`${event.EVENT_NAME}\``,
            createEventStatement,
          ]),
        );
      }
    }

    const schemaFilePath = path.join(resolvedOutputDir, "schema.sql");
    fs.writeFileSync(
      schemaFilePath,
      schemaStatements.join("\n\n") + "\n",
      "utf8",
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              database: targetDatabase,
              outputDir: resolvedOutputDir,
              schemaFile: schemaFilePath,
              versionInfo,
              proceduresDir,
              functionsDir,
              viewsDir,
              triggersDir,
              eventsDir,
              includeSampleRows,
              tables: tables.length,
              views: views.length,
              routines: routines.length,
              triggers: triggers.length,
              events: events.length,
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_export_schema:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function getTableSampleRows(
  database: string,
  table: string,
  limit: number = 3,
): Promise<any[]> {
  try {
    const orderingColumns = await executeQuery<any[]>(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, EXTRA, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table],
    );

    const primaryKeyColumn = orderingColumns.find(
      (column) => column.COLUMN_KEY === "PRI",
    )?.COLUMN_NAME;

    const timestampColumn = orderingColumns.find((column) =>
      ["timestamp", "datetime", "date"].includes(
        String(column.DATA_TYPE).toLowerCase(),
      ),
    )?.COLUMN_NAME;

    const autoIncrementColumn = orderingColumns.find((column) =>
      String(column.EXTRA).toLowerCase().includes("auto_increment"),
    )?.COLUMN_NAME;

    const orderByColumn =
      autoIncrementColumn || primaryKeyColumn || timestampColumn;

    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 3;
    const qualifiedTable = `${escapeId(database)}.${escapeId(table)}`;
    const sampleSql = orderByColumn
      ? `SELECT * FROM ${qualifiedTable} ORDER BY ${escapeId(orderByColumn)} DESC LIMIT ${safeLimit}`
      : `SELECT * FROM ${qualifiedTable} LIMIT ${safeLimit}`;

    return await executeQuery<any[]>(sampleSql);
  } catch (error) {
    log("error", `Error getting sample rows for ${database}.${table}:`, error);
    return [];
  }
}

// ============================================================================
// TOOL: mysql_compare_schemas - Compare two database schemas
// ============================================================================

export async function mysqlCompareSchemas(
  sourceDb: string,
  targetDb: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // Get tables (with options) from both databases
    const sourceTablesResult = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name, ENGINE as engine, TABLE_COLLATION as collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [sourceDb],
    );
    const targetTablesResult = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name, ENGINE as engine, TABLE_COLLATION as collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [targetDb],
    );

    const sourceTables = new Set(sourceTablesResult.map((t) => t.name));
    const targetTables = new Set(targetTablesResult.map((t) => t.name));
    const sourceTableOptions = new Map(
      sourceTablesResult.map((t) => [t.name, t]),
    );
    const targetTableOptions = new Map(
      targetTablesResult.map((t) => [t.name, t]),
    );

    const differences: any = {
      summary: {
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        sourceTotalTables: sourceTables.size,
        targetTotalTables: targetTables.size,
      },
      tablesOnlyInSource: [] as string[],
      tablesOnlyInTarget: [] as string[],
      columnDifferences: [] as any[],
      indexDifferences: [] as any[],
      tableOptionDifferences: [] as any[],
      objectDifferences: {} as Record<string, any>,
    };

    // Find tables only in source
    for (const table of sourceTables) {
      if (!targetTables.has(table)) {
        differences.tablesOnlyInSource.push(table);
      }
    }

    // Find tables only in target
    for (const table of targetTables) {
      if (!sourceTables.has(table)) {
        differences.tablesOnlyInTarget.push(table);
      }
    }

    // Compare common tables
    const commonTables = [...sourceTables].filter((t) => targetTables.has(t));

    for (const table of commonTables) {
      // Compare columns
      const sourceColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA 
         FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [sourceDb, table],
      );

      const targetColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA 
         FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [targetDb, table],
      );

      const sourceColMap = new Map(
        sourceColumns.map((c) => [c.COLUMN_NAME, c]),
      );
      const targetColMap = new Map(
        targetColumns.map((c) => [c.COLUMN_NAME, c]),
      );

      const tableDiff: any = {
        table,
        columnsOnlyInSource: [],
        columnsOnlyInTarget: [],
        columnTypeDifferences: [],
      };

      // Check columns only in source
      for (const [colName, col] of sourceColMap) {
        if (!targetColMap.has(colName)) {
          tableDiff.columnsOnlyInSource.push(colName);
        } else {
          const targetCol = targetColMap.get(colName)!;
          if (
            col.COLUMN_TYPE !== targetCol.COLUMN_TYPE ||
            col.IS_NULLABLE !== targetCol.IS_NULLABLE
          ) {
            // Narrowing types or adding NOT NULL can lose/reject data
            const sourceType = String(col.COLUMN_TYPE);
            const targetType = String(targetCol.COLUMN_TYPE);
            const severity =
              sourceType.length < targetType.length ||
              (col.IS_NULLABLE === "NO" && targetCol.IS_NULLABLE === "YES")
                ? "breaking"
                : "safe";
            tableDiff.columnTypeDifferences.push({
              column: colName,
              severity,
              source: { type: col.COLUMN_TYPE, nullable: col.IS_NULLABLE },
              target: {
                type: targetCol.COLUMN_TYPE,
                nullable: targetCol.IS_NULLABLE,
              },
            });
          }
        }
      }

      // Check columns only in target
      for (const colName of targetColMap.keys()) {
        if (!sourceColMap.has(colName)) {
          tableDiff.columnsOnlyInTarget.push(colName);
        }
      }

      if (
        tableDiff.columnsOnlyInSource.length > 0 ||
        tableDiff.columnsOnlyInTarget.length > 0 ||
        tableDiff.columnTypeDifferences.length > 0
      ) {
        differences.columnDifferences.push(tableDiff);
      }

      // Compare indexes (grouped by index name: column list + uniqueness)
      const loadIndexes = async (db: string) => {
        const rows = await executeQuery<any[]>(
          `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [db, table],
        );
        const map = new Map<string, { unique: boolean; columns: string[] }>();
        for (const row of rows) {
          const entry = map.get(row.INDEX_NAME) || {
            unique: row.NON_UNIQUE === 0,
            columns: [],
          };
          entry.columns.push(row.COLUMN_NAME);
          map.set(row.INDEX_NAME, entry);
        }
        return map;
      };

      const sourceIndexes = await loadIndexes(sourceDb);
      const targetIndexes = await loadIndexes(targetDb);

      const indexDiff: any = {
        table,
        indexesOnlyInSource: [] as any[],
        indexesOnlyInTarget: [] as string[],
        indexDefinitionDifferences: [] as any[],
      };

      for (const [indexName, sourceIndex] of sourceIndexes) {
        const targetIndex = targetIndexes.get(indexName);
        if (!targetIndex) {
          indexDiff.indexesOnlyInSource.push({
            name: indexName,
            unique: sourceIndex.unique,
            columns: sourceIndex.columns,
          });
        } else if (
          sourceIndex.unique !== targetIndex.unique ||
          sourceIndex.columns.join(",") !== targetIndex.columns.join(",")
        ) {
          indexDiff.indexDefinitionDifferences.push({
            name: indexName,
            source: sourceIndex,
            target: targetIndex,
          });
        }
      }

      for (const indexName of targetIndexes.keys()) {
        if (!sourceIndexes.has(indexName)) {
          indexDiff.indexesOnlyInTarget.push(indexName);
        }
      }

      if (
        indexDiff.indexesOnlyInSource.length > 0 ||
        indexDiff.indexesOnlyInTarget.length > 0 ||
        indexDiff.indexDefinitionDifferences.length > 0
      ) {
        differences.indexDifferences.push(indexDiff);
      }

      // Compare table options (engine, collation)
      const sourceOptions = sourceTableOptions.get(table);
      const targetOptions = targetTableOptions.get(table);
      if (
        sourceOptions &&
        targetOptions &&
        (sourceOptions.engine !== targetOptions.engine ||
          sourceOptions.collation !== targetOptions.collation)
      ) {
        differences.tableOptionDifferences.push({
          table,
          source: {
            engine: sourceOptions.engine,
            collation: sourceOptions.collation,
          },
          target: {
            engine: targetOptions.engine,
            collation: targetOptions.collation,
          },
        });
      }
    }

    // Compare routines, views and triggers by definition hash
    const hashBody = (body: unknown): string =>
      createHash("md5")
        .update(String(body ?? "").replace(/\s+/g, " ").trim())
        .digest("hex");

    const compareObjectSets = async (
      objectType: string,
      query: string,
    ): Promise<any> => {
      const [sourceRows, targetRows] = await Promise.all([
        executeQuery<any[]>(query, [sourceDb]),
        executeQuery<any[]>(query, [targetDb]),
      ]);
      const sourceMap = new Map(
        sourceRows.map((row) => [row.name, hashBody(row.body)]),
      );
      const targetMap = new Map(
        targetRows.map((row) => [row.name, hashBody(row.body)]),
      );

      const onlyInSource: string[] = [];
      const onlyInTarget: string[] = [];
      const differentDefinition: string[] = [];

      for (const [name, hash] of sourceMap) {
        if (!targetMap.has(name)) {
          onlyInSource.push(name);
        } else if (targetMap.get(name) !== hash) {
          differentDefinition.push(name);
        }
      }
      for (const name of targetMap.keys()) {
        if (!sourceMap.has(name)) {
          onlyInTarget.push(name);
        }
      }

      return { objectType, onlyInSource, onlyInTarget, differentDefinition };
    };

    const [routineDiff, viewDiff, triggerDiff] = await Promise.all([
      compareObjectSets(
        "routines",
        `SELECT ROUTINE_NAME as name, ROUTINE_DEFINITION as body
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      ),
      compareObjectSets(
        "views",
        `SELECT TABLE_NAME as name, VIEW_DEFINITION as body
         FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
      ),
      compareObjectSets(
        "triggers",
        `SELECT TRIGGER_NAME as name, ACTION_STATEMENT as body
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
      ),
    ]);

    differences.objectDifferences = {
      routines: routineDiff,
      views: viewDiff,
      triggers: triggerDiff,
    };

    differences.summary.tablesOnlyInSource =
      differences.tablesOnlyInSource.length;
    differences.summary.tablesOnlyInTarget =
      differences.tablesOnlyInTarget.length;
    differences.summary.tablesWithColumnDifferences =
      differences.columnDifferences.length;
    differences.summary.tablesWithIndexDifferences =
      differences.indexDifferences.length;

    return {
      content: [{ type: "text", text: JSON.stringify(differences, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_compare_schemas:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_generate_migration - Generate migration SQL scripts
// ============================================================================

export async function mysqlGenerateMigration(
  sourceDb: string,
  targetDb: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const comparison = await mysqlCompareSchemas(sourceDb, targetDb);
    if (comparison.isError) {
      return comparison;
    }

    const diff = JSON.parse(comparison.content[0].text);
    const migrations: string[] = [];
    const downMigrations: string[] = [];

    migrations.push(`-- Migration script from '${sourceDb}' to '${targetDb}'`);
    migrations.push(`-- Generated at ${new Date().toISOString()}`);
    migrations.push(`-- WARNING: Review carefully before executing!\n`);

    // Tables to create in target
    if (diff.tablesOnlyInSource.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(`-- Tables to ADD to '${targetDb}'`);
      migrations.push(`-- ============================================\n`);

      for (const table of diff.tablesOnlyInSource) {
        const createStmt = await executeQuery<any[]>(
          `SHOW CREATE TABLE ${escapeId(sourceDb)}.${escapeId(table)}`,
        );
        if (createStmt[0]) {
          let createSql: string = createStmt[0]["Create Table"];
          // Qualify only the table name in the CREATE TABLE header with the
          // target database. A global source→target name replace corrupted
          // column names, comments and defaults that contained the DB name.
          createSql = createSql.replace(
            /^CREATE TABLE `((?:[^`]|``)+)`/,
            (_match, tableName) =>
              `CREATE TABLE ${escapeId(targetDb)}.\`${tableName}\``,
          );
          migrations.push(`-- Create table: ${table}`);
          migrations.push(createSql + ";\n");
          downMigrations.push(
            `DROP TABLE IF EXISTS ${escapeId(targetDb)}.\`${table}\`;`,
          );
        }
      }
    }

    // Tables to drop from target (commented out for safety)
    if (diff.tablesOnlyInTarget.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(
        `-- Tables that exist only in '${targetDb}' (uncomment to drop)`,
      );
      migrations.push(`-- ============================================\n`);

      for (const table of diff.tablesOnlyInTarget) {
        migrations.push(
          `-- DROP TABLE IF EXISTS \`${targetDb}\`.\`${table}\`;`,
        );
      }
      migrations.push("");
    }

    // Column modifications
    if (diff.columnDifferences.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(`-- Column modifications`);
      migrations.push(`-- ============================================\n`);

      for (const tableDiff of diff.columnDifferences) {
        migrations.push(`-- Table: ${tableDiff.table}`);

        // Columns to add
        for (const col of tableDiff.columnsOnlyInSource) {
          const colInfo = await executeQuery<any[]>(
            `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
             FROM information_schema.COLUMNS 
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [sourceDb, tableDiff.table, col],
          );
          if (colInfo[0]) {
            const nullable =
              colInfo[0].IS_NULLABLE === "YES" ? "NULL" : "NOT NULL";
            const defaultVal = colInfo[0].COLUMN_DEFAULT
              ? ` DEFAULT '${colInfo[0].COLUMN_DEFAULT}'`
              : "";
            migrations.push(
              `ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` ADD COLUMN \`${col}\` ${colInfo[0].COLUMN_TYPE} ${nullable}${defaultVal};`,
            );
            downMigrations.push(
              `ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` DROP COLUMN \`${col}\`;`,
            );
          }
        }

        // Columns to drop (commented for safety)
        for (const col of tableDiff.columnsOnlyInTarget) {
          migrations.push(
            `-- ⚠️ DATA LOSS si se descomenta: elimina la columna y sus datos`,
          );
          migrations.push(
            `-- ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` DROP COLUMN \`${col}\`;`,
          );
        }

        // Column modifications
        for (const colDiff of tableDiff.columnTypeDifferences) {
          const nullable =
            colDiff.source.nullable === "YES" ? "NULL" : "NOT NULL";
          if (colDiff.severity === "breaking") {
            migrations.push(
              `-- ⚠️ POSIBLE PÉRDIDA DE DATOS: cambio de ${colDiff.target.type} a ${colDiff.source.type}`,
            );
          }
          migrations.push(
            `ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` MODIFY COLUMN \`${colDiff.column}\` ${colDiff.source.type} ${nullable};`,
          );
          const downNullable =
            colDiff.target.nullable === "YES" ? "NULL" : "NOT NULL";
          downMigrations.push(
            `ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` MODIFY COLUMN \`${colDiff.column}\` ${colDiff.target.type} ${downNullable};`,
          );
        }

        migrations.push("");
      }
    }

    if (migrations.length <= 4) {
      migrations.push("-- No differences found. Schemas are identical.");
    }

    // Reverse (down) migration to undo the changes above
    if (downMigrations.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(`-- DOWN MIGRATION (revierte los cambios de arriba)`);
      migrations.push(`-- ============================================\n`);
      migrations.push(...downMigrations.reverse());
    }

    return {
      content: [{ type: "text", text: migrations.join("\n") }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_generate_migration:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_call_procedure - Execute stored procedures
// ============================================================================

export async function mysqlCallProcedure(
  procedureName: string,
  params: any[] = [],
  database?: string,
  outParams: string[] = [],
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullProcName = database
      ? `${escapeId(database)}.${escapeId(procedureName)}`
      : escapeId(procedureName);

    for (const name of outParams) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid OUT parameter name '${name}'. Only alphanumeric characters and underscore are allowed.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Read the real signature so we can validate the call BEFORE executing
    // and auto-map OUT/INOUT parameters in declared order.
    let signatureQuery = `
      SELECT PARAMETER_NAME as name, PARAMETER_MODE as mode, DTD_IDENTIFIER as type
      FROM information_schema.PARAMETERS
      WHERE SPECIFIC_NAME = ? AND ROUTINE_TYPE = 'PROCEDURE'
        AND PARAMETER_NAME IS NOT NULL
    `;
    const signatureParams = [procedureName];
    if (database) {
      signatureQuery += " AND SPECIFIC_SCHEMA = ?";
      signatureParams.push(database);
    }
    signatureQuery += " ORDER BY ORDINAL_POSITION";
    const declared = await executeQuery<any[]>(
      signatureQuery,
      signatureParams,
    ).catch(() => []);

    const renderSignature = () =>
      declared
        .map((p) => `${p.mode} ${p.name} ${p.type}`)
        .join(", ") || "(sin parámetros)";

    let sql: string;
    let queryParams: any[] = params;
    let outNames: string[] = outParams;
    const preStatements: Array<{ sql: string; value: any }> = [];

    if (declared.length > 0) {
      // Inputs expected: one value per IN or INOUT parameter
      const inputParams = declared.filter(
        (p) => p.mode === "IN" || p.mode === "INOUT",
      );
      if (params.length !== inputParams.length) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: '${procedureName}' espera ${inputParams.length} valor(es) de entrada y recibió ${params.length}.\n` +
                `Firma real: ${procedureName}(${renderSignature()})\n` +
                `Pasa en 'params' un valor por cada parámetro IN/INOUT en ese orden; los OUT se devuelven automáticamente.`,
            },
          ],
          isError: true,
        };
      }

      // Build the argument list in declared order
      const placeholders: string[] = [];
      const autoOutNames: string[] = [];
      let inputIndex = 0;
      for (const param of declared) {
        const safeName = /^[a-zA-Z0-9_]+$/.test(String(param.name))
          ? String(param.name)
          : `p${placeholders.length + 1}`;
        if (param.mode === "IN") {
          placeholders.push("?");
          inputIndex++;
        } else if (param.mode === "INOUT") {
          preStatements.push({
            sql: `SET @${safeName} = ?`,
            value: params[inputIndex],
          });
          inputIndex++;
          placeholders.push(`@${safeName}`);
          autoOutNames.push(safeName);
        } else {
          placeholders.push(`@${safeName}`);
          autoOutNames.push(safeName);
        }
      }
      // IN values are the input list minus the INOUT ones (those go via SET),
      // walking the declared order
      const inValues: any[] = [];
      let cursor = 0;
      for (const param of declared) {
        if (param.mode === "IN") {
          inValues.push(params[cursor]);
          cursor++;
        } else if (param.mode === "INOUT") {
          cursor++;
        }
      }
      queryParams = inValues;
      outNames = autoOutNames;
      sql = `CALL ${fullProcName}(${placeholders.join(", ")})`;
    } else {
      // No metadata available: legacy behavior (IN placeholders + OUT vars)
      const placeholders = [
        ...params.map(() => "?"),
        ...outParams.map((name) => `@${name}`),
      ].join(", ");
      sql = `CALL ${fullProcName}(${placeholders})`;
    }

    log("info", `Executing stored procedure: ${sql}`, queryParams);

    const pool = await getPool();
    const connection = await pool.getConnection();

    try {
      for (const pre of preStatements) {
        await connection.query(pre.sql, [pre.value]);
      }
      const [results] = await connection.query(sql, queryParams);

      let outValues: Record<string, unknown> | null = null;
      if (outNames.length > 0) {
        const selectOut = `SELECT ${outNames
          .map((name) => `@${name} AS ${escapeId(name)}`)
          .join(", ")}`;
        const [outRows] = await connection.query(selectOut);
        outValues = Array.isArray(outRows) ? (outRows[0] as any) : null;
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
          ...(outValues
            ? [
                {
                  type: "text",
                  text: `\nOUT parameters: ${JSON.stringify(outValues, null, 2)}`,
                },
              ]
            : []),
          {
            type: "text",
            text: `\n--- Procedure ${procedureName} executed successfully ---`,
          },
        ],
        isError: false,
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    log("error", "Error in mysql_call_procedure:", error);
    const info = describeMysqlError(error);
    const suggestions =
      info.code === "ER_SP_DOES_NOT_EXIST"
        ? await suggestSimilarRoutines(procedureName, database)
        : [];
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}${didYouMean(suggestions)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_show_views - List and describe views
// ============================================================================

export async function mysqlShowViews(
  database?: string,
  viewName?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (viewName) {
      // Get specific view details
      const fullViewName = database
        ? `${escapeId(database)}.${escapeId(viewName)}`
        : escapeId(viewName);

      const viewDef = await executeQuery<any[]>(
        `SHOW CREATE VIEW ${fullViewName}`,
      );
      const viewInfo = await executeQuery<any[]>(
        `SELECT * FROM information_schema.VIEWS WHERE TABLE_NAME = ? ${database ? "AND TABLE_SCHEMA = ?" : ""}`,
        database ? [viewName, database] : [viewName],
      );

      // Get columns
      const columns = await executeQuery<any[]>(`DESCRIBE ${fullViewName}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                viewName,
                database: database || "current",
                columns,
                definition: viewDef[0]?.["Create View"] || null,
                isUpdatable: viewInfo[0]?.IS_UPDATABLE || null,
                checkOption: viewInfo[0]?.CHECK_OPTION || null,
                definer: viewInfo[0]?.DEFINER || null,
                securityType: viewInfo[0]?.SECURITY_TYPE || null,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } else {
      // List all views
      let sql = `
        SELECT 
          TABLE_SCHEMA as \`database\`,
          TABLE_NAME as viewName,
          IS_UPDATABLE as isUpdatable,
          DEFINER as definer,
          SECURITY_TYPE as securityType
        FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      `;
      const params: string[] = [];
      if (database) {
        sql += ` AND TABLE_SCHEMA = ?`;
        params.push(database);
      }
      sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;

      const views = await executeQuery<any[]>(sql, params);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalViews: views.length,
                views,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    log("error", "Error in mysql_show_views:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRoutineUsagePatterns(
  routineName: string,
  database: string,
  routineType: "procedure" | "function" | "auto",
): Array<{ kind: string; regex: RegExp }> {
  const escapedName = escapeRegExp(routineName);
  const escapedDatabase = escapeRegExp(database);
  const qualifiedPrefix = `(?:\\\`?${escapedDatabase}\\\`?\\s*\\.\\s*)?`;
  const functionRegex = new RegExp(
    `(^|[^A-Z0-9_])${qualifiedPrefix}\\\`?${escapedName}\\\`?\\s*\\(`,
    "im",
  );
  const procedureRegex = new RegExp(
    `\\bCALL\\s+${qualifiedPrefix}\\\`?${escapedName}\\\`?\\s*\\(`,
    "im",
  );

  if (routineType === "function") {
    return [{ kind: "FUNCTION_CALL", regex: functionRegex }];
  }

  if (routineType === "procedure") {
    return [{ kind: "PROCEDURE_CALL", regex: procedureRegex }];
  }

  return [
    { kind: "PROCEDURE_CALL", regex: procedureRegex },
    { kind: "FUNCTION_CALL", regex: functionRegex },
  ];
}

function extractUsageSnippet(
  definition: string,
  matchIndex: number,
  maxLength: number = 240,
): string {
  const start = Math.max(0, matchIndex - Math.floor(maxLength / 2));
  const end = Math.min(
    definition.length,
    matchIndex + Math.floor(maxLength / 2),
  );
  return definition.slice(start, end).replace(/\s+/g, " ").trim();
}

async function mysqlTableExists(
  schemaName: string,
  tableName: string,
): Promise<boolean> {
  const result = await executeQuery<any[]>(
    `SELECT 1
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
     LIMIT 1`,
    [schemaName, tableName],
  );

  return result.length > 0;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let currentIndex = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (currentIndex < items.length) {
        const item = items[currentIndex++];
        results.push(await worker(item));
      }
    },
  );

  await Promise.all(runners);
  return results;
}

type RoutineImpactObject = {
  objectType: "PROCEDURE" | "FUNCTION" | "VIEW" | "TRIGGER" | "EVENT";
  name: string;
};

async function getRoutineDefinition(
  database: string,
  object: RoutineImpactObject,
): Promise<string | null> {
  try {
    if (object.objectType === "PROCEDURE") {
      const result = await executeQuery<any[]>(
        `SHOW CREATE PROCEDURE \`${database}\`.\`${object.name}\``,
      );
      return result[0]?.["Create Procedure"] || null;
    }

    if (object.objectType === "FUNCTION") {
      const result = await executeQuery<any[]>(
        `SHOW CREATE FUNCTION \`${database}\`.\`${object.name}\``,
      );
      return result[0]?.["Create Function"] || null;
    }

    if (object.objectType === "VIEW") {
      const result = await executeQuery<any[]>(
        `SHOW CREATE VIEW \`${database}\`.\`${object.name}\``,
      );
      return result[0]?.["Create View"] || result[0]?.["CREATE VIEW"] || null;
    }

    if (object.objectType === "TRIGGER") {
      const result = await executeQuery<any[]>(
        `SHOW CREATE TRIGGER \`${database}\`.\`${object.name}\``,
      );
      return (
        result[0]?.["SQL Original Statement"] ||
        result[0]?.["Create Trigger"] ||
        null
      );
    }

    const result = await executeQuery<any[]>(
      `SHOW CREATE EVENT \`${database}\`.\`${object.name}\``,
    );
    return result[0]?.["Create Event"] || null;
  } catch {
    return null;
  }
}

async function getRoutineImpactCandidates(
  database: string,
  needle: string,
  versionInfo: { engine: "MariaDB" | "MySQL" | "Unknown"; fullLabel: string },
): Promise<{
  candidates: RoutineImpactObject[];
  prefilterSources: string[];
  usedMysqlProc: boolean;
}> {
  const likeNeedle = `%${needle}%`;
  const candidateMap = new Map<string, RoutineImpactObject>();
  const prefilterSources: string[] = [];
  let usedMysqlProc = false;

  const addCandidate = (
    objectType: RoutineImpactObject["objectType"],
    name: string,
  ) => {
    candidateMap.set(`${objectType}:${name}`, { objectType, name });
  };

  try {
    const routines = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME as name, ROUTINE_TYPE as type
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_DEFINITION LIKE ?`,
      [database, likeNeedle],
    );
    routines.forEach((item) => addCandidate(item.type, item.name));
    prefilterSources.push("information_schema.ROUTINES");
  } catch {
    // ignore prefilter failure and continue with SHOW CREATE fallback later
  }

  try {
    const views = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
         AND VIEW_DEFINITION LIKE ?`,
      [database, likeNeedle],
    );
    views.forEach((item) => addCandidate("VIEW", item.name));
    prefilterSources.push("information_schema.VIEWS");
  } catch {
    // ignore prefilter failure
  }

  try {
    const triggers = await executeQuery<any[]>(
      `SELECT TRIGGER_NAME as name
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
         AND ACTION_STATEMENT LIKE ?`,
      [database, likeNeedle],
    );
    triggers.forEach((item) => addCandidate("TRIGGER", item.name));
    prefilterSources.push("information_schema.TRIGGERS");
  } catch {
    // ignore prefilter failure
  }

  try {
    const events = await executeQuery<any[]>(
      `SELECT EVENT_NAME as name
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ?
         AND EVENT_DEFINITION LIKE ?`,
      [database, likeNeedle],
    );
    events.forEach((item) => addCandidate("EVENT", item.name));
    prefilterSources.push("information_schema.EVENTS");
  } catch {
    // ignore prefilter failure
  }

  try {
    if (
      versionInfo.engine === "MariaDB" ||
      (await mysqlTableExists("mysql", "proc"))
    ) {
      const procRows = await executeQuery<any[]>(
        `SELECT name, type
         FROM mysql.proc
         WHERE db = ?
           AND body LIKE ?`,
        [database, likeNeedle],
      );
      procRows.forEach((item) => addCandidate(item.type, item.name));
      prefilterSources.push("mysql.proc");
      usedMysqlProc = true;
    }
  } catch {
    // mysql.proc does not exist or is not accessible
  }

  return {
    candidates: Array.from(candidateMap.values()),
    prefilterSources,
    usedMysqlProc,
  };
}

export async function mysqlRoutineImpact(
  routineName: string,
  database?: string,
  routineType: "auto" | "procedure" | "function" = "auto",
  includeSnippets: boolean = true,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [
          {
            type: "text",
            text: "Error: database is required when MYSQL_DB is not configured",
          },
        ],
        isError: true,
      };
    }

    const cleanRoutineName = routineName.replace(/[`"' ]/g, "").trim();
    if (!cleanRoutineName) {
      return {
        content: [{ type: "text", text: "Error: routineName is required" }],
        isError: true,
      };
    }

    const versionInfo = await getDatabaseVersionInfo();
    const resolvedType =
      routineType === "auto"
        ? (
            await executeQuery<any[]>(
              `SELECT ROUTINE_TYPE as routineType
             FROM information_schema.ROUTINES
             WHERE ROUTINE_SCHEMA = ?
               AND ROUTINE_NAME = ?
             LIMIT 1`,
              [targetDatabase, cleanRoutineName],
            )
          )[0]?.routineType?.toLowerCase() || "auto"
        : routineType;

    // If auto-resolution found nothing, the routine does not exist: fail fast
    // with suggestions instead of scanning the whole database for nothing.
    if (routineType === "auto" && resolvedType === "auto") {
      const suggestions = await suggestSimilarRoutines(
        cleanRoutineName,
        targetDatabase,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: la rutina '${cleanRoutineName}' no existe en '${targetDatabase}'.${didYouMean(suggestions)}`,
          },
        ],
        isError: true,
      };
    }

    const patterns = buildRoutineUsagePatterns(
      cleanRoutineName,
      targetDatabase,
      resolvedType === "procedure" || resolvedType === "function"
        ? resolvedType
        : "auto",
    );

    // Analyze the routine's own definition: which tables it touches (impact
    // in the other direction) and whether it builds dynamic SQL
    const ownDefinition = await getRoutineDefinition(targetDatabase, {
      objectType: resolvedType === "function" ? "FUNCTION" : "PROCEDURE",
      name: cleanRoutineName,
    });
    let tablesUsed: string[] = [];
    let usesDynamicSql = false;
    if (ownDefinition) {
      usesDynamicSql = /\b(PREPARE\s+\w+\s+FROM|EXECUTE\s+\w+)/i.test(
        ownDefinition,
      );
      try {
        const knownTables = await executeQuery<any[]>(
          `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
          [targetDatabase],
        );
        tablesUsed = knownTables
          .map((row) => String(row.name))
          .filter((tableName) =>
            new RegExp(
              `(^|[^A-Za-z0-9_])\`?${escapeRegExp(tableName)}\`?([^A-Za-z0-9_]|$)`,
              "i",
            ).test(ownDefinition),
          );
      } catch {
        // best-effort
      }
    }

    const allObjects: RoutineImpactObject[] = [];
    const routines = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME as name, ROUTINE_TYPE as objectType
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?`,
      [targetDatabase],
    );
    routines.forEach((item) => {
      allObjects.push({ objectType: item.objectType, name: item.name });
    });

    const views = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?`,
      [targetDatabase],
    );
    views.forEach((item) =>
      allObjects.push({ objectType: "VIEW", name: item.name }),
    );

    const triggers = await executeQuery<any[]>(
      `SELECT TRIGGER_NAME as name
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?`,
      [targetDatabase],
    );
    triggers.forEach((item) =>
      allObjects.push({ objectType: "TRIGGER", name: item.name }),
    );

    const events = await executeQuery<any[]>(
      `SELECT EVENT_NAME as name
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ?`,
      [targetDatabase],
    );
    events.forEach((item) =>
      allObjects.push({ objectType: "EVENT", name: item.name }),
    );

    const { candidates, prefilterSources, usedMysqlProc } =
      await getRoutineImpactCandidates(
        targetDatabase,
        cleanRoutineName,
        versionInfo,
      );

    const shouldScanAllDefinitions = allObjects.length <= 250;
    const objectsToScan = shouldScanAllDefinitions
      ? allObjects
      : candidates.length > 0
        ? candidates
        : allObjects;

    const findings = await mapWithConcurrency(
      objectsToScan,
      4,
      async (object) => {
        if (object.name === cleanRoutineName) {
          return null;
        }

        const definition = await getRoutineDefinition(targetDatabase, object);
        if (!definition) {
          return null;
        }

        for (const pattern of patterns) {
          const match = pattern.regex.exec(definition);
          if (!match || match.index === undefined) {
            continue;
          }

          return {
            objectType: object.objectType,
            name: object.name,
            database: targetDatabase,
            matchType: pattern.kind,
            snippet: includeSnippets
              ? extractUsageSnippet(definition, match.index)
              : null,
          };
        }

        return null;
      },
    );

    const references = findings
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (left, right) =>
          left.objectType.localeCompare(right.objectType) ||
          left.name.localeCompare(right.name),
      );

    const summaryByType = references.reduce<Record<string, number>>(
      (acc, item) => {
        acc[item.objectType] = (acc[item.objectType] || 0) + 1;
        return acc;
      },
      {},
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              database: targetDatabase,
              routineName: cleanRoutineName,
              requestedRoutineType: routineType,
              resolvedRoutineType: resolvedType,
              versionInfo,
              searchStrategy: {
                prefilterSources,
                usedMysqlProc,
                verifiedWithShowCreate: true,
                scannedObjects: objectsToScan.length,
                totalObjectsInDatabase: allObjects.length,
                scanMode: shouldScanAllDefinitions
                  ? "full-definition-scan"
                  : "prefilter-then-verify",
              },
              routineAnalysis: {
                tablesUsed,
                usesDynamicSql,
              },
              summary: {
                totalReferences: references.length,
                byObjectType: summaryByType,
              },
              references,
              warnings: [
                ...(shouldScanAllDefinitions
                  ? []
                  : [
                      "La base tiene muchos objetos. Se uso prefiltrado por metadata y verificacion con SHOW CREATE para reducir tiempo de respuesta.",
                    ]),
                ...(usesDynamicSql
                  ? [
                      "La rutina usa SQL dinamico (PREPARE/EXECUTE): el analisis estatico de tablas y referencias puede estar incompleto.",
                    ]
                  : []),
              ],
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_routine_impact:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_variables - Show/Set MySQL variables
// ============================================================================

export async function mysqlVariables(
  action: "show" | "set" = "show",
  scope: "global" | "session" = "session",
  filter?: string,
  variable?: string,
  value?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (action === "set") {
      if (!ALLOW_ADMIN_OPERATION) {
        return permissionError(
          "Setting MySQL variables is not allowed. Set ALLOW_ADMIN_OPERATION=true to enable it.",
        );
      }

      if (!variable || value === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Variable name and value are required for SET action",
            },
          ],
          isError: true,
        };
      }

      // Validate variable name to prevent SQL injection (only alphanumeric, underscore, dot)
      if (!/^[a-zA-Z0-9_.]+$/.test(variable)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Invalid variable name. Only alphanumeric characters, underscore, and dot are allowed.",
            },
          ],
          isError: true,
        };
      }

      // Use backticks for variable name and parameterized query for value
      const sql = `SET ${scope.toUpperCase()} \`${variable}\` = ?`;
      await executeQuery(sql, [value]);

      return {
        content: [
          {
            type: "text",
            text:
              `Successfully set ${scope} variable '${variable}' to '${value}'` +
              (scope === "session"
                ? "\nWarning: SESSION variables are set on one pooled connection only and do not persist for subsequent queries. Use scope 'global' for persistent changes."
                : ""),
          },
        ],
        isError: false,
      };
    } else {
      // Show variables
      let sql = `SHOW ${scope.toUpperCase()} VARIABLES`;
      const params: string[] = [];
      if (filter) {
        sql += ` LIKE ?`;
        params.push(`%${filter}%`);
      }

      const variables = await executeQuery<any[]>(sql, params);

      // Group variables by category
      const grouped: Record<string, any[]> = {};
      for (const v of variables) {
        const name = v.Variable_name;
        const category = name.split("_")[0];
        if (!grouped[category]) {
          grouped[category] = [];
        }
        grouped[category].push({
          name: v.Variable_name,
          value: v.Value,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope,
                totalVariables: variables.length,
                filter: filter || "none",
                variables: filter ? variables : grouped,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    log("error", "Error in mysql_variables:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_index_suggestions - Analyze and suggest indexes
// ============================================================================

export async function mysqlIndexSuggestions(database?: string): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const suggestions: any[] = [];

    // Real usage data from the sys schema when available (much better signal
    // than name-based heuristics)
    let unusedIndexes: any[] = [];
    let unusedIndexesSource = "not available (sys schema not accessible)";
    try {
      let unusedQuery = `
        SELECT object_schema as \`database\`, object_name as tableName, index_name as indexName
        FROM sys.schema_unused_indexes`;
      const unusedParams: string[] = [];
      if (database) {
        unusedQuery += ` WHERE object_schema = ?`;
        unusedParams.push(database);
      }
      unusedIndexes = await executeQuery<any[]>(unusedQuery, unusedParams);
      unusedIndexesSource =
        "sys.schema_unused_indexes (índices sin uso desde el último reinicio del servidor)";
    } catch {
      // sys schema not available (older MySQL/MariaDB or no permissions)
    }

    // Get tables to analyze
    let tablesQuery = `
      SELECT TABLE_SCHEMA as db, TABLE_NAME as name
      FROM information_schema.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    `;
    const params: string[] = [];
    if (database) {
      tablesQuery += ` AND TABLE_SCHEMA = ?`;
      params.push(database);
    }

    const tables = await executeQuery<any[]>(tablesQuery, params);

    for (const table of tables) {
      const tableSuggestions: any = {
        database: table.db,
        table: table.name,
        issues: [],
        suggestions: [],
      };

      // Check for tables without primary key
      const pkCheck = await executeQuery<any[]>(
        `SELECT COUNT(*) as hasPK FROM information_schema.TABLE_CONSTRAINTS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'`,
        [table.db, table.name],
      );

      if (pkCheck[0]?.hasPK === 0) {
        tableSuggestions.issues.push("⚠️ Table has no PRIMARY KEY");
        tableSuggestions.suggestions.push(
          "Consider adding a PRIMARY KEY for better performance",
        );
      }

      // Check for foreign key columns without indexes
      const fkColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table.db, table.name],
      );

      // Get existing indexes (full definitions for redundancy analysis)
      const indexes = await executeQuery<any[]>(
        `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [table.db, table.name],
      );
      const indexedColumns = new Set(indexes.map((i) => i.COLUMN_NAME));

      // Redundant index detection: an index whose column list is a prefix of
      // another index is (usually) redundant and slows down writes
      const indexDefs = new Map<string, { unique: boolean; columns: string[] }>();
      for (const idx of indexes) {
        const entry = indexDefs.get(idx.INDEX_NAME) || {
          unique: idx.NON_UNIQUE === 0,
          columns: [],
        };
        entry.columns.push(idx.COLUMN_NAME);
        indexDefs.set(idx.INDEX_NAME, entry);
      }
      for (const [nameA, defA] of indexDefs) {
        if (nameA === "PRIMARY" || defA.unique) continue;
        for (const [nameB, defB] of indexDefs) {
          if (nameA === nameB) continue;
          const isPrefix =
            defA.columns.length < defB.columns.length &&
            defA.columns.every((col, i) => col === defB.columns[i]);
          if (isPrefix) {
            tableSuggestions.issues.push(
              `🟡 Índice redundante '${nameA}' (${defA.columns.join(", ")}): es prefijo de '${nameB}' (${defB.columns.join(", ")})`,
            );
            tableSuggestions.suggestions.push(
              `-- Redundante, ralentiza escrituras sin aportar lecturas:\nALTER TABLE \`${table.db}\`.\`${table.name}\` DROP INDEX \`${nameA}\`;`,
            );
            break;
          }
        }
      }

      for (const fk of fkColumns) {
        if (!indexedColumns.has(fk.COLUMN_NAME)) {
          tableSuggestions.issues.push(
            `⚠️ Foreign key column '${fk.COLUMN_NAME}' is not indexed`,
          );
          tableSuggestions.suggestions.push(
            `CREATE INDEX idx_${table.name}_${fk.COLUMN_NAME} ON \`${table.db}\`.\`${table.name}\`(\`${fk.COLUMN_NAME}\`);`,
          );
        }
      }

      // Check for columns commonly used in WHERE clauses (heuristic based on naming)
      const columns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [table.db, table.name],
      );

      const commonWherePatterns = [
        "_id",
        "status",
        "type",
        "created_at",
        "updated_at",
        "email",
        "username",
        "code",
      ];
      for (const col of columns) {
        const colLower = col.COLUMN_NAME.toLowerCase();
        if (
          commonWherePatterns.some(
            (p) => colLower.endsWith(p) || colLower === p,
          )
        ) {
          if (!indexedColumns.has(col.COLUMN_NAME)) {
            tableSuggestions.suggestions.push(
              `💡 Consider indexing '${col.COLUMN_NAME}' if used frequently in WHERE clauses`,
            );
          }
        }
      }

      if (
        tableSuggestions.issues.length > 0 ||
        tableSuggestions.suggestions.length > 0
      ) {
        suggestions.push(tableSuggestions);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              analyzedTables: tables.length,
              tablesWithSuggestions: suggestions.length,
              priorityGuide: {
                "⚠️": "alta: sin PK o FK sin índice (afecta a todas las queries de esa tabla)",
                "🟡": "media: índice redundante (ralentiza escrituras)",
                "💡": "baja: heurística por nombre de columna, valida con mysql_explain",
              },
              unusedIndexes: {
                source: unusedIndexesSource,
                indexes: unusedIndexes,
              },
              suggestions,
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_index_suggestions:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_foreign_keys - Show foreign key relationships
// ============================================================================

export async function mysqlForeignKeys(
  database?: string,
  table?: string,
  format: "json" | "mermaid" = "json",
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    let sql = `
      SELECT 
        kcu.TABLE_SCHEMA as \`database\`,
        kcu.TABLE_NAME as tableName,
        kcu.COLUMN_NAME as columnName,
        kcu.CONSTRAINT_NAME as constraintName,
        kcu.REFERENCED_TABLE_SCHEMA as referencedDatabase,
        kcu.REFERENCED_TABLE_NAME as referencedTable,
        kcu.REFERENCED_COLUMN_NAME as referencedColumn,
        rc.UPDATE_RULE as onUpdate,
        rc.DELETE_RULE as onDelete
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
        AND kcu.TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    `;

    const params: string[] = [];
    if (database) {
      sql += ` AND kcu.TABLE_SCHEMA = ?`;
      params.push(database);
    }
    if (table) {
      sql += ` AND (kcu.TABLE_NAME = ? OR kcu.REFERENCED_TABLE_NAME = ?)`;
      params.push(table, table);
    }

    sql += ` ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION`;

    const relationships = await executeQuery<any[]>(sql, params);

    // Build a relationship graph
    const graph: Record<string, any> = {};
    for (const rel of relationships) {
      const key = `${rel.database}.${rel.tableName}`;
      if (!graph[key]) {
        graph[key] = {
          table: rel.tableName,
          database: rel.database,
          references: [],
          referencedBy: [],
        };
      }
      graph[key].references.push({
        constraint: rel.constraintName,
        column: rel.columnName,
        referencedTable: `${rel.referencedDatabase}.${rel.referencedTable}`,
        referencedColumn: rel.referencedColumn,
        onUpdate: rel.onUpdate,
        onDelete: rel.onDelete,
      });

      // Add reverse relationship
      const refKey = `${rel.referencedDatabase}.${rel.referencedTable}`;
      if (!graph[refKey]) {
        graph[refKey] = {
          table: rel.referencedTable,
          database: rel.referencedDatabase,
          references: [],
          referencedBy: [],
        };
      }
      graph[refKey].referencedBy.push({
        table: `${rel.database}.${rel.tableName}`,
        column: rel.referencedColumn,
        foreignColumn: rel.columnName,
      });
    }

    if (format === "mermaid") {
      // Mermaid erDiagram: models reason well over this format and it renders
      // directly in most markdown viewers
      const sanitize = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");
      const lines = ["erDiagram"];
      const seen = new Set<string>();
      for (const rel of relationships) {
        const parent = sanitize(rel.referencedTable);
        const child = sanitize(rel.tableName);
        const line = `  ${parent} ||--o{ ${child} : "${rel.columnName} -> ${rel.referencedColumn}"`;
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      }
      if (relationships.length === 0) {
        lines.push("  %% No hay foreign keys definidas");
      }
      return {
        content: [
          {
            type: "text",
            text:
              "```mermaid\n" +
              lines.join("\n") +
              "\n```\n" +
              `\n${relationships.length} relaciones entre ${Object.keys(graph).length} tablas.`,
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              totalRelationships: relationships.length,
              tables: Object.keys(graph).length,
              relationships: Object.values(graph),
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_foreign_keys:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_table_stats - Get detailed table statistics
// ============================================================================

export async function mysqlTableStats(
  database?: string,
  table?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    let sql = `
      SELECT 
        TABLE_SCHEMA as \`database\`,
        TABLE_NAME as tableName,
        ENGINE as engine,
        TABLE_ROWS as estimatedRows,
        AVG_ROW_LENGTH as avgRowLength,
        DATA_LENGTH as dataSize,
        INDEX_LENGTH as indexSize,
        DATA_FREE as freeSpace,
        AUTO_INCREMENT as autoIncrement,
        CREATE_TIME as createTime,
        UPDATE_TIME as updateTime,
        TABLE_COLLATION as collation,
        TABLE_COMMENT as comment
      FROM information_schema.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    `;

    const params: string[] = [];
    if (database) {
      sql += ` AND TABLE_SCHEMA = ?`;
      params.push(database);
    }
    if (table) {
      sql += ` AND TABLE_NAME = ?`;
      params.push(table);
    }
    sql += ` ORDER BY DATA_LENGTH DESC`;

    const tables = await executeQuery<any[]>(sql, params);

    // Format sizes for readability
    const formatSize = (bytes: number) => {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = bytes;
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return `${size.toFixed(2)} ${units[unitIndex]}`;
    };

    const stats = tables.map((t) => ({
      ...t,
      dataSizeFormatted: formatSize(t.dataSize),
      indexSizeFormatted: formatSize(t.indexSize),
      freeSpaceFormatted: formatSize(t.freeSpace),
      totalSize: t.dataSize + t.indexSize,
      totalSizeFormatted: formatSize(t.dataSize + t.indexSize),
      fragmentationPercent:
        t.dataSize > 0
          ? ((t.freeSpace / t.dataSize) * 100).toFixed(2) + "%"
          : "0%",
    }));

    // Calculate totals
    const totals = {
      totalTables: stats.length,
      totalRows: stats.reduce((sum, t) => sum + (t.estimatedRows || 0), 0),
      totalDataSize: formatSize(
        stats.reduce((sum, t) => sum + (t.dataSize || 0), 0),
      ),
      totalIndexSize: formatSize(
        stats.reduce((sum, t) => sum + (t.indexSize || 0), 0),
      ),
      totalFreeSpace: formatSize(
        stats.reduce((sum, t) => sum + (t.freeSpace || 0), 0),
      ),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              summary: totals,
              tables: stats,
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_table_stats:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_process_list - Show running processes/queries
// ============================================================================

export async function mysqlProcessList(
  full: boolean = false,
  user?: string,
  db?: string,
  minTime?: number,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // information_schema.PROCESSLIST admits parameterized filters (SHOW
    // PROCESSLIST does not)
    let sql = `
      SELECT ID as Id, USER as User, HOST as Host, DB as db,
             COMMAND as Command, TIME as Time, STATE as State, INFO as Info
      FROM information_schema.PROCESSLIST
      WHERE 1=1`;
    const params: any[] = [];
    if (user) {
      sql += ` AND USER = ?`;
      params.push(user);
    }
    if (db) {
      sql += ` AND DB = ?`;
      params.push(db);
    }
    if (minTime !== undefined && Number.isInteger(minTime) && minTime >= 0) {
      sql += ` AND TIME >= ?`;
      params.push(minTime);
    }
    sql += ` ORDER BY TIME DESC`;

    let processes = await executeQuery<any[]>(sql, params);
    if (!full) {
      processes = processes.map((p) => ({
        ...p,
        Info:
          typeof p.Info === "string" && p.Info.length > 120
            ? `${p.Info.substring(0, 120)}...`
            : p.Info,
      }));
    }

    // Long-running InnoDB transactions: the usual culprit behind locks
    let innodbTransactions: any[] = [];
    try {
      innodbTransactions = await executeQuery<any[]>(
        `SELECT trx_id as id, trx_state as state, trx_started as started,
                TIMESTAMPDIFF(SECOND, trx_started, NOW()) as ageSeconds,
                trx_mysql_thread_id as processId,
                trx_rows_locked as rowsLocked,
                trx_rows_modified as rowsModified
         FROM information_schema.INNODB_TRX
         ORDER BY trx_started`,
      );
    } catch {
      // Not available or no permissions
    }

    // Analyze processes
    const analysis = {
      totalProcesses: processes.length,
      activeQueries: processes.filter((p) => p.Command !== "Sleep").length,
      sleepingConnections: processes.filter((p) => p.Command === "Sleep")
        .length,
      longRunning: processes.filter((p) => p.Time > 30),
      byUser: {} as Record<string, number>,
      byCommand: {} as Record<string, number>,
    };

    for (const p of processes) {
      analysis.byUser[p.User] = (analysis.byUser[p.User] || 0) + 1;
      analysis.byCommand[p.Command] = (analysis.byCommand[p.Command] || 0) + 1;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              analysis,
              innodbTransactions,
              processes,
            },
            null,
            2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_process_list:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_kill_process - Kill a running process
// ============================================================================

export async function mysqlKillProcess(
  processId: number,
  mode: "connection" | "query" = "connection",
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (!ALLOW_ADMIN_OPERATION) {
      return permissionError(
        "Killing processes is not allowed. Set ALLOW_ADMIN_OPERATION=true to enable it.",
      );
    }

    // Validate processId is a positive integer
    if (!Number.isInteger(processId) || processId <= 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Process ID must be a positive integer",
          },
        ],
        isError: true,
      };
    }

    // KILL does not accept string placeholders (KILL '123' is a syntax
    // error), so interpolate the already-validated integer directly.
    // KILL QUERY aborts only the running statement; KILL (CONNECTION)
    // terminates the whole connection.
    const killSql =
      mode === "query" ? `KILL QUERY ${processId}` : `KILL ${processId}`;
    await executeQuery(killSql);
    return {
      content: [
        {
          type: "text",
          text: `Successfully killed ${mode === "query" ? "query of process" : "process"} ${processId}`,
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_kill_process:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_create_procedure - Create stored procedure
// ============================================================================

export async function mysqlCreateProcedure(
  procedureName: string,
  procedureBody: string,
  database?: string,
  parameters?: string,
  characteristics?: {
    comment?: string;
    language?: "SQL";
    deterministic?: boolean;
    containsSql?:
      | "CONTAINS SQL"
      | "NO SQL"
      | "READS SQL DATA"
      | "MODIFIES SQL DATA";
    sqlSecurity?: "DEFINER" | "INVOKER";
  },
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetSchema = resolveSchema(database);
    if (!isDDLAllowedForSchema(targetSchema)) {
      return permissionError(
        `DDL operations are not allowed for schema '${targetSchema || "default"}'. Configure ALLOW_DDL_OPERATION or SCHEMA_DDL_PERMISSIONS.`,
      );
    }

    const fullProcName = database
      ? `${escapeId(database)}.${escapeId(procedureName)}`
      : escapeId(procedureName);

    // Build CREATE PROCEDURE statement
    let createSql = `CREATE PROCEDURE ${fullProcName}`;

    // Add parameters if provided
    if (parameters) {
      createSql += `(${parameters})`;
    } else {
      createSql += `()`;
    }

    // Add characteristics
    if (characteristics) {
      const chars: string[] = [];
      if (characteristics.language) {
        chars.push(`LANGUAGE ${characteristics.language}`);
      }
      if (characteristics.deterministic !== undefined) {
        chars.push(
          characteristics.deterministic ? "DETERMINISTIC" : "NOT DETERMINISTIC",
        );
      }
      if (characteristics.containsSql) {
        chars.push(characteristics.containsSql);
      }
      if (characteristics.sqlSecurity) {
        chars.push(`SQL SECURITY ${characteristics.sqlSecurity}`);
      }
      if (characteristics.comment) {
        chars.push(`COMMENT '${characteristics.comment.replace(/'/g, "''")}'`);
      }
      if (chars.length > 0) {
        createSql += `\n${chars.join("\n")}`;
      }
    }

    createSql += `\nBEGIN\n${procedureBody}\nEND`;

    log("info", `Creating stored procedure: ${procedureName}`);

    // CREATE PROCEDURE cannot run in transactions, so use direct connection
    const pool = await getPool();
    const connection = await pool.getConnection();

    try {
      // Check if procedure exists (to provide better error message)
      try {
        const checkQuery = database
          ? `SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = 'PROCEDURE'`
          : `SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_NAME = ? AND ROUTINE_TYPE = 'PROCEDURE'`;
        const checkParams = database
          ? [database, procedureName]
          : [procedureName];
        const existing = await connection.query(checkQuery, checkParams);
        if (
          Array.isArray(existing) &&
          existing[0] &&
          (existing[0] as any[]).length > 0
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Procedure '${procedureName}' already exists. Use mysql_alter_procedure to modify it.`,
              },
            ],
            isError: true,
          };
        }
      } catch {
        // Ignore check errors
      }

      // Execute CREATE PROCEDURE
      await connection.query(createSql);

      return {
        content: [
          {
            type: "text",
            text: `Successfully created procedure '${procedureName}'`,
          },
          { type: "text", text: `\nGenerated SQL:\n${createSql}` },
        ],
        isError: false,
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    log("error", "Error in mysql_create_procedure:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_alter_procedure - Modify stored procedure (DROP + CREATE)
// ============================================================================

export async function mysqlAlterProcedure(
  procedureName: string,
  procedureBody: string,
  database?: string,
  parameters?: string,
  characteristics?: {
    comment?: string;
    language?: "SQL";
    deterministic?: boolean;
    containsSql?:
      | "CONTAINS SQL"
      | "NO SQL"
      | "READS SQL DATA"
      | "MODIFIES SQL DATA";
    sqlSecurity?: "DEFINER" | "INVOKER";
  },
  ifExists?: boolean,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetSchema = resolveSchema(database);
    if (!isDDLAllowedForSchema(targetSchema)) {
      return permissionError(
        `DDL operations are not allowed for schema '${targetSchema || "default"}'. Configure ALLOW_DDL_OPERATION or SCHEMA_DDL_PERMISSIONS.`,
      );
    }

    const fullProcName = database
      ? `${escapeId(database)}.${escapeId(procedureName)}`
      : escapeId(procedureName);

    // Build CREATE PROCEDURE statement (same as create)
    let createSql = `CREATE PROCEDURE ${fullProcName}`;

    if (parameters) {
      createSql += `(${parameters})`;
    } else {
      createSql += `()`;
    }

    if (characteristics) {
      const chars: string[] = [];
      if (characteristics.language) {
        chars.push(`LANGUAGE ${characteristics.language}`);
      }
      if (characteristics.deterministic !== undefined) {
        chars.push(
          characteristics.deterministic ? "DETERMINISTIC" : "NOT DETERMINISTIC",
        );
      }
      if (characteristics.containsSql) {
        chars.push(characteristics.containsSql);
      }
      if (characteristics.sqlSecurity) {
        chars.push(`SQL SECURITY ${characteristics.sqlSecurity}`);
      }
      if (characteristics.comment) {
        chars.push(`COMMENT '${characteristics.comment.replace(/'/g, "''")}'`);
      }
      if (chars.length > 0) {
        createSql += `\n${chars.join("\n")}`;
      }
    }

    createSql += `\nBEGIN\n${procedureBody}\nEND`;

    log("info", `Modifying stored procedure: ${procedureName}`);

    // DROP and CREATE cannot run in transactions for procedures
    const pool = await getPool();
    const connection = await pool.getConnection();

    try {
      // Capture the current definition so the procedure can be restored if
      // the CREATE fails after the DROP (otherwise it would be lost).
      let previousDefinition: string | null = null;
      try {
        const showResult = await connection.query(
          `SHOW CREATE PROCEDURE ${fullProcName}`,
        );
        const showRows = Array.isArray(showResult)
          ? (showResult[0] as any[])
          : [];
        previousDefinition = showRows?.[0]?.["Create Procedure"] || null;
      } catch {
        // Procedure may not exist yet
      }

      // Drop existing procedure
      const dropSql = `DROP PROCEDURE ${ifExists ? "IF EXISTS" : ""} ${fullProcName}`;
      try {
        await connection.query(dropSql);
      } catch (dropError) {
        if (!ifExists) {
          throw dropError;
        }
        // If IF EXISTS and procedure doesn't exist, continue
      }

      // Create new procedure; on failure, restore the previous definition
      try {
        await connection.query(createSql);
      } catch (createError) {
        if (previousDefinition) {
          try {
            await connection.query(previousDefinition);
            log(
              "info",
              `CREATE failed; restored previous definition of ${procedureName}`,
            );
          } catch (restoreError) {
            log(
              "error",
              `CREATE failed and restore also failed for ${procedureName}:`,
              restoreError,
            );
          }
        }
        throw createError;
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully modified procedure '${procedureName}'`,
          },
          { type: "text", text: `\nGenerated SQL:\n${dropSql};\n${createSql}` },
        ],
        isError: false,
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    log("error", "Error in mysql_alter_procedure:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_alter_table - Execute ALTER TABLE operations
// ============================================================================

export async function mysqlAlterTable(
  table: string,
  alterStatement: string,
  database?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (!alterStatement || alterStatement.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: alterStatement is required and cannot be empty",
          },
        ],
        isError: true,
      };
    }

    const fullTableName = database
      ? `${escapeId(database)}.${escapeId(table)}`
      : escapeId(table);
    const sql = `ALTER TABLE ${fullTableName} ${alterStatement}`;

    log("info", `Executing ALTER TABLE: ${sql}`);

    // Use executeReadOnlyQuery which will delegate to executeWriteQuery for DDL operations
    // This ensures proper permission checking
    const result = await executeReadOnlyQuery<{
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    }>(sql);

    if (result.isError) {
      return result;
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully executed ALTER TABLE on '${table}'`,
        },
        { type: "text", text: `\nExecuted SQL: ${sql}` },
        ...(result.content || []),
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_alter_table:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${formatMysqlError(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Export tool definitions for MCP registration
// ============================================================================

export const additionalToolDefinitions = [
  {
    name: "mysql_explain",
    description:
      "Analyze SQL query execution plan using EXPLAIN/EXPLAIN ANALYZE. Use this tool to optimize slow queries, understand how MySQL executes queries, and get automatic suggestions for adding indexes or improving query structure. Returns detailed execution plan with optimization recommendations. Works with SELECT, UPDATE, DELETE, and INSERT queries.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "The SQL query to analyze (SELECT, UPDATE, DELETE, or INSERT)",
        },
        format: {
          type: "string",
          enum: ["traditional", "json", "tree"],
          description:
            "Output format: 'traditional' (default, human-readable table), 'json' (structured JSON), or 'tree' (hierarchical tree format)",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "mysql_describe",
    description:
      "Get comprehensive table structure information. Returns columns with data types, indexes, foreign key relationships, table statistics (row count, size, engine), and the CREATE TABLE statement. Use this tool when you need to understand a table's schema, check column types, see indexes, or analyze table structure before making changes.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to describe" },
        database: {
          type: "string",
          description:
            "Database name (optional, uses current database if not specified)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "mysql_data_dictionary",
    description:
      "Generate AI-friendly documentation for one table or a full database. Returns per-table columns, primary key, foreign keys, indexes, sample rows, and an inferred purpose summary. Supports JSON or Markdown output so an agent can build context quickly before writing queries or code.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to inspect. Optional if MYSQL_DB is configured.",
        },
        table: {
          type: "string",
          description:
            "Specific table to document. If omitted, documents all base tables in the database.",
        },
        format: {
          type: "string",
          enum: ["json", "markdown"],
          description:
            "Output format. Use 'json' for structured consumption or 'markdown' for readable documentation.",
        },
        sampleRowsLimit: {
          type: "number",
          description:
            "How many recent sample rows to include per table. Default: 3. Use 0 to disable samples.",
        },
      },
    },
  },
  {
    name: "mysql_backup",
    description:
      "Export table data to JSON or CSV format. Use this tool to backup data, export for analysis, or transfer data between systems. Supports filtering with WHERE clauses and limiting row count. Returns the exported data in the specified format.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Name of the table to export data from",
        },
        format: {
          type: "string",
          enum: ["json", "csv"],
          description:
            "Export format: 'json' (default, structured data) or 'csv' (comma-separated values for spreadsheets)",
        },
        database: {
          type: "string",
          description:
            "Database name (optional, uses current database if not specified)",
        },
        whereClause: {
          type: "string",
          description:
            "SQL WHERE clause conditions without the 'WHERE' keyword (e.g., 'status = \"active\" AND created_at > \"2024-01-01\"')",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of rows to export (useful for large tables)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "mysql_export_schema",
    description:
      "Exporta únicamente el esquema SQL a disco. Crea archivos .sql con CREATE/DROP/USE para tablas, views, procedures, functions, triggers y events. Usa este tool cuando el usuario pide 'generar/exportar el esquema', 'dump SQL', o archivos .sql. No genera documentación Markdown ni análisis con IA.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to export. Optional if MYSQL_DB is configured.",
        },
        outputDir: {
          type: "string",
          description:
            "Absolute or relative folder path where schema.sql and the subfolders procedures/, functions/, views/, triggers/, and events/ will be created. Optional if MYSQL_SCHEMA_EXPORT_DIR is configured.",
        },
        outputPath: {
          type: "string",
          description: "Backward-compatible alias of outputDir.",
        },
        includeDatabaseStatement: {
          type: "boolean",
          description:
            "If true, includes CREATE DATABASE and USE statements at the top of the file. Default: true.",
        },
      },
    },
  },
  {
    name: "mysql_compare_schemas",
    description:
      "Compare the structure (schema) between two databases and identify differences. Use this tool to find missing tables, different column definitions, or schema drift between environments (dev vs prod, staging vs production, etc.). Returns detailed comparison showing tables only in source, tables only in target, and column differences in common tables.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDb: {
          type: "string",
          description:
            "Source database name (the reference schema to compare FROM)",
        },
        targetDb: {
          type: "string",
          description: "Target database name (the schema to compare TO)",
        },
      },
      required: ["sourceDb", "targetDb"],
    },
  },
  {
    name: "mysql_generate_migration",
    description:
      "Generate a SQL migration script to synchronize two database schemas. Use this after mysql_compare_schemas to create ALTER TABLE statements that will make the target database match the source. The generated script includes CREATE TABLE for missing tables, ALTER TABLE for column changes, and commented DROP statements for safety. Review the script carefully before executing.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDb: {
          type: "string",
          description:
            "Source database name (the reference schema to migrate FROM - this is the desired state)",
        },
        targetDb: {
          type: "string",
          description:
            "Target database name (the schema to migrate TO - this will be modified to match source)",
        },
      },
      required: ["sourceDb", "targetDb"],
    },
  },
  {
    name: "mysql_query_history",
    description:
      "View or clear the history of executed queries in the current session. Use this tool to review what queries have been run, check execution times, see which queries failed, or debug issues. The history includes SQL statements, execution duration, row counts, and success/failure status. History is stored in-memory and cleared when the session ends.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Number of most recent queries to return (default: 50, maximum: 100)",
        },
        clear: {
          type: "boolean",
          description:
            "If true, clears the entire query history instead of returning it",
        },
      },
    },
  },
  {
    name: "mysql_call_procedure",
    description:
      "Execute a MySQL stored procedure using the CALL statement. Use this tool to run stored procedures that encapsulate business logic, perform complex operations, or return result sets. Parameters are passed as an array in the order defined by the procedure. Returns the procedure's result set or output parameters.",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: {
          type: "string",
          description: "Name of the stored procedure to execute",
        },
        params: {
          type: "array",
          items: {},
          description:
            'Array of parameter values in the order defined by the procedure. Can contain strings, numbers, booleans, or null. Example: ["value1", 123, true]',
        },
        database: {
          type: "string",
          description:
            "Database name where the procedure exists (optional, uses current database if not specified)",
        },
      },
      required: ["procedureName"],
    },
  },
  {
    name: "mysql_show_views",
    description:
      "List all database views or get detailed information about a specific view. Use this tool to discover available views, understand view definitions, check if views are updatable, or see view metadata. Views are virtual tables based on SELECT queries. If viewName is provided, returns detailed view structure including columns and definition.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to search views in (optional, searches all databases if not specified)",
        },
        viewName: {
          type: "string",
          description:
            "Specific view name to get detailed information for (optional, if omitted returns list of all views)",
        },
      },
    },
  },
  {
    name: "mysql_routine_impact",
    description:
      "Analiza impacto de cambio de una stored procedure o function. Busca dónde se usa dentro de procedures, functions, views, triggers y events para saber qué podría romperse si cambias esa rutina. Usa este tool cuando el usuario pregunta 'dónde se usa', 'qué impacta', o 'quién llama a esta function/SP'.",
    inputSchema: {
      type: "object",
      properties: {
        routineName: {
          type: "string",
          description: "Nombre de la function o stored procedure a buscar.",
        },
        database: {
          type: "string",
          description:
            "Base de datos donde buscar dependencias. Opcional si MYSQL_DB está configurado.",
        },
        routineType: {
          type: "string",
          enum: ["auto", "procedure", "function"],
          description:
            "Tipo de routine buscada. Usa 'auto' para inferirlo. Default: auto.",
        },
        includeSnippets: {
          type: "boolean",
          description:
            "Si es true, incluye un snippet corto donde se detectó el uso. Default: true.",
        },
      },
      required: ["routineName"],
    },
  },
  {
    name: "mysql_variables",
    description:
      "Show or set MySQL server configuration variables. Use this tool to check current MySQL settings (like max_connections, innodb_buffer_pool_size, etc.) or modify session/global variables. 'session' variables affect only the current connection, 'global' variables affect all new connections. Use 'filter' to search for specific variables by name pattern.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["show", "set"],
          description:
            "Action to perform: 'show' (default, displays variables) or 'set' (modifies a variable value)",
        },
        scope: {
          type: "string",
          enum: ["global", "session"],
          description:
            "Variable scope: 'session' (default, affects current connection only) or 'global' (affects all new connections, requires SUPER privilege)",
        },
        filter: {
          type: "string",
          description:
            "Filter variables by name pattern (e.g., 'max_conn' to find max_connections, max_connect_errors, etc.)",
        },
        variable: {
          type: "string",
          description:
            "Variable name to set (required when action='set', e.g., 'max_connections', 'innodb_buffer_pool_size')",
        },
        value: {
          type: "string",
          description:
            "New value for the variable (required when action='set', must be a valid value for that variable type)",
        },
      },
    },
  },
  {
    name: "mysql_index_suggestions",
    description:
      "Analyze database tables and automatically suggest missing indexes for query optimization. Use this tool to identify performance issues like tables without primary keys, foreign key columns without indexes, or commonly queried columns that should be indexed. Returns actionable suggestions with CREATE INDEX statements ready to execute.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to analyze (optional, analyzes all databases if not specified)",
        },
      },
    },
  },
  {
    name: "mysql_foreign_keys",
    description:
      "Show foreign key relationships between tables. Use this tool to understand database relationships, see which tables reference each other, check referential integrity constraints, or map out the database schema structure. Returns a relationship graph showing which tables reference others and which are referenced by others, including ON UPDATE and ON DELETE rules.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to search in (optional, searches all databases if not specified)",
        },
        table: {
          type: "string",
          description:
            "Specific table name to show relationships for (optional, if omitted shows all foreign key relationships)",
        },
      },
    },
  },
  {
    name: "mysql_table_stats",
    description:
      "Get detailed statistics and metrics for database tables. Use this tool to monitor table sizes, row counts, fragmentation levels, storage engine information, and identify tables that may need optimization or maintenance. Returns formatted sizes (KB, MB, GB), fragmentation percentages, and summary totals. Useful for capacity planning and performance monitoring.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description:
            "Database name to analyze (optional, analyzes all databases if not specified)",
        },
        table: {
          type: "string",
          description:
            "Specific table name to get statistics for (optional, if omitted returns stats for all tables)",
        },
      },
    },
  },
  {
    name: "mysql_process_list",
    description:
      "Show currently running MySQL processes and active queries. Use this tool to monitor database activity, identify long-running queries, see which users are connected, check query execution times, or diagnose performance issues. Returns process list with analysis including active queries count, sleeping connections, and queries grouped by user/command.",
    inputSchema: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description:
            "If true, shows full query text (default: false, shows truncated queries for readability)",
        },
      },
    },
  },
  {
    name: "mysql_kill_process",
    description:
      "Terminate a running MySQL process/query by its process ID. Use this tool to stop long-running queries, kill stuck connections, or free up resources. First use mysql_process_list to find the process ID, then use this tool to kill it. WARNING: This will immediately terminate the query/connection.",
    inputSchema: {
      type: "object",
      properties: {
        processId: {
          type: "number",
          description:
            "Process ID to kill (get this from mysql_process_list output, must be a positive integer)",
        },
      },
      required: ["processId"],
    },
  },
  {
    name: "mysql_create_procedure",
    description:
      "Create a new MySQL stored procedure. Use this tool to encapsulate business logic, create reusable database functions, or implement complex operations. Stored procedures can accept IN/OUT/INOUT parameters and return result sets. The procedure body contains SQL statements wrapped in BEGIN...END. Returns an error if the procedure already exists (use mysql_alter_procedure to modify existing procedures).",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: {
          type: "string",
          description:
            "Name of the procedure to create (must be unique in the database)",
        },
        procedureBody: {
          type: "string",
          description:
            "SQL statements inside BEGIN...END block. Example: 'SELECT * FROM users WHERE id = user_id; SELECT COUNT(*) INTO total FROM orders;'",
        },
        database: {
          type: "string",
          description:
            "Database name where to create the procedure (optional, uses current database if not specified)",
        },
        parameters: {
          type: "string",
          description:
            "Procedure parameters definition. Example: 'IN user_id INT, OUT total INT, INOUT counter INT'. Use IN for input, OUT for output, INOUT for both.",
        },
        characteristics: {
          type: "object",
          description:
            "Optional procedure characteristics for security and optimization",
          properties: {
            comment: {
              type: "string",
              description:
                "Documentation comment describing what the procedure does",
            },
            language: {
              type: "string",
              enum: ["SQL"],
              description: "Programming language (default: SQL)",
            },
            deterministic: {
              type: "boolean",
              description:
                "Whether the procedure always returns the same result for the same inputs (affects caching)",
            },
            containsSql: {
              type: "string",
              enum: [
                "CONTAINS SQL",
                "NO SQL",
                "READS SQL DATA",
                "MODIFIES SQL DATA",
              ],
              description:
                "SQL data access level: 'CONTAINS SQL' (default, may read/write), 'NO SQL' (no SQL), 'READS SQL DATA' (read-only), 'MODIFIES SQL DATA' (may modify data)",
            },
            sqlSecurity: {
              type: "string",
              enum: ["DEFINER", "INVOKER"],
              description:
                "Security context: 'DEFINER' (runs with creator's privileges) or 'INVOKER' (runs with caller's privileges)",
            },
          },
        },
      },
      required: ["procedureName", "procedureBody"],
    },
  },
  {
    name: "mysql_alter_procedure",
    description:
      "Modify an existing stored procedure by dropping and recreating it. Use this tool to update procedure logic, change parameters, or modify characteristics. MySQL doesn't support ALTER PROCEDURE directly, so this tool performs DROP + CREATE. Set ifExists=true to avoid errors if the procedure doesn't exist. WARNING: This will temporarily remove the procedure during recreation.",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: {
          type: "string",
          description: "Name of the existing procedure to modify",
        },
        procedureBody: {
          type: "string",
          description: "Updated SQL statements inside BEGIN...END block",
        },
        database: {
          type: "string",
          description:
            "Database name where the procedure exists (optional, uses current database if not specified)",
        },
        parameters: {
          type: "string",
          description:
            "Updated procedure parameters. Example: 'IN param1 INT, OUT param2 VARCHAR(100)'. Can be different from original.",
        },
        characteristics: {
          type: "object",
          description: "Updated procedure characteristics",
          properties: {
            comment: {
              type: "string",
              description: "Updated documentation comment",
            },
            language: {
              type: "string",
              enum: ["SQL"],
              description: "Programming language (default: SQL)",
            },
            deterministic: {
              type: "boolean",
              description: "Updated determinism setting",
            },
            containsSql: {
              type: "string",
              enum: [
                "CONTAINS SQL",
                "NO SQL",
                "READS SQL DATA",
                "MODIFIES SQL DATA",
              ],
              description: "Updated SQL data access level",
            },
            sqlSecurity: {
              type: "string",
              enum: ["DEFINER", "INVOKER"],
              description: "Updated security context",
            },
          },
        },
        ifExists: {
          type: "boolean",
          description:
            "If true, uses 'DROP PROCEDURE IF EXISTS' to avoid errors if procedure doesn't exist (default: false)",
        },
      },
      required: ["procedureName", "procedureBody"],
    },
  },
  {
    name: "mysql_alter_table",
    description:
      "Execute ALTER TABLE operations to modify table structure. Use this tool to add/modify/drop columns, add/remove indexes, change data types, modify constraints, or rename tables. Supports all MySQL ALTER TABLE operations. The alterStatement should contain the operation without the 'ALTER TABLE table_name' prefix. Returns the executed SQL for verification.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to modify" },
        alterStatement: {
          type: "string",
          description:
            "ALTER TABLE operation statement (without 'ALTER TABLE table_name' prefix). Examples: 'ADD COLUMN name VARCHAR(100) NOT NULL', 'MODIFY COLUMN id INT AUTO_INCREMENT', 'DROP COLUMN old_column', 'ADD INDEX idx_name (name)', 'ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)', 'RENAME TO new_table_name'",
        },
        database: {
          type: "string",
          description:
            "Database name where the table exists (optional, uses current database if not specified)",
        },
      },
      required: ["table", "alterStatement"],
    },
  },
];

// Handler function to route tool calls
export async function handleAdditionalTool(
  toolName: string,
  args: Record<string, any>,
  context?: ToolContext,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} | null> {
  switch (toolName) {
    case "mysql_explain":
      return mysqlExplain(args.sql, args.format, args.analyze);

    case "mysql_describe":
      return mysqlDescribe(args.table, args.database, args.includeSampleRows);

    case "mysql_data_dictionary":
      return mysqlDataDictionary(
        args.database,
        args.table,
        args.format,
        args.sampleRowsLimit,
        args.maxTables,
        args.offsetTables,
        context,
      );

    case "mysql_backup":
      return mysqlBackup(
        args.table,
        args.format,
        args.database,
        args.whereClause,
        args.limit,
        args.columns,
        args.outputFile,
      );

    case "mysql_export_schema":
      return mysqlExportSchema(
        args.database,
        args.outputDir || args.outputPath,
        args.includeDatabaseStatement,
        context,
      );

    case "mysql_compare_schemas":
      return mysqlCompareSchemas(args.sourceDb, args.targetDb);

    case "mysql_generate_migration":
      return mysqlGenerateMigration(args.sourceDb, args.targetDb);

    case "mysql_query_history":
      if (args.clear) {
        clearQueryHistory();
        return {
          content: [{ type: "text", text: "Query history cleared" }],
          isError: false,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                stats: getQueryHistoryStats(),
                entries: getQueryHistory(args.limit, args.onlyErrors),
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };

    case "mysql_call_procedure":
      return mysqlCallProcedure(
        args.procedureName,
        args.params || [],
        args.database,
        args.outParams || [],
      );

    case "mysql_show_views":
      return mysqlShowViews(args.database, args.viewName);

    case "mysql_routine_impact":
      return mysqlRoutineImpact(
        args.routineName,
        args.database,
        args.routineType,
        args.includeSnippets,
      );

    case "mysql_variables":
      return mysqlVariables(
        args.action,
        args.scope,
        args.filter,
        args.variable,
        args.value,
      );

    case "mysql_index_suggestions":
      return mysqlIndexSuggestions(args.database);

    case "mysql_foreign_keys":
      return mysqlForeignKeys(args.database, args.table, args.format);

    case "mysql_table_stats":
      return mysqlTableStats(args.database, args.table);

    case "mysql_process_list":
      return mysqlProcessList(args.full, args.user, args.db, args.minTime);

    case "mysql_kill_process":
      return mysqlKillProcess(args.processId, args.mode);

    case "mysql_create_procedure":
      return mysqlCreateProcedure(
        args.procedureName,
        args.procedureBody,
        args.database,
        args.parameters,
        args.characteristics,
      );

    case "mysql_alter_procedure":
      return mysqlAlterProcedure(
        args.procedureName,
        args.procedureBody,
        args.database,
        args.parameters,
        args.characteristics,
        args.ifExists,
      );

    case "mysql_alter_table":
      return mysqlAlterTable(args.table, args.alterStatement, args.database);

    default:
      return null; // Tool not handled here
  }
}
