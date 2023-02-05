import type { EnrichedTransaction } from 'akahu'
import * as firefly from './firefly'

interface CurrencyConversion {
  currency: string
  amount: number
  rate: number
  fee?: number
}

enum AccountType {
  Expense = 'expense', Revenue = 'revenue'
}

type AccountPair = Record<AccountType, number | undefined>

interface Transaction extends firefly.Transaction {
  akahuIds: string[]
}

export class ProcessTransactions {
  accountsByBankNumber: Record<string, AccountPair>
  accountsByExternalId: Record<string, AccountPair>

  transactions: Transaction[]
  transactionsByAkahuId: Record<string, Transaction>

  private constructor (
    accountsByBankNumber: Record<string, AccountPair>,
    accountsByExternalId: Record<string, AccountPair>,
    transactions: Transaction[],
    transactionsByAkahuId: Record<string, Transaction>
  ) {
    this.accountsByBankNumber = accountsByBankNumber
    this.accountsByExternalId = accountsByExternalId
    this.transactions = transactions
    this.transactionsByAkahuId = transactionsByAkahuId
  }

  public static async build (): Promise<ProcessTransactions> {
    const [bankAccounts, accountIds, [transactions, transactionsByAkahuId]] = await Promise.all([
      this.processFireflyBankAccounts(),
      this.processFireflyExternalIds(),
      this.processFireflyTransactions()
    ])
    return new ProcessTransactions(bankAccounts, accountIds, transactions, transactionsByAkahuId)
  }

  // Formats a bank account string:
  // 2 digit Bank Number
  // 4 digit Branch Number
  // 7 digit Account Body
  // 3 digit Account Suffix
  private static formatBankNumber (bankAccountNumber: string): string {
    const lengths = [2, 4, 7, 3]
    return bankAccountNumber
      .split('-')
      .map((part, ix) => parseInt(part).toString().padStart(lengths[ix] ?? 0, '0'))
      .join('-')
  }

  private static async processFireflyBankAccounts (): Promise<Record<string, AccountPair>> {
    const accounts = await firefly.accountsWithNumber()
    const grouped: Record<string, AccountPair> = {}

    accounts
      .filter(account => /\d+-\d+-\d+-\d+/.test(account.account_number))
      .forEach(account => {
        const bankAccountNumber = this.formatBankNumber(account.account_number)
        const accountPair: AccountPair = grouped[bankAccountNumber] ?? { expense: undefined, revenue: undefined }

        // Expense account
        if (account.account_type_id === 4) {
          accountPair.expense ??= account.id

        // Revenue account
        } else if (account.account_type_id === 5) {
          accountPair.revenue ??= account.id

        // User owned account (always use these accounts if they exist)
        } else {
          accountPair.expense = account.id
          accountPair.revenue = account.id
        }

        grouped[bankAccountNumber] = accountPair
      })

    return grouped
  }

  private static async processFireflyExternalIds (): Promise<Record<string, AccountPair>> {
    const accounts = await firefly.accountsWithExternalId()
    const grouped: Record<string, AccountPair> = {}

    accounts
      .forEach(account => {
        const accountPair: AccountPair = grouped[account.external_id] ?? { expense: undefined, revenue: undefined }

        // Expense account
        if (account.account_type_id === 4) {
          accountPair.expense ??= account.id

        // Revenue account
        } else if (account.account_type_id === 5) {
          accountPair.revenue ??= account.id

        // User owned account (always use these accounts if they exist)
        } else {
          accountPair.expense = account.id
          accountPair.revenue = account.id
        }

        grouped[account.external_id] = accountPair
      })

    return grouped
  }

  private static async processFireflyTransactions (): Promise<[Transaction[], Record<string, Transaction>]> {
    const transactions = (await firefly.transactions()) as Transaction[]
    const transactionsByAkahuId: Record<string, Transaction> = {}

    // Process each Firefly transaction
    transactions.forEach(transaction => {
      // Split comma seperated external IDs into an array
      // Array should be empty if external ID is empty or null
      const externalId = transaction.external_id ?? ''
      const externalIds = externalId.length === 0 ? [] : externalId.split(',')
      const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

      // Add akahu IDs to the transaction
      transaction.akahuIds = akahuIds

      // Add transaction to transactionsByAkahuId
      akahuIds.forEach(externalId => {
        const existing = transactionsByAkahuId[externalId]
        if (existing === undefined) {
          transactionsByAkahuId[externalId] = transaction
        } else {
          console.error(`External ID ${externalId} duplicated in ${existing.id} and ${transaction.id}`)
        }
      })
    })

    return [transactions, transactionsByAkahuId]
  }

  private lookupAkahuAccountId (akahuAccountId: string): AccountPair {
    return this.accountsByExternalId[akahuAccountId] ?? { expense: undefined, revenue: undefined }
  }

  private lookupBankAccountNumber (bankAccountNumber: string): AccountPair {
    if (!/"\d+-\d+-\d+-\d+"/.test(bankAccountNumber)) return { expense: undefined, revenue: undefined }

    bankAccountNumber = ProcessTransactions.formatBankNumber(bankAccountNumber)

    return this.accountsByBankNumber[bankAccountNumber] ?? { expense: undefined, revenue: undefined }
  }

  public processTransactions (transactions: EnrichedTransaction[]): Transaction[] {
    const processed = transactions.map(transaction => {
      // TODO:
      // transaction.meta.reference
      // transaction.meta.particulars
      // transaction.meta.code
      // transaction.meta.other_account
      // transaction.type
      // transaction.merchant

      // Look up Akahu Account ID (acc_xxxxx)
      const account = this.lookupAkahuAccountId(transaction._account).revenue ?? 0

      let type, sourceId, destinationId
      if (transaction.amount < 0) {
        type = 'Withdrawal'
        sourceId = account
        destinationId = 0 // TODO - expense account
      } else {
        type = 'Deposit'
        sourceId = 0 // TODO - revenue account
        destinationId = account
      }

      const fireflyTrans: Transaction = {
        type,
        source_id: sourceId,
        destination_id: destinationId,
        date: new Date(transaction.date),
        amount: Math.abs(transaction.amount).toString(),
        description: transaction.description,
        akahuIds: [transaction._id]
      }

      // Add foreign currency details if any available
      const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
      if (conversion !== undefined) {
        fireflyTrans.foreign_amount = Math.abs(conversion.amount).toString()
        fireflyTrans.foreign_currency_code = conversion.currency
        // TODO: Store fee/rate
      }

      // Use personal finance group as category
      fireflyTrans.category_name = transaction?.category?.groups?.['personal_finance']?.name ?? null
      // TODO: Store other categories

      return fireflyTrans
    })

    return processed
  }
}
