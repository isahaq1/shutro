/**
 * @packageDocumentation
 * `@shutro/core`: fields, `defineModel`, recordsets, environment, registry and compute engine (RFCs 0001–0004),
 * and the accounting-safe value types of RFC 0006.
 *
 * Implemented so far: the value types (`Decimal`, `Money`, `Currency`, `Quantity`, `Uom`) and the environment &
 * transaction context (`createShutro`, `Env`).
 */

export {
  type AuditAction,
  type AuditEntry,
  auditTableStatements,
  readTrail,
  type TrailFilter,
} from '@shutro/audit';
export {
  isTranslations,
  mergeTranslation,
  resolveTranslation,
  type Translations,
} from '@shutro/i18n';
export {
  type AccessSpec,
  createKeyRing,
  defineGroup,
  definePermission,
  EncryptionError,
  type FieldGroups,
  type FieldGroupsInput,
  type GroupDefinition,
  type KeyRing,
  type Perm,
  type PermissionDefinition,
  type RulePerm,
  type RuleSpec,
  SecurityDefinitionError,
} from '@shutro/security';
export {
  defineSequence,
  InvalidSequenceError,
  type SequenceDefinition,
  type SequenceInput,
  type SequenceReset,
} from '@shutro/sequence';
export { type CompiledSql, compile, type SqlFragment, sql } from '@shutro/sql';
export {
  buildComputeGraph,
  type ComputedField,
  type ComputeGraph,
  type PathStep,
  type Trigger,
} from './compute/graph.js';
export {
  type DataRecord,
  type DataRef,
  isRef,
  override,
  record,
  ref,
} from './data/data.js';
export {
  type DataLoadResult,
  EXTERNAL_ID_TABLE,
  externalIdTableStatements,
  loadData,
} from './data/load.js';
export type { VerifiedIdentity } from './env/env.js';
export {
  type BootstrapOptions,
  createShutro,
  Env,
  type Flags,
  type Hook,
  type RunOptions,
  type ScopeStats,
  type Shutro,
  type ShutroOptions,
} from './env/env.js';
export { type Identity, type ResolvedIdentity, SYSTEM_UID } from './env/identity.js';
export {
  createInspector,
  type InspectedQuery,
  type Inspector,
  type InspectorOptions,
  type InspectorWarning,
} from './env/inspector.js';
export { assertTimeZone, calendarDateIn } from './env/time.js';
export {
  AccessError,
  CompanyNotAllowedError,
  ComputeAssignmentError,
  ComputeCycleError,
  ConcurrentUpdateError,
  ConstraintError,
  ConstraintViolationError,
  CrossCompanyError,
  CurrencyMismatchError,
  DivisionByZeroError,
  DuplicateModelError,
  DuplicateModuleError,
  EmptyMoneySumError,
  ExtensionConflictError,
  FieldNotLoadedError,
  FlagNotAllowedError,
  IncompatibleUomCategoryError,
  InvalidAllocationError,
  InvalidCurrencyError,
  InvalidDecimalError,
  InvalidDependsPathError,
  InvalidDomainError,
  InvalidExtensionError,
  InvalidFieldError,
  InvalidIdentityError,
  InvalidModelError,
  InvalidModuleError,
  InvalidRelationError,
  InvalidTransitionError,
  InvalidUomError,
  MissingRateError,
  MissingRecordError,
  NoEnvironmentError,
  NonIntegerNumberError,
  NoRegistryError,
  RecomputeLimitError,
  ShutroError,
  type ShutroErrorCode,
  SingletonError,
  type SqlConstraintKind,
  TransactionScopeError,
  TransitionGuardError,
  UndeclaredDependencyError,
  UnknownExternalIdError,
  UnknownModelError,
  UnknownSequenceError,
  UomMismatchError,
  ValidationError,
} from './errors.js';
export type { CreateOf, FlagsOfField, ReadOf, WriteOf } from './model/faces.js';
export type { SequenceFieldOptions, TextWrite } from './model/field.js';
export {
  type BinaryField,
  type BinaryOptions,
  type CharField,
  type CharOptions,
  type CommonOptions,
  type ComputeFn,
  type DecimalField,
  type DecimalOptions,
  type Field,
  type FieldBase,
  type FieldBuilders,
  type FieldFlags,
  type FieldKind,
  type FieldOverrideChanges,
  type FieldTypes,
  type FlagsOf,
  type FloatField,
  f,
  type HtmlOptions,
  type IdField,
  type IndexKind,
  type InverseFn,
  isField,
  type JsonField,
  type JsonOptions,
  type Many2manyField,
  type Many2manyOptions,
  type Many2oneField,
  type Many2oneOptions,
  type MonetaryField,
  type MonetaryOptions,
  type OnDelete,
  type One2manyField,
  type QuantityField,
  type QuantityOptions,
  type ScalarField,
  type SelectionField,
  type SelectionOptions,
  type StateField,
  type StateHooks,
  type StateOptions,
  type StateSpec,
  type TextOptions,
  type Transition,
  type X2ManyOptions,
} from './model/field.js';
export type * as F from './model/generated.js';
export { asId, type Id, type X2ManyCommands } from './model/id.js';
export type { OnchangeFn } from './model/model.js';
export {
  type ActiveField,
  type AnyModel,
  type BackdateSpec,
  type CompanyField,
  type CompanyScope,
  type ConstraintSpec,
  defineModel,
  type FieldDescription,
  type FieldRules,
  type FieldsRecord,
  humanize,
  type ImplicitFields,
  type ImplicitFieldsBase,
  type IndexSpec,
  isModel,
  type MethodsRecord,
  type Model,
  type ModelDefinition,
  type ModelDescription,
  type ModelFields,
  type OrderSpec,
  type OrderTerm,
  RESERVED_KEYS,
  type ReservedKey,
  type ResolvedConstraint,
  type ResolvedIndex,
  type ResolvedSqlConstraint,
  type SqlCheckConstraint,
  type SqlUniqueConstraint,
  snakeCase,
  type TransitionMethods,
  transitionOf,
} from './model/model.js';
export {
  type PartitionBound,
  type PartitionSpec,
  partitionStatements,
  rangePartitions,
} from './model/partition.js';
export { related, relatedPath } from './model/related.js';
export {
  type DefinitionHelpers,
  definitions,
  type LoadedFrom,
  type PathLoaded,
} from './model/typed.js';
export {
  type Currency,
  type CurrencyInput,
  defineCurrency,
  sameCurrency,
} from './money/currency.js';
export { Decimal, type DecimalInput, toDecimal } from './money/decimal.js';
export type { Conversion, ConvertOptions, Fx, PreparedRates } from './money/fx.js';
export { Money, type MoneyJson } from './money/money.js';
export { defineUom, Quantity, type Uom, type UomInput } from './money/quantity.js';
export type { RoundingMethod } from './money/rounding.js';
export { coalesceAudit, isTracked } from './recordset/audit.js';
export { type JunctionTable, junctionTable } from './recordset/relations.js';
export { modelPolicies, rlsStatements, ruleCondition } from './recordset/rls.js';
export { UNNUMBERED } from './recordset/sequences.js';
export type {
  Access,
  AggregateQuery,
  AggregateRow,
  ComputedKeys,
  ComputeRec,
  ComputeSet,
  CreateValues,
  DefaultLoaded,
  Defaults,
  Domain,
  Draft,
  DraftValue,
  FieldsOf,
  Granularity,
  GroupKey,
  IdOnly,
  ListKeys,
  ListLoaded,
  LoadedKeys,
  LoadSpec,
  Many2oneKeys,
  Measure,
  Merge,
  MethodsOf,
  ModelName,
  ModelRef,
  NotLoaded,
  OnchangeInput,
  OnchangeResult,
  PendingSet,
  PlainRow,
  Rec,
  RecordSet,
  RecordSetApi,
  RelKeys,
  ScalarKeys,
  SearchOrder,
  SearchQuery,
  SequenceKeys,
  SummableKeys,
  SumOf,
  Target,
  ToLoaded,
  TranslatedKeys,
  WriteValues,
  X2ManyKeys,
} from './recordset/types.js';
export { copyField } from './recordset/writes.js';
export { columnDefault, createTableStatements } from './registry/ddl.js';
export {
  type AnyExtension,
  type Extension,
  type ExtensionDefinition,
  extendModel,
  type FieldOverride,
  isExtension,
  type OverrideFn,
  type Replacement,
  replace,
} from './registry/extension.js';
export {
  compareVersions,
  type DataMigration,
  defineModule,
  isModule,
  type MigrationContext,
  type Module,
  type ModuleBase,
  type ModuleDefinition,
} from './registry/module.js';
export {
  buildRegistry,
  type MethodLayer,
  type Origin,
  type RegisteredModel,
  type Registry,
  type RegistryModelDescription,
  type RegistryOptions,
  type SchemaOfModule,
  type SchemaOfModules,
  type SecurityOptions,
  targetOf,
} from './registry/registry.js';
