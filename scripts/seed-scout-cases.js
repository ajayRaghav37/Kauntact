import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";

const cases = JSON.parse(readFileSync(new URL("../scoutCasesV2.json", import.meta.url)));
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "kauntact";
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "kauntact-seed" });
try {
  await client.connect();
  const collection = client.db(dbName).collection("scoutCases");
  const ids = cases.map((caseDef) => caseDef.id);
  const now = new Date();
  const archive = client.db(dbName).collection("scoutCasesArchive");
  const retiring = await collection.find({ _id: { $nin: ids } }).toArray();
  if (retiring.length) {
    await archive.bulkWrite(retiring.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: { ...doc, archived: true, archivedAt: doc.archivedAt ?? now, updatedAt: now }, upsert: true },
    })));
    await collection.deleteMany({ _id: { $in: retiring.map((doc) => doc._id) } });
  }
  for (const [index, caseDef] of cases.entries()) {
    await collection.updateOne(
      { _id: caseDef.id },
      {
        $set: {
          query: caseDef.query,
          kind: caseDef.kind,
          mustInclude: caseDef.mustInclude,
          sources: caseDef.sources,
          archived: false,
          order: index,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
        $unset: { archivedAt: "" },
      },
      { upsert: true }
    );
  }
  const active = await collection.countDocuments();
  const hidden = await archive.countDocuments();
  const runs = await client.db(dbName).collection("scoutEvalRuns").countDocuments();
  console.log(JSON.stringify({ movedToArchive: retiring.length, active, hidden, savedRuns: runs }));
} finally {
  await client.close();
}
