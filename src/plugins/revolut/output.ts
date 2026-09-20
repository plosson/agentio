import type { RevolutAccount, RevolutCounterparty, RevolutExpense, RevolutPaymentDraft, RevolutPaymentDraftSummary, RevolutPayoutLink, RevolutTransaction, RevolutTransferResult } from './types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function printAttachmentDownloaded(filename: string, path: string, size: number): void {
  console.log(`Downloaded: ${filename}`);
  console.log(`  Path: ${path}`);
  console.log(`  Size: ${formatBytes(size)}`);
}

function formatAmount(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

export function printRevolutAccountList(accounts: RevolutAccount[]): void {
  if (accounts.length === 0) {
    console.log('No accounts found');
    return;
  }

  console.log(`Accounts (${accounts.length})\n`);

  for (const account of accounts) {
    const name = account.name || '(unnamed)';
    const inactive = account.state === 'active' ? '' : ` [${account.state}]`;
    console.log(`${account.id} | ${name}${inactive}`);
    console.log(`    Balance: ${formatAmount(account.balance, account.currency)}`);
    console.log('');
  }

  const totals = new Map<string, number>();
  for (const account of accounts) {
    totals.set(account.currency, (totals.get(account.currency) ?? 0) + account.balance);
  }
  const summary = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => formatAmount(total, currency))
    .join(' | ');
  console.log(`Total: ${summary}`);
}

export function printRevolutTransactionList(transactions: RevolutTransaction[]): void {
  if (transactions.length === 0) {
    console.log('No transactions found');
    return;
  }

  console.log(`Transactions (${transactions.length})\n`);

  for (const transaction of transactions) {
    // The first leg is our own account's, and carries the signed amount.
    const leg = transaction.legs[0];
    const amount = leg ? formatAmount(leg.amount, leg.currency) : '-';
    const date = (transaction.completedAt || transaction.createdAt).slice(0, 10);
    const description = leg?.description || transaction.merchant?.name || transaction.reference || '';

    console.log(`${date} | ${amount} | ${transaction.type} [${transaction.state}]`);
    if (description) console.log(`    ${description}`);
    console.log(`    ID: ${transaction.id}`);
    console.log('');
  }
}

export function printRevolutTransaction(transaction: RevolutTransaction): void {
  console.log(`ID: ${transaction.id}`);
  console.log(`Type: ${transaction.type}`);
  console.log(`State: ${transaction.state}`);
  if (transaction.reasonCode) console.log(`Reason: ${transaction.reasonCode}`);
  console.log(`Created: ${transaction.createdAt}`);
  if (transaction.completedAt) console.log(`Completed: ${transaction.completedAt}`);
  if (transaction.reference) console.log(`Reference: ${transaction.reference}`);
  if (transaction.cardHolder) console.log(`Card holder: ${transaction.cardHolder}`);

  if (transaction.merchant?.name) {
    const location = [transaction.merchant.city, transaction.merchant.country].filter(Boolean).join(', ');
    console.log(`Merchant: ${transaction.merchant.name}${location ? ` (${location})` : ''}`);
    if (transaction.merchant.categoryCode) console.log(`Category: ${transaction.merchant.categoryCode}`);
  }

  console.log('---');

  for (const leg of transaction.legs) {
    console.log(`\n[Leg ${leg.legId}]`);
    console.log(`Account: ${leg.accountId}`);
    console.log(`Amount: ${formatAmount(leg.amount, leg.currency)}`);
    if (leg.billAmount !== undefined && leg.billCurrency && leg.billCurrency !== leg.currency) {
      console.log(`Billed: ${formatAmount(leg.billAmount, leg.billCurrency)}`);
    }
    if (leg.balance !== undefined) console.log(`Balance after: ${formatAmount(leg.balance, leg.currency)}`);
    if (leg.description) console.log(`Description: ${leg.description}`);
    if (leg.counterpartyId) console.log(`Counterparty: ${leg.counterpartyId} (${leg.counterpartyType || 'unknown'})`);
  }
}

export function printRevolutTransactionsCsv(transactions: RevolutTransaction[]): void {
  const escape = (value: string | number | undefined): string => {
    if (value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  console.log('date,transaction_id,leg_id,type,state,amount,currency,description,merchant,reference,account_id,counterparty_id');

  for (const transaction of transactions) {
    const date = transaction.completedAt || transaction.createdAt;
    for (const leg of transaction.legs) {
      console.log([
        escape(date),
        escape(transaction.id),
        escape(leg.legId),
        escape(transaction.type),
        escape(transaction.state),
        escape(leg.amount.toFixed(2)),
        escape(leg.currency),
        escape(leg.description),
        escape(transaction.merchant?.name),
        escape(transaction.reference),
        escape(leg.accountId),
        escape(leg.counterpartyId),
      ].join(','));
    }
  }
}

function expenseDate(expense: RevolutExpense): string {
  return (expense.expenseDate || expense.completedAt || '').slice(0, 10) || '-';
}

function expenseAmount(expense: RevolutExpense): string {
  if (expense.amount === undefined || !expense.currency) return '-';
  return formatAmount(expense.amount, expense.currency);
}

export function printRevolutExpenseList(expenses: RevolutExpense[]): void {
  if (expenses.length === 0) {
    console.log('No expenses found');
    return;
  }

  console.log(`Expenses (${expenses.length})\n`);

  let withReceipts = 0;

  for (const expense of expenses) {
    const label = expense.merchant || expense.description || expense.category || '';
    console.log(`${expenseDate(expense)} | ${expenseAmount(expense)} | ${expense.state}`);
    if (label) console.log(`    ${label}`);

    const count = expense.receiptIds.length;
    if (count > 0) withReceipts += 1;
    console.log(`    Receipts: ${count === 0 ? 'none' : count}`);
    console.log(`    ID: ${expense.id}`);
    console.log('');
  }

  console.log(`${withReceipts} of ${expenses.length} have a receipt`);
}

export function printRevolutExpense(expense: RevolutExpense): void {
  console.log(`ID: ${expense.id}`);
  console.log(`State: ${expense.state}`);
  if (expense.expenseDate) console.log(`Date: ${expense.expenseDate}`);
  if (expense.completedAt) console.log(`Completed: ${expense.completedAt}`);
  if (expense.amount !== undefined && expense.currency) {
    console.log(`Amount: ${formatAmount(expense.amount, expense.currency)}`);
  }
  if (expense.merchant) console.log(`Merchant: ${expense.merchant}`);
  if (expense.category) console.log(`Category: ${expense.category}`);
  if (expense.description) console.log(`Description: ${expense.description}`);
  if (expense.spender) console.log(`Spender: ${expense.spender}`);
  if (expense.transactionId) console.log(`Transaction: ${expense.transactionId}`);

  if (expense.receiptIds.length === 0) {
    console.log('Receipts: none');
    return;
  }

  console.log(`Receipts (${expense.receiptIds.length}):`);
  for (const receiptId of expense.receiptIds) {
    console.log(`  ${receiptId}`);
  }
  console.log(`\nDownload them with: agentio revolut receipt ${expense.id}`);
}

export function printRevolutExpensesCsv(expenses: RevolutExpense[]): void {
  const escape = (value: string | number | undefined): string => {
    if (value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  console.log('date,expense_id,state,amount,currency,merchant,category,description,spender,transaction_id,receipt_count,receipt_ids');

  for (const expense of expenses) {
    console.log([
      escape(expense.expenseDate || expense.completedAt),
      escape(expense.id),
      escape(expense.state),
      escape(expense.amount === undefined ? undefined : expense.amount.toFixed(2)),
      escape(expense.currency),
      escape(expense.merchant),
      escape(expense.category),
      escape(expense.description),
      escape(expense.spender),
      escape(expense.transactionId),
      escape(expense.receiptIds.length),
      escape(expense.receiptIds.join(' ')),
    ].join(','));
  }
}

function describeCounterpartyAccount(account: RevolutCounterparty['accounts'][number]): string {
  return account.iban || account.accountNo || account.id || '(no account number)';
}

export function printRevolutCounterpartyList(counterparties: RevolutCounterparty[]): void {
  if (counterparties.length === 0) {
    console.log('No counterparties found');
    return;
  }

  console.log(`Counterparties (${counterparties.length})\n`);

  for (const counterparty of counterparties) {
    const inactive = counterparty.state === 'created' ? '' : ` [${counterparty.state}]`;
    console.log(`${counterparty.id} | ${counterparty.name}${inactive}`);
    if (counterparty.country) console.log(`    Country: ${counterparty.country}`);
    for (const account of counterparty.accounts) {
      const currency = account.currency ? ` ${account.currency}` : '';
      console.log(`    ${describeCounterpartyAccount(account)}${currency}`);
    }
    console.log('');
  }
}

export function printRevolutCounterparty(counterparty: RevolutCounterparty): void {
  console.log(`ID: ${counterparty.id}`);
  console.log(`Name: ${counterparty.name}`);
  console.log(`State: ${counterparty.state}`);
  if (counterparty.profileType) console.log(`Profile type: ${counterparty.profileType}`);
  if (counterparty.country) console.log(`Country: ${counterparty.country}`);
  if (counterparty.phone) console.log(`Phone: ${counterparty.phone}`);
  console.log(`Created: ${counterparty.createdAt}`);

  if (counterparty.accounts.length > 0) {
    console.log('---');
    for (const account of counterparty.accounts) {
      console.log(`\n[Account ${account.id || '-'}]`);
      if (account.name) console.log(`Name: ${account.name}`);
      if (account.currency) console.log(`Currency: ${account.currency}`);
      if (account.type) console.log(`Type: ${account.type}`);
      if (account.iban) console.log(`IBAN: ${account.iban}`);
      if (account.accountNo) console.log(`Account number: ${account.accountNo}`);
      if (account.bic) console.log(`BIC: ${account.bic}`);
      if (account.sortCode) console.log(`Sort code: ${account.sortCode}`);
      if (account.routingNumber) console.log(`Routing number: ${account.routingNumber}`);
      if (account.bankCountry) console.log(`Bank country: ${account.bankCountry}`);
      if (account.recipientCharges) console.log(`Recipient charges: ${account.recipientCharges}`);
    }
  }
}

export function printRevolutCounterpartyDeleted(id: string): void {
  console.log(`Deleted counterparty: ${id}`);
}

export function printRevolutTransferResult(result: RevolutTransferResult, summary: string): void {
  console.log(summary);
  console.log(`ID: ${result.id}`);
  console.log(`State: ${result.state}`);
  console.log(`Created: ${result.createdAt}`);
  if (result.completedAt) console.log(`Completed: ${result.completedAt}`);
}

export function printRevolutPaymentDraftCreated(id: string, summary: string): void {
  console.log(summary);
  console.log(`Draft ID: ${id}`);
  console.log('Nothing has moved yet - approve it in the Revolut Business app to send it.');
}

export function printRevolutPaymentDraftList(drafts: RevolutPaymentDraftSummary[]): void {
  if (drafts.length === 0) {
    console.log('No payment drafts found');
    return;
  }

  console.log(`Payment drafts (${drafts.length})\n`);

  for (const draft of drafts) {
    const title = draft.title || '(untitled)';
    console.log(`${draft.id} | ${title}`);
    console.log(`    Payments: ${draft.paymentsCount}`);
    if (draft.scheduledFor) console.log(`    Scheduled for: ${draft.scheduledFor}`);
    if (draft.source) console.log(`    Source: ${draft.source}`);
    console.log('');
  }
}

export function printRevolutPaymentDraft(id: string, draft: RevolutPaymentDraft): void {
  console.log(`ID: ${id}`);
  if (draft.title) console.log(`Title: ${draft.title}`);
  if (draft.scheduledFor) console.log(`Scheduled for: ${draft.scheduledFor}`);
  if (draft.source) console.log(`Source: ${draft.source}`);

  for (const payment of draft.payments) {
    console.log(`\n[Payment ${payment.id}]`);
    console.log(`Amount: ${formatAmount(payment.amount, payment.currency || '')}`.trimEnd());
    console.log(`State: ${payment.state}`);
    console.log(`From account: ${payment.accountId}`);
    if (payment.counterpartyId) console.log(`Counterparty: ${payment.counterpartyId}`);
    if (payment.counterpartyAccountId) console.log(`Counterparty account: ${payment.counterpartyAccountId}`);
    if (payment.counterpartyCardId) console.log(`Counterparty card: ${payment.counterpartyCardId}`);
    if (payment.reference) console.log(`Reference: ${payment.reference}`);
    if (payment.transferReasonCode) console.log(`Transfer reason: ${payment.transferReasonCode}`);
    if (payment.reason) console.log(`Reason: ${payment.reason}`);
    if (payment.errorMessage) console.log(`Error: ${payment.errorMessage}`);

    const charge = payment.charge;
    if (charge?.rate && charge.fromCurrency !== charge.toCurrency) {
      console.log(`Rate: ${charge.rate}`);
    }
    if (charge?.feeAmount !== undefined && charge.feeCurrency) {
      console.log(`Fee: ${formatAmount(charge.feeAmount, charge.feeCurrency)}`);
    }
  }
}

export function printRevolutPaymentDraftDeleted(id: string): void {
  console.log(`Deleted payment draft: ${id}`);
}

export function printRevolutPayoutLink(link: RevolutPayoutLink): void {
  console.log(`ID: ${link.id}`);
  console.log(`State: ${link.state}`);
  console.log(`Recipient: ${link.counterpartyName}`);
  console.log(`Amount: ${formatAmount(link.amount, link.currency)}`);
  console.log(`Reference: ${link.reference}`);
  if (link.url) console.log(`URL: ${link.url}`);
  console.log(`From account: ${link.accountId}`);
  console.log(`Payout methods: ${link.payoutMethods.join(', ') || '-'}`);
  console.log(`Save counterparty: ${link.saveCounterparty ? 'yes' : 'no'}`);
  if (link.expiryDate) console.log(`Expires: ${link.expiryDate}`);
  console.log(`Created: ${link.createdAt}`);
  if (link.transferReasonCode) console.log(`Transfer reason: ${link.transferReasonCode}`);
  if (link.counterpartyId) console.log(`Counterparty: ${link.counterpartyId}`);
  if (link.transactionId) console.log(`Transaction: ${link.transactionId}`);
  if (link.cancellationReason) console.log(`Cancellation reason: ${link.cancellationReason}`);
}

export function printRevolutPayoutLinkList(links: RevolutPayoutLink[]): void {
  if (links.length === 0) {
    console.log('No payout links found');
    return;
  }

  console.log(`Payout links (${links.length})\n`);

  for (const link of links) {
    console.log(`${link.id} | ${formatAmount(link.amount, link.currency)} | ${link.state}`);
    console.log(`    Recipient: ${link.counterpartyName}`);
    console.log(`    Reference: ${link.reference}`);
    if (link.url) console.log(`    URL: ${link.url}`);
    console.log('');
  }
}

export function printRevolutPayoutLinkCancelled(id: string): void {
  console.log(`Cancelled payout link: ${id}`);
}
