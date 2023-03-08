import * as firefly from 'firefly-iii-sdk-typescript'
import { TransactionTypeProperty } from 'firefly-iii-sdk-typescript'
import type { Transaction, Transactions } from './transactions'
import { Account, Accounts, AccountType } from './accounts'
import { AKAHU_ID_REGEX, ALT_NAMES_REGEX } from './firefly'

const transactionMapping = {
  [AccountType.Asset]: {
    [AccountType.Asset]: TransactionTypeProperty.Transfer,
    [AccountType.Liability]: TransactionTypeProperty.Withdrawal,
    [AccountType.Expense]: TransactionTypeProperty.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Liability]: {
    [AccountType.Asset]: TransactionTypeProperty.Deposit,
    [AccountType.Liability]: TransactionTypeProperty.Transfer,
    [AccountType.Expense]: TransactionTypeProperty.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Expense]: {
    [AccountType.Asset]: undefined,
    [AccountType.Liability]: undefined,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Revenue]: {
    [AccountType.Asset]: TransactionTypeProperty.Deposit,
    [AccountType.Liability]: TransactionTypeProperty.Deposit,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  }
}

interface UpdateAccount {
  name: string
  account_number: string
  notes?: string
}

interface UpdateTransaction {
  type: TransactionTypeProperty
  external_id: string
  description: string
  date: string
  amount: string
  source_id: string
  destination_id: string
  foreign_amount?: string
  foreign_currency_code?: string
  category_name?: string
}

function updateNotes (notes: string | undefined, akahuId: string | undefined, otherNames: string[]): string {
  // Remove existing Akahu ID / Alternate names from notes
  notes = (notes ?? '').replace(AKAHU_ID_REGEX, '').replace(ALT_NAMES_REGEX, '').trim()

  // Add Akahu ID to bottom of notes
  if (akahuId !== undefined) {
    notes = `${notes}\n\n**Akahu ID** \`${akahuId}\``
  }

  // Add other names to bottom of list
  if (otherNames.length > 0) {
    const list = otherNames.map(name => `- \`${name.replaceAll('`', "'")}\``).join('\n')
    notes = `${notes}\n\n**Alternate names**\n${list}`
  }

  return notes.trim()
}

export async function exportAccounts (basePath: string, apiKey: string, current: Accounts, modified: Accounts): Promise<void> {
  const config = new firefly.Configuration({
    apiKey,
    basePath,
    baseOptions: {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  })
  const factory = firefly.AccountsApiFactory(config)

  // Process each Firefly account
  for (const pair of modified.changes(current)) {
    const changes = pair[1]
    const account = modified.get(changes.id)
    if (account === undefined) throw Error('Changes returned an invalid account ID - impossible')

    // Remove primary name from alternateNames
    const altNames = new Map(account.alternateNames)
    altNames.delete(Accounts.normalizeName(account.name))
    const otherNames = [...altNames.values()]

    // Construct update request body
    const update: UpdateAccount = {
      name: account.name,
      account_number: [...account.bankNumbers].sort().join(',')
    }

    // Update or create accounts
    try {
      // Process source
      if (account.source !== undefined) {
        update.notes = updateNotes(account.source.notes, account.akahuId, otherNames)

        if (account.source.fireflyId !== undefined) {
          console.log(`Updating account ${account.source.fireflyId}`, changes)
          await factory.updateAccount(account.source.fireflyId.toString(), update)
        } else {
          console.log('Creating account', changes)
          await factory.storeAccount({ ...update, type: account.source.type })
        }
      }

      // Process destination (if different from source)
      if (account.destination !== undefined && account.source?.fireflyId !== account.destination.fireflyId) {
        update.notes = updateNotes(account.destination.notes, account.akahuId, otherNames)

        if (account.destination.fireflyId !== undefined) {
          console.log(`Updating account ${account.destination.fireflyId}`, changes)
          await factory.updateAccount(account.destination.fireflyId.toString(), update)
        } else {
          console.log('Creating account', changes)
          await factory.storeAccount({ ...update, type: account.destination.type })
        }
      }
    } catch (e: any) {
      console.error(account, e?.response?.data)
    }
  }
}

function transformTransaction (transaction: Transaction, accounts: Accounts): UpdateTransaction {
  const source = accounts.get(transaction.sourceId)?.source
  if (source?.fireflyId === undefined) throw Error('Source account not set')

  const destination = accounts.get(transaction.destinationId)?.destination
  if (destination?.fireflyId === undefined) throw Error('Destination account not set')

  const type = transactionMapping[source.type][destination.type]
  if (type === undefined) throw Error(`Invalid transaction type ${source.type} -> ${destination.type}`)

  // Construct update request body
  const update: UpdateTransaction = {
    type,
    external_id: [...transaction.akahuIds].sort().join(','),
    description: transaction.description,
    date: transaction.date.toISOString(),
    amount: transaction.amount.toString(),
    source_id: source.fireflyId.toString(),
    destination_id: destination.fireflyId.toString()
  }

  // Set optional fields
  if (transaction.foreignAmount !== undefined) update.foreign_amount = transaction.foreignAmount.toString()
  if (transaction.foreignCurrencyCode !== undefined) update.foreign_currency_code = transaction.foreignCurrencyCode
  if (transaction.categoryName !== undefined) update.category_name = transaction.categoryName

  return update
}

export async function exportTransactions (basePath: string, apiKey: string, current: Transactions, modified: Transactions, currentAccounts: Accounts, modifiedAccounts: Accounts): Promise<void> {
  const config = new firefly.Configuration({
    apiKey,
    basePath,
    baseOptions: {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  })
  const factory = firefly.TransactionsApiFactory(config)

  // Create source / destination accounts as necessary
  for (const transaction of modified) {
    const source = modifiedAccounts.get(transaction.sourceId)
    if (source === undefined) throw Error(`Invalid account ID ${transaction.sourceId}`)

    if (source.source === undefined) {
      source.source = {
        type: AccountType.Revenue
      }
      modifiedAccounts.save(source)
    }

    const destination = modifiedAccounts.get(transaction.destinationId)
    if (destination === undefined) throw Error(`Invalid account ID ${transaction.destinationId}`)

    if (destination.destination === undefined) {
      destination.destination = {
        type: AccountType.Expense
      }
      modifiedAccounts.save(destination)
    }
  }

  await exportAccounts(basePath, apiKey, currentAccounts, modifiedAccounts)

  // Process each Firefly transaction
  for (const transaction of modified) {
    const update = transformTransaction(transaction, modifiedAccounts)

    // Check if transaction has been modified
    const oldTransaction = current.get(transaction.id)
    if (oldTransaction !== undefined) {
      const otherUpdate = transformTransaction(oldTransaction, modifiedAccounts)
      if (JSON.stringify(update) === JSON.stringify(otherUpdate)) continue
    }

    const request = {
      apply_rules: true,
      fire_webhooks: true,
      transactions: [update]
    }

    // Update or create transaction
    try {
      if (transaction.fireflyId !== undefined) {
        console.log(`Updating transaction ${transaction.fireflyId}`, update)
        await factory.updateTransaction(transaction.fireflyId.toString(), request)
      } else {
        console.log('Creating transaction', update)
        await factory.storeTransaction(request)
      }
    } catch (e: any) {
      console.error(request, e?.response?.data)
    }
  }
}
