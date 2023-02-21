import { Accounts } from './accounts'
import { Transactions } from './transactions'
import * as fireflyImport from './firefly-import'
import * as akahuImport from './akahu-import'

export class ProcessTransactions {
  private readonly transactions: Transactions
  private readonly accounts: Accounts

  private constructor () {
    this.accounts = new Accounts()
    this.transactions = new Transactions()
  }

  public static async build (): Promise<ProcessTransactions> {
    const processor = new ProcessTransactions()
    await fireflyImport.importAccounts(processor.accounts)
    await processor.transactions.importFromFirefly(processor.accounts)
    return processor
  }

  public async processTransactions (): Promise<void> {
    await akahuImport.importTransactions(this.accounts, this.transactions)
  }
}
