// Generates human-readable order numbers like "TCV-00042"
//
// Format: {STORE_PREFIX}-{PADDED_COUNT}
//   - Store prefix = first 3 letters of store name, uppercased
//   - Count = total orders in this store + 1, zero-padded to 5 digits
//
// Examples:
//   TechVault NG → TCV-00001, TCV-00002 ...
//   Amaka Fashion → AMA-00001 ...

import { prisma } from "../config/db";

export async function generateOrderNumber(
  storeId: string,
  storeName: string,
): Promise<string> {
  // Count existing orders for this store to get the next number
  const count = await prisma.order.count({ where: { storeId } });
  const nextNumber = count + 1;

  // Take first 3 letters of store name, strip non-alpha chars, uppercase
  const prefix = storeName
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 3)
    .toUpperCase()
    .padEnd(3, "X"); // pad if store name has fewer than 3 letters

  // Zero-pad to 5 digits: 1 → "00001", 1000 → "01000"
  const padded = String(nextNumber).padStart(5, "0");

  return `${prefix}-${padded}`;
}
