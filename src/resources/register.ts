/**
 * MCP resources (ResourceTemplate + autocompletion) and guided prompts.
 *
 * Resources expose the database structure as navigable URIs
 * (mysql://tables/{db}/{table}, mysql://procedures/{db}/{name}, ...) with
 * per-variable autocompletion, so clients can discover databases, tables and
 * routines while typing. Prompts encode the recommended tool workflows.
 */

import { z } from "zod";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { executeQuery } from "../db/index.js";
import { log } from "../utils/index.js";

const SYSTEM_SCHEMAS =
  "('information_schema','mysql','performance_schema','sys')";

// ---------------------------------------------------------------------------
// Autocompletion helpers
// ---------------------------------------------------------------------------

async function completeDatabases(value: string): Promise<string[]> {
  try {
    const rows = await executeQuery<any[]>(
      `SELECT SCHEMA_NAME as name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ${SYSTEM_SCHEMAS}
         AND SCHEMA_NAME LIKE ?
       ORDER BY SCHEMA_NAME LIMIT 50`,
      [`${value}%`],
    );
    return rows.map((row) => String(row.name));
  } catch {
    return [];
  }
}

function makeTableCompleter() {
  return async (
    value: string,
    context?: { arguments?: Record<string, string> },
  ): Promise<string[]> => {
    try {
      const db = context?.arguments?.db;
      const rows = db
        ? await executeQuery<any[]>(
            `SELECT TABLE_NAME as name FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?
             ORDER BY TABLE_NAME LIMIT 50`,
            [db, `${value}%`],
          )
        : await executeQuery<any[]>(
            `SELECT DISTINCT TABLE_NAME as name FROM information_schema.TABLES
             WHERE TABLE_SCHEMA NOT IN ${SYSTEM_SCHEMAS} AND TABLE_NAME LIKE ?
             ORDER BY TABLE_NAME LIMIT 50`,
            [`${value}%`],
          );
      return rows.map((row) => String(row.name));
    } catch {
      return [];
    }
  };
}

function makeRoutineCompleter(routineType: "PROCEDURE" | "FUNCTION") {
  return async (
    value: string,
    context?: { arguments?: Record<string, string> },
  ): Promise<string[]> => {
    try {
      const db = context?.arguments?.db;
      let sql = `SELECT ROUTINE_NAME as name FROM information_schema.ROUTINES
                 WHERE ROUTINE_TYPE = ? AND ROUTINE_NAME LIKE ?`;
      const params: string[] = [routineType, `${value}%`];
      if (db) {
        sql += ` AND ROUTINE_SCHEMA = ?`;
        params.push(db);
      } else {
        sql += ` AND ROUTINE_SCHEMA NOT IN ${SYSTEM_SCHEMAS}`;
      }
      sql += ` ORDER BY ROUTINE_NAME LIMIT 50`;
      const rows = await executeQuery<any[]>(sql, params);
      return rows.map((row) => String(row.name));
    } catch {
      return [];
    }
  };
}

// ---------------------------------------------------------------------------
// List helpers (shared by list resources and templates)
// ---------------------------------------------------------------------------

async function listTableResources() {
  const tables = await executeQuery<any[]>(
    `SELECT table_name as name, table_schema as \`database\`, table_comment as description
     FROM information_schema.tables
     WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
     ORDER BY table_schema, table_name`,
  );
  return tables.map((table) => ({
    uri: `mysql://tables/${table.database}/${table.name}`,
    name: table.name,
    title: `${table.database}.${table.name}`,
    description:
      table.description || `Table ${table.name} in database ${table.database}`,
    mimeType: "application/json",
  }));
}

async function listRoutineResources(routineType: "PROCEDURE" | "FUNCTION") {
  const routines = await executeQuery<any[]>(
    `SELECT routine_name as name, routine_schema as \`database\`,
            routine_comment as description, data_type as dataType
     FROM information_schema.routines
     WHERE routine_type = ?
       AND routine_schema NOT IN ${SYSTEM_SCHEMAS}
     ORDER BY routine_schema, routine_name`,
    [routineType],
  );
  const segment = routineType === "PROCEDURE" ? "procedures" : "functions";
  return routines.map((routine) => ({
    uri: `mysql://${segment}/${routine.database}/${routine.name}`,
    name: routine.name,
    title: `${routine.database}.${routine.name}`,
    description:
      routine.description ||
      (routineType === "PROCEDURE"
        ? `Stored procedure ${routine.name} in database ${routine.database}`
        : `Function ${routine.name} (returns ${routine.dataType}) in database ${routine.database}`),
    mimeType: "application/json",
  }));
}

async function listEventResources() {
  const events = await executeQuery<any[]>(
    `SELECT event_name as name, event_schema as \`database\`, status,
            event_comment as description
     FROM information_schema.events
     WHERE event_schema NOT IN ${SYSTEM_SCHEMAS}
     ORDER BY event_schema, event_name`,
  );
  return events.map((event) => ({
    uri: `mysql://events/${event.database}/${event.name}`,
    name: event.name,
    title: `${event.database}.${event.name}`,
    description:
      event.description ||
      `Event ${event.name} (${event.status}) in database ${event.database}`,
    mimeType: "application/json",
  }));
}

async function listTriggerResources() {
  const triggers = await executeQuery<any[]>(
    `SELECT trigger_name as name, trigger_schema as \`database\`,
            event_object_table as tableName, event_manipulation as event,
            action_timing as timing
     FROM information_schema.triggers
     WHERE trigger_schema NOT IN ${SYSTEM_SCHEMAS}
     ORDER BY trigger_schema, event_object_table, trigger_name`,
  );
  return triggers.map((trigger) => ({
    uri: `mysql://triggers/${trigger.database}/${trigger.name}`,
    name: trigger.name,
    title: `${trigger.database}.${trigger.name}`,
    description: `Trigger ${trigger.name} (${trigger.timing} ${trigger.event} on ${trigger.tableName})`,
    mimeType: "application/json",
  }));
}

function jsonContents(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Read helpers per object type
// ---------------------------------------------------------------------------

async function readTableColumns(db: string, table: string) {
  return executeQuery<any[]>(
    `SELECT
       column_name as name, data_type as dataType, column_type as columnType,
       is_nullable as isNullable, column_key as columnKey,
       column_default as defaultValue, extra, column_comment as comment
     FROM information_schema.columns
     WHERE table_name = ? AND table_schema = ?
     ORDER BY ordinal_position`,
    [table, db],
  );
}

async function readRoutine(
  db: string,
  name: string,
  routineType: "PROCEDURE" | "FUNCTION",
) {
  const showSql =
    routineType === "PROCEDURE"
      ? `SHOW CREATE PROCEDURE \`${db}\`.\`${name}\``
      : `SHOW CREATE FUNCTION \`${db}\`.\`${name}\``;
  const createResult = await executeQuery<any[]>(showSql);

  const paramsResult = await executeQuery<any[]>(
    `SELECT parameter_name as name, parameter_mode as mode,
            data_type as dataType, dtd_identifier as fullType
     FROM information_schema.parameters
     WHERE specific_name = ? AND routine_type = ? AND specific_schema = ?
     ORDER BY ordinal_position`,
    [name, routineType, db],
  );

  const base = {
    name,
    database: db,
    type: routineType,
    parameters: paramsResult.filter((p) => p.name),
    definition:
      createResult[0]?.["Create Procedure"] ||
      createResult[0]?.["Create Function"] ||
      null,
  };

  if (routineType === "FUNCTION") {
    const returnResult = await executeQuery<any[]>(
      `SELECT data_type as returnType, dtd_identifier as fullReturnType
       FROM information_schema.routines
       WHERE routine_name = ? AND routine_type = 'FUNCTION' AND routine_schema = ?`,
      [name, db],
    );
    return {
      ...base,
      returnType: returnResult[0]?.returnType || null,
      fullReturnType: returnResult[0]?.fullReturnType || null,
    };
  }

  return base;
}

async function readEvent(db: string, name: string) {
  const createResult = await executeQuery<any[]>(
    `SHOW CREATE EVENT \`${db}\`.\`${name}\``,
  );
  const detailsResult = await executeQuery<any[]>(
    `SELECT event_name as name, event_schema as \`database\`, definer,
            time_zone as timeZone, event_type as eventType,
            execute_at as executeAt, interval_value as intervalValue,
            interval_field as intervalField, starts, ends, status,
            on_completion as onCompletion, event_comment as comment
     FROM information_schema.events
     WHERE event_name = ? AND event_schema = ?`,
    [name, db],
  );
  return {
    ...detailsResult[0],
    definition: createResult[0]?.["Create Event"] || null,
  };
}

async function readTrigger(db: string, name: string) {
  const createResult = await executeQuery<any[]>(
    `SHOW CREATE TRIGGER \`${db}\`.\`${name}\``,
  );
  const detailsResult = await executeQuery<any[]>(
    `SELECT trigger_name as name, trigger_schema as \`database\`,
            event_object_table as tableName, action_timing as timing,
            event_manipulation as event, action_orientation as orientation,
            definer, created as createTime
     FROM information_schema.triggers
     WHERE trigger_name = ? AND trigger_schema = ?`,
    [name, db],
  );
  return {
    ...detailsResult[0],
    definition: createResult[0]?.["SQL Original Statement"] || null,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerResources(server: McpServer) {
  const tableCompleter = makeTableCompleter();

  // Dynamic templates with per-variable autocompletion. Their `list`
  // callbacks feed resources/list, replacing the old monolithic handler.
  server.registerResource(
    "table",
    new ResourceTemplate("mysql://tables/{db}/{table}", {
      list: async () => ({ resources: await listTableResources() }),
      complete: { db: completeDatabases, table: tableCompleter },
    }),
    {
      title: "MySQL table",
      description: "Columns of a specific table",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      jsonContents(
        uri,
        await readTableColumns(String(variables.db), String(variables.table)),
      ),
  );

  server.registerResource(
    "procedure",
    new ResourceTemplate("mysql://procedures/{db}/{name}", {
      list: async () => ({
        resources: await listRoutineResources("PROCEDURE"),
      }),
      complete: { db: completeDatabases, name: makeRoutineCompleter("PROCEDURE") },
    }),
    {
      title: "MySQL stored procedure",
      description: "Definition and parameters of a stored procedure",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      jsonContents(
        uri,
        await readRoutine(
          String(variables.db),
          String(variables.name),
          "PROCEDURE",
        ),
      ),
  );

  server.registerResource(
    "function",
    new ResourceTemplate("mysql://functions/{db}/{name}", {
      list: async () => ({ resources: await listRoutineResources("FUNCTION") }),
      complete: { db: completeDatabases, name: makeRoutineCompleter("FUNCTION") },
    }),
    {
      title: "MySQL function",
      description: "Definition, parameters and return type of a function",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      jsonContents(
        uri,
        await readRoutine(
          String(variables.db),
          String(variables.name),
          "FUNCTION",
        ),
      ),
  );

  server.registerResource(
    "event",
    new ResourceTemplate("mysql://events/{db}/{name}", {
      list: async () => ({ resources: await listEventResources() }),
      complete: { db: completeDatabases },
    }),
    {
      title: "MySQL scheduled event",
      description: "Definition and schedule of an event",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      jsonContents(
        uri,
        await readEvent(String(variables.db), String(variables.name)),
      ),
  );

  server.registerResource(
    "trigger",
    new ResourceTemplate("mysql://triggers/{db}/{name}", {
      list: async () => ({ resources: await listTriggerResources() }),
      complete: { db: completeDatabases },
    }),
    {
      title: "MySQL trigger",
      description: "Definition of a trigger",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      jsonContents(
        uri,
        await readTrigger(String(variables.db), String(variables.name)),
      ),
  );

  // Static summary resources (lists as JSON documents)
  server.registerResource(
    "tables-list",
    "mysql://tables",
    {
      title: "MySQL Tables",
      description: "List of all MySQL tables",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        await executeQuery<any[]>(
          `SELECT table_name as name, table_schema as \`database\`
           FROM information_schema.tables
           WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
           ORDER BY table_schema, table_name`,
        ),
      ),
  );

  server.registerResource(
    "procedures-list",
    "mysql://procedures",
    {
      title: "MySQL Stored Procedures",
      description: "List of all MySQL stored procedures",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        await executeQuery<any[]>(
          `SELECT routine_name as name, routine_schema as \`database\`
           FROM information_schema.routines
           WHERE routine_type = 'PROCEDURE'
             AND routine_schema NOT IN ${SYSTEM_SCHEMAS}
           ORDER BY routine_schema, routine_name`,
        ),
      ),
  );

  server.registerResource(
    "functions-list",
    "mysql://functions",
    {
      title: "MySQL Functions",
      description: "List of all MySQL functions",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        await executeQuery<any[]>(
          `SELECT routine_name as name, routine_schema as \`database\`, data_type as returnType
           FROM information_schema.routines
           WHERE routine_type = 'FUNCTION'
             AND routine_schema NOT IN ${SYSTEM_SCHEMAS}
           ORDER BY routine_schema, routine_name`,
        ),
      ),
  );

  server.registerResource(
    "events-list",
    "mysql://events",
    {
      title: "MySQL Events",
      description: "List of all MySQL scheduled events",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        await executeQuery<any[]>(
          `SELECT event_name as name, event_schema as \`database\`, status, event_type as eventType
           FROM information_schema.events
           WHERE event_schema NOT IN ${SYSTEM_SCHEMAS}
           ORDER BY event_schema, event_name`,
        ),
      ),
  );

  server.registerResource(
    "triggers-list",
    "mysql://triggers",
    {
      title: "MySQL Triggers",
      description: "List of all MySQL triggers",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        await executeQuery<any[]>(
          `SELECT trigger_name as name, trigger_schema as \`database\`,
                  event_object_table as tableName, action_timing as timing,
                  event_manipulation as event
           FROM information_schema.triggers
           WHERE trigger_schema NOT IN ${SYSTEM_SCHEMAS}
           ORDER BY trigger_schema, trigger_name`,
        ),
      ),
  );

  log("info", "MCP resources registered (templates with autocompletion)");
}

// ---------------------------------------------------------------------------
// Prompts: guided workflows that chain the tools in the right order
// ---------------------------------------------------------------------------

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "analyze-database",
    {
      title: "Analizar base de datos",
      description:
        "Flujo guiado para entender una base completa: diccionario de datos, relaciones y estadísticas.",
      argsSchema: {
        database: completable(
          z.string().describe("Base de datos a analizar"),
          completeDatabases,
        ),
      },
    },
    ({ database }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Analiza a fondo la base de datos MySQL '${database}' siguiendo estos pasos:`,
              ``,
              `1. Ejecuta mysql_data_dictionary con database="${database}" y format="markdown" para obtener tablas, columnas, claves y filas de ejemplo. Si la base tiene muchas tablas, usa maxTables/offsetTables para paginar.`,
              `2. Ejecuta mysql_foreign_keys con database="${database}" y format="mermaid" para ver el diagrama de relaciones.`,
              `3. Ejecuta mysql_table_stats con database="${database}" para conocer tamaños y volumen de datos.`,
              ``,
              `Con esa información, resume: el propósito de cada tabla, las entidades principales y sus relaciones, y cualquier problema de diseño que detectes (tablas sin PK, FKs sin índice, etc.).`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "optimize-query",
    {
      title: "Optimizar query",
      description:
        "Flujo guiado para diagnosticar y optimizar una consulta lenta con EXPLAIN e índices.",
      argsSchema: {
        sql: z.string().describe("La consulta SQL a optimizar"),
      },
    },
    ({ sql }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Optimiza esta consulta MySQL:`,
              ``,
              "```sql",
              sql,
              "```",
              ``,
              `Pasos:`,
              `1. Ejecuta mysql_explain con format="json" para obtener el plan y la lista de issues con severidad. Si es un SELECT y quieres datos reales, repite con analyze=true.`,
              `2. Revisa los issues: full scans, filesort, índices no usados y las sugerencias de índices compuestos.`,
              `3. Si hace falta, usa mysql_describe sobre las tablas implicadas para ver índices existentes y mysql_index_suggestions para detectar redundancias.`,
              `4. Propón la consulta optimizada y los CREATE INDEX exactos, explicando el porqué de cada cambio y su impacto esperado.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "safe-migration",
    {
      title: "Migración segura entre esquemas",
      description:
        "Flujo guiado para comparar dos bases y generar una migración revisada, marcando cambios con riesgo.",
      argsSchema: {
        sourceDb: completable(
          z.string().describe("Base origen (estado deseado)"),
          completeDatabases,
        ),
        targetDb: completable(
          z.string().describe("Base destino (la que se modificará)"),
          completeDatabases,
        ),
      },
    },
    ({ sourceDb, targetDb }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Prepara una migración segura de esquema desde '${sourceDb}' hacia '${targetDb}':`,
              ``,
              `1. Ejecuta mysql_compare_schemas con sourceDb="${sourceDb}" y targetDb="${targetDb}". Presta atención a columnTypeDifferences con severity="breaking" y a objectDifferences (rutinas/vistas/triggers con distinta definición).`,
              `2. Ejecuta mysql_generate_migration con los mismos argumentos para obtener el script (incluye sección DOWN para revertir).`,
              `3. Revisa el script: señala explícitamente cada línea marcada con "POSIBLE PÉRDIDA DE DATOS" y los DROP comentados.`,
              `4. NO ejecutes la migración. Preséntala con un resumen de riesgos y pide confirmación antes de aplicar nada.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  log("info", "MCP prompts registered");
}
