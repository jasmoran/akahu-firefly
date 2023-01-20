import type { EnrichedTransaction } from 'akahu'
import type { TransactionSplitStore } from 'firefly-iii-sdk-typescript'

interface CurrencyConversion {
  currency: string
  amount: number
  rate: number
  fee?: number
}

export class ProcessTransactions {
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
