# Franz AI Blog

Automated AI news blog. Zero npm dependencies, Node 22+ only.

## Generate new article
```bash
node generate.js
```

## Email Editor (AI assistant via email)
```bash
node email-editor.js
```
Send emails to `support@nichtagentur.at` from `franz.enzenhofer@fullstackoptimization.com`.
Commands: "Write article about X", "Edit article X: instructions", "List articles", "Status", "Help".
Polls IMAP every 30 seconds. Only accepts emails from Franz. Replies FROM i-am-a-user@nichtagentur.at.

## Architecture
- `generate.js` -- article generator, also a module (shared functions for email-editor)
- `email-editor.js` -- IMAP polling email editor, uses Claude Haiku for intent + Sonnet for writing
- `templates/` -- HTML templates with `{{PLACEHOLDER}}` syntax
- `docs/` -- GitHub Pages output directory
- `docs/articles.json` -- tracks published articles for deduplication

## APIs used
- OpenRouter (Perplexity Sonar) for news discovery
- Anthropic (Claude Haiku) for intent classification
- Anthropic (Claude Sonnet) for article writing
- Google Gemini (2.5-flash-image) for featured images
