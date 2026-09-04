const KEY_NAME = "readbackOpenAIApiKey";
const KEY_MODES = new Set(["persistent", "session"]);

export class KeyStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KeyStorageError";
    this.code = code;
  }
}

export function normalizeApiKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  if (key.length < 20 || key.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(key)) return "";
  return key;
}

export async function configureStorageAccess(storage) {
  try {
    await Promise.all([
      storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    ]);
  } catch {
    throw new KeyStorageError("KEY_STORAGE_UNAVAILABLE", "Readback could not protect its local key storage.");
  }
}

export async function saveApiKey(storage, value, mode) {
  const key = normalizeApiKey(value);
  if (!key) throw new KeyStorageError("INVALID_KEY_FORMAT", "Enter a complete OpenAI API key without spaces.");
  if (!KEY_MODES.has(mode)) throw new KeyStorageError("INVALID_KEY_MODE", "Choose a valid key storage option.");

  const target = mode === "persistent" ? storage.local : storage.session;
  const other = mode === "persistent" ? storage.session : storage.local;
  try {
    await target.set({ [KEY_NAME]: key });
    await other.remove(KEY_NAME);
  } catch {
    throw new KeyStorageError("KEY_STORAGE_UNAVAILABLE", "Readback could not save the API key.");
  }
  return { configured: true, mode };
}

export async function readApiKey(storage) {
  try {
    const session = await storage.session.get(KEY_NAME);
    const sessionKey = normalizeApiKey(session[KEY_NAME]);
    if (sessionKey) return { key: sessionKey, mode: "session" };
    const local = await storage.local.get(KEY_NAME);
    const localKey = normalizeApiKey(local[KEY_NAME]);
    if (localKey) return { key: localKey, mode: "persistent" };
    return { key: "", mode: null };
  } catch {
    throw new KeyStorageError("KEY_STORAGE_UNAVAILABLE", "Readback could not read the API key.");
  }
}

export async function apiKeyStatus(storage) {
  const stored = await readApiKey(storage);
  return { configured: Boolean(stored.key), mode: stored.mode };
}

export async function removeApiKey(storage) {
  try {
    await Promise.all([storage.local.remove(KEY_NAME), storage.session.remove(KEY_NAME)]);
  } catch {
    throw new KeyStorageError("KEY_STORAGE_UNAVAILABLE", "Readback could not remove the API key.");
  }
  return { configured: false, mode: null };
}
