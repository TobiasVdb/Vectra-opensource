import { installSecurityObserver } from './security-http.mjs';
// Public digest only. The read key stays on the Directorate collector.
installSecurityObserver({
  "sourceId": "app-035fffdd-1d30-478c-95f1-59fda0b26446",
  "keyHash": "8aa49e287cc9aac4e004933d1f423a0eed5ec16d1d2b87a0608e100df5d9689b",
  "bindings": [
    {
      "hosts": [
        "vectra-open-tkq6e.ondigitalocean.app"
      ],
      "prefix": "/",
      "target": "Vectra open"
    }
  ],
  "fallbackTarget": "Vectra open",
  "digitalOcean": true
});
