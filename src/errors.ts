import { Schema } from "effect"

export class ScanError extends Schema.TaggedErrorClass<ScanError>()("ScanError", {
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class DbError extends Schema.TaggedErrorClass<DbError>()("DbError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
