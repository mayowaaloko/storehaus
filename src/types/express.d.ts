// src/types/express.d.ts
// Extends Express's Request type globally — no imports needed anywhere.

// src/types/express.d.ts   (or wherever your custom types file is)

import { User, StoreCustomer, Store } from "../generated/prisma";

declare global {
  namespace Express {
    interface Request {
      requestId: string;

      /** Current store context */
      store: Pick<Store, "id"> | null;

      /** Current logged in person - can be either Merchant/Admin or Customer */
      user?: User | StoreCustomer;

      /** Helps distinguish between merchant user and store customer */
      userType?: "user" | "customer";
    }
  }
}

export {};
