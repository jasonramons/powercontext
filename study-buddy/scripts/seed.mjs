/** Load data/seed.json into a running study-buddy instance. */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8788';

const response = await fetch(`${BASE}/api/seed`, { method: 'POST' });
const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exit(1);
