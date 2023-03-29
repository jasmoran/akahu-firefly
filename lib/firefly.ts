import * as fireflySDK from 'firefly-iii-sdk-typescript'
import { TransactionTypeProperty } from 'firefly-iii-sdk-typescript'
import knex from 'knex'
import Big from 'big.js'
import { firefly } from '../knexfile'
import { Account as AccountAccount, Accounts, AccountType as AccountAccountType } from './accounts'
import { Transaction as TransactionTransaction, Transactions } from './transactions'
import { Util } from './util'

enum AccountType {
  Default = 'Default account',
  Cash = 'Cash account',
  Asset = 'Asset account',
  Expense = 'Expense account',
  Revenue = 'Revenue account',
  InitialBalance = 'Initial balance account',
  Beneficiary = 'Beneficiary account',
  Import = 'Import account',
  Loan = 'Loan',
  Reconciliation = 'Reconciliation account',
  Debt = 'Debt',
  Mortgage = 'Mortgage',
  LiabilityCredit = 'Liability credit account'
}

interface Account {
  id: number
  type: AccountType
  name: string
  iban: string | null
  account_number: string | null
  external_id: string | null
  notes: string | null
}

interface Transaction {
  id: number
  type: string
  description: string
  date: Date
  amount: string | number
  source_id: number
  destination_id: number
  foreign_amount: string | number | null
  foreign_currency_code: string | null
  external_id: string | null
  category_name: string | null
}

interface UpdateAccount {
  name: string
  account_number: string
  notes?: string
}

interface UpdateTransaction {
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

export class Firefly {
  // Map Firefly account types to Asset, Liability, Expense and Revenue
  // Ignore type accounts will be discarded
  private static readonly TypeMapping: { [K in AccountType]?: AccountAccountType } = {
    [AccountType.Default]: AccountAccountType.Asset,
    [AccountType.Cash]: AccountAccountType.Asset,
    [AccountType.Asset]: AccountAccountType.Asset,
    [AccountType.Expense]: AccountAccountType.Expense,
    [AccountType.Revenue]: AccountAccountType.Revenue,
    [AccountType.Loan]: AccountAccountType.Liability,
    [AccountType.Debt]: AccountAccountType.Liability,
    [AccountType.Mortgage]: AccountAccountType.Liability
  }

  private static readonly transactionMapping = {
    [AccountAccountType.Asset]: {
      [AccountAccountType.Asset]: TransactionTypeProperty.Transfer,
      [AccountAccountType.Liability]: TransactionTypeProperty.Withdrawal,
      [AccountAccountType.Expense]: TransactionTypeProperty.Withdrawal,
      [AccountAccountType.Revenue]: undefined
    },
    [AccountAccountType.Liability]: {
      [AccountAccountType.Asset]: TransactionTypeProperty.Deposit,
      [AccountAccountType.Liability]: TransactionTypeProperty.Transfer,
      [AccountAccountType.Expense]: TransactionTypeProperty.Withdrawal,
      [AccountAccountType.Revenue]: undefined
    },
    [AccountAccountType.Expense]: {
      [AccountAccountType.Asset]: undefined,
      [AccountAccountType.Liability]: undefined,
      [AccountAccountType.Expense]: undefined,
      [AccountAccountType.Revenue]: undefined
    },
    [AccountAccountType.Revenue]: {
      [AccountAccountType.Asset]: TransactionTypeProperty.Deposit,
      [AccountAccountType.Liability]: TransactionTypeProperty.Deposit,
      [AccountAccountType.Expense]: undefined,
      [AccountAccountType.Revenue]: undefined
    }
  }

  private static readonly ALT_NAMES_REGEX = /\*\*Alternate names\*\*(\n-\s*`[^`]+`)+/
  private static readonly AKAHU_ID_REGEX = /\*\*Akahu ID\*\*\s*`([^`]+)`/

  // Fetch all accounts
  private async accounts (): Promise<Account[]> {
    const db = knex(firefly)
    const accounts = await db('accounts AS acc')
      .select(
        'acc.id',
        'at.type',
        'acc.name',
        'acc.iban',
        'num.data AS account_number',
        'ext.data AS external_id',
        'notes.text AS notes'
      )
      .leftJoin('account_meta AS num', function () {
        this.on('acc.id', 'num.account_id')
          .andOnVal('num.name', 'account_number')
      })
      .leftJoin('account_meta AS ext', function () {
        this.on('acc.id', 'ext.account_id')
          .andOnVal('ext.name', 'external_id')
      })
      .leftJoin('notes', function () {
        this.on('acc.id', 'notes.noteable_id')
          .andOnVal('notes.noteable_type', 'FireflyIII\\Models\\Account')
          .andOnNull('notes.deleted_at')
      })
      .leftJoin('account_types AS at', 'acc.account_type_id', 'at.id')
      .whereNull('acc.deleted_at')

    accounts.forEach(account => {
      account.account_number = JSON.parse(account.account_number)
      account.external_id = JSON.parse(account.external_id)
    })

    return accounts
  }

  // Fetch all transactions
  private async transactions (): Promise<Transaction[]> {
    const db = knex(firefly)
    const transactions = await db('transaction_journals AS tj')
      .select(
        'tj.id',
        'tt.type',
        'tj.description',
        'tj.date',
        db.raw('ROUND(dst.amount, 2) AS amount'),
        'src.account_id AS source_id',
        'dst.account_id AS destination_id',
        'dst.foreign_amount',
        'tc.code AS foreign_currency_code',
        'meta.data AS external_id',
        'c.name AS category_name'
      )
      .leftJoin('transactions AS src', function () {
        this.on('tj.id', 'src.transaction_journal_id')
          .andOnVal('src.amount', '<', 0)
          .andOnNull('src.deleted_at')
      })
      .leftJoin('transactions AS dst', function () {
        this.on('tj.id', 'dst.transaction_journal_id')
          .andOnVal('dst.amount', '>=', 0)
          .andOnNull('dst.deleted_at')
      })
      .leftJoin('journal_meta AS meta', function () {
        this.on('tj.id', 'meta.transaction_journal_id')
          .andOnVal('meta.name', 'external_id')
          .andOnNull('meta.deleted_at')
      })
      .leftJoin('transaction_currencies AS tc', 'dst.foreign_currency_id', 'tc.id')
      .leftJoin('transaction_types AS tt', 'tj.transaction_type_id', 'tt.id')
      .leftJoin('category_transaction_journal AS ctj', 'tj.id', 'ctj.transaction_journal_id')
      .leftJoin('categories AS c', 'ctj.category_id', 'c.id')
      .whereNull('tj.deleted_at')

    transactions.forEach(account => {
      account.external_id = JSON.parse(account.external_id)
    })

    return transactions
  }

  // Find all accounts that match any of the provided identifiers
  private findMatches (accounts: Accounts, account: Omit<AccountAccount, 'id'>): AccountAccount[] {
    const matches: Map<number, AccountAccount> = new Map()

    const addAccount = (acc: AccountAccount | undefined): void => {
      if (acc !== undefined) {
        matches.set(acc.id, acc)
      }
    }

    // Match on account name
    account.alternateNames.forEach(name => {
      addAccount(accounts.getByName(name))
    })

    // Match on bank numbers
    account.bankNumbers.forEach(bankNumber => {
      addAccount(accounts.getByBankNumber(bankNumber))
    })

    // Match on Akahu ID
    addAccount(accounts.getByAkahuId(account.akahuId ?? ''))

    // Match on Firefly ID
    addAccount(accounts.getByFireflyId(account.source?.fireflyId ?? 0))
    addAccount(accounts.getByFireflyId(account.destination?.fireflyId ?? 0))

    return [...matches.values()]
  }

  private mergeAccounts (a: AccountAccount, b: Omit<AccountAccount, 'id'>): AccountAccount {
    // Ensure only one account has source set
    if (a.source !== undefined && b.source !== undefined) {
      throw Error(`Merging two accounts with Source Firefly IDs ${Util.stringify([a, b])}`)
    }

    // Ensure only one account has destination set
    if (a.destination !== undefined && b.destination !== undefined) {
      throw Error(`Merging two accounts with Destination Firefly IDs ${Util.stringify([a, b])}`)
    }

    // Compare Akahu IDs
    if (a.akahuId !== undefined && b.akahuId !== undefined && a.akahuId !== b.akahuId) {
      throw Error(`Merging mismatched Akahu IDs ${Util.stringify([a, b])}`)
    }

    // Compare names
    if (a.name !== b.name) throw Error(`Merging mismatched names ${Util.stringify([a, b])}`)

    return {
      id: a.id,
      source: a.source ?? b.source,
      destination: a.destination ?? b.destination,
      akahuId: a.akahuId ?? b.akahuId,
      name: a.name,
      bankNumbers: new Set([...a.bankNumbers, ...b.bankNumbers]),
      alternateNames: new Map([...a.alternateNames, ...b.alternateNames])
    }
  }

  public async importAccounts (): Promise<Accounts> {
    const fireflyAccounts = await this.accounts()
    const accs = new Accounts()

    // Process each Firefly account
    fireflyAccounts.forEach(fireflyAccount => {
      // Fetch account type
      const type = Firefly.TypeMapping[fireflyAccount.type]
      if (type === undefined) return

      // Fetch Akahu ID
      let akahuId: string | undefined
      if (fireflyAccount.notes !== null && Firefly.AKAHU_ID_REGEX.test(fireflyAccount.notes)) {
        akahuId = fireflyAccount.notes.match(Firefly.AKAHU_ID_REGEX)?.[1]
      }

      const notes = fireflyAccount.notes ?? undefined

      // Set source & destination Firefly IDs
      const source = type === AccountAccountType.Expense ? undefined : { fireflyId: fireflyAccount.id, type, notes }
      const destination = type === AccountAccountType.Revenue ? undefined : { fireflyId: fireflyAccount.id, type, notes }

      // Create Account from Firefly data
      const name = fireflyAccount.name.trim()
      const account: Omit<AccountAccount, 'id'> = {
        source,
        destination,
        akahuId,
        name,
        bankNumbers: new Set<string>(),
        alternateNames: new Map()
      }

      account.alternateNames.set(Accounts.normalizeName(name), name)

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
          .match(Firefly.ALT_NAMES_REGEX)
          ?.[0]
          ?.split('\n')
          ?.forEach(line => {
            const name = line.match(/`([^`]+)`/)?.[1]
            if (name !== undefined) account.alternateNames.set(Accounts.normalizeName(name), name)
          })
      }

      // Find any accounts that have matching values
      const matches = this.findMatches(accs, account)
      const [match, others] = matches

      if (match === undefined) {
        // Create a new account if there are no existing accounts
        accs.create(account)
      } else if (others === undefined && (type === AccountAccountType.Revenue || type === AccountAccountType.Expense)) {
        // Merge expense / revenue accounts
        accs.save(this.mergeAccounts(match, account))
      } else {
        throw Error(`Account (${Util.stringify(account)}) conflicts with accounts:\n${Util.stringify(matches)}`)
      }
    })

    return accs
  }

  public async importTransactions (accounts: Accounts): Promise<Transactions> {
    const fireflyTransactions = await this.transactions()
    const trans = new Transactions()

    // Process each Firefly transaction
    fireflyTransactions.forEach(fireflyTransaction => {
      // Split comma seperated external IDs into an array
      // Array should be empty if external ID is empty or null
      const externalId = fireflyTransaction.external_id ?? ''
      const externalIds = externalId.length === 0 ? [] : externalId.split(',')
      const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

      const source = accounts.getByFireflyId(fireflyTransaction.source_id)
      const destination = accounts.getByFireflyId(fireflyTransaction.destination_id)

      // Confirm source and destination account exist
      // This should be enforced by a foreign key in the database
      if (source === undefined || destination === undefined) throw Error("Source or desination account doesn't exist")

      // Create Transaction from Firefly data
      const transaction: Omit<TransactionTransaction, 'id'> = {
        fireflyId: fireflyTransaction.id,
        description: fireflyTransaction.description,
        date: fireflyTransaction.date,
        amount: Big(fireflyTransaction.amount),
        sourceId: source.id,
        destinationId: destination.id,
        akahuIds: new Set(akahuIds)
      }

      // Add optional values
      if (fireflyTransaction.foreign_amount !== null) transaction.foreignAmount = Big(fireflyTransaction.foreign_amount)
      if (fireflyTransaction.foreign_currency_code !== null) transaction.foreignCurrencyCode = fireflyTransaction.foreign_currency_code
      if (fireflyTransaction.category_name !== null) transaction.categoryName = fireflyTransaction.category_name

      trans.create(transaction)
    })

    return trans
  }

  private updateNotes (notes: string | undefined, akahuId: string | undefined, otherNames: string[]): string {
    // Remove existing Akahu ID / Alternate names from notes
    notes = (notes ?? '').replace(Firefly.AKAHU_ID_REGEX, '').replace(Firefly.ALT_NAMES_REGEX, '').trim()

    // Add Akahu ID to bottom of notes
    if (akahuId !== undefined) {
      notes = `${notes}\n\n**Akahu ID** \`${akahuId}\``
    }

    // Add other names to bottom of list
    if (otherNames.length > 0) {
      const list = otherNames.map(name => `- \`${name.replaceAll('`', "'")}\``).join('\n')
      notes = `${notes}\n\n**Alternate names**\n${list}`
    }

    return notes.trim()
  }

  private async updateAccount (
    account: AccountAccount,
    oldAccount: AccountAccount | undefined,
    select: 'source' | 'destination',
    config: fireflySDK.Configuration,
    dryRun: boolean
  ): Promise<void> {
    // Skip if source / destination undefined
    const sourceDest = account[select]
    if (sourceDest === undefined) return

    // Remove primary name from alternateNames
    const altNames = new Map(account.alternateNames)
    altNames.delete(Accounts.normalizeName(account.name))
    const otherNames = [...altNames.values()]

    const update: UpdateAccount = {
      name: account.name,
      account_number: [...account.bankNumbers].sort().join(','),
      notes: this.updateNotes(sourceDest.notes, account.akahuId, otherNames)
    }

    if (oldAccount !== undefined) {
      const oldUpdate: UpdateAccount = {
        name: oldAccount.name,
        account_number: [...oldAccount.bankNumbers].sort().join(','),
        notes: oldAccount[select]?.notes?.trim() ?? ''
      }
      if (JSON.stringify(oldUpdate) === JSON.stringify(update)) return
    }

    const factory = fireflySDK.AccountsApiFactory(config)

    // Update or create accounts
    try {
      if (sourceDest.fireflyId !== undefined) {
        console.log(`Updating account ${sourceDest.fireflyId}`, update)
        if (!dryRun) await factory.updateAccount(sourceDest.fireflyId.toString(), update)
      } else {
        console.log('Creating account', update)
        if (!dryRun) await factory.storeAccount({ ...update, type: sourceDest.type })
      }
    } catch (e: any) {
      console.error(account, e?.response?.data)
    }
  }

  private async exportAccounts (
    basePath: string,
    apiKey: string,
    current: Accounts,
    modified: Accounts,
    dryRun: boolean
  ): Promise<void> {
    const config = new fireflySDK.Configuration({
      apiKey,
      basePath,
      baseOptions: {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    })

    // Process each Firefly account
    for (const account of modified) {
      const oldAccount = current.get(account.id)

      // Process source account
      await this.updateAccount(account, oldAccount, 'source', config, dryRun)

      // Process destination (if different from source)
      if (account.destination?.type === AccountAccountType.Expense) {
        await this.updateAccount(account, oldAccount, 'destination', config, dryRun)
      }
    }
  }

  private transformTransaction (transaction: TransactionTransaction, accounts: Accounts): UpdateTransaction {
    const source = accounts.get(transaction.sourceId)?.source
    if (source?.fireflyId === undefined) throw Error('Source account not set')

    const destination = accounts.get(transaction.destinationId)?.destination
    if (destination?.fireflyId === undefined) throw Error('Destination account not set')

    const type = Firefly.transactionMapping[source.type][destination.type]
    if (type === undefined) throw Error(`Invalid transaction type ${source.type} -> ${destination.type}`)

    // Construct update request body
    const update: UpdateTransaction = {
      type,
      external_id: [...transaction.akahuIds].sort().join(','),
      description: transaction.description,
      date: transaction.date.toISOString(),
      amount: transaction.amount.toString(),
      source_id: source.fireflyId.toString(),
      destination_id: destination.fireflyId.toString()
    }

    // Set optional fields
    if (transaction.foreignAmount !== undefined) update.foreign_amount = transaction.foreignAmount.toString()
    if (transaction.foreignCurrencyCode !== undefined) update.foreign_currency_code = transaction.foreignCurrencyCode
    if (transaction.categoryName !== undefined) update.category_name = transaction.categoryName

    return update
  }

  public async exportTransactions (
    basePath: string,
    apiKey: string,
    current: Transactions,
    modified: Transactions,
    currentAccounts: Accounts,
    modifiedAccounts: Accounts,
    dryRun: boolean
  ): Promise<void> {
    const config = new fireflySDK.Configuration({
      apiKey,
      basePath,
      baseOptions: {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    })
    const factory = fireflySDK.TransactionsApiFactory(config)

    // Create source / destination accounts as necessary
    for (const transaction of modified) {
      const source = modifiedAccounts.get(transaction.sourceId)
      if (source === undefined) throw Error(`Invalid account ID ${transaction.sourceId}`)

      if (source.source === undefined) {
        source.source = {
          type: AccountAccountType.Revenue
        }
        modifiedAccounts.save(source)
      }

      const destination = modifiedAccounts.get(transaction.destinationId)
      if (destination === undefined) throw Error(`Invalid account ID ${transaction.destinationId}`)

      if (destination.destination === undefined) {
        destination.destination = {
          type: AccountAccountType.Expense
        }
        modifiedAccounts.save(destination)
      }
    }

    await this.exportAccounts(basePath, apiKey, currentAccounts, modifiedAccounts, dryRun)

    // Process each Firefly transaction
    for (const transaction of modified) {
      const update = this.transformTransaction(transaction, modifiedAccounts)

      // Check if transaction has been modified
      const oldTransaction = current.get(transaction.id)
      if (oldTransaction !== undefined) {
        const otherUpdate = this.transformTransaction(oldTransaction, modifiedAccounts)
        if (JSON.stringify(update) === JSON.stringify(otherUpdate)) continue
      }

      const request = {
        apply_rules: true,
        fire_webhooks: true,
        transactions: [update]
      }

      // Update or create transaction
      try {
        if (transaction.fireflyId !== undefined) {
          console.log(`Updating transaction ${transaction.fireflyId}`, update)
          if (!dryRun) await factory.updateTransaction(transaction.fireflyId.toString(), request)
        } else {
          console.log('Creating transaction', update)
          if (!dryRun) await factory.storeTransaction(request)
        }
      } catch (e: any) {
        console.error(request, e?.response?.data)
      }
    }
  }
}
