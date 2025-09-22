import { vi, test, expect, afterEach } from 'vitest';
global.expect = expect;
await import('@testing-library/jest-dom');
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup
} from '@testing-library/react';
import App from './App';

afterEach(() => {
  cleanup();
});

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

test('clearing a zone removes it from route and resets no-go status', async () => {
  const zone = {
    type: 'Feature',
    properties: { id: 'zone-1', name: 'Test Zone' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0],[0, 1],[1, 1],[1, 0],[0, 0]]] }
  };
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 0,
    longitude: 0.01,
  };
  const path = [
    [0, 0],
    [0, 0.01],
  ];
  render(
    <App
      initialRouteNoFlyZones={[zone]}
      initialCountryFeatures={{ test: [zone] }}
      initialSelected={selected}
      initialFlightPath={path}
      initialPathNoGo={true}
      disableFocus={true}
    />
  );
  expect(screen.getByText('Flight is NO GO')).toBeInTheDocument();
  const clearBtn = screen.getByText('Clear for this flight');
  fireEvent.click(clearBtn);
  expect(screen.getByText('No Fly Zones')).toBeInTheDocument();
  expect(screen.getByText('Cleared')).toBeInTheDocument();
  expect(screen.getByText('Undo')).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText('Clear for this flight')).toBeNull()
  );
  await waitFor(() => expect(screen.queryByText('Flight is NO GO')).toBeNull());
  expect(screen.getByText('Flight is GO')).toBeInTheDocument();
});

test('undoing a cleared zone restores it to the route list', async () => {
  const zone = {
    type: 'Feature',
    properties: { id: 'zone-1', name: 'Test Zone' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
    }
  };
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 0,
    longitude: 0.01
  };
  const path = [
    [0, 0],
    [0, 0.01]
  ];
  render(
    <App
      initialRouteNoFlyZones={[zone]}
      initialCountryFeatures={{ test: [zone] }}
      initialSelected={selected}
      initialFlightPath={path}
      initialPathNoGo={true}
      disableFocus={true}
    />
  );
  fireEvent.click(screen.getByText('Clear for this flight'));
  const [undo] = await screen.findAllByText('Undo');
  fireEvent.click(undo);
  await waitFor(
    () => expect(screen.getByText('Clear for this flight')).toBeInTheDocument(),
    { timeout: 5000 }
  );
  await waitFor(
    () =>
      expect(document.querySelectorAll('.nfz-item.cleared').length).toBe(0),
    { timeout: 5000 }
  );
  const activeRow = screen
    .getByRole('button', { name: 'Clear for this flight' })
    .closest('.nfz-item');
  expect(activeRow).not.toBeNull();
  const rowQueries = within(activeRow);
  expect(rowQueries.getByText('Clear for this flight')).toBeInTheDocument();
  expect(rowQueries.queryByText('Cleared')).toBeNull();
  expect(rowQueries.queryByText('Undo')).toBeNull();
  expect(screen.getByText('Flight is NO GO')).toBeInTheDocument();
}, 10000);

test('hides avoiding distance when there are no no-fly zones', async () => {
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 1,
    longitude: 1,
  };
  const path = [
    [0, 0],
    [1, 1],
  ];
  render(
    <App
      initialSelected={selected}
      initialFlightPath={path}
      disableFocus={true}
    />
  );
  expect(screen.getAllByText('Direct distance')[0]).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('Avoiding distance')).toBeNull());
});

test('shows avoiding distance when there is a no-fly zone', () => {
  const zone = {
    type: 'Feature',
    properties: { id: 'zone-1', name: 'Test Zone' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0],[0, 1],[1, 1],[1, 0],[0, 0]]] }
  };
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 1,
    longitude: 1,
  };
  const path = [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
  ];
  render(
    <App
      initialSelected={selected}
      initialFlightPath={path}
      initialRouteNoFlyZones={[zone]}
      disableFocus={true}
    />
  );
  expect(screen.getAllByText('Direct distance')[0]).toBeInTheDocument();
  expect(screen.getAllByText('Avoiding distance')[0]).toBeInTheDocument();
});

test('shows time on station', () => {
  const selected = {
    startLatitude: 0,
    startLongitude: 0,
    latitude: 1,
    longitude: 1,
  };
  const path = [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
  ];
  render(
    <App
      initialSelected={selected}
      initialFlightPath={path}
      disableFocus={true}
    />
  );
  expect(screen.getAllByText('Time on station')[0]).toBeInTheDocument();
});

