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
  // Formats a bank account string:
  // 2 digit Bank Number
  // 4 digit Branch Number
  // 7 digit Account Body
  // 3 digit Account Suffix
  private formatBankNumber (bankAccountNumber: string): string {
    const lengths = [2, 4, 7, 3]
    return bankAccountNumber
      .split('-')
      .map((part, ix) => parseInt(part).toString().padStart(lengths[ix] ?? 0, '0'))
      .join('-')
  }

  private async processFireflyBankAccounts (): Promise<Record<string, AccountPair>> {
    const accounts = await firefly.accountsWithNumber()
    const grouped: Record<string, AccountPair> = {}

    accounts
      .filter(account => /"\d+-\d+-\d+-\d+"/.test(account.account_number))
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

  private lookupAkahuAccountId (akahuAccountId: string): number {
    // TODO: Source this from Firefly
    const accountToAsset: Record<string, number> = {
      acc_clcpadkvo000a08mh7qgxch6h: 1,
      acc_clcpadkvm000808mh3cky82f5: 3,
      acc_clcpadkty000408mha3qscnwm: 198,
      acc_clcpadktf000208mhglosagzn: 1314,
      acc_clcpadkv3000608mhcwmk1hff: 1315,
      acc_clcpadkvn000908mh0n8valhy: 1316,
      acc_clcpadku1000508mh80h7h3kl: 1317,
      acc_clcpadktg000308mh78odg7oz: 1661,
      acc_clcpadkv4000708mh9zkzfah7: 1662
    }

    const existingAsset = accountToAsset[akahuAccountId]
    if (existingAsset === undefined) {
      console.log(`Creating asset for ${akahuAccountId}`)
      return 99999
    } else {
      return existingAsset
    }
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

      if (transaction.amount < 0) {
        fireflyTrans.type = 'withdrawal'
        fireflyTrans.source_id = this.lookupAkahuAccountId(transaction._account).toString()
        fireflyTrans.destination_id = 'expense account' // TODO
      } else {
        fireflyTrans.type = 'deposit'
        fireflyTrans.source_id = 'revenue account' // TODO
        fireflyTrans.destination_id = this.lookupAkahuAccountId(transaction._account).toString()
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
