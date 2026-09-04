# Immersive wallpaper and model-branding research

Date: 2026-09-04

## Product decisions

- Keep the selected artwork unfiltered and full-bleed. Put blur and translucency only on the
  controls or text surfaces that need contrast.
- Treat the title bar and sidebar as one wallpaper-aware chrome material so they feel related to the
  scene without copying the image into every pane.
- Use a small, artwork-specific token set for chrome, panels, accent, ink, borders, and shadows.
  This preserves one interface hierarchy while letting each scene have its own color character.
- Remove clipped outer radii on full-bleed opening and chat surfaces. Rounded corners belong to
  floating cards, not the image viewport.
- Identify model cards by the company that released the model, independently from the provider
  hosting it or the Hugging Face account repacking it.
- Use first-party marks without redrawing them where an authoritative asset is available. The OpenAI
  Blossom, Qwen mark, and xAI mark were replaced in this pass; existing company marks were checked
  against first-party brand or organization references.
- Keep a monogram fallback for publishers without a verified asset instead of guessing at a logo.

## UI and accessibility sources

1. [MDN: background-size](https://developer.mozilla.org/en-US/docs/Web/CSS/background-size)
2. [MDN: backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
3. [MDN: color-mix](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix)
4. [MDN: prefers-contrast](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-contrast)
5. [W3C WCAG: Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
6. [W3C WCAG: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
7. [W3C WCAG: Distinguishable](https://www.w3.org/WAI/WCAG22/Understanding/distinguishable)
8. [W3C WAI: Designing for accessibility](https://www.w3.org/WAI/tips/designing/)
9. [Microsoft Windows: Materials](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/materials)
10. [Microsoft Windows: Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
11. [Microsoft Windows: Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
12. [Microsoft Windows: Color](https://learn.microsoft.com/en-us/windows/apps/design/style/color)
13. [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
14. [Apple HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color)

## Brand and model-publisher sources

15. [OpenAI design guidelines](https://openai.com/brand/)
16. [OpenAI Agents SDK first-party Blossom asset](https://github.com/openai/openai-agents-python/blob/main/docs/assets/logo.svg)
17. [Qwen3 official repository](https://github.com/QwenLM/Qwen3)
18. [Qwen first-party icon asset](https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/src/capabilities/video-edit/skill/assets/images/qwen-icon.svg)
19. [xAI official GitHub organization](https://github.com/xai-org)
20. [NVIDIA brand guidelines](https://www.nvidia.com/en-us/about-nvidia/legal-info/logo-brand-usage/)
21. [NVIDIA newsroom media assets](https://nvidianews.nvidia.com/media-gallery)
22. [Hugging Face brand assets](https://huggingface.co/brand)
23. [Anthropic newsroom](https://www.anthropic.com/news)
24. [Cohere newsroom](https://cohere.com/newsroom)
25. [DeepSeek official GitHub organization](https://github.com/deepseek-ai)
26. [Meta brand resources](https://about.meta.com/brand/resources/)
27. [Mistral AI newsroom](https://mistral.ai/news)
28. [Google brand resource center](https://about.google/brand-resource-center/)
29. [Microsoft trademark and brand guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks)
30. [IBM Design Language](https://www.ibm.com/design/language/)

## Verification implications

- Computed styles must prove that the wallpaper is the only full-surface background image and that
  chrome/panels remain translucent.
- Rendered screenshots are required because token inheritance can pass structural tests while still
  producing illegible foreground colors.
- Provider and publisher images must load with non-zero intrinsic dimensions; a correct path in a
  registry is not enough.
