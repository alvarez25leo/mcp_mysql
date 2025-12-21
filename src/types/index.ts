export interface SchemaPermissions {
  [schema: string]: boolean;
}

export interface TableRow {
  table_name: string;
  name: string;
  database: string;
  description?: string;
  rowCount?: number;
  dataSize?: number;
  indexSize?: number;
  createTime?: string;
  updateTime?: string;
}

export interface ColumnRow {
  column_name: string;
  data_type: string;
}

// Stored Procedures and Functions
export interface RoutineRow {
  name: string;
  database: string;
  type: 'PROCEDURE' | 'FUNCTION';
  dataType?: string;        // Return type for functions
  parameterList?: string;   // Parameters definition
  description?: string;     // Comment
  definer?: string;
  securityType?: string;
  isDeterministic?: string;
  createTime?: string;
  updateTime?: string;
}

// MySQL Events
export interface EventRow {
  name: string;
  database: string;
  definer?: string;
  timeZone?: string;
  eventType?: string;       // ONE TIME or RECURRING
  executeAt?: string;       // For one-time events
  intervalValue?: number;   // For recurring events
  intervalField?: string;   // YEAR, MONTH, DAY, HOUR, etc.
  starts?: string;
  ends?: string;
  status?: string;          // ENABLED, DISABLED, SLAVESIDE_DISABLED
  description?: string;
  createTime?: string;
  updateTime?: string;
}

// Triggers
export interface TriggerRow {
  name: string;
  database: string;
  tableName: string;
  event: string;            // INSERT, UPDATE, DELETE
  timing: string;           // BEFORE, AFTER
  statement?: string;
  definer?: string;
  createTime?: string;
}
