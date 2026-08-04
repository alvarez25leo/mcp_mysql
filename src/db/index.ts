import { isMultiDbMode } from "./../config/index.js";

import {
  isDDLAllowedForSchema,
  isInsertAllowedForSchema,
  isUpdateAllowedForSchema,
  isDeleteAllowedForSchema,
} from "./permissions.js";
import {
  extractSchemaFromQuery,
  getQueryTypes,
  detectFullTableWrites,
} from "./utils.js";

import * as mysql2 from "mysql2/promise";
import { log, formatMysqlError, describeMysqlError } from "./../utils/index.js";

// mysql2 numeric field type codes → readable names, used to expose column
// metadata so the model knows how to interpret each value (e.g. DECIMAL
// arrives as string, DATETIME as Date/string).
const MYSQL_FIELD_TYPES: Record<number, string> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  6: "NULL",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINYBLOB",
  250: "MEDIUMBLOB",
  251: "LONGBLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "CHAR",
  255: "GEOMETRY",
};

function describeFields(
  fields: mysql2.FieldPacket[] | undefined,
): Array<{ name: string; type: string }> | undefined {
  if (!Array.isArray(fields) || fields.length === 0) {
    return undefined;
  }
  return fields.map((field) => ({
    name: field.name,
    type: MYSQL_FIELD_TYPES[field.type as number] || `TYPE_${field.type}`,
  }));
}
import {
  mcpConfig as config,
  MYSQL_DISABLE_READ_ONLY_TRANSACTIONS,
  MULTI_DB_WRITE_MODE,
} from "./../config/index.js";

// Force read-only mode in multi-DB mode unless explicitly configured otherwise
if (isMultiDbMode && !MULTI_DB_WRITE_MODE) {
  log("error", "Multi-DB mode detected - enabling read-only mode for safety");
}

// @INFO: Check if running in test mode
const isTestEnvironment = process.env.NODE_ENV === "test" || process.env.VITEST;

// @INFO: Safe way to exit process (not during tests)
function safeExit(code: number): void {
  if (!isTestEnvironment) {
    process.exit(code);
  } else {
    log("error", `[Test mode] Would have called process.exit(${code})`);
  }
}

// @INFO: Lazy load MySQL pool
let poolPromise: Promise<mysql2.Pool> | null = null;
let poolInstance: mysql2.Pool | null = null;
let keepAliveInterval: NodeJS.Timeout | null = null;

// Function to create a new pool
const createPool = (): mysql2.Pool => {
  const poolConfig = {
    ...config.mysql,
  };

  const pool = mysql2.createPool(poolConfig);
  
  // Handle pool errors - use type assertion for event handler
  (pool as any).on('error', (err: Error) => {
    log("error", "MySQL pool error:", err);
    // If it's a connection error, reset the pool
    if (err.message.includes('Connection lost') || err.message.includes('timeout')) {
      log("error", "Connection lost detected, pool will be recreated on next use");
      poolInstance = null;
      poolPromise = null;
    }
  });

  log("info", "MySQL pool created successfully");
  return pool;
};

const getPool = async (): Promise<mysql2.Pool> => {
  // If pool instance exists and is still valid, return it
  if (poolInstance) {
    try {
      // Test if pool is still alive
      const testConnection = await poolInstance.getConnection();
      testConnection.release();
      return poolInstance;
    } catch (error) {
      log("info", "Pool connection test failed, recreating pool");
      poolInstance = null;
      poolPromise = null;
    }
  }

  if (!poolPromise) {
    poolPromise = new Promise<mysql2.Pool>((resolve, reject) => {
      try {
        poolInstance = createPool();
        resolve(poolInstance);
      } catch (error) {
        log("error", "Error creating MySQL pool:", error);
        poolInstance = null;
        poolPromise = null;
        reject(error);
      }
    });
  }
  
  return poolPromise;
};

// Keep-alive function to maintain connections
const startKeepAlive = () => {
  // Clear existing interval if any
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  // Run keep-alive every 5 minutes (300000 ms)
  const keepAliveIntervalMs = process.env.MYSQL_KEEP_ALIVE_INTERVAL 
    ? parseInt(process.env.MYSQL_KEEP_ALIVE_INTERVAL, 10) 
    : 300000; // 5 minutes default

  keepAliveInterval = setInterval(async () => {
    try {
      const pool = await getPool();
      const connection = await pool.getConnection();
      try {
        // Simple query to keep connection alive
        await connection.query('SELECT 1');
        log("info", "Keep-alive query executed successfully");
      } finally {
        connection.release();
      }
    } catch (error) {
      log("error", "Keep-alive query failed:", error);
      // Reset pool on keep-alive failure
      poolInstance = null;
      poolPromise = null;
    }
  }, keepAliveIntervalMs);

  log("info", `Keep-alive started with interval: ${keepAliveIntervalMs}ms`);
};

// Start keep-alive when module loads
if (!isTestEnvironment) {
  // Delay start to allow pool to initialize
  setTimeout(() => {
    startKeepAlive();
  }, 10000); // Start after 10 seconds
}

/**
 * Run a query with a hard timeout. On expiry the running statement is
 * aborted with KILL QUERY from a second connection (engine-agnostic: works
 * on MySQL and MariaDB); if the statement cannot be interrupted within a
 * grace period, the connection socket is destroyed as a last resort so the
 * agent is never left hanging.
 */
function queryWithTimeout(
  connection: mysql2.PoolConnection,
  sql: string,
  params: any[],
  timeoutMs?: number,
): Promise<any> {
  if (!timeoutMs || timeoutMs <= 0) {
    return connection.query(sql, params);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    const timeoutError = () =>
      new Error(
        `Query cancelada por timeout (${timeoutMs} ms). La sentencia fue interrumpida con KILL QUERY; ajusta timeoutMs si necesitas más tiempo.`,
      );

    const killTimer = setTimeout(async () => {
      timedOut = true;
      const threadId = (connection as any).threadId;
      if (threadId) {
        try {
          const pool = await getPool();
          await pool.query(`KILL QUERY ${Number(threadId)}`);
          log("info", `Timeout: issued KILL QUERY ${threadId} after ${timeoutMs}ms`);
        } catch (killError) {
          log("error", "Failed to KILL timed-out query:", killError);
        }
      }
      // Last resort if the statement is not interruptible
      const hardTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            connection.destroy();
          } catch {
            // ignore
          }
          reject(timeoutError());
        }
      }, 5000);
      (hardTimer as any).unref?.();
    }, timeoutMs);

    connection
      .query(sql, params)
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(killTimer);
          resolve(result);
        }
      })
      .catch((error: any) => {
        if (!settled) {
          settled = true;
          clearTimeout(killTimer);
          const interrupted =
            timedOut &&
            (error?.errno === 1317 || // ER_QUERY_INTERRUPTED
              error?.errno === 3024 || // ER_QUERY_TIMEOUT
              error?.code === "ER_QUERY_INTERRUPTED");
          reject(interrupted ? timeoutError() : error);
        }
      });
  });
}

async function executeQuery<T>(sql: string, params: string[] = []): Promise<T> {
  let connection;
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const pool = await getPool();
      connection = await pool.getConnection();
      const result = await connection.query(sql, params);
      return (Array.isArray(result) ? result[0] : result) as T;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("error", `Error executing query (attempt ${retries + 1}/${maxRetries}):`, errorMessage);
      
      // Check if it's a connection error
      if (errorMessage.includes('Connection lost') || 
          errorMessage.includes('timeout') || 
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('PROTOCOL_CONNECTION_LOST')) {
        retries++;
        if (retries < maxRetries) {
          log("info", `Connection error detected, retrying... (${retries}/${maxRetries})`);
          // Reset pool to force reconnection
          poolInstance = null;
          poolPromise = null;
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          continue;
        }
      }
      
      // If not a connection error or max retries reached, throw
      throw error;
    } finally {
      if (connection) {
        connection.release();
        log("info", "Connection released");
      }
    }
  }
  
  throw new Error("Max retries reached for query execution");
}

// @INFO: New function to handle write operations. With dryRun=true the
// statement runs inside the transaction and is rolled back instead of
// committed, so the model can verify affected rows before applying a write.
async function executeWriteQuery<T>(
  sql: string,
  params: any[] = [],
  dryRun: boolean = false,
  timeoutMs?: number,
): Promise<T> {
  let connection;
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const pool = await getPool();
      connection = await pool.getConnection();
      log("info", "Write connection acquired");
      break; // Success, exit retry loop
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Connection lost') || 
          errorMessage.includes('timeout') || 
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('PROTOCOL_CONNECTION_LOST')) {
        retries++;
        if (retries < maxRetries) {
          log("info", `Connection error, retrying... (${retries}/${maxRetries})`);
          poolInstance = null;
          poolPromise = null;
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          continue;
        }
      }
      throw error;
    }
  }

  if (!connection) {
    throw new Error("Failed to acquire connection after retries");
  }

  try {

    // Extract schema for permissions (if needed)
    const schema = extractSchemaFromQuery(sql);

    // @INFO: Begin transaction for write operation
    await connection.beginTransaction();

    try {
      // @INFO: Execute the write query
      const startTime = performance.now();
      const result = await queryWithTimeout(connection, sql, params, timeoutMs);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const response = Array.isArray(result) ? result[0] : result;

      // @INFO: Commit the transaction (or roll back in dry-run mode)
      if (dryRun) {
        await connection.rollback();
      } else {
        await connection.commit();
      }

      // @INFO: Format the response based on operation type
      let responseText;

      // Check the type of query
      const queryTypes = await getQueryTypes(sql);
      const isUpdateOperation = queryTypes.some((type) =>
        ["update"].includes(type),
      );
      const isInsertOperation = queryTypes.some((type) =>
        ["insert"].includes(type),
      );
      const isDeleteOperation = queryTypes.some((type) =>
        ["delete"].includes(type),
      );
      const isDDLOperation = queryTypes.some((type) =>
        ["create", "alter", "drop", "truncate"].includes(type),
      );

      // @INFO: Type assertion for ResultSetHeader which has affectedRows, insertId, etc.
      let structured: Record<string, unknown> | undefined;
      if (isInsertOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Insert successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Last insert ID: ${resultHeader.insertId}`;
        structured = {
          operation: "insert",
          schema: schema || null,
          affectedRows: resultHeader.affectedRows,
          insertId: resultHeader.insertId,
          durationMs: Number(duration.toFixed(2)),
        };
      } else if (isUpdateOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Update successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Changed rows: ${resultHeader.changedRows || 0}`;
        structured = {
          operation: "update",
          schema: schema || null,
          affectedRows: resultHeader.affectedRows,
          changedRows: resultHeader.changedRows || 0,
          durationMs: Number(duration.toFixed(2)),
        };
      } else if (isDeleteOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Delete successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}`;
        structured = {
          operation: "delete",
          schema: schema || null,
          affectedRows: resultHeader.affectedRows,
          durationMs: Number(duration.toFixed(2)),
        };
      } else if (isDDLOperation) {
        responseText = `DDL operation successful on schema '${schema || "default"}'.`;
        structured = {
          operation: "ddl",
          schema: schema || null,
          durationMs: Number(duration.toFixed(2)),
        };
      } else {
        responseText = JSON.stringify(response, null, 2);
        structured = {
          operation: "other",
          result: response,
          durationMs: Number(duration.toFixed(2)),
        };
      }

      if (dryRun && structured) {
        structured.dryRun = true;
        responseText = `[DRY RUN — rolled back, no changes applied]\n${responseText}`;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
          {
            type: "text",
            text: `Query execution time: ${duration.toFixed(2)} ms`,
          },
        ],
        structured,
        isError: false,
      } as T;
    } catch (error: unknown) {
      // @INFO: Rollback on error
      log("error", "Error executing write query:", error);
      await connection.rollback();

      return {
        content: [
          {
            type: "text",
            text: `Error executing write operation: ${formatMysqlError(error)}`,
          },
        ],
        structured: { error: describeMysqlError(error) },
        isError: true,
      } as T;
    }
  } catch (error: unknown) {
    log("error", "Error in write operation transaction:", error);
    return {
      content: [
        {
          type: "text",
          text: `Database connection error: ${formatMysqlError(error)}`,
        },
      ],
      structured: { error: describeMysqlError(error) },
      isError: true,
    } as T;
  } finally {
    if (connection) {
      connection.release();
      log("info", "Write connection released");
    }
  }
}

async function executeReadOnlyQuery<T>(
  sql: string,
  options: {
    maxRows?: number;
    params?: any[];
    allowFullTableWrite?: boolean;
    dryRun?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  let connection: mysql2.PoolConnection | undefined;
  try {
    // Check the type of query
    const queryTypes = await getQueryTypes(sql);

    // Get schema for permission checking
    const schema = extractSchemaFromQuery(sql);

    const isUpdateOperation = queryTypes.some((type) =>
      ["update"].includes(type),
    );
    const isInsertOperation = queryTypes.some((type) =>
      ["insert"].includes(type),
    );
    const isDeleteOperation = queryTypes.some((type) =>
      ["delete"].includes(type),
    );
    const isDDLOperation = queryTypes.some((type) =>
      ["create", "alter", "drop", "truncate"].includes(type),
    );
    const isWriteOperation =
      isUpdateOperation || isInsertOperation || isDeleteOperation || isDDLOperation;

    // Enforce read-only in multi-DB mode: without MULTI_DB_WRITE_MODE=true no
    // write reaches per-schema permission checks at all.
    if (isWriteOperation && isMultiDbMode && !MULTI_DB_WRITE_MODE) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Write operations are disabled in multi-DB mode. Set MULTI_DB_WRITE_MODE=true to enable them.",
          },
        ],
        isError: true,
      } as T;
    }

    // Check schema-specific permissions
    if (isInsertOperation && !isInsertAllowedForSchema(schema)) {
      log(
        "error",
        `INSERT operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_INSERT_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: INSERT operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_INSERT_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isUpdateOperation && !isUpdateAllowedForSchema(schema)) {
      log(
        "error",
        `UPDATE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_UPDATE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: UPDATE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_UPDATE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDeleteOperation && !isDeleteAllowedForSchema(schema)) {
      log(
        "error",
        `DELETE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DELETE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DELETE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DELETE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDDLOperation && !isDDLAllowedForSchema(schema)) {
      log(
        "error",
        `DDL operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DDL_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DDL operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DDL_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    // Guard: UPDATE/DELETE without WHERE touches the whole table. Require an
    // explicit opt-in so the model cannot wipe a table by accident.
    if (
      (isUpdateOperation || isDeleteOperation) &&
      !options.allowFullTableWrite
    ) {
      const offenders = detectFullTableWrites(sql);
      if (offenders.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: ${offenders.join("/").toUpperCase()} sin cláusula WHERE afectaría a TODA la tabla. ` +
                `Añade un WHERE, o si realmente quieres modificar todas las filas, repite la llamada con allowFullTableWrite: true. ` +
                `También puedes previsualizar el alcance con dryRun: true.`,
            },
          ],
          structured: {
            error: {
              code: "FULL_TABLE_WRITE_BLOCKED",
              message: "Write without WHERE clause blocked",
              hint: "Add a WHERE clause or pass allowFullTableWrite: true. Use dryRun: true to preview affected rows.",
            },
          },
          isError: true,
        } as T;
      }
    }

    // For write operations that are allowed, use executeWriteQuery
    if (
      (isInsertOperation && isInsertAllowedForSchema(schema)) ||
      (isUpdateOperation && isUpdateAllowedForSchema(schema)) ||
      (isDeleteOperation && isDeleteAllowedForSchema(schema)) ||
      (isDDLOperation && isDDLAllowedForSchema(schema))
    ) {
      return executeWriteQuery(
        sql,
        options.params ?? [],
        options.dryRun ?? false,
        options.timeoutMs,
      );
    }

    // For read-only operations, continue with the original logic
    let retries = 0;
    const maxRetries = 3;
    let pool: mysql2.Pool | undefined;
    let connectionAcquired = false;

    while (retries < maxRetries && !connectionAcquired) {
      try {
        pool = await getPool();
        connection = await pool.getConnection();
        connectionAcquired = true;
        log("info", "Read-only connection acquired");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Connection lost') || 
            errorMessage.includes('timeout') || 
            errorMessage.includes('ECONNRESET') ||
            errorMessage.includes('PROTOCOL_CONNECTION_LOST')) {
          retries++;
          if (retries < maxRetries) {
            log("info", `Connection error, retrying... (${retries}/${maxRetries})`);
            poolInstance = null;
            poolPromise = null;
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            continue;
          }
        }
        throw error;
      }
    }

    if (!connection) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Failed to acquire database connection after retries",
          },
        ],
        isError: true,
      } as T;
    }

    // Set read-only mode (unless disabled via environment variable)
    if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
    } else {
      log("info", "Read-only transactions disabled via MYSQL_DISABLE_READ_ONLY_TRANSACTIONS=true");
    }

    // Begin transaction
    await connection.beginTransaction();

    try {
      // Execute query - in multi-DB mode, we may need to handle USE statements specially
      const result = await queryWithTimeout(
        connection,
        sql,
        options.params ?? [],
        options.timeoutMs,
      );
      const rows = Array.isArray(result) ? result[0] : result;
      const fields = Array.isArray(result)
        ? (result[1] as mysql2.FieldPacket[] | undefined)
        : undefined;

      // Surface MySQL warnings (truncation, coercion...) — they often reveal
      // queries that "worked" but produced subtly wrong results.
      let warnings: any[] = [];
      try {
        const warningsResult = await connection.query("SHOW WARNINGS");
        const warningRows = Array.isArray(warningsResult)
          ? (warningsResult[0] as any[])
          : [];
        if (Array.isArray(warningRows) && warningRows.length > 0) {
          warnings = warningRows
            .filter((warning) => warning && warning.Message)
            .map((warning) => ({
              level: warning.Level,
              code: warning.Code,
              message: warning.Message,
            }));
        }
      } catch {
        // SHOW WARNINGS is best-effort
      }

      // Rollback transaction (since it's read-only)
      await connection.rollback();

      // Reset to read-write mode (only if we set it to read-only)
      if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
        await connection.query("SET SESSION TRANSACTION READ WRITE");
      }

      // Keep the primary text payload machine-readable. Several handlers parse
      // this field directly when they build MCP resources and higher-level tools.
      let resultText: string;
      let structured: Record<string, unknown> | undefined;

      if (Array.isArray(rows)) {
        const totalRows = rows.length;
        const limitedRows =
          options.maxRows && totalRows > options.maxRows
            ? rows.slice(0, options.maxRows)
            : rows;
        const truncated = limitedRows.length < totalRows;

        resultText =
          limitedRows.length === 0 ? "[]" : JSON.stringify(limitedRows, null, 2);
        if (truncated) {
          resultText += `\n-- Result truncated: showing ${limitedRows.length} of ${totalRows} rows. Use LIMIT/OFFSET or a higher maxRows to see more.`;
        }
        structured = {
          rows: limitedRows,
          rowCount: totalRows,
          returnedRows: limitedRows.length,
          truncated,
        };
        const columns = describeFields(fields);
        if (columns) {
          structured.columns = columns;
        }
        if (warnings.length > 0) {
          structured.warnings = warnings;
          resultText += `\n-- MySQL warnings: ${JSON.stringify(warnings)}`;
        }
      } else if (rows && typeof rows === 'object') {
        // Handle result set headers or other object responses
        resultText = JSON.stringify(rows, null, 2);
        structured = { result: rows };
      } else {
        resultText = String(rows || "Query executed successfully");
        structured = { message: resultText };
      }

      return {
        content: [
          {
            type: "text",
            text: resultText,
          },
        ],
        structured,
        isError: false,
      } as T;
    } catch (error) {
      // Rollback transaction on query error
      log("error", "Error executing read-only query:", error);
      await connection.rollback();
      
      // Return error in proper format instead of throwing
      return {
        content: [
          {
            type: "text",
            text: `Error executing query: ${formatMysqlError(error)}`,
          },
        ],
        structured: { error: describeMysqlError(error) },
        isError: true,
      } as T;
    }
    } catch (error) {
      // Ensure we rollback and reset transaction mode on any error
      log("error", "Error in read-only query transaction:", error);
      if (connection) {
        try {
          await (connection as mysql2.PoolConnection).rollback();
          // Reset to read-write mode (only if we set it to read-only)
          if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
            await (connection as mysql2.PoolConnection).query("SET SESSION TRANSACTION READ WRITE");
          }
        } catch (cleanupError) {
          // Ignore errors during cleanup
          log("error", "Error during cleanup:", cleanupError);
        }
      }
      
      // Return error in proper format instead of throwing
      return {
        content: [
          {
            type: "text",
            text: `Database error: ${formatMysqlError(error)}`,
          },
        ],
        structured: { error: describeMysqlError(error) },
        isError: true,
      } as T;
    } finally {
    if (connection) {
      connection.release();
      log("info", "Read-only connection released");
    }
  }
}

// Cleanup function to close pool and intervals
const cleanup = async () => {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (poolInstance) {
    try {
      await poolInstance.end();
      log("info", "MySQL pool closed");
    } catch (error) {
      log("error", "Error closing pool:", error);
    }
    poolInstance = null;
  }
  poolPromise = null;
};

export {
  isTestEnvironment,
  safeExit,
  executeQuery,
  getPool,
  executeWriteQuery,
  executeReadOnlyQuery,
  poolPromise,
  cleanup,
};
