import json
import os
import base64

BASE = os.path.dirname(__file__)

def embed_images(results):
    for item in results:
        path = item.get("image_path")
        if path and os.path.exists(path):
            ext = path.rsplit(".", 1)[-1].lower()
            mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            item["image_path"] = f"data:{mime};base64,{b64}"
    return results

with open(os.path.join(BASE, "simple_test_results.json"), encoding="utf-8") as f:
    simple = embed_images(json.load(f))

with open(os.path.join(BASE, "image_test_results.json"), encoding="utf-8") as f:
    image = embed_images(json.load(f))

with open(os.path.join(BASE, "results_viewer.html"), encoding="utf-8") as f:
    html = f.read()

html = html.replace("__SIMPLE__", json.dumps(simple, ensure_ascii=False))
html = html.replace("__IMAGE__",  json.dumps(image,  ensure_ascii=False))

out = os.path.join(BASE, "results_viewer_built.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)

print(f"✅ Built: {out}")
