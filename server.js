require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    await pool.connect();
    console.log("PostgreSQL Connected");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.machines (
        id SERIAL PRIMARY KEY,
        machine_uid VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'OFF',
        total_stitches BIGINT DEFAULT 0,
        alter_stitches BIGINT DEFAULT 0,
        thread_break_count INT DEFAULT 0,
        last_seen TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.machine_events (
        id SERIAL PRIMARY KEY,
        machine_id INT REFERENCES public.machines(id),
        stitch_count BIGINT,
        alter_stitch_count BIGINT,
        thread_break INT,
        status VARCHAR(50),
        event_type VARCHAR(50),
        event_time TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("Tables verified");
  } catch (err) {
    console.error("DB INIT ERROR:", err);
  }
})();

app.post("/api/data", async (req, res) => {
  try {
    const { deviceId, stitches, alterStitches, threadBreak, status, event } = req.body;

    let machine = await pool.query(
      "SELECT * FROM public.machines WHERE machine_uid=$1",
      [deviceId]
    );

    let machineId;

    if (machine.rows.length === 0) {
      const insert = await pool.query(
        `INSERT INTO public.machines
         (machine_uid, status, total_stitches, alter_stitches, thread_break_count)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [deviceId, status, stitches, alterStitches, threadBreak]
      );
      machineId = insert.rows[0].id;
    } else {
      machineId = machine.rows[0].id;

      await pool.query(
        `UPDATE public.machines
         SET status=$1,
             total_stitches=$2,
             alter_stitches=$3,
             thread_break_count=$4,
             last_seen=NOW()
         WHERE machine_uid=$5`,
        [status, stitches, alterStitches, threadBreak, deviceId]
      );
    }

    await pool.query(
      `INSERT INTO public.machine_events
       (machine_id, stitch_count, alter_stitch_count, thread_break, status, event_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [machineId, stitches, alterStitches, threadBreak, status, event]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/", async (req, res) => {
  try {
    const machines = await pool.query(
      "SELECT * FROM public.machines ORDER BY last_seen DESC"
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
        <p>Alter Stitches: ${m.alter_stitches}</p>
        <p>Thread Break Count: ${m.thread_break_count}</p>
        <p>Last Seen: ${new Date(m.last_seen).toLocaleString()}</p>
      </div>
      `;
    });

    html += `</body></html>`;

    res.send(html);
  } catch (err) {
    console.error("Dashboard Error:", err);
    res.send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});