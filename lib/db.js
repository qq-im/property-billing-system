'use strict';

const DB_TYPE = (process.env.DB_TYPE || 'mysql').toLowerCase();

if (DB_TYPE === 'sqlite') {
  module.exports = require('./db_sqlite');
} else {
  module.exports = require('./db_mysql');
}
