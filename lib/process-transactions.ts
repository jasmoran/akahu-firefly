import * as fireflyImport from './firefly-import'
import * as akahuImport from './akahu-import'

export class ProcessTransactions {
  public async processTransactions (): Promise<void> {
    console.log('Importing Firefly accounts')
    const fireflyAccounts = await fireflyImport.importAccounts()

    console.log('Importing Firefly transactions')
    const fireflyTransactions = await fireflyImport.importTransactions(fireflyAccounts)

    console.log('Importing Akahu transactions')
    const akahuTransactions = await akahuImport.importTransactions(fireflyAccounts)

    console.log('Merging transactions')
    const mergedTransactions = fireflyTransactions.duplicate()
    mergedTransactions.merge(akahuTransactions, (a, b) => {
      // Check Akahu IDs match
      return [...a.akahuIds].sort().join(',') === [...b.akahuIds].sort().join(',')
    })
  }
}
