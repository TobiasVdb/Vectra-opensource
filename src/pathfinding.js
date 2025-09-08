import { lineString, lineIntersect, polygonToLine, booleanPointInPolygon, point, length, flattenEach, nearestPointOnLine, centroid } from '@turf/turf';

export function pathIntersectsZone(path, zone) {
  const geom = zone.geometry;
  if (!geom) return false;
  const poly =
    geom.type === 'Polygon' || geom.type === 'MultiPolygon' ? geom : null;
  if (!poly) return false;
  const line = lineString(path);
  const intersections = lineIntersect(line, polygonToLine(poly)).features;
  const filtered = intersections.filter(f => {
    const [x, y] = f.geometry.coordinates;
    return !path.some(p => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9);
  });
  if (filtered.length > 0) return true;
  return path.some(c => booleanPointInPolygon(point(c), poly));
}

function findSegmentIndex(ring, pt) {
  return nearestPointOnLine(lineString(ring), point(pt)).properties.index;
}

function buildPath(ring, startIdx, endIdx, direction) {
  const res = [];
  const len = ring.length - 1;
  let idx = startIdx;
  while (idx !== endIdx) {
    idx = (idx + direction + len) % len;
    res.push(ring[idx]);
  }
  return res;
}

export function calculateAvoidingPath(start, dest, zones = []) {
  let path = [start, dest];
  const maxIterations = 5;
  let iter = 0;

  while (iter < maxIterations) {
    let changed = false;

    zones.forEach(zone => {
      flattenEach(zone, poly => {
        const ring = poly.geometry.coordinates[0];
        const center = centroid(poly).geometry.coordinates;
        const nudge = pt => {
          const dx = pt[0] - center[0];
          const dy = pt[1] - center[1];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const off = 1e-6;
          return [pt[0] + (dx / len) * off, pt[1] + (dy / len) * off];
        };

        let i = 0;
        while (i < path.length - 1) {
          const a = path[i];
          const b = path[i + 1];
          const line = lineString([a, b]);
          let ints = lineIntersect(line, polygonToLine(poly)).features.map(f => f.geometry.coordinates);

          if (booleanPointInPolygon(point(a), poly)) ints.unshift(a);
          if (booleanPointInPolygon(point(b), poly)) ints.push(b);

          if (ints.length >= 2) {
            const p1 = ints[0];
            const p2 = ints[ints.length - 1];
            const sIdx = findSegmentIndex(ring, p1);
            const eIdx = findSegmentIndex(ring, p2);
            const cw = [p1, ...buildPath(ring, sIdx, eIdx, 1), p2].map(nudge);
            const ccw = [p1, ...buildPath(ring, sIdx, eIdx, -1), p2].map(nudge);
            const cwLen = length(lineString(cw));
            const ccwLen = length(lineString(ccw));
            const detour = cwLen < ccwLen ? cw : ccw;
            path.splice(i + 1, 1, ...detour, b);
            i += detour.length;
            changed = true;
          } else {
            i++;
          }
        }
      });
    });

    if (!changed) break;
    iter++;
  }

  const intersected = zones.filter(z => pathIntersectsZone(path, z));
  return { path, intersected, explored: [] };
}

export default {
  calculateAvoidingPath,
  pathIntersectsZone,
};
