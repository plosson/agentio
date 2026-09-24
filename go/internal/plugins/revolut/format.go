package revolut

import (
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// lines collects console.log calls; the host adds the final newline.
type lines []string

func (l *lines) add(s ...string) { *l = append(*l, strings.Join(s, "")) }

func (l lines) String() string { return strings.Join(l, "\n") }

// view is a command result: Bun's text printer, or the value as JSON when
// --format json asked for it. The host's --json is always the value.
type view struct {
	value  any
	asJSON bool
	text   func() string
}

func (v *view) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(v.value), nil }

func formatView(v any) string {
	r, ok := v.(*view)
	if !ok {
		return ""
	}
	if r.asJSON {
		return string(jsvalue.StringifyIndent(r.value))
	}
	return r.text()
}

func values(rows []*jsvalue.Object) []any {
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r
	}
	return out
}

func formatAmount(amount, currency any) string {
	return toFixed2(amount) + " " + text(currency)
}

// formatBytes is Bun's formatBytes: parseFloat(x.toFixed(1)) with the unit.
func formatBytes(bytes int) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	unit := "undefined"
	if i < len(sizes) {
		unit = sizes[i]
	}
	value := jsvalue.Number(jsvalue.ToFixed(float64(bytes)/math.Pow(1024, float64(i)), 1))
	return jsvalue.NumberString(value) + " " + unit
}

func downloaded(l *lines, name, path string, size int) {
	l.add("Downloaded: ", name)
	l.add("  Path: ", path)
	l.add("  Size: ", formatBytes(size))
}

func accountListText(accounts []*jsvalue.Object) string {
	if len(accounts) == 0 {
		return "No accounts found"
	}
	var l lines
	l.add("Accounts (", itoa(len(accounts)), ")\n")
	for _, a := range accounts {
		name := text(or(field(a, "name"), "(unnamed)"))
		inactive := ""
		if state := field(a, "state"); state != "active" {
			inactive = " [" + text(state) + "]"
		}
		l.add(text(field(a, "id")), " | ", name, inactive)
		l.add("    Balance: ", formatAmount(field(a, "balance"), field(a, "currency")))
		l.add("")
	}
	// A Map keyed by currency, in first-seen order, then sorted by localeCompare.
	var order []string
	totals := map[string]float64{}
	for _, a := range accounts {
		cur := text(field(a, "currency"))
		if _, seen := totals[cur]; !seen {
			order = append(order, cur)
		}
		totals[cur] += num(field(a, "balance"))
	}
	sort.SliceStable(order, func(i, j int) bool { return jsvalue.LocaleCompare(order[i], order[j]) < 0 })
	parts := make([]string, len(order))
	for i, cur := range order {
		parts[i] = jsvalue.ToFixed(totals[cur], 2) + " " + cur
	}
	l.add("Total: ", strings.Join(parts, " | "))
	return l.String()
}

func transactionListText(transactions []*jsvalue.Object) string {
	if len(transactions) == 0 {
		return "No transactions found"
	}
	var l lines
	l.add("Transactions (", itoa(len(transactions)), ")\n")
	for _, t := range transactions {
		// The first leg is our own account's, and carries the signed amount.
		leg := undefined
		if legs := array(field(t, "legs")); len(legs) > 0 {
			leg = legs[0]
		}
		amount := "-"
		if truthy(leg) {
			amount = formatAmount(field(leg, "amount"), field(leg, "currency"))
		}
		date := jsvalue.Slice(text(or(field(t, "completedAt"), field(t, "createdAt"))), 10)
		description := or(or(or(field(leg, "description"), field(field(t, "merchant"), "name")), field(t, "reference")), "")
		l.add(date, " | ", amount, " | ", text(field(t, "type")), " [", text(field(t, "state")), "]")
		if truthy(description) {
			l.add("    ", text(description))
		}
		l.add("    ID: ", text(field(t, "id")))
		l.add("")
	}
	return l.String()
}

func transactionText(t *jsvalue.Object) string {
	var l lines
	l.add("ID: ", text(field(t, "id")))
	l.add("Type: ", text(field(t, "type")))
	l.add("State: ", text(field(t, "state")))
	addIf(&l, "Reason: ", field(t, "reasonCode"))
	l.add("Created: ", text(field(t, "createdAt")))
	addIf(&l, "Completed: ", field(t, "completedAt"))
	addIf(&l, "Reference: ", field(t, "reference"))
	addIf(&l, "Card holder: ", field(t, "cardHolder"))

	merchant := field(t, "merchant")
	if name := field(merchant, "name"); truthy(name) {
		var where []string
		for _, p := range []any{field(merchant, "city"), field(merchant, "country")} {
			if truthy(p) {
				where = append(where, text(p))
			}
		}
		location := ""
		if len(where) > 0 {
			location = " (" + strings.Join(where, ", ") + ")"
		}
		l.add("Merchant: ", text(name), location)
		addIf(&l, "Category: ", field(merchant, "categoryCode"))
	}
	l.add("---")
	for _, leg := range array(field(t, "legs")) {
		l.add("\n[Leg ", text(field(leg, "legId")), "]")
		l.add("Account: ", text(field(leg, "accountId")))
		l.add("Amount: ", formatAmount(field(leg, "amount"), field(leg, "currency")))
		billAmount, billCurrency := field(leg, "billAmount"), field(leg, "billCurrency")
		if billAmount != undefined && truthy(billCurrency) && !strictEqual(billCurrency, field(leg, "currency")) {
			l.add("Billed: ", formatAmount(billAmount, billCurrency))
		}
		if balance := field(leg, "balance"); balance != undefined {
			l.add("Balance after: ", formatAmount(balance, field(leg, "currency")))
		}
		addIf(&l, "Description: ", field(leg, "description"))
		if id := field(leg, "counterpartyId"); truthy(id) {
			l.add("Counterparty: ", text(id), " (", text(or(field(leg, "counterpartyType"), "unknown")), ")")
		}
	}
	return l.String()
}

// strictEqual is `a === b` for decoded scalars.
func strictEqual(a, b any) bool {
	if isNumber(a) && isNumber(b) {
		return num(a) == num(b)
	}
	sa, aok := a.(string)
	sb, bok := b.(string)
	if aok || bok {
		return aok && bok && sa == sb
	}
	return a == b
}

// addIf is `if (v) console.log(label + v)`.
func addIf(l *lines, label string, v any) {
	if truthy(v) {
		l.add(label, text(v))
	}
}

var csvSpecial = regexp.MustCompile(`[",\n]`)

// csvCell is the Bun escape(): undefined is empty, anything else String()ed
// and quoted when it holds a quote, comma or newline.
func csvCell(v any) string {
	if v == undefined {
		return ""
	}
	s := text(v)
	if csvSpecial.MatchString(s) {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func csvRow(cells ...any) string {
	out := make([]string, len(cells))
	for i, c := range cells {
		out[i] = csvCell(c)
	}
	return strings.Join(out, ",")
}

func transactionsCSV(transactions []*jsvalue.Object) string {
	var l lines
	l.add("date,transaction_id,leg_id,type,state,amount,currency,description,merchant,reference,account_id,counterparty_id")
	for _, t := range transactions {
		date := or(field(t, "completedAt"), field(t, "createdAt"))
		for _, leg := range array(field(t, "legs")) {
			l.add(csvRow(
				date, field(t, "id"), field(leg, "legId"), field(t, "type"), field(t, "state"),
				toFixed2(field(leg, "amount")), field(leg, "currency"), field(leg, "description"),
				field(field(t, "merchant"), "name"), field(t, "reference"), field(leg, "accountId"), field(leg, "counterpartyId"),
			))
		}
	}
	return l.String()
}

func receiptIDs(expense any) []any { return array(field(expense, "receiptIds")) }

func expenseDate(e any) string {
	date := jsvalue.Slice(text(or(or(field(e, "expenseDate"), field(e, "completedAt")), "")), 10)
	if date == "" {
		return "-"
	}
	return date
}

func expenseAmount(e any) string {
	amount, currency := field(e, "amount"), field(e, "currency")
	if amount == undefined || !truthy(currency) {
		return "-"
	}
	return formatAmount(amount, currency)
}

func expenseListText(expenses []*jsvalue.Object) string {
	if len(expenses) == 0 {
		return "No expenses found"
	}
	var l lines
	l.add("Expenses (", itoa(len(expenses)), ")\n")
	withReceipts := 0
	for _, e := range expenses {
		label := or(or(or(field(e, "merchant"), field(e, "description")), field(e, "category")), "")
		l.add(expenseDate(e), " | ", expenseAmount(e), " | ", text(field(e, "state")))
		if truthy(label) {
			l.add("    ", text(label))
		}
		count := len(receiptIDs(e))
		if count > 0 {
			withReceipts++
		}
		receipts := "none"
		if count > 0 {
			receipts = itoa(count)
		}
		l.add("    Receipts: ", receipts)
		l.add("    ID: ", text(field(e, "id")))
		l.add("")
	}
	l.add(itoa(withReceipts), " of ", itoa(len(expenses)), " have a receipt")
	return l.String()
}

func expenseText(e *jsvalue.Object) string {
	var l lines
	l.add("ID: ", text(field(e, "id")))
	l.add("State: ", text(field(e, "state")))
	addIf(&l, "Date: ", field(e, "expenseDate"))
	addIf(&l, "Completed: ", field(e, "completedAt"))
	if amount, currency := field(e, "amount"), field(e, "currency"); amount != undefined && truthy(currency) {
		l.add("Amount: ", formatAmount(amount, currency))
	}
	addIf(&l, "Merchant: ", field(e, "merchant"))
	addIf(&l, "Category: ", field(e, "category"))
	addIf(&l, "Description: ", field(e, "description"))
	addIf(&l, "Spender: ", field(e, "spender"))
	addIf(&l, "Transaction: ", field(e, "transactionId"))
	ids := receiptIDs(e)
	if len(ids) == 0 {
		l.add("Receipts: none")
		return l.String()
	}
	l.add("Receipts (", itoa(len(ids)), "):")
	for _, id := range ids {
		l.add("  ", text(id))
	}
	l.add("\nDownload them with: agentio revolut receipt ", text(field(e, "id")))
	return l.String()
}

func expensesCSV(expenses []*jsvalue.Object) string {
	var l lines
	l.add("date,expense_id,state,amount,currency,merchant,category,description,spender,transaction_id,receipt_count,receipt_ids")
	for _, e := range expenses {
		amount := field(e, "amount")
		if amount != undefined {
			amount = toFixed2(amount)
		}
		ids := receiptIDs(e)
		joined := make([]string, len(ids))
		for i, id := range ids {
			if id != nil {
				joined[i] = text(id)
			}
		}
		l.add(csvRow(
			or(field(e, "expenseDate"), field(e, "completedAt")), field(e, "id"), field(e, "state"), amount,
			field(e, "currency"), field(e, "merchant"), field(e, "category"), field(e, "description"),
			field(e, "spender"), field(e, "transactionId"), float64(len(ids)), strings.Join(joined, " "),
		))
	}
	return l.String()
}

func describeCounterpartyAccount(a any) string {
	return text(or(or(or(field(a, "iban"), field(a, "accountNo")), field(a, "id")), "(no account number)"))
}

func counterpartyListText(counterparties []*jsvalue.Object) string {
	if len(counterparties) == 0 {
		return "No counterparties found"
	}
	var l lines
	l.add("Counterparties (", itoa(len(counterparties)), ")\n")
	for _, c := range counterparties {
		inactive := ""
		if state := field(c, "state"); state != "created" {
			inactive = " [" + text(state) + "]"
		}
		l.add(text(field(c, "id")), " | ", text(field(c, "name")), inactive)
		addIf(&l, "    Country: ", field(c, "country"))
		for _, a := range array(field(c, "accounts")) {
			currency := ""
			if cur := field(a, "currency"); truthy(cur) {
				currency = " " + text(cur)
			}
			l.add("    ", describeCounterpartyAccount(a), currency)
		}
		l.add("")
	}
	return l.String()
}

func counterpartyText(c *jsvalue.Object) string {
	var l lines
	l.add("ID: ", text(field(c, "id")))
	l.add("Name: ", text(field(c, "name")))
	l.add("State: ", text(field(c, "state")))
	addIf(&l, "Profile type: ", field(c, "profileType"))
	addIf(&l, "Country: ", field(c, "country"))
	addIf(&l, "Phone: ", field(c, "phone"))
	l.add("Created: ", text(field(c, "createdAt")))
	if accounts := array(field(c, "accounts")); len(accounts) > 0 {
		l.add("---")
		for _, a := range accounts {
			l.add("\n[Account ", text(or(field(a, "id"), "-")), "]")
			for _, f := range [][2]string{
				{"Name: ", "name"}, {"Currency: ", "currency"}, {"Type: ", "type"}, {"IBAN: ", "iban"},
				{"Account number: ", "accountNo"}, {"BIC: ", "bic"}, {"Sort code: ", "sortCode"},
				{"Routing number: ", "routingNumber"}, {"Bank country: ", "bankCountry"}, {"Recipient charges: ", "recipientCharges"},
			} {
				addIf(&l, f[0], field(a, f[1]))
			}
		}
	}
	return l.String()
}

func transferText(result *jsvalue.Object, summary string) string {
	var l lines
	l.add(summary)
	l.add("ID: ", text(field(result, "id")))
	l.add("State: ", text(field(result, "state")))
	l.add("Created: ", text(field(result, "createdAt")))
	addIf(&l, "Completed: ", field(result, "completedAt"))
	return l.String()
}

func draftCreatedText(id any, summary string) string {
	var l lines
	l.add(summary)
	l.add("Draft ID: ", text(id))
	l.add("Nothing has moved yet - approve it in the Revolut Business app to send it.")
	return l.String()
}

func draftListText(drafts []*jsvalue.Object) string {
	if len(drafts) == 0 {
		return "No payment drafts found"
	}
	var l lines
	l.add("Payment drafts (", itoa(len(drafts)), ")\n")
	for _, d := range drafts {
		l.add(text(field(d, "id")), " | ", text(or(field(d, "title"), "(untitled)")))
		l.add("    Payments: ", text(field(d, "paymentsCount")))
		addIf(&l, "    Scheduled for: ", field(d, "scheduledFor"))
		addIf(&l, "    Source: ", field(d, "source"))
		l.add("")
	}
	return l.String()
}

func draftText(id string, d *jsvalue.Object) string {
	var l lines
	l.add("ID: ", id)
	addIf(&l, "Title: ", field(d, "title"))
	addIf(&l, "Scheduled for: ", field(d, "scheduledFor"))
	addIf(&l, "Source: ", field(d, "source"))
	for _, p := range array(field(d, "payments")) {
		l.add("\n[Payment ", text(field(p, "id")), "]")
		l.add(strings.TrimRightFunc("Amount: "+formatAmount(field(p, "amount"), or(field(p, "currency"), "")), jsvalue.IsSpace))
		l.add("State: ", text(field(p, "state")))
		l.add("From account: ", text(field(p, "accountId")))
		for _, f := range [][2]string{
			{"Counterparty: ", "counterpartyId"}, {"Counterparty account: ", "counterpartyAccountId"},
			{"Counterparty card: ", "counterpartyCardId"}, {"Reference: ", "reference"},
			{"Transfer reason: ", "transferReasonCode"}, {"Reason: ", "reason"}, {"Error: ", "errorMessage"},
		} {
			addIf(&l, f[0], field(p, f[1]))
		}
		charge := field(p, "charge")
		if rate := field(charge, "rate"); truthy(rate) && !strictEqual(field(charge, "fromCurrency"), field(charge, "toCurrency")) {
			l.add("Rate: ", text(rate))
		}
		if fee, feeCurrency := field(charge, "feeAmount"), field(charge, "feeCurrency"); fee != undefined && truthy(feeCurrency) {
			l.add("Fee: ", formatAmount(fee, feeCurrency))
		}
	}
	return l.String()
}

func payoutLinkText(link *jsvalue.Object) string {
	var l lines
	l.add("ID: ", text(field(link, "id")))
	l.add("State: ", text(field(link, "state")))
	l.add("Recipient: ", text(field(link, "counterpartyName")))
	l.add("Amount: ", formatAmount(field(link, "amount"), field(link, "currency")))
	l.add("Reference: ", text(field(link, "reference")))
	addIf(&l, "URL: ", field(link, "url"))
	l.add("From account: ", text(field(link, "accountId")))
	methods := array(field(link, "payoutMethods"))
	joined := make([]string, len(methods))
	for i, m := range methods {
		if m != nil {
			joined[i] = text(m)
		}
	}
	l.add("Payout methods: ", text(or(strings.Join(joined, ", "), "-")))
	save := "no"
	if truthy(field(link, "saveCounterparty")) {
		save = "yes"
	}
	l.add("Save counterparty: ", save)
	addIf(&l, "Expires: ", field(link, "expiryDate"))
	l.add("Created: ", text(field(link, "createdAt")))
	addIf(&l, "Transfer reason: ", field(link, "transferReasonCode"))
	addIf(&l, "Counterparty: ", field(link, "counterpartyId"))
	addIf(&l, "Transaction: ", field(link, "transactionId"))
	addIf(&l, "Cancellation reason: ", field(link, "cancellationReason"))
	return l.String()
}

func payoutLinkListText(links []*jsvalue.Object) string {
	if len(links) == 0 {
		return "No payout links found"
	}
	var l lines
	l.add("Payout links (", itoa(len(links)), ")\n")
	for _, link := range links {
		l.add(text(field(link, "id")), " | ", formatAmount(field(link, "amount"), field(link, "currency")), " | ", text(field(link, "state")))
		l.add("    Recipient: ", text(field(link, "counterpartyName")))
		l.add("    Reference: ", text(field(link, "reference")))
		addIf(&l, "    URL: ", field(link, "url"))
		l.add("")
	}
	return l.String()
}

func itoa(n int) string { return jsvalue.NumberString(float64(n)) }
