import type { EnrichedTransaction } from 'akahu'
import type { TransactionSplitStore } from 'firefly-iii-sdk-typescript'
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

export class ProcessTransactions {
  accountsByBankNumber: Record<string, AccountPair>
  accountsByExternalId: Record<string, AccountPair>

  private constructor (
    accountsByBankNumber: Record<string, AccountPair>,
    accountsByExternalId: Record<string, AccountPair>
  ) {
    this.accountsByBankNumber = accountsByBankNumber
    this.accountsByExternalId = accountsByExternalId
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

  private lookupAkahuAccountId (akahuAccountId: string): AccountPair {
    return this.accountsByExternalId[akahuAccountId] ?? { expense: undefined, revenue: undefined }
  }

  private lookupBankAccountNumber (bankAccountNumber: string): AccountPair {
    if (!/"\d+-\d+-\d+-\d+"/.test(bankAccountNumber)) return { expense: undefined, revenue: undefined }

    bankAccountNumber = ProcessTransactions.formatBankNumber(bankAccountNumber)

    return this.accountsByBankNumber[bankAccountNumber] ?? { expense: undefined, revenue: undefined }
  }

  public processTransactions (transactions: EnrichedTransaction[]): TransactionSplitStore[] {
    const processed = transactions.map(transaction => {
      // TODO:
      // transaction.meta.reference
      // transaction.meta.particulars
      // transaction.meta.code
      // transaction.meta.other_account
      // transaction.type
      // transaction.merchant

      const fireflyTrans: TransactionSplitStore = {
        type: 'deposit',
        date: transaction.date,
        amount: Math.abs(transaction.amount).toString(),
        description: transaction.description,
        external_id: transaction._id
      }

      // Look up Akahu Account ID (acc_xxxxx)
      const account = (this.lookupAkahuAccountId(transaction._account).revenue ?? '').toString()

      if (transaction.amount < 0) {
        fireflyTrans.type = 'withdrawal'
        fireflyTrans.source_id = account
        fireflyTrans.destination_id = 'expense account' // TODO
      } else {
        fireflyTrans.type = 'deposit'
        fireflyTrans.source_id = 'revenue account' // TODO
        fireflyTrans.destination_id = account
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
