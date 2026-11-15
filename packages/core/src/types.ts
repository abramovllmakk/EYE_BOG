/** Serializable, DB-independent structures produced by the analyzer and the coverage model. */

export type OperationKind = 'query' | 'mutation' | 'subscription';

/** A single GraphQL-over-HTTP request (one element of a batch). */
export interface GraphQLRequest {
  query?: string | null | undefined;
  operationName?: string | null | undefined;
  variables?: Record<string, unknown> | null | undefined;
  extensions?: Record<string, unknown> | null | undefined;
}

export type ArgumentSource = 'literal' | 'variable';

export interface FieldUsage {
  /** Schema coordinate `Type.field`, where Type is the parent type the field was selected on. */
  coordinate: string;
  parentType: string;
  fieldName: string;
  /** Named return type (NonNull/List unwrapped). */
  returnType: string;
  /** Number of selections of this field in the request (aliases count separately). */
  occurrences: number;
  /** Paths from the operation root, e.g. `query.user.posts.author` (field names, not aliases). */
  paths: string[];
  /** Aliases that differ from the field name. */
  aliases: string[];
  /** Named fragments the field was selected through (innermost fragment only). */
  fragments: string[];
  minDepth: number;
  maxDepth: number;
  /** True when every selection depended on an @include/@skip condition that could not be evaluated. */
  conditional: boolean;
}

export interface ArgumentUsage {
  /** `Type.field(arg:)` */
  coordinate: string;
  occurrences: number;
  sources: ArgumentSource[];
}

export interface CoordinateUsage {
  coordinate: string;
  occurrences: number;
}

export interface EdgeUsage {
  from: string;
  field: string;
  to: string;
}

export type AnalysisStatus = 'valid' | 'invalid';

export interface AnalysisResult {
  status: AnalysisStatus;
  errors: string[];
  operationType: OperationKind | null;
  operationName: string | null;
  /** The request touches `__schema` / `__type` (never counted towards coverage). */
  introspection: boolean;
  /** Root field coordinates (`Query.user`) — the "operations" of coverage. */
  rootFields: string[];
  fields: FieldUsage[];
  arguments: ArgumentUsage[];
  /** `Enum.VALUE` used in arguments / input objects. */
  enumValues: CoordinateUsage[];
  /** `Input.field` explicitly passed. */
  inputFields: CoordinateUsage[];
  /** `Union.Member` selected through a fragment. */
  unionMembers: CoordinateUsage[];
  /** Covered relations `Parent.field → NamedChild` for composite return types. */
  edges: EdgeUsage[];
  /**
   * Types used by the request: parents of selected fields, enums and input objects that were
   * passed, unions selected through fragments. `occurrences` = selections / usages of that type.
   */
  types: CoordinateUsage[];
  maxDepth: number;
  /** Distinct field coordinates selected at each depth (root fields have depth 1). */
  depthHistogram: { depth: number; fields: number }[];
}

export interface AnalyzeOptions {
  /**
   * When false the variable values are unknown (e.g. replay of a redacted log):
   * variable-dependent @include/@skip are counted as `conditional` and variable values
   * are not inspected. Defaults to true.
   */
  variablesKnown?: boolean;
}
