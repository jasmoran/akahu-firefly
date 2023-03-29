import knex from 'knex'
import type { Knex } from 'knex'
import { production } from './knexfile'
import { AkahuClient } from 'akahu'
import type { Account, Transaction, TransactionQueryParams } from 'akahu'

import { Firefly } from './lib/firefly'
import * as akahuImport from './lib/akahu-import'
import type { Transaction as Trans } from './lib/transactions'

interface Row<T> {
  id: string
  data: T
}

// Get Akahu accounts and update the DB cache
async function updateAkahuAccounts (
  accountsTable: Knex.QueryInterface<Row<Account>>,
  akahu: AkahuClient,
  userToken: string
): Promise<void> {
  const accounts = await akahu.accounts.list(userToken)
  const cacheAccounts = accounts.map(account => ({ id: account._id, data: account }))
  await accountsTable.insert(cacheAccounts).onConflict('id').merge()
}

// Get Akahu transactions and update the DB cache
async function updateAkahuTransactions (
  accountsTable: Knex.QueryInterface<Row<Transaction>>,
  akahu: AkahuClient,
  userToken: string
): Promise<void> {
  const query: TransactionQueryParams = {}

  do {
    const transactions = await akahu.transactions.list(userToken, query)
    const cacheAccounts = transactions.items.map(transaction => ({ id: transaction._id, data: transaction }))
    await accountsTable.insert(cacheAccounts).onConflict('id').merge()
    query.cursor = transactions.cursor.next
  } while (query.cursor !== null)
}

async function main (): Promise<void> {
  console.log('Starting')

  const db = knex(production)
  const accountsTable = db<Row<Account>, any>('akahu_accounts')
  const transactionsTable = db<Row<Transaction>, any>('akahu_transactions')

  // Initialise Akahu client
  const appToken = process.env['AKAHU_APP_TOKEN']
  if (appToken === undefined) throw new Error('$AKAHU_APP_TOKEN is not set')
  const akahu = new AkahuClient({ appToken })

  // Get Akahu user token
  const userToken = process.env['AKAHU_USER_TOKEN']
  if (userToken === undefined) throw new Error('$AKAHU_USER_TOKEN is not set')

  if (process.env['LOAD_AKAHU_DATA'] === 'true') {
    await updateAkahuAccounts(accountsTable, akahu, userToken)
    await updateAkahuTransactions(transactionsTable, akahu, userToken)
  }

  console.log('Importing Firefly accounts and transactions')
  const firefly = new Firefly()
  firefly.import()

  console.log('Importing Akahu transactions')
  const akahuTransactions = await akahuImport.importTransactions(firefly.accounts)

  console.log('Merging transactions')
  firefly.transactions.merge(akahuTransactions, (a, b) => {
    // Check Akahu IDs match
    if (a.akahuIds.size === 0 || b.akahuIds.size === 0) return true
    return [...a.akahuIds].sort().join(',') === [...b.akahuIds].sort().join(',')
  }, (a: Trans, b: Trans) => {
    // Combine the two descriptions
    a.description = b.description
  })

  const basePath = process.env['FIREFLY_BASE_PATH']
  if (basePath === undefined) throw new Error('$FIREFLY_BASE_PATH is not set')

  const apiKey = process.env['FIREFLY_API_KEY']
  if (apiKey === undefined) throw new Error('$FIREFLY_API_KEY is not set')

  const dryRun = process.env['DRY_RUN'] === 'true'

  console.log('Exporting transactions to Firefly')
  await firefly.export(basePath, apiKey, dryRun)

  console.log('Finished')
}

void main().then(() => setTimeout(() => {
  process.exit()
}, 10))
