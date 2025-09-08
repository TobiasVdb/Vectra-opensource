import { describe, test, expect } from 'vitest';

import { calculateAvoidingPath, pathIntersectsZone } from './pathfinding.js';

describe('pathIntersectsZone', () => {
  const polygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0],[0, 0.01],[0.01, 0.01],[0.01, 0],[0, 0]]]
    }
  };
  const multipolygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0],[0, 0.01],[0.01, 0.01],[0.01, 0],[0, 0]]],
        [[[0.02, 0],[0.02, 0.01],[0.03, 0.01],[0.03, 0],[0.02, 0]]]
      ]
    }
  };

  test('detects intersections for Polygon', () => {
    expect(pathIntersectsZone([[-0.01, -0.01], [0.005, 0.005]], polygon)).toBe(true);
    expect(pathIntersectsZone([[0.02, 0.02], [0.03, 0.03]], polygon)).toBe(false);
  });

  test('detects intersections for MultiPolygon', () => {
    expect(pathIntersectsZone([[-0.01, -0.01], [0.025, 0.005]], multipolygon)).toBe(true);
    expect(pathIntersectsZone([[-0.01, -0.01], [-0.02, -0.02]], multipolygon)).toBe(false);
  });
});

describe('calculateAvoidingPath', () => {
  const polygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0],[0, 0.01],[0.01, 0.01],[0.01, 0],[0, 0]]]
    }
  };
  const multipolygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0],[0, 0.01],[0.01, 0.01],[0.01, 0],[0, 0]]],
        [[[0.02, 0],[0.02, 0.01],[0.03, 0.01],[0.03, 0],[0.02, 0]]]
      ]
    }
  };

  test('returns straight path when no intersection', () => {
    const start = [-0.01, -0.01];
    const dest = [-0.02, -0.02];
    const { path } = calculateAvoidingPath(start, dest, [polygon]);
    expect(path).toEqual([start, dest]);
  });

  test('detours when route crosses Polygon zone', () => {
    const start = [-0.005, 0.005];
    const dest = [0.015, 0.005];
    expect(pathIntersectsZone([start, dest], polygon)).toBe(true);
    const { path } = calculateAvoidingPath(start, dest, [polygon]);
    expect(path.length).toBeGreaterThan(2);
    expect(pathIntersectsZone(path, polygon)).toBe(false);
  });

  test('detours when route crosses MultiPolygon zone', () => {
    const start = [0.015, 0.005];
    const dest = [0.035, 0.005];
    expect(pathIntersectsZone([start, dest], multipolygon)).toBe(true);
    const { path } = calculateAvoidingPath(start, dest, [multipolygon]);
    expect(path.length).toBeGreaterThan(2);
    expect(pathIntersectsZone(path, multipolygon)).toBe(false);
  });

  test('handles adjacent zones with segment starting on a boundary', () => {
    const zone1 = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0],[0, 0.01],[0.01, 0.01],[0.01, 0],[0, 0]]]
      }
    };
    const zone2 = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[0.01, 0],[0.01, 0.01],[0.02, 0.01],[0.02, 0],[0.01, 0]]]
      }
    };
    const start = [-0.005, 0.005];
    const dest = [0.025, 0.005];

    const { path } = calculateAvoidingPath(start, dest, [zone1, zone2]);
    expect(pathIntersectsZone(path, zone1)).toBe(false);
    expect(pathIntersectsZone(path, zone2)).toBe(false);
  });
});
