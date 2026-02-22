const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Store machine data in memory
let machines = {};

// ===== RECEIVE DATA FROM ESP =====
app.post("/api/data", (req, res) => {
  const data = req.body;

  if (!data.deviceId) {
    return res.status(400).json({ error: "Missing deviceId" });
  }

  machines[data.deviceId] = {
    deviceId: data.deviceId,
    stitches: data.stitches,
    threadBreak: data.threadBreak,
    status: data.status,
    event: data.event,
    lastUpdate: Date.now()
  };

  console.log("Received:", data.deviceId, data.event);

  res.json({ status: "ok" });
});

// ===== GET ALL MACHINES =====
app.get("/api/machines", (req, res) => {
  res.json(machines);
});

// ===== GET SINGLE MACHINE =====
app.get("/api/machine/:id", (req, res) => {
  const id = req.params.id;

  if (!machines[id]) {
    return res.status(404).json({ error: "Machine not found" });
  }

  res.json(machines[id]);
});

// ===== DASHBOARD =====
app.get("/", (req, res) => {
  res.send(`
  <html>
  <head>
    <title>Embroidery Monitoring</title>
    <style>
      body { font-family: Arial; background:#f4f4f4; padding:20px; }
      .card { background:white; padding:15px; margin:10px; border-radius:8px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
      .running { color:green; }
      .stopped { color:red; }
    </style>
  </head>
  <body>
    <h1>Machine Dashboard</h1>
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
              <p>Status: <b class="\${m.status === "RUNNING" ? "running" : "stopped"}">\${m.status}</b></p>
              <p>Stitches: \${m.stitches}</p>
              <p>Thread Breaks: \${m.threadBreak}</p>
              <p>Last Event: \${m.event}</p>
              <p>Online: \${isOnline ? "YES" : "NO"}</p>
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

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});