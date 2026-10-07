import os
import sys
from typing import Any, Dict

from fastapi import FastAPI, Depends, HTTPException

ROOT = os.path.dirname(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from api.index import (  # noqa: E402
    PublishIn,
    require_auth,
    db_configured,
    ml_access_token,
    ml_account,
    preflight_result,
    resolve_product,
    upload_ml_picture,
    ml_request,
    sb_insert,
    sb_select,
    sb_patch,
    clean_product,
    family_name,
    legacy_title,
    iso,
)

app = FastAPI(title="ANV Safe Mercado Livre Publisher")


@app.post("/{path:path}")
async def publish_safe(path: str, body: PublishIn, user: dict = Depends(require_auth)):
    if not body.confirm:
        raise HTTPException(400, "Confirmação obrigatória")
    if not db_configured():
        raise HTTPException(503, "Banco ANV necessário para publicar e manter vínculo do anúncio")
    if len(body.images or []) < 5:
        raise HTTPException(400, "Gere o pacote de 5 imagens comerciais antes de publicar")

    token = await ml_access_token()
    account = await ml_account()
    if not token or not account or account.get("status") != "CONECTADO":
        raise HTTPException(400, "Conecte a conta Mercado Livre primeiro")

    if body.product_id:
        existing = await sb_select("anv_marketplace_listings", {
            "product_id": f"eq.{body.product_id}",
            "order": "created_at.desc",
            "limit": "20",
        })
        active = next((x for x in existing if x.get("item_id") and str(x.get("status") or "").lower() not in {"closed", "inactive", "deleted"}), None)
        if active:
            raise HTTPException(409, {
                "message": "Este produto já possui anúncio ativo no Mercado Livre",
                "item_id": active.get("item_id"),
                "permalink": active.get("permalink"),
                "status": active.get("status"),
            })

    check = await preflight_result(body)
    if not check.get("ready"):
        raise HTTPException(400, {
            "message": "Preflight reprovado",
            "blockers": check.get("blockers") or [],
            "required_missing": check.get("required_missing") or [],
        })

    product = await resolve_product(body)
    pictures = []
    for image in body.images:
        if image.startswith("data:"):
            uploaded = await upload_ml_picture(image, token)
            if uploaded.get("id"):
                pictures.append({"id": uploaded["id"]})
        elif image.startswith("https://") or image.startswith("http://"):
            pictures.append({"source": image})
    if len(pictures) < 5:
        raise HTTPException(400, "O Mercado Livre não recebeu o pacote mínimo de 5 imagens")

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
        payload["family_name"] = preview.get("family_name") or family_name(product)
    else:
        payload["title"] = preview.get("title") or legacy_title(product)

    _, item = await ml_request("POST", "/items", token=token, body=payload)
    item_id = item.get("id")
    if not item_id:
        raise HTTPException(502, "Mercado Livre não retornou item_id após a publicação")

    product_id = body.product_id
    if not product_id:
        data = clean_product(product)
        if "name" not in data and product.get("title"):
            data["name"] = product["title"]
        if "sale_price" not in data and product.get("price") is not None:
            data["sale_price"] = product.get("price")
        if "stock" not in data and product.get("qty") is not None:
            data["stock"] = product.get("qty")
        saved = await sb_insert("anv_products", data)
        product_id = saved["id"]

    try:
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
            "price": item.get("price") if item.get("price") is not None else preview["price"],
            "available_quantity": item.get("available_quantity") if item.get("available_quantity") is not None else preview["available_quantity"],
            "last_sync_at": iso(),
            "published_at": iso(),
        })
    except Exception:
        try:
            await ml_request("PUT", f"/items/{item_id}", token=token, body={"status": "closed"}, allow=(400, 404))
        finally:
            raise

    await sb_patch("anv_products", {"id": f"eq.{product_id}"}, {"status": "publicado", "updated_at": iso()})

    description_status = None
    description_warning = None
    if preview.get("description"):
        try:
            description_status, _ = await ml_request(
                "POST",
                f"/items/{item_id}/description",
                token=token,
                body={"plain_text": preview["description"]},
                allow=(400, 404),
            )
            if description_status not in (200, 201):
                description_warning = f"Anúncio publicado, mas a descrição retornou HTTP {description_status}"
        except Exception as exc:
            description_warning = "Anúncio publicado e vinculado; a descrição poderá ser sincronizada novamente"

    return {
        "ok": True,
        "listing": listing,
        "ml_item": item,
        "description_http_status": description_status,
        "warning": description_warning,
    }
