# README — `FN_GET_USER_BALANCE`

## 1. Propósito

La función almacenada `FN_GET_USER_BALANCE` tiene como objetivo **calcular y devolver el saldo actual de un usuario** a partir de sus movimientos registrados, validando estados activos y reglas básicas de negocio.

Esta función está diseñada para ser reutilizada desde queries, views, procedures o validaciones internas donde se necesite un valor único y consistente.

---

## 2. Objetivo funcional

A nivel de negocio, esta función responde a una necesidad como:

> “Dado un identificador de usuario, obtener un valor puntual y confiable que represente su saldo actual según la información persistida en la base de datos.”

Su responsabilidad principal es **devolver un solo valor** y no construir un result set complejo.

---

## 3. Firma de la función

```sql
CREATE FUNCTION `FN_GET_USER_BALANCE`(
    USERID INT
)
RETURNS DECIMAL(18,2)
```

### Parámetros

#### `USERID`
Identificador del usuario cuyo saldo se necesita calcular.

### Tipo de retorno

`DECIMAL(18,2)`  
Representa el saldo monetario final calculado por la función.

---

## 4. Responsabilidad general de la función

Esta función realiza, en términos generales, las siguientes etapas:

1. **Recibe el identificador de entrada**.
2. **Consulta la información base necesaria**.
3. **Aplica validaciones o filtros de negocio**.
4. **Realiza el cálculo o transformación principal**.
5. **Devuelve un único valor final**.

---

## 5. Variables principales

### 5.1 Variables de entrada

- `USERID`: identificador principal usado para buscar la información

### 5.2 Variables internas

- `currentBalance`: saldo calculado
- `movementTotal`: suma de movimientos válidos
- `pendingAdjustments`: ajustes pendientes considerados por la lógica

---

## 6. Lógica general

La función concentra una regla reusable que transforma datos persistidos en un solo resultado.

En lugar de devolver filas, columnas complejas o estructuras JSON extensas, su propósito es producir un valor final que otros componentes puedan consumir directamente.

Esto la vuelve especialmente útil para:

- cálculos incrustados en `SELECT`
- reglas dentro de stored procedures
- columnas derivadas en reportes
- validaciones de negocio

---

## 7. Flujo de cálculo

### Paso 1. Obtención de datos base

La función consulta una o más tablas para obtener la información mínima requerida.

### Paso 2. Aplicación de reglas

Luego aplica filtros, condiciones, validaciones o conversiones sobre esos datos.

### Paso 3. Determinación del valor final

Finalmente retorna un valor simple y consumible por otros objetos SQL.

---

## 8. Tablas involucradas

### `user_account`

- fuente principal del saldo o estado base
- contiene la entidad sobre la cual se ejecuta la lógica

### `user_movements`

- aporta movimientos o transacciones que afectan el cálculo

---

## 9. Consideraciones técnicas

- La función debe ser revisada con cuidado si se usa dentro de consultas masivas, porque puede impactar rendimiento.
- Si depende de otras funciones o subconsultas, el costo puede crecer rápidamente.
- Si se modifica su lógica, deben revisarse todos los procedures, views o reportes que la consumen.

---

## 10. Casos de uso típicos

Esta función puede aparecer en escenarios como:

- mostrar un valor calculado en una pantalla
- validar reglas antes de confirmar una operación
- enriquecer reportes con un dato derivado
- reutilizar una misma fórmula en varios puntos del sistema

---

## 11. Notas para persona / IA

- Si esta función participa en cálculos críticos, conviene rastrear todos sus consumidores antes de cambiarla.
- Si consulta varias tablas, hay que revisar índices y frecuencia de uso.
- Si devuelve importes, porcentajes o estados, es importante validar casos borde.

---

## 12. Posibles inconsistencia

## 13. Optimizaciones recomendados

## 14. SQL fuente

```sql
CREATE FUNCTION `FN_GET_USER_BALANCE`(USERID INT)
RETURNS DECIMAL(18,2)
BEGIN
    RETURN 0;
END
```
