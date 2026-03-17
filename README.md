# MySQL MCP Server

Servidor MCP para trabajar con MySQL desde un cliente MCP o una IA.
Permite consultar datos, inspeccionar esquema, exportar documentación y,
si la configuración lo permite, ejecutar operaciones de escritura
controladas.

## Qué hace

- Expone `mysql_query` para ejecutar SQL.
- Soporta modo solo lectura o escritura controlada por variables de entorno.
- Permite permisos por esquema/base de datos.
- Soporta modo multi-DB.
- Expone tools de diagnóstico, análisis, exportación y documentación para IA.

## Instalación

```bash
pnpm install
pnpm build
```

Ejecución en local:

```bash
pnpm dev
```

Ejecutar build compilado:

```bash
pnpm start
```

## Variables de entorno básicas

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASS=secret
MYSQL_DB=tornadoexampleDB
ENABLE_LOGGING=true
```

Variables útiles para documentación:

```env
MYSQL_AI_DOCS_DIR=/Users/leonardo/Documents/tornado/docs
MYSQL_SCHEMA_EXPORT_DIR=/Users/leonardo/Documents/tornado/db-schema
MYSQL_SCHEMA_EXPORT_INCLUDE_SAMPLE_ROWS=true
MYSQL_AI_DOCS_ENABLED=true
MYSQL_AI_DOCS_OPENAI_API_KEY=sk-...
MYSQL_AI_DOCS_OPENAI_MODEL=gpt-5
MYSQL_AI_DOCS_TEMPLATE_PATH=/Users/leonardo/Documents/mcp/mysql/src/template/_template_example_sp.md
```

Variables de permisos:

```env
ALLOW_INSERT_OPERATION=false
ALLOW_UPDATE_OPERATION=false
ALLOW_DELETE_OPERATION=false
ALLOW_DDL_OPERATION=false
```

## Tool principal

### `mysql_query`

Ejecuta cualquier SQL. Si la consulta es de escritura, el servidor valida
permisos antes de ejecutarla.

Uso típico:

- consultas `SELECT`
- `SHOW TABLES`
- `CALL procedure(...)`
- `ALTER TABLE` si está permitido

## Tools disponibles

### Inspección y análisis

- `mysql_explain`: analiza planes de ejecución de queries.
- `mysql_describe`: describe una tabla, columnas, índices, foreign keys
  y `CREATE TABLE`.
- `mysql_data_dictionary`: genera diccionario de datos por tabla o por
  base completa en `json` o `markdown`.
- `mysql_show_views`: lista vistas o describe una vista concreta.
- `mysql_foreign_keys`: muestra relaciones entre tablas.
- `mysql_table_stats`: estadísticas de tamaño, filas y fragmentación.
- `mysql_index_suggestions`: sugiere índices faltantes.
- `mysql_process_list`: muestra procesos activos en MySQL.
- `mysql_query_history`: historial de queries y tools ejecutadas.

### Exportación y documentación

- `mysql_export_schema`: exporta el esquema a carpeta con `schema.sql`,
  `procedures/`, `functions/`, `views/`, `triggers/` y `events/`.
- `mysql_document_procedure`: genera un `.md` profesional en español
  para un stored procedure.
- `mysql_document_function`: genera un `.md` profesional en español
  para una function.
- `mysql_document_view`: genera un `.md` profesional en español para una view.
- `mysql_backup`: exporta datos de una tabla a `json` o `csv`.

### Comparación y migración

- `mysql_compare_schemas`: compara dos esquemas.
- `mysql_generate_migration`: genera SQL de migración entre dos esquemas.

### Ejecución de lógica SQL

- `mysql_call_procedure`: ejecuta un stored procedure.
- `mysql_create_procedure`: crea un stored procedure.
- `mysql_alter_procedure`: recrea/modifica un stored procedure.
- `mysql_alter_table`: ejecuta `ALTER TABLE`.

### Administración

- `mysql_variables`: muestra o cambia variables de MySQL.
- `mysql_kill_process`: mata un proceso por ID.
- `mysql_import`: importa un arreglo JSON a una tabla.

## Tools de documentación para IA

Estas son las más útiles si quieres darle contexto a otra IA antes de pedirle cambios:

### `mysql_data_dictionary`

Genera documentación por tabla con:

- columnas
- primary key
- foreign keys
- índices
- filas de ejemplo
- propósito inferido

Ejemplo de argumentos:

```json
{
  "database": "tornadoexampleDB",
  "format": "markdown",
  "sampleRowsLimit": 3
}
```

### `mysql_document_procedure`

Genera `docs/procedures/NOMBRE.md` en español con:

- resumen ejecutivo
- propósito inferido
- parámetros
- tablas con las que interactúa
- filas de ejemplo
- análisis paso a paso del SQL
- SQL fuente opcional
- y, si `documentWithAi=true`, lo reescribe con OpenAI usando el template configurado por env

Ejemplo:

```json
{
  "procedureName": "SP_LOGIN",
  "database": "tornadoexampleDB",
  "outputDir": "/Users/leonardo/Documents/tornado/docs",
  "includeSourceSql": true,
  "documentWithAi": true
}
```

Variables usadas cuando `documentWithAi=true`:

- `MYSQL_AI_DOCS_ENABLED`: si está en `true`, fuerza el uso de OpenAI aunque no envíes `documentWithAi` en el tool
- `MYSQL_AI_DOCS_OPENAI_API_KEY` o `OPENAI_API_KEY`: token de OpenAI
- `MYSQL_AI_DOCS_OPENAI_MODEL`: modelo a usar
- `MYSQL_AI_DOCS_TEMPLATE_PATH`: template Markdown base. Si no se define, usa `src/template/_template_example_sp.md`

### `mysql_document_function`

Genera `docs/functions/NOMBRE.md` con:

- propósito inferido
- tipo de retorno
- parámetros
- tablas consultadas
- análisis paso a paso
- SQL fuente opcional

Ejemplo:

```json
{
  "functionName": "FN_TOTAL_USUARIO",
  "database": "tornadoexampleDB",
  "outputDir": "/Users/leonardo/Documents/tornado/docs",
  "includeSourceSql": true
}
```

### `mysql_document_view`

Genera `docs/views/NOMBRE.md` con:

- propósito inferido
- columnas expuestas
- tablas fuente
- filas de ejemplo
- análisis paso a paso
- SQL fuente opcional

Ejemplo:

```json
{
  "viewName": "VW_USUARIOS_ACTIVOS",
  "database": "tornadoexampleDB",
  "outputDir": "/Users/leonardo/Documents/tornado/docs",
  "includeSourceSql": true
}
```

## Ejemplos de prompts para pedirle a la IA

### Ejemplo 1: documentar toda la base

```text
Usa mysql_data_dictionary sobre la base tornadoexampleDB en formato
markdown para entender todas las tablas antes de hacer cambios.
```

### Ejemplo 2: documentar un procedure

```text
Usa mysql_document_procedure para documentar el stored procedure
SP_LOGIN de la base tornadoexampleDB y guarda el archivo en
/Users/leonardo/Documents/tornado/docs.
```

### Ejemplo 3: generar documentación completa para contexto de IA

```text
Quiero que documentes la base tornadoexampleDB para que otra IA la
entienda. Primero usa mysql_data_dictionary en markdown. Luego
documenta los procedures importantes con mysql_document_procedure,
las functions con mysql_document_function y las views con
mysql_document_view, guardando todo en
/Users/leonardo/Documents/tornado/docs.
```

## Flujo recomendado para documentar un sistema

1. Ejecutar `mysql_data_dictionary` sobre toda la base.
2. Ejecutar `mysql_export_schema` para guardar el esquema.
3. Ejecutar `mysql_document_procedure` en procedures críticos.
4. Ejecutar `mysql_document_function` en functions relevantes.
5. Ejecutar `mysql_document_view` en vistas usadas por reportes o dashboards.

## Salidas esperadas

Ejemplo de estructura final:

```text
docs/
  procedures/
    SP_LOGIN.md
    SP_CREATE_USER.md
  functions/
    FN_TOTAL_USUARIO.md
  views/
    VW_USUARIOS_ACTIVOS.md

db-schema/
  schema.sql
  procedures/
    SP_LOGIN.sql
  functions/
    FN_TOTAL_USUARIO.sql
  views/
    VW_USUARIOS_ACTIVOS.sql
```

## Notas

- La documentación generada es heurística: ayuda mucho a una IA,
  pero no reemplaza revisión humana.
- Si una rutina usa SQL dinámico, la detección de tablas puede no ser
  completa.
- Para producción, conviene mantener permisos de escritura
  deshabilitados salvo que realmente los necesites.
