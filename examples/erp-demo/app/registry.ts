/**
 * The application: every installed module (dependencies are collected from invoice).
 */
import { buildRegistry } from '@shutro/core';
import { invoice } from '../modules/invoice/module.ts';

export const registry = buildRegistry({ modules: [invoice] });
