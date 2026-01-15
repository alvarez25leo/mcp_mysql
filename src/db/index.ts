import { performance } from "perf_hooks";
import { isMultiDbMode } from "./../config/index.js";

import {
  isDDLAllowedForSchema,
  isInsertAllowedForSchema,
  isUpdateAllowedForSchema,
  isDeleteAllowedForSchema,
} from "./permissions.js";
import { extractSchemaFromQuery, getQueryTypes } from "./utils.js";

import * as mysql2 from "mysql2/promise";
import { log } from "./../utils/index.js";
import { mcpConfig as config, MYSQL_DISABLE_READ_ONLY_TRANSACTIONS } from "./../config/index.js";

// Force read-only mode in multi-DB mode unless explicitly configured otherwise
if (isMultiDbMode && process.env.MULTI_DB_WRITE_MODE !== "true") {
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
let poolPromise: Promise<mysql2.Pool>;
let poolInstance: mysql2.Pool | null = null;
let keepAliveInterval: NodeJS.Timeout | null = null;

// Function to create a new pool
const createPool = (): mysql2.Pool => {
  const poolConfig = {
    ...config.mysql,
    // Add connection timeout and retry settings
    acquireTimeout: process.env.MYSQL_ACQUIRE_TIMEOUT ? parseInt(process.env.MYSQL_ACQUIRE_TIMEOUT, 10) : 60000,
    timeout: process.env.MYSQL_QUERY_TIMEOUT ? parseInt(process.env.MYSQL_QUERY_TIMEOUT, 10) : 30000,
    // Reconnect on connection loss
    reconnect: true,
    // Keep connections alive
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };

  const pool = mysql2.createPool(poolConfig);
  
  // Handle pool errors - use type assertion for event handler
  (pool as any).on('error', (err: Error) => {
    log("error", "MySQL pool error:", err);
    // If it's a connection error, reset the pool
    if (err.message.includes('Connection lost') || err.message.includes('timeout')) {
      log("info", "Connection lost detected, pool will be recreated on next use");
      poolInstance = null;
      poolPromise = null as any;
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
      poolPromise = null as any;
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
        poolPromise = null as any;
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
      poolPromise = null as any;
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
          poolPromise = null as any;
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
        log("error", "Connection released");
      }
    }
  }
  
  throw new Error("Max retries reached for query execution");
}

// @INFO: New function to handle write operations
async function executeWriteQuery<T>(sql: string): Promise<T> {
  let connection;
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const pool = await getPool();
      connection = await pool.getConnection();
      log("error", "Write connection acquired");
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
          poolPromise = null as any;
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
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const response = Array.isArray(result) ? result[0] : result;

      // @INFO: Commit the transaction
      await connection.commit();

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
      if (isInsertOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Insert successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Last insert ID: ${resultHeader.insertId}`;
      } else if (isUpdateOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Update successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Changed rows: ${resultHeader.changedRows || 0}`;
      } else if (isDeleteOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Delete successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}`;
      } else if (isDDLOperation) {
        responseText = `DDL operation successful on schema '${schema || "default"}'.`;
      } else {
        responseText = JSON.stringify(response, null, 2);
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
            text: `Error executing write operation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      } as T;
    }
  } catch (error: unknown) {
    log("error", "Error in write operation transaction:", error);
    return {
      content: [
        {
          type: "text",
          text: `Database connection error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    } as T;
  } finally {
    if (connection) {
      connection.release();
      log("error", "Write connection released");
    }
  }
}

async function executeReadOnlyQuery<T>(sql: string): Promise<T> {
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

    // For write operations that are allowed, use executeWriteQuery
    if (
      (isInsertOperation && isInsertAllowedForSchema(schema)) ||
      (isUpdateOperation && isUpdateAllowedForSchema(schema)) ||
      (isDeleteOperation && isDeleteAllowedForSchema(schema)) ||
      (isDDLOperation && isDDLAllowedForSchema(schema))
    ) {
      return executeWriteQuery(sql);
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
        log("error", "Read-only connection acquired");
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
            poolPromise = null as any;
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
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const rows = Array.isArray(result) ? result[0] : result;

      // Rollback transaction (since it's read-only)
      await connection.rollback();

      // Reset to read-write mode (only if we set it to read-only)
      if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
        await connection.query("SET SESSION TRANSACTION READ WRITE");
      }

      // Format results for better visibility
      let resultText: string;
      let summaryText: string;
      
      if (Array.isArray(rows)) {
        if (rows.length === 0) {
          resultText = "[]";
          summaryText = `\n--- Query executed successfully: 0 rows returned ---\n--- Execution time: ${duration.toFixed(2)} ms ---`;
        } else {
          resultText = JSON.stringify(rows, null, 2);
          summaryText = `\n--- Query executed successfully: ${rows.length} row(s) returned ---\n--- Execution time: ${duration.toFixed(2)} ms ---`;
        }
      } else if (rows && typeof rows === 'object') {
        // Handle result set headers or other object responses
        resultText = JSON.stringify(rows, null, 2);
        summaryText = `\n--- Query executed successfully ---\n--- Execution time: ${duration.toFixed(2)} ms ---`;
      } else {
        resultText = String(rows || "Query executed successfully");
        summaryText = `\n--- Execution time: ${duration.toFixed(2)} ms ---`;
      }

      return {
        content: [
          {
            type: "text",
            text: resultText + summaryText,
          },
        ],
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
            text: `Error executing query: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
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
            text: `Database error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      } as T;
    } finally {
    if (connection) {
      connection.release();
      log("error", "Read-only connection released");
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
  poolPromise = null as any;
};

// Handle process termination
if (!isTestEnvironment) {
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });
}

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
