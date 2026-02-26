# Franz AI Blog

Automated AI news blog. Zero npm dependencies, Node 22+ only.

## Generate new article
```bash
node generate.js
```

## Architecture
- `generate.js` -- single script, calls Perplexity (OpenRouter), Claude (Anthropic), Gemini (Google)
- `templates/` -- HTML templates with `{{PLACEHOLDER}}` syntax
- `docs/` -- GitHub Pages output directory
- `docs/articles.json` -- tracks published articles for deduplication

## APIs used
- OpenRouter (Perplexity Sonar) for news discovery
- Anthropic (Claude Sonnet) for article writing
- Google Gemini (2.5-flash-image) for featured images
