const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let machineData = {
    stitches: 0,
    rpm: 0,
    threadBreak: 0
};

// Receive ESP32 data
app.post('/api/data', (req, res) => {
    machineData = req.body;
    console.log("Received:", machineData);
    res.json({ status: "ok" });
});

// Provide data to webpage
app.get('/api/data', (req, res) => {
    res.json(machineData);
});

// Simple webpage
app.get('/', (req, res) => {
    res.send(`
        <h1>Embroidery Monitor</h1>
        <h2 id="stitches"></h2>
        <h2 id="rpm"></h2>
        <h2 id="thread"></h2>

        <script>
            setInterval(async () => {
                const res = await fetch('/api/data');
                const data = await res.json();
                document.getElementById('stitches').innerText = "Stitches: " + data.stitches;
                document.getElementById('rpm').innerText = "RPM: " + data.rpm;
                document.getElementById('thread').innerText = "Thread Breaks: " + data.threadBreak;
            }, 1000);
        </script>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Server running...");
});