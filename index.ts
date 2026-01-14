#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { performance } from "perf_hooks";
import { log } from "./src/utils/index.js";
import type { TableRow, ColumnRow, RoutineRow, EventRow, TriggerRow } from "./src/types/index.js";
import {
  ALLOW_DELETE_OPERATION,
  ALLOW_DDL_OPERATION,
  ALLOW_INSERT_OPERATION,
  ALLOW_UPDATE_OPERATION,
  SCHEMA_DELETE_PERMISSIONS,
  SCHEMA_DDL_PERMISSIONS,
  SCHEMA_INSERT_PERMISSIONS,
  SCHEMA_UPDATE_PERMISSIONS,
  isMultiDbMode,
  mcpConfig as config,
  MCP_VERSION as version,
  IS_REMOTE_MCP,
  REMOTE_SECRET_KEY,
  PORT,
} from "./src/config/index.js";
import {
  safeExit,
  getPool,
  executeQuery,
  executeReadOnlyQuery,
  poolPromise,
} from "./src/db/index.js";
import {
  additionalToolDefinitions,
  handleAdditionalTool,
  addToQueryHistory,
} from "./src/tools/index.js";

import path from 'path';
import express, { Request, Response } from "express";
import { fileURLToPath } from 'url';


log("info", `Starting MySQL MCP server v${version}...`);

// Update tool description to include multi-DB mode and schema-specific permissions
const toolVersion = `MySQL MCP Server [v${process.env.npm_package_version}]`;
let toolDescription = `[${toolVersion}] Run SQL queries against MySQL database`;

if (isMultiDbMode) {
  toolDescription += " (Multi-DB mode enabled)";
}

if (
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
) {
  // At least one write operation is enabled
  toolDescription += " with support for:";

  if (ALLOW_INSERT_OPERATION) {
    toolDescription += " INSERT,";
  }

  if (ALLOW_UPDATE_OPERATION) {
    toolDescription += " UPDATE,";
  }

  if (ALLOW_DELETE_OPERATION) {
    toolDescription += " DELETE,";
  }

  if (ALLOW_DDL_OPERATION) {
    toolDescription += " DDL,";
  }

  // Remove trailing comma and add READ operations
  toolDescription = toolDescription.replace(/,$/, "") + " and READ operations";

  if (
    Object.keys(SCHEMA_INSERT_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_UPDATE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DELETE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DDL_PERMISSIONS).length > 0
  ) {
    toolDescription += " (Schema-specific permissions enabled)";
  }
} else {
  // Only read operations are allowed
  toolDescription += " (READ-ONLY)";
}

// @INFO: Add debug logging for configuration
log(
  "info",
  "MySQL Configuration:",
  JSON.stringify(
    {
      ...(process.env.MYSQL_SOCKET_PATH
        ? {
            socketPath: process.env.MYSQL_SOCKET_PATH,
            connectionType: "Unix Socket",
          }
        : {
            host: process.env.MYSQL_HOST || "127.0.0.1",
            port: process.env.MYSQL_PORT || "3306",
            connectionType: "TCP/IP",
          }),
      user: config.mysql.user,
      password: config.mysql.password ? "******" : "not set",
      database: config.mysql.database || "MULTI_DB_MODE",
      ssl: process.env.MYSQL_SSL === "true" ? "enabled" : "disabled",
      multiDbMode: isMultiDbMode ? "enabled" : "disabled",
    },
    null,
    2,
  ),
);

// Define configuration schema
export const configSchema = z.object({
  debug: z.boolean().default(false).describe("Enable debug logging"),
});

// Export the default function that creates and returns the MCP server
export default function createMcpServer({
  sessionId,
  config,
}: {
  sessionId?: string;
  config: z.infer<typeof configSchema>;
}) {
  // Create the server instance
  const server = new Server(
    {
      name: "MySQL MCP Server",
      version: process.env.npm_package_version || "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // Register request handlers for resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      log("info", "Handling ListResourcesRequest");
      const connectionInfo = process.env.MYSQL_SOCKET_PATH
        ? `socket: ${process.env.MYSQL_SOCKET_PATH}`
        : `host: ${process.env.MYSQL_HOST || "localhost"}, port: ${
            process.env.MYSQL_PORT || 3306
          }`;
      log("info", `Connection info: ${connectionInfo}`);

      // Query to get all tables
      const tablesQuery = `
      SELECT
        table_name as name,
        table_schema as \`database\`,
        table_comment as description,
        table_rows as rowCount,
        data_length as dataSize,
        index_length as indexSize,
        create_time as createTime,
        update_time as updateTime
      FROM
        information_schema.tables
      WHERE
        table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        table_schema, table_name
    `;

      // Query to get all stored procedures and functions
      const routinesQuery = `
      SELECT
        routine_name as name,
        routine_schema as \`database\`,
        routine_type as type,
        data_type as dataType,
        routine_comment as description,
        definer,
        security_type as securityType,
        is_deterministic as isDeterministic,
        created as createTime,
        last_altered as updateTime
      FROM
        information_schema.routines
      WHERE
        routine_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        routine_schema, routine_type, routine_name
    `;

      // Query to get all events
      const eventsQuery = `
      SELECT
        event_name as name,
        event_schema as \`database\`,
        definer,
        time_zone as timeZone,
        event_type as eventType,
        execute_at as executeAt,
        interval_value as intervalValue,
        interval_field as intervalField,
        starts,
        ends,
        status,
        event_comment as description,
        created as createTime,
        last_altered as updateTime
      FROM
        information_schema.events
      WHERE
        event_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        event_schema, event_name
    `;

      // Query to get all triggers
      const triggersQuery = `
      SELECT
        trigger_name as name,
        trigger_schema as \`database\`,
        event_object_table as tableName,
        event_manipulation as event,
        action_timing as timing,
        definer,
        created as createTime
      FROM
        information_schema.triggers
      WHERE
        trigger_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        trigger_schema, event_object_table, trigger_name
    `;

      const [tablesResult, routinesResult, eventsResult, triggersResult] = await Promise.all([
        executeReadOnlyQuery<any>(tablesQuery),
        executeReadOnlyQuery<any>(routinesQuery),
        executeReadOnlyQuery<any>(eventsQuery),
        executeReadOnlyQuery<any>(triggersQuery),
      ]);

      const tables = JSON.parse(tablesResult.content[0].text) as TableRow[];
      const routines = JSON.parse(routinesResult.content[0].text) as RoutineRow[];
      const events = JSON.parse(eventsResult.content[0].text) as EventRow[];
      const triggers = JSON.parse(triggersResult.content[0].text) as TriggerRow[];

      log("info", `Found ${tables.length} tables, ${routines.length} routines, ${events.length} events, ${triggers.length} triggers`);

      // Create resources for each table
      const resources = tables.map((table) => ({
        uri: `mysql://tables/${table.database}/${table.name}`,
        name: table.name,
        title: `${table.database}.${table.name}`,
        description:
          table.description ||
          `Table ${table.name} in database ${table.database}`,
        mimeType: "application/json",
      }));

      // Create resources for stored procedures
      const procedures = routines.filter(r => r.type === 'PROCEDURE');
      procedures.forEach((proc) => {
        resources.push({
          uri: `mysql://procedures/${proc.database}/${proc.name}`,
          name: proc.name,
          title: `${proc.database}.${proc.name}`,
          description: proc.description || `Stored procedure ${proc.name} in database ${proc.database}`,
          mimeType: "application/json",
        });
      });

      // Create resources for functions
      const functions = routines.filter(r => r.type === 'FUNCTION');
      functions.forEach((func) => {
        resources.push({
          uri: `mysql://functions/${func.database}/${func.name}`,
          name: func.name,
          title: `${func.database}.${func.name}`,
          description: func.description || `Function ${func.name} (returns ${func.dataType}) in database ${func.database}`,
          mimeType: "application/json",
        });
      });

      // Create resources for events
      events.forEach((event) => {
        resources.push({
          uri: `mysql://events/${event.database}/${event.name}`,
          name: event.name,
          title: `${event.database}.${event.name}`,
          description: event.description || `Event ${event.name} (${event.status}) in database ${event.database}`,
          mimeType: "application/json",
        });
      });

      // Create resources for triggers
      triggers.forEach((trigger) => {
        resources.push({
          uri: `mysql://triggers/${trigger.database}/${trigger.name}`,
          name: trigger.name,
          title: `${trigger.database}.${trigger.name}`,
          description: `Trigger ${trigger.name} (${trigger.timing} ${trigger.event} on ${trigger.tableName})`,
          mimeType: "application/json",
        });
      });

      // Add summary resources
      resources.push({
        uri: "mysql://tables",
        name: "Tables",
        title: "MySQL Tables",
        description: "List of all MySQL tables",
        mimeType: "application/json",
      });

      resources.push({
        uri: "mysql://procedures",
        name: "Procedures",
        title: "MySQL Stored Procedures",
        description: "List of all MySQL stored procedures",
        mimeType: "application/json",
      });

      resources.push({
        uri: "mysql://functions",
        name: "Functions",
        title: "MySQL Functions",
        description: "List of all MySQL functions",
        mimeType: "application/json",
      });

      resources.push({
        uri: "mysql://events",
        name: "Events",
        title: "MySQL Events",
        description: "List of all MySQL scheduled events",
        mimeType: "application/json",
      });

      resources.push({
        uri: "mysql://triggers",
        name: "Triggers",
        title: "MySQL Triggers",
        description: "List of all MySQL triggers",
        mimeType: "application/json",
      });

      return { resources };
    } catch (error) {
      log("error", "Error in ListResourcesRequest handler:", error);
      throw error;
    }
  });

  // Register request handler for reading resources
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      log("info", "Handling ReadResourceRequest:", request.params.uri);

      const uri = request.params.uri;
      const uriParts = uri.replace("mysql://", "").split("/");
      const resourceType = uriParts[0]; // tables, procedures, functions, events, triggers
      const dbName = uriParts.length > 2 ? uriParts[1] : null;
      const objectName = uriParts.length > 2 ? uriParts[2] : uriParts[1];

      if (!objectName && resourceType !== "tables" && resourceType !== "procedures" && 
          resourceType !== "functions" && resourceType !== "events" && resourceType !== "triggers") {
        throw new Error(`Invalid resource URI: ${request.params.uri}`);
      }

      let results: any;
      let responseText: string;

      switch (resourceType) {
        case "tables": {
          if (!objectName) {
            // Return list of all tables
            const tablesQuery = `
              SELECT table_name as name, table_schema as \`database\`
              FROM information_schema.tables
              WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY table_schema, table_name
            `;
            const queryResult = await executeReadOnlyQuery<any>(tablesQuery);
            responseText = queryResult.content[0].text;
          } else {
            // Return columns for specific table
            let columnsQuery = `
              SELECT 
                column_name as name,
                data_type as dataType,
                column_type as columnType,
                is_nullable as isNullable,
                column_key as columnKey,
                column_default as defaultValue,
                extra,
                column_comment as comment
              FROM information_schema.columns 
              WHERE table_name = ?
            `;
            const queryParams = [objectName];
            if (dbName) {
              columnsQuery += " AND table_schema = ?";
              queryParams.push(dbName);
            }
            columnsQuery += " ORDER BY ordinal_position";
            results = await executeQuery(columnsQuery, queryParams);
            responseText = JSON.stringify(results, null, 2);
          }
          break;
        }

        case "procedures": {
          if (!objectName) {
            // Return list of all procedures
            const proceduresQuery = `
              SELECT routine_name as name, routine_schema as \`database\`
              FROM information_schema.routines
              WHERE routine_type = 'PROCEDURE'
                AND routine_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY routine_schema, routine_name
            `;
            const queryResult = await executeReadOnlyQuery<any>(proceduresQuery);
            responseText = queryResult.content[0].text;
          } else {
            // Return procedure definition
            const procedureQuery = dbName
              ? `SHOW CREATE PROCEDURE \`${dbName}\`.\`${objectName}\``
              : `SHOW CREATE PROCEDURE \`${objectName}\``;
            const createResult = await executeQuery<any[]>(procedureQuery);
            
            // Get parameters
            let paramsQuery = `
              SELECT 
                parameter_name as name,
                parameter_mode as mode,
                data_type as dataType,
                dtd_identifier as fullType
              FROM information_schema.parameters
              WHERE specific_name = ? AND routine_type = 'PROCEDURE'
            `;
            const paramsQueryParams = [objectName];
            if (dbName) {
              paramsQuery += " AND specific_schema = ?";
              paramsQueryParams.push(dbName);
            }
            paramsQuery += " ORDER BY ordinal_position";
            const paramsResult = await executeQuery<any[]>(paramsQuery, paramsQueryParams);

            responseText = JSON.stringify({
              name: objectName,
              database: dbName,
              type: "PROCEDURE",
              parameters: paramsResult,
              definition: createResult[0]?.['Create Procedure'] || null,
            }, null, 2);
          }
          break;
        }

        case "functions": {
          if (!objectName) {
            // Return list of all functions
            const functionsQuery = `
              SELECT routine_name as name, routine_schema as \`database\`, data_type as returnType
              FROM information_schema.routines
              WHERE routine_type = 'FUNCTION'
                AND routine_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY routine_schema, routine_name
            `;
            const queryResult = await executeReadOnlyQuery<any>(functionsQuery);
            responseText = queryResult.content[0].text;
          } else {
            // Return function definition
            const functionQuery = dbName
              ? `SHOW CREATE FUNCTION \`${dbName}\`.\`${objectName}\``
              : `SHOW CREATE FUNCTION \`${objectName}\``;
            const createResult = await executeQuery<any[]>(functionQuery);
            
            // Get parameters
            let paramsQuery = `
              SELECT 
                parameter_name as name,
                parameter_mode as mode,
                data_type as dataType,
                dtd_identifier as fullType
              FROM information_schema.parameters
              WHERE specific_name = ? AND routine_type = 'FUNCTION'
            `;
            const paramsQueryParams = [objectName];
            if (dbName) {
              paramsQuery += " AND specific_schema = ?";
              paramsQueryParams.push(dbName);
            }
            paramsQuery += " ORDER BY ordinal_position";
            const paramsResult = await executeQuery<any[]>(paramsQuery, paramsQueryParams);

            // Get return type
            let returnQuery = `
              SELECT data_type as returnType, dtd_identifier as fullReturnType
              FROM information_schema.routines
              WHERE routine_name = ? AND routine_type = 'FUNCTION'
            `;
            const returnQueryParams = [objectName];
            if (dbName) {
              returnQuery += " AND routine_schema = ?";
              returnQueryParams.push(dbName);
            }
            const returnResult = await executeQuery<any[]>(returnQuery, returnQueryParams);

            responseText = JSON.stringify({
              name: objectName,
              database: dbName,
              type: "FUNCTION",
              returnType: returnResult[0]?.returnType || null,
              fullReturnType: returnResult[0]?.fullReturnType || null,
              parameters: paramsResult.filter(p => p.name), // Filter out return parameter
              definition: createResult[0]?.['Create Function'] || null,
            }, null, 2);
          }
          break;
        }

        case "events": {
          if (!objectName) {
            // Return list of all events
            const eventsQuery = `
              SELECT event_name as name, event_schema as \`database\`, status, event_type as eventType
              FROM information_schema.events
              WHERE event_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY event_schema, event_name
            `;
            const queryResult = await executeReadOnlyQuery<any>(eventsQuery);
            responseText = queryResult.content[0].text;
          } else {
            // Return event definition
            const eventQuery = dbName
              ? `SHOW CREATE EVENT \`${dbName}\`.\`${objectName}\``
              : `SHOW CREATE EVENT \`${objectName}\``;
            const createResult = await executeQuery<any[]>(eventQuery);

            // Get event details
            let detailsQuery = `
              SELECT 
                event_name as name,
                event_schema as \`database\`,
                definer,
                time_zone as timeZone,
                event_type as eventType,
                execute_at as executeAt,
                interval_value as intervalValue,
                interval_field as intervalField,
                starts,
                ends,
                status,
                on_completion as onCompletion,
                event_comment as comment
              FROM information_schema.events
              WHERE event_name = ?
            `;
            const detailsQueryParams = [objectName];
            if (dbName) {
              detailsQuery += " AND event_schema = ?";
              detailsQueryParams.push(dbName);
            }
            const detailsResult = await executeQuery<any[]>(detailsQuery, detailsQueryParams);

            responseText = JSON.stringify({
              ...detailsResult[0],
              definition: createResult[0]?.['Create Event'] || null,
            }, null, 2);
          }
          break;
        }

        case "triggers": {
          if (!objectName) {
            // Return list of all triggers
            const triggersQuery = `
              SELECT 
                trigger_name as name, 
                trigger_schema as \`database\`,
                event_object_table as tableName,
                action_timing as timing,
                event_manipulation as event
              FROM information_schema.triggers
              WHERE trigger_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY trigger_schema, trigger_name
            `;
            const queryResult = await executeReadOnlyQuery<any>(triggersQuery);
            responseText = queryResult.content[0].text;
          } else {
            // Return trigger definition
            const triggerQuery = dbName
              ? `SHOW CREATE TRIGGER \`${dbName}\`.\`${objectName}\``
              : `SHOW CREATE TRIGGER \`${objectName}\``;
            const createResult = await executeQuery<any[]>(triggerQuery);

            // Get trigger details
            let detailsQuery = `
              SELECT 
                trigger_name as name,
                trigger_schema as \`database\`,
                event_object_table as tableName,
                action_timing as timing,
                event_manipulation as event,
                action_orientation as orientation,
                definer,
                created as createTime
              FROM information_schema.triggers
              WHERE trigger_name = ?
            `;
            const detailsQueryParams = [objectName];
            if (dbName) {
              detailsQuery += " AND trigger_schema = ?";
              detailsQueryParams.push(dbName);
            }
            const detailsResult = await executeQuery<any[]>(detailsQuery, detailsQueryParams);

            responseText = JSON.stringify({
              ...detailsResult[0],
              definition: createResult[0]?.['SQL Original Statement'] || null,
            }, null, 2);
          }
          break;
        }

        default: {
          // Fallback: try to get table columns (backward compatibility)
          let columnsQuery =
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?";
          const queryParams = [resourceType];
          results = await executeQuery(columnsQuery, queryParams);
          responseText = JSON.stringify(results, null, 2);
        }
      }

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: responseText,
          },
        ],
      };
    } catch (error) {
      log("error", "Error in ReadResourceRequest handler:", error);
      throw error;
    }
  });

  // Register handler for tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startTime = performance.now();
    try {
      log("info", "Handling CallToolRequest:", request.params.name);
      
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      // Check if it's one of the additional tools
      const additionalToolResult = await handleAdditionalTool(toolName, args as Record<string, any>);
      if (additionalToolResult !== null) {
        const duration = performance.now() - startTime;
        addToQueryHistory(
          `[TOOL] ${toolName}: ${JSON.stringify(args).substring(0, 200)}`,
          duration,
          0,
          !additionalToolResult.isError
        );
        return additionalToolResult as { content: Array<{ type: string; text: string }>; isError: boolean };
      }

      // Handle mysql_query tool
      if (toolName === "mysql_query") {
        const sql = args.sql as string;
        const result = await executeReadOnlyQuery<{ content: Array<{ type: string; text: string }>; isError: boolean }>(sql);
        const duration = performance.now() - startTime;
        
        // Add to query history
        try {
          const rowCount = result?.content?.[0]?.text ? 
            (JSON.parse(result.content[0].text) || []).length : 0;
          addToQueryHistory(sql, duration, rowCount, !result.isError);
        } catch {
          addToQueryHistory(sql, duration, 0, !result.isError);
        }
        
        return result;
      }

      throw new Error(`Unknown tool: ${toolName}`);
    } catch (err) {
      const error = err as Error;
      log("error", "Error in CallToolRequest handler:", error);
      const duration = performance.now() - startTime;
      addToQueryHistory(
        `[ERROR] ${request.params.name}`,
        duration,
        0,
        false,
        error.message
      );
      return {
        content: [{
          type: "text",
          text: `Error: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Register handler for listing tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("info", "Handling ListToolsRequest");

    const toolsResponse = {
      tools: [
        {
          name: "mysql_query",
          description: toolDescription,
          inputSchema: {
            type: "object",
            properties: {
              sql: {
                type: "string",
                description: "The SQL query to execute",
              },
            },
            required: ["sql"],
          },
        },
        // Add all additional tools
        ...additionalToolDefinitions,
      ],
    };

    log(
      "info",
      "ListToolsRequest response:",
      JSON.stringify(toolsResponse, null, 2),
    );
    return toolsResponse;
  });

  // Initialize database connection and set up shutdown handlers
  (async () => {
    try {
      log("info", "Attempting to test database connection...");
      // Test the connection before fully starting the server
      const pool = await getPool();
      const connection = await pool.getConnection();
      log("info", "Database connection test successful");
      connection.release();
    } catch (error) {
      log("error", "Fatal error during server startup:", error);
      safeExit(1);
    }
  })();

  // Setup shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    try {
      // Only attempt to close the pool if it was created
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
      }
    } catch (err) {
      log("error", "Error closing pool:", err);
      throw err;
    }
  };

  process.on("SIGINT", async () => {
    try {
      await shutdown("SIGINT");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGINT shutdown:", err);
      safeExit(1);
    }
  });

  process.on("SIGTERM", async () => {
    try {
      await shutdown("SIGTERM");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGTERM shutdown:", err);
      safeExit(1);
    }
  });

  // Add unhandled error listeners
  process.on("uncaughtException", (error) => {
    log("error", "Uncaught exception:", error);
    safeExit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log("error", "Unhandled rejection at:", promise, "reason:", reason);
    safeExit(1);
  });

  return server;
}

/**
* Checks if the current module is the main module (the entry point of the application).
* This function works for both ES Modules (ESM) and CommonJS.
* @returns {boolean} - True if the module is the main module, false otherwise.
*/
const isMainModule = () => {
  // 1. Standard check for CommonJS
  // `require.main` refers to the application's entry point module.
  // If it's the same as the current `module`, this file was executed directly.
  if (typeof require !== 'undefined' && require.main === module) {
    return true;
  }
  // 2. Check for ES Modules (ESM)
  // `import.meta.url` provides the file URL of the current module.
  // `process.argv[1]` provides the path of the executed script.
  if (typeof import.meta !== 'undefined' && import.meta.url && process.argv[1]) {
    // Convert the `import.meta.url` (e.g., 'file:///path/to/file.js') to a system-standard absolute path.
    const currentModulePath = fileURLToPath(import.meta.url);
    // Resolve `process.argv[1]` (which can be a relative path) to a standard absolute path.
    const mainScriptPath = path.resolve(process.argv[1]);
    // Compare the two standardized absolute paths.
    return currentModulePath === mainScriptPath;
  }
  // Fallback if neither of the above conditions are met.
  return false;
}

// Start the server if this file is being run directly
if (isMainModule()) {
  log("info", "Running in standalone mode");

  // Start the server
  (async () => {
    try {
      const mcpServer = createMcpServer({ config: { debug: false } });
      if (IS_REMOTE_MCP && REMOTE_SECRET_KEY?.length) {
        const app = express();
        app.use(express.json());
        app.post("/mcp", async (req: Request, res: Response) => {
          // In stateless mode, create a new instance of transport and server for each request
          // to ensure complete isolation. A single instance would cause request ID collisions
          // when multiple clients connect concurrently.
          if (
            !req.get("Authorization") ||
            !req.get("Authorization")?.startsWith("Bearer ") ||
            !req.get("Authorization")?.endsWith(REMOTE_SECRET_KEY)
          ) {
            console.error("Missing or invalid Authorization header");
            res.status(401).json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Missing or invalid Authorization header",
              },
              id: null,
            });
            return;
          }
          try {
            const server = mcpServer;
            const transport: StreamableHTTPServerTransport =
              new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
              });
            res.on("close", () => {
              log("info", "Request closed");
              transport.close();
              server.close();
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
          } catch (error) {
            log("error", "Error handling MCP request:", error);
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message: (error as any).message,
                },
                id: null,
              });
            }
          }
        });

        // SSE notifications not supported in stateless mode
        app.get("/mcp", async (req: Request, res: Response) => {
          console.log("Received GET MCP request");
          res.writeHead(405).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Method not allowed.",
              },
              id: null,
            }),
          );
        });

        // Session termination not needed in stateless mode
        app.delete("/mcp", async (req: Request, res: Response) => {
          console.log("Received DELETE MCP request");
          res.writeHead(405).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Method not allowed.",
              },
              id: null,
            }),
          );
        });

        // Start the server
        app.listen(PORT, (error) => {
          if (error) {
            console.error("Failed to start server:", error);
            process.exit(1);
          }
          console.log(
            `MCP Stateless Streamable HTTP Server listening on port ${PORT}`,
          );
        });
      } else {
        const transport = new StdioServerTransport();
        // Create a server instance directly instead of importing

        await mcpServer.connect(transport);
        log("info", "Server started and listening on stdio");
      }
    } catch (error) {
      log("error", "Server error:", error);
      safeExit(1);
    }
  })();
}
