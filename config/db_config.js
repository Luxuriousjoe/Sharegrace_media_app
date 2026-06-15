const { Pool } = require('pg');
const { URL } = require('url');
const logger = require('../utils/logger');

const DATABASE_URL = process.env.DATABASE_URL;
const DB_HOST = process.env.DB_HOST;
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SSL = String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';

let databaseUrlSummary = 'not-set';
if (DATABASE_URL) {
  try {
    const parsedUrl = new URL(DATABASE_URL);
    databaseUrlSummary =
      `${parsedUrl.hostname}:${parsedUrl.port || '5432'}${parsedUrl.pathname}`;
  } catch (_) {
    databaseUrlSummary = 'invalid';
  }
}

logger.startup(
  `DB config -> host:${DB_HOST} port:${DB_PORT} db:${DB_NAME} user:${DB_USER} ssl:${DB_SSL} database_url:${databaseUrlSummary}`,
);

const basePoolConfig = {
  ssl: DB_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
};

const pool = new Pool(
  DATABASE_URL
    ? {
        ...basePoolConfig,
        connectionString: DATABASE_URL,
      }
    : {
        ...basePoolConfig,
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASS,
        database: DB_NAME,
      }
);

pool.on('connect', (client) => {
  logger.db('CONNECT', 'pool', `connection pid:${client.processID}`);
});

pool.on('error', (error) => {
  logger.error(`PostgreSQL pool error: ${error.message}`);
});

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function buildShowTablesQuery(params) {
  return {
    text: `
      SELECT table_name AS "Tables_in_public"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE $1
    `,
    values: params,
  };
}

function buildShowColumnsQuery(sql, params) {
  const likeFromParam = params.length > 0 ? params[0] : null;
  const inlineMatch = sql.match(
    /SHOW\s+COLUMNS\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+LIKE\s+'([^']+)')?/i,
  );

  if (!inlineMatch) {
    throw new Error(`Unsupported SHOW COLUMNS syntax: ${sql}`);
  }

  const tableName = inlineMatch[1];
  const likePattern = likeFromParam || inlineMatch[2] || null;

  const values = [tableName];
  const conditions = [
    `table_schema = 'public'`,
    `table_name = $1`,
  ];

  if (likePattern) {
    values.push(likePattern);
    conditions.push(`column_name LIKE $${values.length}`);
  }

  return {
    text: `
      SELECT
        column_name AS "Field",
        data_type AS "Type",
        is_nullable AS "Null",
        column_default AS "Default"
      FROM information_schema.columns
      WHERE ${conditions.join(' AND ')}
      ORDER BY ordinal_position
    `,
    values,
  };
}

function expandBulkInsert(sql, params) {
  if (!/VALUES\s+\?/i.test(sql)) {
    return null;
  }

  const nestedRows = params[0];
  if (!Array.isArray(nestedRows) || !nestedRows.length) {
    throw new Error('Bulk insert expected a non-empty nested array.');
  }

  const values = [];
  let placeholderIndex = 1;
  const tuples = nestedRows.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error('Bulk insert rows must be arrays.');
    }

    const tuple = row.map((value) => {
      values.push(value);
      return `$${placeholderIndex++}`;
    });

    return `(${tuple.join(', ')})`;
  });

  return {
    text: sql.replace(/VALUES\s+\?/i, `VALUES ${tuples.join(', ')}`),
    values,
  };
}

function normalizeSql(sql) {
  return sql
    .replace(/`/g, '')
    .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE');
}

function prepareQuery(sql, params = []) {
  const normalizedSql = normalizeSql(sql);

  if (/SHOW\s+TABLES\s+LIKE\s+\?/i.test(normalizedSql)) {
    return buildShowTablesQuery(params);
  }

  if (/SHOW\s+COLUMNS\s+FROM\s+/i.test(normalizedSql)) {
    return buildShowColumnsQuery(normalizedSql, params);
  }

  const bulkInsert = expandBulkInsert(normalizedSql, params);
  if (bulkInsert) {
    return bulkInsert;
  }

  const isInsert = /^\s*INSERT\s+/i.test(normalizedSql);
  const hasReturning = /\bRETURNING\b/i.test(normalizedSql);
  const text = isInsert && !hasReturning
    ? `${convertPlaceholders(normalizedSql)} RETURNING id`
    : convertPlaceholders(normalizedSql);

  return {
    text,
    values: params,
  };
}

function wrapResult(result) {
  if (result.command === 'SELECT') {
    return [result.rows];
  }

  if (result.command === 'INSERT') {
    const firstRow = result.rows[0] || {};
    return [
      {
        insertId: firstRow.id ?? null,
        affectedRows: result.rowCount,
        rows: result.rows,
      },
    ];
  }

  return [
    {
      affectedRows: result.rowCount,
      rows: result.rows,
    },
  ];
}

async function query(sql, params = []) {
  const prepared = prepareQuery(sql, params);
  const result = await pool.query(prepared.text, prepared.values);
  return wrapResult(result);
}

function promise() {
  return { query };
}

function getConnection(callback) {
  pool
    .connect()
    .then((client) => {
      callback(null, {
        threadId: client.processID,
        processID: client.processID,
        release: () => client.release(),
      });
    })
    .catch((error) => callback(error));
}

module.exports = {
  promise,
  query,
  getConnection,
  end: () => pool.end(),
  rawPool: pool,
};
