"""
CORS allowed origins for Flask-CORS.

Configure production via environment variables:
  FRONTEND_URL      — primary frontend origin (e.g. https://your-app.vercel.app)
  CORS_ORIGINS      — optional comma-separated extra origins (e.g. preview deploys)

Local dev defaults include localhost:3000 unless overridden.
"""
import os
import re


def normalize_origin(origin):
    """Compare origins case-insensitively (scheme/host are case-insensitive per RFC)."""
    if not origin:
        return ""
    return origin.strip().rstrip("/").lower()


def get_vercel_origin_pattern():
    """
    If FRONTEND_URL is a *.vercel.app URL, return a regex that also matches
    Vercel preview hostnames (same project slug prefix, e.g. ...-git-branch-...).
    """
    fu = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    if ".vercel.app" not in fu.lower():
        return None
    try:
        host = fu.split("//", 1)[-1].split("/")[0].lower()
        if not host.endswith(".vercel.app"):
            return None
        slug = host[: -len(".vercel.app")]
        if not slug:
            return None
        return re.compile(
            r"^https://" + re.escape(slug) + r"([a-z0-9.-]+)?\.vercel\.app$",
            re.IGNORECASE,
        )
    except Exception:
        return None


def is_origin_allowed(request_origin, allowed_list, vercel_pattern=None):
    """True if origin is in allowed_list (case-insensitive) or matches vercel_pattern."""
    if not request_origin:
        return False
    ro = request_origin.strip()
    req_norm = normalize_origin(ro)
    for o in allowed_list or []:
        if normalize_origin(o) == req_norm:
            return True
    if vercel_pattern is not None and vercel_pattern.match(ro):
        return True
    return False


def get_allowed_origins():
    """Return a list of origins (no trailing slashes) for CORS."""
    seen = set()
    origins = []

    def add(origin):
        if not origin:
            return
        o = origin.strip().rstrip("/")
        if not o or o in seen:
            return
        seen.add(o)
        origins.append(o)

    # Explicit list: CORS_ORIGINS=https://a.com,https://b.com
    raw_extra = os.getenv("CORS_ORIGINS", "").strip()
    if raw_extra:
        for part in raw_extra.split(","):
            add(part)

    # Single frontend URL (Render + Vercel typical setup)
    add(os.getenv("FRONTEND_URL", "").strip())

    # Always allow common local frontend origins to keep local development stable
    # even when FRONTEND_URL points to a deployed domain.
    add("http://localhost:3000")
    add("http://127.0.0.1:3000")

    # Optional extra local ports (when needed)
    if os.getenv("ALLOW_LOCALHOST_CORS", "").lower() in ("1", "true", "yes"):
        add("http://localhost:3001")
        add("http://127.0.0.1:3001")
        add("http://localhost:3002")
        add("http://127.0.0.1:3002")

    return origins
