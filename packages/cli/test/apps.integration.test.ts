/**
 * The guided installer and `shutro apps` / `doctor` against PostgreSQL 18 (RFC 0019 §7.7): a fresh project with the
 * default apps, resuming, previews and confirmations, quarantine and restore, JSON output, and doctor.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CliIo, runCli } from '../src/index.js';

// Inside the workspace, so the generated config can import @shutro/cli and @shutro/apps.
const projects = join(import.meta.dirname, '.projects');
let pg: StartedPostgres;
let url: string;
let db: Driver;

function io(cwd: string, extra: Partial<CliIo> = {}): CliIo & { text(): string } {
  let out = '';
  return {
    cwd,
    env: { SHUTRO_DATABASE_URL: url },
    write: (t) => {
      out += t;
    },
    error: (t) => {
      out += t;
    },
    text: () => out,
    ...extra,
  };
}

const rows = async (query: ReturnType<typeof sql>) => db.query(compile(query));

beforeAll(async () => {
  pg = await startPostgres();
  const parsed = new URL(pg.url);
  parsed.pathname = '/acme_erp'; // does not exist yet: init creates it
  url = parsed.toString();
  db = createDriver({ url, max: 2 });
  rmSync(projects, { recursive: true, force: true });
  mkdirSync(projects, { recursive: true });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await pg?.stop();
  rmSync(projects, { recursive: true, force: true });
});

describe('shutro init', () => {
  test('--no-install writes the project files only', async () => {
    const o = io(projects, { env: {} });
    expect(await runCli(['init', 'files-only', '--no-install', '--yes'], o)).toBe(0);
    const dir = join(projects, 'files-only');
    for (const file of [
      'package.json',
      'shutro.config.ts',
      'modules/README.md',
      'migrations/.gitkeep',
      '.gitignore',
    ])
      expect(existsSync(join(dir, file))).toBe(true);
    expect(o.text()).toContain('Project files written.');
  });

  test('creates the database, installs the default apps, the company and the administrator', async () => {
    const o = io(projects, { env: {} });
    const code = await runCli(
      ['init', 'acme', '--database', url, '--company', 'Acme Corp', '--currency', 'bdt', '--yes'],
      o,
    );
    expect(o.text()).toContain('(database created)');
    expect(code).toBe(0);
    expect(o.text()).toMatch(/\[ok\] 12 modules installed in/);
    expect(o.text()).toContain('[ok] Acme Corp · BDT');
    expect(o.text()).toMatch(/Ready in .*5 apps, 12 modules/);

    const config = readFileSync(join(projects, 'acme', 'shutro.config.ts'), 'utf8');
    expect(config).toContain("modules: ['@shutro/apps']");
    expect(config).toContain("install: ['settings', 'account', 'sale', 'purchase', 'project']");
    expect(config).not.toContain(`:${new URL(url).password}@`); // the password is never written to a file
    expect(
      await rows(
        sql`SELECT c.name, cur.name AS currency FROM res_company c JOIN res_currency cur ON cur.id = c.currency_id`,
      ),
    ).toEqual([{ name: 'Acme Corp', currency: 'BDT' }]);
    expect(await rows(sql`SELECT login FROM res_users`)).toEqual([{ login: 'admin' }]);
  });

  test('running it again resumes: files and data are kept', async () => {
    const o = io(projects, { env: {} });
    expect(await runCli(['init', 'acme', '--database', url, '--yes'], o)).toBe(0);
    expect(o.text()).toContain('kept     shutro.config.ts');
    expect(o.text()).toContain('The apps are already installed.');
    expect(o.text()).toContain('A company already exists: kept.');
    expect(await rows(sql`SELECT count(*)::int AS n FROM res_company`)).toEqual([{ n: 1 }]);
  });

  test('unknown apps and currencies are refused before anything is written', async () => {
    const o = io(projects, { env: {} });
    expect(await runCli(['init', 'bad', '--database', url, '--apps', 'crm', '--yes'], o)).toBe(2);
    expect(o.text()).toContain(
      'Unknown app(s): crm. Apps: settings, account, sale, purchase, project.',
    );
    expect(existsSync(join(projects, 'bad'))).toBe(false);
    expect(
      await runCli(['init', 'bad', '--database', url, '--currency', 'XYZ', '--yes'], io(projects)),
    ).toBe(2);
  });
});

describe('shutro apps', () => {
  const acme = () => join(projects, 'acme');

  test('list and info, as text and JSON', async () => {
    const text = io(acme());
    expect(await runCli(['apps', 'list'], text)).toBe(0);
    expect(text.text()).toMatch(/Purchase\s+purchase\s+1\.0\.0\s+installed/);
    expect(text.text()).toContain('5 of 5 apps installed, 12 modules in total.');

    const json = io(acme());
    expect(await runCli(['apps', 'list', '--all', '--json'], json)).toBe(0);
    const catalog = JSON.parse(json.text()) as { name: string; state: string; icon: string }[];
    expect(catalog).toHaveLength(12);
    expect(catalog.every((a) => a.state === 'installed' && a.icon.startsWith('<svg'))).toBe(true);

    const info = io(acme());
    expect(await runCli(['apps', 'info', 'purchase'], info)).toBe(0);
    expect(info.text()).toMatch(/used by\s+purchase_account, sale_purchase/);
  });

  test('removing data without a terminal needs --yes; the preview shows what goes', async () => {
    const o = io(acme());
    expect(await runCli(['apps', 'uninstall', 'project'], o)).toBe(2);
    expect(o.text()).toMatch(/project_task_stage\s+project\s+5\s+-> quarantine/);
    expect(o.text()).toContain('run the command again with --yes');
    expect(await rows(sql`SELECT state FROM shutro_module WHERE name = 'project'`)).toEqual([
      { state: 'installed' },
    ]);
  });

  test('a terminal asks; dependents are offered; quarantine and restore', async () => {
    const answers = ['y', 'y'];
    const o = io(acme(), { prompt: async () => answers.shift() ?? '' });
    await rows(sql`INSERT INTO res_partner (name, active) VALUES ('Globex', true)`);
    await rows(
      sql`INSERT INTO project_project (name, company_id, active) SELECT (${sql.param(JSON.stringify({ en_US: 'Website' }), 'text')})::jsonb, id, true FROM res_company`,
    );
    expect(await runCli(['apps', 'uninstall', 'project'], o)).toBe(0);
    expect(o.text()).toContain('Recoverable for 30 days');
    expect(
      await rows(
        sql`SELECT state FROM shutro_module WHERE name IN ('project', 'sale_project') ORDER BY name`,
      ),
    ).toEqual([{ state: 'quarantined' }, { state: 'quarantined' }]);

    const list = io(acme());
    await runCli(['apps', 'list'], list);
    expect(list.text()).toMatch(
      /project\s+1\.0\.0\s+uninstalled · data kept until \d{4}-\d{2}-\d{2}/,
    );

    const back = io(acme());
    expect(await runCli(['apps', 'install', 'project', '--yes'], back)).toBe(0);
    expect(back.text()).toContain('data restored');
    expect(await rows(sql`SELECT name->>'en_US' AS name FROM project_project`)).toEqual([
      { name: 'Website' },
    ]);
  });

  test('--json prints the plan, every step and the result, one object per line', async () => {
    const o = io(acme());
    expect(await runCli(['apps', 'uninstall', 'sale_project', '--yes', '--json'], o)).toBe(0);
    const events = o
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; operation?: string; modules?: string[] });
    expect(events[0]?.type).toBe('plan');
    expect(events.some((e) => e.type === 'step')).toBe(true);
    expect(events.at(-2)?.type).toBe('done');
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      operation: 'uninstall',
      modules: ['sale_project'],
    });
    // A glue module comes back with the next install that completes it.
    expect(await runCli(['apps', 'install', 'sale_project', '--yes'], io(acme()))).toBe(0);
  });

  test('purge drops quarantined data now when asked', async () => {
    const o = io(acme());
    expect(await runCli(['apps', 'uninstall', 'project', '--purge', '--yes'], o)).toBe(0);
    expect(o.text()).toContain('Purge: the data above is deleted');
    expect(await rows(sql`SELECT to_regclass('public.project_project') IS NULL AS gone`)).toEqual([
      { gone: true },
    ]);
    const again = io(acme());
    expect(await runCli(['apps', 'install', 'project', '--yes'], again)).toBe(0);
    expect(await rows(sql`SELECT count(*)::int AS n FROM project_project`)).toEqual([{ n: 0 }]);
  });

  test('projects without an install list do not manage apps', async () => {
    const o = io(join(import.meta.dirname, 'fixtures'));
    expect(await runCli(['apps', 'list'], o)).toBe(2);
    expect(o.text()).toContain('has no install list');
  });
});

describe('shutro doctor', () => {
  test('checks the setup and names the fix for each warning', async () => {
    const o = io(join(projects, 'acme'));
    expect(await runCli(['doctor'], o)).toBe(0);
    const text = o.text();
    expect(text).toContain('[ok] PostgreSQL 18');
    expect(text).toContain('12 modules build together');
    expect(text).toContain('[ok] 5 apps installed');
    expect(text).toContain('generated file(s) are stale -> run "shutro generate"');
  });

  test('a broken database URL is a failure with exit 1', async () => {
    const o = io(join(projects, 'acme'), {
      env: { SHUTRO_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
    });
    expect(await runCli(['doctor'], o)).toBe(1);
    expect(o.text()).toContain('[x] Cannot use the database');
  });
});
