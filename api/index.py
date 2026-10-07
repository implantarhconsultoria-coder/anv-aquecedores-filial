import os
import asyncio
import re
import json
import hmac
import base64
import hashlib
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

app = FastAPI(title="ANV Filial Digital API", version="1.0.0")

ML_API = "https://api.mercadolibre.com"
ML_AUTH = "https://auth.mercadolivre.com.br/authorization"
SITE_ID = "MLB"

# -----------------------------------------------------------------------------
# General helpers
# -----------------------------------------------------------------------------

def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime] = None) -> str:
    return (dt or now()).isoformat()


def env(name: str, fallback: Optional[str] = None) -> str:
    return os.environ.get(name, fallback or "")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def json_response_data(response: httpx.Response) -> Any:
    if response.status_code == 204 or not response.content:
        return None
    try:
        return response.json()
    except Exception:
        return {"raw": response.text[:1000]}


# -----------------------------------------------------------------------------
# Lightweight single-app session (server-side password in Vercel env only)
# -----------------------------------------------------------------------------

def auth_configured() -> bool:
    return bool(env("ANV_LOGIN_EMAIL") and env("ANV_LOGIN_PASSWORD") and env("APP_SESSION_SECRET"))


def make_session(email: str, role: str = "admin") -> str:
    secret = env("APP_SESSION_SECRET")
    if not secret:
        raise HTTPException(503, "Sessão ANV não configurada")
    payload = {
        "email": email.lower().strip(),
        "role": role,
        "exp": int((now() + timedelta(days=7)).timestamp()),
    }
    encoded = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signature = b64url(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def read_session(token: str) -> Optional[dict]:
    try:
        encoded, signature = token.split(".", 1)
        expected = b64url(hmac.new(env("APP_SESSION_SECRET").encode(), encoded.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(b64url_decode(encoded))
        if int(payload.get("exp", 0)) < int(now().timestamp()):
            return None
        return payload
    except Exception:
        return None


def require_auth(request: Request) -> dict:
    if not auth_configured():
        raise HTTPException(503, "Login ANV ainda não configurado na Vercel")
    token = request.cookies.get("anv_session")
    user = read_session(token or "")
    if not user:
        raise HTTPException(401, "Sessão inválida ou expirada")
    return user


class LoginIn(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
async def login(body: LoginIn, response: Response):
    if not auth_configured():
        raise HTTPException(503, "Login ANV ainda não configurado")
    wanted_email = env("ANV_LOGIN_EMAIL").lower().strip()
    email_ok = hmac.compare_digest(body.email.lower().strip(), wanted_email)
    password_ok = hmac.compare_digest(body.password, env("ANV_LOGIN_PASSWORD"))
    if not email_ok or not password_ok:
        raise HTTPException(401, "E-mail ou senha inválidos")
    token = make_session(wanted_email)
    response.set_cookie(
        "anv_session", token, httponly=True, secure=True, samesite="lax",
        max_age=7 * 24 * 3600, path="/"
    )
    return {"ok": True, "user": {"email": wanted_email, "role": "admin"}}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("anv_session", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user: dict = Depends(require_auth)):
    return {"user": user}


# -----------------------------------------------------------------------------
# Supabase REST backend (secret key is never exposed to the browser)
# -----------------------------------------------------------------------------

def supabase_key() -> str:
    return env("SUPABASE_SECRET_KEY") or env("SUPABASE_SERVICE_ROLE_KEY")


def db_configured() -> bool:
    return bool(env("SUPABASE_URL") and supabase_key())


def sb_headers(prefer: Optional[str] = None) -> dict:
    key = supabase_key()
    if not key:
        raise HTTPException(503, "Banco ANV ainda não configurado")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


async def sb_request(
    method: str,
    resource: str,
    *,
    params: Optional[dict] = None,
    body: Any = None,
    prefer: Optional[str] = None,
    allow: tuple = (),
) -> Any:
    if not db_configured():
        raise HTTPException(503, "Banco ANV ainda não configurado")
    url = f"{env('SUPABASE_URL').rstrip('/')}/rest/v1/{resource.lstrip('/')}"
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.request(method, url, headers=sb_headers(prefer), params=params, json=body)
    if r.status_code >= 400 and r.status_code not in allow:
        data = json_response_data(r)
        raise HTTPException(502, {"message": "Falha no banco ANV", "status": r.status_code, "detail": data})
    return r.status_code, json_response_data(r)


async def sb_select(table: str, params: Optional[dict] = None) -> List[dict]:
    p = {"select": "*"}
    if params:
        p.update(params)
    _, data = await sb_request("GET", table, params=p)
    return data or []


async def sb_insert(table: str, body: dict) -> dict:
    _, data = await sb_request("POST", table, body=body, prefer="return=representation")
    return (data or [{}])[0]


async def sb_upsert(table: str, body: dict, conflict: str) -> dict:
    _, data = await sb_request(
        "POST", table,
        params={"on_conflict": conflict},
        body=body,
        prefer="resolution=merge-duplicates,return=representation",
    )
    return (data or [{}])[0]


async def sb_patch(table: str, filters: dict, body: dict) -> List[dict]:
    _, data = await sb_request("PATCH", table, params={"select": "*", **filters}, body=body, prefer="return=representation")
    return data or []


async def sb_rpc(name: str, body: dict) -> Any:
    _, data = await sb_request("POST", f"rpc/{name}", body=body)
    return data


# -----------------------------------------------------------------------------
# Token encryption
# -----------------------------------------------------------------------------

def fernet() -> Fernet:
    key = env("TOKEN_ENCRYPTION_KEY")
    if not key:
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY ainda não configurada")
    try:
        return Fernet(key.encode())
    except Exception:
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY inválida")


def encrypt_token(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return fernet().encrypt(value.encode()).decode()


def decrypt_token(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        raise HTTPException(503, "Token do Mercado Livre não pôde ser descriptografado")


# -----------------------------------------------------------------------------
# Health
# -----------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    db_ok = False
    if db_configured():
        try:
            rows = await sb_select("anv_products", {"limit": "1"})
            db_ok = isinstance(rows, list)
        except Exception:
            db_ok = False
    return {
        "status": "healthy" if db_ok else "configuration_required",
        "time": iso(),
        "configured": {
            "auth": auth_configured(),
            "database": db_configured(),
            "marketplace": bool(env("ML_CLIENT_ID") and env("ML_CLIENT_SECRET") and env("ML_REDIRECT_URI")),
            "token_encryption": bool(env("TOKEN_ENCRYPTION_KEY")),
        },
        "database_ok": db_ok,
    }


# -----------------------------------------------------------------------------
# Products
# -----------------------------------------------------------------------------

PRODUCT_FIELDS = {
    "code", "sku", "gtin", "name", "brand", "model", "category", "gas_type",
    "voltage", "color", "material", "application", "compatibility", "description",
    "technical_details", "package_length_cm", "package_width_cm", "package_height_cm",
    "package_weight_g", "ncm", "cest", "fiscal_origin", "cost_price", "sale_price",
    "minimum_price", "stock", "minimum_stock", "status"
}


def clean_product(data: dict) -> dict:
    return {k: v for k, v in data.items() if k in PRODUCT_FIELDS}


@app.get("/api/products")
async def products_list(q: Optional[str] = None, user: dict = Depends(require_auth)):
    params: Dict[str, str] = {"order": "created_at.desc", "limit": "500"}
    if q:
        safe = q.replace(",", " ")
        params["or"] = f"(name.ilike.*{safe}*,code.ilike.*{safe}*,sku.ilike.*{safe}*,brand.ilike.*{safe}*,model.ilike.*{safe}*)"
    return await sb_select("anv_products", params)


@app.get("/api/products/{product_id}")
async def product_get(product_id: str, user: dict = Depends(require_auth)):
    rows = await sb_select("anv_products", {"id": f"eq.{product_id}", "limit": "1"})
    if not rows:
        raise HTTPException(404, "Produto não encontrado")
    images = await sb_select("anv_product_images", {"product_id": f"eq.{product_id}", "order": "position.asc"})
    return {**rows[0], "images": images}


@app.post("/api/products")
async def product_create(body: Dict[str, Any], user: dict = Depends(require_auth)):
    data = clean_product(body)
    if not str(data.get("name") or "").strip():
        raise HTTPException(400, "Nome do produto é obrigatório")
    return await sb_insert("anv_products", data)


@app.patch("/api/products/{product_id}")
async def product_update(product_id: str, body: Dict[str, Any], user: dict = Depends(require_auth)):
    data = clean_product(body)
    data["updated_at"] = iso()
    rows = await sb_patch("anv_products", {"id": f"eq.{product_id}"}, data)
    if not rows:
        raise HTTPException(404, "Produto não encontrado")
    return rows[0]


# -----------------------------------------------------------------------------
# Mercado Livre OAuth and token handling
# -----------------------------------------------------------------------------

def ml_configured() -> bool:
    return bool(env("ML_CLIENT_ID") and env("ML_CLIENT_SECRET") and env("ML_REDIRECT_URI"))


async def ml_account() -> Optional[dict]:
    if not db_configured():
        return None
    rows = await sb_select("anv_marketplace_accounts", {"provider": "eq.mercado_livre", "limit": "1"})
    return rows[0] if rows else None


async def ml_refresh() -> Optional[str]:
    account = await ml_account()
    if not account or not account.get("refresh_token_enc") or not ml_configured():
        return None
    refresh = decrypt_token(account.get("refresh_token_enc"))
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{ML_API}/oauth/token", data={
            "grant_type": "refresh_token",
            "client_id": env("ML_CLIENT_ID"),
            "client_secret": env("ML_CLIENT_SECRET"),
            "refresh_token": refresh,
        })
    if r.status_code != 200:
        await sb_patch("anv_marketplace_accounts", {"provider": "eq.mercado_livre"}, {"status": "ERRO_TOKEN", "updated_at": iso()})
        return None
    tk = r.json()
    expires_at = now() + timedelta(seconds=int(tk.get("expires_in") or 21600))
    await sb_patch("anv_marketplace_accounts", {"provider": "eq.mercado_livre"}, {
        "access_token_enc": encrypt_token(tk.get("access_token")),
        "refresh_token_enc": encrypt_token(tk.get("refresh_token") or refresh),
        "token_expires_at": iso(expires_at),
        "status": "CONECTADO",
        "updated_at": iso(),
    })
    return tk.get("access_token")


async def ml_access_token() -> Optional[str]:
    account = await ml_account()
    if not account or not account.get("access_token_enc"):
        return None
    expires = account.get("token_expires_at")
    if expires:
        try:
            dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            if dt <= now() + timedelta(minutes=5):
                return await ml_refresh()
        except Exception:
            pass
    return decrypt_token(account.get("access_token_enc"))


async def ml_request(method: str, path: str, *, token: Optional[str] = None, params: Optional[dict] = None, body: Any = None, headers: Optional[dict] = None, allow: tuple = ()) -> Any:
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    if body is not None:
        h.setdefault("Content-Type", "application/json")
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.request(method, f"{ML_API}{path}", headers=h, params=params, json=body)
    if r.status_code >= 400 and r.status_code not in allow:
        data = json_response_data(r)
        raise HTTPException(502, {"message": "Mercado Livre recusou a operação", "status": r.status_code, "detail": data})
    return r.status_code, json_response_data(r)


@app.get("/api/integrations/mercado-livre/status")
async def ml_status(user: dict = Depends(require_auth)):
    account = await ml_account()
    return {
        "configured": ml_configured() and db_configured() and bool(env("TOKEN_ENCRYPTION_KEY")),
        "status": account.get("status") if account else "DESCONECTADO",
        "account": None if not account else {
            "provider_user_id": account.get("provider_user_id"),
            "nickname": account.get("nickname"),
            "email": account.get("email"),
            "seller_mode": account.get("seller_mode"),
            "connected_at": account.get("connected_at"),
        },
        "redirect_uri": env("ML_REDIRECT_URI") or None,
    }


@app.post("/api/integrations/mercado-livre/connect")
async def ml_connect(user: dict = Depends(require_auth)):
    if not ml_configured() or not db_configured():
        raise HTTPException(503, "Configure Mercado Livre e banco ANV antes de conectar")
    _ = fernet()
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)[:64]
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    await sb_insert("anv_oauth_states", {
        "state": state,
        "code_verifier": verifier,
        "expires_at": iso(now() + timedelta(minutes=10)),
    })
    url = (
        f"{ML_AUTH}?response_type=code&client_id={quote(env('ML_CLIENT_ID'))}"
        f"&redirect_uri={quote(env('ML_REDIRECT_URI'), safe='')}"
        f"&state={quote(state)}&code_challenge={quote(challenge)}&code_challenge_method=S256"
    )
    return {"authorization_url": url}


@app.get("/api/integrations/mercado-livre/oauth/callback")
async def ml_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    app_url = env("APP_BASE_URL") or "/"
    if error:
        return RedirectResponse(f"{app_url.rstrip('/')}?ml_error={quote(error)}")
    if not code or not state:
        raise HTTPException(400, "code/state ausentes")
    states = await sb_select("anv_oauth_states", {"state": f"eq.{state}", "limit": "1"})
    if not states:
        raise HTTPException(400, "State inválido ou expirado")
    record = states[0]
    try:
        if datetime.fromisoformat(record["expires_at"].replace("Z", "+00:00")) < now():
            raise HTTPException(400, "State expirado")
    except KeyError:
        raise HTTPException(400, "State inválido")

    async with httpx.AsyncClient(timeout=30) as client:
        tr = await client.post(f"{ML_API}/oauth/token", data={
            "grant_type": "authorization_code",
            "client_id": env("ML_CLIENT_ID"),
            "client_secret": env("ML_CLIENT_SECRET"),
            "code": code,
            "redirect_uri": env("ML_REDIRECT_URI"),
            "code_verifier": record.get("code_verifier"),
        })
    if tr.status_code != 200:
        return RedirectResponse(f"{app_url.rstrip('/')}?ml_error=token_{tr.status_code}")
    tk = tr.json()
    access = tk.get("access_token")
    _, me_data = await ml_request("GET", "/users/me", token=access)
    tags = me_data.get("tags") or []
    seller_mode = "user_products" if "user_product_seller" in tags else "legacy"
    expires_at = now() + timedelta(seconds=int(tk.get("expires_in") or 21600))
    await sb_upsert("anv_marketplace_accounts", {
        "provider": "mercado_livre",
        "provider_user_id": str(me_data.get("id") or ""),
        "nickname": me_data.get("nickname"),
        "email": me_data.get("email"),
        "seller_mode": seller_mode,
        "access_token_enc": encrypt_token(access),
        "refresh_token_enc": encrypt_token(tk.get("refresh_token")),
        "token_expires_at": iso(expires_at),
        "status": "CONECTADO",
        "connected_at": iso(),
        "updated_at": iso(),
    }, "provider")
    await sb_request("DELETE", "anv_oauth_states", params={"state": f"eq.{state}"})
    return RedirectResponse(f"{app_url.rstrip('/')}?ml_connected=1")


# -----------------------------------------------------------------------------
# Marketplace intelligence + listing publication
# -----------------------------------------------------------------------------

def normalize(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[^0-9A-Za-zÀ-ÿ]+", " ", str(value))).strip()


def legacy_title(p: dict) -> str:
    parts = [p.get("name"), p.get("brand"), p.get("model"), p.get("application")]
    return normalize(" ".join(str(x) for x in parts if x))[:60]


def family_name(p: dict) -> str:
    return normalize(" ".join(str(x) for x in [p.get("name"), p.get("brand"), p.get("model")] if x))[:60]


def description_text(p: dict) -> str:
    lines = [str(p.get("name") or "Produto")]
    specs = [
        ("Marca", p.get("brand")), ("Modelo", p.get("model")), ("Código", p.get("code")),
        ("SKU", p.get("sku")), ("GTIN/EAN", p.get("gtin")), ("Material", p.get("material")),
        ("Aplicação", p.get("application")), ("Compatibilidade", p.get("compatibility")),
        ("Tipo de gás", p.get("gas_type")), ("Voltagem", p.get("voltage")), ("Cor", p.get("color")),
    ]
    present = [(a, b) for a, b in specs if b]
    if present:
        lines += ["", "ESPECIFICAÇÕES"] + [f"- {a}: {b}" for a, b in present]
    if p.get("technical_details"):
        lines += ["", "DETALHES TÉCNICOS", str(p["technical_details"]).strip()]
    if p.get("description"):
        lines += ["", str(p["description"]).strip()]
    return "\n".join(lines)[:5000]



def research_query_terms(body: dict) -> List[str]:
    terms: List[str] = []
    def add(*parts: Any):
        value = " ".join(str(x).strip() for x in parts if x is not None and str(x).strip())
        value = re.sub(r"\s+", " ", value).strip()
        if value and value.lower() not in [x.lower() for x in terms]:
            terms.append(value)
    ean = re.sub(r"\D", "", str(body.get("ean") or body.get("gtin") or ""))
    if ean:
        add(ean)
    strong = body.get("part_number") or body.get("code") or body.get("sku") or body.get("reference")
    if strong:
        add(body.get("brand"), strong)
        add(strong)
    if body.get("brand") and body.get("model"):
        add(body.get("brand"), body.get("model"))
    if body.get("brand") and (body.get("name_hint") or body.get("name")):
        add(body.get("brand"), body.get("name_hint") or body.get("name"))
    if not terms:
        add(body.get("manufacturer"), body.get("name_hint") or body.get("name"), body.get("model"))
    return terms[:5]


def ml_attribute_map(attrs: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for a in attrs or []:
        if not isinstance(a, dict):
            continue
        key = str(a.get("name") or a.get("id") or "").strip()
        if not key:
            continue
        value = a.get("value_name")
        if value in (None, ""):
            value = a.get("value_id")
        if value in (None, "") and isinstance(a.get("values"), list) and a["values"]:
            value = a["values"][0].get("name") or a["values"][0].get("id")
        if value not in (None, ""):
            out[key] = value
    return out


def ml_attribute_id_map(attrs: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for a in attrs or []:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").strip()
        if not aid:
            continue
        value = a.get("value_name") or a.get("value_id")
        if value in (None, "") and isinstance(a.get("values"), list) and a["values"]:
            value = a["values"][0].get("name") or a["values"][0].get("id")
        if value not in (None, ""):
            out[aid] = str(value)
    return out


def ml_pick_attr(attrs: Any, *wanted: str) -> Optional[str]:
    wanted_u = {x.upper() for x in wanted}
    for a in attrs or []:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").upper()
        name = str(a.get("name") or "").upper()
        if aid in wanted_u or any(w in name for w in wanted_u):
            value = a.get("value_name") or a.get("value_id")
            if value not in (None, ""):
                return str(value)
    return None


def ml_reference_candidate(item: dict, query: str) -> dict:
    attrs = item.get("attributes") or []
    pictures = []
    for pic in item.get("pictures") or []:
        if isinstance(pic, dict):
            url = pic.get("secure_url") or pic.get("url")
            if url:
                pictures.append(url)
    if not pictures:
        thumb = item.get("thumbnail") or item.get("secure_thumbnail")
        if thumb:
            pictures.append(thumb)
    item_id = str(item.get("id") or "")
    permalink = item.get("permalink") or (f"https://produto.mercadolivre.com.br/{item_id}" if item_id else None)
    brand = ml_pick_attr(attrs, "BRAND", "MARCA")
    model = ml_pick_attr(attrs, "MODEL", "MODELO")
    gtin = ml_pick_attr(attrs, "GTIN", "EAN")
    part_number = ml_pick_attr(attrs, "MPN", "PART_NUMBER", "PART NUMBER", "OEM")
    code = ml_pick_attr(attrs, "SELLER_SKU", "SKU", "CODIGO", "CÓDIGO") or part_number
    return {
        "url": permalink,
        "permalink": permalink,
        "domain": "mercadolivre.com.br",
        "title": item.get("title"),
        "name": item.get("title"),
        "source_type": "marketplace",
        "manufacturer": brand,
        "brand": brand,
        "model": model,
        "code": code,
        "part_number": part_number,
        "ean": gtin,
        "description": None,
        "image_url": pictures[0] if pictures else None,
        "specifications": ml_attribute_map(attrs),
        "evidence": [f"Resultado Mercado Livre para: {query}"],
        "item_id": item_id or None,
        "category_id": item.get("category_id"),
        "marketplace": {
            "item_id": item_id or None,
            "category_id": item.get("category_id"),
            "attributes": ml_attribute_id_map(attrs),
            "attribute_labels": ml_attribute_map(attrs),
            "pictures": pictures[:10],
            "condition": item.get("condition"),
            "listing_type_id": item.get("listing_type_id"),
            "buying_mode": item.get("buying_mode"),
        },
    }


@app.post("/api/marketplace/search-reference")
async def marketplace_search_reference(body: Dict[str, Any], user: dict = Depends(require_auth)):
    queries = research_query_terms(body or {})
    if not queries:
        return {"ok": True, "queries": [], "candidates": [], "warnings": ["Pistas insuficientes para pesquisar no Mercado Livre"]}

    token = await ml_access_token() if db_configured() else None
    warnings: List[str] = []
    raw_items: Dict[str, dict] = {}
    item_query: Dict[str, str] = {}
    searched = 0

    for query in queries:
        try:
            status, data = await ml_request(
                "GET", f"/sites/{SITE_ID}/search", token=token,
                params={"q": query, "limit": 8}, allow=(400, 401, 403, 404)
            )
        except Exception as exc:
            warnings.append(f"Busca Mercado Livre indisponível para '{query}': {type(exc).__name__}")
            continue
        searched += 1
        if status != 200 or not isinstance(data, dict):
            warnings.append(f"Busca Mercado Livre retornou HTTP {status} para '{query}'")
            continue
        for item in (data.get("results") or [])[:8]:
            iid = str(item.get("id") or "")
            if iid and iid not in raw_items:
                raw_items[iid] = item
                item_query[iid] = query
        if len(raw_items) >= 8:
            break

    # Enriquecer poucos candidatos com a ficha pública/permitida do item.
    async def enrich(iid: str, base: dict):
        try:
            status, detail = await ml_request("GET", f"/items/{iid}", token=token, allow=(400, 401, 403, 404))
            if status == 200 and isinstance(detail, dict):
                merged = dict(base)
                merged.update({k: v for k, v in detail.items() if v is not None})
                return iid, merged
        except Exception:
            pass
        return iid, base

    enriched_pairs = await asyncio.gather(*(enrich(iid, item) for iid, item in list(raw_items.items())[:8])) if raw_items else []
    candidates = [ml_reference_candidate(item, item_query.get(iid, "")) for iid, item in enriched_pairs]
    return {
        "ok": True,
        "queries": queries,
        "searched_queries": searched,
        "candidates": candidates,
        "warnings": warnings,
        "source": "mercado_livre_existing_integration_read_only",
    }


async def category_suggestions_raw(q: str, token: Optional[str]) -> List[dict]:
    _, data = await ml_request("GET", f"/sites/{SITE_ID}/domain_discovery/search", token=token, params={"q": q, "limit": 3})
    return data if isinstance(data, list) else []


async def category_requirements_raw(category_id: str, token: Optional[str]) -> dict:
    _, cat = await ml_request("GET", f"/categories/{category_id}", token=token)
    _, attrs = await ml_request("GET", f"/categories/{category_id}/attributes", token=token)
    status, tech = await ml_request("GET", f"/categories/{category_id}/technical_specs/input", token=token, allow=(404,))
    return {"category": cat or {}, "attributes": attrs or [], "technical_specs": None if status == 404 else tech}


def attr_value(product: dict, attr: dict) -> Optional[str]:
    attr_id = str(attr.get("id") or "").upper()
    name = str(attr.get("name") or "").lower()
    mapping = {
        "BRAND": product.get("brand"), "MODEL": product.get("model"), "COLOR": product.get("color"),
        "VOLTAGE": product.get("voltage"), "SELLER_SKU": product.get("sku") or product.get("code"),
        "MATERIAL": product.get("material"), "GTIN": product.get("gtin"),
        "PACKAGE_LENGTH": f"{product.get('package_length_cm')} cm" if product.get("package_length_cm") else None,
        "PACKAGE_WIDTH": f"{product.get('package_width_cm')} cm" if product.get("package_width_cm") else None,
        "PACKAGE_HEIGHT": f"{product.get('package_height_cm')} cm" if product.get("package_height_cm") else None,
        "PACKAGE_WEIGHT": f"{product.get('package_weight_g')} g" if product.get("package_weight_g") else None,
    }
    if mapping.get(attr_id):
        return str(mapping[attr_id])
    if ("gás" in name or "gas" in name) and product.get("gas_type"):
        return str(product["gas_type"])
    if "compat" in name and product.get("compatibility"):
        return str(product["compatibility"])
    if ("aplica" in name or "uso" in name) and product.get("application"):
        return str(product["application"])
    return None


def is_required(attr: dict) -> bool:
    tags = attr.get("tags") or {}
    if isinstance(tags, dict):
        return bool(tags.get("required") or tags.get("new_required") or tags.get("catalog_required"))
    if isinstance(tags, list):
        return "required" in tags or "new_required" in tags
    return False


def technical_attrs(node: Any) -> List[dict]:
    found: Dict[str, dict] = {}
    def walk(x: Any):
        if isinstance(x, dict):
            if x.get("id") and x.get("name") and ("value_type" in x or "tags" in x):
                found[str(x["id"])] = x
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(node)
    return list(found.values())


class PreflightIn(BaseModel):
    product_id: Optional[str] = None
    product: Optional[Dict[str, Any]] = None
    category_id: Optional[str] = None
    listing_type_id: str = "gold_special"
    free_shipping: bool = False
    attributes: Dict[str, str] = Field(default_factory=dict)
    images: List[str] = Field(default_factory=list)


async def resolve_product(body: PreflightIn) -> dict:
    if body.product:
        return body.product
    if body.product_id:
        rows = await sb_select("anv_products", {"id": f"eq.{body.product_id}", "limit": "1"})
        if not rows:
            raise HTTPException(404, "Produto não encontrado")
        return rows[0]
    raise HTTPException(400, "Informe product_id ou product")


async def preflight_result(body: PreflightIn) -> dict:
    product = await resolve_product(body)
    token = await ml_access_token() if db_configured() else None
    title = legacy_title(product)
    suggestions = await category_suggestions_raw(title or str(product.get("name") or ""), token)
    category_id = body.category_id or (suggestions[0].get("category_id") if suggestions else None)
    if not category_id:
        return {"ready": False, "blockers": ["Categoria do Mercado Livre não identificada"], "suggestions": suggestions}
    req = await category_requirements_raw(category_id, token)
    output_attrs: List[dict] = []
    populated = set()
    required_missing = []
    recommended_missing = []

    for a in req["attributes"]:
        aid = str(a.get("id") or "")
        value = body.attributes.get(aid) if aid else None
        if value is None:
            value = attr_value(product, a)
        if aid == "ITEM_CONDITION" and not value:
            # New developments should prefer ITEM_CONDITION attribute.
            values = a.get("values") or []
            new_v = next((v for v in values if str(v.get("name") or "").lower() in ("novo", "new")), None)
            if new_v:
                x = {"id": aid}
                if new_v.get("id"):
                    x["value_id"] = new_v["id"]
                else:
                    x["value_name"] = new_v.get("name")
                output_attrs.append(x)
                populated.add(aid)
                continue
        if value not in (None, ""):
            output_attrs.append({"id": aid, "value_name": str(value)})
            populated.add(aid)
        elif aid and is_required(a):
            required_missing.append({"id": aid, "name": a.get("name"), "value_type": a.get("value_type")})

    tech = technical_attrs(req.get("technical_specs"))
    for a in tech:
        aid = str(a.get("id") or "")
        if aid and is_required(a) and aid not in populated:
            recommended_missing.append({"id": aid, "name": a.get("name"), "value_type": a.get("value_type")})

    account = await ml_account() if db_configured() else None
    seller_mode = (account or {}).get("seller_mode") or "unknown"
    pictures_count = len(body.images)
    if not pictures_count and body.product_id and db_configured():
        imgs = await sb_select("anv_product_images", {"product_id": f"eq.{body.product_id}"})
        pictures_count = len(imgs)

    blockers = []
    warnings = []
    if required_missing:
        blockers.append(f"{len(required_missing)} atributo(s) obrigatório(s) ainda sem valor")
    if float(product.get("sale_price") or product.get("price") or 0) <= 0:
        blockers.append("Preço deve ser maior que zero")
    if int(product.get("stock") or product.get("qty") or 0) <= 0:
        blockers.append("Estoque deve ser maior que zero")
    if pictures_count <= 0:
        blockers.append("Adicione ao menos uma foto real do produto")
    if pictures_count < 5:
        warnings.append("Padrão ANV: capa + pelo menos 4 imagens adicionais")
    if recommended_missing:
        warnings.append(f"{len(recommended_missing)} dado(s) técnico(s) recomendado(s) ainda ausentes")

    max_pics = (req.get("category") or {}).get("settings", {}).get("max_pictures_per_item")
    if max_pics and pictures_count > int(max_pics):
        blockers.append(f"Categoria aceita no máximo {max_pics} imagens")

    return {
        "ready": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "seller_mode": seller_mode,
        "suggestions": suggestions,
        "selected_category": {
            "id": category_id,
            "name": req.get("category", {}).get("name"),
            "path_from_root": req.get("category", {}).get("path_from_root") or [],
            "max_pictures_per_item": max_pics,
        },
        "required_missing": required_missing,
        "recommended_missing": recommended_missing,
        "available_attributes": req["attributes"],
        "payload_preview": {
            "title": title if seller_mode != "user_products" else None,
            "family_name": family_name(product) if seller_mode == "user_products" else None,
            "category_id": category_id,
            "price": float(product.get("sale_price") or product.get("price") or 0),
            "available_quantity": int(product.get("stock") or product.get("qty") or 0),
            "listing_type_id": body.listing_type_id,
            "attributes": output_attrs,
            "description": description_text(product),
            "pictures_count": pictures_count,
            "free_shipping": body.free_shipping,
        },
    }


@app.get("/api/marketplace/category-suggestions")
async def category_suggestions(q: str, user: dict = Depends(require_auth)):
    token = await ml_access_token() if db_configured() else None
    return await category_suggestions_raw(q, token)


@app.get("/api/marketplace/categories/{category_id}/requirements")
async def category_requirements(category_id: str, user: dict = Depends(require_auth)):
    token = await ml_access_token() if db_configured() else None
    return await category_requirements_raw(category_id, token)


@app.post("/api/marketplace/preflight")
async def preflight(body: PreflightIn, user: dict = Depends(require_auth)):
    return await preflight_result(body)


async def upload_ml_picture(data_url: str, token: str) -> dict:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, flags=re.S)
    if not m:
        raise HTTPException(400, "Imagem inválida para upload")
    raw = base64.b64decode(m.group(2))
    mime = m.group(1)
    async with httpx.AsyncClient(timeout=45) as client:
        r = await client.post(
            f"{ML_API}/pictures/items/upload",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("anv-product.jpg", raw, mime)},
        )
    if r.status_code >= 400:
        raise HTTPException(502, {"message": "Mercado Livre recusou uma imagem", "status": r.status_code, "detail": json_response_data(r)})
    return r.json()


class PublishIn(PreflightIn):
    confirm: bool = False


@app.post("/api/marketplace/publish")
async def publish(body: PublishIn, user: dict = Depends(require_auth)):
    if not body.confirm:
        raise HTTPException(400, "Confirmação obrigatória")
    if not db_configured():
        raise HTTPException(503, "Banco ANV necessário para publicar e manter vínculo do anúncio")
    token = await ml_access_token()
    account = await ml_account()
    if not token or not account or account.get("status") != "CONECTADO":
        raise HTTPException(400, "Conecte a conta Mercado Livre primeiro")
    check = await preflight_result(body)
    if not check.get("ready"):
        raise HTTPException(400, {"message": "Preflight reprovado", "blockers": check.get("blockers"), "required_missing": check.get("required_missing")})
    product = await resolve_product(body)
    pictures = []
    for image in body.images:
        if image.startswith("data:"):
            uploaded = await upload_ml_picture(image, token)
            if uploaded.get("id"):
                pictures.append({"id": uploaded["id"]})
        elif image.startswith("https://") or image.startswith("http://"):
            pictures.append({"source": image})
    if not pictures:
        raise HTTPException(400, "Nenhuma imagem publicável")

    preview = check["payload_preview"]
    payload: Dict[str, Any] = {
        "category_id": preview["category_id"],
        "price": preview["price"],
        "currency_id": "BRL",
        "available_quantity": preview["available_quantity"],
        "buying_mode": "buy_it_now",
        "listing_type_id": preview["listing_type_id"],
        "pictures": pictures,
        "attributes": preview["attributes"],
        "shipping": {"free_shipping": preview["free_shipping"]},
        "channels": ["marketplace"],
        "condition": "new",
    }
    if account.get("seller_mode") == "user_products":
        payload["family_name"] = preview["family_name"] or family_name(product)
    else:
        payload["title"] = preview["title"] or legacy_title(product)

    _, item = await ml_request("POST", "/items", token=token, body=payload)
    item_id = item.get("id")
    description_status = None
    if item_id and preview.get("description"):
        description_status, _ = await ml_request(
            "POST", f"/items/{item_id}/description", token=token,
            body={"plain_text": preview["description"]}, allow=(400, 404)
        )

    product_id = body.product_id
    if not product_id:
        # Persist a product sent from local-first UI before saving listing.
        data = clean_product(product)
        if "name" not in data and product.get("title"):
            data["name"] = product["title"]
        if "sale_price" not in data and product.get("price") is not None:
            data["sale_price"] = product.get("price")
        if "stock" not in data and product.get("qty") is not None:
            data["stock"] = product.get("qty")
        saved = await sb_insert("anv_products", data)
        product_id = saved["id"]

    listing = await sb_insert("anv_marketplace_listings", {
        "provider": "mercado_livre",
        "product_id": product_id,
        "item_id": item_id,
        "user_product_id": item.get("user_product_id"),
        "category_id": item.get("category_id") or preview["category_id"],
        "title": item.get("title") or preview.get("title"),
        "family_name": item.get("family_name") or preview.get("family_name"),
        "permalink": item.get("permalink"),
        "seller_mode": account.get("seller_mode"),
        "listing_type_id": preview["listing_type_id"],
        "status": item.get("status"),
        "price": item.get("price") or preview["price"],
        "available_quantity": item.get("available_quantity") or preview["available_quantity"],
        "last_sync_at": iso(),
        "published_at": iso(),
    })
    return {"ok": True, "listing": listing, "ml_item": item, "description_http_status": description_status}


# -----------------------------------------------------------------------------
# Orders, stock and notifications
# -----------------------------------------------------------------------------

async def notify_once(kind: str, entity_id: str, title: str, message: str):
    existing = await sb_select("anv_notifications", {
        "kind": f"eq.{kind}", "entity_id": f"eq.{entity_id}", "limit": "1"
    })
    if existing:
        return
    await sb_insert("anv_notifications", {
        "kind": kind, "title": title, "message": message,
        "entity_type": "order" if kind == "NEW_ORDER" else "shipment",
        "entity_id": entity_id, "channel": "in_app", "status": "pending"
    })


async def resolve_order_product(item_data: dict) -> Optional[dict]:
    item_id = str(item_data.get("id") or "")
    if item_id:
        listings = await sb_select("anv_marketplace_listings", {"item_id": f"eq.{item_id}", "limit": "1"})
        if listings:
            products = await sb_select("anv_products", {"id": f"eq.{listings[0]['product_id']}", "limit": "1"})
            if products:
                return products[0]
    seller_sku = item_data.get("seller_sku") or item_data.get("seller_custom_field")
    if not seller_sku:
        for a in item_data.get("variation_attributes") or []:
            if str(a.get("id") or "").upper() == "SELLER_SKU":
                seller_sku = a.get("value_name") or a.get("value_id")
                break
    if seller_sku:
        by_sku = await sb_select("anv_products", {"sku": f"eq.{seller_sku}", "limit": "1"})
        if by_sku:
            return by_sku[0]
        by_code = await sb_select("anv_products", {"code": f"eq.{seller_sku}", "limit": "1"})
        if by_code:
            return by_code[0]
    return None


async def order_shipments(order_id: str, token: str) -> List[dict]:
    try:
        _, data = await ml_request(
            "GET", f"/orders/{order_id}/shipments", token=token,
            params={"list_all": "true"}, headers={"X-New-Domain": "true", "X-Api-Version": "2"},
            allow=(404, 410)
        )
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and data.get("id"):
            return [data]
    except Exception:
        pass
    return []


async def process_order(resource: str):
    token = await ml_access_token()
    if not token:
        return
    order_id = resource.rstrip("/").split("/")[-1]
    if not order_id:
        return
    _, order = await ml_request("GET", f"/orders/{order_id}", token=token)
    status = str(order.get("status") or "")
    shipments = await order_shipments(order_id, token)
    shipment_id = str(shipments[0].get("id")) if shipments and shipments[0].get("id") else None
    shipping_status = shipments[0].get("status") if shipments else None

    order_row = await sb_upsert("anv_orders", {
        "provider": "mercado_livre",
        "provider_order_id": order_id,
        "pack_id": str(order.get("pack_id")) if order.get("pack_id") else None,
        "shipment_id": shipment_id,
        "buyer_nickname": (order.get("buyer") or {}).get("nickname"),
        "total_amount": order.get("total_amount"),
        "currency_id": order.get("currency_id"),
        "marketplace_status": status,
        "shipping_status": shipping_status,
        "date_created": order.get("date_created"),
        "date_closed": order.get("date_closed"),
        "last_marketplace_update_at": iso(),
        "updated_at": iso(),
    }, "provider_order_id")

    new_order = status in ("paid", "confirmed", "shipped", "delivered")
    for oi in order.get("order_items") or []:
        item_data = oi.get("item") or {}
        provider_item_id = str(item_data.get("id") or "")
        qty = int(oi.get("quantity") or 0)
        if not provider_item_id or qty <= 0:
            continue
        product = await resolve_order_product(item_data)
        seller_sku = item_data.get("seller_sku") or item_data.get("seller_custom_field")
        await sb_upsert("anv_order_items", {
            "order_id": order_row["id"],
            "provider_item_id": provider_item_id,
            "product_id": product.get("id") if product else None,
            "seller_sku": seller_sku,
            "title": item_data.get("title"),
            "quantity": qty,
            "unit_price": oi.get("unit_price"),
            "status": status if product else "unlinked",
            "updated_at": iso(),
        }, "order_id,provider_item_id")

        if not product:
            await sb_insert("anv_alerts", {
                "kind": "ORDER_UNLINKED", "severity": "warning",
                "title": f"Pedido {order_id}: item sem vínculo",
                "message": f"Item ML {provider_item_id} não encontrou produto ANV (SKU={seller_sku})",
                "entity_type": "order", "entity_id": order_id,
            })
            continue

        sale_key = f"meli:order:{order_id}:item:{provider_item_id}:product:{product['id']}:sale"
        reversal_key = f"meli:order:{order_id}:item:{provider_item_id}:product:{product['id']}:reversal"
        if new_order:
            try:
                await sb_rpc("anv_apply_stock_movement", {
                    "p_product_id": product["id"], "p_type": "VENDA", "p_quantity": qty,
                    "p_idempotency_key": sale_key, "p_reason": f"Venda Mercado Livre {order_id}",
                    "p_provider_order_id": order_id, "p_actor": "mercado_livre", "p_allow_negative": False,
                })
            except Exception:
                await sb_insert("anv_alerts", {
                    "kind": "STOCK_MISMATCH", "severity": "critical",
                    "title": f"Venda {order_id}: estoque precisa de conferência",
                    "message": f"Não foi possível baixar {qty} unidade(s) de {product.get('name')}",
                    "entity_type": "order", "entity_id": order_id,
                })
        elif status == "cancelled":
            prior = await sb_select("anv_stock_movements", {"idempotency_key": f"eq.{sale_key}", "limit": "1"})
            if prior:
                await sb_rpc("anv_apply_stock_movement", {
                    "p_product_id": product["id"], "p_type": "ESTORNO", "p_quantity": qty,
                    "p_idempotency_key": reversal_key, "p_reason": f"Cancelamento Mercado Livre {order_id}",
                    "p_provider_order_id": order_id, "p_actor": "mercado_livre", "p_allow_negative": False,
                })

    if new_order:
        await notify_once("NEW_ORDER", order_id, "Nova venda no Mercado Livre", f"Pedido {order_id} recebido. Separar o produto para postagem.")


async def process_shipment(resource: str):
    token = await ml_access_token()
    if not token:
        return
    shipment_id = resource.rstrip("/").split("/")[-1]
    if not shipment_id:
        return
    _, shipment = await ml_request("GET", f"/shipments/{shipment_id}", token=token, headers={"x-format-new": "true"})
    status = shipment.get("status")
    substatus = shipment.get("substatus")
    operational = None
    if status == "ready_to_ship":
        operational = "AGUARDANDO_NF" if substatus == "invoice_pending" else "PRONTO_PARA_ENVIO"
    elif status == "shipped":
        operational = "DESPACHADO"
    elif status == "delivered":
        operational = "CONCLUIDO"
    elif status in ("not_delivered", "cancelled"):
        operational = "PROBLEMA_ENTREGA"

    patch = {"shipping_status": status, "last_marketplace_update_at": iso(), "updated_at": iso()}
    if operational:
        patch["operational_status"] = operational
    rows = await sb_patch("anv_orders", {"shipment_id": f"eq.{shipment_id}"}, patch)
    if not rows:
        await sb_insert("anv_alerts", {
            "kind": "SHIPMENT_UNLINKED", "severity": "warning",
            "title": f"Envio {shipment_id} sem pedido vinculado",
            "message": f"Status recebido: {status}/{substatus}",
            "entity_type": "shipment", "entity_id": shipment_id,
        })
    else:
        await notify_once("SHIPMENT_UPDATE", shipment_id, "Atualização de envio", f"Envio {shipment_id}: {status}{' / ' + substatus if substatus else ''}")


@app.post("/api/integrations/mercado-livre/webhooks")
async def ml_webhook(request: Request):
    # Return 200 even if integration is not ready so ML does not retry an intentionally unconfigured endpoint.
    if not db_configured():
        return {"ok": True, "ignored": "database_not_configured"}
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    topic = str(payload.get("topic") or "")
    resource = str(payload.get("resource") or "")
    account = await ml_account()
    notification_user = str(payload.get("user_id") or "")
    if account and account.get("provider_user_id") and notification_user and notification_user != str(account.get("provider_user_id")):
        return {"ok": True, "ignored": "foreign_user"}

    event_id = str(payload.get("_id") or payload.get("id") or "")
    if not event_id:
        event_id = hashlib.sha256(f"{topic}|{resource}|{payload.get('sent')}".encode()).hexdigest()
    status_code, data = await sb_request(
        "POST", "anv_webhook_events",
        body={
            "provider": "mercado_livre", "provider_event_id": event_id,
            "topic": topic, "resource": resource, "provider_user_id": notification_user or None,
            "payload": payload, "status": "received", "received_at": iso(),
        },
        prefer="return=representation", allow=(409,)
    )
    if status_code == 409:
        return {"ok": True, "duplicate": True}

    try:
        if topic in ("orders_v2", "orders"):
            await process_order(resource)
        elif topic == "shipments":
            await process_shipment(resource)
        await sb_patch("anv_webhook_events", {"provider": "eq.mercado_livre", "provider_event_id": f"eq.{event_id}"}, {"status": "processed", "processed_at": iso()})
    except Exception as exc:
        await sb_patch("anv_webhook_events", {"provider": "eq.mercado_livre", "provider_event_id": f"eq.{event_id}"}, {"status": "failed", "error": str(exc)[:500], "processed_at": iso()})
        # Keep HTTP 200: event is persisted and can be reprocessed after correction.
        return {"ok": True, "stored": True, "processing": "failed"}
    return {"ok": True, "processed": True}


@app.get("/api/orders")
async def orders_list(user: dict = Depends(require_auth)):
    orders = await sb_select("anv_orders", {"order": "created_at.desc", "limit": "200"})
    if not orders:
        return []
    items = await sb_select("anv_order_items", {"order": "created_at.asc", "limit": "1000"})
    grouped: Dict[str, List[dict]] = {}
    for item in items:
        grouped.setdefault(str(item.get("order_id")), []).append(item)
    for order in orders:
        order["items"] = grouped.get(str(order.get("id")), [])
    return orders


class OperationalStatusIn(BaseModel):
    status: str


@app.patch("/api/orders/{order_id}/operational-status")
async def order_operational_status(order_id: str, body: OperationalStatusIn, user: dict = Depends(require_auth)):
    allowed = {"NOVO", "SEPARAR", "EMBALAR", "PRONTO_PARA_ENVIO", "AGUARDANDO_NF", "DESPACHADO", "CONCLUIDO", "PROBLEMA_ENTREGA", "CANCELADO"}
    status = body.status.upper().strip()
    if status not in allowed:
        raise HTTPException(400, "Status operacional inválido")
    rows = await sb_patch("anv_orders", {"id": f"eq.{order_id}"}, {"operational_status": status, "updated_at": iso()})
    if not rows:
        raise HTTPException(404, "Pedido não encontrado")
    return rows[0]


@app.get("/api/notifications")
async def notifications_list(user: dict = Depends(require_auth)):
    return await sb_select("anv_notifications", {"order": "created_at.desc", "limit": "200"})


@app.post("/api/notifications/{notification_id}/read")
async def notification_read(notification_id: str, user: dict = Depends(require_auth)):
    rows = await sb_patch("anv_notifications", {"id": f"eq.{notification_id}"}, {"read_at": iso(), "status": "read"})
    if not rows:
        raise HTTPException(404, "Notificação não encontrada")
    return {"ok": True}
