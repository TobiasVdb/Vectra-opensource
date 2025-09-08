import { vi, test, expect } from 'vitest';
global.expect = expect;
await import('@testing-library/jest-dom');
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import App from './App';

vi.mock('mapbox-gl', () => {
  class Map {
    constructor() {
      this.doubleClickZoom = { disable() {} };
    }
    on(event, cb) {
      if (event === 'load') setTimeout(cb, 0);
    }
    remove() {}
    getSource() { return { setData() {} }; }
    addSource() {}
    addLayer() {}
    fitBounds() {}
    stop() {}
    getStyle() { return { layers: [] }; }
    getLayer() { return undefined; }
    getBearing() { return 0; }
    rotateTo() {}
    setTerrain() {}
    removeLayer() {}
    removeSource() {}
    easeTo() {}
    getCanvas() { return { style: {} }; }
    isStyleLoaded() { return true; }
    getCenter() { return { lng: 0, lat: 0 }; }
    getZoom() { return 0; }
    queryRenderedFeatures() { return []; }
    off() {}
  }
  class Popup {
    setLngLat() { return this; }
    addTo() { return this; }
    addClassName() { return this; }
    setHTML() { return this; }
    remove() {}
  }
  class Marker {
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
  }
  return { Map, Popup, Marker, default: { Map, Popup, Marker } };
});

test('layers are sorted by name', async () => {
  const fetchMock = vi.fn(url => {
    if (url.endsWith('/layers')) {
      return Promise.resolve({
        json: () => Promise.resolve([
          { id: 1, name: 'Bravo' },
          { id: 2, name: 'Alpha' }
        ])
      });
    }
    if (url.endsWith('/kp')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          kp: 0,
          geomagnetic_activity: '',
          gnss_impact: '',
          drone_risk: ''
        })
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({}) });
  });
  global.fetch = fetchMock;

  render(<App />);
  const layersBtn = await screen.findByLabelText('Layers/No Fly Zones');
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vectrabackyard-3dmb6.ondigitalocean.app/layers'
    )
  );
  fireEvent.click(layersBtn);
  const dialog = screen.getByText('Layers').parentElement;
  const buttons = within(dialog).getAllByRole('button');
  expect(buttons.map(b => b.textContent)).toEqual(['Alpha', 'Bravo']);
});
