# Franz AI Blog

Automated AI news blog. Zero npm dependencies, Node 22+ only.

## Generate new article
```bash
node generate.js
```

## Email Assistant (conversational AI via email)
```bash
node email-editor.js
```
Email `support@nichtagentur.at` -- it's a real AI assistant, not a command system.
Accepts emails from: `franz.enzenhofer@fullstackoptimization.com` and `support@nichtagentur.at` (self-test).
Sends replies FROM `support@nichtagentur.at`.
Polls IMAP every 30 seconds. Stores conversation history in `email-history.json`.

## Architecture
- `generate.js` -- article generator, also a module (shared functions for email-editor)
- `email-editor.js` -- conversational AI email assistant (single Claude Sonnet call per email)
- `email-history.json` -- last 10 conversation exchanges for context
- `templates/` -- HTML templates with `{{PLACEHOLDER}}` syntax
- `docs/` -- GitHub Pages output directory
- `docs/articles.json` -- tracks published articles

## APIs used
- OpenRouter (Perplexity Sonar) for news discovery
- Anthropic (Claude Sonnet) for the email assistant (single model does everything)
- Google Gemini (2.5-flash-image) for featured images
