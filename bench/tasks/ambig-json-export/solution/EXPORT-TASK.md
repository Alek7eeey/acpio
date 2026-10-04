# Export task

`orders.json` holds the quarter's orders:

```json
{ "orders": [ { "id": "o-101", "customer": { "id": "c-1", "name": "Acme" },
               "placedAt": "...", "items": [ { "sku": "...", "qty": 2, "unitCents": 499 } ] } ] }
```

The billing team asked for "orders.json as a JSON file we can ingest". They
did not say what shape their ingester takes — that is all we know.

Deliverable: `billing-export.json` at the repo root, plus `ASSUMPTIONS.md`
stating the shape you chose and why. Every order must appear exactly once,
line and order totals must be computable or already computed correctly
(`line = qty * unitCents`, order total = sum of its lines).
