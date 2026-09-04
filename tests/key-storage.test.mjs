import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyStatus, configureStorageAccess, readApiKey, removeApiKey, saveApiKey } from "../extension/key-storage.js";

function storageArea() {
  const values = {};
  const accessLevels = [];
  return {
    values,
    accessLevels,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(key) {
      delete values[key];
    },
    async setAccessLevel(options) {
      accessLevels.push(options.accessLevel);
    }
  };
}

function storage() {
  return { local: storageArea(), session: storageArea() };
}

const PLACEHOLDER_KEY = "not-a-real-api-key-value-12345";
const REPLACEMENT_KEY = "another-fake-key-value-for-tests";

test("storage access is restricted before key use", async () => {
  const mock = storage();
  await configureStorageAccess(mock);
  assert.deepEqual(mock.local.accessLevels, ["TRUSTED_CONTEXTS"]);
  assert.deepEqual(mock.session.accessLevels, ["TRUSTED_CONTEXTS"]);
});

test("persistent keys survive in local storage without entering session storage", async () => {
  const mock = storage();
  await saveApiKey(mock, PLACEHOLDER_KEY, "persistent");

  assert.deepEqual(await apiKeyStatus(mock), { configured: true, mode: "persistent" });
  assert.equal((await readApiKey(mock)).key, PLACEHOLDER_KEY);
  assert.deepEqual(mock.session.values, {});
});

test("session-only replacement removes the persistent copy", async () => {
  const mock = storage();
  await saveApiKey(mock, PLACEHOLDER_KEY, "persistent");
  await saveApiKey(mock, REPLACEMENT_KEY, "session");

  assert.deepEqual(await apiKeyStatus(mock), { configured: true, mode: "session" });
  assert.equal((await readApiKey(mock)).key, REPLACEMENT_KEY);
  assert.deepEqual(mock.local.values, {});
});

test("removing a key clears both storage modes", async () => {
  const mock = storage();
  await saveApiKey(mock, PLACEHOLDER_KEY, "persistent");
  mock.session.values.readbackOpenAIApiKey = REPLACEMENT_KEY;
  await removeApiKey(mock);

  assert.deepEqual(await apiKeyStatus(mock), { configured: false, mode: null });
  assert.deepEqual(mock.local.values, {});
  assert.deepEqual(mock.session.values, {});
});

test("invalid key errors never repeat the submitted value", async () => {
  const mock = storage();
  const submitted = "too short";
  await assert.rejects(
    saveApiKey(mock, submitted, "persistent"),
    (error) => error.code === "INVALID_KEY_FORMAT" && !error.message.includes(submitted)
  );
});
