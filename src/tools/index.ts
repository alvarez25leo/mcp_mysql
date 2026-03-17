/**
 * Additional MySQL Tools for MCP Server
 * Provides extended functionality for database analysis, optimization, and management
 */

import { executeQuery, executeReadOnlyQuery, getPool } from "../db/index.js";
import { log } from "../utils/index.js";
import * as fs from "fs";
import * as path from "path";

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

/**
 * Add a query to the history
 */
export function addToQueryHistory(
  sql: string,
  duration: number,
  rowCount: number,
  success: boolean,
  error?: string
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
export function getQueryHistory(limit: number = 50): typeof queryHistory {
  return queryHistory.slice(-limit);
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

function buildDelimitedSqlBlock(statements: string[], delimiter: string = ROUTINE_DELIMITER): string {
  return [
    `DELIMITER ${delimiter}`,
    ...statements
      .filter((statement) => statement.trim().length > 0)
      .map((statement) => `${stripTrailingSqlTerminator(statement)}${delimiter}`),
    "DELIMITER ;",
    "",
  ].join("\n\n");
}

// ============================================================================
// TOOL: mysql_explain - Analyze query execution plans
// ============================================================================

export async function mysqlExplain(sql: string, format: "traditional" | "json" | "tree" = "traditional"): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // Validate that it's a SELECT, UPDATE, DELETE, or INSERT query
    const normalizedSql = sql.trim().toUpperCase();
    if (!normalizedSql.startsWith("SELECT") && 
        !normalizedSql.startsWith("UPDATE") && 
        !normalizedSql.startsWith("DELETE") && 
        !normalizedSql.startsWith("INSERT")) {
      return {
        content: [{ type: "text", text: "Error: EXPLAIN only works with SELECT, UPDATE, DELETE, or INSERT queries" }],
        isError: true,
      };
    }

    let explainSql: string;
    switch (format) {
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
    
    // Also get extended information
    const analyzeResult = await executeQuery<any[]>(`EXPLAIN ANALYZE ${sql}`).catch(() => null);

    let response = {
      explainPlan: result,
      format,
      suggestions: [] as string[],
    };

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
          response.suggestions.push(`⚠️ Full table scan detected on '${table}'. Consider adding an index.`);
        }
        if (type === "index" && rows && rows > 1000) {
          response.suggestions.push(`⚠️ Index scan on '${table}' returning ${rows} rows. Consider optimizing the query.`);
        }
        if (!key && possibleKeys) {
          response.suggestions.push(`💡 Possible keys available but not used on '${table}': ${possibleKeys}`);
        }
        if (extra && typeof extra === "string") {
          if (extra.includes("Using filesort")) {
            response.suggestions.push(`⚠️ Using filesort on '${table}'. Consider adding an index for ORDER BY columns.`);
          }
          if (extra.includes("Using temporary")) {
            response.suggestions.push(`⚠️ Using temporary table on '${table}'. This may impact performance.`);
          }
        }
      }
    }

    if (analyzeResult) {
      response = { ...response, analyzeResult } as any;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_explain:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_describe - Describe table structure
// ============================================================================

export async function mysqlDescribe(table: string, database?: string): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullTableName = database ? `\`${database}\`.\`${table}\`` : `\`${table}\``;
    
    // Get table structure
    const columns = await executeQuery<any[]>(`DESCRIBE ${fullTableName}`);
    
    // Get indexes
    const indexes = await executeQuery<any[]>(`SHOW INDEX FROM ${fullTableName}`);
    
    // Get create table statement
    const createTable = await executeQuery<any[]>(`SHOW CREATE TABLE ${fullTableName}`);
    
    // Get table status
    const statusQuery = database
      ? `SHOW TABLE STATUS FROM \`${database}\` LIKE '${table}'`
      : `SHOW TABLE STATUS LIKE '${table}'`;
    const status = await executeQuery<any[]>(statusQuery);

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

    const response = {
      table: table,
      database: database || "current",
      columns: columns,
      indexes: indexes.reduce((acc: any[], idx: any) => {
        const existing = acc.find(i => i.keyName === idx.Key_name);
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
      tableStats: status[0] ? {
        engine: status[0].Engine,
        rowCount: status[0].Rows,
        dataLength: status[0].Data_length,
        indexLength: status[0].Index_length,
        autoIncrement: status[0].Auto_increment,
        createTime: status[0].Create_time,
        updateTime: status[0].Update_time,
        collation: status[0].Collation,
      } : null,
      createStatement: createTable[0]?.["Create Table"] || null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_describe:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
  sampleRowsLimit: number = 3
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{
          type: "text",
          text: "Error: database is required when MYSQL_DB is not configured",
        }],
        isError: true,
      };
    }

    const tables = await executeQuery<any[]>(
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
      table ? [targetDatabase, table] : [targetDatabase]
    );

    const dictionaryTables = [];

    for (const tableRow of tables) {
      const tableName = tableRow.tableName;

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
        [targetDatabase, tableName]
      );

      const indexesRaw = await executeQuery<any[]>(
        `SHOW INDEX FROM \`${targetDatabase}\`.\`${tableName}\``
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
        [targetDatabase, tableName]
      );

      const sampleRows =
        sampleRowsLimit > 0
          ? await getTableSampleRows(targetDatabase, tableName, sampleRowsLimit)
          : [];

      const indexes = indexesRaw.reduce((acc: any[], idx: any) => {
        const existing = acc.find((i) => i.keyName === idx.Key_name);
        if (existing) {
          existing.columns.push(idx.Column_name);
        } else {
          acc.push({
            keyName: idx.Key_name,
            unique: idx.Non_unique === 0,
            indexType: idx.Index_type,
            columns: [idx.Column_name],
          });
        }
        return acc;
      }, []);

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

    const payload = {
      database: targetDatabase,
      totalTables: dictionaryTables.length,
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
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function inferTablePurpose(
  tableName: string,
  columns: any[],
  foreignKeys: any[]
): string {
  const normalizedTableName = tableName.toLowerCase();
  const columnNames = columns.map((column) => String(column.name).toLowerCase());
  const hints: string[] = [];

  if (normalizedTableName.includes("user")) hints.push("stores user identities or profiles");
  if (normalizedTableName.includes("role") || normalizedTableName.includes("permission")) hints.push("models authorization or access control");
  if (normalizedTableName.includes("log") || normalizedTableName.includes("audit")) hints.push("captures audit trail or operational events");
  if (normalizedTableName.includes("config") || normalizedTableName.includes("setting")) hints.push("stores configuration values");
  if (normalizedTableName.includes("session") || normalizedTableName.includes("token")) hints.push("tracks sessions or authentication tokens");
  if (normalizedTableName.includes("order") || normalizedTableName.includes("invoice")) hints.push("stores transactional or billing records");
  if (normalizedTableName.includes("detail") || normalizedTableName.includes("item")) hints.push("acts as line-item detail for a parent entity");
  if (normalizedTableName.includes("catalog") || normalizedTableName.includes("product")) hints.push("stores product or catalog information");
  if (normalizedTableName.includes("message") || normalizedTableName.includes("notification")) hints.push("stores messages, alerts, or notifications");

  if (columnNames.includes("status")) hints.push("contains lifecycle or workflow state");
  if (columnNames.includes("created_at") || columnNames.includes("updated_at")) hints.push("tracks creation/update timestamps");
  if (columnNames.includes("deleted_at")) hints.push("supports soft deletion");
  if (columnNames.includes("email")) hints.push("contains contact or identity data");
  if (columnNames.includes("password") || columnNames.includes("password_hash")) hints.push("contains authentication-related data");

  if (foreignKeys.length >= 2) hints.push("links multiple business entities through foreign keys");
  else if (foreignKeys.length === 1) hints.push("references another core entity");

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
  lines.push(`- Generated at: \`${payload.generatedAt}\``);
  lines.push(`- Total tables: ${payload.totalTables}`);
  lines.push("");

  for (const table of payload.tables) {
    lines.push(`## ${table.table}`);
    lines.push("");
    lines.push(`- Purpose: ${table.inferredPurpose}`);
    lines.push(`- Engine: ${table.engine || "unknown"}`);
    lines.push(`- Estimated rows: ${table.estimatedRows ?? "unknown"}`);
    lines.push(`- Primary key: ${table.primaryKey.length > 0 ? table.primaryKey.map((key: string) => `\`${key}\``).join(", ") : "none"}`);
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
        `| \`${column.name}\` | \`${column.columnType}\` | ${column.isNullable} | ${column.columnKey || ""} | ${column.defaultValue ?? ""} | ${column.extra || ""} | ${column.comment || ""} |`
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
          `- \`${index.keyName}\` (${index.unique ? "unique" : "non-unique"}, ${index.indexType}): ${index.columns.map((column: string) => `\`${column}\``).join(", ")}`
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
          `- \`${fk.columnName}\` -> \`${fk.referencedSchema}.${fk.referencedTable}.${fk.referencedColumn}\` (${fk.onUpdate || "?"}/${fk.onDelete || "?"})`
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
  format: "json" | "csv" = "json",
  database?: string,
  whereClause?: string,
  limit?: number
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullTableName = database ? `\`${database}\`.\`${table}\`` : `\`${table}\``;
    
    let sql = `SELECT * FROM ${fullTableName}`;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const rows = await executeQuery<any[]>(sql);

    let output: string;
    if (format === "csv") {
      if (rows.length === 0) {
        output = "";
      } else {
        const headers = Object.keys(rows[0]);
        const csvRows = [
          headers.join(","),
          ...rows.map(row => 
            headers.map(h => {
              const val = row[h];
              if (val === null) return "";
              if (typeof val === "string" && (val.includes(",") || val.includes('"') || val.includes("\n"))) {
                return `"${val.replace(/"/g, '""')}"`;
              }
              return String(val);
            }).join(",")
          )
        ];
        output = csvRows.join("\n");
      }
    } else {
      output = JSON.stringify(rows, null, 2);
    }

    return {
      content: [
        { type: "text", text: output },
        { type: "text", text: `\n--- Exported ${rows.length} rows from ${table} as ${format.toUpperCase()} ---` },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_backup:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
  includeDatabaseStatement: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{
          type: "text",
          text: "Error: database is required when MYSQL_DB is not configured",
        }],
        isError: true,
      };
    }

    const configuredOutputDir =
      process.env.MYSQL_SCHEMA_EXPORT_DIR || process.env.MYSQL_SCHEMA_EXPORT_PATH;
    const finalOutputDir = outputDir || configuredOutputDir;
    if (!finalOutputDir) {
      return {
        content: [{
          type: "text",
          text: "Error: outputDir is required or set MYSQL_SCHEMA_EXPORT_DIR",
        }],
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

    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    fs.mkdirSync(proceduresDir, { recursive: true });
    fs.mkdirSync(functionsDir, { recursive: true });
    fs.mkdirSync(viewsDir, { recursive: true });

    if (includeDatabaseStatement) {
      const createDatabaseResult = await executeQuery<any[]>(
        `SHOW CREATE DATABASE \`${targetDatabase}\``
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
      [targetDatabase]
    );

    for (const table of tables) {
      const createTableResult = await executeQuery<any[]>(
        `SHOW CREATE TABLE \`${targetDatabase}\`.\`${table.TABLE_NAME}\``
      );
      const createTableStatement =
        createTableResult[0]?.["Create Table"] ||
        createTableResult[0]?.["CREATE TABLE"];

      if (createTableStatement) {
        schemaStatements.push(`DROP TABLE IF EXISTS \`${table.TABLE_NAME}\`;`);
        schemaStatements.push(`${createTableStatement};`);

        if (includeSampleRows) {
          const sampleRows = await getTableSampleRows(targetDatabase, table.TABLE_NAME);
          if (sampleRows.length > 0) {
            schemaStatements.push(
              [
                `-- SAMPLE_ROWS ${table.TABLE_NAME} (up to 3 latest rows)`,
                ...sampleRows.map((row) => `-- ${JSON.stringify(row)}`),
              ].join("\n")
            );
          } else {
            schemaStatements.push(
              `-- SAMPLE_ROWS ${table.TABLE_NAME} (no rows found or unable to infer ordering)`
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
      [targetDatabase]
    );

    for (const view of views) {
      const createViewResult = await executeQuery<any[]>(
        `SHOW CREATE VIEW \`${targetDatabase}\`.\`${view.TABLE_NAME}\``
      );
      const createViewStatement =
        createViewResult[0]?.["Create View"] ||
        createViewResult[0]?.["CREATE VIEW"];

      if (createViewStatement) {
        const viewFilePath = path.join(viewsDir, `${view.TABLE_NAME}.sql`);
        const viewSql = [
          includeDatabaseStatement ? `USE \`${targetDatabase}\`;` : "",
          `DROP VIEW IF EXISTS \`${view.TABLE_NAME}\`;`,
          `${createViewStatement};`,
          "",
        ].filter(Boolean).join("\n\n");

        fs.writeFileSync(viewFilePath, `${viewSql}\n`, "utf8");
      }
    }

    const routines = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
       ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [targetDatabase]
    );

    for (const routine of routines) {
      if (routine.ROUTINE_TYPE === "PROCEDURE") {
        const createProcedureResult = await executeQuery<any[]>(
          `SHOW CREATE PROCEDURE \`${targetDatabase}\`.\`${routine.ROUTINE_NAME}\``
        );
        const createProcedureStatement =
          createProcedureResult[0]?.["Create Procedure"];

        if (createProcedureStatement) {
          const procedureFilePath = path.join(
            proceduresDir,
            `${routine.ROUTINE_NAME}.sql`
          );
          const procedureSql = buildDelimitedSqlBlock([
            includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
            `DROP PROCEDURE IF EXISTS \`${routine.ROUTINE_NAME}\``,
            createProcedureStatement,
          ]);

          fs.writeFileSync(procedureFilePath, `${procedureSql}\n`, "utf8");
        }
      } else if (routine.ROUTINE_TYPE === "FUNCTION") {
        const createFunctionResult = await executeQuery<any[]>(
          `SHOW CREATE FUNCTION \`${targetDatabase}\`.\`${routine.ROUTINE_NAME}\``
        );
        const createFunctionStatement =
          createFunctionResult[0]?.["Create Function"];

        if (createFunctionStatement) {
          const functionFilePath = path.join(
            functionsDir,
            `${routine.ROUTINE_NAME}.sql`
          );
          const functionSql = buildDelimitedSqlBlock([
            includeDatabaseStatement ? `USE \`${targetDatabase}\`` : "",
            `DROP FUNCTION IF EXISTS \`${routine.ROUTINE_NAME}\``,
            createFunctionStatement,
          ]);

          fs.writeFileSync(functionFilePath, `${functionSql}\n`, "utf8");
        }
      }
    }

    const triggers = await executeQuery<any[]>(
      `SELECT TRIGGER_NAME
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
       ORDER BY TRIGGER_NAME`,
      [targetDatabase]
    );

    for (const trigger of triggers) {
      const createTriggerResult = await executeQuery<any[]>(
        `SHOW CREATE TRIGGER \`${targetDatabase}\`.\`${trigger.TRIGGER_NAME}\``
      );
      const createTriggerStatement =
        createTriggerResult[0]?.["SQL Original Statement"] ||
        createTriggerResult[0]?.["Create Trigger"];

      if (createTriggerStatement) {
        schemaStatements.push(
          buildDelimitedSqlBlock([
            `DROP TRIGGER IF EXISTS \`${trigger.TRIGGER_NAME}\``,
            createTriggerStatement,
          ])
        );
      }
    }

    const events = await executeQuery<any[]>(
      `SELECT EVENT_NAME
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ?
       ORDER BY EVENT_NAME`,
      [targetDatabase]
    );

    for (const event of events) {
      const createEventResult = await executeQuery<any[]>(
        `SHOW CREATE EVENT \`${targetDatabase}\`.\`${event.EVENT_NAME}\``
      );
      const createEventStatement =
        createEventResult[0]?.["Create Event"];

      if (createEventStatement) {
        schemaStatements.push(
          buildDelimitedSqlBlock([
            `DROP EVENT IF EXISTS \`${event.EVENT_NAME}\``,
            createEventStatement,
          ])
        );
      }
    }

    const schemaFilePath = path.join(resolvedOutputDir, "schema.sql");
    fs.writeFileSync(schemaFilePath, schemaStatements.join("\n\n") + "\n", "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          database: targetDatabase,
          outputDir: resolvedOutputDir,
          schemaFile: schemaFilePath,
          proceduresDir,
          functionsDir,
          viewsDir,
          includeSampleRows,
          tables: tables.length,
          views: views.length,
          routines: routines.length,
          triggers: triggers.length,
          events: events.length,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_export_schema:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function getTableSampleRows(
  database: string,
  table: string,
  limit: number = 3
): Promise<any[]> {
  try {
    const orderingColumns = await executeQuery<any[]>(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, EXTRA, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table]
    );

    const primaryKeyColumn = orderingColumns.find(
      (column) => column.COLUMN_KEY === "PRI"
    )?.COLUMN_NAME;

    const timestampColumn = orderingColumns.find((column) =>
      ["timestamp", "datetime", "date"].includes(
        String(column.DATA_TYPE).toLowerCase()
      )
    )?.COLUMN_NAME;

    const autoIncrementColumn = orderingColumns.find((column) =>
      String(column.EXTRA).toLowerCase().includes("auto_increment")
    )?.COLUMN_NAME;

    const orderByColumn =
      autoIncrementColumn || primaryKeyColumn || timestampColumn;

    const sampleSql = orderByColumn
      ? `SELECT * FROM \`${database}\`.\`${table}\` ORDER BY \`${orderByColumn}\` DESC LIMIT ${limit}`
      : `SELECT * FROM \`${database}\`.\`${table}\` LIMIT ${limit}`;

    return await executeQuery<any[]>(sampleSql);
  } catch (error) {
    log("error", `Error getting sample rows for ${database}.${table}:`, error);
    return [];
  }
}

// ============================================================================
// TOOL: mysql_import - Import data from JSON
// ============================================================================

export async function mysqlImport(
  table: string,
  data: any[],
  database?: string,
  mode: "insert" | "replace" | "upsert" = "insert"
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ type: "text", text: "Error: Data must be a non-empty array of objects" }],
        isError: true,
      };
    }

    const fullTableName = database ? `\`${database}\`.\`${table}\`` : `\`${table}\``;
    const columns = Object.keys(data[0]);
    const pool = await getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      let insertedCount = 0;
      for (const row of data) {
        const values = columns.map(col => row[col]);
        const placeholders = columns.map(() => "?").join(", ");
        const columnList = columns.map(c => `\`${c}\``).join(", ");

        let sql: string;
        switch (mode) {
          case "replace":
            sql = `REPLACE INTO ${fullTableName} (${columnList}) VALUES (${placeholders})`;
            break;
          case "upsert":
            const updateClause = columns.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");
            sql = `INSERT INTO ${fullTableName} (${columnList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;
            break;
          default:
            sql = `INSERT INTO ${fullTableName} (${columnList}) VALUES (${placeholders})`;
        }

        await connection.query(sql, values);
        insertedCount++;
      }

      await connection.commit();

      return {
        content: [{ type: "text", text: `Successfully imported ${insertedCount} rows into ${table} using ${mode} mode` }],
        isError: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    log("error", "Error in mysql_import:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_compare_schemas - Compare two database schemas
// ============================================================================

export async function mysqlCompareSchemas(
  sourceDb: string,
  targetDb: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // Get tables from both databases
    const sourceTablesResult = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [sourceDb]
    );
    const targetTablesResult = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [targetDb]
    );

    const sourceTables = new Set(sourceTablesResult.map(t => t.name));
    const targetTables = new Set(targetTablesResult.map(t => t.name));

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
    const commonTables = [...sourceTables].filter(t => targetTables.has(t));
    
    for (const table of commonTables) {
      // Compare columns
      const sourceColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA 
         FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [sourceDb, table]
      );
      
      const targetColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA 
         FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [targetDb, table]
      );

      const sourceColMap = new Map(sourceColumns.map(c => [c.COLUMN_NAME, c]));
      const targetColMap = new Map(targetColumns.map(c => [c.COLUMN_NAME, c]));

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
          if (col.COLUMN_TYPE !== targetCol.COLUMN_TYPE || 
              col.IS_NULLABLE !== targetCol.IS_NULLABLE) {
            tableDiff.columnTypeDifferences.push({
              column: colName,
              source: { type: col.COLUMN_TYPE, nullable: col.IS_NULLABLE },
              target: { type: targetCol.COLUMN_TYPE, nullable: targetCol.IS_NULLABLE },
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

      if (tableDiff.columnsOnlyInSource.length > 0 ||
          tableDiff.columnsOnlyInTarget.length > 0 ||
          tableDiff.columnTypeDifferences.length > 0) {
        differences.columnDifferences.push(tableDiff);
      }
    }

    differences.summary.tablesOnlyInSource = differences.tablesOnlyInSource.length;
    differences.summary.tablesOnlyInTarget = differences.tablesOnlyInTarget.length;
    differences.summary.tablesWithColumnDifferences = differences.columnDifferences.length;

    return {
      content: [{ type: "text", text: JSON.stringify(differences, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_compare_schemas:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_generate_migration - Generate migration SQL scripts
// ============================================================================

export async function mysqlGenerateMigration(
  sourceDb: string,
  targetDb: string
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

    migrations.push(`-- Migration script from '${sourceDb}' to '${targetDb}'`);
    migrations.push(`-- Generated at ${new Date().toISOString()}`);
    migrations.push(`-- WARNING: Review carefully before executing!\n`);

    // Tables to create in target
    if (diff.tablesOnlyInSource.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(`-- Tables to ADD to '${targetDb}'`);
      migrations.push(`-- ============================================\n`);
      
      for (const table of diff.tablesOnlyInSource) {
        const createStmt = await executeQuery<any[]>(`SHOW CREATE TABLE \`${sourceDb}\`.\`${table}\``);
        if (createStmt[0]) {
          let createSql = createStmt[0]["Create Table"];
          // Replace database name if present
          createSql = createSql.replace(new RegExp(sourceDb, "g"), targetDb);
          migrations.push(`-- Create table: ${table}`);
          migrations.push(createSql + ";\n");
        }
      }
    }

    // Tables to drop from target (commented out for safety)
    if (diff.tablesOnlyInTarget.length > 0) {
      migrations.push(`-- ============================================`);
      migrations.push(`-- Tables that exist only in '${targetDb}' (uncomment to drop)`);
      migrations.push(`-- ============================================\n`);
      
      for (const table of diff.tablesOnlyInTarget) {
        migrations.push(`-- DROP TABLE IF EXISTS \`${targetDb}\`.\`${table}\`;`);
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
            [sourceDb, tableDiff.table, col]
          );
          if (colInfo[0]) {
            const nullable = colInfo[0].IS_NULLABLE === "YES" ? "NULL" : "NOT NULL";
            const defaultVal = colInfo[0].COLUMN_DEFAULT ? ` DEFAULT '${colInfo[0].COLUMN_DEFAULT}'` : "";
            migrations.push(`ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` ADD COLUMN \`${col}\` ${colInfo[0].COLUMN_TYPE} ${nullable}${defaultVal};`);
          }
        }

        // Columns to drop (commented for safety)
        for (const col of tableDiff.columnsOnlyInTarget) {
          migrations.push(`-- ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` DROP COLUMN \`${col}\`;`);
        }

        // Column modifications
        for (const colDiff of tableDiff.columnTypeDifferences) {
          const nullable = colDiff.source.nullable === "YES" ? "NULL" : "NOT NULL";
          migrations.push(`ALTER TABLE \`${targetDb}\`.\`${tableDiff.table}\` MODIFY COLUMN \`${colDiff.column}\` ${colDiff.source.type} ${nullable};`);
        }

        migrations.push("");
      }
    }

    if (migrations.length <= 4) {
      migrations.push("-- No differences found. Schemas are identical.");
    }

    return {
      content: [{ type: "text", text: migrations.join("\n") }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_generate_migration:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
  database?: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullProcName = database ? `\`${database}\`.\`${procedureName}\`` : `\`${procedureName}\``;
    const placeholders = params.map(() => "?").join(", ");
    const sql = `CALL ${fullProcName}(${placeholders})`;

    log("info", `Executing stored procedure: ${sql}`, params);

    const pool = await getPool();
    const connection = await pool.getConnection();

    try {
      const [results] = await connection.query(sql, params);
      
      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
          { type: "text", text: `\n--- Procedure ${procedureName} executed successfully ---` },
        ],
        isError: false,
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    log("error", "Error in mysql_call_procedure:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_document_procedure - Generate AI-friendly procedure docs
// ============================================================================

export async function mysqlDocumentProcedure(
  procedureName: string,
  database?: string,
  outputDir?: string,
  includeSourceSql: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{ type: "text", text: "Error: database is required when MYSQL_DB is not configured" }],
        isError: true,
      };
    }

    const routineResult = await executeQuery<any[]>(
      `SHOW CREATE PROCEDURE \`${targetDatabase}\`.\`${procedureName}\``
    );
    const routine = routineResult[0];
    const createSql = routine?.["Create Procedure"];

    if (!createSql) {
      return {
        content: [{ type: "text", text: `Error: procedure '${procedureName}' was not found in database '${targetDatabase}'` }],
        isError: true,
      };
    }

    const paramsResult = await executeQuery<any[]>(
      `SELECT
         PARAMETER_NAME as name,
         PARAMETER_MODE as mode,
         DATA_TYPE as dataType,
         DTD_IDENTIFIER as fullType,
         ORDINAL_POSITION as ordinalPosition
       FROM information_schema.PARAMETERS
       WHERE SPECIFIC_SCHEMA = ?
         AND SPECIFIC_NAME = ?
         AND ROUTINE_TYPE = 'PROCEDURE'
       ORDER BY ORDINAL_POSITION`,
      [targetDatabase, procedureName]
    );

    const metadataResult = await executeQuery<any[]>(
      `SELECT
         ROUTINE_SCHEMA as databaseName,
         ROUTINE_NAME as routineName,
         ROUTINE_COMMENT as comment,
         SECURITY_TYPE as securityType,
         IS_DETERMINISTIC as isDeterministic,
         SQL_DATA_ACCESS as sqlDataAccess,
         CREATED as createdAt,
         LAST_ALTERED as updatedAt,
         DEFINER as definer
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_NAME = ?
         AND ROUTINE_TYPE = 'PROCEDURE'`,
      [targetDatabase, procedureName]
    );

    const metadata = metadataResult[0] || {};
    const referencedTables = extractReferencedTablesFromSql(createSql, targetDatabase);
    const referencedFunctions = await extractReferencedFunctionsFromSql(
      createSql,
      targetDatabase,
      procedureName
    );
    const workflowSteps = inferProcedureWorkflow(createSql);
    const purpose = inferProcedurePurpose(
      procedureName,
      createSql,
      paramsResult,
      referencedTables
    );

    const tableDetails = await hydrateReferencedTables(referencedTables);

    const markdown = renderProcedureDocumentationMarkdown({
      database: targetDatabase,
      procedureName,
      metadata,
      purpose,
      parameters: paramsResult,
      referencedTables: tableDetails,
      referencedFunctions,
      workflowSteps,
      createSql,
      includeSourceSql,
    });

    const baseOutputDir = path.resolve(
      outputDir || process.env.MYSQL_AI_DOCS_DIR || "docs"
    );
    const proceduresDir = path.join(baseOutputDir, "procedures");
    const outputFile = path.join(proceduresDir, `${procedureName}.md`);

    fs.mkdirSync(proceduresDir, { recursive: true });
    fs.writeFileSync(outputFile, markdown, "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          database: targetDatabase,
          procedureName,
          outputFile,
          referencedTables: tableDetails.map((item) => `${item.database}.${item.table}`),
          workflowSteps: workflowSteps.length,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_document_procedure:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function mysqlDocumentFunction(
  functionName: string,
  database?: string,
  outputDir?: string,
  includeSourceSql: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{ type: "text", text: "Error: database is required when MYSQL_DB is not configured" }],
        isError: true,
      };
    }

    const functionResult = await executeQuery<any[]>(
      `SHOW CREATE FUNCTION \`${targetDatabase}\`.\`${functionName}\``
    );
    const routine = functionResult[0];
    const createSql = routine?.["Create Function"];

    if (!createSql) {
      return {
        content: [{ type: "text", text: `Error: function '${functionName}' was not found in database '${targetDatabase}'` }],
        isError: true,
      };
    }

    const paramsResult = await executeQuery<any[]>(
      `SELECT
         PARAMETER_NAME as name,
         PARAMETER_MODE as mode,
         DATA_TYPE as dataType,
         DTD_IDENTIFIER as fullType,
         ORDINAL_POSITION as ordinalPosition
       FROM information_schema.PARAMETERS
       WHERE SPECIFIC_SCHEMA = ?
         AND SPECIFIC_NAME = ?
         AND ROUTINE_TYPE = 'FUNCTION'
       ORDER BY ORDINAL_POSITION`,
      [targetDatabase, functionName]
    );

    const metadataResult = await executeQuery<any[]>(
      `SELECT
         ROUTINE_COMMENT as comment,
         SECURITY_TYPE as securityType,
         IS_DETERMINISTIC as isDeterministic,
         SQL_DATA_ACCESS as sqlDataAccess,
         DATA_TYPE as returnType,
         DTD_IDENTIFIER as fullReturnType,
         CREATED as createdAt,
         LAST_ALTERED as updatedAt,
         DEFINER as definer
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_NAME = ?
         AND ROUTINE_TYPE = 'FUNCTION'`,
      [targetDatabase, functionName]
    );

    const metadata = metadataResult[0] || {};
    const referencedTables = extractReferencedTablesFromSql(createSql, targetDatabase);
    const workflowSteps = inferProcedureWorkflow(createSql);
    const purpose = inferFunctionPurpose(functionName, createSql, referencedTables);
    const tableDetails = await hydrateReferencedTables(referencedTables);

    const markdown = renderFunctionDocumentationMarkdown({
      database: targetDatabase,
      functionName,
      metadata,
      purpose,
      parameters: paramsResult.filter((param) => param.name),
      referencedTables: tableDetails,
      workflowSteps,
      createSql,
      includeSourceSql,
    });

    const baseOutputDir = path.resolve(
      outputDir || process.env.MYSQL_AI_DOCS_DIR || "docs"
    );
    const functionsDir = path.join(baseOutputDir, "functions");
    const outputFile = path.join(functionsDir, `${functionName}.md`);

    fs.mkdirSync(functionsDir, { recursive: true });
    fs.writeFileSync(outputFile, markdown, "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          database: targetDatabase,
          functionName,
          outputFile,
          referencedTables: tableDetails.map((item) => `${item.database}.${item.table}`),
          workflowSteps: workflowSteps.length,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_document_function:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function mysqlDocumentView(
  viewName: string,
  database?: string,
  outputDir?: string,
  includeSourceSql: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{ type: "text", text: "Error: database is required when MYSQL_DB is not configured" }],
        isError: true,
      };
    }

    const viewResult = await executeQuery<any[]>(
      `SHOW CREATE VIEW \`${targetDatabase}\`.\`${viewName}\``
    );
    const viewData = viewResult[0];
    const createSql = viewData?.["Create View"];

    if (!createSql) {
      return {
        content: [{ type: "text", text: `Error: view '${viewName}' was not found in database '${targetDatabase}'` }],
        isError: true,
      };
    }

    const viewInfo = await executeQuery<any[]>(
      `SELECT
         TABLE_NAME as viewName,
         CHECK_OPTION as checkOption,
         IS_UPDATABLE as isUpdatable,
         DEFINER as definer,
         SECURITY_TYPE as securityType
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?`,
      [targetDatabase, viewName]
    );

    const columns = await executeQuery<any[]>(
      `DESCRIBE \`${targetDatabase}\`.\`${viewName}\``
    );

    const referencedTables = extractReferencedTablesFromSql(createSql, targetDatabase);
    const workflowSteps = inferProcedureWorkflow(createSql);
    const purpose = inferViewPurpose(viewName, createSql, referencedTables);
    const tableDetails = await hydrateReferencedTables(referencedTables);

    const markdown = renderViewDocumentationMarkdown({
      database: targetDatabase,
      viewName,
      metadata: viewInfo[0] || {},
      purpose,
      columns,
      referencedTables: tableDetails,
      workflowSteps,
      createSql,
      includeSourceSql,
    });

    const baseOutputDir = path.resolve(
      outputDir || process.env.MYSQL_AI_DOCS_DIR || "docs"
    );
    const viewsDir = path.join(baseOutputDir, "views");
    const outputFile = path.join(viewsDir, `${viewName}.md`);

    fs.mkdirSync(viewsDir, { recursive: true });
    fs.writeFileSync(outputFile, markdown, "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          database: targetDatabase,
          viewName,
          outputFile,
          referencedTables: tableDetails.map((item) => `${item.database}.${item.table}`),
          workflowSteps: workflowSteps.length,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_document_view:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function mysqlExportProcedureDocs(
  database?: string,
  outputDir?: string,
  includeSourceSql: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{ type: "text", text: "Error: database is required when MYSQL_DB is not configured" }],
        isError: true,
      };
    }

    const baseOutputDir = path.resolve(
      outputDir || process.env.MYSQL_AI_DOCS_DIR || "docs"
    );
    const proceduresDir = path.join(baseOutputDir, "procedures");
    fs.mkdirSync(proceduresDir, { recursive: true });

    const procedures = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME as name
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_TYPE = 'PROCEDURE'
       ORDER BY ROUTINE_NAME`,
      [targetDatabase]
    );

    const generated: string[] = [];
    const errors: string[] = [];

    for (const procedure of procedures) {
      const result = await mysqlDocumentProcedure(
        procedure.name,
        targetDatabase,
        baseOutputDir,
        includeSourceSql
      );

      if (result.isError) {
        errors.push(procedure.name);
        continue;
      }

      const payload = JSON.parse(result.content[0].text);
      generated.push(payload.outputFile);
    }

    const structureGuide = [
      "# Estructura de Documentacion de Procedures",
      "",
      "Cada archivo generado debe seguir esta estructura:",
      "",
      "1. Resumen Ejecutivo",
      "2. Parametros",
      "3. Tablas Con Las Que Interactua",
      "4. Funciones Auxiliares Utilizadas",
      "5. Analisis Paso a Paso",
      "6. Desglose Detallado de la Logica",
      "7. Diagrama de Flujo",
      "8. Notas Para Persona / IA",
      "9. SQL Fuente",
      "",
      "Regla de trabajo:",
      "",
      "- El proceso documenta un procedure completo antes de pasar al siguiente.",
      "- Cada archivo se reescribe con la version mas reciente de la documentacion.",
      "- La explicacion debe estar en espanol y orientada a entendimiento humano y de IA.",
      "",
      "Procedures generados:",
      "",
      ...generated.map((file) => `- ${file}`),
    ].join("\n");

    const structureFile = path.join(proceduresDir, "README.md");
    fs.writeFileSync(structureFile, structureGuide + "\n", "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          database: targetDatabase,
          outputDir: proceduresDir,
          generatedCount: generated.length,
          generated,
          errors,
          structureFile,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_export_procedure_docs:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function mysqlGenerateAiDocs(
  database?: string,
  outputDir?: string,
  includeSourceSql: boolean = true,
  includeDataDictionary: boolean = true
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const targetDatabase = database || process.env.MYSQL_DB;
    if (!targetDatabase) {
      return {
        content: [{ type: "text", text: "Error: database is required when MYSQL_DB is not configured" }],
        isError: true,
      };
    }

    const baseOutputDir = path.resolve(
      outputDir || process.env.MYSQL_AI_DOCS_DIR || "docs"
    );
    fs.mkdirSync(baseOutputDir, { recursive: true });

    const summary: {
      database: string;
      outputDir: string;
      generated: string[];
      errors: string[];
    } = {
      database: targetDatabase,
      outputDir: baseOutputDir,
      generated: [],
      errors: [],
    };

    if (includeDataDictionary) {
      const dictionaryResult = await mysqlDataDictionary(
        targetDatabase,
        undefined,
        "markdown",
        3
      );

      if (dictionaryResult.isError) {
        summary.errors.push("data-dictionary");
      } else {
        const dictionaryFile = path.join(baseOutputDir, "data-dictionary.md");
        fs.writeFileSync(dictionaryFile, dictionaryResult.content[0].text, "utf8");
        summary.generated.push(dictionaryFile);
      }
    }

    const procedures = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME as name
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_TYPE = 'PROCEDURE'
       ORDER BY ROUTINE_NAME`,
      [targetDatabase]
    );

    for (const procedure of procedures) {
      const result = await mysqlDocumentProcedure(
        procedure.name,
        targetDatabase,
        baseOutputDir,
        includeSourceSql
      );

      if (result.isError) {
        summary.errors.push(`procedure:${procedure.name}`);
      } else {
        const payload = JSON.parse(result.content[0].text);
        summary.generated.push(payload.outputFile);
      }
    }

    const functions = await executeQuery<any[]>(
      `SELECT ROUTINE_NAME as name
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
         AND ROUTINE_TYPE = 'FUNCTION'
       ORDER BY ROUTINE_NAME`,
      [targetDatabase]
    );

    for (const fn of functions) {
      const result = await mysqlDocumentFunction(
        fn.name,
        targetDatabase,
        baseOutputDir,
        includeSourceSql
      );

      if (result.isError) {
        summary.errors.push(`function:${fn.name}`);
      } else {
        const payload = JSON.parse(result.content[0].text);
        summary.generated.push(payload.outputFile);
      }
    }

    const views = await executeQuery<any[]>(
      `SELECT TABLE_NAME as name
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [targetDatabase]
    );

    for (const view of views) {
      const result = await mysqlDocumentView(
        view.name,
        targetDatabase,
        baseOutputDir,
        includeSourceSql
      );

      if (result.isError) {
        summary.errors.push(`view:${view.name}`);
      } else {
        const payload = JSON.parse(result.content[0].text);
        summary.generated.push(payload.outputFile);
      }
    }

    const indexLines = [
      `# AI Docs Index`,
      ``,
      `- Base de datos: \`${targetDatabase}\``,
      `- Carpeta: \`${baseOutputDir}\``,
      `- Archivos generados: ${summary.generated.length}`,
      `- Errores: ${summary.errors.length}`,
      ``,
      `## Archivos`,
      ``,
      ...summary.generated.map((file) => `- ${file}`),
    ];

    if (summary.errors.length > 0) {
      indexLines.push("");
      indexLines.push("## Errores");
      indexLines.push("");
      indexLines.push(...summary.errors.map((error) => `- ${error}`));
    }

    const indexFile = path.join(baseOutputDir, "README.md");
    fs.writeFileSync(indexFile, indexLines.join("\n") + "\n", "utf8");
    summary.generated.push(indexFile);

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_generate_ai_docs:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function hydrateReferencedTables(
  referencedTables: Array<{ database: string; table: string; operations: string[] }>
): Promise<any[]> {
  const tableDetails = [];

  for (const reference of referencedTables) {
    try {
      const columns = await executeQuery<any[]>(
        `SELECT
           COLUMN_NAME as name,
           COLUMN_TYPE as columnType,
           COLUMN_KEY as columnKey
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [reference.database, reference.table]
      );

      const sampleRows = await getTableSampleRows(reference.database, reference.table, 2);
      tableDetails.push({
        ...reference,
        columns,
        sampleRows,
      });
    } catch {
      tableDetails.push({
        ...reference,
        columns: [],
        sampleRows: [],
      });
    }
  }

  return tableDetails;
}

function extractReferencedTablesFromSql(
  sql: string,
  defaultDatabase: string
): Array<{ database: string; table: string; operations: string[] }> {
  const patterns = [
    { regex: /\bFROM\s+`?([a-zA-Z0-9_]+)`?(?:\.`?([a-zA-Z0-9_]+)`?)?/gi, operation: "SELECT" },
    { regex: /\bJOIN\s+`?([a-zA-Z0-9_]+)`?(?:\.`?([a-zA-Z0-9_]+)`?)?/gi, operation: "JOIN" },
    { regex: /\bUPDATE\s+`?([a-zA-Z0-9_]+)`?(?:\.`?([a-zA-Z0-9_]+)`?)?/gi, operation: "UPDATE" },
    { regex: /\bINSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?(?:\.`?([a-zA-Z0-9_]+)`?)?/gi, operation: "INSERT" },
    { regex: /\bDELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\.`?([a-zA-Z0-9_]+)`?)?/gi, operation: "DELETE" },
  ];

  const tableMap = new Map<string, { database: string; table: string; operations: Set<string> }>();

  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern.regex)) {
      const first = match[1];
      const second = match[2];
      const database = second ? first : defaultDatabase;
      const table = second || first;

      if (!table || ["select", "if", "case"].includes(table.toLowerCase())) {
        continue;
      }

      const key = `${database}.${table}`;
      if (!tableMap.has(key)) {
        tableMap.set(key, {
          database,
          table,
          operations: new Set<string>(),
        });
      }
      tableMap.get(key)!.operations.add(pattern.operation);
    }
  }

  return Array.from(tableMap.values()).map((item) => ({
    database: item.database,
    table: item.table,
    operations: Array.from(item.operations.values()),
  }));
}

async function extractReferencedFunctionsFromSql(
  sql: string,
  defaultDatabase: string,
  currentProcedureName?: string
): Promise<Array<{
  database: string;
  functionName: string;
  purpose: string;
  createSql: string | null;
}>> {
  const candidates = new Set<string>();
  const regex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const reservedWords = new Set([
    "if",
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "concat",
    "coalesce",
    "isnull",
    "substring",
    "now",
    "date",
    "cast",
    "convert",
    "select",
    "values",
    "exists",
    "case",
    "in",
  ]);

  for (const match of sql.matchAll(regex)) {
    const name = match[1];
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (reservedWords.has(normalized)) continue;
    if (currentProcedureName && normalized === currentProcedureName.toLowerCase()) continue;
    candidates.add(name);
  }

  const documentedFunctions = [];

  for (const candidate of candidates) {
    try {
      const routineInfo = await executeQuery<any[]>(
        `SELECT
           ROUTINE_SCHEMA as databaseName,
           ROUTINE_NAME as routineName,
           ROUTINE_COMMENT as comment
         FROM information_schema.ROUTINES
         WHERE ROUTINE_TYPE = 'FUNCTION'
           AND ROUTINE_NAME = ?
           AND ROUTINE_SCHEMA = ?`,
        [candidate, defaultDatabase]
      );

      if (!routineInfo[0]) continue;

      const createResult = await executeQuery<any[]>(
        `SHOW CREATE FUNCTION \`${defaultDatabase}\`.\`${candidate}\``
      );
      const createSql = createResult[0]?.["Create Function"] || null;

      documentedFunctions.push({
        database: defaultDatabase,
        functionName: candidate,
        purpose: inferFunctionPurpose(
          candidate,
          createSql || "",
          extractReferencedTablesFromSql(createSql || "", defaultDatabase)
        ),
        createSql,
      });
    } catch {
      continue;
    }
  }

  return documentedFunctions;
}

function inferProcedureWorkflow(sql: string): string[] {
  return sql
    .split(";")
    .map((step) => step.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((step) => !step.toUpperCase().startsWith("CREATE DEFINER"))
    .slice(0, 15);
}

function explainSqlStepInSpanish(step: string): string {
  const normalized = step.toLowerCase();

  if (normalized.startsWith("select")) return `Consulta datos para validar condiciones, buscar registros o construir el resultado que el procedimiento necesita en este punto. SQL: \`${step}\``;
  if (normalized.startsWith("insert")) return `Inserta nuevos registros, por lo que este paso genera un efecto persistente en la base de datos y puede impactar procesos posteriores. SQL: \`${step}\``;
  if (normalized.startsWith("update")) return `Actualiza registros existentes para reflejar un nuevo estado, resultado de negocio o cambio operativo. SQL: \`${step}\``;
  if (normalized.startsWith("delete")) return `Elimina registros o limpia información previa; este paso debe revisarse con cuidado por su impacto destructivo. SQL: \`${step}\``;
  if (normalized.startsWith("if")) return `Evalúa una condición de negocio para decidir si continúa por una rama, detiene el flujo o cambia el comportamiento del procedimiento. SQL: \`${step}\``;
  if (normalized.startsWith("set")) return `Asigna o recalcula variables internas que luego serán usadas en validaciones, decisiones o escritura de datos. SQL: \`${step}\``;
  if (normalized.startsWith("call")) return `Invoca otro procedimiento almacenado, por lo que este paso delega parte de la lógica y puede introducir efectos secundarios adicionales. SQL: \`${step}\``;
  if (normalized.startsWith("return")) return `Devuelve un valor o un estado final para el consumidor del procedimiento. SQL: \`${step}\``;
  if (normalized.startsWith("create")) return `Define la estructura del objeto SQL o parte de su comportamiento declarativo. SQL: \`${step}\``;

  return `Ejecuta una instrucción interna del procedimiento. Conviene revisarla dentro del contexto del paso anterior y del siguiente para entender su efecto completo. SQL: \`${step}\``;
}

function getProcedureStepLabel(step: string): string {
  const normalized = step.toLowerCase();

  if (normalized.startsWith("select")) return "Consulta";
  if (normalized.startsWith("insert")) return "Inserción";
  if (normalized.startsWith("update")) return "Actualización";
  if (normalized.startsWith("delete")) return "Eliminación";
  if (normalized.startsWith("if")) return "Decisión";
  if (normalized.startsWith("set")) return "Asignación";
  if (normalized.startsWith("call")) return "Llamada";
  if (normalized.startsWith("return")) return "Retorno";

  return "Paso";
}

function buildProcedureFlowDiagram(steps: string[]): string {
  const lines = ["flowchart TD"];

  if (steps.length === 0) {
    lines.push('  A["Inicio"] --> B["Sin pasos inferidos"]');
    return lines.join("\n");
  }

  lines.push('  A["Inicio"]');
  steps.forEach((step, index) => {
    const nodeId = `N${index + 1}`;
    const label = `${index + 1}. ${getProcedureStepLabel(step)}`;
    lines.push(`  ${nodeId}["${label}"]`);
    lines.push(index === 0 ? `  A --> ${nodeId}` : `  N${index} --> ${nodeId}`);
  });
  lines.push(`  N${steps.length} --> Z["Fin"]`);

  return lines.join("\n");
}

function buildProcedureDetailedAnalysis(steps: string[]): string[] {
  const lines: string[] = [];

  if (steps.length === 0) {
    lines.push("No se pudieron inferir etapas detalladas del procedimiento.");
    return lines;
  }

  steps.forEach((step, index) => {
    lines.push(`### Etapa ${index + 1}: ${getProcedureStepLabel(step)}`);
    lines.push("");
    lines.push(explainSqlStepInSpanish(step));
    lines.push("");
    lines.push(`SQL analizado:`);
    lines.push("```sql");
    lines.push(step);
    lines.push("```");
    lines.push("");
  });

  return lines;
}

function inferProcedurePurpose(
  procedureName: string,
  sql: string,
  parameters: any[],
  referencedTables: Array<{ table: string }>
): string {
  const lowerName = procedureName.toLowerCase();
  const lowerSql = sql.toLowerCase();
  const hints: string[] = [];

  if (lowerName.includes("login") || lowerName.includes("auth")) hints.push("gestiona autenticación o validación de acceso");
  if (lowerName.includes("create") || lowerName.includes("register")) hints.push("crea nuevos registros de negocio");
  if (lowerName.includes("update")) hints.push("actualiza registros existentes");
  if (lowerName.includes("delete") || lowerName.includes("remove")) hints.push("elimina o desactiva registros");
  if (lowerName.includes("report") || lowerName.includes("summary")) hints.push("construye un resultado de reporte o resumen");
  if (lowerName.includes("sync") || lowerName.includes("import")) hints.push("sincroniza o importa datos");

  if (lowerSql.includes("transaction")) hints.push("usa control transaccional");
  if (lowerSql.includes("password") || lowerSql.includes("token")) hints.push("toca datos sensibles de autenticación");
  if (referencedTables.length > 1) hints.push("coordina lógica sobre múltiples tablas");
  if (parameters.length > 0) hints.push(`recibe ${parameters.length} parámetros de entrada o salida`);

  return hints.length > 0
    ? hints.slice(0, 4).join("; ")
    : "encapsula lógica de negocio reutilizable en base de datos";
}

function renderProcedureDocumentationMarkdown(payload: any): string {
  const lines: string[] = [];
  const detailedAnalysis = buildProcedureDetailedAnalysis(payload.workflowSteps);
  const flowDiagram = buildProcedureFlowDiagram(payload.workflowSteps);

  lines.push(`# Procedure ${payload.procedureName}`);
  lines.push("");
  lines.push(`- Database: \`${payload.database}\``);
  lines.push(`- Purpose: ${payload.purpose}`);
  lines.push(`- Security type: ${payload.metadata.securityType || "unknown"}`);
  lines.push(`- Tipo de seguridad: ${payload.metadata.securityType || "desconocido"}`);
  lines.push(`- Acceso SQL: ${payload.metadata.sqlDataAccess || "desconocido"}`);
  lines.push(`- Determinístico: ${payload.metadata.isDeterministic || "desconocido"}`);
  if (payload.metadata.comment) {
    lines.push(`- Comentario: ${payload.metadata.comment}`);
  }
  lines.push("");

  lines.push(`## Resumen Ejecutivo`);
  lines.push("");
  lines.push(`Este procedimiento parece ${payload.purpose}. La documentación está pensada para que una persona o una IA pueda entender rápidamente qué hace, qué tablas toca y qué impacto podría tener cambiarlo.`);
  lines.push("");

  lines.push(`## Parámetros`);
  lines.push("");
  if (payload.parameters.length === 0) {
    lines.push(`Este procedimiento no declara parámetros.`);
  } else {
    lines.push(`| Nombre | Modo | Tipo | Tipo Completo |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const parameter of payload.parameters) {
      lines.push(`| \`${parameter.name || "(return)"}\` | ${parameter.mode || "IN"} | ${parameter.dataType || ""} | \`${parameter.fullType || ""}\` |`);
    }
  }
  lines.push("");

  lines.push(`## Tablas Con Las Que Interactúa`);
  lines.push("");
  if (payload.referencedTables.length === 0) {
    lines.push(`No se pudieron inferir referencias a tablas desde el cuerpo SQL.`);
  } else {
    for (const table of payload.referencedTables) {
      lines.push(`### ${table.database}.${table.table}`);
      lines.push("");
      lines.push(`- Operaciones detectadas: ${table.operations.join(", ")}`);
      lines.push(`- Columnas clave: ${table.columns.length > 0 ? table.columns.filter((column: any) => column.columnKey).map((column: any) => `\`${column.name}\``).join(", ") || "ninguna detectada" : "desconocidas"}`);
      if (table.sampleRows.length > 0) {
        lines.push(`- Filas de ejemplo:`);
        lines.push("```json");
        lines.push(JSON.stringify(table.sampleRows, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push(`## Análisis Paso a Paso`);
  lines.push("");
  if (payload.workflowSteps.length === 0) {
    lines.push(`No se pudieron inferir pasos del flujo.`);
  } else {
    payload.workflowSteps.forEach((step: string, index: number) => {
      lines.push(`${index + 1}. ${explainSqlStepInSpanish(step)}`);
    });
  }
  lines.push("");

  lines.push(`## Desglose Detallado de la Lógica`);
  lines.push("");
  lines.push(...detailedAnalysis);
  lines.push("");

  lines.push(`## Diagrama de Flujo`);
  lines.push("");
  lines.push("```mermaid");
  lines.push(flowDiagram);
  lines.push("```");
  lines.push("");

  lines.push(`## Notas Para Persona / IA`);
  lines.push("");
  lines.push(`- Revisa este procedimiento junto con las tablas referenciadas antes de cambiar lógica de aplicación.`);
  lines.push(`- Si este procedimiento participa en login o flujos críticos, revisa quién lo invoca antes de cambiar parámetros o result sets.`);
  lines.push(`- Valida efectos secundarios sobre tablas con operaciones INSERT/UPDATE/DELETE antes de desplegar cambios.`);
  lines.push("");

  if (payload.includeSourceSql) {
    lines.push(`## SQL Fuente`);
    lines.push("");
    lines.push("```sql");
    lines.push(payload.createSql);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function inferFunctionPurpose(
  functionName: string,
  sql: string,
  referencedTables: Array<{ table: string }>
): string {
  const lowerName = functionName.toLowerCase();
  const hints: string[] = [];

  if (lowerName.includes("calc") || lowerName.includes("total")) hints.push("calcula un valor derivado");
  if (lowerName.includes("get") || lowerName.includes("find")) hints.push("obtiene un valor a partir de datos existentes");
  if (lowerName.includes("validate") || lowerName.includes("check")) hints.push("valida una condición de negocio");
  if (referencedTables.length > 0) hints.push("consulta tablas para producir un resultado");
  if (sql.toLowerCase().includes("return")) hints.push("devuelve explícitamente un valor final");

  return hints.length > 0
    ? hints.slice(0, 4).join("; ")
    : "encapsula lógica reutilizable que devuelve un valor";
}

function inferViewPurpose(
  viewName: string,
  sql: string,
  referencedTables: Array<{ table: string }>
): string {
  const lowerName = viewName.toLowerCase();
  const hints: string[] = [];

  if (lowerName.includes("report") || lowerName.includes("summary")) hints.push("expone un resumen o reporte listo para consulta");
  if (lowerName.includes("detail")) hints.push("presenta una vista detallada de una entidad");
  if (lowerName.includes("active")) hints.push("filtra registros activos");
  if (referencedTables.length > 1) hints.push("consolida datos de varias tablas");
  if (sql.toLowerCase().includes("join")) hints.push("combina información mediante joins");

  return hints.length > 0
    ? hints.slice(0, 4).join("; ")
    : "presenta una proyección consultable de una o más tablas";
}

function renderFunctionDocumentationMarkdown(payload: any): string {
  const lines: string[] = [];

  lines.push(`# Function ${payload.functionName}`);
  lines.push("");
  lines.push(`- Base de datos: \`${payload.database}\``);
  lines.push(`- Propósito: ${payload.purpose}`);
  lines.push(`- Tipo de retorno: \`${payload.metadata.fullReturnType || payload.metadata.returnType || "desconocido"}\``);
  lines.push(`- Tipo de seguridad: ${payload.metadata.securityType || "desconocido"}`);
  lines.push(`- Acceso SQL: ${payload.metadata.sqlDataAccess || "desconocido"}`);
  lines.push("");

  lines.push(`## Resumen Ejecutivo`);
  lines.push("");
  lines.push(`Esta función parece ${payload.purpose}. La idea de este documento es que una persona o una IA entiendan rápidamente qué calcula, qué datos consulta y qué podría romperse si se modifica.`);
  lines.push("");

  lines.push(`## Parámetros`);
  lines.push("");
  if (payload.parameters.length === 0) {
    lines.push(`La función no declara parámetros de entrada.`);
  } else {
    lines.push(`| Nombre | Modo | Tipo | Tipo Completo |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const parameter of payload.parameters) {
      lines.push(`| \`${parameter.name}\` | ${parameter.mode || "IN"} | ${parameter.dataType || ""} | \`${parameter.fullType || ""}\` |`);
    }
  }
  lines.push("");

  lines.push(`## Tablas Referenciadas`);
  lines.push("");
  if (payload.referencedTables.length === 0) {
    lines.push(`No se detectaron tablas referenciadas.`);
  } else {
    for (const table of payload.referencedTables) {
      lines.push(`- \`${table.database}.${table.table}\` (${table.operations.join(", ")})`);
    }
  }
  lines.push("");

  lines.push(`## Funciones Auxiliares Utilizadas`);
  lines.push("");
  if (!payload.referencedFunctions || payload.referencedFunctions.length === 0) {
    lines.push(`No se detectaron funciones auxiliares referenciadas dentro del procedimiento.`);
  } else {
    for (const fn of payload.referencedFunctions) {
      lines.push(`### ${fn.database}.${fn.functionName}`);
      lines.push("");
      lines.push(`- Uso inferido: ${fn.purpose}`);
      lines.push(`- Rol dentro del procedimiento: ayuda a encapsular una parte de la lógica para reutilizar cálculos, validaciones o transformaciones sin duplicar código.`);
      if (fn.createSql) {
        lines.push(`- Definición resumida: se detectó una función almacenada que puede ser clave para entender el resultado final del procedimiento.`);
      }
      lines.push("");
    }
  }
  lines.push("");

  lines.push(`## Análisis Paso a Paso`);
  lines.push("");
  if (payload.workflowSteps.length === 0) {
    lines.push(`No se pudieron inferir pasos del flujo.`);
  } else {
    payload.workflowSteps.forEach((step: string, index: number) => {
      lines.push(`${index + 1}. ${explainSqlStepInSpanish(step)}`);
    });
  }
  lines.push("");

  if (payload.includeSourceSql) {
    lines.push(`## SQL Fuente`);
    lines.push("");
    lines.push("```sql");
    lines.push(payload.createSql);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function renderViewDocumentationMarkdown(payload: any): string {
  const lines: string[] = [];

  lines.push(`# View ${payload.viewName}`);
  lines.push("");
  lines.push(`- Base de datos: \`${payload.database}\``);
  lines.push(`- Propósito: ${payload.purpose}`);
  lines.push(`- Updatable: ${payload.metadata.isUpdatable || "desconocido"}`);
  lines.push(`- Security type: ${payload.metadata.securityType || "desconocido"}`);
  lines.push(`- Check option: ${payload.metadata.checkOption || "NONE"}`);
  lines.push("");

  lines.push(`## Resumen Ejecutivo`);
  lines.push("");
  lines.push(`Esta vista parece ${payload.purpose}. El objetivo de este documento es explicar qué proyecta, de qué tablas toma datos y cómo debería interpretarse por una persona o por otra IA.`);
  lines.push("");

  lines.push(`## Columnas Expuestas`);
  lines.push("");
  lines.push(`| Nombre | Tipo | Null | Key | Default | Extra |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const column of payload.columns) {
    lines.push(`| \`${column.Field}\` | \`${column.Type}\` | ${column.Null} | ${column.Key || ""} | ${column.Default ?? ""} | ${column.Extra || ""} |`);
  }
  lines.push("");

  lines.push(`## Tablas Fuente`);
  lines.push("");
  if (payload.referencedTables.length === 0) {
    lines.push(`No se detectaron tablas fuente.`);
  } else {
    for (const table of payload.referencedTables) {
      lines.push(`### ${table.database}.${table.table}`);
      lines.push("");
      lines.push(`- Operaciones detectadas: ${table.operations.join(", ")}`);
      if (table.sampleRows.length > 0) {
        lines.push(`- Filas de ejemplo:`);
        lines.push("```json");
        lines.push(JSON.stringify(table.sampleRows, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push(`## Análisis Paso a Paso`);
  lines.push("");
  if (payload.workflowSteps.length === 0) {
    lines.push(`No se pudieron inferir pasos del flujo.`);
  } else {
    payload.workflowSteps.forEach((step: string, index: number) => {
      lines.push(`${index + 1}. ${explainSqlStepInSpanish(step)}`);
    });
  }
  lines.push("");

  if (payload.includeSourceSql) {
    lines.push(`## SQL Fuente`);
    lines.push("");
    lines.push("```sql");
    lines.push(payload.createSql);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// TOOL: mysql_show_views - List and describe views
// ============================================================================

export async function mysqlShowViews(
  database?: string,
  viewName?: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (viewName) {
      // Get specific view details
      const fullViewName = database ? `\`${database}\`.\`${viewName}\`` : `\`${viewName}\``;
      
      const viewDef = await executeQuery<any[]>(`SHOW CREATE VIEW ${fullViewName}`);
      const viewInfo = await executeQuery<any[]>(
        `SELECT * FROM information_schema.VIEWS WHERE TABLE_NAME = ? ${database ? "AND TABLE_SCHEMA = ?" : ""}`,
        database ? [viewName, database] : [viewName]
      );

      // Get columns
      const columns = await executeQuery<any[]>(`DESCRIBE ${fullViewName}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            viewName,
            database: database || "current",
            columns,
            definition: viewDef[0]?.["Create View"] || null,
            isUpdatable: viewInfo[0]?.IS_UPDATABLE || null,
            checkOption: viewInfo[0]?.CHECK_OPTION || null,
            definer: viewInfo[0]?.DEFINER || null,
            securityType: viewInfo[0]?.SECURITY_TYPE || null,
          }, null, 2),
        }],
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
        content: [{
          type: "text",
          text: JSON.stringify({
            totalViews: views.length,
            views,
          }, null, 2),
        }],
        isError: false,
      };
    }
  } catch (error) {
    log("error", "Error in mysql_show_views:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
  value?: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (action === "set") {
      if (!variable || value === undefined) {
        return {
          content: [{ type: "text", text: "Error: Variable name and value are required for SET action" }],
          isError: true,
        };
      }

      // Validate variable name to prevent SQL injection (only alphanumeric, underscore, dot)
      if (!/^[a-zA-Z0-9_.]+$/.test(variable)) {
        return {
          content: [{ type: "text", text: "Error: Invalid variable name. Only alphanumeric characters, underscore, and dot are allowed." }],
          isError: true,
        };
      }

      // Use backticks for variable name and parameterized query for value
      const sql = `SET ${scope.toUpperCase()} \`${variable}\` = ?`;
      await executeQuery(sql, [value]);

      return {
        content: [{ type: "text", text: `Successfully set ${scope} variable '${variable}' to '${value}'` }],
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
        content: [{
          type: "text",
          text: JSON.stringify({
            scope,
            totalVariables: variables.length,
            filter: filter || "none",
            variables: filter ? variables : grouped,
          }, null, 2),
        }],
        isError: false,
      };
    }
  } catch (error) {
    log("error", "Error in mysql_variables:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_index_suggestions - Analyze and suggest indexes
// ============================================================================

export async function mysqlIndexSuggestions(
  database?: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const suggestions: any[] = [];

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
        [table.db, table.name]
      );

      if (pkCheck[0]?.hasPK === 0) {
        tableSuggestions.issues.push("⚠️ Table has no PRIMARY KEY");
        tableSuggestions.suggestions.push("Consider adding a PRIMARY KEY for better performance");
      }

      // Check for foreign key columns without indexes
      const fkColumns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table.db, table.name]
      );

      // Get existing indexes
      const indexes = await executeQuery<any[]>(
        `SELECT COLUMN_NAME FROM information_schema.STATISTICS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [table.db, table.name]
      );
      const indexedColumns = new Set(indexes.map(i => i.COLUMN_NAME));

      for (const fk of fkColumns) {
        if (!indexedColumns.has(fk.COLUMN_NAME)) {
          tableSuggestions.issues.push(`⚠️ Foreign key column '${fk.COLUMN_NAME}' is not indexed`);
          tableSuggestions.suggestions.push(`CREATE INDEX idx_${table.name}_${fk.COLUMN_NAME} ON \`${table.db}\`.\`${table.name}\`(\`${fk.COLUMN_NAME}\`);`);
        }
      }

      // Check for columns commonly used in WHERE clauses (heuristic based on naming)
      const columns = await executeQuery<any[]>(
        `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [table.db, table.name]
      );

      const commonWherePatterns = ["_id", "status", "type", "created_at", "updated_at", "email", "username", "code"];
      for (const col of columns) {
        const colLower = col.COLUMN_NAME.toLowerCase();
        if (commonWherePatterns.some(p => colLower.endsWith(p) || colLower === p)) {
          if (!indexedColumns.has(col.COLUMN_NAME)) {
            tableSuggestions.suggestions.push(
              `💡 Consider indexing '${col.COLUMN_NAME}' if used frequently in WHERE clauses`
            );
          }
        }
      }

      if (tableSuggestions.issues.length > 0 || tableSuggestions.suggestions.length > 0) {
        suggestions.push(tableSuggestions);
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          analyzedTables: tables.length,
          tablesWithSuggestions: suggestions.length,
          suggestions,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_index_suggestions:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_foreign_keys - Show foreign key relationships
// ============================================================================

export async function mysqlForeignKeys(
  database?: string,
  table?: string
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalRelationships: relationships.length,
          tables: Object.keys(graph).length,
          relationships: Object.values(graph),
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_foreign_keys:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_table_stats - Get detailed table statistics
// ============================================================================

export async function mysqlTableStats(
  database?: string,
  table?: string
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

    const stats = tables.map(t => ({
      ...t,
      dataSizeFormatted: formatSize(t.dataSize),
      indexSizeFormatted: formatSize(t.indexSize),
      freeSpaceFormatted: formatSize(t.freeSpace),
      totalSize: t.dataSize + t.indexSize,
      totalSizeFormatted: formatSize(t.dataSize + t.indexSize),
      fragmentationPercent: t.dataSize > 0 ? ((t.freeSpace / t.dataSize) * 100).toFixed(2) + "%" : "0%",
    }));

    // Calculate totals
    const totals = {
      totalTables: stats.length,
      totalRows: stats.reduce((sum, t) => sum + (t.estimatedRows || 0), 0),
      totalDataSize: formatSize(stats.reduce((sum, t) => sum + (t.dataSize || 0), 0)),
      totalIndexSize: formatSize(stats.reduce((sum, t) => sum + (t.indexSize || 0), 0)),
      totalFreeSpace: formatSize(stats.reduce((sum, t) => sum + (t.freeSpace || 0), 0)),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          summary: totals,
          tables: stats,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_table_stats:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_process_list - Show running processes/queries
// ============================================================================

export async function mysqlProcessList(
  full: boolean = false
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const sql = full ? "SHOW FULL PROCESSLIST" : "SHOW PROCESSLIST";
    const processes = await executeQuery<any[]>(sql);

    // Analyze processes
    const analysis = {
      totalProcesses: processes.length,
      activeQueries: processes.filter(p => p.Command !== "Sleep").length,
      sleepingConnections: processes.filter(p => p.Command === "Sleep").length,
      longRunning: processes.filter(p => p.Time > 30),
      byUser: {} as Record<string, number>,
      byCommand: {} as Record<string, number>,
    };

    for (const p of processes) {
      analysis.byUser[p.User] = (analysis.byUser[p.User] || 0) + 1;
      analysis.byCommand[p.Command] = (analysis.byCommand[p.Command] || 0) + 1;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          analysis,
          processes,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_process_list:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ============================================================================
// TOOL: mysql_kill_process - Kill a running process
// ============================================================================

export async function mysqlKillProcess(
  processId: number
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    // Validate processId is a positive integer
    if (!Number.isInteger(processId) || processId <= 0) {
      return {
        content: [{ type: "text", text: "Error: Process ID must be a positive integer" }],
        isError: true,
      };
    }
    
    // Use parameterized query for safety
    await executeQuery(`KILL ?`, [processId.toString()]);
    return {
      content: [{ type: "text", text: `Successfully killed process ${processId}` }],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_kill_process:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
    containsSql?: "CONTAINS SQL" | "NO SQL" | "READS SQL DATA" | "MODIFIES SQL DATA";
    sqlSecurity?: "DEFINER" | "INVOKER";
  }
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullProcName = database ? `\`${database}\`.\`${procedureName}\`` : `\`${procedureName}\``;
    
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
        chars.push(characteristics.deterministic ? "DETERMINISTIC" : "NOT DETERMINISTIC");
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
        const checkParams = database ? [database, procedureName] : [procedureName];
        const existing = await connection.query(checkQuery, checkParams);
        if (Array.isArray(existing) && existing[0] && (existing[0] as any[]).length > 0) {
          return {
            content: [{ type: "text", text: `Error: Procedure '${procedureName}' already exists. Use mysql_alter_procedure to modify it.` }],
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
          { type: "text", text: `Successfully created procedure '${procedureName}'` },
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
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
    containsSql?: "CONTAINS SQL" | "NO SQL" | "READS SQL DATA" | "MODIFIES SQL DATA";
    sqlSecurity?: "DEFINER" | "INVOKER";
  },
  ifExists?: boolean
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const fullProcName = database ? `\`${database}\`.\`${procedureName}\`` : `\`${procedureName}\``;
    
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
        chars.push(characteristics.deterministic ? "DETERMINISTIC" : "NOT DETERMINISTIC");
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
      
      // Create new procedure
      await connection.query(createSql);
      
      return {
        content: [
          { type: "text", text: `Successfully modified procedure '${procedureName}'` },
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
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
  database?: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    if (!alterStatement || alterStatement.trim().length === 0) {
      return {
        content: [{ type: "text", text: "Error: alterStatement is required and cannot be empty" }],
        isError: true,
      };
    }
    
    const fullTableName = database ? `\`${database}\`.\`${table}\`` : `\`${table}\``;
    const sql = `ALTER TABLE ${fullTableName} ${alterStatement}`;
    
    log("info", `Executing ALTER TABLE: ${sql}`);
    
    // Use executeReadOnlyQuery which will delegate to executeWriteQuery for DDL operations
    // This ensures proper permission checking
    const result = await executeReadOnlyQuery<{ content: Array<{ type: string; text: string }>; isError: boolean }>(sql);
    
    if (result.isError) {
      return result;
    }
    
    return {
      content: [
        { type: "text", text: `Successfully executed ALTER TABLE on '${table}'` },
        { type: "text", text: `\nExecuted SQL: ${sql}` },
        ...(result.content || [])
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Error in mysql_alter_table:", error);
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
    description: "Analyze SQL query execution plan using EXPLAIN/EXPLAIN ANALYZE. Use this tool to optimize slow queries, understand how MySQL executes queries, and get automatic suggestions for adding indexes or improving query structure. Returns detailed execution plan with optimization recommendations. Works with SELECT, UPDATE, DELETE, and INSERT queries.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL query to analyze (SELECT, UPDATE, DELETE, or INSERT)" },
        format: { 
          type: "string", 
          enum: ["traditional", "json", "tree"],
          description: "Output format: 'traditional' (default, human-readable table), 'json' (structured JSON), or 'tree' (hierarchical tree format)" 
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "mysql_describe",
    description: "Get comprehensive table structure information. Returns columns with data types, indexes, foreign key relationships, table statistics (row count, size, engine), and the CREATE TABLE statement. Use this tool when you need to understand a table's schema, check column types, see indexes, or analyze table structure before making changes.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to describe" },
        database: { type: "string", description: "Database name (optional, uses current database if not specified)" },
      },
      required: ["table"],
    },
  },
  {
    name: "mysql_data_dictionary",
    description: "Generate AI-friendly documentation for one table or a full database. Returns per-table columns, primary key, foreign keys, indexes, sample rows, and an inferred purpose summary. Supports JSON or Markdown output so an agent can build context quickly before writing queries or code.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to inspect. Optional if MYSQL_DB is configured." },
        table: { type: "string", description: "Specific table to document. If omitted, documents all base tables in the database." },
        format: { type: "string", enum: ["json", "markdown"], description: "Output format. Use 'json' for structured consumption or 'markdown' for readable documentation." },
        sampleRowsLimit: { type: "number", description: "How many recent sample rows to include per table. Default: 3. Use 0 to disable samples." },
      },
    },
  },
  {
    name: "mysql_backup",
    description: "Export table data to JSON or CSV format. Use this tool to backup data, export for analysis, or transfer data between systems. Supports filtering with WHERE clauses and limiting row count. Returns the exported data in the specified format.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to export data from" },
        format: { type: "string", enum: ["json", "csv"], description: "Export format: 'json' (default, structured data) or 'csv' (comma-separated values for spreadsheets)" },
        database: { type: "string", description: "Database name (optional, uses current database if not specified)" },
        whereClause: { type: "string", description: "SQL WHERE clause conditions without the 'WHERE' keyword (e.g., 'status = \"active\" AND created_at > \"2024-01-01\"')" },
        limit: { type: "number", description: "Maximum number of rows to export (useful for large tables)" },
      },
      required: ["table"],
    },
  },
  {
    name: "mysql_export_schema",
    description: "Export the schema of a MySQL database into a folder on disk. Creates a root schema.sql with database, tables, triggers, and events, plus subfolders named procedures, functions, and views with one .sql file per object. The target folder can be provided directly or taken from MYSQL_SCHEMA_EXPORT_DIR.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to export. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Absolute or relative folder path where schema.sql and the subfolders procedures/, functions/, and views/ will be created. Optional if MYSQL_SCHEMA_EXPORT_DIR is configured." },
        outputPath: { type: "string", description: "Backward-compatible alias of outputDir." },
        includeDatabaseStatement: { type: "boolean", description: "If true, includes CREATE DATABASE and USE statements at the top of the file. Default: true." },
      },
    },
  },
  {
    name: "mysql_import",
    description: "Import data from a JSON array into a table. Use this tool to bulk insert data, restore backups, or sync data. Supports three modes: 'insert' (adds new rows), 'replace' (replaces existing rows with same primary key), and 'upsert' (inserts new or updates existing based on primary key). All operations run in a transaction for data integrity.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Target table name where data will be imported" },
        data: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Array of objects to import. Each object should have keys matching table column names. Example: [{\"id\": 1, \"name\": \"John\"}, {\"id\": 2, \"name\": \"Jane\"}]",
        },
        database: { type: "string", description: "Database name (optional, uses current database if not specified)" },
        mode: { 
          type: "string", 
          enum: ["insert", "replace", "upsert"],
          description: "Import mode: 'insert' (default, adds new rows only), 'replace' (replaces existing rows with same primary/unique key), 'upsert' (inserts new rows or updates existing ones using ON DUPLICATE KEY UPDATE)" 
        },
      },
      required: ["table", "data"],
    },
  },
  {
    name: "mysql_compare_schemas",
    description: "Compare the structure (schema) between two databases and identify differences. Use this tool to find missing tables, different column definitions, or schema drift between environments (dev vs prod, staging vs production, etc.). Returns detailed comparison showing tables only in source, tables only in target, and column differences in common tables.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDb: { type: "string", description: "Source database name (the reference schema to compare FROM)" },
        targetDb: { type: "string", description: "Target database name (the schema to compare TO)" },
      },
      required: ["sourceDb", "targetDb"],
    },
  },
  {
    name: "mysql_generate_migration",
    description: "Generate a SQL migration script to synchronize two database schemas. Use this after mysql_compare_schemas to create ALTER TABLE statements that will make the target database match the source. The generated script includes CREATE TABLE for missing tables, ALTER TABLE for column changes, and commented DROP statements for safety. Review the script carefully before executing.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDb: { type: "string", description: "Source database name (the reference schema to migrate FROM - this is the desired state)" },
        targetDb: { type: "string", description: "Target database name (the schema to migrate TO - this will be modified to match source)" },
      },
      required: ["sourceDb", "targetDb"],
    },
  },
  {
    name: "mysql_query_history",
    description: "View or clear the history of executed queries in the current session. Use this tool to review what queries have been run, check execution times, see which queries failed, or debug issues. The history includes SQL statements, execution duration, row counts, and success/failure status. History is stored in-memory and cleared when the session ends.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of most recent queries to return (default: 50, maximum: 100)" },
        clear: { type: "boolean", description: "If true, clears the entire query history instead of returning it" },
      },
    },
  },
  {
    name: "mysql_call_procedure",
    description: "Execute a MySQL stored procedure using the CALL statement. Use this tool to run stored procedures that encapsulate business logic, perform complex operations, or return result sets. Parameters are passed as an array in the order defined by the procedure. Returns the procedure's result set or output parameters.",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: { type: "string", description: "Name of the stored procedure to execute" },
        params: {
          type: "array",
          items: {},
          description: "Array of parameter values in the order defined by the procedure. Can contain strings, numbers, booleans, or null. Example: [\"value1\", 123, true]",
        },
        database: { type: "string", description: "Database name where the procedure exists (optional, uses current database if not specified)" },
      },
      required: ["procedureName"],
    },
  },
  {
    name: "mysql_document_procedure",
    description: "Genera un documento Markdown profesional en espanol para un stored procedure y lo guarda en disco. Incluye proposito inferido, parametros, tablas relacionadas, filas de ejemplo, analisis paso a paso y opcionalmente el SQL fuente. Es util para que una persona o una IA entiendan rapido la logica del procedimiento.",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: { type: "string", description: "Stored procedure name to document." },
        database: { type: "string", description: "Database where the procedure exists. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Base output directory. Defaults to MYSQL_AI_DOCS_DIR or ./docs." },
        includeSourceSql: { type: "boolean", description: "If true, includes the CREATE PROCEDURE SQL in the generated Markdown. Default: true." },
      },
      required: ["procedureName"],
    },
  },
  {
    name: "mysql_document_function",
    description: "Genera un documento Markdown profesional en espanol para una function de MySQL y lo guarda en disco. Incluye proposito inferido, parametros, tipo de retorno, tablas consultadas, analisis paso a paso y SQL fuente opcional.",
    inputSchema: {
      type: "object",
      properties: {
        functionName: { type: "string", description: "Function name to document." },
        database: { type: "string", description: "Database where the function exists. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Base output directory. Defaults to MYSQL_AI_DOCS_DIR or ./docs." },
        includeSourceSql: { type: "boolean", description: "If true, includes the CREATE FUNCTION SQL in the generated Markdown. Default: true." },
      },
      required: ["functionName"],
    },
  },
  {
    name: "mysql_document_view",
    description: "Genera un documento Markdown profesional en espanol para una view y lo guarda en disco. Incluye columnas expuestas, tablas fuente, filas de ejemplo, proposito inferido, analisis paso a paso y SQL fuente opcional.",
    inputSchema: {
      type: "object",
      properties: {
        viewName: { type: "string", description: "View name to document." },
        database: { type: "string", description: "Database where the view exists. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Base output directory. Defaults to MYSQL_AI_DOCS_DIR or ./docs." },
        includeSourceSql: { type: "boolean", description: "If true, includes the CREATE VIEW SQL in the generated Markdown. Default: true." },
      },
      required: ["viewName"],
    },
  },
  {
    name: "mysql_export_procedure_docs",
    description: "Exporta la documentacion Markdown de todos los stored procedures de una base de datos. Procesa cada SP uno por uno, termina su archivo antes de pasar al siguiente, reescribe el .md con la version actualizada y deja un README dentro de procedures/ explicando la estructura usada para documentar.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to document. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Base output directory. Defaults to MYSQL_AI_DOCS_DIR or ./docs." },
        includeSourceSql: { type: "boolean", description: "If true, includes source SQL in each generated procedure Markdown. Default: true." },
      },
    },
  },
  {
    name: "mysql_generate_ai_docs",
    description: "Genera documentacion completa de una base de datos en forma secuencial. Primero puede crear el data dictionary y luego documenta procedures, functions y views uno por uno, terminando cada archivo detallado antes de pasar al siguiente. Guarda todo en disco y crea un README indice con el resumen.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to document. Optional if MYSQL_DB is configured." },
        outputDir: { type: "string", description: "Base output directory. Defaults to MYSQL_AI_DOCS_DIR or ./docs." },
        includeSourceSql: { type: "boolean", description: "If true, includes source SQL in generated Markdown files. Default: true." },
        includeDataDictionary: { type: "boolean", description: "If true, generates data-dictionary.md before documenting routines and views. Default: true." },
      },
    },
  },
  {
    name: "mysql_show_views",
    description: "List all database views or get detailed information about a specific view. Use this tool to discover available views, understand view definitions, check if views are updatable, or see view metadata. Views are virtual tables based on SELECT queries. If viewName is provided, returns detailed view structure including columns and definition.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to search views in (optional, searches all databases if not specified)" },
        viewName: { type: "string", description: "Specific view name to get detailed information for (optional, if omitted returns list of all views)" },
      },
    },
  },
  {
    name: "mysql_variables",
    description: "Show or set MySQL server configuration variables. Use this tool to check current MySQL settings (like max_connections, innodb_buffer_pool_size, etc.) or modify session/global variables. 'session' variables affect only the current connection, 'global' variables affect all new connections. Use 'filter' to search for specific variables by name pattern.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "set"], description: "Action to perform: 'show' (default, displays variables) or 'set' (modifies a variable value)" },
        scope: { type: "string", enum: ["global", "session"], description: "Variable scope: 'session' (default, affects current connection only) or 'global' (affects all new connections, requires SUPER privilege)" },
        filter: { type: "string", description: "Filter variables by name pattern (e.g., 'max_conn' to find max_connections, max_connect_errors, etc.)" },
        variable: { type: "string", description: "Variable name to set (required when action='set', e.g., 'max_connections', 'innodb_buffer_pool_size')" },
        value: { type: "string", description: "New value for the variable (required when action='set', must be a valid value for that variable type)" },
      },
    },
  },
  {
    name: "mysql_index_suggestions",
    description: "Analyze database tables and automatically suggest missing indexes for query optimization. Use this tool to identify performance issues like tables without primary keys, foreign key columns without indexes, or commonly queried columns that should be indexed. Returns actionable suggestions with CREATE INDEX statements ready to execute.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to analyze (optional, analyzes all databases if not specified)" },
      },
    },
  },
  {
    name: "mysql_foreign_keys",
    description: "Show foreign key relationships between tables. Use this tool to understand database relationships, see which tables reference each other, check referential integrity constraints, or map out the database schema structure. Returns a relationship graph showing which tables reference others and which are referenced by others, including ON UPDATE and ON DELETE rules.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to search in (optional, searches all databases if not specified)" },
        table: { type: "string", description: "Specific table name to show relationships for (optional, if omitted shows all foreign key relationships)" },
      },
    },
  },
  {
    name: "mysql_table_stats",
    description: "Get detailed statistics and metrics for database tables. Use this tool to monitor table sizes, row counts, fragmentation levels, storage engine information, and identify tables that may need optimization or maintenance. Returns formatted sizes (KB, MB, GB), fragmentation percentages, and summary totals. Useful for capacity planning and performance monitoring.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name to analyze (optional, analyzes all databases if not specified)" },
        table: { type: "string", description: "Specific table name to get statistics for (optional, if omitted returns stats for all tables)" },
      },
    },
  },
  {
    name: "mysql_process_list",
    description: "Show currently running MySQL processes and active queries. Use this tool to monitor database activity, identify long-running queries, see which users are connected, check query execution times, or diagnose performance issues. Returns process list with analysis including active queries count, sleeping connections, and queries grouped by user/command.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "If true, shows full query text (default: false, shows truncated queries for readability)" },
      },
    },
  },
  {
    name: "mysql_kill_process",
    description: "Terminate a running MySQL process/query by its process ID. Use this tool to stop long-running queries, kill stuck connections, or free up resources. First use mysql_process_list to find the process ID, then use this tool to kill it. WARNING: This will immediately terminate the query/connection.",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "number", description: "Process ID to kill (get this from mysql_process_list output, must be a positive integer)" },
      },
      required: ["processId"],
    },
  },
  {
    name: "mysql_create_procedure",
    description: "Create a new MySQL stored procedure. Use this tool to encapsulate business logic, create reusable database functions, or implement complex operations. Stored procedures can accept IN/OUT/INOUT parameters and return result sets. The procedure body contains SQL statements wrapped in BEGIN...END. Returns an error if the procedure already exists (use mysql_alter_procedure to modify existing procedures).",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: { type: "string", description: "Name of the procedure to create (must be unique in the database)" },
        procedureBody: { type: "string", description: "SQL statements inside BEGIN...END block. Example: 'SELECT * FROM users WHERE id = user_id; SELECT COUNT(*) INTO total FROM orders;'" },
        database: { type: "string", description: "Database name where to create the procedure (optional, uses current database if not specified)" },
        parameters: { type: "string", description: "Procedure parameters definition. Example: 'IN user_id INT, OUT total INT, INOUT counter INT'. Use IN for input, OUT for output, INOUT for both." },
        characteristics: {
          type: "object",
          description: "Optional procedure characteristics for security and optimization",
          properties: {
            comment: { type: "string", description: "Documentation comment describing what the procedure does" },
            language: { type: "string", enum: ["SQL"], description: "Programming language (default: SQL)" },
            deterministic: { type: "boolean", description: "Whether the procedure always returns the same result for the same inputs (affects caching)" },
            containsSql: {
              type: "string",
              enum: ["CONTAINS SQL", "NO SQL", "READS SQL DATA", "MODIFIES SQL DATA"],
              description: "SQL data access level: 'CONTAINS SQL' (default, may read/write), 'NO SQL' (no SQL), 'READS SQL DATA' (read-only), 'MODIFIES SQL DATA' (may modify data)"
            },
            sqlSecurity: { type: "string", enum: ["DEFINER", "INVOKER"], description: "Security context: 'DEFINER' (runs with creator's privileges) or 'INVOKER' (runs with caller's privileges)" },
          },
        },
      },
      required: ["procedureName", "procedureBody"],
    },
  },
  {
    name: "mysql_alter_procedure",
    description: "Modify an existing stored procedure by dropping and recreating it. Use this tool to update procedure logic, change parameters, or modify characteristics. MySQL doesn't support ALTER PROCEDURE directly, so this tool performs DROP + CREATE. Set ifExists=true to avoid errors if the procedure doesn't exist. WARNING: This will temporarily remove the procedure during recreation.",
    inputSchema: {
      type: "object",
      properties: {
        procedureName: { type: "string", description: "Name of the existing procedure to modify" },
        procedureBody: { type: "string", description: "Updated SQL statements inside BEGIN...END block" },
        database: { type: "string", description: "Database name where the procedure exists (optional, uses current database if not specified)" },
        parameters: { type: "string", description: "Updated procedure parameters. Example: 'IN param1 INT, OUT param2 VARCHAR(100)'. Can be different from original." },
        characteristics: {
          type: "object",
          description: "Updated procedure characteristics",
          properties: {
            comment: { type: "string", description: "Updated documentation comment" },
            language: { type: "string", enum: ["SQL"], description: "Programming language (default: SQL)" },
            deterministic: { type: "boolean", description: "Updated determinism setting" },
            containsSql: {
              type: "string",
              enum: ["CONTAINS SQL", "NO SQL", "READS SQL DATA", "MODIFIES SQL DATA"],
              description: "Updated SQL data access level"
            },
            sqlSecurity: { type: "string", enum: ["DEFINER", "INVOKER"], description: "Updated security context" },
          },
        },
        ifExists: { type: "boolean", description: "If true, uses 'DROP PROCEDURE IF EXISTS' to avoid errors if procedure doesn't exist (default: false)" },
      },
      required: ["procedureName", "procedureBody"],
    },
  },
  {
    name: "mysql_alter_table",
    description: "Execute ALTER TABLE operations to modify table structure. Use this tool to add/modify/drop columns, add/remove indexes, change data types, modify constraints, or rename tables. Supports all MySQL ALTER TABLE operations. The alterStatement should contain the operation without the 'ALTER TABLE table_name' prefix. Returns the executed SQL for verification.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to modify" },
        alterStatement: { type: "string", description: "ALTER TABLE operation statement (without 'ALTER TABLE table_name' prefix). Examples: 'ADD COLUMN name VARCHAR(100) NOT NULL', 'MODIFY COLUMN id INT AUTO_INCREMENT', 'DROP COLUMN old_column', 'ADD INDEX idx_name (name)', 'ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)', 'RENAME TO new_table_name'" },
        database: { type: "string", description: "Database name where the table exists (optional, uses current database if not specified)" },
      },
      required: ["table", "alterStatement"],
    },
  },
];

// Handler function to route tool calls
export async function handleAdditionalTool(
  toolName: string,
  args: Record<string, any>
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean } | null> {
  switch (toolName) {
    case "mysql_explain":
      return mysqlExplain(args.sql, args.format);
    
    case "mysql_describe":
      return mysqlDescribe(args.table, args.database);

    case "mysql_data_dictionary":
      return mysqlDataDictionary(
        args.database,
        args.table,
        args.format,
        args.sampleRowsLimit
      );
    
    case "mysql_backup":
      return mysqlBackup(args.table, args.format, args.database, args.whereClause, args.limit);

    case "mysql_export_schema":
      return mysqlExportSchema(
        args.database,
        args.outputDir || args.outputPath,
        args.includeDatabaseStatement
      );
    
    case "mysql_import":
      return mysqlImport(args.table, args.data, args.database, args.mode);
    
    case "mysql_compare_schemas":
      return mysqlCompareSchemas(args.sourceDb, args.targetDb);
    
    case "mysql_generate_migration":
      return mysqlGenerateMigration(args.sourceDb, args.targetDb);
    
    case "mysql_query_history":
      if (args.clear) {
        clearQueryHistory();
        return { content: [{ type: "text", text: "Query history cleared" }], isError: false };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(getQueryHistory(args.limit), null, 2) }],
        isError: false,
      };
    
    case "mysql_call_procedure":
      return mysqlCallProcedure(args.procedureName, args.params || [], args.database);

    case "mysql_document_procedure":
      return mysqlDocumentProcedure(
        args.procedureName,
        args.database,
        args.outputDir,
        args.includeSourceSql
      );

    case "mysql_document_function":
      return mysqlDocumentFunction(
        args.functionName,
        args.database,
        args.outputDir,
        args.includeSourceSql
      );

    case "mysql_document_view":
      return mysqlDocumentView(
        args.viewName,
        args.database,
        args.outputDir,
        args.includeSourceSql
      );

    case "mysql_export_procedure_docs":
      return mysqlExportProcedureDocs(
        args.database,
        args.outputDir,
        args.includeSourceSql
      );

    case "mysql_generate_ai_docs":
      return mysqlGenerateAiDocs(
        args.database,
        args.outputDir,
        args.includeSourceSql,
        args.includeDataDictionary
      );
    
    case "mysql_show_views":
      return mysqlShowViews(args.database, args.viewName);
    
    case "mysql_variables":
      return mysqlVariables(args.action, args.scope, args.filter, args.variable, args.value);
    
    case "mysql_index_suggestions":
      return mysqlIndexSuggestions(args.database);
    
    case "mysql_foreign_keys":
      return mysqlForeignKeys(args.database, args.table);
    
    case "mysql_table_stats":
      return mysqlTableStats(args.database, args.table);
    
    case "mysql_process_list":
      return mysqlProcessList(args.full);
    
    case "mysql_kill_process":
      return mysqlKillProcess(args.processId);
    
    case "mysql_create_procedure":
      return mysqlCreateProcedure(
        args.procedureName,
        args.procedureBody,
        args.database,
        args.parameters,
        args.characteristics
      );
    
    case "mysql_alter_procedure":
      return mysqlAlterProcedure(
        args.procedureName,
        args.procedureBody,
        args.database,
        args.parameters,
        args.characteristics,
        args.ifExists
      );
    
    case "mysql_alter_table":
      return mysqlAlterTable(args.table, args.alterStatement, args.database);
    
    default:
      return null; // Tool not handled here
  }
}
