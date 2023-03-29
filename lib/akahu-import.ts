import knex from 'knex'
import Big from 'big.js'
import type { Transaction as AkahuTransaction } from 'akahu'
import { production } from '../knexfile'
import { Accounts } from './accounts'
import { Transaction, Transactions } from './transactions'
import { Util } from './util'

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

type IncompleteTransaction = Omit<Transaction, 'id'>

function findAccount (accounts: Accounts, transaction: AkahuTransaction): Accounts.Account {
  let account: Accounts.Account | undefined

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

function transformTransaction (accounts: Accounts, transaction: AkahuTransaction): IncompleteTransaction {
  // TODO:
  // transaction.meta.reference
  // transaction.meta.particulars
  // transaction.meta.code
  // transaction.type

  // Look up Akahu Account ID (acc_xxxxx)
  const account = accounts.getByAkahuId(transaction._account)
  if (account === undefined) throw Error(`Akahu account ${transaction._account} not set up`)

  const foundAccount = findAccount(accounts, transaction)

  // Update account from merchant
  if ('merchant' in transaction && foundAccount !== undefined && foundAccount.akahuId === undefined) {
    const name = transaction.merchant.name
    foundAccount.alternateNames.set(Accounts.normalizeName(name), name)
    foundAccount.akahuId = transaction.merchant._id

    accounts.save(foundAccount)
  }

  let source: Accounts.Account, destination: Accounts.Account
  if (transaction.amount < 0) {
    // TODO: Enhance with data from this transaction
    source = account
    destination = foundAccount
  } else {
    // TODO: Enhance with data from this transaction
    source = foundAccount
    destination = account
  }

  const newTrans: IncompleteTransaction = {
    fireflyId: undefined,
    akahuIds: new Set([transaction._id]),
    sourceId: source.id,
    destinationId: destination.id,
    date: new Date(transaction.date),
    amount: Big(transaction.amount).abs(),
    description: transaction.description
  }

  if ('meta' in transaction) {
    // Add foreign currency details if any available
    const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
    if (conversion !== undefined) {
      newTrans.foreignAmount = Big(conversion.amount).abs()
      newTrans.foreignCurrencyCode = conversion.currency
      // TODO: Store fee/rate
    }

    // Strip reference, code and particulars from description
    newTrans.description = newTrans.description.replace(transaction.meta.reference ?? '', '').replace(transaction.meta.code ?? '', '').replace(transaction.meta.particulars ?? '', '').trim()
  }

  // Use personal finance group as category
  if ('category' in transaction) {
    const categoryName = transaction.category.groups?.['personal_finance']?.name
    if (categoryName !== undefined) newTrans.categoryName = categoryName
    // TODO: Store other categories
  }

  return newTrans
}

export async function importTransactions (accounts: Accounts): Promise<Transactions> {
  const db = knex(production)
  const transactionsTable = db<Row<AkahuTransaction>, any>('akahu_transactions')
  const akahuTransactions = await transactionsTable.pluck('data')

  const positive = new Transactions()
  const negative = new Transactions()
  const normalTransactions: IncompleteTransaction[] = []

  akahuTransactions.forEach(akahuTransaction => {
    const transaction = transformTransaction(accounts, akahuTransaction)

    // Detect if this is an internal transfer of funds
    const source = accounts.get(transaction.sourceId)
    const destination = accounts.get(transaction.destinationId)
    if (source?.akahuId?.startsWith('acc_') === true && destination?.akahuId?.startsWith('acc_') === true) {
      if (akahuTransaction.amount < 0) {
        negative.create(transaction)
      } else {
        positive.create(transaction)
      }
    } else {
      normalTransactions.push(transaction)
    }
  })

  // Transfers between our accounts will result in two transactions,
  // one from the source account and one from the destination account.
  // Find these pairs and merge the two transactions together.
  const remainders = positive.merge(negative, _ => true, (a: Transaction, b: Transaction) => {
    // Combine the two descriptions
    a.description = `${a.description} - ${b.description}`
  })

  // Error if there are any unmatched transactions
  const unmatched = [...remainders.left.values(), ...remainders.right.values()]
  if (unmatched.length !== 0) {
    throw Error(`Could not find matching transactions for ${Util.stringify(unmatched)}`)
  }

  // Add normal transactions to positive
  normalTransactions.forEach(transaction => positive.create(transaction))

  return positive
}
