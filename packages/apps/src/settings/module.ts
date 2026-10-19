/**
 * Settings (required app): configuration parameters per company (or global), with typed reads and writes, and the
 * permission to manage them.
 */
import { defineGroup, definePermission } from '@shutro/core';
import { base } from '../base/module.js';
import { icons } from '../icons.js';
import { defineModel, defineModule, f, method } from './.shutro/bindings.js';

const manage = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const ResConfigParameter = defineModel('res.config.parameter', {
  companyScoped: { required: false }, // no company: the setting applies to every company
  access: { 'base.user': ['read'], 'settings.manager': manage },
  order: ['key'],
  tracking: ['value'],
  fields: {
    key: f.char({ required: true, index: true }),
    value: f.text(),
  },
  sqlConstraints: {
    keyPerCompany: { unique: ['key', 'company'], message: 'A setting is stored once per company.' },
  },
  methods: {
    /**
     * The value of `key` for the current company, falling back to the global value, else `fallback`.
     *
     * ```ts
     * const lock = await env.model('res.config.parameter').browse([]).getParam('account.lock_date');
     * ```
     */
    getParam: method(
      'res.config.parameter',
      async function (key: string, fallback: string | null = null): Promise<string | null> {
        // Record rules already limit the search to the allowed companies and global settings.
        const found = await this.env.model('res.config.parameter').search({ where: { key } });
        const own = found.filter((p) => p.company?.id === this.env.companyId);
        const global = found.filter((p) => p.company === null);
        return (own.isEmpty() ? global : own).map((p) => p.value)[0] ?? fallback;
      },
    ),
    /** Sets `key` for the current company (or for all companies with `{ global: true }`). */
    setParam: method(
      'res.config.parameter',
      async function (
        key: string,
        value: string | null,
        options: { readonly global?: boolean } = {},
      ): Promise<void> {
        const company = options.global === true ? null : this.env.companyRef;
        const params = this.env.model('res.config.parameter');
        const existing = await params.search({ where: { key, company: { eq: company } } });
        if (existing.isEmpty()) await params.create([{ key, value, company }]);
        else await existing.write({ value });
      },
    ),
  },
});

export const settings = defineModule({
  name: 'settings',
  version: '1.0.0',
  label: 'Settings',
  application: true,
  required: true,
  icon: icons.settings,
  glyph: '⚙️',
  category: 'Administration',
  summary: 'Companies, users, currencies and the settings of every app',
  depends: [base],
  groups: [
    defineGroup({ code: 'settings.manager', label: 'Settings manager', implies: ['base.user'] }),
  ],
  permissions: [
    definePermission({
      code: 'settings.manage',
      label: 'Manage settings',
      groups: ['settings.manager'],
    }),
  ],
  models: [ResConfigParameter],
});
