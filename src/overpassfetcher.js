export class OverpassFetcher {
  constructor(radius) {
    this.radius = radius;
  }
  async fetchForPoint(lat, lon, signal) {
    return { features: [] };
  }
}
