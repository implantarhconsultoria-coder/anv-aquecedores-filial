import base64
import hashlib
import hmac
from typing import Optional

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.index import (
    app as core_app,
    env,
    make_session,
    read_session,
    db_configured,
    sb_select,
)

app = FastAPI(title="ANV Access Guard")

LOCKED_MESSAGE = "Aguardando liberação do sistema"


class LoginIn(BaseModel):
    email: str
    password: str


def _owner_email() -> str:
    return env("ANV_LOGIN_EMAIL").lower().strip()


def _is_owner_session(user: dict) -> bool:
    return bool(
        user
        and str(user.get("email") or "").lower().strip() == _owner_email()
        and str(user.get("role") or "").lower() in {"owner", "admin"}
    )


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, rounds_s, salt_s, digest_s = str(encoded or "").split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        rounds = int(rounds_s)
        salt = _b64d(salt_s)
        expected = _b64d(digest_s)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


async def access_user(email: str) -> Optional[dict]:
    if not db_configured():
        return None
    rows = await sb_select("anv_access_users", {
        "email": f"eq.{email.lower().strip()}",
        "limit": "1",
    })
    return rows[0] if rows else None


def public_user(email: str, role: str, access_status: str, display_name: Optional[str] = None) -> dict:
    return {
        "email": email.lower().strip(),
        "role": role,
        "access_status": access_status,
        "display_name": display_name,
        "can_write": role == "owner" or access_status == "LIBERADO",
    }


@app.post("/api/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.lower().strip()

    # Acesso do proprietário: continua vindo das variáveis seguras da Vercel.
    if email == _owner_email():
        if not hmac.compare_digest(body.password, env("ANV_LOGIN_PASSWORD")):
            raise HTTPException(401, "E-mail ou senha inválidos")
        token = make_session(email, "owner")
        response.set_cookie(
            "anv_session", token, httponly=True, secure=True, samesite="lax",
            max_age=7 * 24 * 3600, path="/"
        )
        return {"ok": True, "user": public_user(email, "owner", "LIBERADO", "Proprietário")}

    record = await access_user(email)
    if not record or not record.get("active") or not verify_password(body.password, str(record.get("password_hash") or "")):
        raise HTTPException(401, "E-mail ou senha inválidos")
    if str(record.get("access_status") or "") == "BLOQUEADO":
        raise HTTPException(403, "Acesso bloqueado. Contate o responsável pelo sistema.")

    role = str(record.get("role") or "client")
    status = str(record.get("access_status") or "AGUARDANDO_LIBERACAO")
    token = make_session(email, role)
    response.set_cookie(
        "anv_session", token, httponly=True, secure=True, samesite="lax",
        max_age=7 * 24 * 3600, path="/"
    )
    return {"ok": True, "user": public_user(email, role, status, record.get("display_name"))}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("anv_session", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request):
    user = read_session(request.cookies.get("anv_session") or "")
    if not user:
        raise HTTPException(401, "Sessão inválida ou expirada")
    email = str(user.get("email") or "").lower().strip()
    if _is_owner_session(user):
        return {"user": public_user(email, "owner", "LIBERADO", "Proprietário")}

    record = await access_user(email)
    if not record or not record.get("active"):
        raise HTTPException(401, "Acesso não encontrado ou desativado")
    status = str(record.get("access_status") or "AGUARDANDO_LIBERACAO")
    return {"user": public_user(email, str(record.get("role") or "client"), status, record.get("display_name"))}


@app.middleware("http")
async def commercial_access_guard(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()

    # Login/logout e notificações do próprio Mercado Livre não entram na trava comercial.
    if path in {"/api/auth/login", "/api/auth/logout"} or path.startswith("/api/integrations/mercado-livre/webhooks"):
        return await call_next(request)

    # Navegação/leitura continua liberada para o modo demonstração.
    if method in {"GET", "HEAD", "OPTIONS"}:
        return await call_next(request)

    user = read_session(request.cookies.get("anv_session") or "")
    if not user:
        return await call_next(request)
    if _is_owner_session(user):
        return await call_next(request)

    email = str(user.get("email") or "").lower().strip()
    record = await access_user(email)
    if not record or not record.get("active"):
        return JSONResponse(status_code=403, content={"detail": "Acesso não encontrado ou desativado"})

    status = str(record.get("access_status") or "AGUARDANDO_LIBERACAO")
    if status != "LIBERADO":
        return JSONResponse(
            status_code=423,
            content={
                "detail": LOCKED_MESSAGE,
                "access_status": status,
                "code": "ANV_ACCESS_PENDING",
            },
        )
    return await call_next(request)


app.mount("/", core_app)
