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
    
    case "mysql_backup":
      return mysqlBackup(args.table, args.format, args.database, args.whereClause, args.limit);
    
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
