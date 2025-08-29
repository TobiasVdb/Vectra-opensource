export function lonLatToPixelXY(lon, lat, zoom) {
  const mapSize = 256 * Math.pow(2, zoom);
  const x = (lon + 180) / 360 * mapSize;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * mapSize;
  return { x, y };
}

export function pixelXYToLonLat(x, y, zoom) {
  const mapSize = 256 * Math.pow(2, zoom);
  const lon = (x / mapSize) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / mapSize));
  const lat = (latRad * 180) / Math.PI;
  return { lon, lat };
}
