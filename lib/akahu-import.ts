import knex from 'knex'
import Big from 'big.js'
import type { Transaction as AkahuTransaction } from 'akahu'
import { production } from '../knexfile'
import { Account, AccountPair, Accounts, AccountType } from './accounts'
import { Transaction, Transactions, TransactionType } from './transactions'

const transactionMapping = {
  [AccountType.Asset]: {
    [AccountType.Asset]: TransactionType.Transfer,
    [AccountType.Liability]: TransactionType.Withdrawal,
    [AccountType.Expense]: TransactionType.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Liability]: {
    [AccountType.Asset]: TransactionType.Deposit,
    [AccountType.Liability]: TransactionType.Transfer,
    [AccountType.Expense]: TransactionType.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Expense]: {
    [AccountType.Asset]: undefined,
    [AccountType.Liability]: undefined,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Revenue]: {
    [AccountType.Asset]: TransactionType.Deposit,
    [AccountType.Liability]: TransactionType.Deposit,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  }
}

interface CurrencyConversion {
  currency: string
  amount: number
  rate: number
  fee?: number
}

interface Row<T> {
  id: string
  data: T
}

function findAccountPair (accounts: Accounts, transaction: AkahuTransaction): AccountPair {
  let account: AccountPair | undefined

  // Interest is a special case - match any account that contains the word interest
  if (transaction.description.toLowerCase().includes('interest')) {
    account ??= accounts.getByName('Interest')
  }

  // Match account using the Akahu merchant ID
  if ('merchant' in transaction) {
    account ??= accounts.getByAkahuId(transaction.merchant._id)
  }

  // Match account using the bank account number
  if ('meta' in transaction) {
    account ??= accounts.getByBankNumber(transaction.meta.other_account ?? '')
  }

  // If all else fails match account using fuzzy name matching
  // Match the description with and without the reference - pick the best result
  if (account === undefined) {
    let name = transaction.description
    let match = accounts.getByNameFuzzy(name)
    if ('meta' in transaction) {
      name = name.replace(transaction.meta.reference ?? '', '')
      const newMatch = accounts.getByNameFuzzy(name)
      if (newMatch[1] > match[1]) match = newMatch
    }
    account ??= match[0]
  }

  return account
}

export async function importTransactions (accounts: Accounts, transactions: Transactions): Promise<void> {
  const db = knex(production)
  const transactionsTable = db<Row<AkahuTransaction>, any>('akahu_transactions')
  const akahuTransactions = await transactionsTable.pluck('data')

  akahuTransactions.forEach(transaction => {
    // TODO:
    // transaction.meta.reference
    // transaction.meta.particulars
    // transaction.meta.code
    // transaction.type

    // Look up Akahu Account ID (acc_xxxxx)
    const pair = accounts.getByAkahuId(transaction._account)
    if (pair === undefined) throw Error(`Akahu account ${transaction._account} not set up in Firefly`)
    const account = pair.source ?? pair.destination
    if (account === undefined) throw Error('Found invalid AccountPair')
    if (account.type !== AccountType.Asset && account.type !== AccountType.Liability) throw Error(`User's account ${transaction._account} not configured as an asset or liability`)

    const findAccount = findAccountPair(accounts, transaction)

    let source: Account, destination: Account
    if (transaction.amount < 0) {
      if (findAccount.destination === undefined) {
        const other = findAccount.source
        if (other === undefined) throw Error('Found invalid AccountPair')

        // TODO: Enhance with data from this transaction
        destination = accounts.create({
          fireflyId: other.fireflyId,
          akahuId: other.akahuId,
          name: other.name,
          type: AccountType.Expense,
          bankNumbers: other.bankNumbers,
          alternateNames: other.alternateNames
        })
      } else {
        destination = findAccount.destination
      }

      source = account
    } else {
      if (findAccount.source === undefined) {
        const other = findAccount.destination
        if (other === undefined) throw Error('Found invalid AccountPair')

        // TODO: Enhance with data from this transaction
        source = accounts.create({
          fireflyId: other.fireflyId,
          akahuId: other.akahuId,
          name: other.name,
          type: AccountType.Revenue,
          bankNumbers: other.bankNumbers,
          alternateNames: other.alternateNames
        })
      } else {
        source = findAccount.source
      }

      destination = account
    }

    const type = transactionMapping[source.type][destination.type]
    if (type === undefined) throw Error(`Invalid transaction type ${source.type} -> ${destination.type}`)

    const fireflyTrans: Omit<Transaction, 'id'> = {
      fireflyId: undefined,
      akahuIds: new Set([transaction._id]),
      type,
      source,
      destination,
      date: new Date(transaction.date),
      amount: Big(transaction.amount).abs(),
      description: transaction.description
    }

    // Add foreign currency details if any available
    if ('meta' in transaction) {
      const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
      if (conversion !== undefined) {
        fireflyTrans.foreignAmount = Big(conversion.amount).abs()
        fireflyTrans.foreignCurrencyCode = conversion.currency
        // TODO: Store fee/rate
      }
    }

    // Use personal finance group as category
    if ('category' in transaction) {
      const categoryName = transaction.category.groups?.['personal_finance']?.name
      if (categoryName !== undefined) fireflyTrans.categoryName = categoryName
      // TODO: Store other categories
    }

    transactions.create(fireflyTrans)
  })
}
