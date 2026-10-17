/** Custom gestures: a drag along a path of points, each leg with its own speed. */

import { TestError } from 'e2e/engine';
import type { Point } from './client.ts';

/** A coordinate in screen points, or a share of the screen (`'50%'`). */
export type Coordinate = number | `${number}%`;

/** One point of a `device.drag` path. */
export interface DragPoint {
  readonly x: Coordinate;
  readonly y: Coordinate;
  /** How long the finger takes to get here from the point before, in milliseconds. Default 300; ignored on the first point. */
  readonly durationMs?: number;
  /** How long the finger rests here before it moves on, in milliseconds. On the first point, a press and hold before the drag. */
  readonly holdMs?: number;
}

export const DEFAULT_LEG_MS = 300;

/** Resolves one coordinate against the screen's extent on its axis. */
export function resolveCoordinate(value: Coordinate, extent: number, name: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TestError('INVALID_ARGUMENT', `${name} must be a finite number, got ${String(value)}`);
    return value;
  }
  const match = /^(-?\d+(?:\.\d+)?)%$/.exec(value);
  if (match === null) throw new TestError('INVALID_ARGUMENT', `${name} takes points or a percentage like '50%', got ${JSON.stringify(value)}`);
  return (Number(match[1]) / 100) * extent;
}

/** Resolves a point against the screen. */
export function resolvePoint(point: { x: Coordinate; y: Coordinate }, viewport: { width: number; height: number }, name: string): Point {
  return { x: resolveCoordinate(point.x, viewport.width, `${name}.x`), y: resolveCoordinate(point.y, viewport.height, `${name}.y`) };
}

function duration(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new TestError('INVALID_ARGUMENT', `${name} must be zero or more milliseconds, got ${String(value)}`);
  return Math.round(value);
}

/**
 * The W3C actions for one finger following `points`: down on the first,
 * through every leg at its own duration, resting where a point says so, up
 * on the last.
 */
export function dragActions(points: readonly DragPoint[], viewport: { width: number; height: number }): Record<string, unknown>[] {
  if (points.length < 2) throw new TestError('INVALID_ARGUMENT', `drag needs at least two points, got ${String(points.length)}`);
  const steps: Record<string, unknown>[] = [];
  points.forEach((point, index) => {
    const name = `points[${String(index)}]`;
    const at = resolvePoint(point, viewport, name);
    const move = { type: 'pointerMove', x: Math.round(at.x), y: Math.round(at.y) };
    if (index === 0) {
      steps.push({ ...move, duration: 0 }, { type: 'pointerDown', button: 0 });
    } else {
      steps.push({ ...move, duration: duration(point.durationMs, DEFAULT_LEG_MS, `${name}.durationMs`) });
    }
    const hold = duration(point.holdMs, 0, `${name}.holdMs`);
    if (hold > 0) steps.push({ type: 'pause', duration: hold });
  });
  steps.push({ type: 'pointerUp', button: 0 });
  return [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: steps }];
}
