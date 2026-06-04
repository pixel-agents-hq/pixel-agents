# Plugin Screenshot para JetBrains Marketplace (con ChatGPT)

Objetivo: imagen **≥ 1200 × 760 px** (PNG o JPG) que muestre el plugin
**IT Crowd Pixel Agents** corriendo dentro de un IDE JetBrains.

> ⚠️ Clave: **adjunta el screenshot real del office** para que ChatGPT lo
> componga en vez de inventar el pixel art (los modelos no reproducen bien
> texto ni sprites a mano).
> Archivo: `webview-ui/public/Screenshot.jpg` (o toma una captura del panel
> Pixel Agents en tu PyCharm).

---

## Opción A — Generar la imagen con ChatGPT (DALL·E / GPT-4o image)

1. Abre ChatGPT (modo con generación de imágenes).
2. **Adjunta** `webview-ui/public/Screenshot.jpg`.
3. Pega este prompt:

```
Create a clean marketing screenshot for a JetBrains IDE plugin, 1200x760 pixels, landscape.

Use the IMAGE I attached (a pixel-art office) as the main content panel — keep it
unmodified and sharp, do not redraw it.

Compose it inside a modern dark IDE window mockup:
- Dark background, radial gradient from #2a2a40 to #0e0e16.
- A window card (#1e1e2e) with a 2px #313244 border and a hard offset shadow
  (10px 10px, no blur) — flat "pixel" aesthetic, sharp corners only.
- Top title bar (#181825): three traffic-light dots (red/yellow/green) on the
  left, the text "IT Crowd Pixel Agents — PyCharm" in light gray, and a small
  solid blue (#0183ff) "JETBRAINS" tag on the right.
- The attached pixel-art office fills the body of the window.
- A bottom ribbon with: title "IT Crowd Pixel Agents" (white, the words
  "Pixel Agents" in blue #0183ff), subtitle "Your Claude Code agents come to
  life in your JetBrains IDE", and three small feature chips:
  "Live agents", "Pixel office", "PyCharm & WebStorm".

Style: flat, crisp, developer-tool look. No drop shadows with blur, no rounded
corners, no photo-realism. Output exactly 1200x760.
```

4. Si el texto sale mal (DALL·E suele deformar letras), pídele:
   _"Regenerate keeping all text perfectly legible and correctly spelled."_
   o usa la **Opción B** (texto exacto garantizado).

---

## Opción B — Mockup HTML exacto (texto perfecto, recomendado)

ChatGPT genera el HTML; tú lo abres y haces screenshot. El texto sale exacto.

1. Prompt a ChatGPT:

```
Generate a single self-contained HTML file (inline CSS, no external assets)
that renders a 1200x760 px marketing screenshot for a JetBrains plugin called
"IT Crowd Pixel Agents".

Layout:
- Body exactly 1200x760, dark radial-gradient background (#2a2a40 -> #0e0e16),
  content centered.
- A window card (width ~1112px, background #1e1e2e, 2px solid #313244 border,
  box-shadow 10px 10px 0 #07070d, sharp corners).
- Title bar (height 46px, background #181825, 2px bottom border #313244):
  three 13px dots (#f38ba8, #f9e2af, #a6e3a1), then text
  "IT Crowd Pixel Agents — PyCharm" (bold name in #cdd6f4, rest #9399b2),
  and on the far right a #0183ff tag reading "JETBRAINS".
- An <img> placeholder filling the window body (I will swap in my office
  screenshot); give it width:100% and a 2px bottom border #313244.
- Bottom ribbon (padding ~22px 30px): left side title "IT Crowd Pixel Agents"
  (34px, white, the words "Pixel Agents" in #0183ff) with subtitle
  "Your Claude Code agents come to life in your JetBrains IDE" (#9399b2);
  right side three chips (background #181825, 2px #313244 border,
  box-shadow 3px 3px 0 #07070d) reading "Live agents", "Pixel office",
  "PyCharm & WebStorm".
Use a clean sans-serif. Flat pixel-tool aesthetic: no rounded corners, no blur.
```

2. Reemplaza el `src` del `<img>` por tu screenshot
   (`webview-ui/public/Screenshot.jpg`, o pégalo como `data:image/jpeg;base64,...`).
3. Abre el HTML en el navegador.
4. Captura a 1200×760:
   - Chrome DevTools → `Ctrl+Shift+P` → **"Capture node screenshot"** sobre el
     `.window`, **o**
   - DevTools → device toolbar → tamaño 1200×760 → captura de página completa.

---

## Subir al Marketplace

https://plugins.jetbrains.com → tu plugin → **Edit** → sección **Media** →
**Add screenshot** → sube el PNG/JPG (≥1200×760).

**Source code URL:** `https://github.com/rlarin/it-crowd-pixel-agents`
