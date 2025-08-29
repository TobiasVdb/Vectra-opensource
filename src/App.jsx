import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Globe,
  Moon,
  Sun,
  ArrowClockwise,
  Stack,
  UserCircle,
  Cloud
} from '@phosphor-icons/react';
import AuthDialog from './AuthDialog';
import { isZoneActive } from './fetchActiveGeozones.js';

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
  const noFlyHandlersRef = useRef({});
  const nfzPopupRef = useRef(null);
  const layerFeaturesRef = useRef({});
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

  const [kpData, setKpData] = useState(null);
  const [showKp, setShowKp] = useState(false);
  // map display mode: '2d', '3d', or '3e' (3D with terrain elevation); default '3e'
  const [mapMode, setMapMode] = useState('3e');
  const [mapStyleIndex, setMapStyleIndex] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!localStorage.getItem('jwt'));
  const [showAuth, setShowAuth] = useState(false);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('email') || '');
  const [layers, setLayers] = useState([]);
  const [showLayers, setShowLayers] = useState(false);
  const [selectedLayerIds, setSelectedLayerIds] = useState([]);
  const initialLayerIdsRef = useRef([]);
  const [layerFeatures, setLayerFeatures] = useState([]);
  const [routeNoFlyZones, setRouteNoFlyZones] = useState([]);
  const [clearedZoneIds, setClearedZoneIds] = useState([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showWeather, setShowWeather] = useState(false);

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
      const { lng, lat } = e.lngLat;
      setManualLat(lat.toFixed(5));
      setManualLng(lng.toFixed(5));
    };
    map.on('dblclick', handler);
    map.doubleClickZoom.disable();
    return () => map.off('dblclick', handler);
  }, []);

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

  useEffect(() => {
    if (selected) {
      focusDestination(selected, clearedZoneIds);
    }
  }, [clearedZoneIds]);

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
      data = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [startCoord, destCoord]
            }
          },
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: circle }
          }
        ]
      };
      bounds.extend(startCoord);
      circle.forEach(c => bounds.extend(c));
    } else {
      const hoverCircle = generateHoverCircle(destCoord);
      data = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: hoverCircle }
      };
      hoverCircle.forEach(c => bounds.extend(c));
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

  function cycleMapMode() {
    const next = mapMode === '2d' ? '3d' : mapMode === '3d' ? '3e' : '2d';
    applyMapMode(next);
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
            disabled
            aria-label="Geomagnetic activity (Pro feature)"
          >
            kp {kpData.kp.toFixed(2)}
            <span className="pro-tag">Pro</span>
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
          className="glass-effect"
          aria-label="Weather (Pro feature)"
          disabled
        >
          <Cloud size={18} />
          <span className="pro-tag">Pro</span>
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
            </div>
          <div className="manual-entry">
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
              <p className="manual-description">
                You can also double click on the map to select destination lat & long.
              </p>
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
            </div>
        </div>
      )}
    </>
  );
}
