import mongoose from "mongoose";

const { Schema, model } = mongoose;

const OrderSchema = new Schema(
  {
    agent: { type: Schema.Types.ObjectId, ref: "Agent", index: true },
    ref: { type: String, index: true },
    store: { type: String, default: "" },
    customer: { type: String, default: "" },
    phone: { type: String, default: "" },
    carrier: { type: String, enum: ["MTN", "Telecel", "AirtelTigo"] },
    bundle: { type: String, default: "" }, // display label, e.g. "5 GB"
    gb: { type: Number, default: 0 }, // numeric size — what fulfilment resolves on
    amount: { type: Number, default: 0 },
    earning: { type: Number, default: 0 }, // store owner's margin (agent price − platform price)
    platformEarning: { type: Number, default: 0 }, // app owner's margin (platform price − base cost)
    status: {
      type: String,
      // processing = handed to the provider, awaiting delivery.
      // refunded = the provider couldn't deliver and the money was put back.
      enum: ["pending", "processing", "completed", "failed", "refunded"],
      default: "pending",
    },

    // Upstream fulfilment (Rema Data). `provider` is "rema" for real orders and
    // "simulated" when fulfilment is switched off — see lib/remaApi.js.
    provider: { type: String, default: "" },
    providerRef: { type: String, index: true },
    providerStatus: { type: String, default: "" },
    providerMessage: { type: String, default: "" },
    providerCost: { type: Number, default: 0 }, // what the provider charged us
    deliveredAt: { type: Date },

    // How to put the money back if the provider never delivers. Captured when
    // the order is placed because a failure can arrive minutes later, from the
    // status poller, long after the purchase request has gone.
    reversal: {
      agent: { type: Schema.Types.ObjectId, ref: "Agent" },
      agentName: { type: String, default: "" },
      credit: { type: Number, default: 0 }, // put back on the buyer's wallet
      platformClawback: { type: Number, default: 0 }, // taken off the app owner
      storeId: { type: Schema.Types.ObjectId, ref: "Store" },
    },
    reversedAt: { type: Date },
  },
  { timestamps: true }
);

export const Order = model("Order", OrderSchema);
export default Order;
