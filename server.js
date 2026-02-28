require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// ===== DATABASE CONNECTION =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("PostgreSQL Connected"))
  .catch(err => console.error("DB Connection Error:", err));

// ================= API: RECEIVE DATA =================
app.post("/api/data", async (req, res) => {
  try {
    const { deviceId, stitches, threadBreak, status, event } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    // Check if machine exists
    let machine = await pool.query(
      "SELECT * FROM machines WHERE machine_uid=$1",
      [deviceId]
    );

    let machineId;

    if (machine.rows.length === 0) {
      // Create new machine
      const result = await pool.query(
        `INSERT INTO machines
         (machine_uid, status, total_stitches, thread_break_count)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [deviceId, status || "OFF", stitches || 0, threadBreak || 0]
      );
      machineId = result.rows[0].id;
    } else {
      machineId = machine.rows[0].id;

      // Update machine
      await pool.query(
        `UPDATE machines
         SET status=$1,
             total_stitches=$2,
             thread_break_count=$3,
             last_seen=NOW()
         WHERE machine_uid=$4`,
        [status || "OFF", stitches || 0, threadBreak || 0, deviceId]
      );
    }

    // Insert event
    await pool.query(
      `INSERT INTO machine_events
       (machine_id, stitch_count, thread_break, status, event_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        machineId,
        stitches || 0,
        threadBreak || 0,
        status || "OFF",
        event || "heartbeat"
      ]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ================= DASHBOARD =================
app.get("/", async (req, res) => {
  try {
    const machines = await pool.query(
      "SELECT * FROM machines ORDER BY last_seen DESC"
    );

    let html = `
    <html>
    <head>
      <title>Embroidery Dashboard</title>
      <meta http-equiv="refresh" content="10">
      <style>
        body { font-family:Arial; background:#f4f4f4; padding:20px; }
        .card { background:white; padding:15px; margin:10px; border-radius:8px; }
        .running { color:green; font-weight:bold; }
        .off { color:red; font-weight:bold; }
      </style>
    </head>
    <body>
    <h1>🧵 Embroidery Dashboard</h1>
    `;

    machines.rows.forEach(m => {
      html += `
      <div class="card">
        <h2>${m.machine_uid}</h2>
        <p>Status:
          <span class="${m.status === "RUNNING" ? "running" : "off"}">
            ${m.status}
          </span>
        </p>
        <p>Total Stitches: ${m.total_stitches}</p>
        <p>Thread Break Count: ${m.thread_break_count}</p>
        <p>Last Seen: ${new Date(m.last_seen).toLocaleString()}</p>
      </div>
      `;
    });

    html += `</body></html>`;

    res.send(html);

  } catch (err) {
    console.error("Dashboard Error:", err);
    res.status(500).send("Dashboard Error");
  }
});

// ================= START SERVER =================
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});