// Secrets are encrypted at rest; cookie identifiers are only stored as SHA-256 hashes.
const enc = new TextEncoder();
const dec = new TextDecoder();
const hash = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), b => b.toString(16).padStart(2, '0')).join('');
export function sessionStore(db, secret, namespace) {
  async function key() {
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
    return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function decode(row) {
    if (!row) return undefined;
    const encryptionKey = await key(); // Configuration errors must still surface.
    try {
      const bytes = Uint8Array.from(atob(row.value), c => c.charCodeAt(0));
      return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes.slice(0,12), additionalData:enc.encode(namespace)}, encryptionKey, bytes.slice(12))));
    } catch (error) {
      // Rotated keys or malformed stored sessions require a fresh login, not a 500.
      if (['OperationError', 'InvalidCharacterError', 'SyntaxError'].includes(error.name)) return undefined;
      throw error;
    }
  }
  return {
    async get(id) {
      if (!id) return undefined;
      return decode(await db.prepare('SELECT value FROM auth_state WHERE namespace=? AND id=? AND expires>?').bind(namespace, await hash(id), Date.now()).first());
    },
    async take(id) {
      if (!id) return undefined;
      return decode(await db.prepare('DELETE FROM auth_state WHERE namespace=? AND id=? AND expires>? RETURNING value').bind(namespace, await hash(id), Date.now()).first());
    },
    async set(id, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv, additionalData:enc.encode(namespace)}, await key(), enc.encode(JSON.stringify(value))));
      const all = new Uint8Array(iv.length + body.length); all.set(iv); all.set(body,12);
      const stored = btoa(String.fromCharCode(...all));
      await db.prepare('INSERT OR REPLACE INTO auth_state(namespace,id,value,expires) VALUES(?,?,?,?)').bind(namespace, await hash(id), stored, value.expires).run();
    },
    async delete(id) { if (id) await db.prepare('DELETE FROM auth_state WHERE namespace=? AND id=?').bind(namespace, await hash(id)).run(); }
  };
}
