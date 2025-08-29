import React, { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Globe,
  Moon,
  Sun,
  ArrowClockwise,
  Stack,
  UserCircle,
  SealCheck,
  SealWarning,
  Cloud
} from '@phosphor-icons/react';
import AuthDialog from './AuthDialog';
import {
  getFlightGoNoGo,
  haversineDistance,
  decimalMinutesToTime,
  getEstimatedMissionTimeAtWhichDroneShouldReturnInMinutes,
  getEstimatedCurrentCapacityConsumedAtWhichDroneShouldReturn
} from './utils.js';

import * as turf from '@turf/turf';
import { isZoneActive } from './fetchActiveGeozones.js';

mapboxgl.accessToken = 'pk.eyJ1Ijoic25pbGxvY21vdCIsImEiOiJjbThxY2U2MmIwYWE2MmtzOHhyNjdqMjZnIn0.3b-7Y5j4Uxy5kNCqcLaaYw';

const DEST_URLS = {
  Belgium: 'https://vectrabackyard-3dmb6.ondigitalocean.app/missions',
  Spain: '/spain-demo-flights.json'
};

const STATUS_COLORS = {
  confirmed: '#4caf50',
  pending: '#ff9800',
  cancelled: '#f44336'
};

const PRACTICAL_BATTERY_CAPACITY = 21;

const MAP_STYLES = [
  {
    key: 'dark',
    style: 'mapbox://styles/mapbox/dark-v11',
    icon: Moon,
    isDark: true
  },
  {
    key: 'light',
    style: 'mapbox://styles/mapbox/light-v11',
    icon: Sun,
    isDark: false
  },
  {
    key: 'satellite',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    icon: Globe,
    isDark: false
  }
];

function nearestBasestation([lon, lat], stations) {
  let nearest = null;
  let min = Infinity;
  stations.forEach(bs => {
    const dist = haversineDistance(lat, lon, bs.lat, bs.lng);
    if (dist < min) {
      min = dist;
      nearest = bs;
    }
  });
  return { nearest, distance: isFinite(min) ? min : null };
}

function formatTimeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function findSegmentIndex(ring, pt) {
  // Use nearestPointOnLine for robust segment lookup
  const line = turf.lineString([...ring, ring[0]]);
  const snapped = turf.nearestPointOnLine(line, pt);
  return typeof snapped?.properties?.index === 'number'
    ? snapped.properties.index
    : -1;
}

function buildPath(ring, p1, p2, i1, i2, forward) {
  const n = ring.length;
  const path = [p1];
  if (forward) {
    let idx = (i1 + 1) % n;
    while (idx !== (i2 + 1) % n) {
      path.push(ring[idx]);
      idx = (idx + 1) % n;
    }
  } else {
    let idx = i1 === 0 ? n - 1 : i1 - 1;
    while (idx !== i2) {
      path.push(ring[idx]);
      idx = idx === 0 ? n - 1 : idx - 1;
    }
    path.push(ring[i2]);
  }
  path.push(p2);
  return path;
}

function avoidNoFlyZones(start, end, polygons = []) {
  const getRings = geom => {
    if (!geom) return [];
    const normalize = ring => {
      if (!ring.length) return ring;
      const first = ring[0];
      const last = ring[ring.length - 1];
      return first[0] === last[0] && first[1] === last[1]
        ? ring.slice(0, -1)
        : ring;
    };
    if (geom.type === 'Polygon') {
      return [normalize(geom.coordinates[0])];
    }
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.map(p => normalize(p[0]));
    }
    return [];
  };

  let path = [start, end];

  polygons.forEach(feature => {
    // Only consider active polygonal zones
    if (!isZoneActive(feature?.properties)) return;
    const rings = getRings(feature.geometry);
    if (rings.length === 0) return;

    const newPath = [path[0]];

    for (let i = 0; i < path.length - 1; i++) {
      let segment = [path[i], path[i + 1]];

      rings.forEach(ring => {
        const polygon = turf.polygon([ring.concat([ring[0]])]);
        const line = turf.lineString(segment);
        const intersections = turf.lineIntersect(line, polygon);

        let points = intersections.features.map(f => f.geometry.coordinates);

        if (turf.booleanPointInPolygon(turf.point(segment[0]), polygon)) {
          points.unshift(segment[0]);
        }
        if (turf.booleanPointInPolygon(turf.point(segment[1]), polygon)) {
          points.push(segment[1]);
        }

        if (points.length >= 2) {
          const sorted = points.sort(
            (a, b) =>
              turf.distance(turf.point(segment[0]), turf.point(a)) -
              turf.distance(turf.point(segment[0]), turf.point(b))
          );
          const p1 = sorted[0];
          const p2 = sorted[sorted.length - 1];
          const idx1 = findSegmentIndex(ring, p1);
          const idx2 = findSegmentIndex(ring, p2);
          if (idx1 === -1 || idx2 === -1) return;
          const fwd = buildPath(ring, p1, p2, idx1, idx2, true);
          const bwd = buildPath(ring, p1, p2, idx1, idx2, false);
          const option1 = [segment[0], ...fwd, segment[1]];
          const option2 = [segment[0], ...bwd, segment[1]];
          const len1 = turf.length(turf.lineString(option1));
          const len2 = turf.length(turf.lineString(option2));
          segment = len1 < len2 ? option1 : option2;
        }
      });

      newPath.push(...segment.slice(1));
    }

    path = newPath;
  });

  return path;
}

function formatZoneValue(val) {
  if (!val || typeof val !== 'object') return val;
  const formatTime = t =>
    t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '';
  if (val.Specific || val.General || val.Condition) {
    const parts = [];
    const spec = val.Specific?.properties;
    if (spec) {
      parts.push(
        `Specific: ${formatTime(spec.startTime)} - ${formatTime(spec.endTime)}`
      );
    }
    const gen = val.General?.properties;
    if (gen) {
      const start = formatTime(gen.startDateTime);
      const end = formatTime(gen.endDateTime);
      const perm = gen.permanent === '1' || gen.permanent === true;
      parts.push(`General: ${perm ? 'permanent' : `${start} - ${end}`}`);
    }
    const cond = val.Condition?.properties;
    if (cond) {
      const act = formatTime(cond.activationdate);
      const status = cond.condition_en || '';
      parts.push(`Condition: ${status}${act ? ` (${act})` : ''}`);
    }
    return parts.join('<br/>');
  }
  return JSON.stringify(val);
}

function getZoneId(feature) {
  const props = feature?.properties || {};
  return (
    props.id ||
    props.ID ||
    props.zone_id ||
    props.zoneId ||
    props.zoneID ||
    props.UAS_ZONE_ID ||
    props.uasZoneId ||
    props.UasZoneId ||
    props.identifier ||
    props.name ||
    JSON.stringify(feature.geometry)
  );
}

function generateHoverCircle(center, radiusMeters = 50, points = 60) {
  const [lng, lat] = center;
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLat = 111320;
  const mPerDegLng = Math.cos(latRad) * 111320;
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    const dx = (radiusMeters / mPerDegLng) * Math.cos(angle);
    const dy = (radiusMeters / mPerDegLat) * Math.sin(angle);
    coords.push([lng + dx, lat + dy]);
  }
  return coords;

}

export default function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const baseMarkerRef = useRef(null);
  const noFlyHandlersRef = useRef({});
  const nfzPopupRef = useRef(null);
  const layerFeaturesRef = useRef({});
  const [destinations, setDestinations] = useState([]);
  const [basestations, setBasestations] = useState([]);
  const [autoTimer, setAutoTimer] = useState(null);
  const autoIntervalRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [showDialog, setShowDialog] = useState(true);
  const [limit, setLimit] = useState(10);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [latError, setLatError] = useState('');
  const [lngError, setLngError] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('Belgium');
  const countries = ['Belgium', 'Spain', 'Manual'];
  const manualMode = selectedCountry === 'Manual';

  function handleManualLatChange(e) {
    const value = e.target.value;
    setManualLat(value);
    const num = parseFloat(value);
    if (isNaN(num) || num < -90 || num > 90) {
      setLatError('Latitude must be between -90 and 90');
    } else {
      setLatError('');
    }
  }

  function handleManualLngChange(e) {
    const value = e.target.value;
    setManualLng(value);
    const num = parseFloat(value);
    if (isNaN(num) || num < -180 || num > 180) {
      setLngError('Longitude must be between -180 and 180');
    } else {
      setLngError('');
    }
  }

  const visibleDestinations = useMemo(
    () => (manualMode ? [] : destinations.slice(0, limit)),
    [manualMode, destinations, limit]
  );

  const [kpData, setKpData] = useState(null);
  const [showKp, setShowKp] = useState(false);
  // map display mode: '2d', '3d', or '3e' (3D with terrain elevation); default '3e'
  const [mapMode, setMapMode] = useState('3e');
  const autoSoundRef = useRef(null);
  const [mapStyleIndex, setMapStyleIndex] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!localStorage.getItem('jwt'));
  const [showAuth, setShowAuth] = useState(false);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('email') || '');
  const [layers, setLayers] = useState([]);
  const [showLayers, setShowLayers] = useState(false);
  const [selectedLayerIds, setSelectedLayerIds] = useState([]);
  const initialLayerIdsRef = useRef([]);
  const hoveredDestIdRef = useRef(null);
  const [layerFeatures, setLayerFeatures] = useState([]);
  const [routeNoFlyZones, setRouteNoFlyZones] = useState([]);
  const [clearedZoneIds, setClearedZoneIds] = useState([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showWeather, setShowWeather] = useState(false);

  const [pendingDest, setPendingDest] = useState(null);

  useEffect(() => {
    const folder = pendingDest ? '/favico_active' : '/favico_inactive';
    const setHref = (id, file) => {
      const el = document.getElementById(id);
      if (el) el.href = `${folder}/${file}`;
    };
    setHref('favicon-32', 'favicon-32x32.png');
    setHref('favicon-16', 'favicon-16x16.png');
    setHref('favicon-ico', 'favicon.ico');
    setHref('apple-touch-icon', 'apple-touch-icon.png');
    setHref('site-manifest', 'site.webmanifest');
  }, [pendingDest]);

  const currentStyle = MAP_STYLES[mapStyleIndex];
  const isDark = currentStyle.isDark;
  const nextStyle = MAP_STYLES[(mapStyleIndex + 1) % MAP_STYLES.length];
  const NextIcon = nextStyle.icon;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('selectedLayerIds') || '[]');
      if (Array.isArray(saved)) {
        initialLayerIdsRef.current = saved;
      }
    } catch (e) {
      console.error('Failed to parse saved layer ids', e);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('selectedLayerIds', JSON.stringify(selectedLayerIds));
  }, [selectedLayerIds]);

  useEffect(() => {
    if (!isLoggedIn || !mapLoaded || initialLayerIdsRef.current.length === 0) return;
    const ids = [...initialLayerIdsRef.current];
    initialLayerIdsRef.current = [];
    ids.forEach(id => toggleLayer(id));
  }, [isLoggedIn, mapLoaded]);

  // init map
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
    }
    setMapLoaded(false);
    mapRef.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: currentStyle.style,
      center: [0, 0],
      zoom: 2,
      attributionControl: false
    });
    mapRef.current.on('load', () => {
      if (selected) {
        focusDestination(selected);
      }
      setMapLoaded(true);
      applyMapMode(mapMode);
    });
  }, [mapStyleIndex]);

  useEffect(() => {
    document.body.classList.toggle('light', !isDark);
  }, [isDark]);

  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const handler = e => {
      if (!manualMode) return;
      const { lng, lat } = e.lngLat;
      setManualLat(lat.toFixed(5));
      setManualLng(lng.toFixed(5));
    };
    map.on('dblclick', handler);
    if (manualMode) {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
    return () => map.off('dblclick', handler);
  }, [manualMode]);

  // preload auto-detection sound
  useEffect(() => {
    autoSoundRef.current = new Audio('/missionnotification.mp3');
  }, []);

  // load kp data
  useEffect(() => {
    async function loadKp() {
      try {
        const res = await fetch('https://vectrabackyard-3dmb6.ondigitalocean.app/kp');
        const data = await res.json();
        setKpData(data);
      } catch (e) {
        console.error('Failed to load kp data', e);
      }
    }
    loadKp();
  }, []);

  // load basestations
  useEffect(() => {
    fetch('/basestations.json')
      .then(res => res.json())
      .then(setBasestations);
  }, []);

  // show basestations on the map
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || basestations.length === 0) return;
    const map = mapRef.current;
    const features = basestations.map(bs => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [bs.lng, bs.lat] },
      properties: { name: bs.name }
    }));
    const geojson = { type: 'FeatureCollection', features };
    if (map.getSource('basestations')) {
      map.getSource('basestations').setData(geojson);
    } else {
      map.addSource('basestations', { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'basestation-points',
        type: 'circle',
        source: 'basestations',
        paint: { 'circle-color': '#f7931e', 'circle-radius': 4 }
      });
      map.addLayer({
        id: 'basestation-labels',
        type: 'symbol',
        source: 'basestations',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-anchor': 'top'
        },
        paint: { 'text-color': isDark ? '#fff' : '#000' }
      });
    }
  }, [basestations, mapLoaded, isDark]);


  // toggle weather layer
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const sourceId = 'owm-clouds';
    const layerId = 'owm-clouds';
    if (showWeather) {
      const apiKey = "215a1158194b4deb8daa1f3aa92cf73f";
      if (!apiKey) {
        console.warn('OpenWeather API key missing');
        return;
      }
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [
            `https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${apiKey}`
          ],
          tileSize: 256,
          attribution: 'Weather data © <a href="https://openweathermap.org/" target="_blank">OpenWeather</a>'
        });
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: { 'raster-opacity': 0.6 }
        });
      }
    } else {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, [showWeather, mapLoaded]);


  // load layers when logged in
  useEffect(() => {
    if (!isLoggedIn || !mapLoaded) return;
    async function loadLayers() {
      try {
        const token = localStorage.getItem('jwt');
        const res = await fetch('https://vectrabackyard-3dmb6.ondigitalocean.app/layers', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        setLayers(data);

      } catch (e) {
        console.error('Failed to load layers', e);
      }
    }
    loadLayers();
  }, [isLoggedIn, mapLoaded]);

  // load destinations
  useEffect(() => {
    if (manualMode) {
      setDestinations([]);
      return;
    }

    async function load() {
      try {
        const url = DEST_URLS[selectedCountry];
        const res = await fetch(url);
        const data = await res.json();
        data.sort(
          (a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime)
        );
        setDestinations(data);
      } catch (e) {
        console.error('Failed to load destinations', e);
      }
    }
    load();
  }, [selectedCountry, manualMode]);

  // place markers when destinations load or filter changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || visibleDestinations.length === 0) return;

    const features = [];
    const bounds = new mapboxgl.LngLatBounds();

    visibleDestinations.forEach((d, i) => {
      const lng = parseFloat(d.longitude);
      const lat = parseFloat(d.latitude);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        features.push({
          type: 'Feature',
          id: i,
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { status: d.status, index: i, mission_name: d.mission_name }
        });
        bounds.extend([lng, lat]);
      }
    });

    const geojson = { type: 'FeatureCollection', features };
    const map = mapRef.current;

    if (map.getSource('destinations')) {
      map.getSource('destinations').setData(geojson);
    } else {
      map.addSource('destinations', {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterRadius: 40
      });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'destinations',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#555',
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 25, 30],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff'
        }
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'destinations',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 12
        },
        paint: { 'text-color': '#fff' }
      });

      map.addLayer({
        id: 'unclustered-point',
        type: 'circle',
        source: 'destinations',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'status'],
            'confirmed', '#4caf50',
            'announced', '#ffffff',
            '#888888'
          ],
          'circle-radius': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            10,
            6
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': [
            'match',
            ['get', 'status'],
            'announced', '#000000',
            '#fff'
          ]
        }
      });

      map.addLayer({
        id: 'unclustered-label',
        type: 'symbol',
        source: 'destinations',
        filter: ['!', ['has', 'point_count']],
        minzoom: 12,
        layout: {
          'text-field': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            ['get', 'mission_name'],
            ['get', 'status']
          ],
          'text-size': 10,
          'text-offset': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            [1.2, 0],
            [0, 1.2]
          ],
          'text-anchor': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            'left',
            'top'
          ]
        },
        paint: {
          'text-color': [
            'match',
            ['get', 'status'],
            'confirmed', '#ffffff',
            'announced', '#000000',
            '#000000'
          ],
          'text-halo-color': [
            'match',
            ['get', 'status'],
            'confirmed', '#4caf50',
            'announced', '#ffffff',
            '#ffffff'
          ],
          'text-halo-width': 1
        }
      });

      map.on('click', 'unclustered-point', e => {
        const idx = Number(e.features[0].properties.index);
        focusDestination(destinations[idx]);
      });

      map.on('mousemove', 'unclustered-point', e => {
        if (e.features.length > 0) {
          const id = e.features[0].id;
          if (hoveredDestIdRef.current !== id) {
            if (hoveredDestIdRef.current !== null) {
              map.setFeatureState(
                { source: 'destinations', id: hoveredDestIdRef.current },
                { hover: false }
              );
            }
            hoveredDestIdRef.current = id;
            map.setFeatureState(
              { source: 'destinations', id },
              { hover: true }
            );
          }
          map.getCanvas().style.cursor = 'pointer';
        }
      });

      map.on('mouseleave', 'unclustered-point', () => {
        if (hoveredDestIdRef.current !== null) {
          map.setFeatureState(
            { source: 'destinations', id: hoveredDestIdRef.current },
            { hover: false }
          );
        }
        hoveredDestIdRef.current = null;
        map.getCanvas().style.cursor = '';
      });
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 40, pitch: mapMode === '2d' ? 0 : 60 });
    }
  }, [destinations, limit, mapLoaded]);


  // auto select recent destination
  useEffect(() => {
    const recent = visibleDestinations.find(
      d => Date.now() - new Date(d.createdDateTime).getTime() < 20 * 60 * 1000
    );
    if (!recent) return;
    if (selected && selected !== recent) {
      setPendingDest(recent);
      autoSoundRef.current?.play();
      return;
    }
    if (selected) return;

    setSelected(recent);
    let counter = 10;
    setAutoTimer(counter);
    autoIntervalRef.current = setInterval(() => {
      counter -= 1;
      setAutoTimer(counter);
      if (counter <= 0) {
        clearInterval(autoIntervalRef.current);
        autoIntervalRef.current = null;
        autoSoundRef.current?.play();
        focusDestination(recent);
      }
    }, 1000);
    return () => {
      clearInterval(autoIntervalRef.current);
      autoIntervalRef.current = null;
    };
  }, [destinations, limit]);

  useEffect(() => {
    if (selected) {
      focusDestination(selected, clearedZoneIds);
    }
  }, [clearedZoneIds]);

  function stopAutoSelect() {
    if (autoIntervalRef.current) {
      clearInterval(autoIntervalRef.current);
      autoIntervalRef.current = null;
    }
    setAutoTimer(null);
  }

  function clearOverlays(options = {}) {
    const { keepSelected = false } = options;
    setShowDialog(false);
    setShowLayers(false);
    if (!keepSelected) {
      setSelected(null);
    }
    if (nfzPopupRef.current) {
      nfzPopupRef.current.remove();
      nfzPopupRef.current = null;
    }
  }

  function focusDestination(dest, clearedIdsOverride) {
    const isNewDest = dest !== selected;
    clearOverlays();
    stopAutoSelect();
    setSelected(dest);
    if (isNewDest && clearedIdsOverride === undefined) {
      setClearedZoneIds([]);
    }
    if (
      !mapRef.current ||
      !mapRef.current.isStyleLoaded() ||
      basestations.length === 0
    )
      return;
    const map = mapRef.current;
    // Stop any ongoing camera animations so a new focus can take effect
    map.stop();

    const destCoord = [parseFloat(dest.longitude), parseFloat(dest.latitude)];
    const { nearest } = nearestBasestation(destCoord, basestations);
    if (!nearest) return;

    if (baseMarkerRef.current) {
      baseMarkerRef.current.remove();
    }
    baseMarkerRef.current = new mapboxgl.Marker({ color: '#f7931e' })
      .setLngLat([nearest.lng, nearest.lat])
      .addTo(map);
    const start = [nearest.lng, nearest.lat];
    let coords = [start, destCoord];
    let violated = [];
    const allFeatures = Object.values(layerFeaturesRef.current).flat();
    const clearedIds =
      clearedIdsOverride ?? (isNewDest ? [] : clearedZoneIds);
    const activeFeatures = allFeatures.filter(
      f => !clearedIds.includes(getZoneId(f))
    );
    if (activeFeatures.length > 0) {
      coords = avoidNoFlyZones(start, destCoord, activeFeatures);
      const path = turf.lineString(coords);
      violated = activeFeatures.filter(f => {
        if (!isZoneActive(f?.properties)) return false;
        if (f.geometry?.type !== 'Polygon') return false;
        const poly = turf.polygon(f.geometry.coordinates);
        return (
          turf.booleanPointInPolygon(turf.point(start), poly) ||
          turf.booleanPointInPolygon(turf.point(destCoord), poly) ||
          turf.lineIntersect(path, poly).features.length > 0
        );
      });
    }
    setRouteNoFlyZones(violated);
    const hoverCircle = generateHoverCircle(destCoord);
    const line = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [...coords, ...hoverCircle] }
    };
    if (map.getSource('flight')) {
      map.getSource('flight').setData(line);
    } else {
      map.addSource('flight', { type: 'geojson', data: line });
      map.addLayer({
        id: 'flight',
        type: 'line',
        source: 'flight',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#f7931e',
          'line-width': 4
        }
      });
    }
    const bounds = new mapboxgl.LngLatBounds(start, destCoord);
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, {
      padding: { left: 300, right: 40, top: 40, bottom: 40 },
      pitch: mapMode === '2d' ? 0 : 60
    });
  }

  function handleClearZone(zone) {
    const id = getZoneId(zone);
    const map = mapRef.current;
    Object.entries(layerFeaturesRef.current).forEach(([layerId, feats]) => {
      const filtered = feats.filter(f => getZoneId(f) !== id);
      if (filtered.length !== feats.length) {
        layerFeaturesRef.current[layerId] = filtered;
        if (map && map.getSource(`uas-layer-${layerId}`)) {
          map.getSource(`uas-layer-${layerId}`).setData({
            type: 'FeatureCollection',
            features: filtered
          });
        }
      }
    });
    const flattened = Object.values(layerFeaturesRef.current).flat();
    setLayerFeatures(flattened);
    setRouteNoFlyZones(zones => zones.filter(z => getZoneId(z) !== id));
    const newCleared = [...clearedZoneIds, id];
    setClearedZoneIds(newCleared);
    if (selected) {
      focusDestination(selected, newCleared);
    }
  }

  function applyMapMode(mode) {
    if (!mapRef.current) return;
    const map = mapRef.current;
    if (mode === '2d') {
      map.setTerrain(null);
      if (map.getLayer('3d-buildings')) {
        map.removeLayer('3d-buildings');
      }
      if (map.getLayer('terrain-contours')) {
        map.removeLayer('terrain-contours');
      }
      if (map.getSource('mapbox-terrain')) {
        map.removeSource('mapbox-terrain');
      }
      if (map.getSource('mapbox-dem')) {
        map.removeSource('mapbox-dem');
      }
      map.easeTo({ pitch: 0 });
    } else {
      const layers = map.getStyle().layers;
      const labelLayerId = layers.find(
        l => l.type === 'symbol' && l.layout['text-field']
      )?.id;
      if (!map.getLayer('3d-buildings')) {
        map.addLayer(
          {
            id: '3d-buildings',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            // Render buildings from a further zoom level so they appear earlier
            minzoom: 13,
            paint: {
              'fill-extrusion-color': '#aaa',
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-base': ['get', 'min_height'],
              'fill-extrusion-opacity': 0.6
            }
          },
          labelLayerId
        );
      }
      if (mode === '3e') {
        if (!map.getSource('mapbox-dem')) {
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14
          });
        }
        if (!map.getSource('mapbox-terrain')) {
          map.addSource('mapbox-terrain', {
            type: 'vector',
            url: 'mapbox://mapbox.mapbox-terrain-v2'
          });
        }
        if (!map.getLayer('terrain-contours')) {
          map.addLayer({
            id: 'terrain-contours',
            type: 'line',
            source: 'mapbox-terrain',
            'source-layer': 'contour',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': isDark ? '#fff' : '#000',
              'line-width': 1
            }
          });
        }
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
      } else {
        if (map.getLayer('terrain-contours')) {
          map.removeLayer('terrain-contours');
        }
        if (map.getSource('mapbox-terrain')) {
          map.removeSource('mapbox-terrain');
        }
        if (map.getSource('mapbox-dem')) {
          map.removeSource('mapbox-dem');
        }
        map.setTerrain(null);
      }
      map.easeTo({ pitch: 60 });
    }
    setMapMode(mode);
  }

  function cycleMapMode() {
    const next = mapMode === '2d' ? '3d' : mapMode === '3d' ? '3e' : '2d';
    applyMapMode(next);
  }

  function cycleMapStyle() {
    setMapLoaded(false);
    setMapStyleIndex(i => (i + 1) % MAP_STYLES.length);
  }

  function resetView() {
    stopAutoSelect();
    clearOverlays();
    setShowDialog(true);
    setClearedZoneIds([]);
    if (!mapRef.current) return;
    // Stop any ongoing camera animations so the reset can take effect
    mapRef.current.stop();
    if (mapRef.current.getLayer('flight')) {
      mapRef.current.removeLayer('flight');
    }
    if (mapRef.current.getSource('flight')) {
      mapRef.current.removeSource('flight');
    }
    if (visibleDestinations.length) {
      const bounds = new mapboxgl.LngLatBounds();
      visibleDestinations.forEach(d => {
        const lng = parseFloat(d.longitude);
        const lat = parseFloat(d.latitude);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          bounds.extend([lng, lat]);
        }
      });
      if (!bounds.isEmpty()) {
        mapRef.current.fitBounds(bounds, {
          padding: 40,
          pitch: mapMode === '2d' ? 0 : 60
        });
      }
    }
  }

  function rotateMap() {
    if (!mapRef.current) return;
    const bearing = mapRef.current.getBearing();
    mapRef.current.rotateTo(bearing + 90, { duration: 500 });
  }

  function openLayers() {
    if (!isLoggedIn) {
      setShowAuth(true);
      return;
    }
    clearOverlays();
    setShowLayers(true);
  }

  async function toggleLayer(id) {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const fillId = `uas-layer-fill-${id}`;
    const outlineId = `uas-layer-outline-${id}`;
    const sourceId = `uas-layer-${id}`;
    if (selectedLayerIds.includes(id)) {
      if (map.getLayer(fillId)) map.removeLayer(fillId);
      if (map.getLayer(outlineId)) map.removeLayer(outlineId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      const handlers = noFlyHandlersRef.current[id];
      if (handlers) {
        map.off('click', fillId, handlers.click);
        map.off('mouseenter', fillId, handlers.mouseenter);
        map.off('mouseleave', fillId, handlers.mouseleave);
        delete noFlyHandlersRef.current[id];
      }
      delete layerFeaturesRef.current[id];
      setLayerFeatures(Object.values(layerFeaturesRef.current).flat());
      setSelectedLayerIds(ids => ids.filter(lid => lid !== id));
      return;
    }

    const token = localStorage.getItem('jwt');
    try {
      const res = await fetch(`https://vectrabackyard-3dmb6.ondigitalocean.app/layers/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const layerDetails = await res.json();
      let features;
      try {
        const firstParse = JSON.parse(layerDetails.content);
        features = Array.isArray(firstParse) ? firstParse : JSON.parse(firstParse);
      } catch (e) {
        console.error('Failed to parse layer GeoJSON', e);
        return;
      }
      const filtered = features
        .filter(f => {
          const props = f?.properties || {};
          if (!isZoneActive(props)) return false;
          const rawLower =
            props.lowerlimit ?? props.lowerLimit ?? props.LowerLimit;
          const match = String(rawLower ?? '').match(/-?\d+(\.\d+)?/);
          const lowerLimit = match ? parseFloat(match[0]) : NaN;
          const unit = String(
            props.loweraltitudeunit ||
              props.lowerAltitudeUnit ||
              props.LowerAltitudeUnit ||
              ''
          ).toLowerCase();
          const maxAlt = unit.startsWith('f') ? 400 : 122; // 400ft or ~122m
          return !Number.isFinite(lowerLimit) || lowerLimit <= maxAlt;
        })
        .filter(f => !clearedZoneIds.includes(getZoneId(f)));
      const geojson = { type: 'FeatureCollection', features: filtered };
      layerFeaturesRef.current[id] = filtered;
      setLayerFeatures(Object.values(layerFeaturesRef.current).flat());
      map.addSource(sourceId, { type: 'geojson', data: geojson });
      const colorExpression = [
        'case',
        ['==', ['get', 'activationStatus'], 'soon'],
        '#FFB347',
        '#FF0000'
      ];
      map.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': colorExpression, 'fill-opacity': 0.3 }
      });
      map.addLayer({
        id: outlineId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': colorExpression, 'line-width': 1.5 }
      });

      const clickHandler = e => {
        const features = e.features || [];
        if (!features.length) return;
        // If a destination marker exists at this point, open its overlay instead
        const dest = map.queryRenderedFeatures(e.point, {
          layers: ['unclustered-point']
        });
        if (dest.length) {
          const idx = Number(dest[0].properties.index);
          focusDestination(destinations[idx]);
          return;
        }
        clearOverlays({ keepSelected: true });
        const popup = new mapboxgl.Popup().setLngLat(e.lngLat).addTo(map);
        popup.addClassName('nfz-popup');
        nfzPopupRef.current = popup;
        let idx = 0;

        const render = () => {
          const rawProps = features[idx]?.properties || {};
          const props = { ...rawProps };

          // Merge unit fields like altitudeunits into their base value
          Object.keys(props).forEach(key => {
            const lower = key.toLowerCase();
            if (lower.endsWith('units')) {
              const baseKey = Object.keys(props).find(
                k => k.toLowerCase() === lower.replace(/units$/, '')
              );
              if (
                baseKey &&
                props[baseKey] != null &&
                props[baseKey] !== '' &&
                props[key] != null &&
                props[key] !== ''
              ) {
                props[baseKey] = `${props[baseKey]} ${props[key]}`;
              }
              delete props[key];
            }
          });

          const combineLimits = (limit, unit, ref) => {
            const limitKey = Object.keys(props).find(
              k => k.toLowerCase() === limit
            );
            const unitKey = Object.keys(props).find(
              k => k.toLowerCase() === unit
            );
            const refKey = Object.keys(props).find(
              k => k.toLowerCase() === ref
            );
            if (limitKey) {
              let val = props[limitKey];
              if (
                unitKey &&
                props[unitKey] != null &&
                String(props[unitKey]).trim() !== ''
              ) {
                val = `${val} ${props[unitKey]}`.trim();
                delete props[unitKey];
              }
              if (
                refKey &&
                props[refKey] != null &&
                String(props[refKey]).trim() !== ''
              ) {
                val = `${val} ${props[refKey]}`.trim();
                delete props[refKey];
              }
              props[limitKey] = val;
            } else {
              if (unitKey) delete props[unitKey];
              if (refKey) delete props[refKey];
            }
          };

          combineLimits(
            'lowerlimit',
            'loweraltitudeunit',
            'loweraltitudereference'
          );
          combineLimits(
            'upperlimit',
            'upperaltitudeunit',
            'upperaltitudereference'
          );

          const hidden = [
            'globalid',
            'shape__area',
            'shape__length',
            'latitude',
            'longitude',
            'parentid',
            'objectid'
          ];

          const rows = Object.entries(props)
            .filter(
              ([k, v]) =>
                !hidden.includes(k.toLowerCase()) &&
                v != null &&
                String(v).trim() !== ''
            )
            .map(([k, v]) => {
              let value = v;
              if (k.toLowerCase() === 'activationsources') {
                try {
                  const parsed =
                    typeof value === 'string' ? JSON.parse(value) : value;
                  const parts = [];
                  const spec = parsed?.Specific?.properties;
                  if (spec) {
                    const start = spec.writtenStartTime || spec.startTime;
                    const end = spec.writtenEndTime || spec.endTime;
                    parts.push(`Specific: ${start || ''} - ${end || ''}`.trim());
                  }
                  const gen = parsed?.General?.properties;
                  if (gen) {
                    let range;
                    if (gen.permanent === '1' || gen.permanent === true) {
                      range = 'Permanent';
                    } else {
                      const start =
                        gen.writtenStartDateTime || gen.startDateTime;
                      const end = gen.writtenEndDateTime || gen.endDateTime;
                      range = `${start || ''} - ${end || ''}`.trim();
                    }
                    parts.push(`General: ${range}`);
                  }
                  const cond = parsed?.Condition?.properties;
                  if (cond) {
                    const act =
                      cond.writtenactivationdate || cond.activationdate;
                    parts.push(`Condition: ${act || ''}`.trim());
                  }
                  value = parts.join('; ');
                } catch (e) {
                  value = typeof value === 'string' ? value : JSON.stringify(value);
                }
              }
              return `<tr><th>${k}</th><td>${value}</td></tr>`;
            })
            .join('');
          const nav =
            features.length > 1
              ? `<div class="nfz-popup-nav"><button id="nfz-prev">Prev</button><span>${idx + 1} / ${features.length}</span><button id="nfz-next">Next</button></div>`
              : '';
          popup.setHTML(
            `<div class="nfz-popup-content">${nav}<table>${rows}</table></div>`
          );
          if (features.length > 1) {
            const prev = document.getElementById('nfz-prev');
            const next = document.getElementById('nfz-next');
            prev?.addEventListener('click', () => {
              idx = (idx - 1 + features.length) % features.length;
              render();
            });
            next?.addEventListener('click', () => {
              idx = (idx + 1) % features.length;
              render();
            });
          }
        };

        render();
      };
      const mouseEnterHandler = () => {
        map.getCanvas().style.cursor = 'pointer';
      };
      const mouseLeaveHandler = () => {
        map.getCanvas().style.cursor = '';
      };

      map.on('click', fillId, clickHandler);
      map.on('mouseenter', fillId, mouseEnterHandler);
      map.on('mouseleave', fillId, mouseLeaveHandler);

      noFlyHandlersRef.current[id] = {
        click: clickHandler,
        mouseenter: mouseEnterHandler,
        mouseleave: mouseLeaveHandler
      };
      setSelectedLayerIds(ids => [...ids, id]);
    } catch (e) {
      console.error('Failed to load layer', e);
    }
  }

  function logout() {
    localStorage.removeItem('jwt');
    localStorage.removeItem('email');
    setIsLoggedIn(false);
    setDisplayName('');
    setLayers([]);
    setShowLayers(false);
    setSelectedLayerIds([]);
    setLayerFeatures([]);
    setRouteNoFlyZones([]);
    setClearedZoneIds([]);
    layerFeaturesRef.current = {};
    if (mapRef.current) {
      selectedLayerIds.forEach(id => {
        const fillId = `uas-layer-fill-${id}`;
        const outlineId = `uas-layer-outline-${id}`;
        const sourceId = `uas-layer-${id}`;
        const handlers = noFlyHandlersRef.current[id];
        if (handlers) {
          mapRef.current.off('click', fillId, handlers.click);
          mapRef.current.off('mouseenter', fillId, handlers.mouseenter);
          mapRef.current.off('mouseleave', fillId, handlers.mouseleave);
        }
        if (mapRef.current.getLayer(fillId)) mapRef.current.removeLayer(fillId);
        if (mapRef.current.getLayer(outlineId)) mapRef.current.removeLayer(outlineId);
        if (mapRef.current.getSource(sourceId)) mapRef.current.removeSource(sourceId);
      });
      if (mapRef.current.getLayer('uas-layer-fill-base')) mapRef.current.removeLayer('uas-layer-fill-base');
      if (mapRef.current.getLayer('uas-layer-outline-base')) mapRef.current.removeLayer('uas-layer-outline-base');
      if (mapRef.current.getSource('uas-layer-base')) mapRef.current.removeSource('uas-layer-base');
    }
    noFlyHandlersRef.current = {};
  }

  function setManualDestination(lat, lng) {
    const dest = {
      mission_name: 'Manual',
      latitude: lat,
      longitude: lng,
      zone: 'Manual',
      createdDateTime: new Date().toISOString(),
      status: '',
      customer: ''
    };
    focusDestination(dest);
  }

  return (
    <>
      <div ref={mapContainer} className="map-container" />
      <div className="top-right">
        <button className="glass-effect" onClick={cycleMapStyle} aria-label="Toggle map style">
          <NextIcon size={18} />
        </button>
        {kpData && (
          <button
            className={`kp-pill glass-effect${kpData.kp > 5 ? ' high' : ''}`}
            onClick={() => setShowKp(true)}
          >
            kp {kpData.kp.toFixed(2)}
          </button>
        )}
        <button className="btn-3d glass-effect" onClick={cycleMapMode}>
          {mapMode === '2d' ? '3D' : mapMode === '3d' ? '3E' : '2D'}
        </button>
        <button className="glass-effect" onClick={rotateMap} aria-label="Rotate map">
          <ArrowClockwise size={18} />
        </button>
        <button className="glass-effect" onClick={resetView} aria-label="Reset view">
          <Globe size={18} />
        </button>
        <button
          onClick={() => setShowWeather(w => !w)}
          className={`glass-effect${showWeather ? ' active' : ''}`}
          aria-label="Toggle weather"
        >
          <Cloud size={18} />
        </button>
        <button className="glass-effect" onClick={openLayers} aria-label="Layers">
          <Stack size={18} />
        </button>
        {isLoggedIn ? (
          <button className="glass-effect" onClick={logout} aria-label="Logout">
            {displayName.charAt(0).toUpperCase()}
          </button>
        ) : (
          <button className="glass-effect" onClick={() => setShowAuth(true)} aria-label="Login">
            <UserCircle size={18} />
          </button>
        )}
      </div>
      {showAuth && (
        <AuthDialog
          onAuthenticated={email => {
            setIsLoggedIn(true);
            setDisplayName(email);
          }}
          onClose={() => setShowAuth(false)}
        />
      )}
      {showKp && kpData && (
        <div className="kp-modal glass-effect">
          <h3>Geomagnetic Activity (Kp)</h3>
          <div className="kp-bar">
            <div
              className="kp-bar-inner"
              style={{ width: `${(kpData.kp / 9) * 100}%` }}
            />
          </div>
          <div className="kp-modal-value">{kpData.kp.toFixed(2)}</div>
          <p>Geomagnetic Activity: {kpData.geomagnetic_activity}</p>
          <p>GNSS Impact: {kpData.gnss_impact}</p>
          <p>Drone Risk: {kpData.drone_risk}</p>
          <h4>Kp Sources</h4>
          <ul>
            <li>NOAA (SWPC): {kpData.services_swpc_noaa_gov?.kp}</li>
            <li>GFZ Potsdam: {kpData.kp_gfz_potsdam_de?.kp}</li>
            <li>Spaceweather: {kpData.spaceweather_gfz_potsdam_de?.kp}</li>
          </ul>
          <button onClick={() => setShowKp(false)}>Close</button>
        </div>
      )}
      {showLayers && (
        <div className="dialog glass-effect">
          <h3>Layers</h3>
          <ul>
            {layers.map(l => (
              <li key={l.id}>
                <button
                  className={`dest-btn${selectedLayerIds.includes(l.id) ? ' active' : ''}`}
                  onClick={() => toggleLayer(l.id)}
                >
                  {l.name || l.title || `Layer ${l.id}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showDialog && (
        <div className="dialog flights-panel glass-effect">
          <div className="flights-header">
            <h3>Flights</h3>
            <select
              value={selectedCountry}
              onChange={e => setSelectedCountry(e.target.value)}
            >
              {countries.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {!manualMode && (
            <div className="filter-buttons">
              {[10, 50, 100].map(n => (
                <button
                  key={n}
                  onClick={() => {
                    setLimit(n);
                  }}
                  className={limit === n ? 'active' : ''}
                >
                  Last {n}
                </button>
              ))}
            </div>
          )}
          {manualMode ? (
            <div className="manual-entry">
              <label>
                Latitude
                <input
                  type="number"
                  placeholder="Latitude"
                  value={manualLat}
                  onChange={handleManualLatChange}
                />
                {latError && <span className="error">{latError}</span>}
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  placeholder="Longitude"
                  value={manualLng}
                  onChange={handleManualLngChange}
                />
                {lngError && <span className="error">{lngError}</span>}
              </label>
              <p className="manual-description">
                You can also double click on the map to select lat & long.
              </p>
              <button
                onClick={() => {
                  const lat = parseFloat(manualLat);
                  const lng = parseFloat(manualLng);
                  if (
                    !isNaN(lat) &&
                    !isNaN(lng) &&
                    !latError &&
                    !lngError
                  ) {
                    setManualDestination(lat, lng);
                  }
                }}
                disabled={
                  !!latError ||
                  !!lngError ||
                  manualLat === '' ||
                  manualLng === ''
                }
              >
                Go
              </button>
            </div>
          ) : (
            <ul>
              {visibleDestinations.map((d, i) => {
                const destCoord = [parseFloat(d.longitude), parseFloat(d.latitude)];
                const { distance } = nearestBasestation(destCoord, basestations);
                const distText = distance ? `${distance.toFixed(1)} km` : 'N/A';
                const far = distance !== null && distance > 5;
                const isRecent =
                  Date.now() - new Date(d.createdDateTime).getTime() < 20 * 60 * 1000;
                return (
                  <li key={i} className={`flight-item ${far ? 'far' : 'near'}`}>
                    <button
                      className={`flight-btn${isRecent ? ' recent' : ''}`}
                      onClick={() => {
                        focusDestination(d);
                      }}
                    >
                      <div className="zone">{d.zone}</div>
                      <div className="mission">{d.mission_name}</div>
                      <div className="time">
                        {formatTimeAgo(d.createdDateTime)} - {distText}
                      </div>

                      {isRecent && autoTimer !== null && selected === d && (
                        <div className="countdown">Auto in {autoTimer}s</div>
                      )}

                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {selected && !showDialog &&
        (() => {
          const destCoord = [
            parseFloat(selected.longitude),
            parseFloat(selected.latitude)
          ];
          const { distance, nearest } = nearestBasestation(destCoord, basestations);
          const distText = distance ? `${distance.toFixed(1)} km` : 'N/A';
          if (!nearest) return null;

          const distanceMeters = (distance || 0) * 1000;
          const avgWind = 2.06;
          const gust = 3.06;
          const windFrom = 0;

          const flight = getFlightGoNoGo(
            distanceMeters,
            avgWind,
            gust,
            windFrom,
            nearest.lat,
            nearest.lng,
            parseFloat(selected.latitude),
            parseFloat(selected.longitude)
          );

          const returnCapacity =
            PRACTICAL_BATTERY_CAPACITY -
            getEstimatedCurrentCapacityConsumedAtWhichDroneShouldReturn(distanceMeters);
          const returnTime = decimalMinutesToTime(
            getEstimatedMissionTimeAtWhichDroneShouldReturnInMinutes(distanceMeters)
          );

          return (
            <div className="info-panel glass-effect">

              <h3>Flight Info</h3>

              <div className={`flight-status ${flight.allOk ? 'ok' : 'no'}`}>
                {flight.allOk ? (
                  <SealCheck size={18} weight="fill" />
                ) : (
                  <SealWarning size={18} weight="fill" />
                )}
                <span>
                  Flight is {flight.allOk ? 'GO' : 'NO GO'}
                </span>
              </div>

              <div className="info-group">
                <div className="info-row">
                  <span className="label">Mission</span>
                  <span className="value">{selected.mission_name}</span>
                </div>
                <div className="info-row">
                  <span className="label">Status</span>
                  <span className="value">{selected.status}</span>
                </div>
                <div className="info-row">
                  <span className="label">Zone</span>
                  <span className="value">{selected.zone}</span>
                </div>
                <div className="info-row">
                  <span className="label">Customer</span>
                  <span className="value">{selected.customer}</span>
                </div>
                <div className="info-row">
                  <span className="label">Created</span>
                  <span className="value">
                    {formatTimeAgo(selected.createdDateTime)}
                  </span>
                </div>
              </div>

              <div className="info-group">
                <div className="info-row">
                  <span className="label">Wind</span>
                  <span className={`value ${flight.windAtCruiseAltCheck ? 'ok' : 'no'}`}>
                    {flight.windAtCruiseAltCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {avgWind.toFixed(2)} m/s
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Gust</span>
                  <span className={`value ${flight.maxGustAtCruiseAltCheck ? 'ok' : 'no'}`}>
                    {flight.maxGustAtCruiseAltCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {gust.toFixed(2)} m/s
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Outbound speed</span>
                  <span
                    className={`value ${flight.outboundGroundSpeedCheck ? 'ok' : 'no'}`}
                  >
                    {flight.outboundGroundSpeedCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {flight.outboundGroundSpeed?.toFixed(1) ?? 'N/A'} m/s
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Return speed</span>
                  <span
                    className={`value ${flight.returnGroundSpeedCheck ? 'ok' : 'no'}`}
                  >
                    {flight.returnGroundSpeedCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {flight.returnGroundSpeed?.toFixed(1) ?? 'N/A'} m/s
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Distance</span>
                  <span
                    className={`value ${flight.outboundCapacityCheck ? 'ok' : 'no'}`}
                  >
                    {flight.outboundCapacityCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {distText}
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Return Capacity</span>
                  <span
                    className={`value ${flight.returnCapacityCheck ? 'ok' : 'no'}`}
                  >
                    {flight.returnCapacityCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {returnCapacity.toFixed(2)} Ah
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Return at mission time</span>
                  <span
                    className={`value ${flight.timeOnStationBatteryCheck ? 'ok' : 'no'}`}
                  >
                    {flight.timeOnStationBatteryCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {returnTime}
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Ground speed to dest</span>
                  <span
                    className={`value ${flight.outboundGroundSpeedCheck ? 'ok' : 'no'}`}
                  >
                    {flight.outboundGroundSpeedCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {flight.outboundGroundSpeed?.toFixed(1)} m/s
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">Ground speed back</span>
                  <span
                    className={`value ${flight.returnGroundSpeedCheck ? 'ok' : 'no'}`}
                  >
                    {flight.returnGroundSpeedCheck ? (
                      <SealCheck size={16} weight="fill" />
                    ) : (
                      <SealWarning size={16} weight="fill" />
                    )}
                    {flight.returnGroundSpeed?.toFixed(1)} m/s
                  </span>
                </div>
                {kpData && kpData.kp_index !== undefined && (
                  <div className="info-row">
                    <span className="label">KP</span>
                    <span
                      className={`value ${kpData.kp_index < 5 ? 'ok' : 'no'}`}
                    >
                      {kpData.kp_index < 5 ? (
                        <SealCheck size={16} weight="fill" />
                      ) : (
                        <SealWarning size={16} weight="fill" />
                      )}
                      {kpData.kp_index}
                    </span>
                  </div>
                )}
              </div>
              {routeNoFlyZones.length > 0 && (
                <div className="nfz-clearance">
                  <h4>No Fly Zones</h4>
                  {routeNoFlyZones.map(z => {
                    const id = getZoneId(z);
                    const name =
                      z.properties?.name || z.properties?.id || 'Unnamed';
                    return (
                      <div key={id} className="nfz-item">
                        <span>{name}</span>
                        <button onClick={() => handleClearZone(z)}>
                          Clear for this flight
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button className="back-link" onClick={resetView}>
                Back to flight list
              </button>
            </div>
          );
        })()}
      {pendingDest &&
        (() => {
          const destCoord = [
            parseFloat(pendingDest.longitude),
            parseFloat(pendingDest.latitude)
          ];
          const { distance } = nearestBasestation(destCoord, basestations);
          const distText = distance ? `${distance.toFixed(1)} km` : 'N/A';
          return (
            <div className="toast glass-effect">
              <div>
                <div className="zone">{pendingDest.zone}</div>
                <div className="mission">{pendingDest.mission_name}</div>
                <div className="time">
                  {formatTimeAgo(pendingDest.createdDateTime)} - {distText}
                </div>
              </div>
              <button
                onClick={() => {
                  focusDestination(pendingDest);
                  setPendingDest(null);
                }}
              >
                Select
              </button>
            </div>
          );
        })()}
    </>
  );
}
