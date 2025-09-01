// utils.js
import simplify from '@turf/simplify';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon as turfPolygon } from '@turf/helpers';
import { OverpassFetcher } from './overpassfetcher.js';
import { lonLatToPixelXY, pixelXYToLonLat } from './geo.js';

let dockingStationAltitudeInMeters = 0;
let cruiseAltitudeInMeters = 90;
let lastPhaseLandingAltitudeAboveGroundInMeters = 10;

let cruiseSpeedInMetersPerSecond = 10;
let ascendSpeedInMetersPerSecond = 2.5;
let descendSpeedInMetersPerSecond = 1.8;
let lastPhaseLandingSpeedInMetersPerSecond = 0.5;
let maxTotalAirspeedInMetersPerSecond = 13;
let nokiaFleetControlGroundSpeedLimitInMetersPerSecond = 13; // To Be Checked

let theoreticalBatteryCapacityInAh = 26;
let practicalBatteryCapacityInAh = 21;
let droneTakeOffCurrentCapacityConsumptionInAh = 1;
let droneLandingCurrentCapacityConsumptionInAh = 1;
let droneFlightCurrentCapacityConsumptionAtMaxSpeedInAhPerMinute = 1;
let droneHoverCurrentCapacityConsumptionInAhPerMinute = 1;

let weatherStationAnemometerAltitudeAboveGroundInMeters = 90;
let hellmanExponentOfWindModel = 0.250;
let averageWindSpeedLimitInMetersPerSecond = 17;
let gustWindSpeedLimitInMetersPerSecond = 20;

let groundSpeedToDestinationInMetersPerSecond = 13;
let groundSpeedToHomeInMetersPerSecond = 8.5;
const overpass = new OverpassFetcher(300); // radius in meters

export function simplifyFeatureGeometry(feature, toleranceMeters = 100) {
    try {
        const geometry = Array.isArray(feature.geometry)
            ? feature.geometry[0]
            : feature.geometry;

        if (!geometry || !geometry.type || typeof geometry.type !== 'string') {
            throw new Error("Unsupported or missing geometry");
        }

        const cacheKey = `__simplified_${toleranceMeters}`;
        if (feature[cacheKey]) return feature[cacheKey];

        const simplified = simplify({ type: 'Feature', geometry, properties: {} }, {
            tolerance: toleranceMeters / 111000,
            highQuality: false,
            mutate: false
        });

        feature[cacheKey] = {
            ...feature,
            geometry: simplified.geometry
        };

        return feature[cacheKey];
    } catch (err) {
        console.warn("⚠️ Failed to simplify", err);
        return feature;
    }
}

function calculateHeadingToIncidentInRadiansWithRespectToNorth(sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg) {
    const toRadians = deg => deg * Math.PI / 180;

    const lat1 = toRadians(sourceLatDeg);
    const lon1 = toRadians(sourceLonDeg);
    const lat2 = toRadians(destinationLatDeg);
    const lon2 = toRadians(destinationLonDeg);

    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);

    const heading = Math.atan2(y, x); // result in radians
    return heading;
}

function calculateHeadingToIncidentIn360DegreesWithRespectToNorth(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
    const headingRad = calculateHeadingToIncidentInRadiansWithRespectToNorth(lat1Deg, lon1Deg, lat2Deg, lon2Deg);
    let headingDeg = headingRad * 180 / Math.PI;

    // Normalize to 0–360 degrees
    headingDeg = (headingDeg + 360) % 360;

    return headingDeg;
}

function calculateHeadingToIncidentInSignedDegreesWithRespectToNorth(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
    const headingRad = calculateHeadingToIncidentInRadiansWithRespectToNorth(lat1Deg, lon1Deg, lat2Deg, lon2Deg);
    let headingDeg = headingRad * 180 / Math.PI;

    // Normalize to -180 to +180
    if (headingDeg > 180) {
        headingDeg -= 360;
    } else if (headingDeg < -180) {
        headingDeg += 360;
    }

    return headingDeg;
}

function calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(avgWindSpeed) {
    return avgWindSpeed *
        (cruiseAltitudeInMeters / weatherStationAnemometerAltitudeAboveGroundInMeters)
        ^ hellmanExponentOfWindModel;
}

function calculateMaxWindGustSpeedAtDroneCruiseAltitudeInMetersPerSecond(maxGustSpeed) {
    return maxGustSpeed *
        (cruiseAltitudeInMeters / weatherStationAnemometerAltitudeAboveGroundInMeters)
        ^ hellmanExponentOfWindModel;
}
function calculateHeadingDifferenceDronevsWind(windspeed, sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg) {
    return windspeed
        - calculateHeadingToIncidentIn360DegreesWithRespectToNorth(sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg);
}

function calculateWindSpeedComponentParallelToDroneHeadingTowardsIncident(windSpeed, windFromDeg, sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg) {
    const toRadians = deg => deg * Math.PI / 180;

    const adjustedWindSpeed = calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(windSpeed);
    const headingDifference = calculateHeadingDifferenceDronevsWind(
        windFromDeg, sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg
    );

    return -adjustedWindSpeed * Math.cos(toRadians(headingDifference));
}


function calculateWindSpeedComponentPerpendicularToDirectionOfDroneHeading(windSpeed, windFromDeg, sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg) {
    const toRadians = deg => deg * Math.PI / 180;

    const adjustedWindSpeed = calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(windSpeed);
    const headingDifference = calculateHeadingDifferenceDronevsWind(
        windFromDeg,
        sourceLatDeg, sourceLonDeg,
        destinationLatDeg, destinationLonDeg
    );

    return -adjustedWindSpeed * Math.sin(toRadians(headingDifference));
}

export function calculateGroundSpeedBackHome(
    gustSpeed,
    windSpeed,
    windFromDeg,
    sourceLatDeg,
    sourceLonDeg,
    destinationLatDeg,
    destinationLonDeg
) {
    const toRadians = deg => deg * Math.PI / 180;
    const roundToNearestHalf = val => Math.round(val * 2) / 2;

    const adjustedWindSpeed = calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(windSpeed); // C59
    const maxWindGustSpeedAtCruise = calculateMaxWindGustSpeedAtDroneCruiseAltitudeInMetersPerSecond(gustSpeed); // C60

    const windspeedPerpendicular = calculateWindSpeedComponentPerpendicularToDirectionOfDroneHeading(
        windSpeed, windFromDeg,
        sourceLatDeg, sourceLonDeg,
        destinationLatDeg, destinationLonDeg
    ); // C63

    const windspeedParallel = calculateWindSpeedComponentParallelToDroneHeadingTowardsIncident(
        windSpeed, windFromDeg,
        sourceLatDeg, sourceLonDeg,
        destinationLatDeg, destinationLonDeg
    ); // C62

    let groundSpeed = 0;
    const conditionsMet = adjustedWindSpeed < maxTotalAirspeedInMetersPerSecond &&
        maxWindGustSpeedAtCruise < gustWindSpeedLimitInMetersPerSecond;

    if (conditionsMet) {
        const crosswindRatio = windspeedPerpendicular / maxTotalAirspeedInMetersPerSecond;

        // Guard asin domain
        if (Math.abs(crosswindRatio) <= 1) {
            const forwardComponent = Math.cos(Math.asin(crosswindRatio)) * maxTotalAirspeedInMetersPerSecond;
            groundSpeed = forwardComponent - windspeedParallel;
        }
    }

    // Round to nearest 0.5
    groundSpeed = roundToNearestHalf(groundSpeed);

    // If result is 0 after rounding, return 0.01 instead
    if (groundSpeed === 0) {
        groundSpeed = 0.01;
    }
    // Clamp to Nokia fleet limit
    return Math.min(groundSpeed, nokiaFleetControlGroundSpeedLimitInMetersPerSecond);
}

export function calculateGroundSpeedToIncident(
    gustSpeed,
    windSpeed,
    windFromDeg,
    sourceLatDeg,
    sourceLonDeg,
    destinationLatDeg,
    destinationLonDeg
) {
    const toRadians = deg => deg * Math.PI / 180;
    const toDegrees = rad => rad * 180 / Math.PI;
    const roundToNearestHalf = val => Math.round(val * 2) / 2;

    const adjustedWindSpeed = calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(windSpeed); // C59
    const maxGust = calculateMaxWindGustSpeedAtDroneCruiseAltitudeInMetersPerSecond(gustSpeed); // C60

    const windspeedPerpendicular = calculateWindSpeedComponentPerpendicularToDirectionOfDroneHeading(
        windSpeed, windFromDeg,
        sourceLatDeg, sourceLonDeg,
        destinationLatDeg, destinationLonDeg
    ); // C63

    const windspeedParallel = calculateWindSpeedComponentParallelToDroneHeadingTowardsIncident(
        windSpeed, windFromDeg,
        sourceLatDeg, sourceLonDeg,
        destinationLatDeg, destinationLonDeg
    ); // C62

    let groundSpeed = 0;

    const conditionsOkay = (adjustedWindSpeed < maxTotalAirspeedInMetersPerSecond) &&
        (maxGust < gustWindSpeedLimitInMetersPerSecond);

    if (conditionsOkay) {
        const crosswindRatio = windspeedPerpendicular / maxTotalAirspeedInMetersPerSecond;

        // Guard asin domain: |x| must be ≤ 1
        if (Math.abs(crosswindRatio) <= 1) {
            const airspeedComponent = Math.cos(Math.asin(crosswindRatio)) * maxTotalAirspeedInMetersPerSecond;
            groundSpeed = airspeedComponent + windspeedParallel;
        }
    }

    // Round to nearest 0.5, then clamp
    groundSpeed = roundToNearestHalf(groundSpeed);

    if (groundSpeed === 0) {
        groundSpeed = 0.01;
    }

    // Clamp to Nokia max ground speed
    return Math.min(groundSpeed, nokiaFleetControlGroundSpeedLimitInMetersPerSecond);
}


export function screenToLatLon(screenX, screenY, canvas, centerLat, centerLon, zoom) {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const offsetX = screenX - centerX;
    const offsetY = screenY - centerY;
    const centerPixel = lonLatToPixelXY(centerLon, centerLat, zoom);
    const worldX = centerPixel.x + offsetX;
    const worldY = centerPixel.y + offsetY;
    return pixelXYToLonLat(worldX, worldY, zoom);
}

export async function fetchOpenAIPAirspaces(lat, lon, radiusKm = 100) {
    const apiKey = '6faa7f738149dcedfd0aff17c6cea2f5'; // 🔁 Replace this
    const url = `https://api.openaip.net/api/v1/airspaces?lat=${lat}&lon=${lon}&distance=${radiusKm * 1000}`;

    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        const json = await res.json();
        console.log("🛰️ OpenAIP Airspaces:", json);
        return json?.airspaces || [];
    } catch (err) {
        console.error("❌ Failed to fetch OpenAIP data", err);
        return [];
    }
}

function backuphaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = deg => (deg * Math.PI) / 180;
    const R = 6371; // Earth's radius in kilometers

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in kilometers
}




function calculateCurrentCapacityRequiredTimeOnStation(distance) {
    return practicalBatteryCapacityInAh - (droneTakeOffCurrentCapacityConsumptionInAh
        + calculateCurrentCapacityRequiredCruisePhaseToDestination(distance)
        + calculateCurrentCapacityRequiredCruisePhaseHome(distance)
        + droneLandingCurrentCapacityConsumptionInAh);
}
function calculateCurrentCapacityRequiredCruisePhaseToDestination(distance) {
    const calculateCruisePhaseToDestination2 = calculateCruisePhaseToDestination(distance);

    return droneFlightCurrentCapacityConsumptionAtMaxSpeedInAhPerMinute * calculateCruisePhaseToDestination2;
}
function calculateCurrentCapacityRequiredCruisePhaseHome(distance) {
    return droneFlightCurrentCapacityConsumptionAtMaxSpeedInAhPerMinute * calculateCruisePhaseToHome(distance);
}
//TimeRequired
export function calculateTakeoffToCruise() {
    return (cruiseAltitudeInMeters - dockingStationAltitudeInMeters) / ascendSpeedInMetersPerSecond / 60;
}
export function calculateCruisePhaseToDestination(distance) {
    return distance / groundSpeedToDestinationInMetersPerSecond / 60;
}
export function calculateTimeOnStation(distance) {
    return calculateCurrentCapacityRequiredTimeOnStation(distance) / droneHoverCurrentCapacityConsumptionInAhPerMinute;
}
export function calculateCruisePhaseToHome(distance) {
    return distance / groundSpeedToHomeInMetersPerSecond / 60;
}
export function calculateLanding() {
    return (
        (cruiseAltitudeInMeters - lastPhaseLandingAltitudeAboveGroundInMeters)
        / descendSpeedInMetersPerSecond
        + (lastPhaseLandingAltitudeAboveGroundInMeters - dockingStationAltitudeInMeters)
        / lastPhaseLandingSpeedInMetersPerSecond
    ) / 60;
}
export function easeInOutQuad(t) {
    return t < 0.5
        ? 2 * t * t
        : -1 + (4 - 2 * t) * t;
}

export function getFlightGoNoGo(distance, avgWindSpeed, maxGustSpeed, windFromDeg,
    sourceLatDeg,
    sourceLonDeg,
    destinationLatDeg,
    destinationLonDeg) {
    if (!distance || distance <= 0)
        return {
        allOk: false,
        noGoReason: 'no distance'
    };
    const calculateCurrentCapacityRequiredCruisePhaseToDestination2 = calculateCurrentCapacityRequiredCruisePhaseToDestination(distance);
    const calculateCurrentCapacityRequiredCruisePhaseHome2 = calculateCurrentCapacityRequiredCruisePhaseHome(distance);
    let check1 = calculateCurrentCapacityRequiredCruisePhaseToDestination2 <
        (practicalBatteryCapacityInAh
            - droneTakeOffCurrentCapacityConsumptionInAh
            - calculateCurrentCapacityRequiredCruisePhaseHome2
            - droneLandingCurrentCapacityConsumptionInAh);

    let check2 = calculateCurrentCapacityRequiredTimeOnStation(distance) > 0;
    let check3 = calculateCurrentCapacityRequiredCruisePhaseHome(distance) <
        (practicalBatteryCapacityInAh
            - droneTakeOffCurrentCapacityConsumptionInAh
            - calculateCurrentCapacityRequiredCruisePhaseToDestination(distance)
            - droneLandingCurrentCapacityConsumptionInAh);
    const avgwindSpeedatcruisealt = calculateAverageWindSpeedAtDroneCruiseAltitudeInMetersPerSecond(avgWindSpeed);
    let check4 = avgwindSpeedatcruisealt <= avgWindSpeed;
    let check5 = calculateMaxWindGustSpeedAtDroneCruiseAltitudeInMetersPerSecond(maxGustSpeed) < gustWindSpeedLimitInMetersPerSecond;
    let check6 = calculateGroundSpeedToIncident(maxGustSpeed, avgWindSpeed, windFromDeg,
        sourceLatDeg,
        sourceLonDeg,
        destinationLatDeg,
        destinationLonDeg) > 0.1;
    let check7 = calculateGroundSpeedBackHome(maxGustSpeed, avgWindSpeed, windFromDeg,
        sourceLatDeg,
        sourceLonDeg,
        destinationLatDeg,
        destinationLonDeg) > 0.1;
    const checks = {
        outboundCapacityCheck: check1,
        timeOnStationBatteryCheck: check2,
        returnCapacityCheck: check3,
        windAtCruiseAltCheck: check4,
        maxGustAtCruiseAltCheck: check5,
        outboundGroundSpeedCheck: check6,
        returnGroundSpeedCheck: check7
    };

    const failed = Object.entries(checks)
        .filter(([key, value]) => !value)
        .map(([key]) => key);

    return {
        allOk: failed.length === 0,
        ...checks,
        outboundGroundSpeed: calculateGroundSpeedToIncident(
            maxGustSpeed, avgWindSpeed, windFromDeg,
            sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg
        ),
        returnGroundSpeed: calculateGroundSpeedBackHome(
            maxGustSpeed, avgWindSpeed, windFromDeg,
            sourceLatDeg, sourceLonDeg, destinationLatDeg, destinationLonDeg
        ),
        noGoReason: failed.length > 0 ? failed : null
    };

}
export function findNearestBaseStation(lat, lon, baseStations) {
    if (!baseStations || baseStations.length === 0) return null;

    let closest = null;
    let minDist = Infinity;

    for (const station of baseStations) {
        const dx = lat - station.lat;
        const dy = lon - station.lng;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist) {
            minDist = distSq;
            closest = station;
        }
    }
    return closest;
}
// flightstats.js
export async function updateFlightStats(state, weather) {
    const { lat, lon } = state.calculator;
    if (!lat || !lon) return;

    const nearest = findNearestBaseStation(lat, lon);
    if (!nearest) return;

    nearest.wind = await weather.getLiveWindAt(nearest.lat, nearest.lng);
    const distKm = haversineDistance(lat, lon, nearest.lat, nearest.lng);

    state.flightStats = getFlightStats(state, nearest, distKm);
}
export function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
export function estimateTotalDistance(waypoints, startLat, startLon) {
    let total = 0;
    const allPoints = [{ lat: startLat, lon: startLon }, ...waypoints];

    for (let i = 0; i < allPoints.length - 1; i++) {
        const a = allPoints[i];
        const b = allPoints[i + 1];
        total += getDistanceMeters(a.lat, a.lon, b.lat, b.lon);
    }

    // Return to base
    if (waypoints.length > 0) {
        const last = waypoints[waypoints.length - 1];
        total += getDistanceMeters(last.lat, last.lon, startLat, startLon);
    }

    return total / 1000; // return in km
}
export function getTotalFlightTimeInMinutes(distance) {
    return calculateTakeoffToCruise()
        + calculateCruisePhaseToDestination(distance)
        + calculateTimeOnStation(distance)
        + calculateCruisePhaseToHome(distance)
        + calculateLanding();
}
export async function fetchOverpassData(lat, lon, signal, state) {
    if (state.showOverpass === false) return;
    console.log('fetch', 'fetchOverpassData');

    try {
        const fc = await overpass.fetchForPoint(lat, lon, signal);
        state.overpassFeatures = fc.features;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('Overpass fetch aborted');
        } else {
            console.error('Failed to fetch Overpass data:', err);
        }
    }
}
export function getTotalFlightTimeRequiredFromTakeOffToLandingWithoutTimeOnStationInMinutes() {
    return calculateTakeoffToCruise()
        + calculateLanding()
        + calculateCruisePhaseToDestination(distance)
        + calculateCruisePhaseToHome(distance);
}
export function decimalMinutesToTime(decimalMinutes) {

    const minutes = Math.floor(decimalMinutes);
    const seconds = Math.round((decimalMinutes - minutes) * 60);
    if (decimalMinutes < 0) {
        return "none " + `(${minutes} min, ${seconds} sec)`;
    }
    return `${minutes} min, ${seconds} sec`;
}
export function getEstimatedTimeRequiredBetweenTakeOffAndArrivalAtDestinationInMinutes(distance) {
    return calculateTakeoffToCruise() + calculateCruisePhaseToDestination(distance);
}

export function getEstimatedMissionTimeAtWhichDroneShouldReturnInMinutes(distance) {
    return calculateTakeoffToCruise() + calculateCruisePhaseToDestination(distance) + calculateTimeOnStation(distance);
}

export function pointInPolygon([lon, lat], geometry) {
    if (!geometry) return false;
    const pt = turfPoint([lon, lat]);

    if (geometry.type === 'Polygon') {
        return booleanPointInPolygon(pt, turfPolygon(geometry.coordinates));
    } else if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(coords =>
            booleanPointInPolygon(pt, turfPolygon(coords))
        );
    }
    return false;
}


export function getEstimatedCurrentCapacityConsumedAtWhichDroneShouldReturn(distance) {
    return droneTakeOffCurrentCapacityConsumptionInAh
        + calculateCurrentCapacityRequiredTimeOnStation(distance)
        + calculateCurrentCapacityRequiredCruisePhaseToDestination(distance);
}
/*
function estimateTotalDistance() {
    let total = 0;
    const allPoints = [{ lat: startLat, lon: startLon }, ...waypoints];
 
    for (let i = 0; i < allPoints.length - 1; i++) {
        const a = allPoints[i];
        const b = allPoints[i + 1];
        const dx = a.lat - b.lat;
        const dy = a.lon - b.lon;
        total += Math.hypot(dx, dy) * 111; // rough km
    }
 
    // Add return to base
    if (waypoints.length > 0) {
        const last = waypoints[waypoints.length - 1];
        const dx = last.lat - startLat;
        const dy = last.lon - startLon;
        total += Math.hypot(dx, dy) * 111;
    }
 
    return total;
}*/
export function estimateActualDistance(flightPath = []) {
    let dist = 0;
    for (let i = 1; i < flightPath.length; i++) {
        const a = flightPath[i - 1];
        const b = flightPath[i];
        dist += getDistanceMeters(a.lat, a.lon, b.lat, b.lon);
    }
    return dist / 1000;
}

export function countVisitedAreas(waypoints, areasOfInterest, targetIndex, zoom) {
    let visited = 0;
    const visitedWaypoints = waypoints.slice(0, targetIndex);

    for (const area of areasOfInterest) {
        const hit = visitedWaypoints.some(wp => {
            const a = lonLatToPixelXY(area.lon, area.lat, zoom);
            const b = lonLatToPixelXY(wp.lon, wp.lat, zoom);
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            return Math.hypot(dx, dy) <= area.radius;
        });
        if (hit) visited++;
    }

    return visited;
}

export function getWindSpeedMetersPerSecond(windLat, windLon, centerLat) {
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 40075000 * Math.cos(centerLat * Math.PI / 180) / 360;
    return Math.hypot(windLat * 60 * metersPerDegreeLat, windLon * 60 * metersPerDegreeLon);
}
