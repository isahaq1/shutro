/**
 * sale_project (glue, installed with Sales and Project): a project from a sales order, with one task per order line.
 */
import type { Id } from '@shutro/core';
import { icons } from '../icons.js';
import { project } from '../project/module.js';
import { sale } from '../sale/module.js';
import { compute, defineModule, extendModel, f, method } from './.shutro/bindings.js';

export const ProjectSale = extendModel('project.project', {
  fields: { saleOrder: f.many2one('sale.order', { ondelete: 'set null' }) },
});

export const SaleOrderProjects = extendModel('sale.order', {
  access: { 'project.user': ['read'] },
  fields: {
    projects: f.one2many('project.project', 'saleOrder'),
    projectCount: f.integer({
      ...compute('sale.order', 'projectCount', ['projects'], (orders) => {
        for (const o of orders) o.projectCount = o.projects.length;
      }),
    }),
  },
  methods: {
    /** One project per confirmed order, with a task per line in the first stage. Returns the project ids. */
    createProjects: method(
      'sale.order',
      { elevate: ['sale.order.line:read'], reason: 'plan the work of confirmed orders' },
      async function (): Promise<readonly Id<'project.project'>[]> {
        const orders = await this.load({ partner: ['name'], lines: ['name', 'quantity'] });
        const notConfirmed = orders.filter((o) => o.state !== 'sale' && o.state !== 'done');
        if (!notConfirmed.isEmpty())
          throw new Error(
            `Only confirmed orders get a project (${notConfirmed.map((o) => o.name).join(', ')}).`,
          );
        const { env } = orders;
        const todo = await env.refId('project.task.stage', 'project.stage_todo');
        const created = await env.model('project.project').create(
          orders.map((o) => ({
            name: `${o.name} – ${o.partner.name}`,
            partner: o.partner.id,
            company: o.company.id,
            saleOrder: o.id,
            tasks: {
              create: [...o.lines].map((l) => ({
                name: l.name,
                partner: o.partner.id,
                company: o.company.id,
                stage: todo,
              })),
            },
          })),
        );
        return created.ids;
      },
    ),
  },
});

export const saleProject = defineModule({
  name: 'sale_project',
  version: '1.0.0',
  label: 'Sales projects',
  autoInstall: true,
  icon: icons.link,
  glyph: '🔗',
  summary: 'Projects and tasks from sales orders',
  depends: [sale, project],
  models: [],
  extensions: [ProjectSale, SaleOrderProjects],
});
