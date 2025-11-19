// ========== GLOBALS ==========
// ⚠️ Fallback Google Maps API key used when the server endpoint is unavailable.
//    This allows the application to keep functioning when served statically
//    (e.g., via GitHub Pages) where the Express backend isn't accessible.
//    The value can still be overridden via window.GOOGLE_MAPS_API_KEY,
//    a <meta name="google-maps-api-key"> tag, or the /api/maps-key endpoint.
const FALLBACK_GOOGLE_MAPS_API_KEY = "AIzaSyAMlrXwwsOWvNl7713bqYandeg77FGCte4";

let startCoords = null;
let destCoords = null;
let waypointCoords = [];
let markers = []; // all markers for cleanup
let map, geocoder, directionsService, directionsRenderer;
let lastCalculatedStops = []; // keep all overnight stop names in order
let chargerMarkers = [];
let calcSeq = 0; // guards against stale/overlapping CalculateLegs runs
// 🌍 Distance unit preference
let distanceUnit = localStorage.getItem("distanceUnit") || "km";


// === AFFILIATE SETTINGS ===
const AFFILIATES = {
  booking: { id: "2663340" }, // 🔁 replace with your Booking.com affiliate ID
  expedia: { id: "US.DIRECT.PHG.1101l416247.0" }  // 🔁 replace with your Expedia affiliate ID
};


// 🌍 Distance Conversion Helpers
function kmToMi(km) {
  return km * 0.621371;
}

function formatDistance(valueKm) {
  // valueKm is always kilometers from our code
  if (distanceUnit === "mi") {
    const miles = valueKm * 0.621371;
    return `${miles.toFixed(1)} mi`;
  } else {
    return `${valueKm.toFixed(1)} km`;
  }
}



// 🌀 Loading spinner (fade-in/out)
const spinner = document.createElement("div");
spinner.id = "loadingSpinner";
Object.assign(spinner.style, {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  background: "rgba(0,0,0,0.75)",
  color: "white",
  padding: "20px 30px",
  borderRadius: "12px",
  fontSize: "16px",
  letterSpacing: "0.5px",
  boxShadow: "0 0 15px rgba(0,0,0,0.5)",
  opacity: "0",
  transition: "opacity 0.3s ease",
  zIndex: "9999",
  pointerEvents: "none"
});
spinner.innerText = "Calculating route...";
document.body.appendChild(spinner);

// ✨ Helper functions for fade effect
function showSpinner() {
  spinner.style.display = "block";
  requestAnimationFrame(() => spinner.style.opacity = "1");
}

function hideSpinner() {
  spinner.style.opacity = "0";
  setTimeout(() => spinner.style.display = "none", 300);
}



// ===== Helper: safe JSON parsing so corrupt storage doesn't break the UI =====
function safeJSONParse(rawValue, { fallback = null, storageKey } = {}) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    console.warn("Failed to parse JSON from localStorage", storageKey || "value", error);
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch (removeErr) {
        console.warn("Unable to remove corrupt localStorage key", storageKey, removeErr);
      }
    }
    return fallback;
  }
}

// ========== LOAD SAVED TRIP (only when explicitly requested) ==========
function loadSelectedTrip() {
  const savedTripRaw = localStorage.getItem('tripToLoad');
  if (!savedTripRaw) return; // nothing selected

  const trip = safeJSONParse(savedTripRaw, { fallback: null, storageKey: 'tripToLoad' });
  if (!trip) return;

  // --- Restore basic trip fields ---
  document.getElementById('starting').value = trip.start || '';
  document.getElementById('destination').value = trip.destination || '';
  document.getElementById('maxdaydistance').value = trip.maxDailyDistance || '';
  document.getElementById('adults').value = trip.numAdults || 1;
  document.getElementById('children').value = trip.numChildren || 0;

  document.getElementById('avoidHighways').checked = trip.avoidHighways || false;
  document.getElementById('avoidTolls').checked = trip.avoidTolls || false;
  document.getElementById('avoidFerries').checked = trip.avoidFerries || false;


  // --- Rebuild children ages dropdowns ---
  updateChildrenAges();
  if (trip.childrenAges) {
    trip.childrenAges.forEach((age, i) => {
      const select = document.getElementById(`childAge${i}`);
      if (select) select.value = age;
    });
  }

  // --- Restore stops ---
  const stopsContainer = document.getElementById('stopsContainer');
  stopsContainer.innerHTML = '';
  waypointCoords = [];
  (trip.stops || []).forEach(stop => {
    // stop may be a string (old format) or an object { location, nights }
    if (typeof stop === "string") {
      addStop(stop);
    } else if (stop.location) {
      const stopDiv = addStop(stop.location);
      const stayInput = stopDiv?.querySelector(".stay-input");
      if (stayInput) stayInput.value = stop.nights || 1;
    }
  });


  // --- Restore dates ---
  if (trip.fromDate) document.getElementById('fromDate').value = trip.fromDate;
  if (trip.toDate) document.getElementById('toDate').value = trip.toDate;

  // --- Restore additional details ---
  document.getElementById('rooms').value = trip.numRooms || 1;

  // --- Restore distance unit FIRST ---
  if (trip.distanceUnit) {
    const unitSelect = document.getElementById('unitSelect');
    if (unitSelect) {
      unitSelect.value = trip.distanceUnit;
      localStorage.setItem('distanceUnit', trip.distanceUnit);
    }
  }

  // --- Update the fuel label dynamically based on restored unit ---
  const fuelPriceLabel = document.querySelector('label[for="fuelPrice"]');
  if (fuelPriceLabel) {
    if (trip.distanceUnit === 'mi') {
      fuelPriceLabel.innerText = 'Fuel Price ($/gal or kWh):';
    } else {
      fuelPriceLabel.innerText = 'Fuel Price ($/L or kWh):';
    }
  }


  if (trip.vehicleType) document.getElementById('vehicleType').value = trip.vehicleType;
  if (trip.fuelType) document.getElementById('fuelType').value = trip.fuelType;
  if (trip.fuelPrice) document.getElementById('fuelPrice').value = trip.fuelPrice;



  // --- Auto-calculate if requested ---
  if (trip.autoCalc) {
    setTimeout(() => CalculateLegs(), 500);
  }

  // ✅ Remove flag after use so it won’t reload on next page open
  localStorage.removeItem('tripToLoad');
}

// ✅ DO NOT auto-run this on every load.
// Instead, call loadSelectedTrip() *only* after the user clicks “View” on a saved trip.
// The rest of the app (date + current location) auto-fills separately.






// ========== MAP STYLES ==========
const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] }
];

// ========== INITIALIZE MAP + AUTOCOMPLETE ==========
function initAutocomplete() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 53.536329, lng: -113.51027 },
    zoom: 5
  });




  if (localStorage.getItem("theme") === "dark") map.setOptions({ styles: darkMapStyle });

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
  directionsRenderer.setMap(map);

  attachAutocomplete("starting", coords => startCoords = coords);
  attachAutocomplete("destination", coords => destCoords = coords);

  const savedLocationRaw = localStorage.getItem("userLocation");
  if (savedLocationRaw) {
    const savedLocation = safeJSONParse(savedLocationRaw, { fallback: null, storageKey: 'userLocation' });
    if (savedLocation) {
      const { lat, lng, address } = savedLocation;
      startCoords = { lat, lng };
      document.getElementById("starting").value = address || "";
      map.setCenter({ lat, lng });
    }
  }
}

window.initAutocomplete = initAutocomplete;

// 📍 "Use My Location" button
function useMyLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      startCoords = { lat: latitude, lng: longitude };

      if (!geocoder) geocoder = new google.maps.Geocoder();

      geocoder.geocode({ location: startCoords }, (results, status) => {
        if (status === "OK" && results[0]) {
          document.getElementById("starting").value = results[0].formatted_address;
          localStorage.setItem("userLocation", JSON.stringify({
            lat: latitude,
            lng: longitude,
            address: results[0].formatted_address
          }));
        } else {
          document.getElementById("starting").value = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        }
      });

      // Center the map
      if (map) {
        map.setCenter(startCoords);
        map.setZoom(10);

        // Add a marker for clarity
        new google.maps.Marker({
          position: startCoords,
          map,
          title: "Your Location",
          icon: {
            url: "https://maps.google.com/mapfiles/ms/icons/green-dot.png"
          }
        });
      }
    },
    error => {
      console.warn("Geolocation failed:", error);
      alert("Unable to access your location. Please enable location permissions.");
    }
  );
}

// Attach click event
document.addEventListener("DOMContentLoaded", () => {
  const locBtn = document.getElementById("useMyLocationBtn");
  if (locBtn) locBtn.addEventListener("click", useMyLocation);
});



// ========== AUTOCOMPLETE ==========
function attachAutocomplete(inputId, callback) {
  const input = document.getElementById(inputId);
  const autocomplete = new google.maps.places.Autocomplete(input);
  autocomplete.addListener("place_changed", () => {
    const place = autocomplete.getPlace();
    if (place.geometry) callback({ lat: place.geometry.location.lat(), lng: place.geometry.location.lng() });
  });
}

// ========== STOPS MANAGEMENT ==========
function addStop(initialValue = "") {
  const container = document.getElementById('stopsContainer');
  const stopDiv = document.createElement('div');
  stopDiv.className = 'stop-entry';
  stopDiv.style.marginBottom = '10px';

  const stopIndex = container.children.length;
  const inputId = `stopInput${stopIndex}`;

  stopDiv.innerHTML = `
    <label>Stop:</label><br>
    <input type="text" class="stop-input" id="${inputId}" placeholder="Enter stop location" value="${initialValue}">
    <input type="number" class="stay-input" min="1" value="1" title="Nights to stay" style="width: 100px; margin-left: 10px;">
    <label style="margin-left: 5px;">nights</label>
    <button class="remove-stop" style="margin-left: 10px;">❌ Remove</button>
  `;

  container.appendChild(stopDiv);
  waypointCoords.push(null); // placeholder for this new stop

  const inputElem = document.getElementById(inputId);

  // Autocomplete updates coords
  attachAutocomplete(inputId, coords => {
    const idx = Array.from(container.children).indexOf(stopDiv);
    if (idx !== -1) {
      waypointCoords[idx] = coords;
      CalculateLegs();
    }
  });

  // Sync coords when user types manually
  inputElem.addEventListener('input', () => {
    const idx = Array.from(container.children).indexOf(stopDiv);
    if (idx !== -1) {
      const val = inputElem.value.trim();
      if (!val) {
        waypointCoords[idx] = null;
      } else {
        waypointCoords[idx] = { address: val }; // store the string for later geocoding
      }
    }
  });


  inputElem.addEventListener('blur', () => CalculateLegs());

  stopDiv.querySelector('.remove-stop').onclick = () => removeStop(stopDiv);

  updateStopLabels();
  return stopDiv; // ✅ return for caller to modify (e.g. to set nights)
}




// ======== REMOVE STOP =========
function removeStop(stopDiv) {
  const container = document.getElementById("stopsContainer");
  const index = Array.from(container.children).indexOf(stopDiv);

  if (markers[index + 1]) {
    markers[index + 1].setMap(null);
    markers.splice(index + 1, 1);
  }

  // Remove waypointCoords at that index
  waypointCoords.splice(index, 1);

  stopDiv.remove();
  updateStopLabels();
  CalculateLegs();
}



// ======== HELPER TO UPDATE STOP LABELS =========
function updateStopLabels() {
  const container = document.getElementById("stopsContainer");
  Array.from(container.children).forEach((child, idx) => {
    const label = child.querySelector('label');
    if (label) label.innerText = `Stop ${idx + 1}:`;
  });
}







// ========== CHILDREN AGES ==========
function updateChildrenAges() {
  const numChildren = parseInt(document.getElementById("children").value) || 0;
  const container = document.getElementById("childrenAges");
  container.innerHTML = "";

  for (let i = 0; i < numChildren; i++) {
    const label = document.createElement("label");
    label.innerText = `Child ${i + 1} age: `;

    const select = document.createElement("select");
    select.id = "childAge" + i;

    for (let age = 0; age <= 17; age++) {
      const option = document.createElement("option");
      option.value = age;
      option.text = age;
      select.appendChild(option);
    }

    container.appendChild(label);
    container.appendChild(select);
    container.appendChild(document.createElement("br"));
  }
}

// ========== HELPER FUNCTIONS ==========
function formatDate(date) {
  // Returns YYYY-MM-DD in the user's local timezone
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ======= Distance conversion helpers =======
function toMeters(distance, unit = "km") {
  if (unit === "mi") return distance * 1609.34; // miles → meters
  return distance * 1000; // km → meters
}

function fromMeters(meters, unit = "km") {
  if (unit === "mi") return meters / 1609.34;
  return meters / 1000;
}



// ✅ Only auto-fill today's date and user's current location
window.addEventListener("DOMContentLoaded", () => {
  // --- 1. Set today's date in local timezone ---
  const fromDateInput = document.getElementById("fromDate");
  if (fromDateInput && !fromDateInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    fromDateInput.value = `${yyyy}-${mm}-${dd}`;
  }

  // --- 2. Fill starting point with current GPS location ---
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        startCoords = { lat: latitude, lng: longitude };

        if (!geocoder) geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: startCoords }, (results, status) => {
          if (status === "OK" && results[0]) {
            document.getElementById("starting").value = results[0].formatted_address;
            localStorage.setItem("userLocation", JSON.stringify({
              lat: latitude,
              lng: longitude,
              address: results[0].formatted_address
            }));
          } else {
            document.getElementById("starting").value = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
          }
        });

        // Center the map if ready
        if (map) {
          map.setCenter(startCoords);
          map.setZoom(10);
        }
      },
      err => console.warn("Geolocation denied or failed:", err)
    );
  }

  // ✅ Restore and update distance unit preference
  const unitSelect = document.getElementById("unitSelect");
  if (unitSelect) {
    unitSelect.value = distanceUnit;
    unitSelect.addEventListener("change", () => {
      distanceUnit = unitSelect.value;
      localStorage.setItem("distanceUnit", distanceUnit);
      alert(`Switched to ${distanceUnit === "mi" ? "miles" : "kilometers"}`);
    });
  }

  // 🔁 Update fuel label when distance unit changes
  const fuelPriceLabel = document.querySelector('label[for="fuelPrice"]');
  if (fuelPriceLabel) {
    const updateFuelLabel = () => {
      if (distanceUnit === "mi") {
        fuelPriceLabel.innerText = "Fuel Price ($/gal or kWh):";
      } else {
        fuelPriceLabel.innerText = "Fuel Price ($/L or kWh):";
      }
    };
    updateFuelLabel();
    unitSelect.addEventListener("change", updateFuelLabel);
  }

});






// Estimate average fuel consumption based on type, mode, and year
function getAverageConsumption(vehicleType, mode, year) {
  let consumption = 8.5; // Default L/100km

  // Base by type
  switch (vehicleType) {
    case "car": consumption = 7.5; break;
    case "suv": consumption = 10.5; break;
    case "truck": consumption = 12.5; break;
    case "van": consumption = 11; break;
    case "motorcycle": consumption = 5; break;
  }

  // Adjust by mode
  switch (mode) {
    case "diesel": consumption *= 0.9; break;
    case "hybrid": consumption *= 0.65; break;
    case "electric": consumption = 20; break; // kWh/100km instead
  }

  // Adjust slightly by age (older = less efficient)
  if (year) {
    const age = new Date().getFullYear() - year;
    if (mode !== "electric") {
      consumption *= 1 + Math.min(age * 0.005, 0.2); // max +20%
    }
  }

  return consumption;
}


// Compute intermediate stops along a path based on max distance

function computeStopsFromOverviewPath(path, maxMeters, destLatLng) {
  const stops = [];
  if (!path || path.length < 2) return stops;
  const segDist = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = google.maps.geometry.spherical.computeDistanceBetween(path[i - 1], path[i]);
    segDist.push(d);
    total += d;
  }
  if (total < maxMeters) return stops;

  const numTargets = Math.floor(total / maxMeters);
  let cum = 0, segindex = 0;
  for (let n = 1; n <= numTargets; n++) {
    const target = n * maxMeters;
    while (segindex < segDist.length && cum + segDist[segindex] < target) {
      cum += segDist[segindex];
      segindex++;
    }
    if (segindex >= segDist.length) break;
    const prev = path[segindex];
    const next = path[segindex + 1];
    const fraction = (target - cum) / segDist[segindex];
    const stopLatLng = google.maps.geometry.spherical.interpolate(prev, next, fraction);
    const distToDest = google.maps.geometry.spherical.computeDistanceBetween(stopLatLng, destLatLng);
    if (distToDest > 1000) stops.push(stopLatLng);
  }
  return stops;
}



// ===== Helper: promisified geocoding =====
function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status === "OK" && results[0]) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else {
        console.warn("Geocode failed for address:", address, status);
        resolve(null); // fail gracefully
      }
    });
  });
}

function addSnappedMarker(latlng, overviewPath, index, isAutoStop = false) {
  if (!latlng) return null;

  const snapped = snapToRoute(latlng, overviewPath);

  // Distinct colors for user vs auto stops
  const pinColor = isAutoStop ? "FFD700" : "1E90FF"; // gold for auto, blue for user
  const labelColor = "black";

  // Create a larger, high-contrast pin icon with bold label
  const marker = new google.maps.Marker({
    position: snapped,
    map,
    icon: {
      url: `https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=${index}|${pinColor}|000000`,
      scaledSize: new google.maps.Size(48, 72)
    },
    label: {
      text: `${index}`,
      color: labelColor,
      fontWeight: "bold",
      fontSize: "16px"
    },
    title: isAutoStop
      ? `⚡ Auto Stop ${index}`
      : `Stop ${index}`,
    zIndex: isAutoStop ? 5 : 10 // ensure manual stops appear above auto stops
  });

  // Add a small circle halo for visibility (optional)
  new google.maps.Circle({
    map,
    center: snapped,
    radius: 8000, // ~8 km halo
    strokeColor: isAutoStop ? "#FFD700" : "#1E90FF",
    strokeOpacity: 0.8,
    strokeWeight: 2,
    fillColor: isAutoStop ? "#FFFACD" : "#ADD8E6",
    fillOpacity: 0.25
  });

  markers.push(marker);
  return snapped;
}

function isValidLatLng(obj) {
  return (
    obj &&
    typeof obj.lat === "number" &&
    typeof obj.lng === "number" &&
    !isNaN(obj.lat) &&
    !isNaN(obj.lng)
  );
}





// ========== MAIN FUNCTION ==========
async function CalculateLegs() {
  console.log("CalculateLegs triggered");
  geocoder = new google.maps.Geocoder();

  const starting = document.getElementById("starting").value.trim();
  const destination = document.getElementById("destination").value.trim();
  const maxDailyDistance = parseFloat(document.getElementById("maxdaydistance").value) || 0;
  const distanceUnit = document.getElementById("unitSelect")?.value || "km";
  const maxDailyMeters = toMeters(maxDailyDistance, distanceUnit);

  // Read avoid preferences
  const avoidHighways = document.getElementById('avoidHighways')?.checked || false;
  const avoidTolls = document.getElementById('avoidTolls')?.checked || false;
  const avoidFerries = document.getElementById('avoidFerries')?.checked || false;
  
  const numAdults = parseInt(document.getElementById("adults").value) || 1;
  const numChildren = parseInt(document.getElementById("children").value) || 0;
  const childrenAges = [];
  for (let i = 0; i < numChildren; i++) {
    const ageSelect = document.getElementById("childAge" + i);
    if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
  }


  if (!starting || !destination || !maxDailyDistance) {
    alert("Please enter starting point, destination, and maximum daily distance (km).");
    return;
  }

  if (!map) {
    alert("Map not initialized yet. Please wait a few seconds and try again.");
    return;
  }

  showSpinner();

  const seq = ++calcSeq; // this run’s id; only the latest run may update UI/alerts

  // 🧹 Clear old map items
  markers.forEach(m => m.setMap(null));
  markers = [];
  directionsRenderer.setDirections({ routes: [] });
  chargerMarkers.forEach(m => m.setMap(null));
  chargerMarkers = [];


  try {
      // --- Build waypoint list ---
      const stopInputs = Array.from(document.querySelectorAll(".stop-input"));

      const waypointCandidates = await Promise.all(
        stopInputs.map(async (input, idx) => {
          const val = input.value.trim();
          if (!val) return null;

          let coords = waypointCoords[idx];
          if (coords?.lat && coords?.lng) {
            return {
              location: new google.maps.LatLng(coords.lat, coords.lng),
              stopover: true,
              label: val,
            };
          }
          if (coords?.address) {
            const geocodeResult = await geocodeAddress(coords.address);
            if (geocodeResult) {
              waypointCoords[idx] = geocodeResult;
              return {
                location: new google.maps.LatLng(geocodeResult.lat, geocodeResult.lng),
                stopover: true,
                label: val,
              };
            }
            return null;
          }

          // fallback — try direct geocode
          const geocodeResult = await geocodeAddress(val);
          if (geocodeResult) {
            waypointCoords[idx] = geocodeResult;
            return {
              location: new google.maps.LatLng(geocodeResult.lat, geocodeResult.lng),
              stopover: true,
              label: val,
            };
          }
          return null;
        })
      );

      const validWaypointEntries = waypointCandidates
        .filter(
          w =>
            w &&
            w.location &&
            typeof w.location.lat === "function" &&
            typeof w.location.lng === "function" &&
            !isNaN(w.location.lat()) &&
            !isNaN(w.location.lng())
        )
        .map(entry => ({
          waypoint: { location: entry.location, stopover: true },
          meta: {
            lat: entry.location.lat(),
            lng: entry.location.lng(),
            label: entry.label || "",
          },
        }));

      const validWaypoints = validWaypointEntries.map(entry => entry.waypoint);
      const waypointMetadata = validWaypointEntries.map(entry => entry.meta);

    // 🧭 Validate waypoint coordinates before routing
    for (let i = 0; i < validWaypoints.length; i++) {
      const wp = validWaypoints[i].location;
      const lat = typeof wp.lat === "function" ? wp.lat() : wp.lat;
      const lng = typeof wp.lng === "function" ? wp.lng() : wp.lng;

      if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
        console.warn("Invalid waypoint removed:", wp);
        validWaypoints.splice(i, 1);
        i--;
      }
    }

    // ⚠️ Notify if any user stops were removed
      if (waypointCandidates.length !== validWaypoints.length) {
        alert("Some stops were invalid and skipped (could not find a route).");
      }

    // 🚧 If the route cannot connect all stops, attempt partial routing
    if (validWaypoints.length > 0) {
      const firstValid = validWaypoints[0];
      const lastValid = validWaypoints[validWaypoints.length - 1];
      if (!firstValid || !lastValid) {
        console.warn("Route start or end missing. Skipping invalid stops.");
      }
    } else {
      console.warn("No valid waypoints remain — calculating direct route only.");
    }



    // --- Prepare start/dest ---
    const originLatLng = startCoords?.lat && startCoords?.lng
      ? new google.maps.LatLng(startCoords.lat, startCoords.lng)
      : starting;

    const destLatLng = destCoords?.lat && destCoords?.lng
      ? new google.maps.LatLng(destCoords.lat, destCoords.lng)
      : destination;

    console.log("Routing from:", originLatLng);
    console.log("Through waypoints:", validWaypoints.map(w => w.location.toString()));
    console.log("To:", destLatLng);

    // --- Get route (do not alert here; only resolve status/result) ---
    const routeResponse = await new Promise(resolve => {
      directionsService.route(
        {
          origin: originLatLng,
          destination: destLatLng,
          waypoints: validWaypoints.length ? validWaypoints : undefined,
          travelMode: google.maps.TravelMode.DRIVING,
          avoidHighways: avoidHighways,
          avoidTolls: avoidTolls,
          avoidFerries: avoidFerries
        },
        (result, status) => resolve({ status, result })
      );
    });

    // If this result is stale (a newer CalculateLegs ran), ignore it entirely.
    if (seq !== calcSeq) {
      hideSpinner();
      return;
    }

    let routeData = null;

    if (routeResponse.status === "OK" && routeResponse.result) {
      routeData = routeResponse.result;
    } else if (routeResponse.status === "REQUEST_DENIED") {
      try {
        routeData = await computeRouteUsingRoutesApi({
          originLatLng,
          destinationLatLng: destLatLng,
          originText: starting,
          destinationText: destination,
          waypointMetadata,
          avoidHighways,
          avoidTolls,
          avoidFerries,
        });
      } catch (fallbackError) {
        hideSpinner();
        const fallbackLines = [
          fallbackError?.message?.trim() ||
            "Route calculation was denied by Google Maps. Please verify your API configuration or try again later.",
        ];

        if (fallbackError?.hint) {
          fallbackLines.push(fallbackError.hint);
        }

        if (fallbackError?.status) {
          fallbackLines.push(`Google status: ${fallbackError.status}`);
        }

        if (fallbackError?.details) {
          const detailText = Array.isArray(fallbackError.details)
            ? fallbackError.details
                .map(detail =>
                  typeof detail === "string"
                    ? detail
                    : detail?.reason || detail?.message || JSON.stringify(detail)
                )
                .filter(Boolean)
                .join("\n")
            : typeof fallbackError.details === "string"
              ? fallbackError.details
              : "";

          if (detailText) {
            fallbackLines.push(detailText);
          }
        }

        alert(fallbackLines.filter(Boolean).join("\n\n"));
        console.error("Routes API fallback failed:", fallbackError);
        return;
      }
    } else {
      hideSpinner();
      if (routeResponse.status === "ZERO_RESULTS") {
        alert("No drivable route found between one or more points. Please adjust your stops and try again.");
      } else {
        alert(`Route error: ${routeResponse.status}. Please adjust stops or try again.`);
      }
      console.error("Directions error:", routeResponse.status, { originLatLng, destLatLng, validWaypoints });
      return;
    }

    directionsRenderer.setDirections(routeData);


    // --- Compute overnight stops (continuous, one-way) ---
    const route = routeData.routes[0];
    const legs = route.legs;

    const allOvernights = [];


    // Iterate over legs in order
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const legDistanceKm = leg.distance.value / 1000;

// Compute intermediate auto-stops if leg exceeds max distance
if (legDistanceKm > maxDailyDistance) {
  const extraStops = computeStopsFromOverviewPath(
    leg.path || leg.steps.flatMap(step => step.path),
    maxDailyMeters,
    leg.end_location
  );

  // 🧭 For each computed stop, find the nearest town along the route
  for (const s of extraStops) {
    let nearestTown = null;
    let formatted = `${s.lat().toFixed(4)}, ${s.lng().toFixed(4)}`;

    try {
      const results = await new Promise(resolve => {
        geocoder.geocode({ location: s }, (res, status) => {
          if (status === "OK" && res[0]) resolve(res);
          else resolve(null);
        });
      });

      if (results && results[0]) {
        const comps = results[0].address_components;
        const town = comps.find(c => c.types.includes("locality"))?.long_name || "";
        const state = comps.find(c => c.types.includes("administrative_area_level_1"))?.short_name || "";
        const country = comps.find(c => c.types.includes("country"))?.short_name || "";

        if (town) {
          nearestTown = `${town}${state ? `, ${state}` : ""}${country ? `, ${country}` : ""}`;
        } else {
          nearestTown = results[0].formatted_address;
        }
        formatted = nearestTown;
      }
    } catch (err) {
      console.warn("Reverse-geocode failed for auto-stop:", err);
    }

    allOvernights.push({
      latlng: s,
      addressFormatted: formatted,
      stayNights: 1,
      isAutoStop: true,
    });
  }
}


      // Add the leg end (user waypoint or final destination)
      allOvernights.push({
        latlng: leg.end_location,
        addressFormatted: leg.end_address,
        stayNights: 1,
      });
    }

    // --- Reverse geocode auto-stops for readability ---
    for (const stop of allOvernights) {
      if (!stop.addressFormatted || stop.addressFormatted.includes(',')) continue;

      try {
        const results = await new Promise(resolve => {
          geocoder.geocode({ location: stop.latlng }, (res, status) => {
            if (status === "OK" && res[0]) resolve(res);
            else resolve(null);
          });
        });

        if (results && results[0]) {
          stop.addressFormatted = results[0].formatted_address;
          const comps = results[0].address_components;
          stop.town = comps.find(c => c.types.includes("locality"))?.long_name || "";
          stop.state = comps.find(c => c.types.includes("administrative_area_level_1"))?.short_name || "";
          stop.country = comps.find(c => c.types.includes("country"))?.short_name || "";
        }
      } catch (err) {
        console.warn("Reverse geocode failed:", err);
      }
    }

    // ✅ Apply "nights" only to user-added stops, not auto-generated ones
    const stopEntries = Array.from(document.querySelectorAll(".stop-entry"));
    let manualStopIndex = 0;

    for (const stop of allOvernights) {
      if (stop.isAutoStop) {
        stop.stayNights = 1; // default for auto-stops
        continue;
      }

      const entryDiv = stopEntries[manualStopIndex];
      if (entryDiv) {
        const stayInput = entryDiv.querySelector(".stay-input");
        stop.stayNights = stayInput ? parseInt(stayInput.value) || 1 : 1;
      }
      manualStopIndex++;
    }



    // --- Output trip summary ---
    let output = `<h3>Trip Summary</h3>`;
    const totalDistanceKm = routeData.routes[0].legs.reduce((sum, leg) => sum + (leg.distance.value / 1000), 0);
    
    const totalDistance = fromMeters(
      routeData.routes[0].legs.reduce((sum, leg) => sum + leg.distance.value, 0),
      distanceUnit
    );
    output += `<p><strong>Total Distance:</strong> ${totalDistance.toFixed(1)} ${distanceUnit}</p>`;
    output += `<p><strong>Max Daily Distance:</strong> ${maxDailyDistance} ${distanceUnit}</p>`;
    
    
    output += `<p><strong>Estimated Overnight Stops:</strong> ${allOvernights.length}</p>`;
    // output += `<h4>Suggested Overnight Stops:</h4>`;  seems not needed
    output += `<p><strong>Adults:</strong> ${numAdults}, <strong>Children:</strong> ${numChildren}</p>`;
    if (childrenAges.length) output += `<p><strong>Children ages:</strong> ${childrenAges.join(", ")}</p>`;


    // --- Vehicle & Fuel Cost Calculation (with safe fallbacks) ---
    const vehicleTypeEl = document.getElementById("vehicleType");
    const fuelTypeEl = document.getElementById("fuelType");
    const vehicleYearEl = document.getElementById("vehicleYear");
    const fuelPriceEl = document.getElementById("fuelPrice");

    const vehicleType = vehicleTypeEl ? vehicleTypeEl.value : "car";
    const fuelType = fuelTypeEl ? fuelTypeEl.value : "gas";
    const vehicleYear = vehicleYearEl
      ? parseInt(vehicleYearEl.value) || new Date().getFullYear()
      : new Date().getFullYear();
    const fuelPrice = fuelPriceEl ? parseFloat(fuelPriceEl.value) || 0 : 0;


    let consumption = getAverageConsumption(vehicleType, fuelType, vehicleYear);
    let displayConsumption = consumption;
    let totalCost = 0;

    // Convert consumption if user uses miles
    if (distanceUnit === "mi" && fuelType !== "electric") {
      // Convert L/100km → MPG (miles per gallon)
      const mpg = 235.214583 / consumption; // 235.2 ÷ L/100km = mpg
      displayConsumption = mpg;
    }

    // Calculate cost properly
    if (fuelType === "electric") {
      // kWh/100km → kWh/100mi
      const energyRate = distanceUnit === "mi" ? (consumption / 1.60934) : consumption;
      totalCost = (totalDistance / 100) * energyRate * fuelPrice;
    } else {
      if (distanceUnit === "km") {
        totalCost = (totalDistance / 100) * consumption * fuelPrice;
      } else {
        // miles mode: totalDistance in miles, fuelPrice in $/gal
        totalCost = (totalDistance / displayConsumption) * fuelPrice;
      }
    }


    // format numbers
    const costFormatted = totalCost.toFixed(2);
    const consFormatted = consumption.toFixed(1);


    // ✅ Updated output labels for unit consistency
    output += `<p><strong>Vehicle:</strong> ${vehicleType.toUpperCase()} (${fuelType})</p>`;

    if (fuelType === "electric") {
      // Electric vehicles
      output += `<p><strong>Average Consumption:</strong> ${displayConsumption.toFixed(1)} ${distanceUnit === "mi" ? "kWh/100 mi" : "kWh/100 km"}</p>`;
      output += `<p><strong>Energy Price:</strong> $${fuelPrice.toFixed(2)} per kWh</p>`;
    } else if (distanceUnit === "mi") {
      // Gas/diesel/hybrid when user chose miles
      output += `<p><strong>Average Consumption:</strong> ${displayConsumption.toFixed(1)} mpg</p>`;
      output += `<p><strong>Fuel Price:</strong> $${fuelPrice.toFixed(2)} per gal</p>`;
    } else {
      // Gas/diesel/hybrid in kilometers
      output += `<p><strong>Average Consumption:</strong> ${displayConsumption.toFixed(1)} L/100 km</p>`;
      output += `<p><strong>Fuel Price:</strong> $${fuelPrice.toFixed(2)} per L</p>`;
    }

    output += `<p><strong>Estimated Total Fuel Cost:</strong> $${costFormatted}</p>`;


    const fromDateInput = document.getElementById("fromDate");
    let currentDate;

    if (fromDateInput?.value) {
      // Use the date from input, ensure proper local time
      currentDate = new Date(fromDateInput.value + "T00:00");
    } else {
      // Default to today
      currentDate = new Date();
      if (fromDateInput) fromDateInput.value = formatDate(currentDate);
    }


    allOvernights.forEach((stop, i) => {
      const stayNights = stop.stayNights || 1;

      const checkinDate = new Date(currentDate);
      const checkoutDate = new Date(currentDate);
      checkoutDate.setDate(currentDate.getDate() + stayNights);

      const place =
        [stop.town, stop.state, stop.country].filter(Boolean).join(", ") ||
        stop.addressFormatted;

      // Get number of travelers
      const numAdults = parseInt(document.getElementById("adults").value) || 1;
      const numChildren = parseInt(document.getElementById("children").value) || 0;
      const childrenAges = [];
      for (let j = 0; j < numChildren; j++) {
        const ageSelect = document.getElementById("childAge" + j);
        if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
      }

      


      // Detect if it's an auto-stop
      const isAutoStop = !stop.town && stop.addressFormatted.includes(',');

      
      // --- Booking.com (Improved: use coordinates when available) ---
      let bookingUrl;
      if (stop.latlng && typeof stop.latlng.lat === "function") {
        const lat = stop.latlng.lat();
        const lng = stop.latlng.lng();
        bookingUrl = `https://www.booking.com/searchresults.html?ssne=${encodeURIComponent(place)}&ssne_untouched=${encodeURIComponent(place)}&efdco=1&latitude=${lat}&longitude=${lng}&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}&no_rooms=1&group_adults=${numAdults}&group_children=${numChildren}${childrenAges.length ? `&age=${childrenAges.join(',')}` : ''}&order=distance_from_search`;
      } else if (stop.latlng && stop.latlng.lat && stop.latlng.lng) {
        const { lat, lng } = stop.latlng;
        bookingUrl = `https://www.booking.com/searchresults.html?ssne=${encodeURIComponent(place)}&ssne_untouched=${encodeURIComponent(place)}&efdco=1&latitude=${lat}&longitude=${lng}&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}&no_rooms=1&group_adults=${numAdults}&group_children=${numChildren}${childrenAges.length ? `&age=${childrenAges.join(',')}` : ''}&order=distance_from_search`;
      } else {
        // fallback if coordinates are missing
        bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(place)}&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}&group_adults=${numAdults}&group_children=${numChildren}${childrenAges.length ? `&age=${childrenAges.join(',')}` : ''}`;
      }

      // --- Expedia (Improved) ---
      // Use precise coordinates when available for accurate hotel search
      let expediaUrl;

      if (stop.latlng && typeof stop.latlng.lat === "function") {
        expediaUrl = `https://www.expedia.com/Hotel-Search?lat=${stop.latlng.lat()}&lng=${stop.latlng.lng()}&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}&adults=${numAdults}&children=${numChildren}${childrenAges.length ? `&childAges=${childrenAges.join(',')}` : ''}&showMap=true`;
      } else if (stop.latlng && stop.latlng.lat && stop.latlng.lng) {
        expediaUrl = `https://www.expedia.com/Hotel-Search?lat=${stop.latlng.lat}&lng=${stop.latlng.lng}&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}&adults=${numAdults}&children=${numChildren}${childrenAges.length ? `&childAges=${childrenAges.join(',')}` : ''}&showMap=true`;
      } else {
        // fallback to textual search
        expediaUrl = `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(
          place
        )}&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}&adults=${numAdults}&children=${numChildren}${childrenAges.length ? `&childAges=${childrenAges.join(',')}` : ''}`;
      }


      // --- TripAdvisor (Improved: prefer coordinates for nearby attractions) ---
      let tripAdvisorAttractionsUrl;
      if (stop.latlng && typeof stop.latlng.lat === "function") {
        const lat = stop.latlng.lat();
        const lng = stop.latlng.lng();
        tripAdvisorAttractionsUrl = `https://www.tripadvisor.com/Search?geo=${lat},${lng}&query=attractions&uiOrigin=tripsearch&pid=3826`;
      } else if (stop.latlng && stop.latlng.lat && stop.latlng.lng) {
        const { lat, lng } = stop.latlng;
        tripAdvisorAttractionsUrl = `https://www.tripadvisor.com/Search?geo=${lat},${lng}&query=attractions&uiOrigin=tripsearch&pid=3826`;
      } else {
        // fallback to name-based search
        tripAdvisorAttractionsUrl = `https://www.tripadvisor.com/Search?q=${encodeURIComponent(place + " attractions")}`;
      }

      // 🗺️ Add numbered marker to map (AFTER URLs are ready)
      const snappedLatLng = addSnappedMarker(
        stop.latlng,
        route.legs[Math.min(i, route.legs.length - 1)]?.path ||
          route.legs[Math.min(i, route.legs.length - 1)]?.steps.flatMap((s) => s.path),
        i + 1,
        isAutoStop
      );

      stop.latlng = snappedLatLng;
      currentDate = checkoutDate;

      // Now that all variables exist, safely append the output
      output += `
        <p style="margin-bottom: 10px;">
          <strong>Stop ${i + 1} – Night ${i + 1}:</strong>
          ${isAutoStop ? '<span style="color:#DAA520;">⚡ Auto Stop</span>' : ''}
          <br>
          ${place}<br>
          <em>${formatDate(checkinDate)} → ${formatDate(checkoutDate)}</em><br>

          <button 
            title="Find hotels near ${place} (Booking.com)" 
            onclick="openStopTravelSite(
              'booking',
              ${stop.latlng.lat()},
              ${stop.latlng.lng()},
              '${encodeURIComponent(place)}',
              false,
              '${formatDate(checkinDate)}',
              '${formatDate(checkoutDate)}'
            )">
            🏨 Booking.com
          </button>

          <button 
            title="Find hotels near ${place} (Expedia)" 
            onclick="openStopTravelSite(
              'expedia',
              ${stop.latlng.lat()},
              ${stop.latlng.lng()},
              '${encodeURIComponent(place)}',
              false,
              '${formatDate(checkinDate)}',
              '${formatDate(checkoutDate)}'
            )">
            ✈️ Expedia
          </button>

          ${stayNights > 0 ? `
            <button 
              title="Compare hotel prices on Booking and Expedia" 
              onclick="comparePrices(
                ${stop.latlng.lat()},
                ${stop.latlng.lng()},
                '${encodeURIComponent(place)}',
                '${formatDate(checkinDate)}',
                '${formatDate(checkoutDate)}'
              )">
              💸 Compare Prices
            </button>
          ` : ''}

          <button 
            title="Explore attractions near ${place} (TripAdvisor)" 
            onclick="openStopTravelSite(
              'tripadvisor',
              ${stop.latlng.lat()},
              ${stop.latlng.lng()},
              '${encodeURIComponent(place)}',
              true,
              '${formatDate(checkinDate)}',
              '${formatDate(checkoutDate)}'
            )">
            🌐 TripAdvisor
          </button>



        </p>
      `;



    });




    // 🗺️ Start and destination markers (styled + labeled)
    const firstLeg = routeData.routes[0].legs[0];
    const lastLeg = routeData.routes[0].legs.slice(-1)[0];

    markers.push(
      new google.maps.Marker({
        position: firstLeg.start_location,
        map,
        title: "Start: " + starting,
        label: {
          text: "S",
          color: "white",
          fontWeight: "bold"
        },
        icon: {
          url: "https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=S|32CD32|000000",
          scaledSize: new google.maps.Size(40, 60)
        }
      }),
      new google.maps.Marker({
        position: lastLeg.end_location,
        map,
        title: "Destination: " + destination,
        label: {
          text: "D",
          color: "white",
          fontWeight: "bold"
        },
        icon: {
          url: "https://chart.googleapis.com/chart?chst=d_map_pin_letter&chld=D|DC143C|000000",
          scaledSize: new google.maps.Size(40, 60)
        }
      })
    );


    // After all markers have been added
    if (markers.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      markers.forEach(m => bounds.extend(m.getPosition()));
      map.fitBounds(bounds);
      map.setZoom(Math.min(map.getZoom(), 8)); // prevent over-zoom
    }

    // ⚡ Show charging stations near each stop (only for electric vehicles)
    if (document.getElementById("fuelType").value === "electric") {
      // small delay to ensure route and map are fully rendered before querying Places API
      setTimeout(() => {
        lastCalculatedStops.forEach(stop => {
          if (stop.lat && stop.lng) {
            const stopLocation = new google.maps.LatLng(stop.lat, stop.lng);
            showChargingStationsNearStop(stopLocation);
          }
        });
      }, 800); // 0.8s delay helps ensure markers & bounds are ready
    }





    // ✅ Save all stops (for ABRP, Google Maps, etc.)
    lastCalculatedStops = allOvernights.map(stop => ({
      name: [stop.town, stop.state, stop.country].filter(Boolean).join(", ") || stop.addressFormatted,
      lat: typeof stop.latlng?.lat === "function" ? stop.latlng.lat() : stop.latlng?.lat,
      lng: typeof stop.latlng?.lng === "function" ? stop.latlng.lng() : stop.latlng?.lng
    }));

   
    

    // 🧾 Display itinerary
    document.getElementById("output").innerHTML = output;


    // 🔄 Auto-expand the output section dynamically
    const outputEl = document.getElementById("output");
    outputEl.style.maxHeight = "none";
    outputEl.style.overflowY = "visible";
    outputEl.scrollIntoView({ behavior: "smooth", block: "start" });

  } catch (err) {
    console.error("CalculateLegs error:", err);
    alert("Error calculating route: " + err);
  } finally {
    hideSpinner();
  }
}






function saveTrip() {
  const start = document.getElementById('starting').value;
  const destination = document.getElementById('destination').value;

  // 🏕️ Capture user-added stops with nights
  const stopEntries = Array.from(document.querySelectorAll('#stopsContainer .stop-entry')).map(entry => {
    const location = entry.querySelector('.stop-input')?.value.trim();
    const nights = parseInt(entry.querySelector('.stay-input')?.value) || 1;
    return location ? { location, nights } : null;
  }).filter(Boolean);

  const maxDailyDistance = parseFloat(document.getElementById("maxdaydistance").value) || 0;
  const numAdults = parseInt(document.getElementById("adults").value) || 1;
  const numChildren = parseInt(document.getElementById("children").value) || 0;
  const numRooms = parseInt(document.getElementById("rooms").value) || 1;
  const fromDate = document.getElementById("fromDate")?.value || "";
  const toDate = document.getElementById("toDate")?.value || "";
  const vehicleType = document.getElementById("vehicleType")?.value || "car";
  const fuelType = document.getElementById("fuelType")?.value || "gas";
  const fuelPrice = parseFloat(document.getElementById("fuelPrice")?.value) || 0;
  const avoidHighways = document.getElementById('avoidHighways').checked;
  const avoidTolls = document.getElementById('avoidTolls').checked;
  const avoidFerries = document.getElementById('avoidFerries').checked;


  // 👶 Children ages
  const childrenAges = [];
  for (let i = 0; i < numChildren; i++) {
    const ageSelect = document.getElementById("childAge" + i);
    if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
  }

  if (!start || !destination) {
    alert("Please enter both a starting point and a destination.");
    return;
  }

  const trip = {
    title: `${start} → ${destination}`,
    start,
    destination,
    stops: stopEntries,   // ✅ now includes both name and nights
    maxDailyDistance,
    numAdults,
    numChildren,
    childrenAges,
    numRooms,
    fromDate,
    toDate,
    vehicleType,
    fuelType,
    fuelPrice,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    distanceUnit, // ✅ add this line
    dateSaved: new Date().toLocaleString()
  };

  const savedTrips = safeJSONParse(localStorage.getItem('savedTrips'), {
    fallback: [],
    storageKey: 'savedTrips'
  }) || [];
  savedTrips.push(trip);
  localStorage.setItem('savedTrips', JSON.stringify(savedTrips));

  alert("Trip saved successfully!");
}





async function exportToPDF() {
  const { jsPDF } = window.jspdf;
  const outputDiv = document.getElementById("output");
  const mapDiv = document.getElementById("map");
  const downloadBtn = document.getElementById("downloadpdf");

  if (!outputDiv || !mapDiv) {
    alert("Missing map or itinerary content.");
    return;
  }

  // Show loading feedback
  const originalText = downloadBtn.innerText;
  downloadBtn.innerText = "Generating PDF...";
  downloadBtn.disabled = true;

  try {
    // Hide UI elements during capture
    const hiddenElements = document.querySelectorAll("button, .no-print");
    hiddenElements.forEach(el => (el.style.display = "none"));

    // ---- CAPTURE MAP IMAGE ----
    const mapCanvas = await html2canvas(mapDiv, {
      useCORS: true,
      logging: false,
      scale: 2, // high quality
    });
    const mapImgData = mapCanvas.toDataURL("image/png");

    // ---- CLEAN & FORMAT ITINERARY TEXT ----
    const clone = outputDiv.cloneNode(true);

    // Remove unwanted elements (links, buttons, price compare)
    clone.querySelectorAll("a, button, .compare, .price-compare").forEach(el => el.remove());
    [...clone.querySelectorAll("*")].forEach(el => {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("booking.com") || t.includes("expedia") || t.includes("compare prices")) {
        el.remove();
      }
    });

    // Normalize text
    let txt = (clone.textContent || "")
      .replace(/\u00A0/g, " ") // nbsp → space
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "") // remove control chars
      .replace(/\s+/g, " ") // collapse multiple spaces
      .trim();

    // Fix date spacing
    txt = txt.replace(/(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})/g, "$1 > $2");

    // Labels to highlight
    const labels = [
      "Trip Summary",
      "Total Distance:",
      "Max Daily Distance:",
      "Estimated Overnight Stops:",
      // "Suggested Overnight Stops:", seems not needed
      "Children ages:",
      "Vehicle:",
      "Average Consumption:",
      "Fuel Price:",
      "Estimated Total Fuel Cost:",
      "Stop"
    ];

    // Add line breaks and <strong> markup for bold labels
    labels.forEach(label => {
      const regex = new RegExp(`\\s*(${label})`, "gi");
      txt = txt.replace(regex, "\n<strong>$1</strong>");
    });

    // Add spacing after Trip Summary and Stop sections
    txt = txt
      .replace(/Trip Summary(?!\s*\n)/, "Trip Summary\n")
      .replace(/(Stop \d+\s*[-–]\s*Night\s*\d+)/gi, "\n<strong>$1</strong>")
      .replace(/\n{2,}/g, "\n")
      .trim();

    // Convert to HTML with line breaks
    const htmlFormatted = txt.replace(/\n/g, "<br>");

    // ---- STYLE TEMP CONTAINER ----
    const tempDiv = document.createElement("div");
    const isDark = document.body.classList.contains("dark-mode");
    tempDiv.style.cssText = `
      font-family: Arial, sans-serif;
      color: ${isDark ? "#fff" : "#000"};
      background: ${isDark ? "#121212" : "#fff"};
      padding: 20px;
      width: ${Math.max(outputDiv.offsetWidth, 320)}px;
      line-height: 1.6;
      font-size: 14px;
      white-space: normal;
    `;
    tempDiv.innerHTML = htmlFormatted;

    // ---- STYLE LABELS & HEADINGS ----
    tempDiv.querySelectorAll("strong").forEach(el => {
      const text = el.textContent.trim();

      // Big section headers (Trip Summary, Stop 1 - Night 1, etc.)
      if (/Trip Summary/i.test(text) || /Stop\s+\d+\s*[-–]\s*Night\s*\d+/i.test(text)) {
        el.style.fontWeight = "bold";
        el.style.fontSize = "18px";
        el.style.textDecoration = "underline";
        el.style.display = "block";
        el.style.marginTop = "12px";
        el.style.marginBottom = "4px";
      } 
      // Regular bold labels (like Total Distance, Fuel Price, etc.)
      else {
        el.style.fontWeight = "bold";
        el.style.fontSize = "16px";
        el.style.display = "inline-block";
        el.style.marginTop = "6px";
      }
    });

    document.body.appendChild(tempDiv);

    // ---- CAPTURE ITINERARY AS IMAGE ----
    const itineraryCanvas = await html2canvas(tempDiv, {
      useCORS: true,
      logging: false,
      scale: 2,
    });
    const itineraryImgData = itineraryCanvas.toDataURL("image/png");
    document.body.removeChild(tempDiv);

    // ---- BUILD PDF ----
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    // Map image
    const imgWidth = 190;
    const mapHeight = (mapCanvas.height * imgWidth) / mapCanvas.width;
    pdf.addImage(mapImgData, "PNG", 10, 10, imgWidth, mapHeight);

    // Itinerary image below map
    const yStart = 10 + mapHeight + 10;
    const itineraryHeight = (itineraryCanvas.height * imgWidth) / itineraryCanvas.width;

    if (yStart + itineraryHeight > 290) {
      pdf.addPage();
      pdf.addImage(itineraryImgData, "PNG", 10, 20, imgWidth, itineraryHeight);
    } else {
      pdf.addImage(itineraryImgData, "PNG", 10, yStart, imgWidth, itineraryHeight);
    }

    // Save PDF
    pdf.save("trip_itinerary.pdf");
  } catch (err) {
    console.error("PDF export failed:", err);
    alert("Failed to generate PDF. Please try again.");
  } finally {
    // Restore UI
    const hiddenElements = document.querySelectorAll("button, .no-print");
    hiddenElements.forEach(el => (el.style.display = ""));
    downloadBtn.innerText = originalText;
    downloadBtn.disabled = false;
  }
}

/* 🌗 Theme Toggle (unchanged) */
const themeToggle = document.getElementById("themeToggle");
const savedTheme = localStorage.getItem("theme");

if (savedTheme === "dark") {
  document.body.classList.add("dark-mode");
  themeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
}
if (savedTheme === "dark" && typeof map !== "undefined" && map) {
  map.setOptions({ styles: darkMapStyle });
}
themeToggle.addEventListener("click", () => {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  themeToggle.innerHTML = isDark
    ? '<i class="fa-solid fa-sun"></i>'
    : '<i class="fa-solid fa-moon"></i>';
  localStorage.setItem("theme", isDark ? "dark" : "light");
  if (typeof map !== "undefined" && map) {
    map.setOptions({ styles: isDark ? darkMapStyle : [] });
  }
});





function extractStopsFromOutput() {
  const paragraphs = Array.from(document.querySelectorAll("#output p"));
  const stops = [];

  paragraphs.forEach(p => {
    const html = p.innerHTML;
    const match = html.match(/<br>\s*([^<]+)<br>/i);
    let place = match ? match[1].trim() : "";

    if (!place) {
      const lines = p.innerText.split("\n").map(l => l.trim()).filter(Boolean);
      place = lines.find(line => !line.includes("Stop") && !line.includes("Night") && !line.includes("→")) || "";
    }

    if (place) stops.push(place);
  });

  return stops;
}

function OpenGoogleMaps() {
  let start = document.getElementById("starting").value.trim();
  let dest = document.getElementById("destination").value.trim();
  const stops = extractStopsFromOutput();

  // Use itinerary stops if available
  if (stops.length > 0) {
    if (!dest) dest = stops[stops.length - 1]; // last stop becomes destination
  }

  // Waypoints are all middle stops
  const waypoints = stops.slice(0, -1);

  if (!start || !dest) {
    alert("Enter or calculate at least a start and destination first.");
    return;
  }

  // Build Google Maps URL with multiple waypoints
  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(start)}&destination=${encodeURIComponent(dest)}`;
  if (waypoints.length) {
    url += `&waypoints=${encodeURIComponent(waypoints.join("|"))}`;
  }

  window.open(url, "_blank");
}


function OpenABRP() {
  if (!lastCalculatedStops.length) {
    alert("Please calculate your route first.");
    return;
  }

  // ✅ Use starting point (coords preferred)
  let from = document.getElementById("starting").value.trim();
  if (startCoords?.lat && startCoords?.lng) {
    from = `${startCoords.lat},${startCoords.lng}`;
  }

  // ✅ Just use the *final destination* stop
  const lastStop = lastCalculatedStops.at(-1);
  if (!lastStop || !lastStop.lat || !lastStop.lng) {
    alert("No valid destination found. Try recalculating your route.");
    return;
  }

  const destination = `${lastStop.lat},${lastStop.lng}`;

  // ✅ Only build route from → destination
  const url = `https://abetterrouteplanner.com/?plan_uuid=null&plan=1`
    + `&from=${encodeURIComponent(from)}`
    + `&to=${encodeURIComponent(destination)}`
    + `&vehicle=tesla:model3:23:awd:longrange:us`;

  console.log("ABRP destination-only link →", url);
  window.open(url, "_blank");
}










function OpenGoogleMapsFullRoute() {
  const start = document.getElementById("starting").value.trim();
  const dest = document.getElementById("destination").value.trim();
  const stops = extractStopsFromOutput();

  if (!start && stops.length === 0) {
    alert("Please enter or calculate your route first.");
    return;
  }

  const allStops = [start, ...stops];
  if (dest) allStops.push(dest);

  const url = `https://www.google.com/maps/dir/${allStops.map(encodeURIComponent).join("/")}`;
  window.open(url, "_blank");
}

function OpenABRPFullRoute() {
  const start = document.getElementById("starting").value.trim();
  const dest = document.getElementById("destination").value.trim();
  const stops = extractStopsFromOutput();

  if (!start && stops.length === 0) {
    alert("Please enter or calculate your route first.");
    return;
  }

  const allStops = [start, ...stops];
  if (dest) allStops.push(dest);

  let url = `https://abetterrouteplanner.com/?plan=1`;
  allStops.forEach((stop, i) => {
    if (i === 0) {
      url += `&from=${encodeURIComponent(stop)}`;
    } else if (i === allStops.length - 1) {
      url += `&to=${encodeURIComponent(stop)}`;
    } else {
      url += `&v${i}=${encodeURIComponent(stop)}`;
    }
  });

  window.open(url, "_blank");
}



function readInlineMapsKey() {
  const key =
    typeof window !== "undefined" && typeof window.GOOGLE_MAPS_API_KEY === "string" && window.GOOGLE_MAPS_API_KEY.trim()
      ? window.GOOGLE_MAPS_API_KEY.trim()
      : document.querySelector("meta[name='google-maps-api-key']")?.content?.trim() ||
        document.querySelector("[data-google-maps-key]")?.dataset.googleMapsKey?.trim();

  if (key && key.trim()) {
    return key.trim();
  }

  if (typeof FALLBACK_GOOGLE_MAPS_API_KEY === "string" && FALLBACK_GOOGLE_MAPS_API_KEY.trim()) {
    return FALLBACK_GOOGLE_MAPS_API_KEY.trim();
  }

  return null;
}

function resolveApiBaseUrl() {
  if (typeof window === "undefined") return "";

  const inlineBase =
    typeof window.TRAVELPATHPRO_API_BASE_URL === "string" && window.TRAVELPATHPRO_API_BASE_URL.trim()
      ? window.TRAVELPATHPRO_API_BASE_URL.trim()
      : null;

  if (inlineBase) {
    return inlineBase;
  }

  const metaBase = document.querySelector("meta[name='travelpathpro-api-base']")?.content?.trim();
  if (metaBase) {
    return metaBase;
  }

  return "";
}

function useFallbackMapsKey(reason) {
  if (typeof FALLBACK_GOOGLE_MAPS_API_KEY === "string" && FALLBACK_GOOGLE_MAPS_API_KEY.trim()) {
    console.warn(`Falling back to built-in Google Maps API key: ${reason}`);
    return FALLBACK_GOOGLE_MAPS_API_KEY.trim();
  }

  throw new Error(
    `${reason} Configure a Google Maps API key via window.GOOGLE_MAPS_API_KEY, a <meta name='google-maps-api-key'> tag, or ` +
      `provide a backend /api/maps-key endpoint.`
  );
}

async function requestMapsKey() {
  try {
    const apiBase = resolveApiBaseUrl();
    let endpointUrl = "/api/maps-key";

    try {
      const base = apiBase || (typeof window !== "undefined" ? window.location.href : "");
      if (base) {
        endpointUrl = new URL("api/maps-key", base).toString();
      }
    } catch (urlError) {
      console.warn("Falling back to default /api/maps-key endpoint due to URL resolution error:", urlError);
    }

    const response = await fetch(endpointUrl, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({ error: response.statusText }));
      return useFallbackMapsKey(
        error || `Unable to retrieve Google Maps API key from the server (endpoint: ${endpointUrl}).`
      );
    }

    const data = await response.json();
    if (!data?.key) {
      return useFallbackMapsKey("Google Maps API key is not configured on the server.");
    }

    if (typeof data.key !== "string" || !data.key.trim()) {
      return useFallbackMapsKey("Google Maps API key returned by the server is invalid.");
    }

    return data.key.trim();
  } catch (networkError) {
    if (networkError instanceof TypeError) {
      return useFallbackMapsKey(
        "Unable to contact the /api/maps-key endpoint. If you're serving the site statically or from a different domain, " +
          "set window.TRAVELPATHPRO_API_BASE_URL or add <meta name='travelpathpro-api-base'> to point to the server."
      );
    }

    throw networkError;
  }
}

async function resolveMapsKey() {
  const inlineKey = readInlineMapsKey();
  if (inlineKey) {
    return inlineKey;
  }

  return requestMapsKey();
}

async function loadGoogleMaps() {
  if (document.querySelector("script[data-google-maps]") || typeof google !== "undefined") {
    return;
  }

  try {
    const key = await resolveMapsKey();

    if (!key) {
      throw new Error(
        "Google Maps API key was not found. Configure it via window.GOOGLE_MAPS_API_KEY, a <meta name='google-maps-api-key'> tag, or the /api/maps-key endpoint."
      );
    }

    const script = document.createElement("script");
    const encodedKey = encodeURIComponent(key);
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodedKey}&libraries=places,geometry&callback=initAutocomplete`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "true";
    script.onerror = () => {
      handleMapsLoadError(new Error("Failed to load Google Maps JavaScript API."));
    };
    document.head.appendChild(script);
  } catch (error) {
    handleMapsLoadError(error);
  }
}

function handleMapsLoadError(error) {
  console.error("Google Maps API failed to load:", error);

  const mapContainer = document.getElementById("map");
  if (mapContainer && !mapContainer.querySelector(".map-error")) {
    const errorMessage = document.createElement("div");
    errorMessage.className = "map-error";
    errorMessage.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;text-align:center;padding:1.5rem;background:#fff4f4;border:1px solid #f5c2c7;color:#842029;border-radius:10px;";
    errorMessage.innerHTML = `⚠️ Unable to load Google Maps.<br><small>${error.message}</small>`;
    mapContainer.innerHTML = "";
    mapContainer.appendChild(errorMessage);
  }
}

loadGoogleMaps();


function extractLatLngLiteral(latLng) {
  if (!latLng) return null;

  const latValue = typeof latLng.lat === "function" ? latLng.lat() : latLng.lat;
  const lngValue = typeof latLng.lng === "function" ? latLng.lng() : latLng.lng;

  if (
    typeof latValue === "number" &&
    typeof lngValue === "number" &&
    !Number.isNaN(latValue) &&
    !Number.isNaN(lngValue)
  ) {
    return { lat: latValue, lng: lngValue };
  }

  return null;
}

function formatDistanceFromMeters(distanceMeters = 0) {
  if (!distanceMeters || Number.isNaN(distanceMeters)) {
    return "0 km";
  }

  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
  }

  return `${Math.round(distanceMeters)} m`;
}

function parseDurationToSeconds(duration) {
  if (!duration || typeof duration !== "string") return 0;

  const match = duration.match(/(-?\d+(?:\.\d*)?)s/);
  if (!match) return 0;

  return Math.round(parseFloat(match[1]));
}

function formatDurationFromSeconds(totalSeconds = 0) {
  if (!totalSeconds || Number.isNaN(totalSeconds)) return "0 min";

  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours && minutes) return `${hours} hr ${minutes} min`;
  if (hours) return `${hours} hr`;
  if (minutes) return `${minutes} min`;
  return `${remainingSeconds} sec`;
}

function decodePolylineToLatLng(encoded = "") {
  if (!encoded || typeof encoded !== "string") return [];

  if (
    typeof google !== "undefined" &&
    google?.maps?.geometry?.encoding?.decodePath
  ) {
    return google.maps.geometry.encoding.decodePath(encoded);
  }

  // Minimal fallback decoder if geometry library is unavailable
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLat = (result & 1) ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const deltaLng = (result & 1) ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push(new google.maps.LatLng(lat / 1e5, lng / 1e5));
  }

  return points;
}

function deriveLegAddresses(context, legIndex) {
  const waypointLabels = Array.isArray(context.waypointLabels) ? context.waypointLabels : [];

  const startAddress =
    legIndex === 0
      ? context.originText
      : waypointLabels[legIndex - 1] || context.originText;

  const endAddress =
    legIndex < waypointLabels.length
      ? waypointLabels[legIndex] || context.destinationText
      : context.destinationText;

  return { startAddress, endAddress };
}

function transformRoutesApiResponse(data, context) {
  if (!data?.routes?.length) {
    throw new Error("Routes API returned no routes.");
  }

  const [apiRoute] = data.routes;

  const overviewPath = decodePolylineToLatLng(apiRoute?.polyline?.encodedPolyline || "");
  const bounds = new google.maps.LatLngBounds();
  overviewPath.forEach(point => bounds.extend(point));

  const totalLegs = (apiRoute.legs || []).length;

  const legs = (apiRoute.legs || []).map((leg, index) => {
    const startLatLng = leg?.startLocation?.latLng;
    const endLatLng = leg?.endLocation?.latLng;

    const startLocation = startLatLng
      ? new google.maps.LatLng(startLatLng.latitude, startLatLng.longitude)
      : index === 0 && context.originLiteral
        ? new google.maps.LatLng(context.originLiteral.lat, context.originLiteral.lng)
        : null;

      const endLocation = endLatLng
        ? new google.maps.LatLng(endLatLng.latitude, endLatLng.longitude)
        : index === totalLegs - 1 && context.destinationLiteral
        ? new google.maps.LatLng(context.destinationLiteral.lat, context.destinationLiteral.lng)
        : null;

    const steps = (leg.steps || []).map(step => {
      const path = decodePolylineToLatLng(step?.polyline?.encodedPolyline || "");
      const distanceMeters = step?.distanceMeters || 0;
      const durationSeconds = parseDurationToSeconds(step?.staticDuration || step?.duration || "0s");

      const startStep = path.length ? path[0] : startLocation;
      const endStep = path.length ? path[path.length - 1] : endLocation;

      return {
        distance: {
          value: distanceMeters,
          text: formatDistanceFromMeters(distanceMeters),
        },
        duration: {
          value: durationSeconds,
          text: formatDurationFromSeconds(durationSeconds),
        },
        start_location: startStep || null,
        end_location: endStep || null,
        path,
        instructions: step?.navigationInstruction?.instructions || "",
      };
    });

    const legPath = steps.flatMap(step => step.path).filter(Boolean);
    const legDistance = leg?.distanceMeters || 0;
    const legDurationSeconds = parseDurationToSeconds(leg?.duration || "0s");

    const { startAddress, endAddress } = deriveLegAddresses(context, index);

    return {
      distance: {
        value: legDistance,
        text: formatDistanceFromMeters(legDistance),
      },
      duration: {
        value: legDurationSeconds,
        text: formatDurationFromSeconds(legDurationSeconds),
      },
      start_location: startLocation || (legPath[0] || null),
      end_location: endLocation || (legPath[legPath.length - 1] || null),
      steps,
      path: legPath,
      start_address: startAddress,
      end_address: endAddress,
      via_waypoints: [],
      via_waypoint_order: [],
    };
  });

  return {
    geocoded_waypoints: [],
    routes: [
      {
        legs,
        overview_path: overviewPath,
        overview_polyline: { points: apiRoute?.polyline?.encodedPolyline || "" },
        bounds,
        warnings: [],
        waypoint_order: [],
      },
    ],
    request: null,
  };
}

async function computeRouteUsingRoutesApi({
  originLatLng,
  destinationLatLng,
  originText,
  destinationText,
  waypointMetadata = [],
  avoidHighways = false,
  avoidTolls = false,
  avoidFerries = false,
}) {
  const originLiteral = extractLatLngLiteral(originLatLng);
  const destinationLiteral = extractLatLngLiteral(destinationLatLng);

  const payload = {
    origin: originLiteral
      ? { lat: originLiteral.lat, lng: originLiteral.lng, label: originText }
      : { address: originText },
    destination: destinationLiteral
      ? { lat: destinationLiteral.lat, lng: destinationLiteral.lng, label: destinationText }
      : { address: destinationText },
  };

  const routeModifiers = {
    avoidHighways: Boolean(avoidHighways),
    avoidTolls: Boolean(avoidTolls),
    avoidFerries: Boolean(avoidFerries),
  };

  if (routeModifiers.avoidHighways || routeModifiers.avoidTolls || routeModifiers.avoidFerries) {
    payload.routeModifiers = routeModifiers;
  }

  if (Array.isArray(waypointMetadata) && waypointMetadata.length) {
    payload.waypoints = waypointMetadata
      .map(meta => {
        if (
          typeof meta?.lat === "number" &&
          typeof meta?.lng === "number" &&
          !Number.isNaN(meta.lat) &&
          !Number.isNaN(meta.lng)
        ) {
          return { lat: meta.lat, lng: meta.lng, label: meta.label };
        }
        if (meta?.label) {
          return { address: meta.label };
        }
        return null;
      })
      .filter(Boolean);
  }

  const response = await fetch("/api/compute-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      payload?.error ||
      payload?.message ||
      response.statusText ||
      "Routes API request failed.";
    const error = new Error(message);
    if (payload?.hint) {
      error.hint = payload.hint;
    }
    if (payload?.status) {
      error.status = payload.status;
    }
    if (payload?.details) {
      error.details = payload.details;
    }
    throw error;
  }

  const data = await response.json();

  return transformRoutesApiResponse(data, {
    originLiteral,
    destinationLiteral,
    originText,
    destinationText,
    waypointLabels: Array.isArray(waypointMetadata)
      ? waypointMetadata.map(meta => meta?.label || "")
      : [],
  });
}


// ✅ Load trip if redirected from saved.html
window.addEventListener("load", () => {
  if (localStorage.getItem("tripToLoad")) {
    setTimeout(() => loadSelectedTrip(), 400); // slight delay to let map initialize
  }
});



function showMessage(msg, type = "error") {
  // Clear previous results
  const output = document.getElementById("output");
  output.innerHTML = "<h3>🗺️ Trip Summary</h3>";

  // Build nice card-style layout for each leg
  legs.forEach((leg, i) => {
    const from = leg.start;
    const to = leg.end;
    const distanceText = leg.distance.text;
    const durationText = leg.duration.text;
    const hotelNote = leg.stayNights && leg.stayNights > 0 
      ? `Recommended: Stay ${leg.stayNights} night${leg.stayNights > 1 ? "s" : ""} in ${to} 🏨`
      : "";

    const cardHTML = `
      <div class="leg-card">
        <h4><i class="fa-solid fa-route"></i> Leg ${i + 1}: ${from} → ${to}</h4>
        <div class="leg-info">
          <span class="badge"><i class="fa-solid fa-road"></i> ${distanceText}</span>
          <span class="badge"><i class="fa-solid fa-clock"></i> ${durationText}</span>
        </div>
        ${hotelNote ? `<p class="leg-note">${hotelNote}</p>` : ""}
      </div>
    `;

    output.insertAdjacentHTML("beforeend", cardHTML);
  });

  // Optional: Add total summary
  if (legs.length > 0) {
    const totalDist = legs.reduce((sum, l) => sum + l.distance.value, 0) / 1000; // convert m → km
    const totalHTML = `
      <hr>
      <div class="leg-card" style="border-left-color:#34a853;">
        <h4><i class="fa-solid fa-flag-checkered"></i> Trip Total</h4>
        <div class="leg-info">
          <span class="badge"><i class="fa-solid fa-road"></i> ${totalDist.toFixed(1)} km</span>
        </div>
      </div>
    `;
    output.insertAdjacentHTML("beforeend", totalHTML);
  }

}


// Snap a given LatLng to the closest point on an existing route polyline
function snapToRoute(latlng, overviewPath) {
  if (!overviewPath || overviewPath.length < 2) return latlng;

  let minDistance = Infinity;
  let closestPoint = null;

  for (let i = 1; i < overviewPath.length; i++) {
    const p1 = overviewPath[i - 1];
    const p2 = overviewPath[i];
    const candidate = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);

    // Project latlng onto this segment
    const projection = google.maps.geometry.spherical.interpolate(
      p1,
      p2,
      Math.max(0, Math.min(1, projectionFraction(latlng, p1, p2)))
    );

    const dist = google.maps.geometry.spherical.computeDistanceBetween(latlng, projection);
    if (dist < minDistance) {
      minDistance = dist;
      closestPoint = projection;
    }
  }

  return closestPoint || latlng;
}

// Helper to get fractional position of a point projection along a segment
function projectionFraction(p, a, b) {
  const toRad = x => (x * Math.PI) / 180;
  const lat1 = toRad(a.lat()), lng1 = toRad(a.lng());
  const lat2 = toRad(b.lat()), lng2 = toRad(b.lng());
  const latP = toRad(p.lat()), lngP = toRad(p.lng());
  const dx = Math.cos(lat2) * Math.cos(lng2) - Math.cos(lat1) * Math.cos(lng1);
  const dy = Math.sin(lat2) - Math.sin(lat1);
  // Approximate fraction; this doesn't need to be perfect
  return ((latP - lat1) * dy + (lngP - lng1) * dx) / (dx * dx + dy * dy);
}



function OpenTravelSite(site = "booking") {
  const fromDateInput = document.getElementById("fromDate");
  const checkinDate = new Date(fromDateInput?.value || formatDate(new Date()));

  const numAdults = parseInt(document.getElementById("adults").value) || 1;
  const numChildren = parseInt(document.getElementById("children").value) || 0;
  const childrenAges = [];
  for (let i = 0; i < numChildren; i++) {
    const ageSelect = document.getElementById("childAge" + i);
    if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
  }

  const stayNights = 1;
  const checkoutDate = new Date(checkinDate);
  checkoutDate.setDate(checkinDate.getDate() + stayNights);

  const outputDiv = document.getElementById("output");
  let place = "";
  let lat = null, lng = null;

  // ✅ Prefer coordinates from the first stop marker
  if (window.markers && markers.length > 1) {
    const pos = markers[1].getPosition?.();
    if (pos) {
      lat = pos.lat();
      lng = pos.lng();
    }
  }

  // Fallback to text from itinerary
  if (!lat || !lng) {
    const firstStopParagraph = outputDiv.querySelector("p");
    if (firstStopParagraph) {
      const textLines = firstStopParagraph.innerText
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
      const possibleLocation = textLines.find(
        l => !l.toLowerCase().includes("stop") &&
             !l.includes("→") &&
             !l.toLowerCase().includes("night")
      );
      if (possibleLocation) place = possibleLocation;
    }

    if (!place) {
      const firstStopInput = document.querySelector(".stop-input");
      if (firstStopInput) place = firstStopInput.value.trim();
    }
  }

  if (!lat && !place) {
    alert("Please calculate your trip or add at least one stop first.");
    return;
  }

  // 🌐 Build URLs per site
  let url = "";
  switch (site.toLowerCase()) {
    case "booking":
      if (lat && lng) {
        url = `https://www.booking.com/searchresults.html?latitude=${lat}&longitude=${lng}&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}&group_adults=${numAdults}&group_children=${numChildren}${childrenAges.length ? `&age=${childrenAges.join(',')}` : ''}&order=distance_from_search`;
      } else {
        url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(place)}&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}&group_adults=${numAdults}&group_children=${numChildren}${childrenAges.length ? `&age=${childrenAges.join(',')}` : ''}`;
      }
      break;

    case "expedia":
      if (lat && lng) {
        url = `https://www.expedia.com/Hotel-Search?lat=${lat}&lng=${lng}&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}&adults=${numAdults}&children=${numChildren}${childrenAges.length ? `&childAges=${childrenAges.join(',')}` : ''}&showMap=true`;
      } else {
        url = `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(place)}&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}&adults=${numAdults}&children=${numChildren}${childrenAges.length ? `&childAges=${childrenAges.join(',')}` : ''}`;
      }
      break;

    case "tripadvisor":
      if (lat && lng) {
        url = `https://www.tripadvisor.com/Search?geo=${lat},${lng}&query=hotels&uiOrigin=tripsearch&pid=3826`;
      } else {
        url = `https://www.tripadvisor.com/Search?q=${encodeURIComponent(place + " hotels")}`;
      }
      break;

    default:
      url = "https://www.booking.com";
  }

  window.open(url, "_blank");
}


function openStopTravelSite(site, lat, lng, placeEncoded, isAttraction = false, checkin = null, checkout = null) {
  const place = decodeURIComponent(placeEncoded);

  // ✅ Use provided dates or default to today → tomorrow
  const checkinDate = checkin ? new Date(checkin + "T00:00") : new Date();
  const checkoutDate = checkout ? new Date(checkout + "T00:00") : new Date(checkinDate.getTime() + 86400000);

  const numAdults = parseInt(document.getElementById("adults").value) || 1;
  const numChildren = parseInt(document.getElementById("children").value) || 0;
  const numRooms = parseInt(document.getElementById("rooms").value) || 1;

  // ✅ Build children ages
  const childrenAges = [];
  for (let i = 0; i < numChildren; i++) {
    const ageSelect = document.getElementById("childAge" + i);
    if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
  }

  let url = "";
  const totalTravellers = numAdults + numChildren;

  switch (site.toLowerCase()) {
    // 🏨 BOOKING.COM
    case "booking":
      // ✅ Booking expects &age=5&age=10 (no numbering)
      const bookingAgeParams = childrenAges.map(age => `&age=${age}`).join("");

      if (lat && lng) {
        url = `https://www.booking.com/searchresults.html?&ss=${encodeURIComponent(place)}`
          + `&latitude=${lat}&longitude=${lng}`
          + `&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}`
          + `&no_rooms=${numRooms}`
          + `&group_adults=${numAdults}&group_children=${numChildren}`
          + bookingAgeParams
          + `&order=distance_from_search`;
      } else {
        url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(place)}`
          + `&checkin=${formatDate(checkinDate)}&checkout=${formatDate(checkoutDate)}`
          + `&no_rooms=${numRooms}`
          + `&group_adults=${numAdults}&group_children=${numChildren}`
          + bookingAgeParams
          + `&order=distance_from_search`;
      }
      break;

    // ✈️ EXPEDIA
    case "expedia":
      // ✅ Expedia: combine total travelers + rooms
      const expediaChildParams = childrenAges.length ? `&childAges=${childrenAges.join(',')}` : "";
      if (lat && lng) {
        url = `https://www.expedia.com/Hotel-Search?destination=${lat},${lng}`
          + `&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}`
          + `&rooms=${numRooms}`
          + `&adults=${totalTravellers}`
          + expediaChildParams
          + `&showMap=true`;
      } else {
        url = `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(place)}`
          + `&startDate=${formatDate(checkinDate)}&endDate=${formatDate(checkoutDate)}`
          + `&rooms=${numRooms}`
          + `&adults=${totalTravellers}`
          + expediaChildParams;
      }
      break;


    // 🌐 TRIPADVISOR (use text-based search for reliability)
    case "tripadvisor":
      const query = encodeURIComponent(place + (isAttraction ? " attractions" : " hotels"));
      url = `https://www.tripadvisor.com/Search?q=${query}`;
      break;

  }

  window.open(url, "_blank");
}


function showChargingStationsNearStop(stopLocation, radius = 50000) {
  if (!map || !stopLocation) return;

  // Initialize or clear previous charger markers
  if (!window.chargerMarkers) window.chargerMarkers = [];
  window.chargerMarkers.forEach(marker => marker.setMap(null));
  window.chargerMarkers = [];

  const service = new google.maps.places.PlacesService(map);
  const request = {
    location: stopLocation,
    radius: radius,
    keyword: "EV charging station"
  };

  service.nearbySearch(request, (results, status) => {
    if (status === google.maps.places.PlacesServiceStatus.OK && results.length > 0) {
      results.forEach(place => {
        // ⚡ Infer charger level from name or types
        const name = (place.name || "").toLowerCase();
        let iconUrl = "https://maps.google.com/mapfiles/ms/icons/green-dot.png"; // default (Level 2)

        if (name.includes("dc") || name.includes("fast") || name.includes("supercharger")) {
          iconUrl = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"; // DC fast
        } else if (name.includes("tesla")) {
          iconUrl = "https://maps.google.com/mapfiles/ms/icons/red-dot.png"; // Tesla
        } else if (name.includes("level 1")) {
          iconUrl = "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png"; // Level 1 (slow)
        }

        // 🧭 Place the marker
        const marker = new google.maps.Marker({
          position: place.geometry.location,
          map: map,
          icon: { url: iconUrl },
          title: place.name
        });

        // Store marker globally
        window.chargerMarkers.push(marker);

        // 🪧 Info window
        const infowindow = new google.maps.InfoWindow({
          content: `
            <div style="font-size:14px">
              <strong>${place.name}</strong><br>
              ${place.vicinity || ""}
            </div>
          `
        });
        marker.addListener("click", () => infowindow.open(map, marker));
      });
    } else if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
      console.info("No EV stations found near:", stopLocation.toString());
    } else {
      console.warn("PlacesService error:", status);
    }
  });
}




function comparePrices(lat, lng, place, checkin, checkout) {
  // 🔧 fix: decode in case already encoded
  place = decodeURIComponent(place);
  const adults = parseInt(document.getElementById("adults").value) || 2;
  const children = parseInt(document.getElementById("children").value) || 0;
  const rooms = parseInt(document.getElementById("rooms").value) || 1;
  const childrenAges = [];
  for (let i = 0; i < children; i++) {
    const ageSelect = document.getElementById("childAge" + i);
    if (ageSelect) childrenAges.push(parseInt(ageSelect.value) || 0);
  }

  const totalTravelers = adults + children;

  // ✅ Use place directly, encode only once when embedding in the URL
  const bookingPlace = encodeURIComponent(place.trim());
  const expediaPlace = encodeURIComponent(place.trim());

  // ✅ Booking.com (coordinates preferred)
  let booking;
  if (lat && lng) {
    booking = `https://www.booking.com/searchresults.html`
      + `?ss=${bookingPlace}`
      + `&latitude=${lat}&longitude=${lng}`
      + `&checkin=${checkin}&checkout=${checkout}`
      + `&no_rooms=${rooms}`
      + `&group_adults=${adults}&group_children=${children}`
      + childrenAges.map(age => `&age=${age}`).join("")
      + `&order=distance_from_search`;
  } else {
    booking = `https://www.booking.com/searchresults.html`
      + `?ss=${bookingPlace}`
      + `&checkin=${checkin}&checkout=${checkout}`
      + `&no_rooms=${rooms}`
      + `&group_adults=${adults}&group_children=${children}`
      + childrenAges.map(age => `&age=${age}`).join("");
  }

  // ✅ Expedia (same encoding rule)
  let expedia;
  if (lat && lng) {
    expedia = `https://www.expedia.com/Hotel-Search`
      + `?destination=${lat},${lng}`
      + `&startDate=${checkin}&endDate=${checkout}`
      + `&rooms=${rooms}`
      + `&adults=${totalTravelers}`
      + (childrenAges.length ? `&childAges=${childrenAges.join(',')}` : '')
      + `&showMap=true`;
  } else {
    expedia = `https://www.expedia.com/Hotel-Search`
      + `?destination=${expediaPlace}`
      + `&startDate=${checkin}&endDate=${checkout}`
      + `&rooms=${rooms}`
      + `&adults=${totalTravelers}`;
  }

  // 🪟 Open both sites
  window.open(booking, "_blank");
  window.open(expedia, "_blank");
}



// 🔋 Automatically show or remove charging stations when fuel type changes
document.getElementById("fuelType").addEventListener("change", (e) => {
  const fuelType = e.target.value;

  // If route already calculated
  if (typeof lastCalculatedStops !== "undefined" && lastCalculatedStops.length > 0) {
    // Remove any old charging markers first (if you track them)
    if (window.chargingMarkers) {
      window.chargingMarkers.forEach(m => m.setMap(null));
      window.chargingMarkers = [];
    }

    // Only show stations if user just switched to "electric"
    if (fuelType === "electric") {
      setTimeout(() => {
        lastCalculatedStops.forEach(stop => {
          if (stop.lat && stop.lng) {
            const stopLocation = new google.maps.LatLng(stop.lat, stop.lng);
            showChargingStationsNearStop(stopLocation);
          }
        });
      }, 500); // delay allows map to stabilize
    }
  }
});


// Toggle EV charger legend based on fuel type selection
const fuelSelect = document.getElementById("fuelType");
const colorKey = document.getElementById("colorKey");

fuelSelect.addEventListener("change", () => {
  const fuelType = fuelSelect.value;

  if (fuelType === "electric") {
    // Show legend
    colorKey.style.display = "block";

    // 🔋 Show chargers near each stop
    if (typeof lastCalculatedStops !== "undefined" && lastCalculatedStops.length > 0) {
      setTimeout(() => {
        lastCalculatedStops.forEach(stop => {
          if (stop.lat && stop.lng) {
            const stopLocation = new google.maps.LatLng(stop.lat, stop.lng);
            showChargingStationsNearStop(stopLocation);
          }
        });
      }, 500);
    }
  } else {
    // Hide legend
    colorKey.style.display = "none";

    // 🧹 Clear all charging station markers
    if (window.chargerMarkers && window.chargerMarkers.length > 0) {
      window.chargerMarkers.forEach(marker => marker.setMap(null));
      window.chargerMarkers = [];
    }
  }
});


// Optional: Show legend if a saved trip with electric vehicle is loaded
window.addEventListener("load", () => {
  if (fuelSelect.value === "electric") {
    colorKey.style.display = "block";
  }
});
