/**
 * Package specifiers written into generated and starter files. The single-package npm build (`shutro`) replaces
 * this module so user code imports `shutro`, `shutro/cli` and `shutro/apps` instead (scripts/pack-npm.ts).
 */
export const CORE_PACKAGE: string = '@shutro/core';
export const CLI_PACKAGE: string = '@shutro/cli';
export const APPS_PACKAGE: string = '@shutro/apps';
