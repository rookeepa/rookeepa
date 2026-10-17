
import { DB } from "./app/core/db.js";
import { seedDemoCompany } from "./app/core/sample.js";
import { documentSummary } from "./app/core/docs.js";
const AS_OF = "2026-10-14";
const db = await DB.open({ forceMemory: true, debounceMs: 0 });
const company = seedDemoCompany(db, { asOf: AS_OF });
const taxCodes = db.of("taxCodes", company.id);
const payments = db.of("payments", company.id);
const docs = db.of("documents", company.id).filter(d => d.type === "invoice");
console.log("--- invoices ---");
for (const d of docs) {
  const s = documentSummary(d, taxCodes, payments, AS_OF);
  const alloc = payments.flatMap(p => (p.allocations||[]).filter(a => a.docId === d.id).map(a => ({ num: p.number, amt: a.amount })));
  console.log(`${d.number} ${d.date} total=${s.total} paid=${s.paid} bal=${s.balance} ${s.status} alloc=${JSON.stringify(alloc)}`);
}
console.log("--- payments ---");
for (const p of payments) {
  console.log(`${p.number} ${p.type} ${p.date} amt=${p.amount} allocs=${JSON.stringify((p.allocations||[]).map(a=>[a.docNumber,a.amount]))}`);
}
const receiptSpecs = [0,1,3,5];
console.log("--- doc ids referenced by receipts ---");
for (const i of receiptSpecs) console.log(i, docs[i]?.number, docs[i]?.id);
