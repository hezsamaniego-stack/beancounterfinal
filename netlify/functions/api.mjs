import { getConnectionString } from "@netlify/database";
import pg from "pg";

pg.types.setTypeParser(1082, (v) => v); // keep DATE columns as plain text
let pool;

const T = {
  supplier: { pk: "supplier_id", cols: ["name", "contact_name", "email", "phone"] },
  bean: { pk: "bean_id", cols: ["name", "origin_country", "roast_level", "stock_kg", "reorder_level_kg", "supplier_id", "price_per_kg"] },
  customer: { pk: "customer_id", cols: ["first_name", "last_name", "email", "phone"] },
  bean_order: { pk: "bean_order_id", cols: ["supplier_id", "order_date", "expected_date", "status", "notes"] },
  bean_order_item: { pk: "bean_order_item_id", cols: ["bean_order_id", "bean_id", "quantity_kg", "price_per_kg"] },
};
const L = {
  supplier: "SELECT * FROM supplier ORDER BY name",
  bean: `SELECT b.*, s.name AS supplier_name, (b.stock_kg <= b.reorder_level_kg) AS low,
      COALESCE((SELECT SUM(i.quantity_kg) FROM bean_order_item i JOIN bean_order o ON o.bean_order_id = i.bean_order_id
                WHERE i.bean_id = b.bean_id AND o.status = 'Ordered'), 0) AS in_transit_kg
    FROM bean b LEFT JOIN supplier s ON s.supplier_id = b.supplier_id ORDER BY b.name`,
  customer: "SELECT * FROM customer ORDER BY last_name, first_name",
  bean_order: `SELECT o.*, s.name AS supplier_name, c.first_name || ' ' || c.last_name AS customer_name,
      COALESCE((SELECT SUM(i.quantity_kg * i.price_per_kg) FROM bean_order_item i WHERE i.bean_order_id = o.bean_order_id), 0) AS total
    FROM bean_order o JOIN supplier s ON s.supplier_id = o.supplier_id
    LEFT JOIN customer c ON c.customer_id = o.customer_id
    ORDER BY o.order_date DESC, o.bean_order_id DESC`,
  bean_order_item: `SELECT i.*, b.name AS bean_name, i.quantity_kg * i.price_per_kg AS line_total
    FROM bean_order_item i JOIN bean b ON b.bean_id = i.bean_id
    WHERE i.bean_order_id = $1 ORDER BY b.name`,
};
const MSG = {
  23001: "That record is used by other records (for example a supplier with orders), so it can't be deleted.",
  23503: "That record is linked to other records, so it can't be deleted (or the linked record doesn't exist).",
  23505: "That value already exists. It must be unique.",
  23502: "A required field is empty.",
  23514: "A value is out of range or not allowed (for example, stock can't go below zero).",
  "22P02": "A number or date is not in a valid format.",
  22003: "A number is too large.",
  22007: "A date is not in a valid format.",
  22008: "A date is not in a valid format.",
};
// Beans get used up over time: every DEPLETE_SECS seconds each bean loses DEPLETE_KG (never below 0).
// Only one request per interval wins the update, so extra tabs don't use beans up faster.
const DEPLETE_KG = 0.5;
const DEPLETE_SECS = 15;
const DEPLETE = `WITH t AS (
    UPDATE bean_depletion SET last_tick = now()
    WHERE id = 1 AND last_tick <= now() - interval '${DEPLETE_SECS} seconds' RETURNING id)
  UPDATE bean SET stock_kg = GREATEST(stock_kg - ${DEPLETE_KG}, 0) WHERE EXISTS (SELECT 1 FROM t)`;
const LOCK = "This order is already Received, so its items are locked. Change the status back to Ordered first.";
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Orders placed from "Order Beans" arrive automatically: once their arrival time has passed, mark them Received and add the beans to stock.
const ARRIVALS = `WITH due AS (
    UPDATE bean_order SET status = 'Received'
    WHERE status = 'Ordered' AND arrives_at IS NOT NULL AND arrives_at <= now() RETURNING bean_order_id)
  UPDATE bean SET stock_kg = bean.stock_kg + s.q
  FROM (SELECT i.bean_id, SUM(i.quantity_kg) AS q FROM bean_order_item i JOIN due ON due.bean_order_id = i.bean_order_id GROUP BY i.bean_id) s
  WHERE s.bean_id = bean.bean_id`;

async function placeOrder(req) {
  const { items, customer } = await req.json();
  const want = (items || [])
    .map((i) => ({ bean_id: Number(i.bean_id), qty: Number(i.quantity_kg), supplier_id: Number(i.supplier_id) || null }))
    .filter((i) => i.bean_id && i.qty > 0);
  if (!want.length) return json({ error: "Enter a quantity for at least one bean." }, 400);
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const cu = { first_name: clean(customer?.first_name), last_name: clean(customer?.last_name), email: clean(customer?.email), phone: clean(customer?.phone) };
  if (!cu.first_name || !cu.last_name) return json({ error: "Please enter the customer's first and last name." }, 400);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query("SELECT bean_id, name, supplier_id, price_per_kg FROM bean WHERE bean_id = ANY($1::int[])", [want.map((w) => w.bean_id)]);
    const by = new Map(rows.map((r) => [r.bean_id, r]));
    const groups = new Map();
    for (const w of want) {
      const b = by.get(w.bean_id);
      if (!b) throw Object.assign(new Error("unknown bean"), { friendly: "One of those beans no longer exists." });
      const sid = w.supplier_id || b.supplier_id; // the supplier picked on the order page, else the bean's usual one
      if (!sid) throw Object.assign(new Error("no supplier"), { friendly: `Choose a supplier for ${b.name}.` });
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push({ ...w, price: b.price_per_kg });
    }
    const found = await c.query("SELECT supplier_id FROM supplier WHERE supplier_id = ANY($1::int[])", [[...groups.keys()]]);
    if (found.rowCount !== groups.size) throw Object.assign(new Error("unknown supplier"), { friendly: "One of those suppliers no longer exists." });

    // Save the customer: update them if they already exist (matched by email, or by name when there is no email), otherwise add them.
    let cid;
    if (cu.email) {
      cid = (
        await c.query(
          `INSERT INTO customer (first_name, last_name, email, phone) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, phone = COALESCE(EXCLUDED.phone, customer.phone)
           RETURNING customer_id`,
          [cu.first_name, cu.last_name, cu.email, cu.phone]
        )
      ).rows[0].customer_id;
    } else {
      const ex = await c.query(
        "SELECT customer_id FROM customer WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2) ORDER BY customer_id LIMIT 1",
        [cu.first_name, cu.last_name]
      );
      if (ex.rowCount) {
        cid = ex.rows[0].customer_id;
        if (cu.phone) await c.query("UPDATE customer SET phone = $1 WHERE customer_id = $2", [cu.phone, cid]);
      } else {
        cid = (await c.query("INSERT INTO customer (first_name, last_name, phone) VALUES ($1, $2, $3) RETURNING customer_id", [cu.first_name, cu.last_name, cu.phone])).rows[0].customer_id;
      }
    }

    const orderIds = [];
    for (const [sid, list] of groups) {
      const o = await c.query(
        "INSERT INTO bean_order (supplier_id, customer_id, status, notes, arrives_at) VALUES ($1, $2, 'Ordered', 'Placed from Order Beans', now() + interval '5 seconds') RETURNING bean_order_id",
        [sid, cid]
      );
      orderIds.push(o.rows[0].bean_order_id);
      for (const l of list) {
        await c.query("INSERT INTO bean_order_item (bean_order_id, bean_id, quantity_kg, price_per_kg) VALUES ($1, $2, $3, $4)", [o.rows[0].bean_order_id, l.bean_id, l.qty, l.price]);
        // the supplier you ordered from now shows on the Beans (Supply) page
        await c.query("UPDATE bean SET supplier_id = $1 WHERE bean_id = $2 AND supplier_id IS DISTINCT FROM $1", [sid, l.bean_id]);
      }
    }
    await c.query("COMMIT");
    return json({ orders: groups.size, order_ids: orderIds, customer_id: cid }, 201);
  } catch (e) {
    await c.query("ROLLBACK");
    if (e.friendly) return json({ error: e.friendly }, 400);
    throw e;
  } finally {
    c.release();
  }
}

async function orderIsReceived(orderId) {
  if (!orderId) return false;
  const r = await pool.query("SELECT 1 FROM bean_order WHERE bean_order_id = $1 AND status = 'Received'", [orderId]);
  return r.rowCount > 0;
}
async function parentOrderOfItem(id) {
  const r = await pool.query("SELECT bean_order_id FROM bean_order_item WHERE bean_order_item_id = $1", [id]);
  return r.rows[0]?.bean_order_id;
}

export default async (req) => {
  pool ??= new pg.Pool({ connectionString: await getConnectionString(), max: 3 });
  const u = new URL(req.url);
  const [, , table, id] = u.pathname.split("/");
  if (table === "place_order" && req.method === "POST") {
    try {
      return await placeOrder(req);
    } catch (e) {
      console.error(e);
      return json({ error: MSG[e.code] || "Something went wrong. Please try again." }, 400);
    }
  }
  const t = T[table];
  if (!t) return json({ error: "Unknown table" }, 404);
  try {
    if (req.method === "GET") {
      await pool.query(ARRIVALS);
      await pool.query(DEPLETE);
      const r = await pool.query(L[table], table === "bean_order_item" ? [u.searchParams.get("order")] : []);
      return json(r.rows);
    }
    if (req.method === "DELETE") {
      if (table === "bean_order_item" && (await orderIsReceived(await parentOrderOfItem(id)))) return json({ error: LOCK }, 400);
      if (table === "bean_order" && (await orderIsReceived(id)))
        return json({ error: "Received orders already added stock, so they can't be deleted. Change the status first." }, 400);
      await pool.query(`DELETE FROM ${table} WHERE ${t.pk} = $1`, [id]);
      return json({ ok: true });
    }
    const b = await req.json();
    if (req.method === "PUT" && table === "bean_order_item") delete b.bean_order_id;
    const val = (c) => (b[c] === "" ? null : b[c]);
    if (table === "bean_order_item") {
      const oid = req.method === "POST" ? b.bean_order_id : await parentOrderOfItem(id);
      if (await orderIsReceived(oid)) return json({ error: LOCK }, 400);
    }
    if (req.method === "POST") {
      const ks = t.cols.filter((c) => b[c] !== undefined && val(c) !== null);
      const r = await pool.query(
        `INSERT INTO ${table} (${ks.join(",")}) VALUES (${ks.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
        ks.map(val)
      );
      return json(r.rows[0], 201);
    }
    if (req.method === "PUT") {
      const ks = t.cols.filter((c) => b[c] !== undefined);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        let old;
        if (table === "bean_order") old = (await c.query("SELECT status FROM bean_order WHERE bean_order_id = $1 FOR UPDATE", [id])).rows[0]?.status;
        const r = await c.query(
          `UPDATE ${table} SET ${ks.map((k, i) => `${k} = $${i + 1}`).join(",")} WHERE ${t.pk} = $${ks.length + 1} RETURNING *`,
          [...ks.map(val), id]
        );
        if (table === "bean_order" && old && b.status && old !== b.status) {
          const dir = b.status === "Received" ? 1 : old === "Received" ? -1 : 0;
          if (dir === -1) await c.query("UPDATE bean_order SET arrives_at = NULL WHERE bean_order_id = $1", [id]);
          if (dir)
            await c.query(
              "UPDATE bean SET stock_kg = stock_kg + $1::numeric * i.quantity_kg FROM bean_order_item i WHERE i.bean_id = bean.bean_id AND i.bean_order_id = $2",
              [dir, id]
            );
        }
        await c.query("COMMIT");
        return json(r.rows[0]);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: MSG[e.code] || "Something went wrong. Please check your entries and try again." }, 400);
  }
};

export const config = { path: "/api/*" };
