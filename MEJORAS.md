# Análisis completo del MCP de MySQL — mejoras propuestas

Fecha: 2026-08-04 · Proyecto: `C:\mcp\mcp_mysql` (v2.0.7) · SDK instalado: `@modelcontextprotocol/sdk` 1.30.0

---

## 1. Resumen ejecutivo

El servidor funciona y tiene un catálogo de 22 tools muy completo, pero está construido con la **API antigua de bajo nivel del SDK** (`Server` + `setRequestHandler`) aunque tiene instalada la versión 1.30.0, que ya incluye toda la API moderna. Las tres mejoras con mayor impacto para que una IA "lo entienda todo" son:

1. **Migrar a `McpServer` + `registerTool` con Zod, `outputSchema` y `structuredContent`** — hoy todas las tools devuelven JSON serializado como texto plano; con `outputSchema` el cliente/modelo recibe datos tipados y validados.
2. **Añadir `annotations` y `title` a las 22 tools** — hoy solo `mysql_query` las tiene; el cliente no puede distinguir cuáles son de solo lectura y cuáles destructivas.
3. **Cerrar los bypass de permisos y las inyecciones SQL** — varias tools ejecutan escrituras/DDL sin pasar por el sistema de permisos (`ALLOW_DDL_OPERATION`, etc.) e interpolan identificadores sin escapar.

---

## 2. Investigación de `@modelcontextprotocol/sdk` (agosto 2026)

### Versiones

| Línea | Última versión | Fecha | Spec que implementa |
|---|---|---|---|
| **v1** — `@modelcontextprotocol/sdk` | **1.30.0** (la que tienes instalada) | 2026-07-27 | hasta **2025-11-25** |
| **v2** — paquetes separados | `@modelcontextprotocol/server` / `client` / `core` **2.0.0** | 2026-07-28 | **2026-07-28** (stateless) |

- **No existirá un 2.x bajo el nombre `@modelcontextprotocol/sdk`**: la v2 se dividió en paquetes nuevos (`server`, `client`, `core` + adaptadores `node`/`express`/`fastify`/`hono`), requiere Node ≥ 20 y Zod 4 (o cualquier Standard Schema: Valibot, ArkType). Hay codemod oficial de migración: `npx @modelcontextprotocol/codemod@beta v1-to-v2 .`
- La v1 tendrá soporte (bugs/seguridad) **mínimo 6 meses más**. **Recomendación: quedarse en 1.30.0 hoy** y modernizar dentro de v1; migrar a v2 más adelante con el codemod.
- Zod: la 1.30.0 acepta `zod ^3.25 || ^4.0`. Tu proyecto ya tiene `zod ^4.4.3` — compatible.

### Qué añadió cada revisión del spec

- **2025-03-26**: Streamable HTTP (el que ya usas en modo remoto), OAuth, tool annotations, audio.
- **2025-06-18**: **salida estructurada** (`outputSchema` + `structuredContent`), **elicitation** (el servidor pide datos al usuario), `resource_link` en resultados de tools, campo `title` separado de `name`.
- **2025-11-25**: elicitation por URL, tasks experimentales (peticiones largas con polling), sampling con tools, iconos, valores por defecto en elicitation, y la guía de que los errores de validación de input deben devolverse como `isError: true` (no como error de protocolo) para que el modelo pueda autocorregirse.
- **2026-07-28** (solo v2): protocolo sin estado — desaparecen `initialize` y las sesiones; nuevo RPC `server/discover`; patrón MRTR sustituye a sampling/elicitation iniciados por el servidor; **deprecados Roots, Sampling, Logging y HTTP+SSE** (ventana de 12 meses).

### Capacidades del SDK 1.30.0 que el proyecto NO usa todavía

| Feature | Qué aporta a la IA |
|---|---|
| `McpServer` + `registerTool/registerResource/registerPrompt` | Validación automática de inputs con Zod, capacidades autoinferidas, notificaciones `list_changed` automáticas |
| `outputSchema` + `structuredContent` | El modelo recibe resultados tipados y validados en vez de un string JSON que tiene que re-parsear "a ciegas" |
| `title` en tools | Nombre legible separado del identificador programático |
| `annotations` por tool | `readOnlyHint`, `destructiveHint`, `idempotentHint` — el cliente puede pedir confirmación solo para las peligrosas |
| `ResourceTemplate` (`mysql://tables/{db}/{table}`) | Resources dinámicos con autocompletado de parámetros, en vez de listar miles de resources fijos |
| `completable()` | Autocompletado de nombres de base de datos/tabla/rutina mientras el usuario escribe |
| Prompts registrados | Plantillas reutilizables tipo "analiza este esquema", "optimiza esta query" |
| Progress notifications (`extra.sendNotification`) | Progreso en operaciones largas (export de esquema, diccionario de bases grandes) |
| Cancelación (`extra.signal`) | Abortar queries largas cuando el cliente cancela |
| `server.sendLoggingMessage()` | Logging MCP real por niveles en vez de `console.info/error` |
| Elicitation (`server.server.elicitInput`) | Pedir confirmación humana antes de operaciones destructivas (KILL, DROP, migraciones) |
| `createMcpExpressApp()` | Servidor Express con protección DNS-rebinding activada por defecto |

---

## 3. Bugs y problemas encontrados (línea por línea)

### Críticos

| # | Archivo | Problema |
|---|---|---|
| B1 | `index.ts:900-909` | **Modo HTTP remoto roto para concurrencia**: el comentario dice "create a new instance of transport and server for each request" pero se reutiliza el `mcpServer` singleton, y en `res.on("close")` se hace `server.close()` — el primer request que se cierra **cierra el servidor compartido** para todos los siguientes. |
| B2 | `index.ts:883-887` | **Auth débil**: se valida con `Authorization.endsWith(REMOTE_SECRET_KEY)`. Cualquier token que *termine* en el secreto pasa. Debe ser igualdad exacta `=== "Bearer " + REMOTE_SECRET_KEY` y con `crypto.timingSafeEqual`. |
| B3 | `src/tools/index.ts` (create/alter procedure, kill, variables, call_procedure, backup...) | **Bypass del sistema de permisos**: estas tools usan `executeQuery`/pool directo, que NO valida `ALLOW_DDL_OPERATION` ni los permisos por esquema. Con `ALLOW_DDL_OPERATION=false` la IA aún puede crear/eliminar procedures vía `mysql_create_procedure`/`mysql_alter_procedure`, matar procesos y cambiar variables GLOBAL. Solo `mysql_alter_table` pasa por la capa de permisos. |
| B4 | `index.ts:695-698, 727-729` | **Se descarta `isError`**: el handler de CallTool devuelve `{ content: result.content }` eliminando el flag `isError`. El modelo no puede saber que una tool falló — va contra el spec y contra SEP-1303. |
| B5 | `src/tools/index.ts:183-185` (`mysql_explain`) | `EXPLAIN ANALYZE` **ejecuta la query real**. Para UPDATE/DELETE (y en MariaDB `ANALYZE`) puede **modificar datos** saltándose los permisos. Debe limitarse a SELECT y/o ser opt-in. |
| B6 | `src/tools/index.ts:1324` (`mysql_generate_migration`) | `createSql.replace(new RegExp(sourceDb, "g"), targetDb)` reemplaza el nombre de la BD **en cualquier parte del DDL** (nombres de columnas, comentarios, defaults). Si la BD se llama `app`, una columna `app_id` se convierte en `target_id`. Además no escapa el regex. |

### Importantes

| # | Archivo | Problema |
|---|---|---|
| B7 | `src/db/index.ts:16-18` | El log dice "Multi-DB mode detected - enabling read-only mode for safety" pero **no activa nada** — `MULTI_DB_WRITE_MODE` solo controla un log. La seguridad prometida no existe. |
| B8 | `src/db/utils.ts:27-30` (`extractSchemaFromQuery`) | El regex `db.tabla` hace match con **cualquier identificador con punto**, incluidos alias (`u.id` → detecta esquema "u") y `information_schema.tables`. Los permisos por esquema pueden evaluarse contra un "esquema" equivocado. |
| B9 | `src/db/utils.ts:36-50` (`getQueryTypes`) | Si `node-sql-parser` no puede parsear (SHOW, CALL, SET, EXPLAIN, sintaxis MySQL nueva...), **lanza excepción y la query válida falla**. Necesita fallback por palabra clave inicial. |
| B10 | `src/tools/index.ts:2596` (`mysql_kill_process`) | `KILL ?` con el id como **string** genera `KILL '123'`, que en MySQL es error de sintaxis. Tras validar `Number.isInteger`, interpolar directamente `KILL ${processId}`. |
| B11 | `src/tools/index.ts:287-288` (`mysql_describe`) | `SHOW TABLE STATUS ... LIKE '${table}'` interpola el nombre en un literal — inyección con una comilla. Mejor consultar `information_schema.TABLES` parametrizado. |
| B12 | `src/tools/index.ts:695-701` (`mysql_backup`) | `whereClause` y `limit` se interpolan sin validar y la query corre por `executeQuery` (sin transacción read-only ni permisos). Validar `limit` como entero y ejecutar vía la ruta read-only. |
| B13 | Todo `src/tools/index.ts` | Identificadores (`database`, `table`, nombres de rutinas) se interpolan con backticks **sin escapar backticks internos**. Usar un helper `escapeId` (duplicar `` ` ``) o `mysql2.escapeId`. |
| B14 | `src/tools/index.ts:2070` (`mysql_variables`) | `SET SESSION x = ?` se ejecuta en **una conexión del pool que se devuelve al pool**: no afecta a la "sesión" del usuario y contamina una conexión aleatoria para queries futuras. |
| B15 | `index.ts:152-156` | El `Server` se crea con `process.env.npm_package_version || "1.0.0"` mientras `MCP_VERSION` es "2.0.7" — versión inconsistente reportada al cliente. |
| B16 | `src/tools/index.ts:1162-1173` (`mysql_compare_schemas`) | `indexDifferences: []` se declara pero **nunca se rellena** — la comparación de índices no está implementada. Tampoco compara rutinas, vistas, triggers ni FKs. |
| B17 | `src/tools/index.ts:1434-1443` (`mysql_call_procedure`) | No soporta parámetros **OUT/INOUT** (solo placeholders posicionales IN). No hay forma de recuperar valores de salida (`SET @out` + `SELECT @out`). |
| B18 | `index.ts:166-376` (ListResources) | Carga **todas** las tablas/rutinas/eventos/triggers de todas las BDs en una sola respuesta — en bases grandes es enorme. Sin paginación ni `ResourceTemplate`. |

---

## 4. Mejoras propuestas por tool (para que la IA lo entienda todo)

### Transversales (aplican a las 22 tools)

1. **`outputSchema` + `structuredContent`**: definir el shape de la respuesta de cada tool (p. ej. `mysql_query` → `{ rows, rowCount, truncated, durationMs, warnings }`). El SDK valida la salida automáticamente.
2. **`title` + `annotations` por tool**. Clasificación sugerida:
   - Solo lectura e idempotentes (`readOnlyHint: true, idempotentHint: true`): explain*, describe, data_dictionary, show_views, foreign_keys, table_stats, index_suggestions, process_list, query_history, compare_schemas, routine_impact, variables(show).
   - Escritura no destructiva: backup (lectura pero exporta), export_schema (escribe a disco), create_procedure, call_procedure.
   - **Destructivas** (`destructiveHint: true`): query (según config), alter_table, alter_procedure, kill_process, variables(set), generate_migration (el script, no la ejecución).
3. **Validación de inputs con Zod** vía `registerTool` — hoy los `args` llegan sin validar (`args.sql as string`). Los fallos de validación deben devolverse como `isError: true` con mensaje accionable, para que el modelo se autocorrija.
4. **Límite de filas por defecto en resultados** (`maxRows`, default p. ej. 200) con aviso `truncated: true` — evita reventar el contexto del modelo con SELECTs gigantes.
5. **Mensajes de error enriquecidos**: incluir `code`/`errno`/`sqlState` de mysql2 y una sugerencia ("tabla no existe — usa mysql_describe o revisa el nombre") en la respuesta estructurada.

### Por tool

- **`mysql_query`**: soporte de `params` (prepared statements) para que la IA no concatene valores; `maxRows`; `timeoutMs` (usar `KILL QUERY` o `max_execution_time`); salida estructurada con metadatos de columnas (`Field`, tipo) además de las filas.
- **`mysql_explain`**: default `FORMAT=JSON` (mucho más rico para IA); `EXPLAIN ANALYZE` solo para SELECT y con flag `analyze: true` explícito; detección MariaDB (`ANALYZE FORMAT=JSON`); sugerencias basadas también en el plan JSON (cost, rows_examined_per_scan).
- **`mysql_describe`**: sustituir `SHOW TABLE STATUS LIKE` por `information_schema` parametrizado; opción `includeSampleRows`; incluir triggers de la tabla y CHECK constraints.
- **`mysql_data_dictionary`**: paginación (`offsetTables`/`maxTables`) para BDs grandes; opción de incluir vistas y rutinas; progress notifications; opción de escribir a archivo y devolver `resource_link` en vez de volcar todo al contexto.
- **`mysql_backup`**: validar `limit` como entero; ejecutar por la ruta read-only; opción `outputFile` para exportar a disco (y devolver `resource_link`) en vez de meter miles de filas en el contexto; formato `sql` (INSERTs) además de json/csv.
- **`mysql_export_schema`**: progress notifications por objeto exportado; devolver `resource_link`s a los archivos generados; opción de excluir `DROP ...` para exports "seguros".
- **`mysql_compare_schemas`**: implementar la comparación de **índices** (campo hoy vacío), FKs, vistas, rutinas, triggers y opciones de tabla (engine, collation); salida estructurada con `outputSchema`.
- **`mysql_generate_migration`**: arreglar el replace global (solo tocar el prefijo de esquema con regex anclado a `` `db`. ``); generar también migración inversa (down); avisar de operaciones con pérdida de datos.
- **`mysql_call_procedure`**: soporte OUT/INOUT vía variables de usuario (`CALL p(?, @o); SELECT @o`); devolver múltiples result sets estructurados; gate de permisos (una SP puede escribir).
- **`mysql_routine_impact`**: opción cross-database; incluir también referencias desde `mysql_query_history`; salida estructurada.
- **`mysql_variables`**: en `set`, allowlist de variables seguras + exigir `ALLOW_DDL_OPERATION` (o un flag propio) para GLOBAL; documentar que SESSION en pool no persiste; en `show`, salida estructurada.
- **`mysql_index_suggestions`**: usar `sys.schema_unused_indexes` y `performance_schema` cuando existan; detectar índices duplicados/redundantes (prefijos); estimar selectividad con `COUNT(DISTINCT)` opcional.
- **`mysql_foreign_keys`**: opción `format: "mermaid"` que genere un diagrama ER `erDiagram` — ideal para que la IA (y el humano) visualicen el modelo.
- **`mysql_process_list`**: filtros (`user`, `minTime`, `db`) vía `information_schema.PROCESSLIST` parametrizado.
- **`mysql_kill_process`**: arreglar B10; opción `mode: "query" | "connection"` (`KILL QUERY id` mata solo la query, no la conexión); confirmación vía elicitation.
- **`mysql_create_procedure` / `mysql_alter_procedure`**: pasar por el gate DDL (B3); validar nombre con regex de identificador; `mysql_alter_procedure` debería hacer el DROP+CREATE de forma "transaccional" (guardar definición previa y restaurarla si el CREATE falla — hoy si el CREATE falla la procedure queda **eliminada**).
- **`mysql_query_history`**: añadir `filter` (solo fallidas, por texto); persistencia opcional a archivo; incluir el nombre de tool en entradas de tools.

### Nuevas capacidades MCP (más allá de tools)

- **Resources con `ResourceTemplate`**: `mysql://tables/{db}/{table}`, `mysql://procedures/{db}/{name}`... con `list` paginado y `complete` para autocompletar `{db}` y `{table}`.
- **Prompts registrados**: `analyze-database` (encadena data_dictionary + foreign_keys), `optimize-query` (explain + index_suggestions), `safe-migration` (compare + generate_migration + revisión).
- **Elicitation** antes de acciones destructivas: confirmar KILL, ALTER en producción, ejecución de migraciones.
- **Logging MCP** (`sendLoggingMessage`) en vez de `console.*` — en stdio, escribir a stdout corrompe el protocolo; hoy `log("info")` usa `console.info` (stdout) y solo se salva porque `ENABLE_LOGGING` está apagado por defecto.

---

## 5. Plan de acción recomendado

1. **Fase 1 — Correcciones (sin cambiar API)**: B1–B16 (auth HTTP, isError, bypass de permisos, EXPLAIN ANALYZE, replace de migración, KILL, escapes de identificadores, fallback del parser SQL).
2. **Fase 2 — Modernización SDK v1.30**: migrar a `McpServer` + `registerTool` con Zod, `title`, `annotations`, `outputSchema`/`structuredContent` en las 22 tools. (Compatible con todos los clientes actuales; no rompe nada.)
3. **Fase 3 — Capacidades nuevas**: ResourceTemplates con paginación y autocompletado, prompts, progress, cancelación, elicitation, logging MCP, límites de filas.
4. **Fase 4 — Futuro**: evaluar migración a v2 (`@modelcontextprotocol/server` 2.0.0, spec 2026-07-28) con el codemod oficial cuando el ecosistema de clientes lo soporte; la v1 tiene soporte garantizado ~6 meses más.

---

## 6. Fuentes

- npm: `@modelcontextprotocol/sdk` 1.30.0 (2026-07-27) · `@modelcontextprotocol/server` 2.0.0 (2026-07-28)
- GitHub: modelcontextprotocol/typescript-sdk (docs del tag 1.30.0)
- Spec MCP: changelogs 2025-06-18, 2025-11-25 y 2026-07-28 (modelcontextprotocol.io)
- Blog oficial MCP: "Beta SDKs for the 2026-07-28 MCP Spec Release"