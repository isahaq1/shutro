/**
 * `shutro inspect`: the schema explorer (RFC 0002 §9). Without a model, the modules and their models; with one, its
 * fields (kind, column, origin module), methods with their override chains, computed fields with ranks and
 * dependencies, constraints, access and record rules.
 */
import type { Registry } from '@shutro/core';
import { CliError } from './errors.js';

/** The registry overview: modules in load order and the models each owns or extends. */
export function inspectRegistry(registry: Registry): string {
  const lines = [`${registry.modules.length} module(s), ${registry.models.size} model(s)`, ''];
  for (const module of registry.modules) {
    const owned = [...registry.models.values()]
      .filter((m) => m.module === module.name)
      .map((m) => m.model.name);
    const extended = [...registry.models.values()]
      .filter((m) => m.extensions.includes(module.name))
      .map((m) => m.model.name);
    lines.push(
      `${module.name} ${module.version}${module.depends.length > 0 ? `  (depends: ${module.depends.map((d) => d.name).join(', ')})` : ''}`,
    );
    if (owned.length > 0) lines.push(`  owns:    ${owned.join(', ')}`);
    if (extended.length > 0) lines.push(`  extends: ${extended.join(', ')}`);
  }
  return lines.join('\n');
}

/** One model in detail. */
export function inspectModel(registry: Registry, name: string): string {
  if (!registry.has(name)) {
    throw new CliError(
      `Unknown model '${name}'.`,
      `Models: ${[...registry.models.keys()].sort().join(', ')}.`,
    );
  }
  const registered = registry.get(name);
  const { model } = registered;
  const d = registry.describe(name);
  const lines = [
    `${name}  table ${model.table}  owner ${registered.module}${registered.extensions.length > 0 ? `  extended by ${registered.extensions.join(', ')}` : ''}`,
    '',
    'fields',
  ];
  const width = Math.max(...Object.keys(d.fields).map((k) => k.length));
  for (const [key, field] of Object.entries(d.fields)) {
    const flags = [
      field.required ? 'required' : '',
      field.readonly ? 'readonly' : '',
      field.computed ? (field.store ? 'computed+stored' : 'computed') : '',
      field.translate ? 'translate' : '',
      field['encrypted'] === true ? 'encrypted' : '',
      field.tracking ? 'tracked' : '',
      field.groups.read.length > 0 ? `groups:${field.groups.read.join('|')}` : '',
    ].filter((f) => f !== '');
    const target = typeof field['target'] === 'string' ? ` → ${field['target']}` : '';
    lines.push(
      `  ${key.padEnd(width)}  ${`${field.kind}${target}`.padEnd(28)} ${(field.column ?? '-').padEnd(20)} ${field.origin.module.padEnd(14)} ${flags.join(' ')}`,
    );
  }
  const methods = Object.entries(registered.methodLayers);
  if (methods.length > 0) {
    lines.push('', 'methods');
    for (const [method, layers] of methods)
      lines.push(
        `  ${method}: ${layers.map((l) => (l.kind === 'definition' ? l.module : `${l.module}(${l.kind})`)).join(' → ')}`,
      );
  }
  const computed = registry.compute.fields.filter((f) => f.model === name);
  if (computed.length > 0) {
    lines.push('', 'computed');
    for (const f of computed)
      lines.push(
        `  ${f.key}  rank ${f.rank}  ${f.stored ? 'stored' : 'on load'}  depends ${f.paths.map((p) => p.map((s) => s.key).join('.')).join(', ') || '-'}`,
      );
  }
  if (d.constraints.length > 0) {
    lines.push('', 'constraints');
    for (const c of d.constraints) lines.push(`  ${c.key}  depends ${c.depends.join(', ')}`);
  }
  if (d.sqlConstraints.length > 0) {
    lines.push('', 'sql constraints');
    for (const c of d.sqlConstraints) lines.push(`  ${c.name}  ${c.kind}  ${c.message}`);
  }
  const access = Object.entries(d.access);
  lines.push('', 'access');
  if (access.length === 0) lines.push('  (none: denied to everyone but superuser scopes)');
  for (const [group, perms] of access) lines.push(`  ${group}: ${perms.join(', ')}`);
  const rules = Object.entries(d.rules);
  if (rules.length > 0) {
    lines.push('', 'rules');
    for (const [key, r] of rules)
      lines.push(
        `  ${key}  ${r.groups === 'global' ? 'global' : r.groups.join('|')}  ${r.perms.join(',')}  ${JSON.stringify(r.domain)}`,
      );
  }
  return lines.join('\n');
}
