export function parseDateSafe(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d) ? null : d.getTime();
}

export function isZoneActive(props, now = Date.now()) {
  if (!props) return false;

  const status = props.activationStatus;
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase();
    if (normalized === 'inactive') return false;
    if (normalized === 'soon') return true;
  }

  if (typeof props.active === 'boolean') {
    return props.active;
  }

  const checkWindow = (start, end, permanent) => {
    const s = parseDateSafe(start);
    const e = parseDateSafe(end);
    if (permanent === true || permanent === '1') return true;
    if (s && now < s) return false;
    if (e && now > e) return false;
    return (!s || now >= s) && (!e || now <= e);
  };

  const statusLabel = props.status;
  if (typeof statusLabel === 'string' && statusLabel.toLowerCase() === 'recurring') {
    return checkWindow(props.startTime, props.endTime);
  }

  const raw = props.activationSources;
  if (!raw) {
    return true;
  }

  let sources;
  try {
    sources = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return true;
  }

  const specific = sources.Specific?.properties || {};
  if (checkWindow(specific.startTime, specific.endTime)) return true;

  const general = sources.General?.properties || {};
  if (checkWindow(general.startDateTime, general.endDateTime, general.permanent)) return true;

  const condition = sources.Condition?.properties || {};
  const activation = parseDateSafe(condition.activationdate);
  if (!activation || now >= activation) return true;

  return false;
}

export async function fetchActiveGeozones() {
  const now = Date.now();
  const soonThresholdMs = 8 * 60 * 60 * 1000; // 8 hours

  const toGeoJSON = url =>
    fetch(`${url}/query?where=1=1&outFields=*&f=geojson`)
      .then(res => res.json())
      .then(data => data.features || []);

  const masterZones = await toGeoJSON(
    'https://services3.arcgis.com/om3vWi08kAyoBbj3/arcgis/rest/services/Geozone_Download_Prod/FeatureServer/0'
  );

  const [specificSet, generalSet, conditionSet] = await Promise.all([
    toGeoJSON('https://services3.arcgis.com/om3vWi08kAyoBbj3/arcgis/rest/services/Specific_Time_Download_Prod/FeatureServer/0'),
    toGeoJSON('https://services3.arcgis.com/om3vWi08kAyoBbj3/arcgis/rest/services/General_Time_Download_Prod/FeatureServer/0'),
    toGeoJSON('https://services3.arcgis.com/om3vWi08kAyoBbj3/arcgis/rest/services/Condition_Download_Prod/FeatureServer/0'),
  ]);

  const activeMap = new Map();
  const sourceMap = new Map();

  // Specific time zones — date-ranged
  for (const f of specificSet) {
    const p = f.properties || {};
    const id = p.ParentID?.trim();
    if (!id) continue;

    const start = parseDateSafe(p.startTime);
    const end = parseDateSafe(p.endTime);
    const isActive = start && end && now >= start && now <= end;
    const isSoon = start && start > now && start <= now + soonThresholdMs;
    if (!isActive && !isSoon) continue;

    if (!sourceMap.has(id)) sourceMap.set(id, {});
    sourceMap.get(id).Specific = f;

    activeMap.set(id, {
      activationStatus: isActive ? 'active' : 'soon',
      activationSource: 'Specific',
      name: p.name || '',
      days: p.days,
      status: p.status || '',
      startTime: start,
      endTime: end,
      permanent: false
    });
  }

  // General time zones — permanent or date-ranged
  for (const f of generalSet) {
    const p = f.properties || {};
    const id = p.ParentID;
    if (!id) continue;

    const start = parseDateSafe(p.startDateTime);
    const end = parseDateSafe(p.endDateTime);
    const isPermanent = p.permanent === '1' || p.permanent === true;

    const isActive = isPermanent || (start && end && now >= start && now <= end);
    const isSoon = start && start > now && start <= now + soonThresholdMs;

    if (isActive || isSoon) {
      if (!sourceMap.has(id)) sourceMap.set(id, {});
      sourceMap.get(id).General = f;

      activeMap.set(id, {
        activationStatus: isActive ? 'active' : 'soon',
        activationSource: 'General',
        name: p.name || '',
        days: '',
        status: p.status || '',
        startTime: start,
        endTime: end,
        permanent: isPermanent
      });
    }
  }

  // Condition zones — based on condition status
  for (const f of conditionSet) {
    const p = f.properties || {};
    const id = p.GlobalID;
    if (!id) continue;

    const activation = parseDateSafe(p.activationdate);

    if (!sourceMap.has(id)) sourceMap.set(id, {});
    sourceMap.get(id).Condition = f;

    activeMap.set(id, {
      activationStatus: 'active',
      activationSource: 'Condition',
      name: p.name || '',
      days: '',
      status: p.condition_en,
      type: p.type_en,
      startTime: activation,
      endTime: null,
      permanent: false
    });
  }

  const tooBig = 300_000_000_000; // 300 km²
  const masterIDs = new Set(masterZones.map(z => z.properties?.ParentID));
  const filtered = masterZones
    .filter(zone => {
      const id = zone.properties?.ParentID;
      const gid = zone.properties?.GlobalID;
      const isInActivationMap = activeMap.has(id) || activeMap.has(gid);
      if (!isInActivationMap) return false;
      const rawLower = zone.properties?.lowerLimit;
      const match = String(rawLower ?? '').match(/-?\d+(\.\d+)?/);
      const lowerLimit = match ? parseFloat(match[0]) : NaN;
      const unit = String(zone.properties?.lowerAltitudeUnit || '').toLowerCase();
      const maxAltitude = unit.startsWith('f') ? 400 : 122; // 400 ft or ~122 m
      const isAltitudeOk =
        !Number.isFinite(lowerLimit) || lowerLimit <= maxAltitude;
      const isRenderable =
        isAltitudeOk && (zone.properties?.Shape__Area || 0) < tooBig;
      return isRenderable;
    })
    .map(zone => {
      const id = zone.properties?.ParentID;
      const gid = zone.properties?.GlobalID;
      const activation = activeMap.get(id) || activeMap.get(gid);
      const originalSources = sourceMap.get(id) || sourceMap.get(gid) || {};
      zone.properties = {
        ...zone.properties,
        ...activation,
        activationSources: originalSources,
        activationStatus: activation?.activationStatus || 'inactive'
      };
      return zone;
    });

  return filtered;
}

export default fetchActiveGeozones;
