/**
 * Project (app): projects, tasks moving through shared stages, assignees, deadlines and priorities, for every
 * company the user is allowed in.
 */
import { defineGroup } from '@shutro/core';
import { icons } from '../icons.js';
import { partner } from '../partner/module.js';
import {
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  record,
} from './.shutro/bindings.js';

export const ProjectProject = defineModel('project.project', {
  archivable: true,
  companyScoped: { required: true },
  order: ['name'],
  tracking: ['user', 'dateEnd'],
  access: {
    'project.user': ['read', 'write', 'create'],
    'project.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, translate: true }),
    /** Project manager. */
    user: f.many2one('res.users', { default: (env: Env) => env.userId }),
    /** Customer, when the project is done for one. */
    partner: f.many2one('res.partner', { checkCompany: true }),
    dateStart: f.date(),
    dateEnd: f.date(),
    description: f.text(),
    tasks: f.one2many('project.task', 'project'),
    taskCount: f.integer({
      ...compute('project.project', 'taskCount', ['tasks'], (projects) => {
        for (const p of projects) p.taskCount = p.tasks.length;
      }),
    }),
    openTaskCount: f.integer({
      ...compute('project.project', 'openTaskCount', ['tasks.isClosed'], (projects) => {
        for (const p of projects) p.openTaskCount = p.tasks.filter((t) => !t.isClosed).length;
      }),
    }),
  },
});

export const ProjectTaskStage = defineModel('project.task.stage', {
  access: {
    'project.user': ['read'],
    'project.manager': ['read', 'write', 'create', 'unlink'],
  },
  order: ['sequence', 'id'],
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ default: 10 }),
    /** Tasks in this stage are finished. */
    closed: f.boolean({ default: false }),
    /** Folded in kanban views. */
    fold: f.boolean({ default: false }),
  },
});

export const ProjectTask = defineModel('project.task', {
  archivable: true,
  companyScoped: { required: true },
  order: ['sequence', 'id'],
  tracking: ['stage', 'user', 'deadline'],
  access: {
    'project.user': ['read', 'write', 'create', 'unlink'],
    'project.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    project: f.many2one('project.project', {
      required: true,
      ondelete: 'cascade',
      checkCompany: true,
    }),
    stage: f.many2one('project.task.stage', { ondelete: 'restrict' }),
    /** Assignee. */
    user: f.many2one('res.users'),
    partner: f.many2one('res.partner'),
    deadline: f.date(),
    priority: f.selection(
      { normal: 'Normal', high: 'High', urgent: 'Urgent' },
      { default: 'normal' },
    ),
    sequence: f.integer({ default: 10 }),
    plannedHours: f.decimal({ scale: 2, default: '0' }),
    description: f.text(),
    parent: f.many2one('project.task', { ondelete: 'cascade' }),
    subtasks: f.one2many('project.task', 'parent'),
    isClosed: f.boolean({
      store: true,
      ...compute('project.task', 'isClosed', ['stage.closed'], (tasks) => {
        for (const t of tasks) t.isClosed = t.stage?.closed ?? false;
      }),
    }),
  },
  methods: {
    /** Moves tasks to the first closed stage. */
    markDone: method('project.task', async function (): Promise<void> {
      const [done] = await this.env
        .model('project.task.stage')
        .search({ where: { closed: true }, limit: 1 });
      if (done === undefined)
        throw new Error('No closed stage exists: create one (Settings → Project stages).');
      await this.write({ stage: done.id });
    }),
  },
});

export const project = defineModule({
  name: 'project',
  version: '1.0.0',
  label: 'Project',
  application: true,
  icon: icons.project,
  glyph: '📋',
  category: 'Services',
  summary: 'Projects, tasks, stages and deadlines',
  depends: [partner],
  groups: [
    defineGroup({ code: 'project.user', label: 'Project member', implies: ['base.user'] }),
    defineGroup({ code: 'project.manager', label: 'Project manager', implies: ['project.user'] }),
  ],
  models: [ProjectProject, ProjectTaskStage, ProjectTask],
  data: [
    record('project.task.stage', 'stage_todo', { name: 'To do', sequence: 1 }),
    record('project.task.stage', 'stage_in_progress', { name: 'In progress', sequence: 2 }),
    record('project.task.stage', 'stage_review', { name: 'Review', sequence: 3 }),
    record('project.task.stage', 'stage_done', {
      name: 'Done',
      sequence: 4,
      closed: true,
      fold: true,
    }),
    record('project.task.stage', 'stage_cancelled', {
      name: 'Cancelled',
      sequence: 5,
      closed: true,
      fold: true,
    }),
  ],
});
