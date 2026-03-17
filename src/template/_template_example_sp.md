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

```sql
DELIMITER $$ 

USE `onroad`$$

DROP PROCEDURE IF EXISTS `SP_GET_PSG_MTRAVEL`$$

CREATE DEFINER=`root`@`%` PROCEDURE `SP_GET_PSG_MTRAVEL`(IN LANGID INT,IN JSONDATA JSON) 
BEGIN 
	DECLARE TZORIGIN VARCHAR(30);
	DECLARE queryString LONGTEXT;
	DECLARE ORIGINID, DESTINYID, CHANNELID,ORIGINEXTERNALID, DESTINYEXTERNALID, ISPOINT, ISRETURN INT;
	DECLARE DATEINI, DATEEND,DATETMPFFLAG TIMESTAMP;
	DECLARE DATAMROUTE JSON;	
	DECLARE TIMEWAIT INT DEFAULT 0;		
	DECLARE CURRENCYID,priceId INT;
	DECLARE MAXTIME INT;
	DECLARE CURRENCY VARCHAR(200);
	DECLARE newConversionValue DOUBLE;
	DECLARE priceEndCityNear,priceInitCityNear,priceTravel,TRAVELPOINT DECIMAL (10,2);
	DECLARE cityInit,cityInit2,cityInitAb,stateInit,countryInit,addressInit,cityEnd,cityEnd2,cityEndAb,stateEnd,countryEnd,addressEnd,lngInit,latInit,lngEnd,latEnd,endtz VARCHAR(500);
	DECLARE CPERSON, CPERSONDISABILITY INT;
	DECLARE FILTERDATE, FILTERDATEEND DATETIME;
	DECLARE allowSellMexToMex INT DEFAULT FN_GET_OPTIONSBYKEY('ticket.allowSellMexToMex');
	DECLARE allowSellMexToMexCityNear INT DEFAULT FN_GET_OPTIONSBYKEY('ticket.allowSellMexToMexCityNear');
	DECLARE travelTimeTolerance INT DEFAULT FN_GET_OPTIONSBYKEY('ticket.general.travelTimeTolerance');
	DECLARE COUNTRY_CITYORIGIN, COUNTRY_CITYDESTINY, COUNTRY_CITYDESTINYNEAR INT;
	DECLARE HOURFORMAT VARCHAR(20) DEFAULT IFNULL((SELECT 
			LIDET_DESCRIPSHORT
			FROM `or_option` o
			LEFT JOIN `or_optionvaluelist` ol ON o.id_option = ol.id_option
			LEFT JOIN `or_listdetail` ld ON ol.optval_content = ld.id_listdet
			WHERE o.id_option = 13 AND ol.status = 1 LIMIT 1),'%h:%i %p');	

	IF STR_TO_DATE(JSON_VALUE(JSONDATA,'$.DATEINI'),'%Y-%m-%d')<'2000-01-01' THEN
		SET JSONDATA = JSON_REPLACE(JSONDATA,'$.DATEINI','2000-01-01');
	END IF;
	IF STR_TO_DATE(JSON_VALUE(JSONDATA,'$.DATEEND'),'%Y-%m-%d')<'2000-01-01' THEN
		SET JSONDATA = JSON_REPLACE(JSONDATA,'$.DATEEND','2000-01-01');
	END IF;
 
	SELECT ORIGINIDJSON, DESTINYIDJSON, CHANNELIDJSON, DATEINIJSON, DATEENDJSON, NULLIF(ORIGINEXTERNALIDJSON,0), NULLIF(DESTINYEXTERNALIDJSON,0), IFNULL(NULLIF(CURRENTIDJSON,0),567), ISPOINTJSON,IFNULL(IF(CPERSONJSON=0,1,CPERSONJSON),1),CPERSONDISABILITYJSON,ISRETURNJSON
	INTO ORIGINID, DESTINYID, CHANNELID, DATEINI, DATEEND, ORIGINEXTERNALID, DESTINYEXTERNALID, CURRENCYID, ISPOINT, CPERSON, CPERSONDISABILITY, ISRETURN
	FROM JSON_TABLE(JSONDATA,'$'
	COLUMNS(
		ORIGINIDJSON INT PATH '$.ORIGINID', 
		DESTINYIDJSON INT PATH '$.DESTINYID',
		CHANNELIDJSON INT PATH '$.CHANNELID',
		DATEINIJSON TIMESTAMP PATH '$.DATEINI',
		DATEENDJSON TIMESTAMP PATH '$.DATEEND',
		ORIGINEXTERNALIDJSON INT PATH '$.ORIGINEXTERNALID',
		DESTINYEXTERNALIDJSON INT PATH '$.DESTINYEXTERNALID',
		ISPOINTJSON INT PATH '$.ISPOINT',
		CURRENTIDJSON INT PATH '$.CURRENCYID',
		CPERSONJSON INT PATH '$.CPERSON',
		CPERSONDISABILITYJSON INT PATH '$.CPERSONDISABILITY',
		ISRETURNJSON INT PATH '$.ISRETURN'
	))dt;
	
	SELECT 
	pri0.ID_PRICE,
	pri0.PRICE_BASE,
	IF(ISPOINT,FN_GET_POINTFORRULER(
	IF(ISRETURN,
	FN_GET_PRICING(JSON_OBJECT('amount',FN_GET_PRICING(JSON_OBJECT('amount',pri0.PRICE_BASE,'currencyId',CURRENCYID,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal','isReturn',ISRETURN,IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),'currencyId',CURRENCYID,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),
	FN_GET_PRICING(JSON_OBJECT('amount',pri0.PRICE_BASE,'currencyId',CURRENCYID,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID)))
	),CURRENCYID,0,NULL,ORIGINID,DESTINYID,0),0) AS pointPrice
	INTO priceId,priceTravel,TRAVELPOINT
	FROM or_price pri0
	WHERE pri0.CITY_INI = ORIGINID
	AND pri0.CITY_END = DESTINYID
	AND pri0.ID_CURRENCY = CURRENCYID;
	
	SET DATAMROUTE = IF(priceTravel > 0, IFNULL(FN_GET_TIMEMULTIROUTE(ORIGINID,DESTINYID),'[]'), '[]');
	
	SELECT
		st.ZONE, st.ID_COUNTRY
		INTO TZORIGIN, COUNTRY_CITYORIGIN
	FROM or_city c
	JOIN `or_state` st ON st.ID_STATE = c.ID_STATE
	WHERE c.ID_CITY = ORIGINID;
	
	SELECT
		st.ID_COUNTRY INTO COUNTRY_CITYDESTINY
	FROM or_city c
	JOIN `or_state` st ON st.ID_STATE = c.ID_STATE
	WHERE c.ID_CITY = DESTINYID;
	
	IF DESTINYEXTERNALID IS NOT NULL THEN	
		SELECT
			st.ID_COUNTRY INTO COUNTRY_CITYDESTINYNEAR
		FROM or_city c
		JOIN `or_state` st ON st.ID_STATE = c.ID_STATE
		WHERE c.ID_CITY = DESTINYEXTERNALID;	
	END IF;
	
	IF COUNTRY_CITYORIGIN = 142 AND COUNTRY_CITYDESTINY = 142 THEN
		SET DATAMROUTE = IF(allowSellMexToMex, DATAMROUTE, '[]');
	END IF;
	
	IF COUNTRY_CITYORIGIN = 142 AND COUNTRY_CITYDESTINYNEAR = 142 THEN
		SET DATAMROUTE = IF(allowSellMexToMexCityNear, DATAMROUTE, '[]');
	END IF;
	
	IF DATAMROUTE <> '[]' THEN
		SET FILTERDATE = CONVERT_TZ(CURRENT_TIMESTAMP(),'+00:00',IFNULL(TZORIGIN,'+00:00'));		
		SET DATEINI = IF(TIME(DATEINI) = '00:00:00' OR DATE(DATEINI) > DATE(CURRENT_TIMESTAMP()), CONCAT(DATE(DATEINI), ' 00:00:00'), CONVERT_TZ(DATEINI ,'+00:00',IFNULL(TZORIGIN,'+00:00')));		
		SET DATEEND = CONVERT_TZ(DATEEND ,'+00:00',IFNULL(TZORIGIN,'+00:00'));

		IF TIMESTAMPDIFF(DAY,DATEINI,DATEEND)=0 THEN
			SET DATEEND = DATE_ADD(DATEINI,INTERVAL 1 DAY) ;
		END IF;	

		IF CHANNELID IN (647,650) AND DATE(DATEINI) = DATE(FILTERDATE) THEN
			SET travelTimeTolerance = IFNULL(travelTimeTolerance * -1, 0);
			SET FILTERDATE = DATE_ADD(FILTERDATE,INTERVAL travelTimeTolerance SECOND);
			SET DATEINI = DATE_ADD(DATEINI,INTERVAL travelTimeTolerance SECOND);
		END IF;		

		SELECT lstattr0.`LISATTR_VALUE` INTO newConversionValue
		FROM or_listdetail ol
		LEFT JOIN or_listattrval lstattr0 ON ol.ID_LISTDET = lstattr0.ID_ITEM AND lstattr0.ID_ATTR = 572
		WHERE ol.ID_LIST=54 AND ol.`STATUS` = 1 AND ol.ID_LISTDET = CURRENCYID;

		SELECT ctex_amountsell * newConversionValue INTO priceInitCityNear
		FROM `or_city_external`
		WHERE `id_citybase` = ORIGINID
		AND id_city = ORIGINEXTERNALID
		AND `type` = 1035;

		SELECT ctex_amountsell * newConversionValue INTO priceEndCityNear
		FROM `or_city_external`
		WHERE `id_citybase` = DESTINYID
		AND id_city = DESTINYEXTERNALID
		AND `type` = 1036; 

		SELECT LIDET_DESCRIPSHORT INTO CURRENCY FROM or_listdetail ol WHERE ID_LISTDET = CURRENCYID;	

		SELECT CONCAT(cty0.CITY_NAME ,', ',stat0.ST_ABBREVIATION,' - ',cty0.CITY_ALIAS),CONCAT(cty0.CITY_NAME ,', ',stat0.ST_ABBREVIATION,' (',cty0.CITY_ALIAS,')'),
			cty0.CITY_ABBREVIATION,stat0.ST_NAME,cont0.CONTR_NAME,IFNULL(off0.OFFI_LOCADDRESS,cty0.CITY_ADDRESS),cty0.CITY_LONGITUD,cty0.CITY_LATITUD
		INTO cityInit2,cityInit,cityInitAb,stateInit,countryInit,addressInit,lngInit,latInit
		FROM or_city cty0
		INNER JOIN or_state stat0 ON stat0.ID_STATE = cty0.ID_STATE
		INNER JOIN or_country cont0 ON cont0.ID_COUNTRY = stat0.ID_COUNTRY
		LEFT JOIN or_office off0 ON off0.ID_CITY = cty0.ID_CITY
		WHERE cty0.ID_CITY = ORIGINID
		LIMIT 1;

		SELECT CONCAT(cty0.CITY_NAME ,', ',stat0.ST_ABBREVIATION,' - ',cty0.CITY_ALIAS),CONCAT(cty0.CITY_NAME ,', ',stat0.ST_ABBREVIATION,' (',cty0.CITY_ALIAS,')'),
			cty0.CITY_ABBREVIATION,stat0.ST_NAME,cont0.CONTR_NAME,IFNULL(off0.OFFI_LOCADDRESS,cty0.CITY_ADDRESS),cty0.CITY_LONGITUD,cty0.CITY_LATITUD, stat0.ZONE
		INTO cityEnd2,cityEnd,cityEndAb,stateEnd,countryEnd,addressEnd,lngEnd,latEnd,endtz
		FROM or_city cty0
		INNER JOIN or_state stat0 ON stat0.ID_STATE = cty0.ID_STATE
		INNER JOIN or_country cont0 ON cont0.ID_COUNTRY = stat0.ID_COUNTRY
		LEFT JOIN or_office off0 ON off0.ID_CITY = cty0.ID_CITY
		WHERE cty0.ID_CITY = DESTINYID
		LIMIT 1;
	
	END IF;
	
	DROP TEMPORARY TABLE IF EXISTS `M_ROUTE`;
	CREATE TEMPORARY TABLE `M_ROUTE`(	
	id INT, total INT, connTime INT, routes JSON,
	r0 INT, r1 INT, r2 INT, r3 INT, r4 INT,
	citiesInit0 INT, citiesInit1 INT, citiesInit2 INT, citiesInit3 INT, citiesInit4 INT,
	citiesEnd0 INT, citiesEnd1 INT, citiesEnd2 INT, citiesEnd3 INT, citiesEnd4 INT,
	timeMultiroute INT,
 	KEY `idx_tmp0` (id)
	) ENGINE=INNODB CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

	INSERT M_ROUTE (
		id,total,connTime,routes,
		r0,r1,r2,r3,r4,
		citiesInit0,citiesInit1,citiesInit2,citiesInit3,citiesInit4,
		citiesEnd0,citiesEnd1,citiesEnd2,citiesEnd3,citiesEnd4,
		timeMultiroute
		)
	SELECT 	
		id, total, connTime, routes,
		JSON_VALUE(routes,'$[0]') r0, JSON_VALUE(routes,'$[1]') r1, JSON_VALUE(routes,'$[2]') r2, JSON_VALUE(routes,'$[3]') r3, JSON_VALUE(routes,'$[4]') r4,
		JSON_VALUE(citiesInit,'$[0]') citiesInit0, JSON_VALUE(citiesInit,'$[1]') citiesInit1, JSON_VALUE(citiesInit,'$[2]') citiesInit2, JSON_VALUE(citiesInit,'$[3]') citiesInit3, JSON_VALUE(citiesInit,'$[4]') citiesInit4,	
		JSON_VALUE(citiesEnd,'$[0]') citiesEnd0, JSON_VALUE(citiesEnd,'$[1]') citiesEnd1, JSON_VALUE(citiesEnd,'$[2]') citiesEnd2, JSON_VALUE(citiesEnd,'$[3]') citiesEnd3, JSON_VALUE(citiesEnd,'$[4]') citiesEnd4,
		timeMultiroute
	FROM JSON_TABLE(DATAMROUTE, '$[*]' 
	COLUMNS(
		id INT PATH "$.id",
		citiesInit JSON PATH "$.citiesInit",
		citiesEnd JSON PATH "$.citiesEnd",
		total INT PATH "$.total",
		connTime INT PATH "$.connTime",
		routes JSON PATH "$.routes",
		timeMultiroute INT PATH '$.timeMultiroute'
	))mr0;
	
	SET MAXTIME = (SELECT MAX(timeMultiroute) + MAX(connTime * total) FROM M_ROUTE);	
	
	SET FILTERDATEEND = DATE_ADD(DATEINI, INTERVAL IF(MAXTIME > 0, MAXTIME + 86400, 864000) SECOND);

	SET @@lc_time_names = CASE LANGID WHEN 196 THEN 'es_MX' WHEN 197 THEN 'en_US' ELSE 'es_MX' END;

	DROP TEMPORARY TABLE IF EXISTS `TMP_ITINERARY`;
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
	) ENGINE=INNODB CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci; 

	SELECT	
	GROUP_CONCAT(
	"('",
	CONCAT_WS("','",		
		f.id,
		f.total,
		it.ID_ITINERARY,
		idCityIni,
		idCityEnd,
		it.ID_ROUTE,
		it.ITIN_ALIAS,
		lvl.LIDET_NAME,
		FN_GET_SEATTRAVEL(it.ID_ITINERARY,f.idCityIni,f.idCityEnd,3,NULL),
		DATE_ADD(it.ITIN_INIDATE, INTERVAL timeDeparture + IFNULL(timePosponeIni, 0) SECOND),
		DATE_ADD(it.ITIN_INIDATE, INTERVAL timeArrival + IFNULL(timePosponeEnd, 0) SECOND),
		DATE_ADD(it.ITIN_INIDATE, INTERVAL timeArrival + IFNULL(timePosponeEnd, 0) + TIMEWAIT SECOND),
		DATE_ADD(it.ITIN_INIDATE, INTERVAL timeArrival + IFNULL(timePosponeEnd, 0) + connTime SECOND),
		REPLACE(IF(it.ITIN_HAS_NEWCOMPANY = 1 AND it.ITIN_ID_NEWCOMPANY IS NOT NULL  ,JSON_REPLACE(travelName,'$.companyLogo',ocom.COMP_PHOTO,'$.companyName' ,ocom.COMP_NAME),travelName ),"'",""),
		zoneInit,
		zoneEnd
		),
	"')"
	) INTO queryString
	FROM or_itinerary it 
	JOIN or_itinerarymodule itmd ON itmd.ID_ITINERARY = it.ID_ITINERARY AND itmd.ID_MODULE = CHANNELID AND itmd.STATUS = 1 AND it.status = 1
	LEFT JOIN or_bus bus ON it.ID_BUS = bus.ID_BUS
	LEFT JOIN or_bustype bty ON bus.ID_BUSTYPE  = bty.ID_BUSTYPE
	LEFT JOIN or_listdetail lvl ON lvl.id_list = 34 AND lvl.ID_LISTDET = bty.ID_NIVEL
	LEFT JOIN `or_company` ocom ON it.ITIN_ID_NEWCOMPANY = ocom.ID_COMP
	LEFT JOIN JSON_TABLE(DATAMROUTE, '$[*]' 
	COLUMNS(
		id INT PATH '$.id',
		total INT PATH '$.total',
		connTime INT PATH '$.connTime',
		NESTED PATH '$.cityRoute[*]' 
		    COLUMNS(
			_rowID INT PATH '$._rowID',
			idRoute INT PATH '$.idRoute',
			idCityIni INT PATH '$.departure',
			idCityEnd INT PATH '$.arrival',
			timeDeparture INT PATH '$.timeDeparture',
			timeArrival INT PATH '$.timeArrival',
			stpTypeInit INT PATH '$.stpTypeInit',
			stpTypeEnd INT PATH '$.stpTypeEnd',
			travelName JSON PATH '$.travelName',
			zoneInit VARCHAR(20) PATH '$.zoneInit',
			zoneEnd VARCHAR(20) PATH '$.zoneEnd'
		    )
	))f ON it.`ID_ROUTE` = f.idRoute
	LEFT JOIN (		
		SELECT
			id,
			it.id_itinerary,
			IFNULL(SUM(IF(iniRouteStp < ROUTSTP_ORDER, 0, ITP_POSTPONETIME)), 0) timePosponeIni,
			IFNULL(SUM(IF(endRouteStp < ROUTSTP_ORDER, 0, ITP_POSTPONETIME)), 0) timePosponeEnd
		FROM or_itinerary it
		JOIN or_itinerarypostpone itp ON itp.ID_ITINERARY = it.ID_ITINERARY AND itp.status = 1
		JOIN or_routestop rs ON itp.ID_ROUTESTOP = rs.ID_ROUTESTOP AND rs.status = 1
		JOIN JSON_TABLE(DATAMROUTE, '$[*]' 
		COLUMNS(
			id INT PATH '$.id',
			NESTED PATH '$.cityRoute[*]' 
			    COLUMNS(				
				idRoute INT PATH '$.idRoute',
				timeDeparture INT PATH '$.timeDeparture',
				iniRouteStp INT PATH '$.iniRouteStp',
				endRouteStp INT PATH '$.endRouteStp'
			    )
		))f ON it.`ID_ROUTE` = f.idRoute
		WHERE it.ITIN_INIDATE BETWEEN DATE_SUB(DATE_SUB(DATEINI, INTERVAL 1 DAY), INTERVAL timeDeparture SECOND) AND DATE_SUB(FILTERDATEEND, INTERVAL timeDeparture SECOND)
		#WHERE DATE_ADD(it.ITIN_INIDATE, INTERVAL timeDeparture SECOND) BETWEEN DATE_SUB(DATEINI, INTERVAL 1 DAY) AND FILTERDATEEND
		GROUP BY it.id_itinerary, id
	) itp ON it.id_itinerary = itp.id_itinerary AND f.id = itp.id
	LEFT JOIN or_itinerarystop isIni ON isIni.ID_ITINERARY = it.ID_ITINERARY AND isIni.ITINSTP_CITYINI = f.idCityIni
	LEFT JOIN or_itinerarystop isEnd ON isEnd.ID_ITINERARY = it.ID_ITINERARY AND isEnd.ITINSTP_CITYEND = f.idCityEnd
	WHERE
	it.ITIN_INIDATE BETWEEN DATE_SUB(DATEINI, INTERVAL timeDeparture SECOND) AND DATE_SUB(FILTERDATEEND, INTERVAL timeDeparture SECOND)
	#DATE_ADD(it.ITIN_INIDATE, INTERVAL timeDeparture SECOND) BETWEEN DATEINI AND FILTERDATEEND
	AND it.ITIN_INIDATE > DATE_SUB(FILTERDATE, INTERVAL timeDeparture SECOND)
	#AND DATE_ADD(it.ITIN_INIDATE, INTERVAL timeDeparture SECOND) > FILTERDATE	
	AND FN_GET_SEATTRAVEL(it.id_itinerary,f.idCityIni,f.idCityEnd,0,NULL) >= CPERSON
	AND IF(NULLIF(CPERSONDISABILITY,0) IS NULL, TRUE, FN_GET_TOTALSEATITINERARY(it.ID_ITINERARY,f.idCityEnd,3,NULL) >= CPERSONDISABILITY)
	AND IF(isIni.ITINSTP_TYPE IS NULL, f.stpTypeInit IN (473,474), isIni.ITINSTP_TYPE IN (473,474))
	AND IF(isEnd.ITINSTP_TYPE IS NULL, f.stpTypeEnd IN (473,475), isEnd.ITINSTP_TYPE IN (473,475));
	
	SET queryString = CONCAT('INSERT TMP_ITINERARY(ID_MULTI, TOTAL, ID_ITINERARY, CITY_INI, CITY_END, ID_ROUTE, ITIN_ALIAS, LEVELBUS, TRAVELSEAT, TRAVELDATE, TRAVELENDDATE, TRAVELENDDATEWAIT, TRAVELENDDATECONEX, DATA_ITINERARY, ZONEINI, ZONEEND) VALUE ', queryString);
	
	IF queryString IS NOT NULL THEN
		PREPARE stmt FROM queryString;
		EXECUTE stmt;
	END IF;
	
	SELECT
	mr0.id,
	rmul0.ROUTMULT_ALIAS multiple,
	itin0.ID_ITINERARY itinID0,
	itin1.ID_ITINERARY itinID1,
	itin2.ID_ITINERARY itinID2,
	itin3.ID_ITINERARY itinID3,
	itin4.ID_ITINERARY itinID4,
	ORIGINID cityInitID,
	cityInit,
	cityInitAb,
	stateInit,
	countryInit,
	addressInit,
	latInit,
	lngInit,
	CONCAT_WS(' - ',itin0.ITIN_ALIAS,itin1.ITIN_ALIAS,itin2.ITIN_ALIAS,itin3.ITIN_ALIAS,itin4.ITIN_ALIAS)routesNames,
	CONCAT_WS(' - ',itin0.ITIN_ALIAS,itin1.ITIN_ALIAS,itin2.ITIN_ALIAS,itin3.ITIN_ALIAS,itin4.ITIN_ALIAS)routesNames2,
	DESTINYID cityEndID,
	cityEnd,
	cityEndAb,
	stateEnd,
	countryEnd,
	addressEnd,
	latEnd,
	lngEnd,
	CONCAT_WS(',',r0,r1,r2,r3,r4) routeIDs,
	
 	CONCAT_WS(',',mr0.citiesInit0,citiesInit1,citiesInit2,citiesInit3,citiesInit4) citiesInit,
 	CONCAT_WS(',',mr0.citiesEnd0,citiesEnd1,citiesEnd2,citiesEnd3,citiesEnd4) citiesEnd,
	
	JSON_LENGTH(mr0.routes)-1 routesCount,	
	itin0.TRAVELDATE dateinit,
	COALESCE(itin4.TRAVELENDDATE, itin3.TRAVELENDDATE, itin2.TRAVELENDDATE, itin1.TRAVELENDDATE) dateEnd,	
	DATE_FORMAT(CONVERT_TZ(COALESCE(itin4.TRAVELENDDATE, itin3.TRAVELENDDATE, itin2.TRAVELENDDATE, itin1.TRAVELENDDATE),IFNULL(endtz,'+00:00'),'+00:00'),'%Y-%m-%d %h:%i %p') dateEndTz,	
	IF(ORIGINEXTERNALID IS NULL, NULL,ORIGINEXTERNALID) externalCityInitID,
	IF(ORIGINEXTERNALID IS NULL, NULL,CONCAT(FN_GET_CITYBYID(ORIGINEXTERNALID),' (',cityInit2,')')) externalCityInit,
	IF(DESTINYEXTERNALID IS NULL, NULL,DESTINYEXTERNALID) externalCityEndID,
	IF(DESTINYEXTERNALID IS NULL, NULL,CONCAT(FN_GET_CITYBYID(DESTINYEXTERNALID),' (',cityEnd2,')')) externalCityEnd,
	IF(ORIGINEXTERNALID IS NULL, NULL, FN_GET_TRAVELNEAR(itin0.TRAVELDATE, itin0.TRAVELDATE, 1035, ORIGINID, ORIGINEXTERNALID, r0)) initCityNear,
	IF(DESTINYEXTERNALID IS NULL, NULL, FN_GET_TRAVELNEAR(COALESCE(itin4.TRAVELENDDATE, itin3.TRAVELENDDATE, itin2.TRAVELENDDATE, itin1.TRAVELENDDATE), COALESCE(itin4.TRAVELENDDATE, itin3.TRAVELENDDATE, itin2.TRAVELENDDATE, itin1.TRAVELENDDATE),1036,DESTINYID,DESTINYEXTERNALID,COALESCE(r4,r3,r2,r1))) endCityNear,	
	TRAVELPOINT pointPrice,
	priceId,
	priceTravel baseAmount,
	CURRENCYID currencyID,
	CURRENCY currency,
	priceTravel,
 	IF(ISRETURN,
		FN_GET_PRICING(JSON_OBJECT('dateTicket',itin0.TRAVELDATE,'amount',FN_GET_PRICING(JSON_OBJECT('idMRoute',id,'dateTicket',itin0.TRAVELDATE,'amount',priceTravel,'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isReturn',ISRETURN,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),
		FN_GET_PRICING(JSON_OBJECT('dateTicket',itin0.TRAVELDATE,'amount',priceTravel,'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID)))
	)
	+ FN_GET_PRICING(JSON_OBJECT('isCityNear', 1, 'cityNear', ORIGINEXTERNALID, 'cityTypeNear', 1035, 'cityBaseNear', ORIGINID, 'dateTicket',itin0.TRAVELDATE,'amount',IFNULL(priceInitCityNear, 0),'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID)))
	+ FN_GET_PRICING(JSON_OBJECT('isCityNear', 1, 'cityNear', DESTINYEXTERNALID, 'cityTypeNear', 1036, 'cityBaseNear', DESTINYID,'dateTicket',itin0.TRAVELDATE,'amount',IFNULL(priceEndCityNear, 0),'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',1,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID)))
	amount,
 	JSON_MERGE(IFNULL(FN_GET_PRICING(JSON_OBJECT('dateTicket',itin0.TRAVELDATE,'amount',priceTravel,'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',0,'general',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),JSON_ARRAY()),
		IFNULL(FN_GET_PRICING(JSON_OBJECT('dateTicket',itin0.TRAVELDATE,'amount',priceTravel,'currencyId',CURRENCYID,'idRoute',r0,'idMRoute',id,'idItinerary',itin0.ID_ITINERARY,'cityIni',ORIGINID,'cityEnd',DESTINYID,'channelSale',CHANNELID,'apply',0,'general',1,'isReturn',1,'isExternal',IFNULL(ORIGINEXTERNALID, DESTINYEXTERNALID))),JSON_ARRAY()))idsPricing,
	JSON_ARRAY(
		JSON_MERGE(
			itin0.DATA_ITINERARY,
			JSON_OBJECT(
			'_rowID',1,
			'id', itin0.ID_ITINERARY,
			'totalNivel',itin0.LEVELBUS,
			'itineraryAlias',itin0.ITIN_ALIAS,
			'travelSeat1',JSON_VALUE(itin0.TRAVELSEAT, '$.free1'),
			'travelSeat2',JSON_VALUE(itin0.TRAVELSEAT, '$.free2'),	
			'dateInit',itin0.TRAVELDATE,
			'dateEnd', itin0.TRAVELENDDATE,
			'dateEndNext', itin1.TRAVELDATE,
			'dateInitTz', CONVERT_TZ(itin0.TRAVELDATE,itin0.ZONEINI,'+00:00'),
			'dateEndTz', CONVERT_TZ(itin0.TRAVELENDDATE,itin0.ZONEEND,'+00:00'),
			'externalCityEnd', NULL,
			'externalCityEndID', NULL,
			'externalCityInit', IF(ORIGINEXTERNALID IS NULL, NULL,FN_GET_CITYBYID(ORIGINEXTERNALID)),
			'externalCityInitID', IF(ORIGINEXTERNALID IS NULL, NULL,ORIGINEXTERNALID)
			)
		),
		JSON_MERGE(
			itin1.DATA_ITINERARY,
			JSON_OBJECT(
			'_rowID',2,
			'id', itin1.ID_ITINERARY,
			'totalNivel',itin1.LEVELBUS,
			'itineraryAlias',itin1.ITIN_ALIAS,
			'travelSeat1',JSON_VALUE(itin1.TRAVELSEAT, '$.free1'),
			'travelSeat2',JSON_VALUE(itin1.TRAVELSEAT, '$.free2'),
			'dateInit',itin1.TRAVELDATE,
			'dateEnd', itin1.TRAVELENDDATE,
			'dateEndNext', itin2.TRAVELDATE,
			'dateInitTz', CONVERT_TZ(itin1.TRAVELDATE,itin1.ZONEINI,'+00:00'),
			'dateEndTz', CONVERT_TZ(itin1.TRAVELENDDATE,itin1.ZONEEND,'+00:00'),
			'externalCityEnd', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 2, FN_GET_CITYBYID(DESTINYEXTERNALID), NULL),
			'externalCityEndID', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 2, DESTINYEXTERNALID, NULL),
			'externalCityInit', NULL,
			'externalCityInitID', NULL			
			)
		),
		IF(mr0.total<3, JSON_OBJECT(), 
			JSON_MERGE(
				itin2.DATA_ITINERARY,
				JSON_OBJECT(
				'_rowID',3,
				'id', itin2.ID_ITINERARY,
				'totalNivel',itin2.LEVELBUS,
				'itineraryAlias',itin2.ITIN_ALIAS,
				'travelSeat1',JSON_VALUE(itin2.TRAVELSEAT, '$.free1'),
				'travelSeat2',JSON_VALUE(itin2.TRAVELSEAT, '$.free2'),
				'dateInit',itin2.TRAVELDATE,
				'dateEnd', itin2.TRAVELENDDATE,
				'dateEndNext', itin3.TRAVELDATE,
				'dateInitTz', CONVERT_TZ(itin2.TRAVELDATE,itin2.ZONEINI,'+00:00'),
				'dateEndTz', CONVERT_TZ(itin2.TRAVELENDDATE,itin2.ZONEEND,'+00:00'),
				'externalCityEnd', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 3, FN_GET_CITYBYID(DESTINYEXTERNALID), NULL),
				'externalCityEndID', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 3, DESTINYEXTERNALID, NULL),
				'externalCityInit', NULL,
				'externalCityInitID', NULL
				)
			)
		),
		IF(mr0.total<4, JSON_OBJECT(),
			JSON_MERGE(
				itin3.DATA_ITINERARY,
				JSON_OBJECT(
				'_rowID',4,
				'id', itin3.ID_ITINERARY,
				'totalNivel',itin3.LEVELBUS,
				'itineraryAlias',itin3.ITIN_ALIAS,
				'travelSeat1',JSON_VALUE(itin3.TRAVELSEAT, '$.free1'),
				'travelSeat2',JSON_VALUE(itin3.TRAVELSEAT, '$.free2'),
				'dateInit',itin3.TRAVELDATE,
				'dateEnd', itin3.TRAVELENDDATE,
				'dateEndNext', itin4.TRAVELDATE,
				'dateInitTz', CONVERT_TZ(itin3.TRAVELDATE,itin3.ZONEINI,'+00:00'),
				'dateEndTz', CONVERT_TZ(itin3.TRAVELENDDATE,itin3.ZONEEND,'+00:00'),
				'externalCityEnd', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 4, FN_GET_CITYBYID(DESTINYEXTERNALID), NULL),
				'externalCityEndID', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 4, DESTINYEXTERNALID, NULL),
				'externalCityInit', NULL,
				'externalCityInitID', NULL
				)
			)
		),
		IF(mr0.total<5, JSON_OBJECT(),
			JSON_MERGE(
				itin4.DATA_ITINERARY,
				JSON_OBJECT(
				'_rowID',5,
				'id', itin4.ID_ITINERARY,
				'totalNivel',itin4.LEVELBUS,
				'itineraryAlias',itin4.ITIN_ALIAS,
				'travelSeat1',JSON_VALUE(itin4.TRAVELSEAT, '$.free1'),
				'travelSeat2',JSON_VALUE(itin4.TRAVELSEAT, '$.free2'),
				'dateInit',itin4.TRAVELDATE,
				'dateEnd', itin4.TRAVELENDDATE,
				'dateEndNext', itin4.TRAVELENDDATE,
				'dateInitTz', CONVERT_TZ(itin4.TRAVELDATE,itin4.ZONEINI,'+00:00'),
				'dateEndTz', CONVERT_TZ(itin4.TRAVELENDDATE,itin4.ZONEEND,'+00:00'),
				'externalCityEnd', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 5, FN_GET_CITYBYID(DESTINYEXTERNALID), NULL),
				'externalCityEndID', IF(DESTINYEXTERNALID IS NOT NULL AND mr0.total = 5, DESTINYEXTERNALID, NULL),
				'externalCityInit', NULL,
				'externalCityInitID', NULL
				)
			)
		)
	)cities
	FROM M_ROUTE mr0
	JOIN or_multiple rmul0 ON rmul0.ID_MULTIPLE = mr0.id
	JOIN TMP_ITINERARY itin0 ON
		itin0.ID_MULTI = mr0.id AND
		itin0.ID_ROUTE = r0 AND
		itin0.TOTAL = mr0.total AND
		itin0.TRAVELDATE BETWEEN DATEINI AND DATEEND AND
		itin0.CITY_INI = mr0.citiesInit0 AND
		itin0.CITY_END = mr0.citiesEnd0
	JOIN TMP_ITINERARY itin1 ON
		itin1.ID_MULTI = mr0.id AND
		itin1.ID_ROUTE = r1 AND
		itin1.TOTAL = mr0.total AND
		itin1.TRAVELDATE BETWEEN itin0.TRAVELENDDATEWAIT AND itin0.TRAVELENDDATECONEX AND
		itin1.CITY_INI = mr0.citiesInit1 AND
		itin1.CITY_END = mr0.citiesEnd1
	LEFT JOIN TMP_ITINERARY itin2 ON
		mr0.total > 2 AND
		itin2.ID_MULTI = mr0.id AND
		itin2.TRAVELDATE BETWEEN itin1.TRAVELENDDATEWAIT AND itin1.TRAVELENDDATECONEX AND
		itin2.ID_ROUTE = r2 AND
		itin2.TOTAL = mr0.total AND
		itin2.CITY_INI = mr0.citiesInit2 AND
		itin2.CITY_END = mr0.citiesEnd2
	LEFT JOIN TMP_ITINERARY itin3 ON
		mr0.total > 3 AND
		itin3.ID_MULTI = mr0.id AND
		itin3.TRAVELDATE BETWEEN itin2.TRAVELENDDATEWAIT AND itin2.TRAVELENDDATECONEX AND
		itin3.ID_ROUTE = r3 AND
		itin3.TOTAL = mr0.total AND
		itin3.CITY_INI = mr0.citiesInit3 AND
		itin3.CITY_END = mr0.citiesEnd3
	LEFT JOIN TMP_ITINERARY itin4 ON
		mr0.total > 4 AND
		itin4.ID_MULTI = mr0.id AND
		itin4.TRAVELDATE BETWEEN itin3.TRAVELENDDATEWAIT AND itin3.TRAVELENDDATECONEX AND
		itin4.ID_ROUTE = r4 AND
		itin4.TOTAL = mr0.total AND
		itin4.CITY_INI = mr0.citiesInit4 AND
		itin4.CITY_END = mr0.citiesEnd4
	WHERE
	CASE mr0.total
		WHEN 2 THEN itin1.TRAVELDATE >= itin0.TRAVELENDDATE
		WHEN 3 THEN itin2.TRAVELDATE >= itin1.TRAVELENDDATE AND itin1.TRAVELDATE >= itin0.TRAVELENDDATE
		WHEN 4 THEN itin3.TRAVELDATE >= itin2.TRAVELENDDATE AND itin2.TRAVELDATE >= itin1.TRAVELENDDATE AND itin1.TRAVELDATE >= itin0.TRAVELENDDATE
		WHEN 5 THEN itin4.TRAVELDATE >= itin3.TRAVELENDDATE AND itin3.TRAVELDATE >= itin2.TRAVELENDDATE AND itin2.TRAVELDATE >= itin1.TRAVELENDDATE AND itin1.TRAVELDATE >= itin0.TRAVELENDDATE	
	END
	HAVING
	IF(ORIGINEXTERNALID>0, initCityNear IS NOT NULL AND JSON_VALUE(initCityNear,'$.travelDate') >= FILTERDATE, TRUE)
	AND IF(DESTINYEXTERNALID>0, endCityNear IS NOT NULL, TRUE);
END$$ 

DELIMITER ;
```
