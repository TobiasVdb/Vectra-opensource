import { vi, test, expect } from 'vitest';
global.expect = expect;
await import('@testing-library/jest-dom');
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

vi.mock('mapbox-gl', () => {
  class Map {
    constructor() {
      this.doubleClickZoom = { disable() {} };
    }
    on() {}
    remove() {}
    getSource() {
      return { setData() {} };
    }
    addSource() {}
    addLayer() {}
    fitBounds() {}
    stop() {}
    getStyle() {
      return { layers: [] };
    }
    setTerrain() {}
    removeLayer() {}
    removeSource() {}
    easeTo() {}
    getCanvas() {
      return { style: {} };
    }
    isStyleLoaded() {
      return true;
    }
    getCenter() {
      return { lng: 0, lat: 0 };
    }
    getZoom() {
      return 0;
    }
    queryRenderedFeatures() {
      return [];
    }
    off() {}
  }
  class Popup {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    addClassName() {
      return this;
    }
    setHTML() {
      return this;
    }
    remove() {}
  }
  class Marker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  return { Map, Popup, Marker, default: { Map, Popup, Marker } };
});

test('clearing a zone removes it from route', () => {
  const zone = {
    type: 'Feature',
    properties: { id: 'zone-1', name: 'Test Zone' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0],[0, 1],[1, 1],[1, 0],[0, 0]]] }
  };
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 1,
    longitude: 1
  };
  const path = [
    [0, 0],
    [1, 1]
  ];
  render(
    <App
      initialRouteNoFlyZones={[zone]}
      initialLayerFeatures={{ test: [zone] }}
      initialSelected={selected}
      initialFlightPath={path}
      disableFocus={true}
    />
  );
  const clearBtn = screen.getByText('Clear for this flight');
  fireEvent.click(clearBtn);
  expect(screen.queryByText('No Fly Zones')).toBeNull();
});

