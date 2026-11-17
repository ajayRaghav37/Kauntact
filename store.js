import { MongoClient, ObjectId } from "mongodb";

const DB_NAME = process.env.MONGODB_DB || "kauntact";

function mongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

function notConfigured() {
  const error = new Error("MONGODB_URI is not set, so Kauntact cannot save or load data.");
  error.statusCode = 503;
  return error;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection("searches").createIndex({ createdAt: -1 }),
    db.collection("searches").createIndex({ batchId: 1, rowIndex: 1 }),
    db.collection("batches").createIndex({ createdAt: -1 }),
    db.collection("evalRuns").createIndex({ at: -1 }),
    db.collection("evalCases").createIndex({ order: 1 }),
    db.collection("alerts").createIndex({ createdAt: -1 }),
    db.collection("alerts").createIndex({ monitorId: 1 }, { unique: true, sparse: true }),
    db.collection("alertNews").createIndex({ alertId: 1, url: 1 }, { unique: true }),
    db.collection("alertNews").createIndex({ receivedAt: -1 }),
    db.collection("scoutSearches").createIndex({ createdAt: -1 }),
    db.collection("scoutCases").createIndex({ order: 1 }),
    db.collection("scoutEvalRuns").createIndex({ at: -1 }),
  ]);
}

// Serverless functions reuse the module between requests, so the connection is cached on globalThis.
async function db() {
  if (!mongoConfigured()) throw notConfigured();
  if (!globalThis.__kauntactDb) {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, appName: "kauntact" });
    globalThis.__kauntactDb = client.connect().then(async () => {
      const database = client.db(DB_NAME);
      await ensureIndexes(database);
      return database;
    });
    globalThis.__kauntactDb.catch(() => { globalThis.__kauntactDb = null; });
  }
  return globalThis.__kauntactDb;
}

function toId(value) {
  if (!ObjectId.isValid(value)) {
    const error = new Error("Not found.");
    error.statusCode = 404;
    throw error;
  }
  return new ObjectId(value);
}

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

// Balance estimate

const DEFAULT_BALANCE = { amount: 10, userSet: false };

async function getBalance() {
  const doc = await (await db()).collection("settings").findOne({ _id: "balance" });
  return doc ? { amount: doc.amount, userSet: doc.userSet } : DEFAULT_BALANCE;
}

async function setBalance({ amount, userSet }) {
  await (await db()).collection("settings").updateOne(
    { _id: "balance" },
    { $set: { amount, userSet, updatedAt: new Date() } },
    { upsert: true }
  );
  return getBalance();
}

async function spendBalance(cost) {
  const settings = (await db()).collection("settings");
  await settings.updateOne({ _id: "balance" }, { $setOnInsert: DEFAULT_BALANCE }, { upsert: true });
  await settings.updateOne({ _id: "balance" }, [
    { $set: { amount: { $max: [0, { $round: [{ $subtract: ["$amount", cost] }, 6] }] }, updatedAt: "$$NOW" } },
  ]);
  return getBalance();
}

// Eval cases

function caseFromDoc(doc) {
  return { id: doc._id, input: doc.input, expect: doc.expect };
}

async function listCases() {
  const cases = await (await db()).collection("evalCases").find().sort({ order: 1, createdAt: 1 }).toArray();
  return cases.map(caseFromDoc);
}

async function createCase(caseDef) {
  const collection = (await db()).collection("evalCases");
  const last = await collection.find().sort({ order: -1 }).limit(1).next();
  const now = new Date();
  try {
    await collection.insertOne({ _id: caseDef.id, input: caseDef.input, expect: caseDef.expect, order: (last?.order ?? -1) + 1, createdAt: now, updatedAt: now });
  } catch (error) {
    if (error.code === 11000) {
      const conflict = new Error(`A case with id ${caseDef.id} already exists.`);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  return caseDef;
}

async function updateCase(id, caseDef) {
  const result = await (await db()).collection("evalCases").updateOne(
    { _id: id },
    { $set: { input: caseDef.input, expect: caseDef.expect, updatedAt: new Date() } }
  );
  if (!result.matchedCount) {
    const error = new Error(`No case with id ${id}.`);
    error.statusCode = 404;
    throw error;
  }
  return { id, input: caseDef.input, expect: caseDef.expect };
}

async function deleteCase(id) {
  await (await db()).collection("evalCases").deleteOne({ _id: id });
}

// A short label for an eval run. Empty input is stored as no name.
function cleanRunName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || null;
}

// Eval runs

async function saveEvalRun(run) {
  const result = await (await db()).collection("evalRuns").insertOne({ ...run, at: new Date() });
  return String(result.insertedId);
}

async function listEvalRuns(limit = 20) {
  const runs = await (await db()).collection("evalRuns").find().sort({ at: -1 }).limit(limit).toArray();
  return runs.map(withId);
}

async function clearEvalRuns() {
  await (await db()).collection("evalRuns").deleteMany({});
}

// Search and batch history

async function saveSearch(doc) {
  const result = await (await db()).collection("searches").insertOne({ ...doc, createdAt: new Date() });
  return String(result.insertedId);
}

async function createBatch(doc) {
  const result = await (await db()).collection("batches").insertOne({ ...doc, createdAt: new Date() });
  return String(result.insertedId);
}

async function listHistory() {
  const database = await db();
  const [searches, batches] = await Promise.all([
    database.collection("searches").find({ batchId: null }, { projection: { input: 1, "result.person_name": 1, "result.verdict": 1, "result.company": 1, status: 1, createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(20).toArray(),
    database.collection("batches").find({}, { projection: { fileName: 1, rowCount: 1, effort: 1, createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  return searches.map((doc) => ({ type: "search", ...withId(doc) }))
    .concat(batches.map((doc) => ({ type: "batch", ...withId(doc) })))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getSearch(id) {
  return withId(await (await db()).collection("searches").findOne({ _id: toId(id) }));
}

async function getBatch(id) {
  const database = await db();
  const batch = await database.collection("batches").findOne({ _id: toId(id) });
  if (!batch) return null;
  const searches = await database.collection("searches").find({ batchId: String(batch._id) }).sort({ rowIndex: 1, createdAt: 1 }).toArray();
  return { ...withId(batch), searches: searches.map(withId) };
}

// Alerts

async function createAlert(doc) {
  const result = await (await db()).collection("alerts").insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });
  return String(result.insertedId);
}

async function updateAlert(id, fields) {
  await (await db()).collection("alerts").updateOne({ _id: toId(id) }, { $set: { ...fields, updatedAt: new Date() } });
}

async function getAlert(id) {
  return withId(await (await db()).collection("alerts").findOne({ _id: toId(id) }));
}

async function findAlertByMonitor(monitorId) {
  return withId(await (await db()).collection("alerts").findOne({ monitorId }));
}

async function deleteAlert(id) {
  const database = await db();
  await Promise.all([
    database.collection("alerts").deleteOne({ _id: toId(id) }),
    database.collection("alertNews").deleteMany({ alertId: id }),
  ]);
}

async function listAlerts() {
  const database = await db();
  const [alerts, unread] = await Promise.all([
    database.collection("alerts").find({}, { projection: { webhookSecret: 0 } }).sort({ createdAt: -1 }).toArray(),
    database.collection("alertNews").aggregate([{ $match: { read: false } }, { $group: { _id: "$alertId", count: { $sum: 1 } } }]).toArray(),
  ]);
  const unreadBy = Object.fromEntries(unread.map((row) => [row._id, row.count]));
  return alerts.map((alert) => ({ ...withId(alert), unread: unreadBy[String(alert._id)] ?? 0 }));
}

async function insertNews(items) {
  if (!items.length) return 0;
  const result = await (await db()).collection("alertNews").bulkWrite(
    items.map((item) => ({
      updateOne: {
        filter: { alertId: item.alertId, url: item.url },
        update: { $setOnInsert: { ...item, read: false, receivedAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return result.upsertedCount;
}

async function listNews({ alertId, limit = 100 } = {}) {
  const filter = alertId ? { alertId } : {};
  const news = await (await db()).collection("alertNews").find(filter).sort({ receivedAt: -1, publishedDate: -1 }).limit(limit).toArray();
  return news.map(withId);
}

async function markNewsRead({ alertId } = {}) {
  await (await db()).collection("alertNews").updateMany({ read: false, ...(alertId ? { alertId } : {}) }, { $set: { read: true } });
}

// Delulu Scout

async function saveScoutSearch(doc) {
  const result = await (await db()).collection("scoutSearches").insertOne({ ...doc, createdAt: new Date() });
  return String(result.insertedId);
}

async function listScoutSearches(limit = 20) {
  const searches = await (await db()).collection("scoutSearches")
    .find({}, { projection: { query: 1, providers: 1, model: 1, createdAt: 1 } })
    .sort({ createdAt: -1 }).limit(limit).toArray();
  return searches.map(withId);
}

async function getScoutSearch(id) {
  return withId(await (await db()).collection("scoutSearches").findOne({ _id: toId(id) }));
}

function scoutCaseFromDoc(doc) {
  return { id: doc._id, query: doc.query, kind: doc.kind, mustInclude: doc.mustInclude ?? [] };
}

async function listScoutCases() {
  const cases = await (await db()).collection("scoutCases").find().sort({ order: 1, createdAt: 1 }).toArray();
  return cases.map(scoutCaseFromDoc);
}

async function createScoutCase(caseDef) {
  const collection = (await db()).collection("scoutCases");
  const last = await collection.find().sort({ order: -1 }).limit(1).next();
  const now = new Date();
  try {
    await collection.insertOne({ _id: caseDef.id, query: caseDef.query, kind: caseDef.kind, mustInclude: caseDef.mustInclude, order: (last?.order ?? -1) + 1, createdAt: now, updatedAt: now });
  } catch (error) {
    if (error.code === 11000) {
      const conflict = new Error(`A query with id ${caseDef.id} already exists.`);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  return caseDef;
}

async function updateScoutCase(id, caseDef) {
  const result = await (await db()).collection("scoutCases").updateOne(
    { _id: id },
    { $set: { query: caseDef.query, kind: caseDef.kind, mustInclude: caseDef.mustInclude, updatedAt: new Date() } }
  );
  if (!result.matchedCount) {
    const error = new Error(`No query with id ${id}.`);
    error.statusCode = 404;
    throw error;
  }
  return { ...caseDef, id };
}

async function deleteScoutCase(id) {
  await (await db()).collection("scoutCases").deleteOne({ _id: id });
}

async function saveScoutEvalRun(run) {
  const result = await (await db()).collection("scoutEvalRuns").insertOne({ ...run, at: new Date() });
  return String(result.insertedId);
}

async function listScoutEvalRuns(limit = 20) {
  const runs = await (await db()).collection("scoutEvalRuns").find().sort({ at: -1 }).limit(limit).toArray();
  return runs.map(withId);
}

async function clearScoutEvalRuns() {
  await (await db()).collection("scoutEvalRuns").deleteMany({});
}

export {
  mongoConfigured,
  getBalance, setBalance, spendBalance,
  listCases, createCase, updateCase, deleteCase,
  cleanRunName,
  saveEvalRun, listEvalRuns, clearEvalRuns,
  saveSearch, createBatch, listHistory, getSearch, getBatch,
  createAlert, updateAlert, getAlert, findAlertByMonitor, deleteAlert, listAlerts, insertNews, listNews, markNewsRead,
  saveScoutSearch, listScoutSearches, getScoutSearch,
  listScoutCases, createScoutCase, updateScoutCase, deleteScoutCase,
  saveScoutEvalRun, listScoutEvalRuns, clearScoutEvalRuns,
};
