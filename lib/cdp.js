// 极简 CDP 客户端：连 Node inspector，执行 Runtime.evaluate
const WS_URL = process.argv[2];
const EXPR   = process.argv[3];

const ws = new WebSocket(WS_URL);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  const res = await send('Runtime.evaluate', {
    expression: EXPR,
    includeCommandLineAPI: true,
    returnByValue: true,
    awaitPromise: true,
    timeout: 10000,
  });
  const r = res.result || {};
  if (r.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails, null, 2).slice(0, 1500));
  } else {
    const v = r.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', (e) => { console.log('WS_ERROR:', e.message || e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
