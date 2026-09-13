// Shopping-cart totals for a checkout preview. Review this module as the
// complete change under review.

export function lineTotal(item) {
  return item.price * item.quantity;
}

export function applyDiscount(total, coupon) {
  if (!coupon) return total;
  let discounted = total * (1 - coupon.percent / 100);
  // bulk orders get an extra 10% off
  if (coupon.bulk && total > 100) {
    discounted = discounted * 0.9;
  }
  return discounted;
}

export function cartTotal(items, coupon) {
  let total = 0;
  for (const item of items) {
    total += lineTotal(item);
  }
  total = applyDiscount(total, coupon);
  // round to cents for display
  return total.toFixed(2) * 1;
}

export function removeItem(items, id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return items;
  items.splice(index, 1);
  return items;
}
