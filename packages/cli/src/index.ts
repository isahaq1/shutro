/**
 * @packageDocumentation
 * `@shutro/cli`: `shutro init | doctor | apps | generate | migrate | inspect`.
 */

export { type AppsFlags, appsCommand, progressReporter } from './apps.js';
export { type CliIo, runCli } from './cli.js';
export { defineConfig, loadConfig, type ShutroConfig } from './config.js';
export { CliError, type CliErrorCode, ConfigError, ModuleSourceError } from './errors.js';
export {
  type GeneratedFile,
  type GenerateOptions,
  type GenerateResult,
  generate,
} from './generate/generate.js';
export {
  definitionsHash,
  fieldType,
  importSpecifier,
  interfaceName,
  type ModuleSource,
  renderAppIndex,
  renderBindings,
  renderSchema,
} from './generate/render.js';
export { initProject } from './init.js';
export { inspectModel, inspectRegistry } from './inspect.js';
export {
  appManaged,
  appsOf,
  databaseUrl,
  loadProject,
  type Project,
  runningRegistry,
  withDriver,
} from './project.js';
export { doctor, guidedInit, type InitFlags, redact } from './setup.js';
export {
  count,
  createUi,
  duration,
  type OutputMode,
  outputMode,
  type Ui,
  type UiIo,
  visibleWidth,
} from './ui.js';
