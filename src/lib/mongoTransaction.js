import mongoose from "mongoose";

/** Run a unit of financial work atomically. MongoDB must be a replica set. */
export async function withMongoTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}
