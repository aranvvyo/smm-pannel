import { getDb } from '../db.js';
import { startOfISTDay, startOfISTMonth } from './ist.js';

// Admin analytics. Profit = what the owner keeps after provider cost.
//   profit of an order = price_inr - base_cost_inr  (0 for no-profit users)
// All aggregates are computed in paise, then divided for display.

function aggOrders(where, params = []) {
  return getDb().prepare(
    `SELECT COALESCE(SUM(price_inr),0) AS revenue,
            COALESCE(SUM(base_cost_inr),0) AS cost,
            COUNT(*) AS orders_count
     FROM orders ${where}`
  ).get(...params);
}

export function profitMetrics() {
  const db = getDb();
  const now = Date.now();
  const today = aggOrders('WHERE created_at >= ?', [startOfISTDay(now)]);
  const month = aggOrders('WHERE created_at >= ?', [startOfISTMonth(now)]);
  const all = aggOrders('');
  const dailyProfit = today.revenue - today.cost;
  const monthlyProfit = month.revenue - month.cost;
  const totalProfit = all.revenue - all.cost;
  const profitPct = all.cost > 0 ? Math.round((totalProfit / all.cost) * 10000) / 100 : 0;

  return {
    totalRevenueInr: all.revenue,
    totalCostInr: all.cost,
    totalProfitInr: totalProfit,
    profitPct,
    daily: { revenueInr: today.revenue, costInr: today.cost, profitInr: dailyProfit, orders: today.orders_count },
    monthly: { revenueInr: month.revenue, costInr: month.cost, profitInr: monthlyProfit, orders: month.orders_count },
  };
}

export function depositStats() {
  const db = getDb();
  const now = Date.now();
  const confirmed = db.prepare(
    `SELECT COALESCE(SUM(amount_inr),0) AS total,
            COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_inr ELSE 0 END),0) AS today,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_inr ELSE 0 END),0) AS this_month,
            COUNT(CASE WHEN created_at >= ? THEN 1 END) AS today_count,
            COUNT(CASE WHEN created_at >= ? THEN 1 END) AS this_month_count
     FROM deposits WHERE status='confirmed'`
  ).get(startOfISTDay(now), startOfISTMonth(now), startOfISTDay(now), startOfISTMonth(now));
  return confirmed;
}

export function platformStats() {
  const db = getDb();
  return {
    users: db.prepare(`SELECT COUNT(*) c FROM users WHERE role='client'`).get().c,
    orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
    services: db.prepare('SELECT COUNT(*) c FROM services WHERE status=1').get().c,
    totalSpentInr: db.prepare(`SELECT COALESCE(SUM(total_spent_inr),0) c FROM users WHERE role='client'`).get().c,
  };
}

// Last N days daily series (IST buckets) for the admin charts.
export function dailySeries(days = 14) {
  const db = getDb();
  const out = [];
  const todayStart = startOfISTDay(Date.now());
  for (let d = days - 1; d >= 0; d--) {
    const start = todayStart - d * 86400000;
    const end = start + 86400000;
    const orders = aggOrders('WHERE created_at >= ? AND created_at < ?', [start, end]);
    const dep = db.prepare(
      `SELECT COALESCE(SUM(amount_inr),0) c FROM deposits WHERE status='confirmed' AND created_at >= ? AND created_at < ?`
    ).get(start, end);
    out.push({
      day: new Date(start + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
      revenueInr: orders.revenue,
      profitInr: orders.revenue - orders.cost,
      depositsInr: dep.c,
      orders: orders.orders_count,
    });
  }
  return out;
}