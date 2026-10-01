/**
 * The schema migrations. Ids are plain integers and MUST apply in numeric
 * order — several steps depend on tables created by earlier steps.
 */
export function makeMigrations() {
  return [
    { id: 1, up: (db) => { db.users = { columns: ["id", "email"] }; } },
    { id: 2, up: (db) => { db.users.columns.push("name"); } },
    { id: 3, up: (db) => { db.orders = { columns: ["id", "user_id", "total_cents"], indexes: [] }; } },
    { id: 4, up: (db) => { db.orders.columns.push("status"); } },
    { id: 5, up: (db) => { if (!db.users) throw new Error("users table missing"); db.users.indexes = ["users_email_key"]; } },
    { id: 6, up: (db) => { db.orders.indexes.push("orders_user_idx"); } },
    { id: 7, up: (db) => { db.coupons = { columns: ["id", "code", "percent"] }; } },
    { id: 8, up: (db) => { db.orders.columns.push("coupon_id"); } },
    { id: 9, up: (db) => { db.audit = { events: [] }; } },
    { id: 10, up: (db) => { if (!db.orders) throw new Error("orders table missing"); db.orders.indexes.push("orders_status_idx"); } },
    { id: 11, up: (db) => { db.audit.events.push("backfill"); } },
    { id: 12, up: (db) => { if (!db.coupons) throw new Error("coupons table missing"); db.coupons.columns.push("expires_at"); } },
  ];
}
