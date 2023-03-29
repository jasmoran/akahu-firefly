import * as fireflySDK from 'firefly-iii-sdk-typescript'
import { TransactionTypeProperty } from 'firefly-iii-sdk-typescript'
import knex from 'knex'
import Big from 'big.js'
import { firefly } from '../knexfile'
import { Accounts } from './accounts'
import { Transactions } from './transactions'
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
  // Store accounts and transactions as they currently exist in Firefly
  private actualAccounts = new Accounts()
  private actualTransactions = new Transactions()

  // Store modified accounts and transactions
  private modifiedAccounts: Accounts | undefined
  private modifiedTransactions: Transactions | undefined
  
  public async import () {
    // Import accounts and transactions from Firefly
    await this.importAccounts()
    await this.importTransactions()

    // Clone imported accounts and transactions
    this.modifiedAccounts = this.actualAccounts.duplicate()
    this.modifiedTransactions = this.actualTransactions.duplicate()
  }

  // Getter for modified accounts
  public get accounts (): Accounts {
    if (this.modifiedAccounts === undefined) throw new Error('Accounts not imported')
    return this.modifiedAccounts
  }

  // Getter for modified transactions
  public get transactions (): Transactions {
    if (this.modifiedTransactions === undefined) throw new Error('Transactions not imported')
    return this.modifiedTransactions
  }

  // Map Firefly account types to Asset, Liability, Expense and Revenue
  // Ignore type accounts will be discarded
  private static readonly TypeMapping: { [K in AccountType]?: Accounts.Type } = {
    [AccountType.Default]: Accounts.Type.Asset,
    [AccountType.Cash]: Accounts.Type.Asset,
    [AccountType.Asset]: Accounts.Type.Asset,
    [AccountType.Expense]: Accounts.Type.Expense,
    [AccountType.Revenue]: Accounts.Type.Revenue,
    [AccountType.Loan]: Accounts.Type.Liability,
    [AccountType.Debt]: Accounts.Type.Liability,
    [AccountType.Mortgage]: Accounts.Type.Liability
  }

  private static readonly transactionMapping = {
    [Accounts.Type.Asset]: {
      [Accounts.Type.Asset]: TransactionTypeProperty.Transfer,
      [Accounts.Type.Liability]: TransactionTypeProperty.Withdrawal,
      [Accounts.Type.Expense]: TransactionTypeProperty.Withdrawal,
      [Accounts.Type.Revenue]: undefined
    },
    [Accounts.Type.Liability]: {
      [Accounts.Type.Asset]: TransactionTypeProperty.Deposit,
      [Accounts.Type.Liability]: TransactionTypeProperty.Transfer,
      [Accounts.Type.Expense]: TransactionTypeProperty.Withdrawal,
      [Accounts.Type.Revenue]: undefined
    },
    [Accounts.Type.Expense]: {
      [Accounts.Type.Asset]: undefined,
      [Accounts.Type.Liability]: undefined,
      [Accounts.Type.Expense]: undefined,
      [Accounts.Type.Revenue]: undefined
    },
    [Accounts.Type.Revenue]: {
      [Accounts.Type.Asset]: TransactionTypeProperty.Deposit,
      [Accounts.Type.Liability]: TransactionTypeProperty.Deposit,
      [Accounts.Type.Expense]: undefined,
      [Accounts.Type.Revenue]: undefined
    }
  }

  private static readonly ALT_NAMES_REGEX = /\*\*Alternate names\*\*(\n-\s*`[^`]+`)+/
  private static readonly AKAHU_ID_REGEX = /\*\*Akahu ID\*\*\s*`([^`]+)`/

  // Fetch all accounts
  private async getAccounts (): Promise<Account[]> {
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
  private async getTransactions (): Promise<Transaction[]> {
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
  private findMatches (account: Omit<Accounts.Account, 'id'>): Accounts.Account[] {
    const matches: Map<number, Accounts.Account> = new Map()

    const addAccount = (acc: Accounts.Account | undefined): void => {
      if (acc !== undefined) {
        matches.set(acc.id, acc)
      }
    }

    // Match on account name
    account.alternateNames.forEach(name => {
      addAccount(this.actualAccounts.getByName(name))
    })

    // Match on bank numbers
    account.bankNumbers.forEach(bankNumber => {
      addAccount(this.actualAccounts.getByBankNumber(bankNumber))
    })

    // Match on Akahu ID
    addAccount(this.actualAccounts.getByAkahuId(account.akahuId ?? ''))

    // Match on Firefly ID
    addAccount(this.actualAccounts.getByFireflyId(account.source?.fireflyId ?? 0))
    addAccount(this.actualAccounts.getByFireflyId(account.destination?.fireflyId ?? 0))

    return [...matches.values()]
  }

  private mergeAccounts (a: Accounts.Account, b: Omit<Accounts.Account, 'id'>): Accounts.Account {
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

  // Import all accounts from Firefly
  public async importAccounts (): Promise<void> {
    const fireflyAccounts = await this.getAccounts()

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
      const source = type === Accounts.Type.Expense ? undefined : { fireflyId: fireflyAccount.id, type, notes }
      const destination = type === Accounts.Type.Revenue ? undefined : { fireflyId: fireflyAccount.id, type, notes }

      // Create Account from Firefly data
      const name = fireflyAccount.name.trim()
      const account: Omit<Accounts.Account, 'id'> = {
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
      const matches = this.findMatches(account)
      const [match, others] = matches

      if (match === undefined) {
        // Create a new account if there are no existing accounts
        this.actualAccounts.create(account)
      } else if (others === undefined && (type === Accounts.Type.Revenue || type === Accounts.Type.Expense)) {
        // Merge expense / revenue accounts
        this.actualAccounts.save(this.mergeAccounts(match, account))
      } else {
        throw Error(`Account (${Util.stringify(account)}) conflicts with accounts:\n${Util.stringify(matches)}`)
      }
    })
  }

  public async importTransactions (): Promise<void> {
    const fireflyTransactions = await this.getTransactions()

    // Process each Firefly transaction
    fireflyTransactions.forEach(fireflyTransaction => {
      // Split comma seperated external IDs into an array
      // Array should be empty if external ID is empty or null
      const externalId = fireflyTransaction.external_id ?? ''
      const externalIds = externalId.length === 0 ? [] : externalId.split(',')
      const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

      const source = this.actualAccounts.getByFireflyId(fireflyTransaction.source_id)
      const destination = this.actualAccounts.getByFireflyId(fireflyTransaction.destination_id)

      // Confirm source and destination account exist
      // This should be enforced by a foreign key in the database
      if (source === undefined || destination === undefined) throw Error("Source or desination account doesn't exist")

      // Create Transaction from Firefly data
      const transaction: Omit<Transactions.Transaction, 'id'> = {
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

      this.actualTransactions.create(transaction)
    })
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
    account: Accounts.Account,
    oldAccount: Accounts.Account | undefined,
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
    for (const account of this.accounts) {
      const oldAccount = this.actualAccounts.get(account.id)

      // Process source account
      await this.updateAccount(account, oldAccount, 'source', config, dryRun)

      // Process destination (if different from source)
      if (account.destination?.type === Accounts.Type.Expense) {
        await this.updateAccount(account, oldAccount, 'destination', config, dryRun)
      }
    }
  }

  private transformTransaction (transaction: Transactions.Transaction): UpdateTransaction {
    const source = this.accounts.get(transaction.sourceId)?.source
    if (source?.fireflyId === undefined) throw Error('Source account not set')

    const destination = this.accounts.get(transaction.destinationId)?.destination
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

  public async export (
    basePath: string,
    apiKey: string,
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
    for (const transaction of this.transactions) {
      const source = this.accounts.get(transaction.sourceId)
      if (source === undefined) throw Error(`Invalid account ID ${transaction.sourceId}`)

      if (source.source === undefined) {
        source.source = {
          type: Accounts.Type.Revenue
        }
        this.accounts.save(source)
      }

      const destination = this.accounts.get(transaction.destinationId)
      if (destination === undefined) throw Error(`Invalid account ID ${transaction.destinationId}`)

      if (destination.destination === undefined) {
        destination.destination = {
          type: Accounts.Type.Expense
        }
        this.accounts.save(destination)
      }
    }

    await this.exportAccounts(basePath, apiKey, dryRun)

    // Process each Firefly transaction
    for (const transaction of this.transactions) {
      const update = this.transformTransaction(transaction)

      // Check if transaction has been modified
      const oldTransaction = this.actualTransactions.get(transaction.id)
      if (oldTransaction !== undefined) {
        const otherUpdate = this.transformTransaction(oldTransaction)
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
