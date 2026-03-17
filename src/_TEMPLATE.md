# README — `SP_GET_PSG_MTRAVEL`

## 1. Propósito

El procedimiento almacenado `SP_GET_PSG_MTRAVEL` tiene como objetivo **buscar viajes multitrayecto** (`multiple travel`) entre una ciudad de origen y una ciudad de destino, considerando:

- fechas de búsqueda
- rutas múltiples o conexiones
- disponibilidad de asientos
- precios base y precios dinámicos
- ciudades externas/cercanas
- restricciones por canal
- restricciones por país
- puntos de abordaje y desembarque
- reglas de moneda y conversión
- reglas de viaje de ida / retorno

Este procedimiento no solo devuelve itinerarios directos, sino también **combinaciones de itinerarios enlazados** que forman un viaje compuesto.

---

## 2. Objetivo funcional

A nivel de negocio, este SP responde a una necesidad como:

> “Dado un origen, un destino, una fecha y ciertas condiciones de venta, obtener todas las opciones de viaje múltiple disponibles, incluyendo precios, conexiones, asientos, horarios y ciudades cercanas.”

Es decir, el SP construye una respuesta completa para el motor de búsqueda de viajes multiruta.

---

## 3. Firma del procedimiento

```sql
CREATE PROCEDURE `SP_GET_PSG_MTRAVEL`(
    IN LANGID INT,
    IN JSONDATA JSON
)
```

### Parámetros

#### `LANGID`
Identificador de idioma. Se usa principalmente para configurar `lc_time_names` y afectar formatos/localización.

Valores observados:
- `196` → `es_MX`
- `197` → `en_US`
- cualquier otro → `es_MX`

#### `JSONDATA`
Objeto JSON con todos los filtros de entrada.

### Estructura esperada de `JSONDATA`

```json
{
  "ORIGINID": 1,
  "DESTINYID": 2,
  "CHANNELID": 647,
  "DATEINI": "2026-03-17 00:00:00",
  "DATEEND": "2026-03-18 00:00:00",
  "ORIGINEXTERNALID": 0,
  "DESTINYEXTERNALID": 0,
  "ISPOINT": 0,
  "CURRENCYID": 567,
  "CPERSON": 1,
  "CPERSONDISABILITY": 0,
  "ISRETURN": 0
}
```

---

## 4. Responsabilidad general del SP

Este SP realiza, en términos generales, las siguientes etapas:

1. **Normaliza y valida fechas de entrada**.
2. **Extrae parámetros desde el JSON**.
3. **Calcula precio base del trayecto principal**.
4. **Obtiene la definición de multirruta** mediante `FN_GET_TIMEMULTIROUTE`.
5. **Aplica restricciones por país y configuración**.
6. **Convierte fechas a la zona horaria del origen**.
7. **Calcula precios de ciudades cercanas**.
8. **Resuelve datos descriptivos de origen y destino**.
9. **Sobrescribe dirección con puntos operativos** si existen.
10. **Materializa las multirrutas en tabla temporal `M_ROUTE`**.
11. **Materializa los itinerarios candidatos en `TMP_ITINERARY`**.
12. **Combina segmentos consecutivos** respetando tiempos de conexión.
13. **Calcula el precio final**.
14. **Devuelve una estructura enriquecida con ciudades, tramos, horarios, precios y metadata**.

---

## 5. Variables principales

### 5.1 Variables de entrada procesada

- `ORIGINID`: ciudad origen
- `DESTINYID`: ciudad destino
- `CHANNELID`: canal de venta
- `DATEINI`: fecha inicial de búsqueda
- `DATEEND`: fecha final de búsqueda
- `ORIGINEXTERNALID`: ciudad cercana de origen
- `DESTINYEXTERNALID`: ciudad cercana de destino
- `ISPOINT`: indica si aplica cálculo adicional por punto
- `ISRETURN`: indica si se trata de lógica de retorno
- `CURRENCYID`: moneda de cálculo
- `CPERSON`: cantidad de pasajeros
- `CPERSONDISABILITY`: cantidad de pasajeros con requerimiento especial

### 5.2 Variables de apoyo de negocio

- `DATAMROUTE`: JSON con definición de multirrutas posibles
- `priceId`: identificador del precio base
- `priceTravel`: precio base principal
- `TRAVELPOINT`: precio adicional por punto
- `priceInitCityNear`: precio por ciudad cercana origen
- `priceEndCityNear`: precio por ciudad cercana destino
- `newConversionValue`: factor de conversión monetaria
- `CURRENCY`: abreviatura o nombre corto de la moneda
- `travelTimeTolerance`: tolerancia de tiempo configurable
- `allowSellMexToMex`: flag de venta México → México
- `allowSellMexToMexCityNear`: flag de venta México → México en ciudades cercanas

### 5.3 Variables descriptivas de ciudad

Para origen:
- `cityInit`
- `cityInit2`
- `cityInitAb`
- `stateInit`
- `countryInit`
- `addressInit`
- `lngInit`
- `latInit`

Para destino:
- `cityEnd`
- `cityEnd2`
- `cityEndAb`
- `stateEnd`
- `countryEnd`
- `addressEnd`
- `lngEnd`
- `latEnd`
- `endtz`

---

## 6. Normalización de fechas

Antes de extraer datos desde `JSONDATA`, el SP protege fechas inválidas menores a `2000-01-01`.

```sql
IF STR_TO_DATE(JSON_VALUE(JSONDATA,'$.DATEINI'),'%Y-%m-%d')<'2000-01-01' THEN
    SET JSONDATA = JSON_REPLACE(JSONDATA,'$.DATEINI','2000-01-01');
END IF;
```

Lo mismo ocurre para `DATEEND`.

### Intención
Evitar que fechas basura o vacías rompan la lógica posterior de filtros temporales.

---

## 7. Extracción de parámetros desde JSON

Se usa `JSON_TABLE` para convertir el payload a columnas SQL.

```sql
FROM JSON_TABLE(JSONDATA,'$'
COLUMNS(
    ORIGINIDJSON INT PATH '$.ORIGINID',
    DESTINYIDJSON INT PATH '$.DESTINYID',
    ...
)) dt;
```

### Detalles importantes

- Si `CURRENCYID` viene `NULL` o `0`, se usa `567` por defecto.
- Si `CPERSON` viene `0`, se transforma en `1`.
- `ORIGINEXTERNALID` y `DESTINYEXTERNALID` se convierten a `NULL` si vienen en `0`.

### Objetivo
Asegurar que la lógica siguiente trabaje con valores consistentes.

---

## 8. Cálculo de precio base del viaje

Se consulta `or_price` para obtener el precio entre `ORIGINID` y `DESTINYID` en la moneda solicitada.

```sql
SELECT
    pri0.ID_PRICE,
    pri0.PRICE_BASE,
    ...
INTO priceId, priceTravel, TRAVELPOINT
FROM or_price pri0
WHERE pri0.CITY_INI = ORIGINID
  AND pri0.CITY_END = DESTINYID
  AND pri0.ID_CURRENCY = CURRENCYID;
```

### Qué se calcula aquí

1. `priceId`: registro del precio base.
2. `priceTravel`: monto base del trayecto.
3. `TRAVELPOINT`: recargo por punto si aplica `ISPOINT`.

### Funciones auxiliares involucradas

#### `FN_GET_PRICING(...)`
Función clave del sistema de pricing. Recibe un JSON con contexto del viaje y devuelve:
- monto ajustado cuando `apply = 1`
- detalle de pricing cuando `apply = 0`

#### `FN_GET_POINTFORRULER(...)`
Calcula el recargo o ajuste por viaje con punto asociado.

### Observación
Este SP **no define la lógica de pricing**, sino que la **orquesta** delegando el cálculo a funciones auxiliares.

---

## 9. Obtención de definición de multirruta

```sql
SET DATAMROUTE = IF(priceTravel > 0, IFNULL(FN_GET_TIMEMULTIROUTE(ORIGINID,DESTINYID),'[]'), '[]');
```

### Función auxiliar
#### `FN_GET_TIMEMULTIROUTE(origin, destiny)`
Devuelve la definición JSON de posibles multirrutas entre origen y destino.

Se espera una estructura JSON parecida a:

```json
[
  {
    "id": 10,
    "total": 2,
    "connTime": 3600,
    "routes": [101, 205],
    "citiesInit": [1, 8],
    "citiesEnd": [8, 2],
    "timeMultiroute": 14400,
    "cityRoute": [
      {
        "_rowID": 1,
        "idRoute": 101,
        "departure": 1,
        "arrival": 8,
        "timeDeparture": 0,
        "timeArrival": 7200,
        "iniRouteStp": 1,
        "endRouteStp": 5,
        "stpTypeInit": 473,
        "stpTypeEnd": 475,
        "zoneInit": "-06:00",
        "zoneEnd": "-06:00",
        "travelName": {"companyName": "X"}
      }
    ]
  }
]
```

### Significado
`DATAMROUTE` representa el “mapa” de combinaciones válidas que luego se intentarán materializar con itinerarios reales.

---

## 10. Restricciones por país y configuración

El SP obtiene el país del origen, del destino y del destino cercano si existe.

Luego aplica reglas configurables:

```sql
IF COUNTRY_CITYORIGIN = 142 AND COUNTRY_CITYDESTINY = 142 THEN
    SET DATAMROUTE = IF(allowSellMexToMex, DATAMROUTE, '[]');
END IF;
```

### Regla
Si el origen y destino están en México (`142`), la venta multiruta puede anularse dependiendo de:
- `ticket.allowSellMexToMex`
- `ticket.allowSellMexToMexCityNear`

### Intención
Permitir restricciones operativas o comerciales por territorio.

---

## 11. Conversión de fechas a zona horaria del origen

Si existen multirrutas, el SP ajusta todas las fechas a la zona del origen.

### Variables clave
- `TZORIGIN`
- `FILTERDATE`
- `DATEINI`
- `DATEEND`

### Lógica relevante

```sql
SET FILTERDATE = CONVERT_TZ(CURRENT_TIMESTAMP(),'+00:00',IFNULL(TZORIGIN,'+00:00'));
```

### Reglas importantes

1. Si `DATEINI` viene sin hora o corresponde a otro día, se fija al inicio del día.
2. Si `DATEEND - DATEINI = 0 días`, se suma 1 día.
3. Para canales `647` y `650`, si la búsqueda es para el día actual, se aplica tolerancia configurable.

```sql
SET travelTimeTolerance = IFNULL(travelTimeTolerance * -1, 0);
SET FILTERDATE = DATE_ADD(FILTERDATE,INTERVAL travelTimeTolerance SECOND);
SET DATEINI = DATE_ADD(DATEINI,INTERVAL travelTimeTolerance SECOND);
```

### Intención
Evitar perder opciones de viaje cercanas a la hora actual por desfases mínimos.

---

## 12. Conversión monetaria y ciudades cercanas

### Factor de conversión

```sql
SELECT lstattr0.`LISATTR_VALUE` INTO newConversionValue
FROM or_listdetail ol
LEFT JOIN or_listattrval lstattr0 ON ol.ID_LISTDET = lstattr0.ID_ITEM AND lstattr0.ID_ATTR = 572
WHERE ol.ID_LIST=54 AND ol.`STATUS` = 1 AND ol.ID_LISTDET = CURRENCYID;
```

### Precios de ciudad cercana

- `1035` → ciudad cercana de origen
- `1036` → ciudad cercana de destino

```sql
SELECT ctex_amountsell * newConversionValue INTO priceInitCityNear
FROM `or_city_external`
WHERE `id_citybase` = ORIGINID
  AND id_city = ORIGINEXTERNALID
  AND `type` = 1035;
```

### Intención
Agregar al monto total los costos adicionales por traslado entre ciudad base y ciudad externa/cercana.

---

## 13. Resolución de información descriptiva de ciudades

El SP busca datos enriquecidos de origen y destino:

- nombre de ciudad
- alias
- abreviación
- estado
- país
- dirección
- latitud
- longitud

### Fuente principal
- `or_city`
- `or_state`
- `or_country`
- `or_office`

Se prioriza:

```sql
IFNULL(off0.OFFI_LOCADDRESS, cty0.CITY_ADDRESS)
```

Es decir:
- si existe dirección operativa de oficina, se usa esa
- si no, se usa la dirección general de ciudad

---

## 14. Sobrescritura con puntos operativos

Luego, si existen registros en `or_city_operation_point`, se reemplaza la dirección y coordenadas.

### Para origen

```sql
IF EXISTS (SELECT 1 FROM or_city_operation_point WHERE id_city = ORIGINID AND POINT_TYPE = 'BOARDING') THEN
    SELECT ADDRESS, LATITUDE, LONGITUDE
    INTO addressInit, lngInit, latInit
    FROM or_city_operation_point
    WHERE id_city = ORIGINID AND POINT_TYPE = 'BOARDING';
END IF;
```

### Para destino

```sql
IF EXISTS (SELECT 1 FROM or_city_operation_point WHERE id_city = DESTINYID AND POINT_TYPE = 'DROPOFF') THEN
    SELECT ADDRESS, LATITUDE, LONGITUDE
    INTO addressEnd, lngEnd, latEnd
    FROM or_city_operation_point
    WHERE id_city = DESTINYID AND POINT_TYPE = 'DROPOFF';
END IF;
```

### Importante
Aquí hay una observación técnica importante:

- la tabla parece guardar `LATITUDE` y `LONGITUDE`
- pero el `SELECT ... INTO` asigna:
  - `ADDRESS`
  - `LATITUDE`
  - `LONGITUDE`
- y los mete en:
  - `addressInit`
  - `lngInit`
  - `latInit`

Eso sugiere un posible cruce de variables (`lat` y `lng`) si el nombre lógico esperado era:
- `LATITUDE -> latInit`
- `LONGITUDE -> lngInit`

Conviene revisar eso porque en el código actual parece invertido.

---

## 15. Tabla temporal `M_ROUTE`

Esta tabla materializa la definición JSON de multirrutas a columnas relacionales.

### Estructura

```sql
CREATE TEMPORARY TABLE `M_ROUTE`(
    id INT,
    total INT,
    connTime INT,
    routes JSON,
    r0 INT, r1 INT, r2 INT, r3 INT, r4 INT,
    citiesInit0 INT, citiesInit1 INT, citiesInit2 INT, citiesInit3 INT, citiesInit4 INT,
    citiesEnd0 INT, citiesEnd1 INT, citiesEnd2 INT, citiesEnd3 INT, citiesEnd4 INT,
    timeMultiroute INT,
    KEY `idx_tmp0` (id)
)
```

### Propósito
Facilitar joins posteriores sin depender de JSON dinámico en cada consulta.

### Qué contiene
Por cada multirruta:
- cantidad total de segmentos
- tiempo de conexión
- rutas individuales (`r0..r4`)
- ciudades de inicio y fin por tramo
- duración total estimada

---

## 16. Cálculo de ventana máxima de búsqueda

```sql
SET MAXTIME = (SELECT MAX(timeMultiroute) + MAX(connTime * total) FROM M_ROUTE);
SET FILTERDATEEND = DATE_ADD(DATEINI, INTERVAL IF(MAXTIME > 0, MAXTIME + 86400, 864000) SECOND);
```

### Intención
Expandir la ventana de búsqueda para incluir itinerarios cuya combinación completa podría terminar mucho después del primer tramo.

Esto es importante porque una multirruta puede abarcar varias horas o incluso más de un día.

---

## 17. Tabla temporal `TMP_ITINERARY`

Esta tabla contiene **segmentos de itinerario candidatos** ya enriquecidos, listos para combinarse.

### Estructura

```sql
CREATE TEMPORARY TABLE `TMP_ITINERARY`(
    ID_MULTI INT,
    TOTAL INT,
    ID_ITINERARY INT,
    CITY_INI INT,
    CITY_END INT,
    ID_ROUTE INT,
    ITIN_ALIAS VARCHAR(200),
    LEVELBUS INT,
    TRAVELSEAT JSON,
    TRAVELDATE DATETIME,
    TRAVELENDDATE DATETIME,
    TRAVELENDDATEWAIT DATETIME,
    TRAVELENDDATECONEX DATETIME,
    DATA_ITINERARY JSON,
    ZONEINI VARCHAR(30),
    ZONEEND VARCHAR(30),
    KEY `idx_tmpItVal_composite` (ID_MULTI, TOTAL, ID_ROUTE, CITY_INI, CITY_END, TRAVELDATE)
)
```

### Propósito
Guardar todos los tramos de itinerario posibles, con sus horarios reales, asientos y metadata, para después combinarlos entre sí.

---

## 18. Construcción dinámica de `TMP_ITINERARY`

El SP genera un `INSERT` dinámico usando `GROUP_CONCAT`.

### Qué hace esa consulta
Por cada combinación entre:
- itinerarios reales (`or_itinerary`)
- módulos/canales habilitados (`or_itinerarymodule`)
- definición de multirruta (`DATAMROUTE`)

se crea una fila candidata en `TMP_ITINERARY`.

### Información calculada por fila
- `ID_MULTI`: id de multirruta
- `TOTAL`: cantidad de segmentos
- `ID_ITINERARY`: itinerario real
- `CITY_INI` / `CITY_END`
- `ID_ROUTE`
- alias del itinerario
- nivel de bus
- asientos libres (`FN_GET_SEATTRAVEL`)
- fecha real de salida ajustada
- fecha real de llegada ajustada
- fecha mínima para espera
- fecha máxima para conexión
- metadata JSON del tramo
- zona horaria de inicio y fin

### Funciones auxiliares usadas aquí

#### `FN_GET_SEATTRAVEL(itinerary, cityIni, cityEnd, mode, extra)`
Se usa para obtener disponibilidad de asientos.

Usos detectados:
- modo `3` → detalle o estructura de asientos libres por nivel
- modo `0` → total disponible para validar capacidad

#### `FN_GET_TOTALSEATITINERARY(...)`
Valida disponibilidad específica para pasajeros con requerimiento de discapacidad.

### Reglas de filtrado importantes

1. Itinerario activo y habilitado para el canal.
2. Fecha dentro de la ventana expandida.
3. No salir antes del `FILTERDATE` ajustado.
4. Tener asientos suficientes para `CPERSON`.
5. Tener asientos especiales si `CPERSONDISABILITY > 0`.
6. Validar tipos de parada de inicio y fin.

### Tipos de parada observados
- `473`
- `474`
- `475`

Esto sugiere reglas como:
- permitido iniciar en cierto tipo de stop
- permitido terminar en cierto tipo de stop

---

## 19. Ajuste por postergaciones del itinerario

La subconsulta `itp` suma tiempos de postergación (`or_itinerarypostpone`) por tramo.

### Propósito
Ajustar la hora real de salida y llegada considerando retrasos configurados sobre determinados puntos de ruta.

### Resultado
Genera:
- `timePosponeIni`
- `timePosponeEnd`

Estos valores son aplicados a:
- `TRAVELDATE`
- `TRAVELENDDATE`
- ventanas de espera y conexión

---

## 20. Combinación final de segmentos

La consulta final une `M_ROUTE` con `TMP_ITINERARY` varias veces:

- `itin0`
- `itin1`
- `itin2`
- `itin3`
- `itin4`

### Regla principal
Cada siguiente tramo debe salir:
- después de la llegada del tramo anterior
- dentro de la ventana de conexión permitida

Ejemplo:

```sql
itin1.TRAVELDATE BETWEEN itin0.TRAVELENDDATEWAIT AND itin0.TRAVELENDDATECONEX
```

### Validación adicional
En el `WHERE CASE` final se asegura que los tramos no se solapen temporalmente.

---

## 21. Cálculo del monto final

El monto final (`amount`) resulta de sumar:

1. precio principal ajustado
2. precio por ciudad cercana de origen
3. precio por ciudad cercana de destino

### Lógica principal

```sql
FN_GET_PRICING(JSON_OBJECT(... 'amount', priceTravel ...))
+ FN_GET_PRICING(JSON_OBJECT(... 'amount', IFNULL(priceInitCityNear, 0) ...))
+ FN_GET_PRICING(JSON_OBJECT(... 'amount', IFNULL(priceEndCityNear, 0) ...))
```

### Consideración de retorno
Si `ISRETURN = 1`, el precio principal se recalcula con lógica adicional de retorno.

---

## 22. `idsPricing`: detalle de pricing aplicado

Además del monto final, el SP devuelve `idsPricing`, que es un JSON con el detalle de pricing obtenido con `apply = 0`.

### Propósito
Permitir trazabilidad del pricing:
- promociones aplicadas
- reglas aplicadas
- identificadores de pricing

Esto es muy útil para auditoría, depuración y explicación del precio al usuario.

---

## 23. Construcción del JSON `cities`

La salida incluye un arreglo `cities` donde cada posición representa un tramo del viaje.

Cada objeto combina:
- `DATA_ITINERARY`
- metadata agregada manualmente

### Datos incluidos por tramo
- `_rowID`
- `id`
- `totalNivel`
- `itineraryAlias`
- `travelSeat1`
- `travelSeat2`
- `dateInit`
- `dateEnd`
- `dateEndNext`
- `dateInitTz`
- `dateEndTz`
- `externalCityInit`
- `externalCityEnd`

### Propósito
Entregar al frontend una estructura lista para pintar cada segmento del viaje sin reconstrucción adicional compleja.

---

## 24. Condiciones finales del `HAVING`

```sql
HAVING
    IF(ORIGINEXTERNALID>0, initCityNear IS NOT NULL AND JSON_VALUE(initCityNear,'$.travelDate') >= FILTERDATE, TRUE)
    AND IF(DESTINYEXTERNALID>0, endCityNear IS NOT NULL, TRUE);
```

### Significado
Si se solicitó ciudad cercana:
- debe existir viaje cercano válido de inicio
- debe existir viaje cercano válido de destino

En caso contrario, la combinación se descarta.

---

## 25. Estructura general de salida

El SP devuelve una fila por combinación válida de multiviaje con campos como:

- identificador de multirruta
- alias de la múltiple
- ids de itinerarios por tramo
- datos de ciudad origen/destino
- dirección y coordenadas de abordaje/desembarque
- nombres de rutas
- ids de rutas
- ciudades por tramo
- cantidad de segmentos
- fecha inicial y final
- ciudad externa origen/destino
- información de viaje cercano
- precio base
- moneda
- monto final
- pricing aplicado
- JSON de segmentos (`cities`)

---

## 26. Dependencias importantes

Este SP depende fuertemente de funciones y tablas auxiliares.

### Funciones auxiliares detectadas

#### `FN_GET_OPTIONSBYKEY(key)`
Obtiene configuraciones del sistema.

Usos:
- `ticket.allowSellMexToMex`
- `ticket.allowSellMexToMexCityNear`
- `ticket.general.travelTimeTolerance`
- formato de fecha/hora

#### `FN_GET_TIMEMULTIROUTE(origin, destiny)`
Devuelve definición JSON de multirruta.

#### `FN_GET_PRICING(json)`
Calcula pricing y/o devuelve detalle de pricing.

#### `FN_GET_POINTFORRULER(...)`
Calcula precio o ajuste por punto.

#### `FN_GET_SEATTRAVEL(...)`
Obtiene disponibilidad de asientos.

#### `FN_GET_TOTALSEATITINERARY(...)`
Valida disponibilidad específica de asientos.

#### `FN_GET_CITYBYID(cityId)`
Devuelve nombre o descripción de una ciudad.

#### `FN_GET_TRAVELNEAR(...)`
Devuelve información del viaje asociado a ciudad cercana.

### Tablas principales involucradas

- `or_price`
- `or_city`
- `or_state`
- `or_country`
- `or_city_external`
- `or_city_operation_point`
- `or_itinerary`
- `or_itinerarymodule`
- `or_itinerarypostpone`
- `or_itinerarystop`
- `or_routestop`
- `or_multiple`
- `or_office`
- `or_bus`
- `or_bustype`
- `or_company`
- `or_listdetail`
- `or_listattrval`
- `or_option`
- `or_optionvaluelist`

---

## 27. Flujo resumido del SP

```text
1. Leer JSON de entrada
2. Normalizar fechas
3. Obtener precio base
4. Obtener multirrutas posibles
5. Validar restricciones por país/configuración
6. Ajustar fechas a zona horaria
7. Obtener conversión y precios de ciudades cercanas
8. Resolver datos descriptivos de origen y destino
9. Reemplazar dirección por puntos operativos si existen
10. Crear M_ROUTE desde DATAMROUTE
11. Crear TMP_ITINERARY con tramos candidatos
12. Combinar tramos por ventanas de conexión
13. Calcular monto final
14. Retornar resultado enriquecido
```

---

## 28. Observaciones técnicas importantes

### 28.1 Posible cruce entre latitud y longitud
En la lectura desde `or_city_operation_point`, parece haber inversión entre variables `lat` y `lng`.

Conviene revisar:

```sql
SELECT ADDRESS, LATITUDE, LONGITUDE
INTO addressInit, lngInit, latInit
```

Porque semánticamente debería ser algo como:

```sql
INTO addressInit, latInit, lngInit
```

### 28.2 Riesgo por `GROUP_CONCAT`
La construcción dinámica del `INSERT` a `TMP_ITINERARY` depende de `GROUP_CONCAT`.

Si hay muchos resultados, podría truncarse según `group_concat_max_len`.

### 28.3 Uso intensivo de funciones por fila
Funciones como:
- `FN_GET_PRICING`
- `FN_GET_SEATTRAVEL`
- `FN_GET_TRAVELNEAR`

pueden impactar bastante el rendimiento si el volumen de itinerarios es alto.

### 28.4 Dependencia fuerte de JSON
El SP depende mucho de:
- `JSON_TABLE`
- `JSON_VALUE`
- `JSON_MERGE`
- `JSON_OBJECT`

Esto lo hace flexible, pero también más costoso de mantener y depurar.

### 28.5 Lógica de negocio muy concentrada
Este SP mezcla:
- disponibilidad
- pricing
- reglas de venta
- zonas horarias
- ciudades cercanas
- composición de respuesta

Eso lo vuelve poderoso, pero también complejo.

---

## 29. Recomendaciones de documentación para funciones auxiliares

Si este SP va a servir como ejemplo para una IA que documente otros SP, conviene que cada función auxiliar se documente con esta plantilla:

### Plantilla sugerida

```md
## FN_NOMBRE_FUNCION

### Propósito
Qué resuelve la función.

### Firma
Cómo se invoca.

### Parámetros
Listado detallado.

### Retorno
Tipo de retorno y estructura.

### Reglas internas
Qué valida o calcula.

### Ejemplo de uso
Un ejemplo real.

### Impacto en rendimiento
Si es costosa o no.
```

---

## 30. Cómo debería leerlo una IA

Una IA que documente este tipo de SP debería identificar siempre:

1. **Qué problema de negocio resuelve**.
2. **Qué entra por parámetros**.
3. **Qué tablas toca**.
4. **Qué funciones auxiliares llama**.
5. **Qué tablas temporales crea**.
6. **Qué filtros aplica**.
7. **Cómo calcula el resultado final**.
8. **Qué riesgos técnicos o supuestos tiene**.
9. **Qué devuelve exactamente**.
10. **Dónde están las reglas de negocio más sensibles**.

---

## 31. Ejemplo de resumen ejecutivo corto

`SP_GET_PSG_MTRAVEL` es el motor de búsqueda de viajes múltiples del sistema. Parte de un JSON de entrada, obtiene rutas compuestas posibles, busca itinerarios reales compatibles en fechas y disponibilidad, calcula precios dinámicos incluyendo ciudades cercanas y retorna una respuesta enriquecida lista para consumo del frontend.

---

## 32. Ejemplo de documentación breve de una sección interna

### Sección: puntos operativos de ciudad

**Objetivo:** reemplazar la dirección general de ciudad por una dirección específica de abordaje o desembarque cuando exista configuración operativa.

**Entrada:**
- `ORIGINID`
- `DESTINYID`

**Tabla usada:**
- `or_city_operation_point`

**Regla:**
- si existe `POINT_TYPE = 'BOARDING'`, se usa para origen
- si existe `POINT_TYPE = 'DROPOFF'`, se usa para destino

**Salida afectada:**
- `addressInit`, `latInit`, `lngInit`
- `addressEnd`, `latEnd`, `lngEnd`

---

## 33. Ejemplo de payload de prueba

```sql
CALL SP_GET_PSG_MTRAVEL(
    196,
    JSON_OBJECT(
        'ORIGINID', 10,
        'DESTINYID', 20,
        'CHANNELID', 647,
        'DATEINI', '2026-03-17 00:00:00',
        'DATEEND', '2026-03-18 00:00:00',
        'ORIGINEXTERNALID', NULL,
        'DESTINYEXTERNALID', NULL,
        'ISPOINT', 0,
        'CURRENCYID', 567,
        'CPERSON', 1,
        'CPERSONDISABILITY', 0,
        'ISRETURN', 0
    )
);
```

---

## 34. Ejemplo de cómo usar este documento como patrón

Si se quiere documentar otro SP complejo, seguir este orden:

1. Propósito
2. Firma
3. Parámetros
4. Flujo general
5. Variables clave
6. Tablas involucradas
7. Funciones auxiliares
8. Tablas temporales
9. Reglas de negocio
10. Estructura de salida
11. Riesgos técnicos
12. Ejemplo de ejecución

---

## 35. Conclusión

`SP_GET_PSG_MTRAVEL` es un procedimiento de alto valor y alta complejidad. Funciona como un **orquestador de búsqueda multitrayecto**, combinando disponibilidad, pricing, rutas, zonas horarias, ciudades cercanas y reglas comerciales.

Como documento de ejemplo, este SP es ideal porque muestra casi todos los patrones complejos que una IA debería aprender a documentar en SQL empresarial:

- lectura de JSON
- uso de funciones auxiliares
- tablas temporales
- SQL dinámico
- reglas de negocio por configuración
- enriquecimiento de respuesta
- composición de resultados por segmentos

---

## 36. Recomendación final para estandarizar documentación futura

Para que una IA documente todos los SP del sistema con consistencia, conviene exigir que cada documentación incluya siempre:

- **Propósito funcional**
- **Entrada exacta**
- **Salida exacta**
- **Dependencias**
- **Funciones auxiliares**
- **Tablas temporales**
- **Reglas de negocio**
- **Posibles bugs o riesgos**
- **Ejemplo de ejecución**
- **Resumen ejecutivo**

Con eso, este README puede servir como plantilla base para el resto de procedimientos del sistema.

