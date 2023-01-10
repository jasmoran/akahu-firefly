import type { Knex } from 'knex'

const connection = process.env['DATABASE_URL']
if (connection === undefined) {
  throw new Error('$DATABASE_URL is not set')
}

export const production: Knex.Config = {
  client: 'pg',
  connection,
  migrations: {
    tableName: 'knex_migrations',
    extension: 'ts'
  }
}
