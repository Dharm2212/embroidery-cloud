require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./db");

require("./mqtt");
require("./effi");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================= RECEIVE ESP DATA =================
app.post("/api/data", async (req, res) => {
  try {
    const { deviceId, stitches, threadBreak, status, event } = req.body;

    if (!deviceId)
      return res.status(400).json({ error: "Missing deviceId" });

    let machine = await pool.query(
      "SELECT * FROM machines WHERE machine_uid=$1",
      [deviceId]
    );

    if (machine.rows.length === 0) {
      machine = await pool.query(
        `INSERT INTO machines
        (machine_uid, status, total_stitches, last_seen, target_stitches_10min)
        VALUES ($1,$2,$3,NOW(),1000)
        RETURNING *`,
        [deviceId, status || "OFF", stitches || 0]
      );
    } else {
      await pool.query(
        `UPDATE machines
         SET status=$1,
             total_stitches=$2,
             last_seen=NOW()
         WHERE machine_uid=$3`,
        [status || "OFF", stitches || 0, deviceId]
      );
    }

    const machineId = machine.rows[0].id;

    await pool.query(
      `INSERT INTO machine_events
      (machine_id, stitch_count, thread_break, is_running, event_type, event_time)
      VALUES ($1,$2,$3,$4,$5,NOW())`,
      [
        machineId,
        stitches || 0,
        threadBreak || 0,
        status === "RUNNING",
        event || "heartbeat"
      ]
    );

    res.json({ status: "stored" });

  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ================= DASHBOARD =================
app.get("/", async (req, res) => {
  try {
    const machines = await pool.query(
      "SELECT * FROM machines ORDER BY last_seen DESC"
    );

    const events = await pool.query(
      `SELECT me.*, m.machine_uid
       FROM machine_events me
       JOIN machines m ON me.machine_id=m.id
       ORDER BY event_time DESC
       LIMIT 30`
    );

    let html = `
    <html>
    <head>
      <title>Embroidery Monitoring</title>
      <meta http-equiv="refresh" content="10">
      <style>
        body { font-family:Arial; background:#f4f4f4; padding:20px; }
        .card { background:white; padding:15px; margin:10px; border-radius:8px; }
        .running { color:green; font-weight:bold; }
        .off { color:red; font-weight:bold; }
        table { width:100%; border-collapse: collapse; margin-top:20px; }
        th,td { border:1px solid #ccc; padding:8px; }
      </style>
    </head>
    <body>
    <h1>🧵 Embroidery Dashboard</h1>
    `;

    machines.rows.forEach(m => {
      const online =
        (Date.now() - new Date(m.last_seen)) < 60000;

      html += `
      <div class="card">
        <h2>${m.machine_uid}</h2>
        <p>Status: <span class="${m.status === "RUNNING" ? "running" : "off"}">${m.status}</span></p>
        <p>Total Stitches: ${m.total_stitches}</p>
        <p>Online: ${online ? "YES" : "NO"}</p>
      </div>
      `;
    });

    html += `
    <h2>Recent Events</h2>
    <table>
      <tr>
        <th>Machine</th>
        <th>Stitches</th>
        <th>ThreadBreak</th>
        <th>Event</th>
        <th>Time</th>
      </tr>
    `;

    events.rows.forEach(e => {
      html += `
      <tr>
        <td>${e.machine_uid}</td>
        <td>${e.stitch_count}</td>
        <td>${e.thread_break}</td>
        <td>${e.event_type}</td>
        <td>${new Date(e.event_time).toLocaleString()}</td>
      </tr>
      `;
    });

    html += `</table></body></html>`;

    res.send(html);

  } catch (err) {
    res.status(500).send("Dashboard Error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});