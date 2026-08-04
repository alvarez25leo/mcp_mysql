# MySQL MCP Server

Servidor MCP (Model Context Protocol) para trabajar con MySQL/MariaDB desde
Claude u otros editores/asistentes de IA. Permite consultar datos, inspeccionar
y documentar el esquema, analizar rendimiento, exportar DDL y, si la
configuración lo permite, ejecutar operaciones de escritura controladas.

Construido sobre la API moderna del SDK oficial (`@modelcontextprotocol/sdk`
1.30, `McpServer` + `registerTool`):

- **Inputs validados con Zod**: si la IA envía argumentos mal formados recibe
  un error claro y accionable (`isError: true`) que le permite autocorregirse.
- **`structuredContent` + `outputSchema` en las 21 tools**: además del texto,
  cada tool devuelve datos estructurados y declara su forma de salida.
- **Errores enriquecidos con hint**: cada error MySQL incluye su código
  (`ER_NO_SUCH_TABLE`...) y una sugerencia de corrección accionable.
- **"¿Querías decir?"**: si una tabla/rutina no existe, el error incluye los
  nombres más parecidos (fuzzy matching) para corregir a la primera.
- **Guard de escrituras**: UPDATE/DELETE sin WHERE se bloquean salvo opt-in
  explícito, y `dryRun` permite previsualizar el alcance con rollback.
- **`title` y `annotations` en todas las tools**: el cliente sabe qué tools
  son de solo lectura (`readOnlyHint`) y cuáles destructivas
  (`destructiveHint`), y puede pedir confirmación solo para las peligrosas.
- **Prompts guiados y resources con autocompletado**: flujos predefinidos
  (`analyze-database`, `optimize-query`, `safe-migration`) y URIs
  `mysql://tables/{db}/{table}` con autocompletado de nombres.
- **Progreso y cancelación** en operaciones largas, y **elicitation**
  (confirmación humana) antes de acciones destructivas si el cliente lo
  soporta.
- **Sistema de permisos por capas**: flags globales, permisos por esquema,
  gate de administración y modo multi-DB forzado a solo lectura.
- **Límite de filas por defecto**: los SELECT grandes se truncan con aviso
  para no saturar el contexto del modelo.

## Índice

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Configuración en clientes de IA](#configuración-en-clientes-de-ia)
- [Variables de entorno](#variables-de-entorno)
- [Sistema de permisos](#sistema-de-permisos)
- [Tools disponibles](#tools-disponibles)
- [Prompts guiados](#prompts-guiados)
- [Recursos MCP](#recursos-mcp)
- [Flujos recomendados y ejemplos de prompts](#flujos-recomendados-y-ejemplos-de-prompts)
- [Desarrollo y tests](#desarrollo-y-tests)
- [Solución de problemas](#solución-de-problemas)
- [Notas y limitaciones](#notas-y-limitaciones)

## Requisitos

- Node.js 18 o superior (recomendado 22, ver `.nvmrc`)
- Un servidor MySQL 5.7+/8.x o MariaDB accesible (TCP o socket Unix)
- `pnpm` (o `npm`) para instalar dependencias

## Instalación

Clona o descarga el proyecto y compílalo:

```bash
pnpm install
```

```bash
pnpm build
```

El build genera `dist/index.js`, que es el ejecutable que usan los clientes
MCP. Para probarlo en local:

```bash
node dist/index.js
```

El servidor prueba la conexión a MySQL al arrancar; si las credenciales son
incorrectas termina con error (revisa [Solución de problemas](#solución-de-problemas)).

## Configuración en clientes de IA

Todos los clientes usan el mismo patrón: ejecutar `node` con la ruta absoluta
a `dist/index.js` y pasar la conexión por variables de entorno. Ajusta la ruta
`C:\\mcp\\mcp_mysql` (Windows) o `/ruta/a/mcp_mysql` (macOS/Linux) a tu caso.

### Claude Desktop

Edita el archivo de configuración:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["C:\\mcp\\mcp_mysql\\dist\\index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASS": "tu_password",
        "MYSQL_DB": "mi_base",
        "ALLOW_INSERT_OPERATION": "false",
        "ALLOW_UPDATE_OPERATION": "false",
        "ALLOW_DELETE_OPERATION": "false",
        "ALLOW_DDL_OPERATION": "false"
      }
    }
  }
}
```

Reinicia Claude Desktop después de guardar. Verás las tools `mysql_*`
disponibles en el icono de herramientas.

### Claude Code (CLI)

Opción 1 — comando (registra el servidor para el usuario o el proyecto):

```bash
claude mcp add mysql --env MYSQL_HOST=127.0.0.1 --env MYSQL_PORT=3306 --env MYSQL_USER=root --env MYSQL_PASS=tu_password --env MYSQL_DB=mi_base -- node C:\mcp\mcp_mysql\dist\index.js
```

Opción 2 — archivo `.mcp.json` en la raíz del proyecto (se comparte con el
equipo vía git):

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["C:\\mcp\\mcp_mysql\\dist\\index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASS": "tu_password",
        "MYSQL_DB": "mi_base"
      }
    }
  }
}
```

Comprueba el estado con `claude mcp list` o el comando `/mcp` dentro de una
sesión.

### Cursor

Crea o edita `~/.cursor/mcp.json` (global) o `.cursor/mcp.json` en el
proyecto:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["C:\\mcp\\mcp_mysql\\dist\\index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASS": "tu_password",
        "MYSQL_DB": "mi_base"
      }
    }
  }
}
```

Actívalo en Cursor Settings → MCP.

### VS Code (GitHub Copilot)

Crea `.vscode/mcp.json` en el proyecto. VS Code usa la clave `servers` y
soporta `inputs` para pedir credenciales sin guardarlas en el archivo:

```json
{
  "inputs": [
    {
      "id": "mysql_pass",
      "type": "promptString",
      "description": "Password de MySQL",
      "password": true
    }
  ],
  "servers": {
    "mysql": {
      "command": "node",
      "args": ["C:\\mcp\\mcp_mysql\\dist\\index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASS": "${input:mysql_pass}",
        "MYSQL_DB": "mi_base"
      }
    }
  }
}
```

### Windsurf

Edita `~/.codeium/windsurf/mcp_config.json` con el mismo formato
`mcpServers` que Claude Desktop.

### Modo remoto (Streamable HTTP)

Para exponer el servidor por HTTP (por ejemplo en un contenedor o VM) en vez
de stdio:

```env
IS_REMOTE_MCP=true
REMOTE_SECRET_KEY=un_secreto_largo_y_aleatorio
PORT=3000
```

El servidor escucha en `POST /mcp` (modo stateless, un servidor por request)
y exige el header `Authorization: Bearer <REMOTE_SECRET_KEY>` con comparación
en tiempo constante. Conexión desde Claude Code:

```bash
claude mcp add --transport http mysql http://localhost:3000/mcp --header "Authorization: Bearer un_secreto_largo_y_aleatorio"
```

En otros clientes que soporten HTTP, la configuración equivalente es:

```json
{
  "mcpServers": {
    "mysql": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer un_secreto_largo_y_aleatorio"
      }
    }
  }
}
```

## Variables de entorno

Puedes definirlas en el bloque `env` del cliente MCP o en un archivo `.env`
en la raíz del proyecto (se carga con dotenv al arrancar).

### Conexión

| Variable | Default | Descripción |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | Host del servidor MySQL. |
| `MYSQL_PORT` | `3306` | Puerto TCP. |
| `MYSQL_USER` | `root` | Usuario de conexión. |
| `MYSQL_PASS` | (vacío) | Password del usuario. |
| `MYSQL_DB` | (vacío) | Base de datos por defecto. Si se deja vacía se activa el [modo multi-DB](#modo-multi-db). |
| `MYSQL_SOCKET_PATH` | — | Ruta a socket Unix (ej. `/tmp/mysql.sock`). Si se define, se ignoran host/puerto. |
| `MYSQL_CONNECTION_STRING` | — | Cadena estilo CLI de mysql (`mysql -h HOST -P 3306 -u USER -pPASS base`). Tiene prioridad sobre las variables individuales. |
| `MYSQL_SSL` | `false` | `true` para conectar con SSL/TLS. |
| `MYSQL_SSL_REJECT_UNAUTHORIZED` | `false` | `true` para rechazar certificados no válidos. |
| `MYSQL_TIMEZONE` | — | Timezone de la conexión (ej. `Z`, `+00:00`, `local`). |
| `MYSQL_DATE_STRINGS` | `false` | `true` para recibir fechas como strings en vez de objetos Date. |
| `MYSQL_CONNECT_TIMEOUT` | `10000` | Timeout de conexión en ms. |
| `MYSQL_QUEUE_LIMIT` | `100` | Máximo de peticiones en cola del pool (el pool usa 10 conexiones). |
| `MYSQL_KEEP_ALIVE_INTERVAL` | `300000` | Intervalo del keep-alive del pool en ms (5 minutos). |

### Permisos y seguridad

| Variable | Default | Descripción |
| --- | --- | --- |
| `ALLOW_INSERT_OPERATION` | `false` | Permite INSERT globalmente. |
| `ALLOW_UPDATE_OPERATION` | `false` | Permite UPDATE globalmente. |
| `ALLOW_DELETE_OPERATION` | `false` | Permite DELETE globalmente. |
| `ALLOW_DDL_OPERATION` | `false` | Permite DDL (CREATE/ALTER/DROP/TRUNCATE) globalmente. También habilita `mysql_create_procedure` y `mysql_alter_procedure`. |
| `ALLOW_ADMIN_OPERATION` | `false` | Habilita operaciones administrativas: `mysql_kill_process` y `mysql_variables` con `action=set`. |
| `SCHEMA_INSERT_PERMISSIONS` | — | Permisos INSERT por esquema: `db1:true,db2:false`. Tiene prioridad sobre el flag global para esos esquemas. |
| `SCHEMA_UPDATE_PERMISSIONS` | — | Igual para UPDATE. |
| `SCHEMA_DELETE_PERMISSIONS` | — | Igual para DELETE. |
| `SCHEMA_DDL_PERMISSIONS` | — | Igual para DDL. |
| `MULTI_DB_WRITE_MODE` | `false` | En modo multi-DB, `true` permite escrituras (por defecto se bloquean todas). |
| `MYSQL_DISABLE_READ_ONLY_TRANSACTIONS` | `false` | `true` desactiva las transacciones READ ONLY en consultas de lectura (no recomendado). |
| `MYSQL_ELICIT_CONFIRM` | `true` | `false` desactiva la confirmación interactiva (elicitation) antes de acciones destructivas (KILL, ALTER TABLE, recrear procedures). Solo aplica si el cliente soporta elicitation. |

### Modo remoto

| Variable | Default | Descripción |
| --- | --- | --- |
| `IS_REMOTE_MCP` | `false` | `true` para servir por HTTP (Streamable HTTP) en vez de stdio. |
| `REMOTE_SECRET_KEY` | — | Token Bearer obligatorio en modo remoto. Sin él, el servidor arranca en stdio. |
| `PORT` | `3000` | Puerto HTTP del modo remoto. |

### Exportación de esquema

| Variable | Default | Descripción |
| --- | --- | --- |
| `MYSQL_SCHEMA_EXPORT_DIR` | — | Carpeta destino por defecto de `mysql_export_schema` (evita pasar `outputDir` en cada llamada). |
| `MYSQL_SCHEMA_EXPORT_PATH` | — | Alias legado de la anterior. |
| `MYSQL_SCHEMA_EXPORT_INCLUDE_SAMPLE_ROWS` | `false` | `true` para incluir filas de ejemplo comentadas en `schema.sql`. |

### Logging

| Variable | Default | Descripción |
| --- | --- | --- |
| `ENABLE_LOGGING` | `false` | `true` o `1` para activar logs. Siempre van a stderr (stdout transporta el protocolo MCP). |

### Ejemplo de `.env` completo

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASS=secret
MYSQL_DB=mi_base

ALLOW_INSERT_OPERATION=false
ALLOW_UPDATE_OPERATION=false
ALLOW_DELETE_OPERATION=false
ALLOW_DDL_OPERATION=false
ALLOW_ADMIN_OPERATION=false

MYSQL_SCHEMA_EXPORT_DIR=C:\proyectos\mi-app\db-schema
ENABLE_LOGGING=true
```

## Sistema de permisos

El servidor evalúa cada consulta en capas, de más restrictiva a menos:

1. **Clasificación**: cada sentencia se clasifica (SELECT, INSERT, UPDATE,
   DELETE, DDL...) con un parser SQL y un fallback por palabra clave, de modo
   que sentencias válidas nunca fallan por limitaciones del parser.
2. **Modo multi-DB**: si no hay `MYSQL_DB` configurada, toda escritura se
   bloquea salvo `MULTI_DB_WRITE_MODE=true`.
3. **Permisos por esquema**: si `SCHEMA_*_PERMISSIONS` define el esquema
   objetivo, manda sobre el flag global.
4. **Flags globales**: `ALLOW_INSERT/UPDATE/DELETE/DDL_OPERATION`.
5. **Gate administrativo**: KILL y SET de variables requieren además
   `ALLOW_ADMIN_OPERATION=true`.
6. **Transacciones**: las lecturas corren en transacción `READ ONLY` (el
   propio MySQL bloquea escrituras que se cuelen) y las escrituras permitidas
   corren en transacción con COMMIT/ROLLBACK automático.

Recomendación para producción: todo en `false` (solo lectura) y activar
permisos puntuales por esquema solo cuando haga falta.

### Modo multi-DB

Si `MYSQL_DB` está vacía, el servidor puede consultar cualquier base a la que
tenga acceso el usuario MySQL (usando `base.tabla` o `USE base`). En este modo
las escrituras quedan bloqueadas por defecto.

## Tools disponibles

Las 21 tools devuelven texto legible y `structuredContent` con los mismos
datos en formato máquina. Los errores llegan como `isError: true` con mensaje
descriptivo (nunca rompen la sesión).

### Consulta principal

#### `mysql_query`

Ejecuta cualquier sentencia SQL con validación de permisos y transacciones
automáticas. Es la tool principal para SELECT, SHOW, y (si está permitido)
INSERT/UPDATE/DELETE/DDL.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sql` | string | sí | Sentencia SQL a ejecutar. Usa placeholders `?` con `params` en vez de concatenar valores. |
| `params` | array | no | Valores para los placeholders `?` (prepared statement). Acepta string, number, boolean o null. |
| `maxRows` | number | no | Máximo de filas a devolver (default 500, máx 5000). Si se trunca, la respuesta lo indica con `truncated: true`. |
| `allowFullTableWrite` | boolean | no | Obligatorio (`true`) para ejecutar UPDATE/DELETE **sin WHERE**. Por defecto esas escrituras de tabla completa se bloquean como protección. |
| `dryRun` | boolean | no | `true` ejecuta la escritura en una transacción con ROLLBACK: devuelve los `affectedRows` reales sin aplicar ningún cambio. Ideal para previsualizar UPDATE/DELETE. |

Ejemplo de argumentos:

```json
{
  "sql": "SELECT id, nombre, email FROM usuarios WHERE status = ? LIMIT 20",
  "params": ["activo"]
}
```

La respuesta estructurada incluye `rows`, `columns` (nombre y tipo de cada
columna, para interpretar DECIMAL/DATETIME correctamente), `rowCount`,
`returnedRows`, `truncated`, `warnings` (los warnings de MySQL por truncado o
coerción de tipos) y `durationMs`; en escrituras incluye `operation`,
`affectedRows`, `insertId`, `changedRows` y `dryRun`. Los errores incluyen
código MySQL, hint de corrección y, si una tabla no existe, sugerencias de
nombres parecidos.

### Inspección y análisis

#### `mysql_explain`

Analiza el plan de ejecución de una query con EXPLAIN y sugiere mejoras
automáticas (full scans, filesort, índices no usados...).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sql` | string | sí | Query a analizar (SELECT, UPDATE, DELETE o INSERT). |
| `format` | string | no | `traditional` (default), `json` (el más rico para análisis automático) o `tree` (solo MySQL). |
| `analyze` | boolean | no | `true` ejecuta además `EXPLAIN ANALYZE` (MariaDB: `ANALYZE FORMAT=JSON`) para comparar filas estimadas vs reales. Solo SELECT porque ejecuta la query real. Default `false`. |

Además del plan, siempre devuelve `issues`: una lista priorizada
(`critical`/`warning`/`info`) extraída del plan JSON — full scans con filas
examinadas, filesort, tablas temporales — con sugerencias de índices
**compuestos** deducidos de las condiciones del WHERE. Detecta el motor
(MySQL/MariaDB) automáticamente.

#### `mysql_describe`

Estructura completa de una tabla: columnas, índices agrupados, foreign keys
salientes **y entrantes** (`referencedBy`: qué tablas referencian a esta —
clave para prever efectos de cascada), triggers de la tabla, CHECK
constraints, estadísticas y el `CREATE TABLE`.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `table` | string | sí | Tabla a describir. Si no existe, el error sugiere nombres parecidos. |
| `database` | string | no | Base de datos (usa la actual si se omite). |
| `includeSampleRows` | boolean | no | `true` incluye hasta 3 filas recientes de ejemplo. Default `false`. |

#### `mysql_data_dictionary`

Genera un diccionario de datos pensado para dar contexto a una IA: por cada
tabla incluye columnas, primary key, foreign keys, índices, filas de ejemplo
y un propósito inferido heurísticamente.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a documentar. Opcional si `MYSQL_DB` está configurada. |
| `table` | string | no | Tabla concreta. Si se omite documenta todas las tablas base. |
| `format` | string | no | `json` (default, estructurado) o `markdown` (legible). |
| `sampleRowsLimit` | number | no | Filas de ejemplo por tabla (default 3, 0 desactiva, máx 50). |
| `maxTables` | number | no | Máximo de tablas a documentar en esta llamada (paginación para bases grandes). |
| `offsetTables` | number | no | Tablas a saltar (orden alfabético) antes de documentar. Combínalo con `maxTables` para paginar. |

Extras para precisión de la IA: los valores permitidos de columnas ENUM/SET
se devuelven como lista explícita (`allowedValues`), los índices incluyen su
cardinalidad (señal de selectividad), y la respuesta incluye un `schemaHash`
estable — si dos llamadas devuelven el mismo hash, el esquema no cambió.
Emite notificaciones de progreso por tabla y soporta cancelación.

Ejemplo de argumentos:

```json
{
  "database": "mi_base",
  "format": "markdown",
  "sampleRowsLimit": 3
}
```

#### `mysql_show_views`

Lista las vistas o describe una vista concreta (columnas, definición SQL, si
es actualizable, definer y tipo de seguridad).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base donde buscar. Si se omite busca en todas. |
| `viewName` | string | no | Vista concreta a describir. Si se omite lista todas. |

#### `mysql_routine_impact`

Análisis de impacto antes de modificar una stored procedure o function: busca
dónde se usa dentro de procedures, functions, views, triggers y events, con
snippet del punto de uso. En bases grandes prefiltra por metadata y verifica
con `SHOW CREATE`.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `routineName` | string | sí | Nombre de la rutina a buscar. |
| `database` | string | no | Base donde buscar. Opcional si `MYSQL_DB` está configurada. |
| `routineType` | string | no | `auto` (default, lo infiere), `procedure` o `function`. |
| `includeSnippets` | boolean | no | Incluir snippet del uso detectado. Default `true`. |

#### `mysql_foreign_keys`

Mapa de relaciones entre tablas: qué tablas referencian a cuáles y quién las
referencia, con reglas ON UPDATE/ON DELETE.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a analizar. Si se omite analiza todas. |
| `table` | string | no | Tabla concreta (muestra relaciones en ambas direcciones). |
| `format` | string | no | `json` (default, grafo de relaciones) o `mermaid` (diagrama ER `erDiagram` listo para renderizar o razonar sobre él). |

#### `mysql_table_stats`

Estadísticas por tabla: filas estimadas, tamaño de datos e índices formateado
(KB/MB/GB), espacio libre, fragmentación y totales por base.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a analizar. |
| `table` | string | no | Tabla concreta. |

#### `mysql_index_suggestions`

Detecta problemas de indexación priorizados: tablas sin primary key,
columnas de foreign key sin índice (con el `CREATE INDEX` listo para
ejecutar), **índices redundantes** (prefijo de otro índice, con el `DROP
INDEX` sugerido), **índices sin uso real** (desde `sys.schema_unused_indexes`
cuando está disponible) y columnas candidatas por convención de nombres.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a analizar. Si se omite analiza todas. |

#### `mysql_process_list`

Procesos y queries en ejecución, con análisis: activos vs durmiendo, queries
de más de 30 segundos, agrupación por usuario y comando. Incluye además las
**transacciones InnoDB activas** (`innodbTransactions`: antigüedad, filas
bloqueadas y modificadas) — lo primero que mirar ante bloqueos.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `full` | boolean | no | `true` muestra el texto completo de cada query (default: truncado a 120 caracteres). |
| `user` | string | no | Filtrar por usuario MySQL. |
| `db` | string | no | Filtrar por base de datos. |
| `minTime` | number | no | Solo procesos que lleven al menos estos segundos ejecutándose. |

#### `mysql_query_history`

Historial en memoria de la sesión: SQL ejecutado, duración, filas y éxito o
error de cada consulta y tool. Incluye `stats` agregadas: total, errores,
duración media y las 5 queries más lentas — útil para que la IA revise su
propia sesión.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `limit` | number | no | Número de entradas recientes (default 50, máx 100). |
| `onlyErrors` | boolean | no | `true` devuelve solo las consultas fallidas. |
| `clear` | boolean | no | `true` borra el historial en vez de devolverlo. |

#### `mysql_variables`

Muestra variables de configuración de MySQL agrupadas por categoría, o cambia
una variable (esto último requiere `ALLOW_ADMIN_OPERATION=true`).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `action` | string | no | `show` (default) o `set`. |
| `scope` | string | no | `session` (default) o `global`. Ojo: los cambios `session` se aplican a una conexión del pool y no persisten; usa `global` para cambios duraderos. |
| `filter` | string | no | Patrón de nombre (ej. `max_conn`). |
| `variable` | string | no | Variable a cambiar (requerido con `set`). |
| `value` | string | no | Nuevo valor (requerido con `set`). |

### Exportación y datos

#### `mysql_export_data`

Exporta los datos de **una tabla** a JSON, CSV o SQL (INSERTs listos para
reproducir), con filtro WHERE, selección de columnas y límite opcionales.
No es un backup completo de la base — para el DDL usa `mysql_export_schema`
o `mysql_generate_migration_files`. (Nombre anterior: `mysql_backup`, que
sigue funcionando como alias.)

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `table` | string | sí | Tabla a exportar. Si no existe, el error sugiere nombres parecidos. |
| `format` | string | no | `json` (default), `csv` o `sql` (sentencias INSERT). |
| `database` | string | no | Base de datos. |
| `columns` | array | no | Columnas a exportar (default: todas). Evita `SELECT *` en tablas anchas. |
| `whereClause` | string | no | Condiciones sin la palabra `WHERE` (ej. `status = 'activo' AND created_at > '2026-01-01'`). |
| `limit` | number | no | Máximo de filas (entero positivo). |
| `outputFile` | string | no | Si se indica, escribe el export a ese archivo y devuelve un resumen (filas, bytes, ruta) en vez de volcar los datos al contexto. |

#### `mysql_export_schema`

Vuelca el DDL completo a disco: `schema.sql` con tablas y triggers, más
carpetas `procedures/`, `functions/`, `views/`, `triggers/` y `events/` con
un archivo `.sql` por objeto (incluye `DROP IF EXISTS` y delimitadores).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a exportar. Opcional si `MYSQL_DB` está configurada. |
| `outputDir` | string | no | Carpeta destino. Opcional si `MYSQL_SCHEMA_EXPORT_DIR` está configurada. |
| `outputPath` | string | no | Alias legado de `outputDir`. |
| `includeDatabaseStatement` | boolean | no | Incluir `CREATE DATABASE` y `USE` al inicio. Default `true`. |

Estructura generada:

```text
db-schema/
  schema.sql
  procedures/
    SP_LOGIN.sql
  functions/
    FN_TOTAL_USUARIO.sql
  views/
    VW_USUARIOS_ACTIVOS.sql
  triggers/
  events/
```

### Comparación y migración

#### `mysql_compare_schemas`

Compara la estructura de dos bases: tablas que solo existen en una, columnas
distintas (tipo/nulabilidad, con `severity: breaking|safe`), índices
distintos (columnas/unicidad), opciones de tabla (engine, collation) y
**rutinas/vistas/triggers** comparados por hash de definición
(`objectDifferences`). Útil para detectar drift entre entornos (dev vs
prod).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sourceDb` | string | sí | Base origen (la referencia). |
| `targetDb` | string | sí | Base destino a comparar. |

#### `mysql_sync_migration`

Genera un script SQL para **sincronizar dos bases existentes** (diff de
esquemas): `CREATE TABLE` de tablas faltantes, `ALTER TABLE` de columnas y
`DROP` comentados por seguridad. Marca explícitamente las operaciones con
posible **pérdida de datos** (⚠️) e incluye al final la **migración inversa
(DOWN)** para revertir los cambios. Revísalo siempre antes de ejecutarlo.
No confundir con `mysql_generate_migration_files`, que convierte UNA base en
archivos de migración por tabla. (Nombre anterior:
`mysql_generate_migration`, que sigue funcionando como alias.)

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sourceDb` | string | sí | Base origen (estado deseado). |
| `targetDb` | string | sí | Base destino (la que se modificaría). |

#### `mysql_generate_migration_files`

Convierte el esquema en **migraciones estilo Laravel**: un archivo `.sql`
por tabla con prefijo de fecha y secuencia
(`2026_08_04_000001_create_users_table.sql`), **ordenados topológicamente
por dependencias de foreign keys** — ejecutarlos en orden de nombre nunca
falla. Casuísticas cubiertas:

- Ciclos de FKs (A→B→A) y FKs hacia otras bases: las constraints afectadas
  se retiran del `CREATE TABLE` y se difieren a un archivo final
  `add_foreign_keys.sql` (con el motivo comentado).
- FKs auto-referenciadas: se mantienen inline (no rompen el orden).
- Genera también functions y procedures (antes de las vistas, porque una
  vista puede usarlas), vistas ordenadas por dependencias entre vistas
  (`CREATE OR REPLACE`), triggers y events, cada uno con `DROP IF EXISTS` y
  bloques `DELIMITER`.
- Elimina `DEFINER` (rompe al importar en otro servidor) y el contador
  `AUTO_INCREMENT=N`; usa `CREATE TABLE IF NOT EXISTS` para que las
  migraciones sean re-ejecutables.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base origen. Opcional si `MYSQL_DB` está configurada. |
| `outputDir` | string | no | Carpeta destino. Opcional si `MYSQL_SCHEMA_EXPORT_DIR` está configurada (usa `<dir>/migrations`). |
| `datePrefix` | string | no | Prefijo de fecha `YYYY_MM_DD`. Default: hoy. |
| `startSequence` | number | no | Secuencia inicial (default 1 → `000001`). |
| `ifNotExists` | boolean | no | `CREATE TABLE IF NOT EXISTS`. Default `true`. |
| `includeViews` | boolean | no | Generar vistas. Default `true`. |
| `includeRoutines` | boolean | no | Generar functions/procedures. Default `true`. |
| `includeTriggers` | boolean | no | Generar triggers. Default `true`. |
| `includeEvents` | boolean | no | Generar events. Default `true`. |
| `stripDefiner` | boolean | no | Eliminar `DEFINER`. Default `true`. |
| `stripAutoIncrement` | boolean | no | Eliminar `AUTO_INCREMENT=N`. Default `true`. |

Devuelve el `executionOrder` completo (archivo, tipo y objeto en orden de
ejecución), los ciclos detectados y las FKs diferidas. Emite progreso por
tabla y soporta cancelación.

Ejemplo de argumentos:

```json
{
  "database": "onroad",
  "outputDir": "C:\\proyectos\\onroad\\database\\migrations"
}
```

### Ejecución de lógica SQL

#### `mysql_call_procedure`

Ejecuta un stored procedure con `CALL`. Antes de ejecutar **lee la firma
real** desde `information_schema.parameters`: valida el número de valores de
entrada (con mensaje que muestra la firma completa si no coinciden) y
**detecta y devuelve automáticamente los parámetros OUT/INOUT** en el orden
declarado.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `procedureName` | string | sí | Nombre del procedure. Si no existe, el error sugiere nombres parecidos. |
| `params` | array | no | Un valor por cada parámetro IN/INOUT, en el orden declarado. |
| `outParams` | array | no | Solo necesario si la firma no es legible desde `information_schema`: nombres para variables OUT añadidas tras los IN. |
| `database` | string | no | Base donde existe el procedure. |

Ejemplo (los OUT se detectan solos):

```json
{
  "procedureName": "SP_CONTAR_PEDIDOS",
  "params": [42]
}
```

#### `mysql_create_procedure`

Crea un stored procedure nuevo. Requiere permiso DDL. Falla con mensaje claro
si ya existe (usa `mysql_alter_procedure` para modificarlo).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `procedureName` | string | sí | Nombre único del procedure. |
| `procedureBody` | string | sí | Sentencias SQL del cuerpo (van dentro de `BEGIN...END`). |
| `database` | string | no | Base donde crearlo. |
| `parameters` | string | no | Definición de parámetros, ej. `IN user_id INT, OUT total INT`. |
| `characteristics` | object | no | Opcionales: `comment`, `language` (`SQL`), `deterministic` (bool), `containsSql` (`CONTAINS SQL` / `NO SQL` / `READS SQL DATA` / `MODIFIES SQL DATA`), `sqlSecurity` (`DEFINER` / `INVOKER`). |

#### `mysql_alter_procedure`

Modifica un procedure existente con DROP + CREATE (MySQL no soporta ALTER del
cuerpo). Requiere permiso DDL. Guarda la definición previa y **la restaura
automáticamente si el CREATE falla**, para no perder el procedure.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `procedureName` | string | sí | Procedure a modificar. |
| `procedureBody` | string | sí | Nuevo cuerpo SQL. |
| `database` | string | no | Base donde existe. |
| `parameters` | string | no | Nueva definición de parámetros. |
| `characteristics` | object | no | Igual que en `mysql_create_procedure`. |
| `ifExists` | boolean | no | `true` usa `DROP PROCEDURE IF EXISTS` para no fallar si no existe. |

#### `mysql_alter_table`

Ejecuta operaciones `ALTER TABLE` (pasa por la capa de permisos DDL).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `table` | string | sí | Tabla a modificar. |
| `alterStatement` | string | sí | Operación sin el prefijo `ALTER TABLE nombre`. Ej.: `ADD COLUMN edad INT NOT NULL`, `ADD INDEX idx_email (email)`, `DROP COLUMN vieja`. |
| `database` | string | no | Base donde existe la tabla. |

### Administración

Requieren `ALLOW_ADMIN_OPERATION=true`.

#### `mysql_kill_process`

Termina un proceso o consulta de MySQL. Obtén el ID con
`mysql_process_list`. Si el cliente soporta elicitation, pide confirmación
humana antes de ejecutar (desactivable con `MYSQL_ELICIT_CONFIRM=false`); lo
mismo aplica a `mysql_alter_table` y `mysql_alter_procedure`.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `processId` | number | sí | ID del proceso (entero positivo). |
| `mode` | string | no | `connection` (default, cierra la conexión entera) o `query` (aborta solo la sentencia en ejecución). |

## Prompts guiados

El servidor registra prompts MCP que encadenan las tools en el orden
correcto (en Claude aparecen como comandos/plantillas; los argumentos de
base de datos tienen autocompletado):

| Prompt | Argumentos | Qué hace |
| --- | --- | --- |
| `analyze-database` | `database` | Analiza una base completa: diccionario de datos en markdown, diagrama de relaciones en Mermaid y estadísticas, con resumen de entidades y problemas de diseño. |
| `optimize-query` | `sql` | Diagnóstico de una query lenta: EXPLAIN en JSON con issues priorizados, revisión de índices y propuesta de query optimizada con los `CREATE INDEX` exactos. |
| `safe-migration` | `sourceDb`, `targetDb` | Compara dos bases, genera el script de migración (con sección DOWN), señala los cambios con riesgo de pérdida de datos y pide confirmación antes de aplicar nada. |

## Recursos MCP

Además de tools, el servidor expone recursos navegables con **autocompletado
de variables** (al escribir `mysql://tables/mi_base/...` el cliente puede
autocompletar bases, tablas y nombres de rutinas):

| URI | Contenido |
| --- | --- |
| `mysql://tables` | Lista de todas las tablas. |
| `mysql://tables/{base}/{tabla}` | Columnas de una tabla. |
| `mysql://procedures` | Lista de stored procedures. |
| `mysql://procedures/{base}/{nombre}` | Definición y parámetros de un procedure. |
| `mysql://functions` | Lista de functions. |
| `mysql://functions/{base}/{nombre}` | Definición, parámetros y tipo de retorno. |
| `mysql://events` | Lista de eventos programados. |
| `mysql://events/{base}/{nombre}` | Definición y programación de un evento. |
| `mysql://triggers` | Lista de triggers. |
| `mysql://triggers/{base}/{nombre}` | Definición de un trigger. |

## Flujos recomendados y ejemplos de prompts

### Entender una base de datos desconocida

```text
Usa mysql_data_dictionary sobre la base mi_base en formato markdown para
entender todas las tablas, y después mysql_foreign_keys para ver cómo se
relacionan entre sí.
```

### Optimizar una query lenta

```text
Esta query tarda mucho: SELECT ... . Usa mysql_explain con format json y
analyze true para ver el plan real, y mysql_index_suggestions sobre la base
para proponer los índices que faltan.
```

### Modificar una rutina sin romper nada

```text
Usa mysql_routine_impact sobre SP_LOGIN en la base mi_base para ver qué
procedures, functions, views y triggers la referencian antes de modificarla
con mysql_alter_procedure.
```

### Dar contexto completo a otra IA

```text
Quiero que otra IA entienda la base mi_base. Primero usa
mysql_data_dictionary en markdown. Luego usa mysql_export_schema para volcar
el DDL a C:\proyectos\mi-app\db-schema.
```

### Detectar drift entre entornos

```text
Compara los esquemas de mi_base_dev y mi_base_prod con
mysql_compare_schemas y genera el script de sincronización con
mysql_sync_migration. No lo ejecutes: solo muéstramelo.
```

## Desarrollo y tests

```bash
pnpm dev
```

Ejecuta el servidor desde TypeScript sin compilar (tsx).

```bash
pnpm test
```

Prepara la base de test (`scripts/setup-test-db.ts`, requiere MySQL local) y
corre toda la suite con vitest. Suites parciales:

```bash
npx vitest run tests/unit
```

```bash
pnpm lint
```

Corre eslint y markdownlint.

## Solución de problemas

- **`Access denied for user ...` al arrancar**: credenciales incorrectas en
  `.env` o en el bloque `env` del cliente. El servidor prueba la conexión al
  iniciar y termina si falla.
- **El cliente no ve las tools**: comprueba que la ruta a `dist/index.js` es
  absoluta y que ejecutaste `pnpm build` después de actualizar el código.
- **`Error: INSERT/UPDATE/DELETE/DDL operations are not allowed`**: es el
  sistema de permisos. Activa el flag global o el permiso por esquema
  correspondiente.
- **`Killing processes is not allowed` / `Setting MySQL variables is not allowed`**:
  activa `ALLOW_ADMIN_OPERATION=true`.
- **Escrituras bloqueadas sin `MYSQL_DB`**: es el modo multi-DB; define
  `MYSQL_DB` o activa `MULTI_DB_WRITE_MODE=true`.
- **Logs**: exporta `ENABLE_LOGGING=true`. Los logs salen por stderr, así que
  no interfieren con el protocolo MCP.

## Notas y limitaciones

- El diccionario de datos es heurístico: ayuda mucho a una IA, pero no
  reemplaza revisión humana.
- Si una rutina usa SQL dinámico, la detección de dependencias de
  `mysql_routine_impact` puede no ser completa.
- Los cambios de variables con `scope=session` afectan a una conexión del
  pool y no persisten; usa `global` para cambios duraderos.
- `EXPLAIN ANALYZE` ejecuta la consulta real: por eso es opt-in
  (`analyze: true`) y está limitado a SELECT.
- El historial de queries vive en memoria y se pierde al reiniciar el
  servidor (máximo 100 entradas).
- Para producción, mantén los permisos de escritura y administración
  deshabilitados salvo que realmente los necesites.
