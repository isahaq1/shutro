/**
 * @packageDocumentation
 * `@shutro/cli`: `shutro generate` (per-module and application type views, RFC 0002 §7.7). `init`, `migrate` and
 * `inspect` arrive with the CLI roadmap item.
 */
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
