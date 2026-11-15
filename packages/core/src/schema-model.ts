import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  lexicographicSortSchema,
  printSchema,
  type GraphQLArgument,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';

export type TypeKind = 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';

export interface ArgModel {
  name: string;
  /** `Type.field(arg:)` */
  coordinate: string;
  type: string;
  namedType: string;
}

export interface FieldModel {
  name: string;
  coordinate: string;
  /** Printed type, e.g. `[Post!]!`. */
  type: string;
  namedType: string;
  namedTypeKind: TypeKind;
  args: ArgModel[];
  deprecated: boolean;
}

export interface InputFieldModel {
  name: string;
  coordinate: string;
  type: string;
  namedType: string;
}

export interface TypeModel {
  name: string;
  kind: TypeKind;
  description: string | null;
  /** OBJECT / INTERFACE */
  fields: FieldModel[];
  /** Interfaces implemented by an OBJECT / INTERFACE. */
  interfaces: string[];
  /** UNION members, or object implementations of an INTERFACE. */
  possibleTypes: string[];
  enumValues: string[];
  inputFields: InputFieldModel[];
  builtIn: boolean;
}

export type EdgeKind = 'field' | 'implements' | 'member';

export interface EdgeModel {
  /** `field`: `Parent.field`; `implements`: `Type>Interface`; `member`: `Union|Member`. */
  id: string;
  kind: EdgeKind;
  from: string;
  /** Field name for `field` edges. */
  field: string | null;
  to: string;
}

export interface SchemaModel {
  roots: { query: string | null; mutation: string | null; subscription: string | null };
  types: TypeModel[];
  edges: EdgeModel[];
}

const BUILT_IN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/** Canonical SDL used for schema snapshot hashing (sorted, comments/descriptions preserved). */
export function normalizeSdl(schema: GraphQLSchema): string {
  return printSchema(lexicographicSortSchema(schema));
}

function kindOf(t: GraphQLNamedType): TypeKind {
  if (isObjectType(t)) return 'OBJECT';
  if (isInterfaceType(t)) return 'INTERFACE';
  if (isUnionType(t)) return 'UNION';
  if (isEnumType(t)) return 'ENUM';
  if (isInputObjectType(t)) return 'INPUT_OBJECT';
  return 'SCALAR';
}

const argModel = (parent: string, field: string, a: GraphQLArgument): ArgModel => ({
  name: a.name,
  coordinate: `${parent}.${field}(${a.name}:)`,
  type: String(a.type),
  namedType: getNamedType(a.type).name,
});

export function buildSchemaModel(schema: GraphQLSchema): SchemaModel {
  const types: TypeModel[] = [];
  const edges: EdgeModel[] = [];
  const typeMap = schema.getTypeMap();
  const names = Object.keys(typeMap)
    .filter((n) => !n.startsWith('__'))
    .sort();

  for (const name of names) {
    const t = typeMap[name]!;
    const kind = kindOf(t);
    const model: TypeModel = {
      name,
      kind,
      description: t.description ?? null,
      fields: [],
      interfaces: [],
      possibleTypes: [],
      enumValues: [],
      inputFields: [],
      builtIn: isScalarType(t) && BUILT_IN_SCALARS.has(name),
    };
    if (isObjectType(t) || isInterfaceType(t)) {
      for (const f of Object.values(t.getFields())) {
        const named = getNamedType(f.type);
        model.fields.push({
          name: f.name,
          coordinate: `${name}.${f.name}`,
          type: String(f.type),
          namedType: named.name,
          namedTypeKind: kindOf(named),
          args: f.args.map((a) => argModel(name, f.name, a)),
          deprecated: f.deprecationReason != null,
        });
        edges.push({
          id: `${name}.${f.name}`,
          kind: 'field',
          from: name,
          field: f.name,
          to: named.name,
        });
      }
      model.interfaces = t
        .getInterfaces()
        .map((i) => i.name)
        .sort();
      for (const i of model.interfaces) {
        edges.push({ id: `${name}>${i}`, kind: 'implements', from: name, field: null, to: i });
      }
    }
    if (isInterfaceType(t)) {
      model.possibleTypes = schema
        .getImplementations(t)
        .objects.map((o) => o.name)
        .sort();
    }
    if (isUnionType(t)) {
      model.possibleTypes = t
        .getTypes()
        .map((m) => m.name)
        .sort();
      for (const m of model.possibleTypes) {
        edges.push({ id: `${name}|${m}`, kind: 'member', from: name, field: null, to: m });
      }
    }
    if (isEnumType(t)) model.enumValues = t.getValues().map((v) => v.name);
    if (isInputObjectType(t)) {
      model.inputFields = Object.values(t.getFields()).map((f) => ({
        name: f.name,
        coordinate: `${name}.${f.name}`,
        type: String(f.type),
        namedType: getNamedType(f.type).name,
      }));
      for (const f of model.inputFields) {
        edges.push({ id: f.coordinate, kind: 'field', from: name, field: f.name, to: f.namedType });
      }
    }
    types.push(model);
  }

  return {
    roots: {
      query: schema.getQueryType()?.name ?? null,
      mutation: schema.getMutationType()?.name ?? null,
      subscription: schema.getSubscriptionType()?.name ?? null,
    },
    types,
    edges,
  };
}

export interface SchemaDiff {
  addedTypes: string[];
  removedTypes: string[];
  /** Field, argument, enum value and input field coordinates. */
  added: string[];
  removed: string[];
}

function coordinates(model: SchemaModel): Set<string> {
  const out = new Set<string>();
  for (const t of model.types) {
    for (const f of t.fields) {
      out.add(f.coordinate);
      for (const a of f.args) out.add(a.coordinate);
    }
    for (const v of t.enumValues) out.add(`${t.name}.${v}`);
    for (const f of t.inputFields) out.add(f.coordinate);
  }
  return out;
}

export function diffSchemaModels(base: SchemaModel, head: SchemaModel): SchemaDiff {
  const bt = new Set(base.types.map((t) => t.name));
  const ht = new Set(head.types.map((t) => t.name));
  const bc = coordinates(base);
  const hc = coordinates(head);
  const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
  return {
    addedTypes: minus(ht, bt),
    removedTypes: minus(bt, ht),
    added: minus(hc, bc),
    removed: minus(bc, hc),
  };
}
