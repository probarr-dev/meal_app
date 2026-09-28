"""Web Push (RFC 8030/8291/8292) for the meal planner.

Optional: needs the `cryptography` package (Debian: python3-cryptography).
Without it the app runs exactly as before and push simply reports disabled.

Payloads are end-to-end encrypted to each browser, so the push service
(Google for Chrome, Apple for Safari) only relays opaque bytes.
"""
import base64
import calendar
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from cryptography.hazmat.primitives import hashes, hmac, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    AVAILABLE = True
except ImportError:  # push is optional
    AVAILABLE = False

# Kinds a person can switch off individually. parents_only ones aren't shown to kids.
KINDS = {
    "voting_open": {"label": "Voting opens", "parents_only": False},
    "voting_reminder": {"label": "Reminder if I haven't voted", "parents_only": False},
    "plan_final": {"label": "Next week's meals are set", "parents_only": False},
    "extra_request": {"label": "A child asks for an extra", "parents_only": True},
}

CONTACT = os.environ.get("PUSH_CONTACT", "mailto:admin@localhost")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def migrate(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS push_sub (
        endpoint TEXT PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created TEXT DEFAULT CURRENT_TIMESTAMP)""")
    # Opt-out list per person: a row means that kind is switched off.
    conn.execute("""CREATE TABLE IF NOT EXISTS push_off (
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, PRIMARY KEY (person_id, kind))""")
    # One-shot notifications (reminders) are recorded so they never repeat.
    conn.execute("""CREATE TABLE IF NOT EXISTS push_sent (
        kind TEXT NOT NULL, week_id INTEGER NOT NULL, person_id INTEGER NOT NULL,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (kind, week_id, person_id))""")


def vapid_keys(conn):
    """The server's VAPID key pair, made once and kept in config."""
    if not AVAILABLE:
        return None, None
    row = conn.execute("SELECT value FROM config WHERE key='vapid_private'").fetchone()
    if row:
        priv = serialization.load_pem_private_key(row["value"].encode(), None)
    else:
        priv = ec.generate_private_key(ec.SECP256R1())
        pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption()).decode()
        conn.execute("INSERT INTO config(key,value) VALUES ('vapid_private',?)", (pem,))
        conn.commit()
    pub = priv.public_key().public_bytes(serialization.Encoding.X962,
                                         serialization.PublicFormat.UncompressedPoint)
    return priv, b64u(pub)


def _hkdf(salt, ikm, info, length):
    h = hmac.HMAC(salt, hashes.SHA256()); h.update(ikm); prk = h.finalize()
    h = hmac.HMAC(prk, hashes.SHA256()); h.update(info + b"\x01")
    return h.finalize()[:length]


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """aes128gcm content encoding (RFC 8291), single record."""
    ua_pub = unb64u(p256dh)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub)
    as_priv = ec.generate_private_key(ec.SECP256R1())
    as_pub = as_priv.public_key().public_bytes(serialization.Encoding.X962,
                                               serialization.PublicFormat.UncompressedPoint)
    shared = as_priv.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(unb64u(auth), shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + (4096).to_bytes(4, "big") + bytes([len(as_pub)]) + as_pub + body


def vapid_header(priv, pub, endpoint):
    u = urllib.parse.urlparse(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}",
                              "exp": int(time.time()) + 12 * 3600, "sub": CONTACT}).encode())
    r, s = decode_dss_signature(priv.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    sig = b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={head}.{claims}.{sig}, k={pub}"


def _deliver(db, subs, message):
    """Runs in a background thread so a slow push service never holds up a request."""
    with db() as conn:
        priv, pub = vapid_keys(conn)
        for s in subs:
            try:
                req = urllib.request.Request(s["endpoint"], method="POST",
                    data=encrypt(message, s["p256dh"], s["auth"]),
                    headers={"Authorization": vapid_header(priv, pub, s["endpoint"]),
                             "Content-Encoding": "aes128gcm", "TTL": "86400",
                             "Content-Type": "application/octet-stream"})
                urllib.request.urlopen(req, timeout=15).close()
            except urllib.error.HTTPError as e:
                if e.code in (404, 410):  # the browser dropped this subscription
                    conn.execute("DELETE FROM push_sub WHERE endpoint=?", (s["endpoint"],))
                    conn.commit()
                else:
                    print(f"push to person {s['person_id']} failed: HTTP {e.code}", flush=True)
            except Exception as e:  # network trouble shouldn't kill the thread
                print(f"push to person {s['person_id']} failed: {e}", flush=True)


def notify(conn, db, person_ids, kind, title, body, url="/"):
    """Send to everyone listed who hasn't switched this kind off. Returns how many devices."""
    if not AVAILABLE or not person_ids:
        return 0
    ids = list(set(person_ids))
    q = ",".join("?" * len(ids))
    subs = [dict(r) for r in conn.execute(f"""
        SELECT s.* FROM push_sub s WHERE s.person_id IN ({q})
        AND NOT EXISTS (SELECT 1 FROM push_off o WHERE o.person_id=s.person_id AND o.kind=?)""",
        (*ids, kind))]
    if subs:
        msg = json.dumps({"title": title, "body": body, "url": url, "tag": kind}).encode()
        threading.Thread(target=_deliver, args=(db, subs, msg), daemon=True).start()
    return len(subs)


def people(conn, role=None, exclude=None):
    sql = "SELECT id FROM person WHERE is_placeholder=0"
    args = []
    if role == "parent":
        sql += " AND role='parent'"
    elif role == "child":
        sql += " AND role!='parent'"
    if exclude:
        sql += " AND id!=?"; args.append(exclude)
    return [r["id"] for r in conn.execute(sql, args)]


def reminder_loop(db, hour=18):
    """Once a day at `hour`: nudge children who haven't voted, once per week,
    and only after voting has been open for most of a day."""
    def tick():
        with db() as conn:
            # The week whose "voting is open" went out and still isn't planned.
            opened = conn.execute("""SELECT s.week_id, s.sent_at FROM push_sent s
                JOIN week w ON w.id=s.week_id WHERE s.kind='voting_open' AND s.person_id=0
                AND w.confirmed=0 ORDER BY s.sent_at DESC LIMIT 1""").fetchone()
            if not opened:
                return
            wk = opened["week_id"]
            if time.time() - calendar.timegm(time.strptime(opened["sent_at"], "%Y-%m-%d %H:%M:%S")) < 20 * 3600:
                return
            todo = [r["id"] for r in conn.execute("""
                SELECT p.id FROM person p WHERE p.is_placeholder=0 AND p.role!='parent'
                AND NOT EXISTS (SELECT 1 FROM meal_vote v WHERE v.week_id=? AND v.person_id=p.id)
                AND NOT EXISTS (SELECT 1 FROM push_sent s WHERE s.kind='voting_reminder'
                                AND s.week_id=? AND s.person_id=p.id)""", (wk, wk))]
            for pid in todo:
                conn.execute("INSERT OR IGNORE INTO push_sent(kind,week_id,person_id) VALUES ('voting_reminder',?,?)", (wk, pid))
            conn.commit()
            notify(conn, db, todo, "voting_reminder", "Don't forget to vote 🗳️",
                   "Pick the meals you'd like next week.", "/#/vote")

    def loop():
        last = None
        while True:
            now = time.localtime()
            if now.tm_hour == hour and last != now.tm_yday:
                last = now.tm_yday
                try:
                    tick()
                except Exception as e:
                    print(f"voting reminder failed: {e}")
            time.sleep(300)

    if AVAILABLE:
        threading.Thread(target=loop, daemon=True).start()
