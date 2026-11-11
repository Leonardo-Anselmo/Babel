// Fake bot for the app's end-to-end test: talks to the app like src/app-link.js.
import fs from 'node:fs';
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`${stamp()} INFO  [bot] ${m}`);
const received = [];
let chattiness = 'low';
// Auto-join as saved for the server (memory.json), like the real bot reads it.
let autoJoin = (() => {
  try {
    const g = Object.values(JSON.parse(fs.readFileSync('data/memory.json', 'utf8')).guilds)[0];
    return typeof g.autoJoin === 'boolean' ? g.autoJoin : false;
  } catch {
    return false;
  }
})();
// The test makes the call end by creating data/no-call.
const calls = () => (fs.existsSync('data/no-call') ? [] : [{ server: 'The Pressure Chamber', channel: 'Gaming', people: ['Daniel', 'Weevil', 'Mike'], since: Date.now() - 754000 }]);
const status = () => ({
  type: 'status', ready: true, user: 'Winslow#2921',
  servers: [{ name: 'The Pressure Chamber', chattiness, autoJoin }],
  calls: calls(),
  hearing: { provider: 'whisper', detail: 'Whisper large-v3-turbo on your graphics card' },
});
process.on('message', (m) => {
  received.push(m);
  fs.writeFileSync('data/received.json', JSON.stringify(received));
  // Leaving voice and saving takes a moment, like the real bot.
  if (m.type === 'shutdown') { log('stop request from the app received, leaving voice and shutting down'); setTimeout(() => process.exit(0), 800); }
  if (m.type === 'set-chattiness') { chattiness = m.level; log(`chattiness set to ${m.level} from the app`); process.send(status()); }
  if (m.type === 'set-auto-join') { autoJoin = m.on; log(`auto-join turned ${m.on ? 'on' : 'off'} from the app`); process.send(status()); }
  // Forgetting a saved call: the real bot changes memory.json itself (it holds it while running).
  if (m.type === 'forget-call') {
    const data = JSON.parse(fs.readFileSync('data/memory.json', 'utf8'));
    let count = 0;
    let jokes = 0;
    for (const g of Object.values(data.guilds)) {
      const before = (g.calls || []).length;
      g.calls = (g.calls || []).filter((c) => m.id && c.id !== m.id);
      count += before - g.calls.length;
      if (!m.id) {
        jokes += (g.landed || []).length;
        g.landed = [];
      }
    }
    fs.writeFileSync('data/memory.json', JSON.stringify(data, null, 2));
    log(`forgot ${count} saved call(s) and ${jokes} kept joke(s) (from the app)`);
    process.send({ type: 'forgot-calls', requestId: m.requestId, count, jokes });
  }
});
process.on('disconnect', () => process.exit(0));
// The test ends him with SIGTERM to stand in for a crash: he says why, like src/app.js does.
process.on('SIGTERM', () => {
  console.error(`${stamp()} ERROR [bot] unexpected error: TypeError: boom (at src/session.js:212). Details are in data/bot.log (Logs > Activity in the app).`);
  console.error('Node.js v22.22.0');
  setTimeout(() => process.exit(1), 50);
});
log('starting up');
console.error(`${stamp()} WARN  [whisper] local Whisper is running an older version; restarting it`);
setTimeout(() => {
  log('logged in as Winslow#2921. Answers to: winslow');
  process.send(status());
  // The owner said "look at this": ask the app for a picture of the screen.
  process.send({ type: 'screenshot-request', id: 1 });
}, 700);
setInterval(() => process.send(status()), 1000);
