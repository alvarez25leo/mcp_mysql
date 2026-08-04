#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { log } from "./src/utils/index.js";
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
  cleanup as cleanupPool,
} from "./src/db/index.js";
import { registerAllTools } from "./src/tools/register.js";
import {
  registerResources,
  registerPrompts,
} from "./src/resources/register.js";

import express, { Request, Response } from "express";
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { timingSafeEqual } from 'crypto';


log("info", `Starting MySQL MCP server v${version}...`);

// Update tool description to include multi-DB mode and schema-specific permissions
const toolVersion = `MySQL MCP Server [v${version}]`;
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

toolDescription +=
  ". This is the primary tool for executing any SQL query (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, etc.). Use this tool for general database operations, data retrieval, and SQL execution. For specialized operations, consider using the other MySQL tools (mysql_explain for query optimization, mysql_describe for table structure, etc.). Queries are executed with proper transaction handling and permission checking.";

// Determine if we're in read-only mode (no write operations enabled)
const isReadOnly = !(
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
);

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
  config: _serverConfig,
}: {
  sessionId?: string;
  config: z.infer<typeof configSchema>;
}) {
  // High-level McpServer (SDK 1.x modern API):
  //  - tools via registerTool (Zod validation, annotations, structured output)
  //  - resources via ResourceTemplate with per-variable autocompletion
  //  - guided prompts (analyze-database, optimize-query, safe-migration)
  const server = new McpServer({
    name: "MySQL MCP Server",
    version,
  });

  registerResources(server);
  registerPrompts(server);
  registerAllTools(server, {
    mysqlQueryDescription: toolDescription,
    isReadOnly,
  });

  return server;
}

/**
* Checks if the current module is the main module (the entry point of the application).
* This function works for both ES Modules (ESM) and CommonJS.
* @returns {boolean} - True if the module is the main module, false otherwise.
*/
const isMainModule = () => {
  if (import.meta.url && process.argv[1]) {
    const currentModulePath = fileURLToPath(import.meta.url);
    const mainScriptPath = realpathSync(process.argv[1]);
    return currentModulePath === mainScriptPath;
  }
  return false;
}

// Constant-time comparison of the Authorization header against the expected
// Bearer token. endsWith()-style checks would accept any token that merely
// ends with the secret.
function isAuthorized(authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${REMOTE_SECRET_KEY}`);
  const received = Buffer.from(authorizationHeader);
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

// Start the server if this file is being run directly
if (isMainModule()) {
  log("info", "Running in standalone mode");

  // Process-level handlers are registered once here, not inside
  // createMcpServer: the factory runs per request in HTTP mode and would
  // otherwise leak listeners.
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    await cleanupPool();
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

  process.on("uncaughtException", (error) => {
    log("error", "Uncaught exception:", error);
    safeExit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log("error", "Unhandled rejection at:", promise, "reason:", reason);
    safeExit(1);
  });

  // Start the server
  (async () => {
    try {
      // Test the database connection before accepting clients
      try {
        log("info", "Attempting to test database connection...");
        const pool = await getPool();
        const connection = await pool.getConnection();
        log("info", "Database connection test successful");
        connection.release();
      } catch (error) {
        log("error", "Fatal error during server startup:", error);
        safeExit(1);
      }

      if (IS_REMOTE_MCP && REMOTE_SECRET_KEY?.length) {
        const app = express();
        app.use(express.json());
        app.post("/mcp", async (req: Request, res: Response) => {
          if (!isAuthorized(req.get("Authorization"))) {
            log("error", "Missing or invalid Authorization header");
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
            // Stateless mode: a fresh server + transport per request for full
            // isolation. Reusing one server instance caused request ID
            // collisions and its close() on the first finished response tore
            // down the shared server for every other client.
            const server = createMcpServer({ config: { debug: false } });
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
          log("info", "Received GET MCP request");
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
          log("info", "Received DELETE MCP request");
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
            log("error", "Failed to start server:", error);
            process.exit(1);
          }
          log("info", `MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
        });
      } else {
        const mcpServer = createMcpServer({ config: { debug: false } });
        const transport = new StdioServerTransport();
        await mcpServer.connect(transport);
        log("info", "Server started and listening on stdio");
      }
    } catch (error) {
      log("error", "Server error:", error);
      safeExit(1);
    }
  })();
}
