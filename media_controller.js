// ═══════════════════════════════════════════════════════════════
//  GRACE CHURCH MEDIA — Database Config
//  Uses: defaultdb on Aiven MySQL
//  Port: read from DB_PORT env var (Aiven uses non-standard port)
// ═══════════════════════════════════════════════════════════════
const mysql  = require('mysql2');
const logger = require('../utils/logger');

const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || 'defaultdb';  // ← uses defaultdb

logger.startup(`DB config → host:${DB_HOST} port:${DB_PORT} db:${DB_NAME} user:${DB_USER}`);

const pool = mysql.createPool({
  host:               DB_HOST,
  port:               DB_PORT,
  user:               DB_USER,
  password:           DB_PASS,
  database:           DB_NAME,

  // Aiven requires SSL — rejectUnauthorized:false works with free tier
  ssl: {
    rejectUnauthorized: false,
  },

  // Pool settings
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:            'utf8mb4',

  // Keep connection alive on Render (free tier sleeps)
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

// Log every time a connection is acquired from the pool
pool.on('acquire', (connection) => {
  logger.db('ACQUIRE', 'pool', `connection id:${connection.threadId}`);
});

// Log every time a connection is released back to pool
pool.on('release', (connection) => {
  logger.db('RELEASE', 'pool', `connection id:${connection.threadId}`);
});

// Log pool errors
pool.on('error', (err) => {
  logger.error('Pool error', err.message);
});

module.exports = pool;
