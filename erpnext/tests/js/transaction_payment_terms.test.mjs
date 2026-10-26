import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/js/controllers/transaction.js"
);

// loads TransactionController with frappe.call answering every request with `response`
function controller(doc, { response, has_due_date = true } = {}) {
  const calls = [];
  const set_values = [];
  const frappe = {
    call: (opts) => {
      calls.push(opts);
      opts.callback?.({ message: response });
    },
    ui: { form: { trigger: () => {} } },
  };
  const context = {
    erpnext: { taxes_and_totals: class {} },
    frappe,
    refresh_field: () => {},
  };
  vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), context);

  const me = Object.create(context.erpnext.TransactionController.prototype);
  me.frm = {
    doc,
    fields_dict: has_due_date ? { due_date: {} } : {},
    set_value: (field, value) => {
      set_values.push(field);
      doc[field] = value;
    },
    refresh_field: () => {},
  };
  me.get_company_currency = () => "INR";
  me.update_payment_schedule_grid_labels = () => {};
  me.recalculate_terms = () => {};
  return { me, calls, set_values };
}

const invoice = (overrides = {}) => ({
  doctype: "Purchase Invoice",
  supplier: "Supplier X",
  company: "Test Company",
  posting_date: "2026-10-26",
  due_date: "2026-11-25",
  payment_terms_template: "Test 15 Days",
  grand_total: 100,
  ...overrides,
});

describe("Payment terms template on an invoice", () => {
  it("moves the due date to the regenerated payment schedule", () => {
    const doc = invoice();
    const { me, set_values } = controller(doc, {
      response: [{ due_date: "2026-11-10" }],
    });

    me.payment_terms_template();

    assert.equal(doc.due_date, "2026-11-10");
    // not through set_value, which would offer to clear the template
    assert.deepEqual(set_values, ["payment_schedule"]);
  });

  it("uses the last instalment when the template has several terms", () => {
    const doc = invoice();
    const { me } = controller(doc, {
      response: [{ due_date: "2026-12-10" }, { due_date: "2026-11-10" }],
    });

    me.payment_terms_template();

    assert.equal(doc.due_date, "2026-12-10");
  });

  it("leaves documents without a due date alone", () => {
    const doc = invoice({ doctype: "Sales Order", due_date: undefined });
    const { me } = controller(doc, {
      response: [{ due_date: "2026-11-10" }],
      has_due_date: false,
    });

    me.payment_terms_template();

    assert.equal(doc.due_date, undefined);
  });

  it("asks for the due date of the invoice's own template when the posting date changes", () => {
    const doc = invoice({ posting_date: "2026-10-30" });
    const { me, calls } = controller(doc, { response: "2026-11-14" });

    me.posting_date();

    assert.equal(calls[0].method, "erpnext.accounts.party.get_due_date");
    assert.equal(calls[0].args.template_name, "Test 15 Days");
    assert.equal(doc.due_date, "2026-11-14");
  });
});
