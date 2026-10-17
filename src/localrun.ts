/**
 * Saving a run into the MobAI app's local run history, so a run started from
 * the app's editor shows in its local dashboard. Only the app asks for it:
 * it opens a slot in its history and names it in `MOBAI_E2E_LOCAL_RUN_DIR`,
 * with the run id in `MOBAI_E2E_LOCAL_RUN_ID`. Without both, nothing is
 * written anywhere. The app commits the slot, or drops it, when the run's
 * process ends.
 */

import { copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FinishedRun } from 'e2e';
import { toBundle, type BundleCase } from './reporter.ts';

/** A local run's case: the dashboard bundle's, plus the case's recording and device log. */
interface LocalCase extends BundleCase {
  videos?: { path: string; format: 'mp4' | 'mjpeg'; fps?: number; bytes: number }[];
  deviceLog?: { path: string; bytes: number };
}

/** MJPEG recordings are on a fixed 25 fps grid (the app plays them at that). */
const MJPEG_FPS = 25;

/** The slot the app asked the run to be saved into, if it asked. */
export function localRunTarget(env: Readonly<Record<string, string | undefined>>): { dir: string; runId: string } | undefined {
  const dir = env['MOBAI_E2E_LOCAL_RUN_DIR']?.trim() ?? '';
  const runId = env['MOBAI_E2E_LOCAL_RUN_ID']?.trim() ?? '';
  if (dir === '' || runId === '' || !path.isAbsolute(dir)) return undefined;
  return { dir, runId };
}

/**
 * Writes the run into `dir`: its files under `artifacts/` at their report
 * paths, then `run.json`, last and whole, so the app never commits half a run.
 * Returns the summary line.
 */
export async function writeLocalRun(run: FinishedRun, target: { dir: string; runId: string }, projectName: string): Promise<string> {
  const { bundle, files } = toBundle(run.report, { projectName });
  if (bundle.cases.length === 0) return 'not saved locally: no test ran';
  bundle.runId = target.runId;
  const artifacts = path.join(target.dir, 'artifacts');
  const saved = new Map<string, number>();
  for (const file of files) {
    if (saved.has(file.path)) continue;
    const to = inside(artifacts, file.path);
    if (to === undefined) continue;
    try {
      await mkdir(path.dirname(to), { recursive: true });
      if (file.text !== undefined) await writeFile(to, file.text);
      else await copyFile(path.join(run.artifactsRoot, ...file.path.split('/')), to);
      saved.set(file.path, (await stat(to)).size);
    } catch {
      // A file the run never wrote is left out, and so is its reference.
    }
  }
  const cases = bundle.cases as LocalCase[];
  for (const c of cases) {
    for (const step of c.steps) {
      if (!saved.has(step.screenshot)) step.screenshot = '';
      if (!saved.has(step.uiTree)) step.uiTree = '';
    }
  }
  for (const file of files) {
    const bytes = saved.get(file.path);
    if ((file.type !== 'video' && file.type !== 'device_log') || bytes === undefined) continue;
    const c = cases.find((x) => x.id === file.caseId && x.attempt === file.attempt);
    if (c === undefined) continue;
    if (file.type === 'device_log') {
      c.deviceLog = { path: file.path, bytes };
      continue;
    }
    const format = path.posix.extname(file.path).toLowerCase() === '.mjpeg' ? 'mjpeg' : 'mp4';
    (c.videos ??= []).push({ path: file.path, format, ...(format === 'mjpeg' ? { fps: MJPEG_FPS } : {}), bytes });
  }
  const runJson = path.join(target.dir, 'run.json');
  await writeFile(`${runJson}.part`, JSON.stringify(bundle, null, 2));
  await rename(`${runJson}.part`, runJson);
  return 'saved to the local dashboard';
}

/** `rel` under `root`, or undefined when it would leave it. */
function inside(root: string, rel: string): string | undefined {
  const to = path.resolve(root, ...rel.split('/'));
  return to.startsWith(root + path.sep) ? to : undefined;
}
