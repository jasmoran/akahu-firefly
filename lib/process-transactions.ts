import type { EnrichedTransaction } from 'akahu'
import Big from 'big.js'
import * as firefly from './firefly'
import { Transactions } from './transactions'

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

interface Transaction {
  id: number
  type: string
  description: string
  date: Date
  amount: Big
  sourceId: number
  destinationId: number
  foreignAmount?: Big
  foreignCurrencyCode?: string
  categoryName?: string
  akahuIds: string[]
}

export class ProcessTransactions {
  accountsByBankNumber: Record<string, AccountPair>
  accountsByExternalId: Record<string, AccountPair>

  transactions: Transactions

  private constructor (
    accountsByBankNumber: Record<string, AccountPair>,
    accountsByExternalId: Record<string, AccountPair>
  ) {
    this.accountsByBankNumber = accountsByBankNumber
    this.accountsByExternalId = accountsByExternalId
    this.transactions = new Transactions()
  }

  public static async build (): Promise<ProcessTransactions> {
    const [bankAccounts, accountIds] = await Promise.all([
      this.processFireflyBankAccounts(),
      this.processFireflyExternalIds()
    ])
    return new ProcessTransactions(bankAccounts, accountIds)
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
    const accounts = await firefly.accounts()
    const grouped: Record<string, AccountPair> = {}

    accounts.forEach(account => {
      if (account.account_number === null || !/\d+-\d+-\d+-\d+/.test(account.account_number)) return

      const bankAccountNumber = this.formatBankNumber(account.account_number)
      const accountPair: AccountPair = grouped[bankAccountNumber] ?? { expense: undefined, revenue: undefined }

      // Expense account
      if (account.type === firefly.AccountType.Expense) {
        accountPair.expense ??= account.id

      // Revenue account
      } else if (account.type === firefly.AccountType.Revenue) {
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
    const accounts = await firefly.accounts()
    const grouped: Record<string, AccountPair> = {}

    accounts.forEach(account => {
      if (account.external_id === null) return

      const accountPair: AccountPair = grouped[account.external_id] ?? { expense: undefined, revenue: undefined }

      // Expense account
      if (account.type === firefly.AccountType.Expense) {
        accountPair.expense ??= account.id

      // Revenue account
      } else if (account.type === firefly.AccountType.Revenue) {
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

  private lookupAkahuAccountId (akahuAccountId: string): AccountPair {
    return this.accountsByExternalId[akahuAccountId] ?? { expense: undefined, revenue: undefined }
  }

  private lookupBankAccountNumber (bankAccountNumber: string): AccountPair {
    if (!/"\d+-\d+-\d+-\d+"/.test(bankAccountNumber)) return { expense: undefined, revenue: undefined }

    bankAccountNumber = ProcessTransactions.formatBankNumber(bankAccountNumber)

    return this.accountsByBankNumber[bankAccountNumber] ?? { expense: undefined, revenue: undefined }
  }

  public akahuToFirefly (transaction: EnrichedTransaction): Transaction {
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
      id: 0,
      type,
      sourceId,
      destinationId,
      date: new Date(transaction.date),
      amount: Big(transaction.amount).abs(),
      description: transaction.description,
      akahuIds: [transaction._id]
    }

    // Add foreign currency details if any available
    const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
    if (conversion !== undefined) {
      fireflyTrans.foreignAmount = Big(conversion.amount).abs()
      fireflyTrans.foreignCurrencyCode = conversion.currency
      // TODO: Store fee/rate
    }

    // Use personal finance group as category
    const categoryName = transaction?.category?.groups?.['personal_finance']?.name
    if (categoryName !== undefined) fireflyTrans.categoryName = categoryName
    // TODO: Store other categories

    return fireflyTrans
  }

  public async processTransactions (transactions: EnrichedTransaction[]): Promise<void> {
    this.lookupBankAccountNumber('hi')
    await this.transactions.importFromFirefly()

    transactions.forEach(transaction => {
      const existingTransaction = this.transactions.getByAkahuId(transaction._id)
      const convertedTransaction = this.akahuToFirefly(transaction)
      if (existingTransaction !== undefined) {
        // existingTransaction.description = convertedTransaction.description
        existingTransaction.amount = convertedTransaction.amount
        this.transactions.save(existingTransaction)
      }
    })

    this.transactions.changes()
  }
}
