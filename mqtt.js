const mqtt = require("mqtt");
const pool = require("./db");

const client = mqtt.connect(process.env.MQTT_BROKER);

client.on("connect", () => {
  console.log("MQTT Connected");
  client.subscribe("machines/+/data");
});

client.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    await pool.query(
      `UPDATE machines
       SET total_stitches=$1,
           status=$2,
           last_seen=NOW()
       WHERE machine_uid=$3`,
      [data.stitches, data.status, data.deviceId]
    );
  } catch (err) {
    console.error("MQTT Error:", err);
  }
});