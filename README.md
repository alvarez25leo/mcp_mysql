# MySQL MCP Server

Servidor MCP para trabajar con MySQL desde un cliente MCP o una IA.
Permite consultar datos, inspeccionar esquema, exportar el DDL y,
si la configuración lo permite, ejecutar operaciones de escritura
controladas.

## Qué hace

- Expone `mysql_query` para ejecutar SQL.
- Soporta modo solo lectura o escritura controlada por variables de entorno.
- Permite permisos por esquema/base de datos.
- Soporta modo multi-DB.
- Expone tools de diagnóstico, análisis y exportación de esquema.

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

Variables útiles para exportación de esquema:

```env
MYSQL_SCHEMA_EXPORT_DIR=/Users/leonardo/Documents/tornado/db-schema
MYSQL_SCHEMA_EXPORT_INCLUDE_SAMPLE_ROWS=true
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
- `mysql_backup`: exporta datos de una tabla a `json` o `csv`.

### Comparación y migración

- `mysql_compare_schemas`: compara dos esquemas.
- `mysql_generate_migration`: genera SQL de migración entre dos esquemas.
- `mysql_routine_impact`: muestra qué objetos referencian una rutina.

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

### `mysql_export_schema`

Vuelca el DDL completo a disco: `schema.sql` más carpetas
`procedures/`, `functions/`, `views/`, `triggers/` y `events/`.

Ejemplo de argumentos:

```json
{
  "database": "tornadoexampleDB",
  "outputDir": "/Users/leonardo/Documents/tornado/db-schema"
}
```

## Ejemplos de prompts para pedirle a la IA

### Ejemplo 1: documentar toda la base

```text
Usa mysql_data_dictionary sobre la base tornadoexampleDB en formato
markdown para entender todas las tablas antes de hacer cambios.
```

### Ejemplo 2: revisar el impacto de una rutina

```text
Usa mysql_routine_impact sobre SP_LOGIN en la base tornadoexampleDB
para ver qué procedures, functions y views la referencian antes de
modificarla.
```

### Ejemplo 3: dar contexto completo a otra IA

```text
Quiero que otra IA entienda la base tornadoexampleDB. Primero usa
mysql_data_dictionary en markdown. Luego usa mysql_export_schema para
volcar el DDL a /Users/leonardo/Documents/tornado/db-schema.
```

## Flujo recomendado para entender un sistema

1. Ejecutar `mysql_data_dictionary` sobre toda la base.
2. Ejecutar `mysql_export_schema` para guardar el esquema.
3. Ejecutar `mysql_show_views` en vistas usadas por reportes o dashboards.
4. Ejecutar `mysql_routine_impact` antes de tocar cualquier rutina.

## Salidas esperadas

Ejemplo de estructura final:

```text
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

- El diccionario de datos es heurístico: ayuda mucho a una IA,
  pero no reemplaza revisión humana.
- Si una rutina usa SQL dinámico, la detección de tablas puede no ser
  completa.
- Para producción, conviene mantener permisos de escritura
  deshabilitados salvo que realmente los necesites.
