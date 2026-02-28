const cron = require("node-cron");
const pool = require("./db");

cron.schedule("*/10 * * * *", async () => {

  const machines = await pool.query("SELECT * FROM machines");

  for (let machine of machines.rows) {

    const end = new Date();
    const start = new Date(end - 10 * 60000);

    const events = await pool.query(
      `SELECT * FROM machine_events
       WHERE machine_id=$1
       AND event_time BETWEEN $2 AND $3
       ORDER BY event_time`,
      [machine.id, start, end]
    );

    if (events.rows.length < 2) continue;

    const first = events.rows[0];
    const last = events.rows[events.rows.length - 1];

    const stitches = last.stitch_count - first.stitch_count;
    const efficiency =
      (stitches / machine.target_stitches_10min) * 100;

    await pool.query(
      `INSERT INTO machine_efficiency_logs
       (machine_id, window_start, window_end, total_stitches, efficiency)
       VALUES ($1,$2,$3,$4,$5)`,
      [machine.id, start, end, stitches, efficiency]
    );
  }

});