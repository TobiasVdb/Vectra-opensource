import React, { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Globe,
  Moon,
  Sun,
  ArrowClockwise,
  Stack,
  Cloud,
  SealCheck,
  SealWarning,
  ChatCenteredText,
  Airplane
} from '@phosphor-icons/react';
import FeedbackDialog from './FeedbackDialog';
import { isZoneActive } from './fetchActiveGeozones.js';
import {
  lineString,
  lineIntersect,
  bbox,
  point,
  booleanPointInPolygon,
  distance,
  polygonToLine
} from '@turf/turf';
import {
  estimateActualDistance,
  getFlightGoNoGo,
  decimalMinutesToTime,
  getEstimatedMissionTimeAtWhichDroneShouldReturnInMinutes,
  getEstimatedCurrentCapacityConsumedAtWhichDroneShouldReturn
} from './utils.js';

mapboxgl.accessToken = 'pk.eyJ1Ijoic25pbGxvY21vdCIsImEiOiJjbThxY2U2MmIwYWE2MmtzOHhyNjdqMjZnIn0.3b-7Y5j4Uxy5kNCqcLaaYw';

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


const PRACTICAL_BATTERY_CAPACITY = 21;


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

function formatTimeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

function calculateAvoidingPath(start, dest, zones = []) {
  // Helper that checks whether a path intersects a given zone
  function pathIntersectsZone(path, zone) {
    const geom = zone.geometry;
    if (!geom) return false;
    const poly =
      geom.type === 'Polygon' || geom.type === 'MultiPolygon' ? geom : null;
    if (!poly) return false;
    const line = lineString(path);
    if (lineIntersect(line, polygonToLine(poly)).features.length > 0) return true;
    return path.some(c => booleanPointInPolygon(point(c), poly));
  }

  function segmentIntersects(a, b) {
    return zones.some(z => pathIntersectsZone([a, b], z));
  }

  // quick check for a direct straight path before running RRT
  const straightPath = [start, dest];
  const directIntersections = zones.filter(z => pathIntersectsZone(straightPath, z));
  if (directIntersections.length === 0) {
    return { path: straightPath, intersected: [], explored: [] };
  }

  let minLng = Math.min(start[0], dest[0]);
  let minLat = Math.min(start[1], dest[1]);
  let maxLng = Math.max(start[0], dest[0]);
  let maxLat = Math.max(start[1], dest[1]);
  zones.forEach(z => {
    const b = bbox(z);
    minLng = Math.min(minLng, b[0]);
    minLat = Math.min(minLat, b[1]);
    maxLng = Math.max(maxLng, b[2]);
    maxLat = Math.max(maxLat, b[3]);
  });
  const marginLng = (maxLng - minLng) * 0.1;
  const marginLat = (maxLat - minLat) * 0.1;
  minLng -= marginLng;
  maxLng += marginLng;
  minLat -= marginLat;
  maxLat += marginLat;

  const stepMeters = 200;
  const stepKm = stepMeters / 1000;
  const stepDeg = stepMeters / 111320;
  const maxIterations = 2000;
  const nodes = [{ point: start, parent: null }];
  const explored = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const target =
      iter % 5 === 0
        ? dest
        : [
            minLng + Math.random() * (maxLng - minLng),
            minLat + Math.random() * (maxLat - minLat)
          ];

    let nearestIndex = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = distance(point(nodes[i].point), point(target));
      if (d < nearestDist) {
        nearestDist = d;
        nearestIndex = i;
      }
    }
    const nearest = nodes[nearestIndex];
    const angle = Math.atan2(
      target[1] - nearest.point[1],
      target[0] - nearest.point[0]
    );
    const newPoint = [
      nearest.point[0] + stepDeg * Math.cos(angle),
      nearest.point[1] + stepDeg * Math.sin(angle)
    ];

    if (
      newPoint[0] < minLng ||
      newPoint[0] > maxLng ||
      newPoint[1] < minLat ||
      newPoint[1] > maxLat
    )
      continue;
    if (segmentIntersects(nearest.point, newPoint)) continue;

    nodes.push({ point: newPoint, parent: nearestIndex });
    explored.push([nearest.point, newPoint]);

    if (
      distance(point(newPoint), point(dest)) < stepKm &&
      !segmentIntersects(newPoint, dest)
    ) {
      const path = [];
      let idx = nodes.length - 1;
      while (idx !== null) {
        path.push(nodes[idx].point);
        idx = nodes[idx].parent;
      }
      path.reverse();
      path.push(dest);
      const intersected = zones.filter(z => pathIntersectsZone(path, z));
      return { path, intersected, explored };
    }
  }

  const fallback = [start, dest];
  const intersected = zones.filter(z => pathIntersectsZone(fallback, z));
  return { path: fallback, intersected, explored };
}

export default function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const noFlyHandlersRef = useRef({});
  const nfzPopupRef = useRef(null);
  const layerFeaturesRef = useRef({});
  const startMarkerRef = useRef(null);
  const destMarkerRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [showDialog, setShowDialog] = useState(true);
  const [manualStartLat, setManualStartLat] = useState('');
  const [manualStartLng, setManualStartLng] = useState('');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [startLatError, setStartLatError] = useState('');
  const [startLngError, setStartLngError] = useState('');
  const [latError, setLatError] = useState('');
  const [lngError, setLngError] = useState('');
  const [flightPath, setFlightPath] = useState([]);

  const flightInfo = useMemo(() => {
    if (flightPath.length < 2 || !selected) return null;
    const startLat = parseFloat(selected.startLatitude);
    const startLng = parseFloat(selected.startLongitude);
    const destLat = parseFloat(selected.latitude);
    const destLng = parseFloat(selected.longitude);
    if ([startLat, startLng, destLat, destLng].some(n => isNaN(n))) return null;
    const distance = estimateActualDistance(flightPath);
    const distanceMeters = distance * 1000;
    const avgWind = 2.06;
    const gust = 3.06;
    const windFrom = 0;
    const flight = getFlightGoNoGo(
      distanceMeters,
      avgWind,
      gust,
      windFrom,
      startLat,
      startLng,
      destLat,
      destLng
    );
    const returnCapacity =
      PRACTICAL_BATTERY_CAPACITY -
      getEstimatedCurrentCapacityConsumedAtWhichDroneShouldReturn(distanceMeters);
    const returnTime = decimalMinutesToTime(
      getEstimatedMissionTimeAtWhichDroneShouldReturnInMinutes(distanceMeters)
    );
    const distText = `${distance.toFixed(1)} km`;
    return { flight, returnCapacity, returnTime, distText, avgWind, gust };
  }, [flightPath, selected]);

  function handleManualStartLatChange(e) {
    const value = e.target.value;
    setManualStartLat(value);
    const num = parseFloat(value);
    if (isNaN(num) || num < -90 || num > 90) {
      setStartLatError('Latitude must be between -90 and 90');
    } else {
      setStartLatError('');
    }
  }

  function handleManualStartLngChange(e) {
    const value = e.target.value;
    setManualStartLng(value);
    const num = parseFloat(value);
    if (isNaN(num) || num < -180 || num > 180) {
      setStartLngError('Longitude must be between -180 and 180');
    } else {
      setStartLngError('');
    }
  }

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

  function clearStart() {
    setManualStartLat('');
    setManualStartLng('');
  }

  function clearDestination() {
    setManualLat('');
    setManualLng('');
  }

  function resetMission() {
    setSelected(null);
    setFlightPath([]);
    const map = mapRef.current;
    if (map) {
      if (map.getLayer('flight')) map.removeLayer('flight');
      if (map.getSource('flight')) map.removeSource('flight');
      if (map.getLayer('flight-trials')) map.removeLayer('flight-trials');
      if (map.getSource('flight-trials')) map.removeSource('flight-trials');
    }
  }

  const [kpData, setKpData] = useState(null);
  const [showKp, setShowKp] = useState(false);
  // map display mode: '2d', '3d', or '3e' (3D with terrain elevation); default '2d'
  const [mapMode, setMapMode] = useState('2d');
  const [mapStyleIndex, setMapStyleIndex] = useState(0);
  const [layers, setLayers] = useState([]);
  const [showLayers, setShowLayers] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const initialLayerIdRef = useRef(null);
  const [layerFeatures, setLayerFeatures] = useState([]);
  const [routeNoFlyZones, setRouteNoFlyZones] = useState([]);
  const [clearedZoneIds, setClearedZoneIds] = useState([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showWeather, setShowWeather] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  useEffect(() => {
    if (selected?.mission_name !== 'Manual') return;

    const sLat = parseFloat(manualStartLat);
    const sLng = parseFloat(manualStartLng);
    const dLat = parseFloat(manualLat);
    const dLng = parseFloat(manualLng);

    const valid =
      manualStartLat !== '' &&
      manualStartLng !== '' &&
      manualLat !== '' &&
      manualLng !== '' &&
      ![sLat, sLng, dLat, dLng].some(n => isNaN(n)) &&
      !startLatError &&
      !startLngError &&
      !latError &&
      !lngError;

    if (valid) {
      const matches =
        Number(selected.startLatitude) === sLat &&
        Number(selected.startLongitude) === sLng &&
        Number(selected.latitude) === dLat &&
        Number(selected.longitude) === dLng;
      if (!matches) {
        setManualRoute(sLat, sLng, dLat, dLng);
      }
    } else {
      resetMission();
    }
  }, [
    manualStartLat,
    manualStartLng,
    manualLat,
    manualLng,
    startLatError,
    startLngError,
    latError,
    lngError,
    selected
  ]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('mapStyle');
      if (saved) {
        const index = MAP_STYLES.findIndex(s => s.key === saved);
        if (index >= 0) {
          setMapStyleIndex(index);
        }
      }
    } catch (e) {
      console.error('Failed to read saved map style', e);
    }
  }, []);

  useEffect(() => {
    try {
      const key = MAP_STYLES[mapStyleIndex]?.key;
      if (key) {
        localStorage.setItem('mapStyle', key);
      }
    } catch (e) {
      console.error('Failed to save map style', e);
    }
  }, [mapStyleIndex]);

  const currentStyle = MAP_STYLES[mapStyleIndex];
  const isDark = currentStyle.isDark;
  const nextStyle = MAP_STYLES[(mapStyleIndex + 1) % MAP_STYLES.length];
  const NextIcon = nextStyle.icon;

  useEffect(() => {
    try {
      const saved = localStorage.getItem('selectedLayerId');
      if (saved) {
        initialLayerIdRef.current = saved;
      }
    } catch (e) {
      console.error('Failed to read saved layer id', e);
    }
  }, []);

  useEffect(() => {
    if (selectedLayerId) {
      localStorage.setItem('selectedLayerId', selectedLayerId);
    } else {
      localStorage.removeItem('selectedLayerId');
    }
  }, [selectedLayerId]);

  useEffect(() => {
    if (!mapLoaded || !initialLayerIdRef.current) return;
    const id = initialLayerIdRef.current;
    initialLayerIdRef.current = null;
    toggleLayer(id);
  }, [mapLoaded]);

  // init map
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
    }
    setMapLoaded(false);
    let initialCenter = [4.4699, 50.5039];
    let initialZoom = 7;
    try {
      const saved = localStorage.getItem('mapView');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          Array.isArray(parsed.center) &&
          parsed.center.length === 2 &&
          typeof parsed.zoom === 'number'
        ) {
          initialCenter = parsed.center;
          initialZoom = parsed.zoom;
        }
      }
    } catch (e) {
      console.error('Failed to load saved map view', e);
    }
    mapRef.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: currentStyle.style,
      center: initialCenter,
      zoom: initialZoom,
      pitch: mapMode === '2d' ? 0 : 60,
      attributionControl: false
    });
    mapRef.current.on('load', () => {
      if (selected) {
        focusDestination(selected);
      }
      setMapLoaded(true);
      applyMapMode(mapMode);
      mapRef.current.doubleClickZoom.disable();
    });
  }, [mapStyleIndex]);

  useEffect(() => {
    document.body.classList.toggle('light', !isDark);
  }, [isDark]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const saveView = () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      localStorage.setItem(
        'mapView',
        JSON.stringify({ center: [center.lng, center.lat], zoom })
      );
    };
    map.on('moveend', saveView);
    return () => map.off('moveend', saveView);
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const handler = e => {
      const { lng, lat } = e.lngLat;
      if (!manualStartLat || !manualStartLng) {
        setManualStartLat(lat.toFixed(5));
        setManualStartLng(lng.toFixed(5));
      } else {
        setManualLat(lat.toFixed(5));
        setManualLng(lng.toFixed(5));
      }
    };
    map.on('dblclick', handler);
    map.doubleClickZoom.disable();
    return () => map.off('dblclick', handler);
  }, [manualStartLat, manualStartLng, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const startSet = manualStartLat !== '' && manualStartLng !== '';
    const destSet = manualLat !== '' && manualLng !== '';

    if (startSet) {
      const coord = [parseFloat(manualStartLng), parseFloat(manualStartLat)];
      if (startMarkerRef.current) {
        startMarkerRef.current.setLngLat(coord);
      } else {
        startMarkerRef.current = new mapboxgl.Marker({ color: '#4caf50' })
          .setLngLat(coord)
          .addTo(map);
      }
    } else if (startMarkerRef.current) {
      startMarkerRef.current.remove();
      startMarkerRef.current = null;
    }

    if (destSet) {
      const coord = [parseFloat(manualLng), parseFloat(manualLat)];
      if (destMarkerRef.current) {
        destMarkerRef.current.setLngLat(coord);
      } else {
        destMarkerRef.current = new mapboxgl.Marker({ color: '#e65100' })
          .setLngLat(coord)
          .addTo(map);
      }
    } else if (destMarkerRef.current) {
      destMarkerRef.current.remove();
      destMarkerRef.current = null;
    }

    if (startSet && destSet) {
      const line = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [parseFloat(manualStartLng), parseFloat(manualStartLat)],
            [parseFloat(manualLng), parseFloat(manualLat)]
          ]
        }
      };
      if (map.getSource('manual-line')) {
        map.getSource('manual-line').setData(line);
      } else {
        map.addSource('manual-line', { type: 'geojson', data: line });
        map.addLayer({
          id: 'manual-line',
          type: 'line',
          source: 'manual-line',
          layout: {},
          paint: {
            'line-color': '#f7931e',
            'line-width': 2,
            'line-dasharray': [2, 2]
          }
        });
      }
    } else {
      if (map.getLayer('manual-line')) map.removeLayer('manual-line');
      if (map.getSource('manual-line')) map.removeSource('manual-line');
    }
  }, [manualStartLat, manualStartLng, manualLat, manualLng, mapLoaded]);

  // preload auto-detection sound
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


  // load layers
  useEffect(() => {
    if (!mapLoaded) return;
    async function loadLayers() {
      try {
        const res = await fetch('https://vectrabackyard-3dmb6.ondigitalocean.app/layers');
        const data = await res.json();
        setLayers(data);
      } catch (e) {
        console.error('Failed to load layers', e);
      }
    }
    loadLayers();
  }, [mapLoaded]);

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
    setSelected(dest);
    if (isNewDest && clearedIdsOverride === undefined) {
      setClearedZoneIds([]);
    }
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
    const map = mapRef.current;
    // Stop any ongoing camera animations so a new focus can take effect
    map.stop();

    const destCoord = [parseFloat(dest.longitude), parseFloat(dest.latitude)];
    setRouteNoFlyZones([]);
    const features = Object.values(layerFeaturesRef.current).flat();
    const hasStart =
      dest.startLatitude !== undefined && dest.startLongitude !== undefined;
    const bounds = new mapboxgl.LngLatBounds(destCoord, destCoord);
    let data;
    if (hasStart) {
      const startCoord = [
        parseFloat(dest.startLongitude),
        parseFloat(dest.startLatitude)
      ];
      const circle = generateHoverCircle(destCoord);
      const { path, intersected, explored } = calculateAvoidingPath(
        startCoord,
        destCoord,
        features
      );
      setRouteNoFlyZones(intersected);
      setFlightPath(path);

      const trialFeatures = explored.map(coords => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords }
      }));

      data = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'LineString', coordinates: path } },
          { type: 'Feature', geometry: { type: 'LineString', coordinates: circle } }
        ]
      };

      const trialData = {
        type: 'FeatureCollection',
        features: trialFeatures
      };

      bounds.extend(startCoord);
      path.forEach(c => bounds.extend(c));
      circle.forEach(c => bounds.extend(c));
      explored.forEach(seg => seg.forEach(c => bounds.extend(c)));

      if (map.getSource('flight-trials')) {
        map.getSource('flight-trials').setData(trialData);
      } else {
        map.addSource('flight-trials', { type: 'geojson', data: trialData });
        map.addLayer({
          id: 'flight-trials',
          type: 'line',
          source: 'flight-trials',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 2,
            'line-dasharray': [1, 1],
            'line-opacity': 0.15
          }
        });
      }
    } else {
      const hoverCircle = generateHoverCircle(destCoord);
      data = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: hoverCircle }
      };
      setFlightPath([]);
      hoverCircle.forEach(c => bounds.extend(c));
      if (map.getSource('flight-trials')) {
        map.getSource('flight-trials').setData({
          type: 'FeatureCollection',
          features: []
        });
      }
    }
    if (map.getSource('flight')) {
      map.getSource('flight').setData(data);
    } else {
      map.addSource('flight', { type: 'geojson', data });
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

  function cycleMapStyle() {
    setMapLoaded(false);
    setMapStyleIndex(i => (i + 1) % MAP_STYLES.length);
  }

  function resetView() {
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
  }

  function toggleFlights() {
    if (showDialog) {
      clearOverlays();
      if (mapRef.current) {
        mapRef.current.stop();
        if (mapRef.current.getLayer('flight')) {
          mapRef.current.removeLayer('flight');
        }
        if (mapRef.current.getSource('flight')) {
          mapRef.current.removeSource('flight');
        }
      }
    } else {
      resetView();
    }
  }

  function rotateMap() {
    if (!mapRef.current) return;
    const bearing = mapRef.current.getBearing();
    mapRef.current.rotateTo(bearing + 90, { duration: 500 });
  }

  function toggleLayers() {
    if (showLayers) {
      clearOverlays();
    } else {
      clearOverlays();
      setShowLayers(true);
    }
  }

  function toggleFeedback() {
    setShowFeedback(v => !v);
  }

  async function toggleLayer(id) {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const fillId = `uas-layer-fill-${id}`;
    const outlineId = `uas-layer-outline-${id}`;
    const sourceId = `uas-layer-${id}`;
    if (selectedLayerId && selectedLayerId !== id) {
      const prevFill = `uas-layer-fill-${selectedLayerId}`;
      const prevOutline = `uas-layer-outline-${selectedLayerId}`;
      const prevSource = `uas-layer-${selectedLayerId}`;
      if (map.getLayer(prevFill)) map.removeLayer(prevFill);
      if (map.getLayer(prevOutline)) map.removeLayer(prevOutline);
      if (map.getSource(prevSource)) map.removeSource(prevSource);
      const prevHandlers = noFlyHandlersRef.current[selectedLayerId];
      if (prevHandlers) {
        map.off('click', prevFill, prevHandlers.click);
        map.off('mouseenter', prevFill, prevHandlers.mouseenter);
        map.off('mouseleave', prevFill, prevHandlers.mouseleave);
        delete noFlyHandlersRef.current[selectedLayerId];
      }
      delete layerFeaturesRef.current[selectedLayerId];
      setLayerFeatures(Object.values(layerFeaturesRef.current).flat());
      setSelectedLayerId(null);
    }
    if (selectedLayerId === id) {
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
      setSelectedLayerId(null);
      return;
    }

    try {
      const res = await fetch(`https://vectrabackyard-3dmb6.ondigitalocean.app/layers/${id}`);
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

      // Orient the map to the bounds of the newly added layer
      if (filtered.length) {
        const [minLng, minLat, maxLng, maxLat] = bbox(geojson);
        map.stop();
        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat]
          ],
          { padding: 40, pitch: mapMode === '2d' ? 0 : 60 }
        );
      }

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
      setSelectedLayerId(id);
    } catch (e) {
      console.error('Failed to load layer', e);
    }
  }
  function setManualRoute(startLat, startLng, destLat, destLng) {
    const dest = {
      mission_name: 'Manual',
      startLatitude: startLat,
      startLongitude: startLng,
      latitude: destLat,
      longitude: destLng,
      zone: 'Manual',
      createdDateTime: new Date().toISOString(),
      status: '',
      customer: ''
    };
    focusDestination(dest);
  }

  const nextTarget = !manualStartLat || !manualStartLng ? 'start' : 'dest';

  return (
    <>
      <div ref={mapContainer} className="map-container" />
      <div className="top-right">
        <button
          className="glass-effect"
          onClick={cycleMapStyle}
          aria-label="Map type"
          title="Map type"
        >
          <NextIcon size={18} />
        </button>
        {kpData && (
          <button
            className="kp-pill glass-effect"
            disabled
            aria-label="Geomagnetic activity (Pro only)"
            title="Geomagnetic activity (Pro only)"
          >
            kp
            <span className="pro-tag">Pro</span>
          </button>
        )}
        <button
          className="btn-3d glass-effect"
          disabled
          aria-label="Camera mode (Pro only)"
          title="Camera mode (Pro only)"
        >
          3D
          <span className="pro-tag">Pro</span>
        </button>
        <button
          className="glass-effect"
          onClick={rotateMap}
          aria-label="Rotate camera"
          title="Rotate camera"
        >
          <ArrowClockwise size={18} />
        </button>
        <button
          className="glass-effect"
          onClick={toggleFlights}
          aria-label="Flights"
          title="Flights"
        >
          <Airplane size={18} />
        </button>
        <button
          className="glass-effect"
          aria-label="Weather (Pro only)"
          title="Weather (Pro only)"
          disabled
        >
          <Cloud size={18} />
          <span className="pro-tag">Pro</span>
        </button>
        <button
          className="glass-effect"
          onClick={toggleLayers}
          aria-label="Layers/No Fly Zones"
          title="Layers/No Fly Zones"
        >
          <Stack size={18} />
        </button>

        <button
          className="glass-effect"
          onClick={toggleFeedback}
          aria-label="Feedback"
        >
          <ChatCenteredText size={18} />
        </button>
      </div>
      {flightInfo && (
        <div className="info-panel glass-effect">
          <h3>Flight Info</h3>
          <div className={`flight-status ${flightInfo.flight.allOk ? 'ok' : 'no'}`}>
            {flightInfo.flight.allOk ? (
              <SealCheck size={18} weight="fill" />
            ) : (
              <SealWarning size={18} weight="fill" />
            )}
            <span>Flight is {flightInfo.flight.allOk ? 'GO' : 'NO GO'}</span>
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
              <span className="value">{formatTimeAgo(selected.createdDateTime)}</span>
            </div>
          </div>

          <div className="info-group">
            <div className="info-row">
              <span className="label">Wind</span>
              <span className={`value ${flightInfo.flight.windAtCruiseAltCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.windAtCruiseAltCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.avgWind.toFixed(2)} m/s
              </span>
            </div>
            <div className="info-row">
              <span className="label">Gust</span>
              <span className={`value ${flightInfo.flight.maxGustAtCruiseAltCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.maxGustAtCruiseAltCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.gust.toFixed(2)} m/s
              </span>
            </div>
            <div className="info-row">
              <span className="label">Outbound speed</span>
              <span className={`value ${flightInfo.flight.outboundGroundSpeedCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.outboundGroundSpeedCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.flight.outboundGroundSpeed?.toFixed(1) ?? 'N/A'} m/s
              </span>
            </div>
            <div className="info-row">
              <span className="label">Return speed</span>
              <span className={`value ${flightInfo.flight.returnGroundSpeedCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.returnGroundSpeedCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.flight.returnGroundSpeed?.toFixed(1) ?? 'N/A'} m/s
              </span>
            </div>
            <div className="info-row">
              <span className="label">Distance</span>
              <span className={`value ${flightInfo.flight.outboundCapacityCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.outboundCapacityCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.distText}
              </span>
            </div>
            <div className="info-row">
              <span className="label">Return Capacity</span>
              <span className={`value ${flightInfo.flight.returnCapacityCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.returnCapacityCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.returnCapacity.toFixed(2)} Ah
              </span>
            </div>
            <div className="info-row">
              <span className="label">Return at mission time</span>
              <span className={`value ${flightInfo.flight.timeOnStationBatteryCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.timeOnStationBatteryCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.returnTime}
              </span>
            </div>
            <div className="info-row">
              <span className="label">Ground speed to dest</span>
              <span className={`value ${flightInfo.flight.outboundGroundSpeedCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.outboundGroundSpeedCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.flight.outboundGroundSpeed?.toFixed(1)} m/s
              </span>
            </div>
            <div className="info-row">
              <span className="label">Ground speed back</span>
              <span className={`value ${flightInfo.flight.returnGroundSpeedCheck ? 'ok' : 'no'}`}>
                {flightInfo.flight.returnGroundSpeedCheck ? (
                  <SealCheck size={16} weight="fill" />
                ) : (
                  <SealWarning size={16} weight="fill" />
                )}
                {flightInfo.flight.returnGroundSpeed?.toFixed(1)} m/s
              </span>
            </div>
          </div>

          {routeNoFlyZones.length > 0 && (
            <div className="nfz-clearance">
              <h4>No Fly Zones</h4>
              {routeNoFlyZones.map(z => {
                const id = getZoneId(z);
                const name = z.properties?.name || z.properties?.id || 'Unnamed';
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
        </div>
      )}
      {showFeedback && (
        <FeedbackDialog onClose={() => setShowFeedback(false)} />
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
                  className={`dest-btn${selectedLayerId === l.id ? ' active' : ''}`}
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
            </div>
          <div className="manual-entry">
            <div className={`coord-group${nextTarget === 'start' ? ' highlight' : ''}`}>
              <label>
                Start Latitude
                <input
                  type="number"
                  placeholder="Start Latitude"
                  value={manualStartLat}
                  onChange={handleManualStartLatChange}
                />
                {startLatError && <span className="error">{startLatError}</span>}
              </label>
              <label>
                Start Longitude
                <input
                  type="number"
                  placeholder="Start Longitude"
                  value={manualStartLng}
                  onChange={handleManualStartLngChange}
                />
                {startLngError && <span className="error">{startLngError}</span>}
              </label>
              {manualStartLat && manualStartLng && (
                <button className="remove-btn" onClick={clearStart}>Remove Start</button>
              )}
              {nextTarget === 'start' && (
                <p className="manual-description">
                  Double click on the map to select start lat & long.
                </p>
              )}
            </div>
            <div className={`coord-group${nextTarget === 'dest' ? ' highlight' : ''}`}>
              <label>
                Destination Latitude
                <input
                  type="number"
                  placeholder="Destination Latitude"
                  value={manualLat}
                  onChange={handleManualLatChange}
                />
                {latError && <span className="error">{latError}</span>}
              </label>
              <label>
                Destination Longitude
                <input
                  type="number"
                  placeholder="Destination Longitude"
                  value={manualLng}
                  onChange={handleManualLngChange}
                />
                {lngError && <span className="error">{lngError}</span>}
              </label>
              {manualLat && manualLng && (
                <button className="remove-btn" onClick={clearDestination}>
                  Remove Destination
                </button>
              )}
              {nextTarget === 'dest' && (
                <p className="manual-description">
                  Double click on the map to select destination lat & long.
                </p>
              )}
            </div>
            <button
              onClick={() => {
                const sLat = parseFloat(manualStartLat);
                const sLng = parseFloat(manualStartLng);
                const dLat = parseFloat(manualLat);
                const dLng = parseFloat(manualLng);
                if (
                  !isNaN(sLat) &&
                  !isNaN(sLng) &&
                  !isNaN(dLat) &&
                  !isNaN(dLng) &&
                  !startLatError &&
                  !startLngError &&
                  !latError &&
                  !lngError
                ) {
                  setManualRoute(sLat, sLng, dLat, dLng);
                }
              }}
              disabled={
                !!startLatError ||
                !!startLngError ||
                !!latError ||
                !!lngError ||
                manualStartLat === '' ||
                manualStartLng === '' ||
                manualLat === '' ||
                manualLng === ''
              }
            >
              Go
            </button>
            <button className="remove-btn" onClick={resetMission}>
              Reset Mission
            </button>
          </div>
        </div>
      )}
    </>
  );
}
