"""Sign-in for the meal planner: one username + password per person.

Passwords are hashed with scrypt (or PBKDF2 where scrypt isn't available). A successful sign-in gets a random session token
in an HttpOnly cookie; only a hash of it is stored, so a copied database can't
be used to sign in. Guessing is slowed three ways: per-account lockouts, a
per-IP limit, and a 401 on every failure (a reverse proxy running CrowdSec
bans addresses that rack those up).
"""
import hashlib
import hmac
import os
import secrets
import threading
import time

COOKIE = "mp_session"
SESSION_DAYS = 180            # phones stay signed in; renewed as they're used
MIN_PASSWORD = 8
LOCK_AFTER = 5                # wrong passwords in a row before an account locks
LOCK_SECONDS = 15 * 60
IP_WINDOW, IP_MAX = 15 * 60, 20   # attempts per IP per window, any account

_ip_hits = {}
_ip_lock = threading.Lock()


def migrate(conn):
    for col, typ in (("username", "TEXT"), ("pw_hash", "TEXT"), ("pw_must_change", "INTEGER DEFAULT 0"),
                     ("failed_logins", "INTEGER DEFAULT 0"), ("locked_until", "INTEGER DEFAULT 0")):
        if col not in {r[1] for r in conn.execute("PRAGMA table_info(person)")}:
            conn.execute(f"ALTER TABLE person ADD COLUMN {col} {typ}")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS person_username ON person(username)")
    conn.execute("""CREATE TABLE IF NOT EXISTS session (
        token_hash TEXT PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL)""")
    # Everyone gets a username from their name; admins can change it later.
    for r in conn.execute("SELECT id, name FROM person WHERE username IS NULL AND is_placeholder=0").fetchall():
        conn.execute("UPDATE person SET username=? WHERE id=?", (unique_username(conn, r["name"]), r["id"]))
    conn.execute("DELETE FROM session WHERE expires < ?", (int(time.time()),))


def clean_username(s):
    return "".join(c for c in (s or "").lower() if c.isalnum() or c in "._-")[:30]


def unique_username(conn, name, exclude_id=None):
    base = clean_username(name) or "user"
    u, n = base, 2
    while conn.execute("SELECT 1 FROM person WHERE username=? AND id IS NOT ?", (u, exclude_id)).fetchone():
        u, n = f"{base}{n}", n + 1
    return u


def _derive(algo, pw, salt):
    if algo == "scrypt":
        return hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 600_000)


# scrypt where Python's OpenSSL has it (Linux, Docker); PBKDF2 otherwise (macOS's
# system Python). Each hash records its own algorithm, so both keep verifying.
ALGO = "scrypt" if hasattr(hashlib, "scrypt") else "pbkdf2"


def hash_password(pw):
    salt = os.urandom(16)
    return f"{ALGO}${salt.hex()}${_derive(ALGO, pw, salt).hex()}"


def check_password(pw, stored):
    try:
        algo, salt, want = stored.split("$")
        return hmac.compare_digest(_derive(algo, pw, bytes.fromhex(salt)).hex(), want)
    except Exception:
        return False


_DUMMY = hash_password(secrets.token_hex(8))


def password_problem(pw):
    if len(pw or "") < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters."
    if len(pw) > 200:
        return "That's too long."
    return None


def ip_allowed(ip):
    now = time.time()
    with _ip_lock:
        hits = [t for t in _ip_hits.get(ip, []) if now - t < IP_WINDOW]
        _ip_hits[ip] = hits + [now]
        return len(hits) < IP_MAX


def login(conn, username, password):
    """Returns (person_row, None) or (None, message)."""
    row = conn.execute("SELECT * FROM person WHERE username=? AND is_placeholder=0",
                       (clean_username(username),)).fetchone()
    now = int(time.time())
    if not row or not row["pw_hash"]:
        check_password(password or "", _DUMMY)  # same timing as a real miss
        return None, "Wrong username or password."
    if (row["locked_until"] or 0) > now:
        return None, f"Too many wrong tries. Try again in {-(-(row['locked_until'] - now) // 60)} minutes."
    if not check_password(password or "", row["pw_hash"]):
        fails = (row["failed_logins"] or 0) + 1
        locked = now + LOCK_SECONDS if fails >= LOCK_AFTER else 0
        conn.execute("UPDATE person SET failed_logins=?, locked_until=? WHERE id=?",
                     (0 if locked else fails, locked, row["id"]))
        conn.commit()
        return None, "Wrong username or password."
    conn.execute("UPDATE person SET failed_logins=0, locked_until=0 WHERE id=?", (row["id"],))
    conn.commit()
    return row, None


def new_session(conn, person_id):
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO session(token_hash, person_id, expires) VALUES (?,?,?)",
                 (_h(token), person_id, int(time.time()) + SESSION_DAYS * 86400))
    conn.commit()
    return token


def session_person(conn, token):
    if not token:
        return None
    now = int(time.time())
    row = conn.execute("""SELECT p.*, s.expires FROM session s JOIN person p ON p.id=s.person_id
                          WHERE s.token_hash=? AND s.expires>?""", (_h(token), now)).fetchone()
    if row and row["expires"] - now < (SESSION_DAYS - 1) * 86400:  # sliding renewal, at most daily
        conn.execute("UPDATE session SET expires=? WHERE token_hash=?",
                     (now + SESSION_DAYS * 86400, _h(token)))
        conn.commit()
    return row


def end_session(conn, token):
    conn.execute("DELETE FROM session WHERE token_hash=?", (_h(token or ""),))
    conn.commit()


def set_password(conn, person_id, pw, must_change, keep_token=None):
    """Sets a password and signs that person out everywhere else."""
    conn.execute("UPDATE person SET pw_hash=?, pw_must_change=?, failed_logins=0, locked_until=0 WHERE id=?",
                 (hash_password(pw), 1 if must_change else 0, person_id))
    conn.execute("DELETE FROM session WHERE person_id=? AND token_hash IS NOT ?",
                 (person_id, _h(keep_token) if keep_token else None))
    conn.commit()


def cookie_header(token, max_age=SESSION_DAYS * 86400):
    return f"{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"


def _h(token):
    return hashlib.sha256(token.encode()).hexdigest()
