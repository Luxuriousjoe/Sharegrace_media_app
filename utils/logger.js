// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Logger
//  Every log line prints to stdout so Render.com shows it live
// ═══════════════════════════════════════════════════════════════

const timestamp = () => new Date().toISOString();

// Render reads stdout — console.log goes straight to Render logs
const logger = {

  info: (msg, ...args) => {
    const extra = args.length ? ' ' + args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    console.log(`[${timestamp()}] ✅ INFO  | ${msg}${extra}`);
  },

  warn: (msg, ...args) => {
    const extra = args.length ? ' ' + args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    console.warn(`[${timestamp()}] ⚠️  WARN  | ${msg}${extra}`);
  },

  error: (msg, ...args) => {
    const extra = args.length ? ' ' + args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    console.error(`[${timestamp()}] ❌ ERROR | ${msg}${extra}`);
  },

  // Used for every API request — shows in Render logs
  request: (method, url, status, ms, user) => {
    const who = user ? `user:${user}` : 'guest';
    const icon = status < 300 ? '→' : status < 400 ? '↪' : '✗';
    console.log(`[${timestamp()}] ${icon} REQUEST | ${method.padEnd(6)} ${url.padEnd(40)} ${status} | ${ms}ms | ${who}`);
  },

  // Used when someone logs in / logs out
  auth: (action, email, role, ip) => {
    console.log(`[${timestamp()}] 🔐 AUTH   | ${action.padEnd(12)} | ${email} | role:${role} | ip:${ip}`);
  },

  // Used when DB queries run
  db: (action, table, detail) => {
    console.log(`[${timestamp()}] 🗄  DB     | ${action.padEnd(10)} | ${table.padEnd(20)} | ${detail}`);
  },

  // Used for media uploads
  media: (action, type, id, detail) => {
    console.log(`[${timestamp()}] 📤 MEDIA  | ${action.padEnd(10)} | ${type} #${id} | ${detail}`);
  },

  // Startup banner
  startup: (msg) => {
    console.log(`[${timestamp()}] 🚀 START  | ${msg}`);
  },
};

module.exports = logger;
