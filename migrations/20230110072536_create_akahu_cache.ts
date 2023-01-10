import type { Knex } from 'knex'

export async function up (knex: Knex): Promise<void> {
  await knex.schema.createTable('akahu_accounts', table => {
    table.string('id')
    table.json('data')
    table.primary(['id'])
  })

  await knex.schema.createTable('akahu_transactions', table => {
    table.string('id')
    table.json('data')
    table.primary(['id'])
  })
}

export async function down (knex: Knex): Promise<void> {
  await knex.schema.dropTable('akahu_accounts')
  await knex.schema.dropTable('akahu_transactions')
}
