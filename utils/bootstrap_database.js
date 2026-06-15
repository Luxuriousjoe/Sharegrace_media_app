const fs = require('fs/promises');
const path = require('path');

const db = require('../config/db_config');
const logger = require('./logger');

const schemaPath = path.join(__dirname, '..', 'schema_defaultdb.sql');

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const nextTwoChars = sql.slice(index, index + 2);

    if (nextTwoChars === '$$') {
      inDollarQuote = !inDollarQuote;
      current += nextTwoChars;
      index += 1;
      continue;
    }

    if (char === ';' && !inDollarQuote) {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    statements.push(trailing);
  }

  return statements;
}

async function bootstrapDatabase() {
  logger.startup(`DB bootstrap -> loading schema from ${schemaPath}`);

  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const statements = splitSqlStatements(schemaSql);

  for (const statement of statements) {
    await db.rawPool.query(statement);
  }

  logger.startup(`DB bootstrap -> schema ready (${statements.length} statements)`);
}

if (require.main === module) {
  bootstrapDatabase()
    .then(async () => {
      await db.end();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`DB bootstrap failed: ${error.message}`);
      await db.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = {
  bootstrapDatabase,
};
