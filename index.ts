import knex from 'knex'
import type { Knex } from 'knex'
import { production } from './knexfile'
import { AkahuClient } from 'akahu'
import type { Account, Transaction, TransactionQueryParams } from 'akahu'

import * as fireflyImport from './lib/firefly-import'
import * as fireflyExport from './lib/firefly-export'
import * as akahuImport from './lib/akahu-import'

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

  console.log('Importing Firefly accounts')
  const accounts = await fireflyImport.importAccounts()
  const originalAccounts = accounts.duplicate()

  console.log('Importing Firefly transactions')
  const transactions = await fireflyImport.importTransactions(accounts)
  const originalTransactions = transactions.duplicate()

  console.log('Importing Akahu transactions')
  const akahuTransactions = await akahuImport.importTransactions(accounts)

  console.log('Merging transactions')
  transactions.merge(akahuTransactions, (a, b) => {
    // Check Akahu IDs match
    return [...a.akahuIds].sort().join(',') === [...b.akahuIds].sort().join(',')
  })

  const basePath = process.env['FIREFLY_BASE_PATH']
  if (basePath === undefined) throw new Error('$FIREFLY_BASE_PATH is not set')

  const apiKey = process.env['FIREFLY_API_KEY']
  if (apiKey === undefined) throw new Error('$FIREFLY_API_KEY is not set')

  console.log('Exporting transactions to Firefly')
  await fireflyExport.exportAccounts(basePath, apiKey, originalAccounts, accounts)

  console.log('Finished')
}

void main().then(() => setTimeout(() => {
  process.exit()
}, 10))
