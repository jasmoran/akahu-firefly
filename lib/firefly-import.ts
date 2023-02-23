import * as firefly from './firefly'
import { Accounts, AccountType } from './accounts'
import { Transaction, Transactions, TransactionType } from './transactions'
import Big from 'big.js'

// Map Firefly account types to Asset, Liability, Expense and Revenue
// Ignore type accounts will be discarded
const TypeMapping: { [K in firefly.AccountType]?: AccountType } = {
  [firefly.AccountType.Default]: AccountType.Asset,
  [firefly.AccountType.Cash]: AccountType.Asset,
  [firefly.AccountType.Asset]: AccountType.Asset,
  [firefly.AccountType.Expense]: AccountType.Expense,
  [firefly.AccountType.Revenue]: AccountType.Revenue,
  [firefly.AccountType.Loan]: AccountType.Liability,
  [firefly.AccountType.Debt]: AccountType.Liability,
  [firefly.AccountType.Mortgage]: AccountType.Liability
}

export async function importAccounts (): Promise<Accounts> {
  const fireflyAccounts = await firefly.accounts()
  const accounts = new Accounts()

  // Process each Firefly account
  fireflyAccounts.forEach(fireflyAccount => {
    // Fetch account type
    const accountType = TypeMapping[fireflyAccount.type]
    if (accountType === undefined) return

    // Fetch Akahu ID
    let akahuId
    const externalId = fireflyAccount.external_id ?? fireflyAccount.iban
    if (externalId !== null && /^(acc|merchant)_/.test(externalId)) {
      akahuId = externalId
    }

    // Create Account from Firefly data
    const name = fireflyAccount.name.trim()
    const account = {
      fireflyId: fireflyAccount.id,
      akahuId,
      name,
      type: accountType,
      bankNumbers: new Set<string>(),
      alternateNames: new Set([name])
    }

    // Add bank account numbers
    if (fireflyAccount.account_number !== null) {
      const numbers = fireflyAccount.account_number.split(',')
      numbers.forEach(number => {
        if (/^\d+-\d+-\d+-\d+$/.test(number)) {
          account.bankNumbers.add(Accounts.formatBankNumber(number))
        }
      })
    }

    // Add alternate names
    if (fireflyAccount.notes !== null) {
      fireflyAccount
        .notes
        .match(/\*\*Alternate names\*\*(\n-\s*`[^`]+`)+/g)
        ?.[0]
        ?.split('\n')
        ?.forEach(line => {
          const name = line.match(/`([^`]+)`/)?.[1]
          if (name !== undefined) account.alternateNames.add(name)
        })
    }

    accounts.create(account)
  })

  return accounts
}

export async function importTransactions (accounts: Accounts): Promise<Transactions> {
  const fireflyTransactions = await firefly.transactions()
  const transactions = new Transactions()

  // Process each Firefly transaction
  fireflyTransactions.forEach(fireflyTransaction => {
    // Fetch transaction type
    const transactionType: TransactionType = TransactionType[fireflyTransaction.type as keyof typeof TransactionType]

    // Split comma seperated external IDs into an array
    // Array should be empty if external ID is empty or null
    const externalId = fireflyTransaction.external_id ?? ''
    const externalIds = externalId.length === 0 ? [] : externalId.split(',')
    const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

    const source = accounts.getByFireflyId(fireflyTransaction.source_id)?.source
    const destination = accounts.getByFireflyId(fireflyTransaction.destination_id)?.destination

    // Confirm source and destination account exist
    // This should be enforced by a foreign key in the database
    if (source === undefined || destination === undefined) throw Error("Source or desination account doesn't exist")

    // Create Transaction from Firefly data
    const transaction: Omit<Transaction, 'id'> = {
      type: transactionType,
      fireflyId: fireflyTransaction.id,
      description: fireflyTransaction.description,
      date: fireflyTransaction.date,
      amount: Big(fireflyTransaction.amount),
      source,
      destination,
      akahuIds: new Set(akahuIds)
    }

    // Add optional values
    if (fireflyTransaction.foreign_amount !== null) transaction.foreignAmount = Big(fireflyTransaction.foreign_amount)
    if (fireflyTransaction.foreign_currency_code !== null) transaction.foreignCurrencyCode = fireflyTransaction.foreign_currency_code
    if (fireflyTransaction.category_name !== null) transaction.categoryName = fireflyTransaction.category_name

    transactions.create(transaction)
  })

  return transactions
}
