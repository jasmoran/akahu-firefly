import * as firefly from './firefly'
import { Accounts, AccountType } from './accounts'

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

export async function importAccounts (accounts: Accounts): Promise<void> {
  const fireflyAccounts = await firefly.accounts()

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
}
