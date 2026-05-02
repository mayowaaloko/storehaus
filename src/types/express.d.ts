// src/types/express.d.ts
// Extends Express's Request type globally — no imports needed anywhere.

declare namespace Express {
  interface Request {
    requestId: string;
    store: {
      id: string;
    } | null;
    user?: User | StoreCustomer;
    userType?: "user" | "customer";
  }
}
