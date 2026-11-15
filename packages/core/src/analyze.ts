import {
  GraphQLError,
  Kind,
  TypeInfo,
  getNamedType,
  getNullableType,
  getOperationAST,
  getVariableValues,
  isCompositeType,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isListType,
  isUnionType,
  parse,
  print,
  typeFromAST,
  validate,
  visit,
  visitWithTypeInfo,
  type BooleanValueNode,
  type DirectiveNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLInputType,
  type GraphQLSchema,
  type ObjectValueNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
  type VariableDefinitionNode,
} from 'graphql';
import type {
  AnalysisResult,
  AnalyzeOptions,
  ArgumentSource,
  CoordinateUsage,
  GraphQLRequest,
  OperationKind,
} from './types.js';

/** Parsed + validated document, cacheable by query hash (independent of variables). */
export interface PreparedDocument {
  document: DocumentNode | null;
  /** `print(parse(query))` — comments and formatting normalised. */
  normalizedQuery: string | null;
  /** Parse error or validation errors. */
  errors: string[];
}

export function prepareDocument(
  schema: GraphQLSchema,
  query: string | null | undefined,
): PreparedDocument {
  if (!query)
    return { document: null, normalizedQuery: null, errors: ['Must provide query string.'] };
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (err) {
    return { document: null, normalizedQuery: null, errors: [(err as GraphQLError).message] };
  }
  const errors = validate(schema, document).map((e) => e.message);
  return { document, normalizedQuery: print(document), errors };
}

export function analyzeRequest(
  schema: GraphQLSchema,
  request: GraphQLRequest,
  options: AnalyzeOptions = {},
): AnalysisResult {
  return analyzePrepared(schema, prepareDocument(schema, request.query), {
    ...options,
    operationName: request.operationName,
    variables: request.variables,
  });
}

export interface AnalyzePreparedOptions extends AnalyzeOptions {
  operationName?: string | null | undefined;
  variables?: Record<string, unknown> | null | undefined;
}

function emptyResult(errors: string[], op: OperationDefinitionNode | null): AnalysisResult {
  return {
    status: 'invalid',
    errors,
    operationType: op ? (op.operation as OperationKind) : null,
    operationName: op?.name?.value ?? null,
    introspection: false,
    rootFields: [],
    fields: [],
    arguments: [],
    enumValues: [],
    inputFields: [],
    unionMembers: [],
    edges: [],
    maxDepth: 0,
    depthHistogram: [],
  };
}

function selectOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
): { op: OperationDefinitionNode } | { error: string } {
  const op = getOperationAST(document, operationName ?? undefined);
  if (op) return { op };
  // Mirror graphql-js `buildExecutionContext` messages.
  if (operationName) return { error: `Unknown operation named "${operationName}".` };
  const hasOps = document.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION);
  return {
    error: hasOps
      ? 'Must provide operation name if query contains multiple operations.'
      : 'Must provide an operation.',
  };
}

export function analyzePrepared(
  schema: GraphQLSchema,
  prepared: PreparedDocument,
  options: AnalyzePreparedOptions = {},
): AnalysisResult {
  const { document } = prepared;
  if (!document) return emptyResult(prepared.errors, null);

  const selected = selectOperation(document, options.operationName);
  const op = 'op' in selected ? selected.op : null;
  if (prepared.errors.length > 0) return emptyResult(prepared.errors, op);
  if (!op) return emptyResult([(selected as { error: string }).error], null);

  const variablesKnown = options.variablesKnown !== false;
  const rawVariables = options.variables ?? {};
  if (variablesKnown) {
    const coerced = getVariableValues(schema, op.variableDefinitions ?? [], rawVariables);
    if ('errors' in coerced && coerced.errors) {
      return emptyResult(
        coerced.errors.map((e) => e.message),
        op,
      );
    }
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  const varDefs = new Map<string, VariableDefinitionNode>();
  for (const v of op.variableDefinitions ?? []) varDefs.set(v.variable.name.value, v);

  const rootType = schema.getRootType(op.operation)!;
  const collector = new Collector(schema, op.operation as OperationKind, {
    variablesKnown,
    rawVariables,
    varDefs,
    fragments,
  });
  collector.walk(op.selectionSet, rootType, {
    path: [],
    conditional: false,
    fragmentStack: [],
    via: null,
  });

  return collector.result(op);
}

type Condition = 'include' | 'skip' | 'conditional';

interface WalkContext {
  path: string[];
  conditional: boolean;
  fragmentStack: string[];
  via: string | null;
}

interface FieldAcc {
  parentType: string;
  fieldName: string;
  returnType: string;
  composite: boolean;
  occurrences: number;
  paths: Set<string>;
  aliases: Set<string>;
  fragments: Set<string>;
  minDepth: number;
  maxDepth: number;
  conditional: boolean;
}

interface CollectorEnv {
  variablesKnown: boolean;
  rawVariables: Record<string, unknown>;
  varDefs: Map<string, VariableDefinitionNode>;
  fragments: Map<string, FragmentDefinitionNode>;
}

const sortStrings = (xs: Iterable<string>): string[] => [...xs].sort();
const usageList = (m: Map<string, number>): CoordinateUsage[] =>
  sortStrings(m.keys()).map((coordinate) => ({ coordinate, occurrences: m.get(coordinate)! }));
const bump = (m: Map<string, number>, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};

class Collector {
  private readonly fields = new Map<string, FieldAcc>();
  private readonly args = new Map<string, { occurrences: number; sources: Set<ArgumentSource> }>();
  private readonly enumValues = new Map<string, number>();
  private readonly inputFields = new Map<string, number>();
  private readonly unionMembers = new Map<string, number>();
  private readonly depthCoords = new Map<number, Set<string>>();
  private introspection = false;

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly opKind: OperationKind,
    private readonly env: CollectorEnv,
  ) {}

  walk(selectionSet: SelectionSetNode, initialType: GraphQLCompositeType, ctx: WalkContext): void {
    const typeInfo = new TypeInfo(this.schema, initialType);
    const path = [...ctx.path];
    const conditional: boolean[] = [ctx.conditional];
    const top = () => conditional[conditional.length - 1]!;

    visit(
      selectionSet,
      visitWithTypeInfo(typeInfo, {
        Field: {
          enter: (node) => {
            const name = node.name.value;
            if (name === '__typename') return false;
            if (name === '__schema' || name === '__type') {
              this.introspection = true;
              return false;
            }
            const cond = this.evaluate(node.directives);
            if (cond === 'skip') return false;
            // Document is validated, so parent type and field definition always resolve.
            const parent = typeInfo.getParentType()!;
            const def = typeInfo.getFieldDef()!;
            path.push(name);
            const isConditional = top() || cond === 'conditional';
            conditional.push(isConditional);
            const named = getNamedType(def.type);
            this.recordField({
              parentType: parent.name,
              fieldName: name,
              returnType: named.name,
              composite: isCompositeType(named),
              alias: node.alias?.value,
              path: `${this.opKind}.${path.join('.')}`,
              depth: path.length,
              conditional: isConditional,
              via: ctx.via,
            });
            for (const argNode of node.arguments ?? []) {
              const argDef = def.args.find((a) => a.name === argNode.name.value)!;
              const coord = `${parent.name}.${name}(${argDef.name}:)`;
              const acc = this.args.get(coord) ?? { occurrences: 0, sources: new Set() };
              acc.occurrences += 1;
              acc.sources.add(argNode.value.kind === Kind.VARIABLE ? 'variable' : 'literal');
              this.args.set(coord, acc);
              this.walkLiteral(argDef.type, argNode.value);
            }
            return undefined;
          },
          leave: () => {
            path.pop();
            conditional.pop();
          },
        },
        InlineFragment: {
          enter: (node) => {
            const cond = this.evaluate(node.directives);
            if (cond === 'skip') return false;
            if (node.typeCondition) {
              this.recordMembership(
                typeInfo.getParentType()!,
                typeInfo.getType() as GraphQLCompositeType,
              );
            }
            conditional.push(top() || cond === 'conditional');
            return undefined;
          },
          leave: () => {
            conditional.pop();
          },
        },
        FragmentSpread: {
          enter: (node) => {
            const name = node.name.value;
            const cond = this.evaluate(node.directives);
            if (cond === 'skip') return false;
            const fragment = this.env.fragments.get(name)!;
            /* v8 ignore next -- cycles are rejected by validation; guard kept for safety */
            if (ctx.fragmentStack.includes(name)) return false;
            const condType = typeFromAST(
              this.schema,
              fragment.typeCondition,
            ) as GraphQLCompositeType;
            this.recordMembership(typeInfo.getParentType()!, condType);
            this.walk(fragment.selectionSet, condType, {
              path: [...path],
              conditional: top() || cond === 'conditional',
              fragmentStack: [...ctx.fragmentStack, name],
              via: name,
            });
            return false;
          },
        },
      }),
    );
  }

  private evaluate(directives: readonly DirectiveNode[] | undefined): Condition {
    let result: Condition = 'include';
    for (const d of directives ?? []) {
      const name = d.name.value;
      if (name !== 'include' && name !== 'skip') continue;
      const value = this.booleanArg(d);
      if (value === undefined) {
        result = 'conditional';
        continue;
      }
      if ((name === 'include' && !value) || (name === 'skip' && value)) return 'skip';
    }
    return result;
  }

  private booleanArg(d: DirectiveNode): boolean | undefined {
    const arg = d.arguments!.find((a) => a.name.value === 'if')!;
    const v = arg.value;
    if (v.kind === Kind.BOOLEAN) return v.value;
    // Validation guarantees a Boolean! variable here.
    const name = (v as { name: { value: string } }).name.value;
    if (!this.env.variablesKnown) return undefined;
    if (name in this.env.rawVariables) return Boolean(this.env.rawVariables[name]);
    // Not provided: coercion succeeded, so a Boolean default literal must exist.
    return (this.env.varDefs.get(name)!.defaultValue as BooleanValueNode).value;
  }

  private recordMembership(outer: GraphQLCompositeType, cond: GraphQLCompositeType): void {
    // A fragment on the union itself (`... on SearchResult`) selects no particular member.
    if (!isUnionType(outer) || cond.name === outer.name) return;
    for (const member of outer.getTypes()) {
      const selected = isAbstractType(cond)
        ? this.schema.isSubType(cond, member)
        : cond.name === member.name;
      if (selected) bump(this.unionMembers, `${outer.name}.${member.name}`);
    }
  }

  private recordField(hit: {
    parentType: string;
    fieldName: string;
    returnType: string;
    composite: boolean;
    alias: string | undefined;
    path: string;
    depth: number;
    conditional: boolean;
    via: string | null;
  }): void {
    const coord = `${hit.parentType}.${hit.fieldName}`;
    let acc = this.fields.get(coord);
    if (!acc) {
      acc = {
        parentType: hit.parentType,
        fieldName: hit.fieldName,
        returnType: hit.returnType,
        composite: hit.composite,
        occurrences: 0,
        paths: new Set(),
        aliases: new Set(),
        fragments: new Set(),
        minDepth: hit.depth,
        maxDepth: hit.depth,
        conditional: hit.conditional,
      };
      this.fields.set(coord, acc);
    }
    acc.occurrences += 1;
    acc.paths.add(hit.path);
    if (hit.alias && hit.alias !== hit.fieldName) acc.aliases.add(hit.alias);
    if (hit.via) acc.fragments.add(hit.via);
    acc.minDepth = Math.min(acc.minDepth, hit.depth);
    acc.maxDepth = Math.max(acc.maxDepth, hit.depth);
    acc.conditional = acc.conditional && hit.conditional;
    let set = this.depthCoords.get(hit.depth);
    if (!set) this.depthCoords.set(hit.depth, (set = new Set()));
    set.add(coord);
  }

  /** Walk an argument / input literal, resolving nested variables. */
  private walkLiteral(type: GraphQLInputType, value: ValueNode): void {
    if (value.kind === Kind.VARIABLE) {
      const name = value.name.value;
      if (!this.env.variablesKnown) return;
      if (name in this.env.rawVariables) {
        this.walkValue(type, this.env.rawVariables[name]);
        return;
      }
      const def = this.env.varDefs.get(name)!.defaultValue;
      if (def) this.walkLiteral(type, def);
      return;
    }
    if (value.kind === Kind.NULL) return;
    const nullable = getNullableType(type);
    if (isListType(nullable)) {
      const items = value.kind === Kind.LIST ? value.values : [value];
      for (const item of items) this.walkLiteral(nullable.ofType, item);
      return;
    }
    if (isInputObjectType(nullable)) {
      // Validated: the only non-null, non-variable literal for an input object is an object.
      const defs = nullable.getFields();
      for (const f of (value as ObjectValueNode).fields) {
        bump(this.inputFields, `${nullable.name}.${f.name.value}`);
        this.walkLiteral(defs[f.name.value]!.type, f.value);
      }
      return;
    }
    if (isEnumType(nullable) && value.kind === Kind.ENUM) {
      bump(this.enumValues, `${nullable.name}.${value.value}`);
    }
  }

  /** Walk a raw JSON variable value (already validated by coercion) by its input type. */
  private walkValue(type: GraphQLInputType, value: unknown): void {
    if (value === null || value === undefined) return;
    const nullable = getNullableType(type);
    if (isListType(nullable)) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) this.walkValue(nullable.ofType, item);
      return;
    }
    if (isInputObjectType(nullable)) {
      const defs = nullable.getFields();
      // Coercion already rejected unknown keys.
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        bump(this.inputFields, `${nullable.name}.${key}`);
        this.walkValue(defs[key]!.type, v);
      }
      return;
    }
    if (isEnumType(nullable) && typeof value === 'string') {
      bump(this.enumValues, `${nullable.name}.${value}`);
    }
  }

  result(op: OperationDefinitionNode): AnalysisResult {
    const coords = sortStrings(this.fields.keys());
    const fields = coords.map((coordinate) => {
      const f = this.fields.get(coordinate)!;
      return {
        coordinate,
        parentType: f.parentType,
        fieldName: f.fieldName,
        returnType: f.returnType,
        occurrences: f.occurrences,
        paths: sortStrings(f.paths),
        aliases: sortStrings(f.aliases),
        fragments: sortStrings(f.fragments),
        minDepth: f.minDepth,
        maxDepth: f.maxDepth,
        conditional: f.conditional,
      };
    });
    const depths = [...this.depthCoords.keys()].sort((a, b) => a - b);
    return {
      status: 'valid',
      errors: [],
      operationType: this.opKind,
      operationName: op.name?.value ?? null,
      introspection: this.introspection,
      rootFields: fields.filter((f) => f.minDepth === 1).map((f) => f.coordinate),
      fields,
      arguments: sortStrings(this.args.keys()).map((coordinate) => {
        const a = this.args.get(coordinate)!;
        return {
          coordinate,
          occurrences: a.occurrences,
          sources: sortStrings(a.sources) as ArgumentSource[],
        };
      }),
      enumValues: usageList(this.enumValues),
      inputFields: usageList(this.inputFields),
      unionMembers: usageList(this.unionMembers),
      edges: coords
        .map((c) => this.fields.get(c)!)
        .filter((f) => f.composite)
        .map((f) => ({ from: f.parentType, field: f.fieldName, to: f.returnType })),
      maxDepth: depths.length > 0 ? depths[depths.length - 1]! : 0,
      depthHistogram: depths.map((depth) => ({ depth, fields: this.depthCoords.get(depth)!.size })),
    };
  }
}
