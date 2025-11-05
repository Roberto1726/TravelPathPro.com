import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Secure route that provides the key to frontend
app.get("/api/maps-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;

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

app.post("/api/compute-route", async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    return res.status(500).json({ error: "Google Maps API key is not configured." });
  }

  const { origin, destination, waypoints } = req.body || {};

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

  if (intermediates.length) {
    requestBody.intermediates = intermediates;
  }

  try {
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

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    console.error("Routes API request failed:", error);
    return res.status(502).json({ error: "Unable to compute route using Google Routes API." });
  }
});

// Start server
const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
