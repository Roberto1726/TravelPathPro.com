import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve your static files (HTML, CSS, JS)
app.use(express.static(__dirname));

// Secure route that provides the key to frontend
app.get("/api/maps-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    return res.status(500).json({ error: "Google Maps API key is not configured." });
  }

  res.json({ key });
});

// Start server
const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
