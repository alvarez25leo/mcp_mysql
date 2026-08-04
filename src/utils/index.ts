import { SchemaPermissions } from "../types/index.js";
type LogType = "info" | "error";

// @INFO: Enable logging if ENABLE_LOGGING is true
const ENABLE_LOGGING =
  process.env.ENABLE_LOGGING === "true" || process.env.ENABLE_LOGGING === "1";

export function log(type: LogType = "info", ...args: any[]): void {
  if (!ENABLE_LOGGING) return;

  // Always log to stderr: on stdio transport, stdout carries JSON-RPC frames
  // and any stray write would corrupt the protocol stream.
  console.error(`[${type}]`, ...args);
}

// Escape a MySQL identifier (database, table, column, routine name) for safe
// interpolation inside backticks. Doubles embedded backticks per MySQL rules.
export function escapeId(identifier: string): string {
  return "`" + String(identifier).replace(/`/g, "``") + "`";
}

// Levenshtein distance for "did you mean" suggestions
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i++) {
    let prevDiagonal = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = dist[j];
      dist[j] = Math.min(
        dist[j] + 1,
        dist[j - 1] + 1,
        prevDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiagonal = temp;
    }
  }
  return dist[cols - 1];
}

/**
 * Find names similar to `input` among `candidates` (case-insensitive).
 * Returns up to `max` matches sorted by closeness. Used to build
 * "did you mean" hints when a table/database/routine does not exist.
 */
export function findSimilarNames(
  input: string,
  candidates: string[],
  max: number = 3,
): string[] {
  const normalized = input.toLowerCase();
  // Allow more distance for longer names, at least 2, at most 5
  const threshold = Math.min(5, Math.max(2, Math.floor(input.length / 3)));

  return candidates
    .map((candidate) => {
      const candidateLower = candidate.toLowerCase();
      // Substring matches rank first regardless of edit distance
      const contains =
        candidateLower.includes(normalized) || normalized.includes(candidateLower);
      return {
        candidate,
        distance: contains ? 0 : levenshtein(normalized, candidateLower),
      };
    })
    .filter((entry) => entry.distance <= threshold)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, max)
    .map((entry) => entry.candidate);
}

// Actionable hints for common MySQL error codes so the model can
// self-correct on the next call instead of retrying blindly.
const MYSQL_ERROR_HINTS: Record<string, string> = {
  ER_NO_SUCH_TABLE:
    "La tabla no existe. Usa mysql_data_dictionary o mysql_query con SHOW TABLES para ver las tablas disponibles y verifica mayúsculas/minúsculas.",
  ER_BAD_DB_ERROR:
    "La base de datos no existe. Usa mysql_query con SHOW DATABASES para listar las bases disponibles.",
  ER_BAD_FIELD_ERROR:
    "La columna no existe. Usa mysql_describe sobre la tabla para ver las columnas reales.",
  ER_PARSE_ERROR:
    "Error de sintaxis SQL. Revisa la sentencia cerca de la posición indicada; verifica comillas, backticks y palabras reservadas.",
  ER_DUP_ENTRY:
    "Valor duplicado en un índice único. Consulta los índices con mysql_describe para ver qué restricción se viola.",
  ER_NO_REFERENCED_ROW_2:
    "Violación de foreign key: el valor referenciado no existe en la tabla padre. Usa mysql_foreign_keys para ver la relación.",
  ER_ROW_IS_REFERENCED_2:
    "No se puede borrar/modificar: otras filas referencian este registro. Usa mysql_foreign_keys para ver qué tablas dependen.",
  ER_ACCESS_DENIED_ERROR:
    "Credenciales incorrectas. Revisa MYSQL_USER y MYSQL_PASS en la configuración del servidor MCP.",
  ER_DBACCESS_DENIED_ERROR:
    "El usuario MySQL no tiene permisos sobre esa base de datos.",
  ER_TABLEACCESS_DENIED_ERROR:
    "El usuario MySQL no tiene permisos sobre esa tabla para esta operación.",
  ER_SP_DOES_NOT_EXIST:
    "El procedure/function no existe. Usa mysql_query con SHOW PROCEDURE STATUS o mysql_routine_impact para localizar rutinas.",
  ER_WRONG_VALUE_COUNT_ON_ROW:
    "El número de valores no coincide con el número de columnas. Usa mysql_describe para ver las columnas de la tabla.",
  ER_TRUNCATED_WRONG_VALUE:
    "Valor con formato incorrecto para el tipo de columna (fecha/número). Usa mysql_describe para ver el tipo exacto.",
  ER_DATA_TOO_LONG:
    "El valor excede el tamaño de la columna. Usa mysql_describe para ver la longitud máxima.",
  ER_LOCK_WAIT_TIMEOUT:
    "Timeout esperando un lock: otra transacción tiene bloqueada la fila/tabla. Usa mysql_process_list para ver transacciones activas.",
  ER_LOCK_DEADLOCK:
    "Deadlock detectado y transacción abortada. Reintenta la operación; si persiste, revisa el orden de acceso a tablas.",
  PROTOCOL_CONNECTION_LOST:
    "Se perdió la conexión con MySQL. El pool se reconectará automáticamente; reintenta la consulta.",
  ECONNREFUSED:
    "MySQL no acepta conexiones en ese host/puerto. Verifica que el servidor esté arrancado y MYSQL_HOST/MYSQL_PORT.",
  ETIMEDOUT:
    "Timeout de conexión. Verifica conectividad de red y MYSQL_CONNECT_TIMEOUT.",
};

export interface MySqlErrorInfo {
  message: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  hint?: string;
}

/**
 * Extract structured info (code/errno/sqlState) plus an actionable hint from
 * a mysql2 error. Falls back gracefully for non-MySQL errors.
 */
export function describeMysqlError(error: unknown): MySqlErrorInfo {
  const err = error as any;
  const info: MySqlErrorInfo = {
    message: err instanceof Error ? err.message : String(err),
  };

  if (err && typeof err === "object") {
    if (typeof err.code === "string") info.code = err.code;
    if (typeof err.errno === "number") info.errno = err.errno;
    if (typeof err.sqlState === "string") info.sqlState = err.sqlState;
  }

  if (info.code && MYSQL_ERROR_HINTS[info.code]) {
    info.hint = MYSQL_ERROR_HINTS[info.code];
  }

  return info;
}

/**
 * Human/AI friendly single-string rendering of a MySQL error, including the
 * error code and the actionable hint when available.
 */
export function formatMysqlError(error: unknown): string {
  const info = describeMysqlError(error);
  let text = info.message;
  if (info.code) {
    text += ` [${info.code}${info.errno ? ` ${info.errno}` : ""}]`;
  }
  if (info.hint) {
    text += `\nHint: ${info.hint}`;
  }
  return text;
}

// Function to parse schema-specific permissions from environment variables
export function parseSchemaPermissions(
  permissionsString?: string,
): SchemaPermissions {
  const permissions: SchemaPermissions = {};

  if (!permissionsString) {
    return permissions;
  }

  // Format: "schema1:true,schema2:false"
  const permissionPairs = permissionsString.split(",");

  for (const pair of permissionPairs) {
    const [schema, value] = pair.split(":");
    if (schema && value) {
      permissions[schema.trim()] = value.trim() === "true";
    }
  }

  return permissions;
}

// MySQL connection configuration type
export interface MySQLConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  socketPath?: string;
}

// Function to parse MySQL connection string (mysql CLI format)
// Example: mysql --default-auth=mysql_native_password -A -hrdsproxy.staging.luno.com -P3306 -uUSER -pPASS database_name
export function parseMySQLConnectionString(
  connectionString: string,
): MySQLConnectionConfig {
  const config: MySQLConnectionConfig = {};

  // Remove 'mysql' command at the start if present
  let cleanedString = connectionString.trim().replace(/^mysql\s+/, '');

  // Parse flags and options
  const tokens = [];
  let currentToken = '';
  let inQuotes = false;
  let quoteChar: string | null = null;

  for (let i = 0; i < cleanedString.length; i++) {
    const char = cleanedString[i];

    if ((char === '"' || char === "'") && (!inQuotes || char === quoteChar)) {
      // Toggle quote state without adding the quote character
      inQuotes = !inQuotes;
      quoteChar = inQuotes ? char : null;
    } else if (char === ' ' && !inQuotes) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }
    } else {
      currentToken += char;
    }
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  // Process tokens
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Check for combined short options (e.g., -uUSER, -pPASS, -hHOST, -PPORT)
    if (token.startsWith('-') && !token.startsWith('--')) {
      const flag = token[1];
      let value = token.substring(2);

      // If no value attached, check next token
      if (!value && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        value = tokens[i + 1];
        i++;
      }

      switch (flag) {
        case 'h':
          config.host = value;
          break;
        case 'P': {
          const port = parseInt(value, 10);
          if (Number.isNaN(port) || !Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${value}`);
          }
          config.port = port;
          break;
        }
        case 'u':
          config.user = value;
          break;
        case 'p':
          config.password = value;
          break;
        case 'S':
          config.socketPath = value;
          break;
      }
    }
    // Check for long options (e.g., --host=HOST, --port=PORT)
    else if (token.startsWith('--')) {
      const [flag, ...valueParts] = token.substring(2).split('=');
      let value = valueParts.join('=');

      // If no value with =, check next token
      if (!value && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        value = tokens[i + 1];
        i++;
      }

      switch (flag) {
        case 'host':
          config.host = value;
          break;
        case 'port': {
          const port = parseInt(value, 10);
          if (Number.isNaN(port) || !Number.isFinite(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${value}`);
          }
          config.port = port;
          break;
        }
        case 'user':
          config.user = value;
          break;
        case 'password':
          config.password = value;
          break;
        case 'socket':
          config.socketPath = value;
          break;
      }
    }
    // Last positional argument (not starting with -) is the database name
    else if (!token.startsWith('-')) {
      // Only consider it a database if it's one of the last arguments and not part of a flag
      config.database = token;
    }
  }

  return config;
}
