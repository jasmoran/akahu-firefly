import * as firefly from 'firefly-iii-sdk-typescript'
import type { TransactionTypeProperty } from 'firefly-iii-sdk-typescript'
import type { Transactions } from './transactions'

interface Update {
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

export async function exportTransactions (basePath: string, apiKey: string, current: Transactions, modified: Transactions): Promise<void> {
  const config = new firefly.Configuration({
    apiKey,
    basePath,
    baseOptions: {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  })
  const factory = firefly.TransactionsApiFactory(config)

  // Process each Firefly transaction
  for (const pair of modified.changes(current)) {
    const changes = pair[1]
    const transaction = modified.get(changes.id)
    if (transaction === undefined) throw Error('Changes returned an invalid transaction ID - impossible')

    if (transaction.type === undefined) throw Error('FIXME: Transaction type is undefined')

    // Construct update request body
    const update: Update = {
      type: (changes.type as string).toLowerCase() as TransactionTypeProperty,
      external_id: [...transaction.akahuIds].sort().join(','),
      description: transaction.description,
      date: transaction.date.toISOString(),
      amount: transaction.amount.toString(),
      source_id: transaction.source.fireflyId?.toString() ?? '0',
      destination_id: transaction.destination.fireflyId?.toString() ?? '0'
    }

    // Set optional fields
    if (transaction.foreignAmount !== undefined) update.foreign_amount = transaction.foreignAmount.toString()
    if (transaction.foreignCurrencyCode !== undefined) update.foreign_currency_code = transaction.foreignCurrencyCode
    if (transaction.categoryName !== undefined) update.category_name = transaction.categoryName

    const request = {
      apply_rules: true,
      fire_webhooks: true,
      transactions: [update]
    }

    // Update or create transaction
    try {
      if (transaction.fireflyId !== undefined) {
        console.log(`Updating transaction ${transaction.fireflyId}`, changes)
        await factory.updateTransaction(transaction.fireflyId.toString(), request)
      } else {
        console.log('Creating transaction', changes)
        await factory.storeTransaction(request)
      }
    } catch (e: any) {
      console.error(e?.response?.data)
    }
  }
}
