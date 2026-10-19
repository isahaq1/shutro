/**
 * `shutro apps list | info | install | uninstall | upgrade | purge` (RFC 0019 §7.7): a plan first, one confirmation,
 * live progress, a summary. Every prompt has a flag (`--yes`), and `--json` prints the engine's events.
 */
import {
  AppDependentsError,
  type AppEvent,
  type AppInfo,
  type AppManager,
  type AppStep,
  type InstallPlan,
  type PlannedModule,
  type UninstallPlan,
  type UpgradePlan,
} from '@shutro/migrate';
import { CliError } from './errors.js';
import { count, duration, type Ui } from './ui.js';

/** Flags of the `apps` commands. */
export interface AppsFlags {
  readonly yes: boolean;
  readonly all: boolean;
  readonly cascade: boolean;
  readonly purge: boolean;
  readonly allowDestructive: boolean;
  readonly now: boolean;
}

const REASONS: Readonly<Record<PlannedModule['reason'], string>> = {
  requested: 'requested',
  dependency: 'dependency',
  required: 'required',
  auto: 'connects installed apps',
  dependent: 'depends on it',
  upgrade: 'upgrade',
};

function moduleRows(ui: Ui, modules: readonly PlannedModule[], info: ReadonlyMap<string, AppInfo>) {
  return modules.map((m, i) => {
    const branch = i === modules.length - 1 ? ui.symbols.last : ui.symbols.branch;
    const depends = info.get(m.name)?.depends ?? [];
    const why =
      m.reason === 'auto' || m.reason === 'dependency'
        ? `${REASONS[m.reason]} (${depends.join(' + ')})`
        : REASONS[m.reason];
    return [
      `${ui.style('dim', branch)} ${ui.glyph(m.glyph)}${m.application ? ui.style('bold', m.name) : m.name}`,
      ui.style(
        'dim',
        m.from !== null && m.from !== m.version
          ? `${m.from} ${ui.symbols.arrow} ${m.version}`
          : m.version,
      ),
      ui.style('dim', `${why}${m.restore ? ' · data restored' : ''}`),
    ];
  });
}

/** Renders progress events: a live bar on a terminal, one line per finished step everywhere. */
export function progressReporter(
  ui: Ui,
  info: ReadonlyMap<string, AppInfo>,
): (event: AppEvent) => void {
  let total = 0;
  let done = 0;
  const labels: Readonly<Record<AppStep, string>> = {
    restore: 'restoring data',
    schema: 'schema',
    data: 'installing',
    hooks: 'migrating data',
    quarantine: 'moving data to quarantine',
    drop: 'dropping data',
  };
  return (event) => {
    ui.json(event);
    switch (event.type) {
      case 'plan':
        total = event.plan.modules.length;
        return;
      case 'warning':
        ui.warn(event.message);
        return;
      case 'done':
        ui.settle();
        return;
      case 'step': {
        const name = event.module ?? '';
        const glyph = ui.glyph(info.get(name)?.glyph);
        if (event.status === 'start') {
          ui.live(
            `    ${ui.bar(done, total)}  ${ui.style('dim', `${labels[event.step]} ${name}…`)}`,
          );
          return;
        }
        const ms = event.ms === undefined ? '' : ui.style('dim', duration(event.ms));
        const detail = event.detail === undefined ? '' : ui.style('dim', ` · ${event.detail}`);
        if (event.module === undefined)
          ui.ok(`${labels[event.step]}${detail}${ms === '' ? '' : `  ${ms}`}`);
        else {
          if (event.step === 'data' || event.step === 'hooks') done++;
          if (event.step !== 'restore') ui.ok(`${glyph}${name.padEnd(18)} ${ms}${detail}`);
          else
            ui.ok(`${glyph}${name.padEnd(18)} ${ui.style('dim', 'data restored from quarantine')}`);
        }
        ui.live(`    ${ui.bar(done, total)}`);
        return;
      }
    }
  };
}

async function confirmed(
  ui: Ui,
  flags: AppsFlags,
  question: string,
  destructive: boolean,
): Promise<boolean> {
  if (flags.yes) return true;
  const answer = await ui.confirm(question, !destructive);
  if (answer !== undefined) return answer;
  if (!destructive) return true; // non-interactive and nothing is lost
  throw new CliError(
    'This change removes data and needs a confirmation, but there is no terminal to ask.',
    'Review the plan above, then run the command again with --yes.',
  );
}

function catalogRows(ui: Ui, apps: readonly AppInfo[]) {
  const state = (a: AppInfo): string => {
    switch (a.state) {
      case 'installed':
        return a.upgradable
          ? ui.style('yellow', `installed · ${a.installedVersion} ${ui.symbols.arrow} ${a.version}`)
          : ui.style('green', 'installed');
      case 'quarantined':
        return ui.style(
          'yellow',
          `uninstalled · data kept until ${a.purgeAfter?.toISOString().slice(0, 10) ?? '?'}`,
        );
      case 'uninstalled':
        return ui.style('dim', 'uninstalled');
      default:
        return ui.style('dim', 'available');
    }
  };
  return apps.map((a) => [
    `${ui.glyph(a.glyph)}${ui.style('bold', a.label)}`,
    ui.style('dim', a.name),
    a.version,
    state(a),
    ui.style('dim', a.application ? a.category : a.autoInstall ? 'glue' : 'technical'),
  ]);
}

/** Runs an `apps` subcommand. Returns the exit code. */
export async function appsCommand(
  sub: string | undefined,
  names: readonly string[],
  flags: AppsFlags,
  apps: AppManager,
  ui: Ui,
): Promise<number> {
  const list = await apps.list();
  const info = new Map(list.map((a) => [a.name, a]));
  const need = (what: string): void => {
    if (names.length === 0)
      throw new CliError(
        `apps ${what} needs at least one app name.`,
        `E.g. shutro apps ${what} purchase.`,
      );
  };

  switch (sub) {
    case undefined:
    case 'list': {
      const shown = flags.all ? list : list.filter((a) => a.application);
      if (ui.mode === 'json') {
        ui.json(shown);
        return 0;
      }
      ui.heading(flags.all ? 'Modules' : 'Apps');
      ui.table(catalogRows(ui, shown));
      const installed = list.filter((a) => a.state === 'installed');
      ui.line(
        ui.style(
          'dim',
          `\n    ${installed.filter((a) => a.application).length} of ${list.filter((a) => a.application).length} apps installed, ${installed.length} modules in total.${flags.all ? '' : ' --all lists technical and glue modules.'}`,
        ),
      );
      return 0;
    }

    case 'info': {
      need('info');
      for (const name of names) {
        const a = info.get(name);
        if (a === undefined)
          throw new CliError(
            `No module named '${name}'.`,
            `Available: ${[...info.keys()].join(', ')}.`,
          );
        if (ui.mode === 'json') {
          ui.json(a);
          continue;
        }
        ui.heading(`${ui.glyph(a.glyph)}${a.label} ${ui.style('dim', `${a.name} ${a.version}`)}`);
        if (a.summary !== '') ui.line(`    ${a.summary}`);
        ui.table([
          ['state', catalogRows(ui, [a])[0]?.[3] ?? a.state],
          [
            'kind',
            a.application
              ? `app · ${a.category}`
              : a.autoInstall
                ? 'glue (installs itself)'
                : 'technical',
          ],
          ['depends on', a.depends.join(', ') || ui.style('dim', 'nothing')],
          ['used by', a.dependents.join(', ') || ui.style('dim', 'nothing')],
          ['models', a.models.join(', ') || ui.style('dim', 'none (extends other apps)')],
          ...(a.required ? [['note', 'required: cannot be uninstalled']] : []),
        ]);
      }
      return 0;
    }

    case 'install': {
      need('install');
      const plan: InstallPlan = await apps.planInstall(names);
      if (plan.modules.length === 0) {
        ui.json({ type: 'result', operation: 'install', modules: [] });
        ui.ok(`Already installed: ${names.join(', ')}.`);
        return 0;
      }
      ui.heading(
        `Install plan ${ui.style('dim', `· ${plan.modules.length} module(s), ${plan.statements.length} statement(s)`)}`,
      );
      ui.table(moduleRows(ui, plan.modules, info));
      if (!(await confirmed(ui, flags, 'Install?', false))) {
        ui.info('Cancelled: nothing was changed.');
        return 1;
      }
      ui.heading('Installing');
      const result = await apps.install(names, {
        actor: 'cli',
        onEvent: progressReporter(ui, info),
      });
      ui.json({
        type: 'result',
        operation: 'install',
        modules: result.plan.modules.map((m) => m.name),
        ms: result.ms,
      });
      ui.line();
      ui.ok(
        ui.style(
          'bold',
          `Installed ${
            result.plan.modules
              .filter((m) => m.application)
              .map((m) => info.get(m.name)?.label ?? m.name)
              .join(', ') || result.plan.modules.map((m) => m.name).join(', ')
          } in ${duration(result.ms)}.`,
        ),
      );
      return 0;
    }

    case 'uninstall': {
      need('uninstall');
      let cascade = flags.cascade;
      let plan: UninstallPlan;
      try {
        plan = await apps.planUninstall(names, { cascade, purge: flags.purge });
      } catch (error) {
        if (!(error instanceof AppDependentsError) || flags.yes) throw error;
        ui.warn(`${error.dependents.join(', ')} depend(s) on ${names.join(', ')}.`);
        const also = await ui.confirm(`Uninstall ${error.dependents.join(', ')} too?`, false);
        if (also !== true) throw error;
        cascade = true;
        plan = await apps.planUninstall(names, { cascade, purge: flags.purge });
      }
      const head = plan.modules.find((m) => m.reason === 'requested');
      ui.heading(
        `Uninstall ${ui.glyph(head?.glyph)}${plan.modules
          .filter((m) => m.reason === 'requested')
          .map((m) => `${m.label} ${m.version}`)
          .join(', ')}`,
      );
      const others = plan.modules.filter((m) => m.reason !== 'requested');
      if (others.length > 0) {
        ui.line(`\n    ${ui.style('bold', 'Also removed')}`);
        ui.table(moduleRows(ui, others, info), 4);
      }
      const where = plan.purge ? ui.style('red', 'dropped') : ui.style('yellow', 'quarantine');
      const affected = [
        ...plan.tables.map((t) => [
          t.table,
          ui.style('dim', t.module),
          count(t.rows),
          `${ui.symbols.arrow} ${where}`,
        ]),
        ...plan.columns.map((c) => [
          `${c.table}.${c.column}`,
          ui.style('dim', `${c.module} · column on ${c.table}`),
          count(c.rows),
          `${ui.symbols.arrow} ${where}`,
        ]),
      ];
      if (affected.length > 0) {
        ui.line(`\n    ${ui.style('bold', 'Data affected')}`);
        ui.table([[ui.style('dim', 'table'), '', ui.style('dim', 'rows'), ''], ...affected]);
      } else
        ui.line(`\n    ${ui.style('dim', 'No tables or columns hold data of these modules.')}`);
      ui.line();
      ui.ok('Audit history is kept (never deleted).');
      if (plan.purge)
        ui.warn(ui.style('bold', 'Purge: the data above is deleted and cannot be restored.'));
      else
        ui.info(
          `Recoverable for ${plan.retentionDays} days: "shutro apps install ${names.join(' ')}" restores everything.`,
        );
      const rows =
        plan.tables.reduce((n, t) => n + t.rows, 0) + plan.columns.reduce((n, c) => n + c.rows, 0);
      if (plan.purge && !flags.yes && ui.mode !== 'json') {
        const typed = await ui.ask(
          `Type ${names.join(' ')} to delete ${count(rows)} row(s) for good`,
          '',
        );
        if (typed !== names.join(' ')) {
          ui.info('Cancelled: nothing was changed.');
          return 1;
        }
      } else if (!(await confirmed(ui, flags, 'Proceed?', true))) {
        ui.info('Cancelled: nothing was changed.');
        return 1;
      }
      ui.heading('Uninstalling');
      const result = await apps.uninstall(names, {
        cascade,
        purge: flags.purge,
        actor: 'cli',
        onEvent: progressReporter(ui, info),
      });
      ui.json({
        type: 'result',
        operation: 'uninstall',
        modules: result.plan.modules.map((m) => m.name),
        ms: result.ms,
      });
      ui.line();
      ui.ok(
        ui.style(
          'bold',
          `Uninstalled ${result.plan.modules.map((m) => m.name).join(', ')} in ${duration(result.ms)}.`,
        ),
      );
      return 0;
    }

    case 'upgrade': {
      const plan: UpgradePlan = await apps.planUpgrade(names.length === 0 ? undefined : names);
      if (plan.modules.length === 0 && plan.statements.length === 0) {
        ui.json({ type: 'result', operation: 'upgrade', modules: [] });
        ui.ok('Everything is up to date.');
        return 0;
      }
      ui.heading(
        `Upgrade plan ${ui.style('dim', `· ${plan.modules.length} module(s), ${plan.statements.length} statement(s)`)}`,
      );
      if (plan.modules.length > 0) ui.table(moduleRows(ui, plan.modules, info));
      for (const statement of plan.destructive) ui.warn(`destructive: ${statement}`);
      if (plan.destructive.length > 0 && !flags.allowDestructive)
        throw new CliError(
          `The upgrade has ${plan.destructive.length} destructive statement(s).`,
          'Review them above, then run with --allow-destructive (or write a migration file for them).',
        );
      if (!(await confirmed(ui, flags, 'Upgrade?', plan.destructive.length > 0))) {
        ui.info('Cancelled: nothing was changed.');
        return 1;
      }
      ui.heading('Upgrading');
      const result = await apps.upgrade(names.length === 0 ? undefined : names, {
        actor: 'cli',
        allowDestructive: flags.allowDestructive,
        onEvent: progressReporter(ui, info),
      });
      ui.json({
        type: 'result',
        operation: 'upgrade',
        modules: result.plan.modules.map((m) => m.name),
        ms: result.ms,
      });
      ui.ok(ui.style('bold', `Upgraded in ${duration(result.ms)}.`));
      return 0;
    }

    case 'purge': {
      const due = list.filter((a) => a.state === 'quarantined');
      const targets = flags.now ? names : [];
      if (flags.now) need('purge --now');
      if (due.length === 0) {
        ui.ok('The quarantine is empty.');
        return 0;
      }
      if (
        flags.now &&
        !(await confirmed(
          ui,
          flags,
          `Delete the quarantined data of ${names.join(', ')} for good?`,
          true,
        ))
      ) {
        ui.info('Cancelled: nothing was changed.');
        return 1;
      }
      const result = await apps.purge({
        modules: targets,
        actor: 'cli',
        onEvent: progressReporter(ui, info),
      });
      ui.json({
        type: 'result',
        operation: 'purge',
        modules: result.plan.modules.map((m) => m.name),
      });
      if (result.plan.modules.length === 0) {
        ui.ok('Nothing is past its retention period.');
        for (const a of due)
          ui.info(
            `${a.name}: kept until ${a.purgeAfter?.toISOString().slice(0, 10) ?? '?'} (shutro apps purge --now ${a.name})`,
          );
      } else ui.ok(`Purged ${result.plan.modules.map((m) => m.name).join(', ')}.`);
      return 0;
    }

    default:
      throw new CliError(
        `Unknown apps command '${sub}'.`,
        'Use list, info, install, uninstall, upgrade or purge.',
      );
  }
}
