import * as fireflyImport from './firefly-import'
import * as akahuImport from './akahu-import'

export class ProcessTransactions {
  public async processTransactions (): Promise<void> {
    const fireflyAccounts = await fireflyImport.importAccounts()
    const fireflyTransactions = await fireflyImport.importTransactions(fireflyAccounts)

    const akahuTransactions = await akahuImport.importTransactions(fireflyAccounts)
  }
}
