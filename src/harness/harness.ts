import type { Config } from "../config";
import type { Turn } from "../model";
import { omp } from "./omp";

export interface SessionRef {
  harness: string;
  key: string;
  file: string;
  cwd: string;
  title?: string;
}

/** Folds one raw record into the turn list; returns every turn it created or changed. */
export interface Reader {
  push(record: unknown): Turn[];
}

export interface Harness {
  id: string;
  locate(opts: { sessionFile?: string; tty?: string; cwd: string }): Promise<SessionRef>;
  resolve(key: string): Promise<SessionRef>;
  reader(ref: SessionRef, opts: { config: Config }): Reader;
}

export const harnesses = { omp } as const;
export type HarnessId = keyof typeof harnesses;

/** Own-property lookup, so ids such as "toString" are not harnesses. */
export function harnessById(id: string): Harness | undefined {
  return Object.hasOwn(harnesses, id) ? harnesses[id as HarnessId] : undefined;
}
