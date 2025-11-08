import express from "express";
import dotenv from "dotenv";
import path from "path";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FALLBACK_GOOGLE_MAPS_API_KEY = "AIzaSyAMlrXwwsOWvNl7713bqYandeg77FGCte4";

let runtimeFetch = globalThis.fetch;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

async function resolveFetch() {
  if (runtimeFetch) {
    return runtimeFetch;
  }

  runtimeFetch = function (resource, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const requestUrl = typeof resource === "string" ? new URL(resource) : resource;
        const isHttps = requestUrl.protocol === "https:";
        const transport = isHttps ? https : http;

        const {
          method = "GET",
          headers = {},
          body,
        } = options || {};

        const req = transport.request(
          {
            protocol: requestUrl.protocol,
            hostname: requestUrl.hostname,
            port: requestUrl.port || (isHttps ? 443 : 80),
            path: `${requestUrl.pathname}${requestUrl.search}`,
            method,
            headers,
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const buffer = Buffer.concat(chunks);
              const responseText = buffer.toString();

              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                statusText: res.statusMessage || "",
                headers: res.headers,
                text: async () => responseText,
                json: async () => {
                  if (!responseText) return {};
                  return JSON.parse(responseText);
                },
              });
            });
          }
        );

        req.on("error", reject);

        if (body) {
          if (Buffer.isBuffer(body) || typeof body === "string") {
            req.write(body);
          } else {
            req.write(JSON.stringify(body));
          }
        }

        req.end();
      } catch (error) {
        reject(error);
      }
    });
  };

  return runtimeFetch;
}

// Secure route that provides the key to frontend
app.get("/api/maps-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || FALLBACK_GOOGLE_MAPS_API_KEY;

  if (!key) {
    return res.status(500).json({ error: "Google Maps API key is not configured." });
  }

  res.json({ key });
});

// Serve your static files (HTML, CSS, JS)
app.use(express.static(__dirname));

function buildRouteLocationPayload(location = {}) {
  if (!location) return null;

  const { lat, lng, latitude, longitude, address, label } = location;
  const latValue = typeof lat === "number" ? lat : typeof latitude === "number" ? latitude : null;
  const lngValue = typeof lng === "number" ? lng : typeof longitude === "number" ? longitude : null;

  if (latValue != null && lngValue != null) {
    return {
      location: {
        latLng: {
          latitude: latValue,
          longitude: lngValue,
        },
      },
    };
  }

  const fallbackAddress = address || label;
  if (fallbackAddress && typeof fallbackAddress === "string") {
    return { address: fallbackAddress };
  }

  return null;
}

function extractLatLngFromInput(location = {}) {
  if (!location || typeof location !== "object") {
    return null;
  }

  const directLat = typeof location.lat === "number" ? location.lat : location.latitude;
  const directLng = typeof location.lng === "number" ? location.lng : location.longitude;

  if (typeof directLat === "number" && typeof directLng === "number") {
    return { latitude: directLat, longitude: directLng };
  }

  const nestedLat = location?.location?.latLng?.latitude;
  const nestedLng = location?.location?.latLng?.longitude;
  if (typeof nestedLat === "number" && typeof nestedLng === "number") {
    return { latitude: nestedLat, longitude: nestedLng };
  }

  return null;
}

function buildLocationLabel(location = {}, fallbackLabel) {
  if (!location || typeof location !== "object") {
    return fallbackLabel;
  }

  return (
    location.address ||
    location.label ||
    location.description ||
    location.name ||
    fallbackLabel
  );
}

function toIsoDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  let iso = "PT";
  if (hours) iso += `${hours}H`;
  if (minutes) iso += `${minutes}M`;
  if (!hours && !minutes) {
    iso += `${remainingSeconds || 0}S`;
  } else if (remainingSeconds) {
    iso += `${remainingSeconds}S`;
  }
  if (iso === "PT") {
    iso += "0S";
  }
  return iso;
}

function haversineDistanceMeters(a, b) {
  const R = 6371000; // Earth radius in meters
  const toRad = (value) => (value * Math.PI) / 180;

  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const deltaLat = toRad(b.latitude - a.latitude);
  const deltaLng = toRad(b.longitude - a.longitude);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);

  const c =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  const d = 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));

  return R * d;
}

function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";

  for (const point of points) {
    const [lat, lng] = point;
    const scaledLat = Math.round(lat * 1e5);
    const scaledLng = Math.round(lng * 1e5);

    const deltaLat = scaledLat - lastLat;
    const deltaLng = scaledLng - lastLng;

    result += encodeSignedNumber(deltaLat) + encodeSignedNumber(deltaLng);

    lastLat = scaledLat;
    lastLng = scaledLng;
  }

  return result;
}

function encodeSignedNumber(value) {
  let sgnNum = value << 1;
  if (value < 0) {
    sgnNum = ~sgnNum;
  }

  let encoded = "";
  while (sgnNum >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  encoded += String.fromCharCode(sgnNum + 63);
  return encoded;
}

function buildOfflineRouteResponse(originInput, destinationInput) {
  const originCoords = extractLatLngFromInput(originInput);
  const destinationCoords = extractLatLngFromInput(destinationInput);

  if (!originCoords || !destinationCoords) {
    return null;
  }

  const distanceMeters = Math.round(haversineDistanceMeters(originCoords, destinationCoords));
  const averageSpeedMetersPerSecond = 27.7778; // ≈100 km/h
  const durationSeconds = Math.max(60, Math.round(distanceMeters / averageSpeedMetersPerSecond));

  const encodedPolyline = encodePolyline([
    [originCoords.latitude, originCoords.longitude],
    [destinationCoords.latitude, destinationCoords.longitude],
  ]);

  const originLabel = buildLocationLabel(originInput, "Origin");
  const destinationLabel = buildLocationLabel(destinationInput, "Destination");

  const leg = {
    distanceMeters,
    duration: toIsoDuration(durationSeconds),
    polyline: { encodedPolyline },
    startLocation: {
      latLng: {
        latitude: originCoords.latitude,
        longitude: originCoords.longitude,
      },
    },
    endLocation: {
      latLng: {
        latitude: destinationCoords.latitude,
        longitude: destinationCoords.longitude,
      },
    },
    steps: [
      {
        distanceMeters,
        staticDuration: toIsoDuration(durationSeconds),
        polyline: { encodedPolyline },
        navigationInstruction: {
          maneuver: "DRIVE_STRAIGHT",
          instructions: `Drive from ${originLabel} to ${destinationLabel}.`,
        },
      },
    ],
  };

  return {
    routes: [
      {
        distanceMeters,
        duration: toIsoDuration(durationSeconds),
        polyline: { encodedPolyline },
        legs: [leg],
        fallbackInfo: {
          source: "offline-direct",
          message:
            "Google Routes API was unreachable. Distances are approximated using the great-circle distance between the two points.",
        },
      },
    ],
    fallback: {
      reason: "Google Routes API unreachable",
      strategy: "great-circle",
    },
  };
}

function isNetworkError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = error.code || error?.cause?.code;
  return code ? NETWORK_ERROR_CODES.has(code) : false;
}

app.post("/api/compute-route", async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || FALLBACK_GOOGLE_MAPS_API_KEY;

  if (!key) {
    return res.status(500).json({ error: "Google Maps API key is not configured." });
  }

  const { origin, destination, waypoints, routeModifiers } = req.body || {};

  if (!origin || !destination) {
    return res.status(400).json({ error: "Origin and destination are required." });
  }

  const originPayload = buildRouteLocationPayload(origin);
  const destinationPayload = buildRouteLocationPayload(destination);

  if (!originPayload || !destinationPayload) {
    return res.status(400).json({ error: "Unable to resolve coordinates for origin or destination." });
  }

  const intermediates = Array.isArray(waypoints)
    ? waypoints
        .map(buildRouteLocationPayload)
        .filter(Boolean)
    : [];

  const requestBody = {
    origin: originPayload,
    destination: destinationPayload,
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    computeAlternativeRoutes: false,
    languageCode: "en-US",
    units: "METRIC",
  };

  if (routeModifiers && typeof routeModifiers === "object") {
    const modifiersPayload = {
      avoidFerries: Boolean(routeModifiers.avoidFerries),
      avoidHighways: Boolean(routeModifiers.avoidHighways),
      avoidTolls: Boolean(routeModifiers.avoidTolls),
    };

    if (modifiersPayload.avoidFerries || modifiersPayload.avoidHighways || modifiersPayload.avoidTolls) {
      requestBody.routeModifiers = modifiersPayload;
    }
  }

  if (intermediates.length) {
    requestBody.intermediates = intermediates;
  }

  try {
    const fetch = await resolveFetch();
    const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": [
          "routes.distanceMeters",
          "routes.duration",
          "routes.polyline.encodedPolyline",
          "routes.legs.distanceMeters",
          "routes.legs.duration",
          "routes.legs.polyline.encodedPolyline",
          "routes.legs.startLocation",
          "routes.legs.endLocation",
          "routes.legs.steps.distanceMeters",
          "routes.legs.steps.staticDuration",
          "routes.legs.steps.polyline.encodedPolyline",
          "routes.legs.steps.navigationInstruction",
        ].join(","),
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const googleError = errorPayload?.error || {};
      const message =
        googleError.message ||
        errorPayload?.message ||
        `Routes API request failed with status ${response.status}`;
      const status = googleError.status || response.status;

      let hint = "";
      if (status === "PERMISSION_DENIED" || response.status === 403) {
        hint =
          "Verify that the Google Maps Routes API is enabled, billing is active, and the provided API key allows server-side requests from this host.";
      } else if (status === "INVALID_ARGUMENT" || response.status === 400) {
        hint =
          "Double-check the origin, destination, and waypoint values being sent to the Google Routes API.";
      } else if (status === "RESOURCE_EXHAUSTED" || response.status === 429) {
        hint = "The Google Maps quota has been exceeded. Try again later or adjust your usage limits.";
      }

      return res.status(502).json({
        error: message,
        status,
        hint,
        details: googleError.details || errorPayload?.details || null,
      });
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      throw new Error("Google Routes API returned an unreadable response.");
    }

    return res.json(data);
  } catch (error) {
    if (isNetworkError(error)) {
      const fallbackRoute = buildOfflineRouteResponse(origin, destination);
      if (fallbackRoute) {
        console.warn("Routes API unreachable. Returning offline fallback route.");
        return res.json(fallbackRoute);
      }

      return res.status(502).json({
        error: "Unable to reach Google Routes API and no fallback route could be generated.",
        status: "NETWORK_UNREACHABLE",
        hint: "Check the server's internet connectivity or try again later.",
      });
    }

    console.error("Routes API request failed:", error);
    return res.status(502).json({ error: "Unable to compute route using Google Routes API." });
  }
});

// Start server
const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
