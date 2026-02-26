const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================
// In-Memory Machine Storage
// ================================
let machines = {};

// ================================
// RECEIVE DATA FROM ESP32
// ================================
app.post("/api/data", (req, res) => {

  const data = req.body;

  if (!data.deviceId) {
    return res.status(400).json({ error: "Missing deviceId" });
  }

  if (!machines[data.deviceId]) {
    machines[data.deviceId] = {};
  }

  machines[data.deviceId] = {
    deviceId: data.deviceId,
    stitches: Number(data.stitches) || 0,
    threadBreak: Number(data.threadBreak) || 0,
    frames: Number(data.frames) || 0,   // 🔥 Frame support added
    status: data.status || "UNKNOWN",
    event: data.event || "NONE",
    lastUpdate: Date.now()
  };

  console.log("Received:", data.deviceId, data.event);

  res.json({ status: "ok" });
});


// ================================
// GET ALL MACHINES
// ================================
app.get("/api/machines", (req, res) => {
  res.json(machines);
});


// ================================
// GET SINGLE MACHINE
// ================================
app.get("/api/machine/:id", (req, res) => {

  const id = req.params.id;

  if (!machines[id]) {
    return res.status(404).json({ error: "Machine not found" });
  }

  res.json(machines[id]);
});


// ================================
// RESET MACHINE DATA (Optional)
// ================================
app.post("/api/reset/:id", (req, res) => {

  const id = req.params.id;

  if (!machines[id]) {
    return res.status(404).json({ error: "Machine not found" });
  }

  machines[id].stitches = 0;
  machines[id].threadBreak = 0;
  machines[id].frames = 0;

  res.json({ message: "Machine counters reset" });
});


// ================================
// DASHBOARD
// ================================
app.get("/", (req, res) => {

  res.send(`
  <html>
  <head>
    <title>Embroidery Monitoring</title>
    <style>
      body { 
        font-family: Arial; 
        background:#f4f4f4; 
        padding:20px; 
      }
      .card { 
        background:white; 
        padding:15px; 
        margin:10px; 
        border-radius:8px; 
        box-shadow:0 2px 6px rgba(0,0,0,0.1); 
      }
      .running { color:green; font-weight:bold; }
      .stopped { color:red; font-weight:bold; }
      .offline { color:gray; }
    </style>
  </head>
  <body>
    <h1>🧵 Embroidery Machine Dashboard</h1>
    <div id="machines"></div>

    <script>

      async function loadData() {
        const res = await fetch('/api/machines');
        const data = await res.json();

        let html = "";

        for (let id in data) {

          const m = data[id];
          const isOnline = (Date.now() - m.lastUpdate) < 60000;

          html += \`
            <div class="card">
              <h2>\${m.deviceId}</h2>
              <p>Status: 
                <span class="\${m.status === "RUNNING" ? "running" : "stopped"}">
                  \${m.status}
                </span>
              </p>

              <p>🧵 Stitches: <b>\${m.stitches}</b></p>
              <p>⚠️ Thread Breaks: <b>\${m.threadBreak}</b></p>
              <p>🖼️ Frames Completed: <b>\${m.frames}</b></p>

              <p>Last Event: \${m.event}</p>
              <p>Online: 
                <span class="\${isOnline ? "running" : "offline"}">
                  \${isOnline ? "YES" : "NO"}
                </span>
              </p>
            </div>
          \`;
        }

        document.getElementById("machines").innerHTML = html;
      }

      setInterval(loadData, 2000);
      loadData();

    </script>
  </body>
  </html>
  `);
});


// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});