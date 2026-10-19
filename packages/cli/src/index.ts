/**
 * @packageDocumentation
 * `@shutro/cli`: `shutro init | generate | migrate | inspect`.
 */
export { type CliIo, runCli } from './cli.js';
export { defineConfig, loadConfig, type ShutroConfig } from './config.js';
export { CliError, type CliErrorCode, ConfigError, ModuleSourceError } from './errors.js';
export {
  type GeneratedFile,
  type GenerateOptions,
  type GenerateResult,
  generate,
  loadSources,
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
export { databaseUrl, loadProject, type Project, withDriver } from './project.js';
