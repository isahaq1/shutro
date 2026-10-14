import type { TestProject } from 'vitest/node';
import { startTargets, type Targets } from '../src/containers.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    direct: string;
    bouncer: string;
  }
}

let targets: Targets | undefined;

export async function setup(project: TestProject): Promise<void> {
  targets = await startTargets();
  project.provide('direct', targets.direct);
  project.provide('bouncer', targets.bouncer);
}

export async function teardown(): Promise<void> {
  await targets?.stop();
}
