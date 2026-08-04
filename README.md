# MySQL MCP Server

Servidor MCP (Model Context Protocol) para trabajar con MySQL/MariaDB desde
Claude u otros editores/asistentes de IA. Permite consultar datos, inspeccionar
y documentar el esquema, analizar rendimiento, exportar DDL y, si la
configuración lo permite, ejecutar operaciones de escritura controladas.

Construido sobre la API moderna del SDK oficial (`@modelcontextprotocol/sdk`
1.30, `McpServer` + `registerTool`):

- **Inputs validados con Zod**: si la IA envía argumentos mal formados recibe
  un error claro y accionable (`isError: true`) que le permite autocorregirse.
- **`structuredContent` en las respuestas**: además del texto, cada tool
  devuelve datos estructurados que el modelo puede consumir sin re-parsear.
- **`title` y `annotations` en todas las tools**: el cliente sabe qué tools
  son de solo lectura (`readOnlyHint`) y cuáles destructivas
  (`destructiveHint`), y puede pedir confirmación solo para las peligrosas.
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

Ejemplo de argumentos:

```json
{
  "sql": "SELECT id, nombre, email FROM usuarios WHERE status = ? LIMIT 20",
  "params": ["activo"]
}
```

La respuesta estructurada incluye `rows`, `rowCount`, `returnedRows`,
`truncated` y `durationMs`; en escrituras incluye `operation`,
`affectedRows`, `insertId` y `changedRows`.

### Inspección y análisis

#### `mysql_explain`

Analiza el plan de ejecución de una query con EXPLAIN y sugiere mejoras
automáticas (full scans, filesort, índices no usados...).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sql` | string | sí | Query a analizar (SELECT, UPDATE, DELETE o INSERT). |
| `format` | string | no | `traditional` (default), `json` (el más rico para análisis automático) o `tree`. |
| `analyze` | boolean | no | `true` ejecuta además `EXPLAIN ANALYZE`. Solo aplica a SELECT porque ANALYZE ejecuta la query real. Default `false`. |

#### `mysql_describe`

Estructura completa de una tabla: columnas, índices agrupados, foreign keys,
estadísticas y el `CREATE TABLE`.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `table` | string | sí | Tabla a describir. |
| `database` | string | no | Base de datos (usa la actual si se omite). |

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

#### `mysql_table_stats`

Estadísticas por tabla: filas estimadas, tamaño de datos e índices formateado
(KB/MB/GB), espacio libre, fragmentación y totales por base.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a analizar. |
| `table` | string | no | Tabla concreta. |

#### `mysql_index_suggestions`

Detecta problemas de indexación: tablas sin primary key, columnas de foreign
key sin índice (con el `CREATE INDEX` listo para ejecutar) y columnas
candidatas por convención de nombres (`status`, `*_id`, `email`...).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `database` | string | no | Base a analizar. Si se omite analiza todas. |

#### `mysql_process_list`

Procesos y queries en ejecución, con análisis: activos vs durmiendo, queries
de más de 30 segundos, agrupación por usuario y comando.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `full` | boolean | no | `true` muestra el texto completo de cada query. Default `false`. |

#### `mysql_query_history`

Historial en memoria de la sesión: SQL ejecutado, duración, filas y éxito o
error de cada consulta y tool.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `limit` | number | no | Número de entradas recientes (default 50, máx 100). |
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

#### `mysql_backup`

Exporta los datos de una tabla a JSON o CSV, con filtro WHERE y límite de
filas opcionales.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `table` | string | sí | Tabla a exportar. |
| `format` | string | no | `json` (default) o `csv`. |
| `database` | string | no | Base de datos. |
| `whereClause` | string | no | Condiciones sin la palabra `WHERE` (ej. `status = 'activo' AND created_at > '2026-01-01'`). |
| `limit` | number | no | Máximo de filas (entero positivo). |

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
distintas (tipo/nulabilidad) e índices distintos (columnas/unicidad). Útil
para detectar drift entre entornos (dev vs prod).

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sourceDb` | string | sí | Base origen (la referencia). |
| `targetDb` | string | sí | Base destino a comparar. |

#### `mysql_generate_migration`

Genera un script SQL de migración para que la base destino iguale a la
origen: `CREATE TABLE` de tablas faltantes, `ALTER TABLE` de columnas y
`DROP` comentados por seguridad. Revísalo siempre antes de ejecutarlo.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `sourceDb` | string | sí | Base origen (estado deseado). |
| `targetDb` | string | sí | Base destino (la que se modificaría). |

### Ejecución de lógica SQL

#### `mysql_call_procedure`

Ejecuta un stored procedure con `CALL`, incluyendo procedimientos con
parámetros de salida.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `procedureName` | string | sí | Nombre del procedure. |
| `params` | array | no | Valores IN en el orden que define el procedure. |
| `outParams` | array | no | Nombres para los parámetros OUT/INOUT. Se pasan como variables `@nombre` después de los IN y se devuelven tras la llamada. |
| `database` | string | no | Base donde existe el procedure. |

Ejemplo con OUT:

```json
{
  "procedureName": "SP_CONTAR_PEDIDOS",
  "params": [42],
  "outParams": ["total"]
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
`mysql_process_list`.

| Parámetro | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `processId` | number | sí | ID del proceso (entero positivo). |
| `mode` | string | no | `connection` (default, cierra la conexión entera) o `query` (aborta solo la sentencia en ejecución). |

## Recursos MCP

Además de tools, el servidor expone recursos navegables (útiles en clientes
que soportan resources):

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
mysql_generate_migration. No lo ejecutes: solo muéstramelo.
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
